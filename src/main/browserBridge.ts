// ブラウザ連携 — Chrome 拡張からリサーチへ登録するための localhost サーバー。
//
// CLI サーバー (cliServer.ts) は「ブラウザからは到達させない」設計なので流用せず、
// 拡張専用の入口を別に持つ。データの正はレンダラーなので、受けた内容は CLI と同じ
// cli:request 経路で cliBridge へ転送する (ADD_RESEARCH が BATCH で 1 undo)。
//
// 防御: 127.0.0.1 のみ / Host 検査 / Origin は chrome-extension:// のみ / 永続トークン /
// メソッド許可リスト。CORS ヘッダは一切返さないので、Web ページの fetch は preflight で
// 止まる (拡張は host_permissions により CORS の対象外)。
import { app, ipcMain, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { cp, mkdir, readFile, rename, unlink, writeFile } from 'fs/promises'
import { createServer, IncomingMessage, ServerResponse } from 'http'
import { randomBytes, timingSafeEqual } from 'crypto'
import { forwardToRenderer } from './cliServer'

// 拡張はこの範囲を順に探す (browser-extension/lib.js の PORTS と揃える)。
const PORTS = [38947, 38948, 38949, 38950]
const MAX_RPC_BODY = 1024 * 1024
const MAX_SAVE_BODY = 128 * 1024 * 1024 // browser-extension/lib.js の MAX_CLIP_BYTES より大きいこと
const RPC_METHODS = new Set(['research.targets', 'research.lookup'])

type EnsureWindow = () => BrowserWindow | null
type ClipPath = (itemId: string) => string | null

const tokenFile = (): string => join(app.getPath('userData'), 'browser-bridge.json')
const extensionDir = (): string => join(app.getPath('userData'), 'browser-extension')
const extensionSource = (): string =>
  app.isPackaged ? join(process.resourcesPath, 'browser-extension') : join(app.getAppPath(), 'browser-extension')

const newToken = (): string => `constella-${randomBytes(24).toString('hex')}`

async function persistToken(token: string): Promise<void> {
  const tmp = tokenFile() + '.tmp'
  await writeFile(tmp, JSON.stringify({ token }, null, 2), { mode: 0o600 })
  await rename(tmp, tokenFile())
}

async function loadToken(): Promise<string> {
  try {
    const t = JSON.parse(await readFile(tokenFile(), 'utf8')).token
    if (typeof t === 'string' && t.startsWith('constella-')) return t
  } catch { /* 初回 */ }
  const t = newToken()
  await persistToken(t).catch(() => { /* 今回の起動中だけ有効 */ })
  return t
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) { reject(new Error('too-large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

// /save の本文 = [JSON メタ (metaLength バイト)] + [MHTML (任意)]。
// 別々に送ると追加とクリップ付与が 2 つの undo に割れるので 1 リクエストにしている。
function splitSaveBody(body: Buffer, metaLength: number): { params: Record<string, unknown>; clip: Buffer | null } | null {
  if (!Number.isInteger(metaLength) || metaLength <= 0 || metaLength > body.length || metaLength > MAX_RPC_BODY) return null
  try {
    const params = JSON.parse(body.subarray(0, metaLength).toString('utf8'))
    if (!params || typeof params !== 'object') return null
    return { params, clip: metaLength < body.length ? body.subarray(metaLength) : null }
  } catch { return null }
}

// file:// で webview に読ませるものなので、MHTML 以外は保存しない。
const looksLikeMhtml = (b: Buffer): boolean => /multipart\/related/i.test(b.subarray(0, 8192).toString('latin1'))

export function startBrowserBridge(ensureWindow: EnsureWindow, clipPath: ClipPath): void {
  let token = ''
  let tokenBuf = Buffer.alloc(0)
  let port = 0
  const setToken = (t: string): void => { token = t; tokenBuf = Buffer.from(t) }

  const clipsDir = (): string => join(app.getPath('userData'), 'clips')

  const ask = async (res: ServerResponse, req: { method: string; params: unknown }): Promise<{ ok: boolean; [k: string]: unknown } | null> => {
    const win = ensureWindow()
    const answer = win && !win.isDestroyed() ? await forwardToRenderer(win, req) : null
    if (!answer) { send(res, 503, { ok: false, error: 'starting', retry: true }); return null }
    return answer
  }

  const handleSave = async (req: IncomingMessage, res: ServerResponse, metaLength: number): Promise<void> => {
    const parts = splitSaveBody(await readBody(req, MAX_SAVE_BODY), metaLength)
    if (!parts) return send(res, 400, { ok: false, error: '不正なリクエストです' })
    const { params, clip } = parts
    if (clip && !looksLikeMhtml(clip)) return send(res, 400, { ok: false, error: 'MHTML ではありません' })

    // 追加より先に一時ファイルへ書く: ディスクに書けなかったのに clip メタだけ DB に残るのを防ぐ。
    let tmp: string | null = null
    if (clip) {
      await mkdir(clipsDir(), { recursive: true })
      tmp = join(clipsDir(), `.incoming-${randomBytes(8).toString('hex')}.tmp`)
      await writeFile(tmp, clip)
    }
    const discard = async (): Promise<void> => { if (tmp) await unlink(tmp).catch(() => { /* ignore */ }) }
    try {
      const answer = await ask(res, { method: 'research.add', params: { ...params, clip: clip ? { size: clip.length } : undefined } })
      if (!answer) return await discard()
      if (!answer.ok) { await discard(); return send(res, answer.retry ? 503 : 400, answer) }
      const result = answer.result as { id: string; existed?: boolean }
      if (tmp) {
        const dest = result.existed ? null : clipPath(result.id)
        if (dest) await rename(tmp, dest)
        else await discard()
      }
      send(res, 200, answer)
    } catch (e) {
      await discard()
      throw e
    }
  }

  const server = createServer((req, res) => {
    ;(async () => {
      if (!String(req.headers.origin || '').startsWith('chrome-extension://')) return send(res, 403, { ok: false, error: 'forbidden' })
      if (String(req.headers.host || '') !== `127.0.0.1:${port}`) return send(res, 403, { ok: false, error: 'forbidden' })
      const auth = String(req.headers.authorization || '')
      const given = Buffer.from(auth.startsWith('Bearer ') ? auth.slice(7) : '')
      if (given.length !== tokenBuf.length || !timingSafeEqual(given, tokenBuf)) return send(res, 401, { ok: false, error: 'unauthorized', app: 'constella' })
      if (req.method !== 'POST') return send(res, 404, { ok: false, error: 'not-found' })

      const url = new URL(req.url || '/', 'http://127.0.0.1')
      if (url.pathname === '/ping') return send(res, 200, { ok: true, result: { app: 'constella', version: app.getVersion() } })
      if (url.pathname === '/save') return await handleSave(req, res, Number(url.searchParams.get('metaLength')))
      if (url.pathname !== '/rpc') return send(res, 404, { ok: false, error: 'not-found' })

      let parsed: { method?: unknown; params?: unknown }
      try { parsed = JSON.parse((await readBody(req, MAX_RPC_BODY)).toString('utf8')) } catch { return send(res, 400, { ok: false, error: 'リクエストが JSON ではありません' }) }
      if (typeof parsed.method !== 'string' || !RPC_METHODS.has(parsed.method)) return send(res, 400, { ok: false, error: '許可されていないメソッドです' })
      const answer = await ask(res, { method: parsed.method, params: parsed.params ?? {} })
      if (answer) send(res, answer.ok ? 200 : answer.retry ? 503 : 400, answer)
    })().catch((e) => {
      const tooLarge = e instanceof Error && e.message === 'too-large'
      try { send(res, tooLarge ? 413 : 500, { ok: false, error: tooLarge ? 'ページが大きすぎます' : 'internal' }) } catch { /* ignore */ }
    })
  })

  const listenNext = (i: number): void => {
    if (i >= PORTS.length) return // 全部塞がっていても本体は動かす
    server.once('error', () => listenNext(i + 1))
    server.listen(PORTS[i], '127.0.0.1', () => {
      server.removeAllListeners('error')
      server.on('error', () => { /* ignore */ })
      port = PORTS[i]
    })
  }

  // 拡張本体を userData へコピーする。ポータブル版の resources は一時展開で終了時に消えるため、
  // Chrome に読み込ませる場所は固定の userData にする (起動毎に更新 = アプリ更新に追従)。
  const installed = cp(extensionSource(), extensionDir(), { recursive: true, force: true }).then(() => true, () => false)
  const ready = loadToken().then((t) => { setToken(t); listenNext(0) })

  const info = async (): Promise<{ code: string; port: number; extensionDir: string | null }> => {
    await ready
    return { code: token, port, extensionDir: (await installed) ? extensionDir() : null }
  }
  ipcMain.handle('browser-bridge:info', info)
  ipcMain.handle('browser-bridge:regenerate', async () => {
    await ready
    const t = newToken()
    await persistToken(t)
    setToken(t) // 永続化に成功してから切り替える (再起動で旧トークンに戻らないように)
    return info()
  })
  ipcMain.handle('browser-bridge:open-extension-dir', async () => {
    if (await installed) await shell.openPath(extensionDir())
  })

  app.on('will-quit', () => { server.close() })
}
