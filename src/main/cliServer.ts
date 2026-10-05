// CLI アクセスライン — `constella` コマンド用の localhost RPC サーバー。
//
// データの正はレンダラーのメモリ (sql.js) なので、main は受けたリクエストを IPC で
// レンダラーへ転送して返事を中継するだけ。DB ファイルには一切触らない。
//
// 接続情報 (ポート / トークン / pid / exe) は userData/cli.json に書く。トークンは
// 起動毎に作り直し、127.0.0.1 のみで listen。ブラウザからの到達 (DNS rebinding /
// CSRF) は Origin ヘッダ拒否 + Host 検査 + Bearer トークンで塞ぐ。
import { app, ipcMain, BrowserWindow } from 'electron'
import { join } from 'path'
import { writeFile, rename, unlink, readFile, mkdir, chmod } from 'fs/promises'
import { readFileSync, writeFileSync } from 'fs'
import { createServer, IncomingMessage, ServerResponse } from 'http'
import { randomBytes, timingSafeEqual } from 'crypto'
import cliScript from './cli/constella.mjs?raw'

const MAX_BODY = 32 * 1024 * 1024
const RENDERER_TIMEOUT_MS = 20000
const CRLF = String.fromCharCode(13, 10)

export const cliInfoPath = (): string => join(app.getPath('userData'), 'cli.json')
export const cliBinDir = (): string => join(app.getPath('userData'), 'bin')

// CLI が「未起動ならこれを起動」に使う実行ファイル。ポータブル版の execPath は
// 一時展開先(終了で消える)なので元の exe を、AppImage は AppImage 本体を指す。
// 開発実行(未パッケージ)では electron 単体を起動しても意味がないので null。
function launchPath(): string | null {
  if (!app.isPackaged) return null
  return process.env.PORTABLE_EXECUTABLE_FILE || process.env.APPIMAGE || process.execPath
}

// `constella` を node として動かす実行ファイル (ELECTRON_RUN_AS_NODE=1)。ポータブル版の
// 自己展開スタブはこの環境変数を解さないので、その場合はラッパーが node にフォールバック。
function nodeHostPath(): string | null {
  if (process.env.PORTABLE_EXECUTABLE_FILE) return null
  return process.env.APPIMAGE || process.execPath
}

type Answer = { ok: boolean; [k: string]: unknown }
const waiters = new Map<string, (a: Answer) => void>()

ipcMain.on('cli:reply', (_e, reqId: string, res: Answer) => {
  const w = waiters.get(reqId)
  if (w) { waiters.delete(reqId); w(res) }
})

function askRenderer(win: BrowserWindow, req: unknown): Promise<Answer> {
  return new Promise((resolve) => {
    const reqId = `${Date.now().toString(36)}-${randomBytes(6).toString('hex')}`
    const timer = setTimeout(() => { waiters.delete(reqId); resolve({ ok: false, error: 'アプリが応答しません (タイムアウト)', retry: true }) }, RENDERER_TIMEOUT_MS)
    waiters.set(reqId, (a) => { clearTimeout(timer); resolve(a) })
    win.webContents.send('cli:request', reqId, req)
  })
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(json)
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) { reject(new Error('too-large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export function startCliServer(ensureWindow: () => BrowserWindow | null): void {
  const token = randomBytes(24).toString('hex')
  const tokenBuf = Buffer.from(token)
  let port = 0

  const server = createServer((req, res) => {
    ;(async () => {
      // ブラウザ発のリクエスト (Origin 付き) と、127.0.0.1 以外の Host 名は拒否。
      if (req.headers.origin) return send(res, 403, { ok: false, error: 'forbidden' })
      const host = String(req.headers.host || '')
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 403, { ok: false, error: 'forbidden' })
      const auth = String(req.headers.authorization || '')
      const given = Buffer.from(auth.startsWith('Bearer ') ? auth.slice(7) : '')
      if (given.length !== tokenBuf.length || !timingSafeEqual(given, tokenBuf)) return send(res, 401, { ok: false, error: 'unauthorized' })
      if (req.method !== 'POST' || req.url !== '/rpc') return send(res, 404, { ok: false, error: 'not-found' })

      let parsed: { method?: unknown; params?: unknown }
      try { parsed = JSON.parse(await readBody(req)) } catch { return send(res, 400, { ok: false, error: 'リクエストが JSON ではありません' }) }
      if (typeof parsed.method !== 'string') return send(res, 400, { ok: false, error: 'method がありません' })

      if (parsed.method === 'version') return send(res, 200, { ok: true, result: { version: app.getVersion(), pid: process.pid } })

      const win = ensureWindow()
      if (!win || win.isDestroyed()) return send(res, 503, { ok: false, error: 'ウィンドウがありません', retry: true })
      const answer = await askRenderer(win, { method: parsed.method, params: parsed.params ?? {} })
      send(res, answer.ok ? 200 : answer.retry ? 503 : 400, answer)
    })().catch(() => { try { send(res, 500, { ok: false, error: 'internal' }) } catch { /* ignore */ } })
  })

  server.listen(0, '127.0.0.1', async () => {
    const addr = server.address()
    port = typeof addr === 'object' && addr ? addr.port : 0
    if (!port) return
    // tmp → rename で、CLI が書きかけの JSON を読まないようにする。
    const info = { port, token, pid: process.pid, version: app.getVersion(), launch: launchPath(), startedAt: new Date().toISOString() }
    const tmp = cliInfoPath() + '.tmp'
    try {
      await writeFile(tmp, JSON.stringify(info, null, 2), { mode: 0o600 })
      await rename(tmp, cliInfoPath())
    } catch { /* CLI が使えないだけでアプリ本体は動かす */ }
  })
  server.on('error', () => { /* listen 失敗時も本体は継続 */ })

  // 終了時は接続情報 (ポート/トークン) だけ消し、起動パスは残す — 次回 CLI が
  // アプリを起動するのに使う。自分が書いたものだけ。will-quit は同期で済ませる。
  app.on('will-quit', () => {
    try {
      const cur = JSON.parse(readFileSync(cliInfoPath(), 'utf8'))
      if (cur.pid === process.pid) writeFileSync(cliInfoPath(), JSON.stringify({ launch: launchPath() }, null, 2))
    } catch { /* ignore */ }
    server.close()
  })
}

// 起動時: 前回クラッシュ等で残った cli.json は、listen 完了で上書きされるまでの間
// CLI に古いポートを見せてしまう。自プロセス以外のものは起動パスだけに戻しておく。
export async function clearStaleCliInfo(): Promise<void> {
  try {
    const cur = JSON.parse(await readFile(cliInfoPath(), 'utf8'))
    if (cur.pid !== process.pid) await writeFile(cliInfoPath(), JSON.stringify({ launch: launchPath() }, null, 2))
  } catch {
    try { await unlink(cliInfoPath()) } catch { /* ignore */ }
  }
}

// userData/bin に CLI 本体とラッパーを置く (起動毎に更新 = アプリ更新に追従)。
// 置き場を userData にするのは、ポータブル版の resources が一時展開で消えるのと、
// PATH に入れる場所をインストール形態によらず一定にするため。
export async function installCli(): Promise<{ dir: string; command: string }> {
  const dir = cliBinDir()
  const host = nodeHostPath()
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'constella.mjs'), cliScript)
  if (process.platform === 'win32') {
    const cmd = [
      '@echo off',
      'setlocal',
      // 括弧ブロックは使わない: パスに "(x86)" などが入ると壊れる。
      ...(host ? [`if not exist "${host}" goto node`, 'set ELECTRON_RUN_AS_NODE=1', `"${host}" "%~dp0constella.mjs" %*`, 'exit /b %ERRORLEVEL%'] : []),
      ':node',
      'node "%~dp0constella.mjs" %*',
      '',
    ].join(CRLF)
    await writeFile(join(dir, 'constella.cmd'), cmd)
    return { dir, command: join(dir, 'constella.cmd') }
  }
  const q = (p: string): string => `'${p.replace(/'/g, `'\\''`)}'`
  const sh = [
    '#!/bin/sh',
    'DIR="$(cd "$(dirname "$0")" && pwd)"',
    host ? `if [ -x ${q(host)} ]; then ELECTRON_RUN_AS_NODE=1 exec ${q(host)} "$DIR/constella.mjs" "$@"; fi` : '',
    'exec node "$DIR/constella.mjs" "$@"',
    '',
  ].join('\n')
  await writeFile(join(dir, 'constella'), sh)
  await chmod(join(dir, 'constella'), 0o755)
  return { dir, command: join(dir, 'constella') }
}
