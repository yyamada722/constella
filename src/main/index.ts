import { app, BrowserWindow, shell, ipcMain, dialog } from 'electron'
import { join, dirname, normalize, extname } from 'path'
import { readFile, writeFile, unlink, mkdir, rm, stat, rename, copyFile, readdir } from 'fs/promises'
import { createServer, Server } from 'http'
import { networkInterfaces } from 'os'
import { randomBytes } from 'crypto'
import Anthropic from '@anthropic-ai/sdk'
import { initUpdater } from './updater'
import { initSync } from './sync'

// E2E hook: isolate userData (and the single-instance lock derived from it) so an
// automated run never collides with — or writes into — the real installation.
if (process.env.CONSTELLA_USERDATA) app.setPath('userData', process.env.CONSTELLA_USERDATA)

// Persist the SQLite database (serialized by sql.js in the renderer) to a real
// file under the app's userData directory.
const dbPath = (): string => join(app.getPath('userData'), 'constella.db')
// Previous-good copy, rotated on every save. First line of defence when the main
// file is corrupted (e.g. a crash mid-write or filesystem damage).
const bakPath = (): string => dbPath() + '.bak'
// Rolling daily backups (constella-YYYYMMDD.db), pruned to the newest N. Second
// line of defence — survives corruption that already propagated into .bak.
const backupsDir = (): string => join(app.getPath('userData'), 'db-backups')
const BACKUP_KEEP = 14
// Pre-rename location (app was formerly named "maind-set"). userData is
// <appData>/<appName>, so the old DB sits in a sibling folder.
const legacyDbPath = (): string => join(dirname(app.getPath('userData')), 'maind-set', 'maind_set.db')

ipcMain.handle('db:load', async (): Promise<Buffer | null> => {
  try {
    return await readFile(dbPath())
  } catch {
    // No DB at the new location yet — one-time migration from the old name.
    try {
      const legacy = await readFile(legacyDbPath())
      try { await mkdir(dirname(dbPath()), { recursive: true }); await writeFile(dbPath(), legacy) } catch { /* copy best-effort; bytes still returned */ }
      return legacy
    } catch {
      return null // genuinely no database yet
    }
  }
})

// Write the day's rolling backup (first save of the day only) and prune old ones.
async function dailyBackup(buf: Buffer): Promise<void> {
  const dir = backupsDir()
  await mkdir(dir, { recursive: true })
  const d = new Date()
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  const p = join(dir, `constella-${stamp}.db`)
  try { await stat(p); return } catch { /* not yet written today */ }
  await writeFile(p, buf)
  const names = (await readdir(dir)).filter(n => /^constella-\d{8}\.db$/.test(n)).sort()
  for (const n of names.slice(0, Math.max(0, names.length - BACKUP_KEEP))) {
    try { await unlink(join(dir, n)) } catch { /* best-effort prune */ }
  }
}

// ATOMIC save: write to a temp file first, then rename over the target — a
// crash/kill mid-write can no longer leave a truncated/corrupt constella.db.
// Shared by db:save and the folder-sync pull (which replaces the DB the same way).
async function writeDbAtomic(buf: Buffer, opts?: { fromRemote?: boolean }): Promise<void> {
  const p = dbPath()
  // 一意な tmp 名: この関数は db:save と同期フォルダの pull という2人の書き手から
  // 呼ばれる。固定名だと両者が同じ tmp に書き、片方の rename が相手の書きかけを
  // 本体に載せて切り詰め DB を生む(旧実装は db:save 単独前提だった)。
  const tmp = `${p}.tmp-${randomBytes(4).toString('hex')}`
  await mkdir(dirname(p), { recursive: true })
  await writeFile(tmp, buf)
  try { await copyFile(p, bakPath()) } catch { /* no previous file yet */ }
  try {
    await rename(tmp, p)
  } catch (e) {
    try { await unlink(tmp) } catch { /* 掃除は best-effort */ }
    throw e
  }
  // 日次バックアップは「このマシンで作業した内容」の第2の防衛線。同期の pull で
  // 取り込んだリモートのバイトでその日の枠を埋めてしまうと、その日のローカル作業は
  // どの世代にも残らない(.bak は次の保存で即ローテートされる)。
  if (!opts?.fromRemote) {
    try { await dailyBackup(buf) } catch { /* backups are best-effort */ }
  }
}

ipcMain.handle('db:save', async (_e, bytes: Uint8Array): Promise<void> => {
  const buf = Buffer.from(bytes)
  // An empty payload is never a legitimate save — historically it meant "reset",
  // which made a single buggy call destroy the database. Resets now go through
  // the explicit db:reset channel; empty saves are ignored.
  if (buf.length === 0) return
  await writeDbAtomic(buf)
})

ipcMain.handle('db:reset', async (): Promise<void> => {
  try { await unlink(dbPath()) } catch { /* already gone */ }
})

// Recovery candidates, newest first: previous-good .bak, then the rolling daily
// backups. The renderer walks these when the main DB fails to open.
// `kind`: 'auto' は破損時の自動復旧チェーンが辿ってよい候補(このマシンの正規の
// スナップショット)。'conflict' は同期の競合でユーザーが**選ばなかった側**の退避で、
// 自動復元に混ぜると「拒否したはずのデータで勝手に上書きされる」ため除外し、
// 明示的な復元操作からのみ辿れるようにする。
ipcMain.handle('db:recovery-list', async (): Promise<{ name: string; size: number; mtime: number; kind: 'auto' | 'conflict' }[]> => {
  const out: { name: string; size: number; mtime: number; kind: 'auto' | 'conflict' }[] = []
  try { const s = await stat(bakPath()); out.push({ name: 'constella.db.bak', size: s.size, mtime: s.mtimeMs, kind: 'auto' }) } catch { /* none */ }
  try {
    const dir = backupsDir()
    const names = (await readdir(dir)).filter(n => /^constella-(?:\d{8}|conflict-\d{8}-\d{6})\.db$/.test(n))
    const dated: { name: string; size: number; mtime: number; kind: 'auto' | 'conflict' }[] = []
    for (const n of names) {
      try {
        const s = await stat(join(dir, n))
        dated.push({ name: n, size: s.size, mtime: s.mtimeMs, kind: n.includes('conflict-') ? 'conflict' : 'auto' })
      } catch { /* skip */ }
    }
    dated.sort((a, b) => b.mtime - a.mtime)
    out.push(...dated)
  } catch { /* no backups dir yet */ }
  return out
})

// Read one recovery candidate by the name returned from db:recovery-list. The
// name is validated against the known shapes so this can't read arbitrary paths.
ipcMain.handle('db:load-recovery', async (_e, name: string): Promise<Buffer | null> => {
  let p: string | null = null
  if (name === 'constella.db.bak') p = bakPath()
  else if (/^constella-(?:\d{8}|conflict-\d{8}-\d{6})\.db$/.test(name)) p = join(backupsDir(), name)
  if (!p) return null
  try { return await readFile(p) } catch { return null }
})

// Extensions allowed per media card type. The bytes & name come from the card
// (which may originate from an imported, attacker-controlled backup), so the
// final extension is FORCED into this allowlist — shell.openPath() picks the OS
// handler by extension, and we must never let it open a script/executable type
// (.hta/.html/.url/.exe/…). A mismatched extension is replaced with the type default.
const TYPE_EXTS: Record<string, string[]> = {
  pdf: ['.pdf'],
  image: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.avif'],
  video: ['.mp4', '.webm', '.mov', '.mkv', '.m4v', '.ogv'],
  audio: ['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac'],
  // ライブラリの「その他」ファイル用 — 文書/アーカイブ/制作系の頑健な許可リスト。
  // ここに無い拡張子（.html/.chm/.js …）は .bin に強制され、OSが実行系ハンドラで
  // 開くことはない（拒否リスト方式に反転させないこと — imported backup のバイトは
  // 攻撃者制御になり得る）。
  other: [
    '.txt', '.md', '.csv', '.tsv', '.json', '.xml', '.yaml', '.yml', '.log',
    '.zip', '.7z', '.rar', '.gz', '.tar',
    '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp', '.rtf', '.epub',
    '.psd', '.ai', '.blend', '.fbx', '.obj', '.stl', '.gltf', '.glb', '.skp', '.c4d',
    '.heic', '.heif', '.tif', '.tiff', '.tga', '.raw', '.cr2', '.cr3', '.nef', '.arw', '.dng', '.exr', '.hdr',
    '.ttf', '.otf', '.woff', '.woff2',
    '.srt', '.vtt', '.ass',
    '.aep', '.prproj', '.drp', '.als', '.flp', '.logicx',
  ],
}
const DEFAULT_EXT: Record<string, string> = { pdf: '.pdf', image: '.png', video: '.mp4', audio: '.mp3' }
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

// Write a card's stored media bytes to a temp file and open it in the OS default
// app (image viewer, PDF reader, video player, …). idb-stored blobs have no
// on-disk original, so we materialize one on demand.
ipcMain.handle('file:open-temp', async (_e, bytes: Uint8Array, name: string, type: string): Promise<void> => {
  const allowed = TYPE_EXTS[type] ?? []
  const raw = (name || 'file').replace(/[\\/:*?"<>|]/g, '_')
  const dot = raw.lastIndexOf('.')
  let stem = (dot > 0 ? raw.slice(0, dot) : raw).replace(/^[.\s]+|[.\s]+$/g, '').slice(-100)
  if (!stem || RESERVED.test(stem)) stem = 'file'
  const givenExt = dot > 0 ? raw.slice(dot).toLowerCase() : ''
  // Force the extension into the per-type allowlist (defends against spoofed
  // executable extensions — .html/.chm/.js/… — paired with arbitrary bytes via an
  // imported backup). Unlisted extensions become the type default / .bin, never
  // whatever the name claimed.
  const ext = allowed.includes(givenExt) ? givenExt : (DEFAULT_EXT[type] ?? '.bin')
  const dir = join(app.getPath('temp'), 'constella')
  await mkdir(dir, { recursive: true })
  const p = join(dir, stem + ext)
  await writeFile(p, Buffer.from(bytes))
  await shell.openPath(p)
})

// ── Local / server file references (アセットのパス参照) ──
// Assets can stay where they live (NAS の UNC パスやローカルフォルダ); the DB stores
// only a `local:<absolute path>` reference and the bytes are read on demand.

// Per-extension MIME for local file previews (renderer builds a typed Blob).
const LOCAL_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/mp4', '.mkv': 'video/x-matroska', '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.aac': 'audio/aac',
  '.txt': 'text/plain', '.md': 'text/plain', '.json': 'application/json',
}
// Reading huge files through IPC would balloon renderer memory — preview reads are
// capped; bigger files can still be opened in their OS default app.
const LOCAL_READ_MAX = 512 * 1024 * 1024
// Never hand these to shell.openPath — a reference (possibly arriving via an
// imported backup) must not be able to launch code.
const LOCAL_BLOCKED_EXTS = new Set([
  '.exe', '.bat', '.cmd', '.com', '.scr', '.pif', '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse',
  '.wsf', '.wsh', '.msi', '.msp', '.hta', '.cpl', '.jar', '.lnk', '.url', '.reg', '.appx',
  '.app', '.command', '.sh',
])

// Extensions offered per card kind, so a PDF card's picker doesn't invite an
// audio file. The renderer re-checks the chosen path — every dialog also offers
// "all files", and these filters are only a nudge.
const LOCAL_PICK_FILTERS: Record<string, { name: string; extensions: string[] }> = {
  image: { name: '画像', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg'] },
  pdf: { name: 'PDF', extensions: ['pdf'] },
  video: { name: '動画', extensions: ['mp4', 'webm', 'mov', 'm4v', 'mkv', 'ogv'] },
  audio: { name: '音声', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'] },
}

ipcMain.handle('local:pick', async (_e, kind?: string): Promise<string[] | null> => {
  if (!mainWindow || mainWindow.isDestroyed()) return null
  const preferred = kind ? LOCAL_PICK_FILTERS[kind] : undefined
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'サーバー / ローカルのファイルを参照',
    properties: ['openFile', 'multiSelections'],
    filters: preferred ? [preferred, { name: 'すべてのファイル', extensions: ['*'] }] : undefined,
  })
  return r.canceled || r.filePaths.length === 0 ? null : r.filePaths
})

// A `local:` ref usually points at a NAS share. When that server is offline the
// OS network stack can sit on a stat/read for tens of seconds, and since the
// renderer awaits these over IPC the UI hangs for exactly that long. Bound every
// probe: metadata calls get a short budget, the byte read a longer one (large
// files over a slow-but-alive link are legitimate). A timeout resolves to the
// same "unavailable" value as an error, so call sites need no new handling.
const LOCAL_STAT_TIMEOUT = 5_000
const LOCAL_READ_TIMEOUT = 60_000

function withTimeout<T>(work: Promise<T>, ms: number, onTimeout: T): Promise<T> {
  return new Promise<T>(resolve => {
    const timer = setTimeout(() => resolve(onTimeout), ms)
    const done = (v: T): void => { clearTimeout(timer); resolve(v) }
    work.then(done, () => done(onTimeout))
  })
}

ipcMain.handle('local:stat', async (_e, p: string): Promise<{ exists: boolean; size?: number; mtime?: number }> => {
  return withTimeout((async () => {
    const s = await stat(p)
    if (!s.isFile()) return { exists: false }
    return { exists: true, size: s.size, mtime: s.mtimeMs }
  })(), LOCAL_STAT_TIMEOUT, { exists: false })
})

ipcMain.handle('local:read', async (_e, p: string): Promise<{ bytes: Buffer; mime: string } | null> => {
  const meta = await withTimeout(stat(p).then(s => (s.isFile() && s.size <= LOCAL_READ_MAX ? s : null)), LOCAL_STAT_TIMEOUT, null)
  if (!meta) return null
  // AbortSignal actually cancels the read (unlike the stat race above, which can
  // only stop waiting), so a dying transfer doesn't keep the handle open.
  return withTimeout(
    readFile(p, { signal: AbortSignal.timeout(LOCAL_READ_TIMEOUT) })
      .then(bytes => ({ bytes, mime: LOCAL_MIME[extname(p).toLowerCase()] ?? 'application/octet-stream' })),
    LOCAL_READ_TIMEOUT,
    null,
  )
})

// Open the ORIGINAL file in its OS default app (not a temp copy — edits land on
// the server file itself). Returns '' on success, else a user-facing message.
ipcMain.handle('local:open', async (_e, p: string): Promise<string> => {
  if (LOCAL_BLOCKED_EXTS.has(extname(p).toLowerCase())) return '実行可能ファイルは開けません'
  // Same unreachable-NAS hazard as local:stat — bound the existence check.
  const ok = await withTimeout(stat(p).then(s => s.isFile()), LOCAL_STAT_TIMEOUT, false)
  if (!ok) return 'ファイルが見つかりません（サーバーに接続できない可能性があります）'
  return shell.openPath(p)
})

ipcMain.handle('local:reveal', async (_e, p: string): Promise<void> => {
  shell.showItemInFolder(p)
})

// ── 計画の PDF 書き出し ──
// The renderer builds a self-contained print HTML (all user text escaped there)
// and we rasterize it via a hidden BrowserWindow + printToPDF. JS is disabled in
// the window since the document never needs it. Margins are in inches.
ipcMain.handle('pdf:render-html', async (
  _e,
  html: string,
  margins: { top: number; bottom: number; left: number; right: number },
  // pageSizeInch: カスタムページ寸法（インチ）。スライド書き出しの 16:9 などに使う。
  opts?: { pageSizeInch?: { width: number; height: number } },
): Promise<Buffer> => {
  const dir = join(app.getPath('temp'), 'constella')
  await mkdir(dir, { recursive: true })
  const p = join(dir, `print-${Date.now()}-${Math.random().toString(36).slice(2)}.html`)
  await writeFile(p, html, 'utf8')
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, javascript: false },
  })
  try {
    await win.loadFile(p)
    return await win.webContents.printToPDF({
      pageSize: opts?.pageSizeInch ? { width: opts.pageSizeInch.width, height: opts.pageSizeInch.height } : 'A4',
      printBackground: true,
      margins: { top: margins.top, bottom: margins.bottom, left: margins.left, right: margins.right },
    })
  } finally {
    win.destroy()
    unlink(p).catch(() => { /* temp cleanup is best-effort */ })
  }
})

ipcMain.handle('pdf:save', async (_e, bytes: Uint8Array, defaultName: string): Promise<boolean> => {
  // E2E hook: ダイアログを出せない自動テストでは環境変数のパスへ直接保存する。
  if (process.env.CONSTELLA_PDF_SAVE_TO) {
    await writeFile(process.env.CONSTELLA_PDF_SAVE_TO, Buffer.from(bytes))
    return true
  }
  if (!mainWindow || mainWindow.isDestroyed()) return false
  const safe = (defaultName || 'ドキュメント').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)
  const r = await dialog.showSaveDialog(mainWindow, {
    title: 'PDFに書き出し',
    defaultPath: safe + '.pdf',
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  })
  if (r.canceled || !r.filePath) return false
  await writeFile(r.filePath, Buffer.from(bytes))
  shell.showItemInFolder(r.filePath)
  return true
})

// YouTube (since late 2025) refuses to play embeds that arrive without a valid
// HTTP Referer/origin. The renderer is loaded from file:// (no usable origin), so
// embeds fail. Rather than move the whole app off file:// (which would change the
// IndexedDB origin and orphan stored media), we serve a tiny wrapper page from a
// real http://127.0.0.1 origin and load THAT in the video webview — its nested
// YouTube iframe then carries a valid Referer and plays.
let embedBase = ''

function startEmbedServer(): Promise<void> {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const u = new URL(req.url || '/', 'http://127.0.0.1')
      if (u.pathname === '/ytplayer.html') {
        // Self-contained custom YouTube player (controls=0 + our own controls), served
        // from a real http origin so YouTube accepts the embed. Bundled from public/.
        try {
          const html = await readFile(join(__dirname, '../renderer/ytplayer.html'))
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(html)
        } catch { res.writeHead(404); res.end() }
        return
      }
      if (u.pathname === '/embed') {
        const p = u.searchParams.get('p')
        const id = (u.searchParams.get('id') || '').trim()
        const start = Math.max(0, Math.floor(Number(u.searchParams.get('start')) || 0))
        let inner = ''
        // rel=0/iv_load_policy=3/modestbranding suppress the related-videos & end-screen
        // clutter YouTube overlays when paused/finished.
        if (p === 'yt' && /^[\w-]{11}$/.test(id)) {
          inner = `https://www.youtube.com/embed/${id}?rel=0&iv_load_policy=3&modestbranding=1&playsinline=1${start ? `&start=${start}` : ''}`
        } else if (p === 'vimeo' && /^\d+$/.test(id)) {
          inner = `https://player.vimeo.com/video/${id}?title=0&byline=0&portrait=0${start ? `#t=${start}s` : ''}`
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="strict-origin-when-cross-origin"><style>html,body{margin:0;height:100%;background:#000;overflow:hidden}iframe{border:0;position:fixed;inset:0;width:100%;height:100%}</style></head><body>${inner ? `<iframe src="${inner}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>` : '<p style="color:#888;font-family:sans-serif;padding:1em">動画を読み込めません</p>'}</body></html>`)
        return
      }
      res.writeHead(404); res.end()
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      embedBase = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : ''
      resolve()
    })
  })
}

// Synchronous so the preload can expose the base URL before the renderer mounts.
ipcMain.on('embed:base', (e) => { e.returnValue = embedBase })

// ── LAN access: optionally serve the app + data over the local network so an
// external device (iPad on the same WiFi) can use the SAME data. Off by default;
// when enabled it is persisted and auto-starts. No auth (user's local network).
// The desktop and remote clients share the one constella.db file; data stays
// consistent by reloading on focus (designed for one device at a time).
let mainWindow: BrowserWindow | null = null
let lanServer: Server | null = null
let lanPort = 0
const RENDERER_DIR = (): string => join(__dirname, '../renderer')
const settingsPath = (): string => join(app.getPath('userData'), 'remote.json')

async function loadRemoteEnabled(): Promise<boolean> {
  try { return !!JSON.parse(await readFile(settingsPath(), 'utf8')).enabled } catch { return false }
}
async function saveRemoteEnabled(enabled: boolean): Promise<void> {
  try { await writeFile(settingsPath(), JSON.stringify({ enabled })) } catch { /* ignore */ }
}

// All usable IPv4 addresses to reach this machine, each with a friendly label.
// Tailscale (100.x) is listed first since it's the usual way to reach the app
// off-LAN; virtual/loopback/link-local adapters are filtered out.
function lanAddrs(): { label: string; ip: string }[] {
  const skip = /vmware|virtualbox|hyper-v|vethernet|bluetooth|loopback|default switch/i
  const out: { label: string; ip: string }[] = []
  const ifaces = networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] ?? []) {
      if (ni.family !== 'IPv4' || ni.internal) continue
      if (ni.address.startsWith('169.254.') || skip.test(name)) continue
      const ts = ni.address.startsWith('100.') || /tailscale/i.test(name)
      out.push({ label: ts ? 'Tailscale' : name, ip: ni.address })
    }
  }
  out.sort((a, b) => (b.label === 'Tailscale' ? 1 : 0) - (a.label === 'Tailscale' ? 1 : 0))
  return out
}

function remoteStatus(): { enabled: boolean; port: number; urls: { label: string; url: string }[] } {
  const enabled = !!lanServer
  return {
    enabled,
    port: lanPort,
    urls: enabled ? lanAddrs().map(a => ({ label: a.label, url: `http://${a.ip}:${lanPort}` })) : [],
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon', '.pdf': 'application/pdf',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.map': 'application/json',
}

// Media proxy: the renderer holds media blobs in IndexedDB, so the server asks the
// (always-running) desktop renderer for the bytes when a remote client requests them.
// The stored blob's MIME rides along so remote clients receive a real Content-Type
// (an octet-stream response makes the itinerary attachment preview fall back to
// 「プレビュー非対応」 on phones).
type MediaAnswer = { bytes: Uint8Array; mime: string } | null
const mediaWaiters = new Map<string, (r: MediaAnswer) => void>()
ipcMain.on('remote:media-reply', (_e, reqId: string, bytes: Uint8Array | null, mime?: string) => {
  const w = mediaWaiters.get(reqId)
  if (w) { mediaWaiters.delete(reqId); w(bytes ? { bytes, mime: mime || '' } : null) }
})
function fetchMediaFromRenderer(id: string): Promise<MediaAnswer> {
  return new Promise((resolve) => {
    if (!mainWindow || mainWindow.isDestroyed()) return resolve(null)
    const reqId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
    const timer = setTimeout(() => { mediaWaiters.delete(reqId); resolve(null) }, 8000)
    mediaWaiters.set(reqId, (b) => { clearTimeout(timer); resolve(b) })
    mainWindow.webContents.send('remote:media-request', reqId, id)
  })
}

async function handleLanRequest(req: import('http').IncomingMessage, res: import('http').ServerResponse): Promise<void> {
  const u = new URL(req.url || '/', 'http://localhost')
  const path = u.pathname

  // ── API ──
  if (path === '/api/db') {
    if (req.method === 'PUT') {
      const chunks: Buffer[] = []
      req.on('data', c => chunks.push(c as Buffer))
      req.on('end', async () => {
        try { await writeFile(dbPath(), Buffer.concat(chunks)); res.writeHead(200); res.end('ok') }
        catch { res.writeHead(500); res.end() }
      })
      return
    }
    try { const buf = await readFile(dbPath()); res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end(buf) }
    catch { res.writeHead(204); res.end() }
    return
  }
  if (path === '/api/db/etag') {
    try { const s = await stat(dbPath()); res.writeHead(200); res.end(`${Math.floor(s.mtimeMs)}-${s.size}`) }
    catch { res.writeHead(200); res.end('none') }
    return
  }
  if (path.startsWith('/api/media/')) {
    const id = decodeURIComponent(path.slice('/api/media/'.length))
    if (!/^[A-Za-z0-9]+$/.test(id)) { res.writeHead(400); res.end(); return }
    const answer = await fetchMediaFromRenderer(id)
    if (!answer) { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'Content-Type': answer.mime || 'application/octet-stream', 'Cache-Control': 'no-store' })
    res.end(Buffer.from(answer.bytes))
    return
  }

  // ── Static renderer files ──
  const dir = RENDERER_DIR()
  if (path === '/' || path === '/index.html') {
    // Serve index.html with an injected flag so the renderer knows it's a remote
    // (HTTP-backed) client. Checked before normalize() so the OS separator can't
    // make the comparison miss.
    try {
      let html = await readFile(join(dir, 'index.html'), 'utf8')
      html = html.replace('<head>', '<head><script>window.__CONSTELLA_REMOTE__=true</script>')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(html)
    } catch { res.writeHead(404); res.end() }
    return
  }
  const safe = normalize(path.replace(/^\/+/, '')).replace(/^(\.\.[/\\])+/, '') // strip path traversal
  const file = join(dir, safe)
  if (!file.startsWith(dir)) { res.writeHead(403); res.end(); return }
  const ext = file.slice(file.lastIndexOf('.')).toLowerCase()
  try {
    const buf = await readFile(file)
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' })
    res.end(buf)
  } catch {
    res.writeHead(404); res.end()
  }
}

function startLanServer(): Promise<void> {
  return new Promise((resolve) => {
    if (lanServer) { resolve(); return }
    const server = createServer((req, res) => { handleLanRequest(req, res).catch(() => { try { res.writeHead(500); res.end() } catch { /* */ } }) })
    let port = 8765
    const tryListen = () => {
      server.once('error', (e: NodeJS.ErrnoException) => {
        if (e.code === 'EADDRINUSE' && port < 8785) { port++; setTimeout(tryListen, 0) }
        else { lanServer = null; resolve() }
      })
      server.listen(port, '0.0.0.0', () => { lanServer = server; lanPort = port; resolve() })
    }
    tryListen()
  })
}

function stopLanServer(): void {
  if (lanServer) { lanServer.close(); lanServer = null; lanPort = 0 }
}

ipcMain.handle('remote:status', () => remoteStatus())
ipcMain.handle('remote:set', async (_e, on: boolean) => {
  await saveRemoteEnabled(!!on)
  if (on) await startLanServer(); else stopLanServer()
  return remoteStatus()
})
ipcMain.handle('db:etag', async () => {
  try { const s = await stat(dbPath()); return `${Math.floor(s.mtimeMs)}-${s.size}` } catch { return 'none' }
})

// 他マシンとの同期(同期フォルダ方式) — フォルダ側のファイル入出力一式。
initSync({ dbPath, backupsDir, writeDbAtomic, getMainWindow: () => mainWindow })

// ── AI assistant (Claude API) ──
// Settings (API key, default model) live in a small JSON file under userData so they
// survive DB resets and aren't mixed into the data store. The key never leaves this
// process — the renderer streams via IPC; LAN remote clients can't read or use it.
const aiSettingsPath = (): string => join(app.getPath('userData'), 'ai.json')
interface AISettings { apiKey?: string; model?: string }
async function loadAISettings(): Promise<AISettings> {
  try { return JSON.parse(await readFile(aiSettingsPath(), 'utf8')) } catch { return {} }
}
async function saveAISettings(s: AISettings): Promise<void> {
  try { await writeFile(aiSettingsPath(), JSON.stringify(s)) } catch { /* ignore */ }
}

// Renderer reads settings minus the key (we only report whether one is configured).
ipcMain.handle('ai:get-settings', async () => {
  const s = await loadAISettings()
  return { hasKey: !!s.apiKey, model: s.model ?? 'claude-sonnet-4-6' }
})
ipcMain.handle('ai:set-settings', async (_e, s: AISettings) => {
  const cur = await loadAISettings()
  await saveAISettings({ ...cur, ...s })
  return { hasKey: !!(s.apiKey ?? cur.apiKey), model: s.model ?? cur.model ?? 'claude-sonnet-4-6' }
})

// Streaming chat: many concurrent streams could exist (rare in practice — UI shows
// one at a time — but the streamId keeps it safe). Renderer subscribes to
// ai:chunk/ai:done/ai:error with the streamId.
const aiStreams = new Map<string, AbortController>()
ipcMain.on('ai:chat', async (e, streamId: string, opts: {
  system: string
  messages: { role: 'user' | 'assistant'; content: string }[]
  model?: string
  maxTokens?: number
}) => {
  const reply = (channel: string, ...args: unknown[]) => { if (!e.sender.isDestroyed()) e.sender.send(channel, streamId, ...args) }
  try {
    const s = await loadAISettings()
    if (!s.apiKey) { reply('ai:error', 'APIキーが未設定です。設定画面でAPIキーを入力してください。'); return }
    const controller = new AbortController()
    aiStreams.set(streamId, controller)
    const client = new Anthropic({ apiKey: s.apiKey })
    const stream = client.messages.stream({
      model: opts.model ?? s.model ?? 'claude-sonnet-4-6',
      max_tokens: opts.maxTokens ?? 4096,
      system: opts.system || undefined,
      messages: opts.messages,
    }, { signal: controller.signal })
    stream.on('text', (delta) => { reply('ai:chunk', delta) })
    const final = await stream.finalMessage()
    aiStreams.delete(streamId)
    reply('ai:done', { stopReason: final.stop_reason, usage: final.usage })
  } catch (err: unknown) {
    aiStreams.delete(streamId)
    const msg = err instanceof Error ? err.message : String(err)
    reply('ai:error', msg)
  }
})
ipcMain.on('ai:cancel', (_e, streamId: string) => {
  const c = aiStreams.get(streamId)
  if (c) { c.abort(); aiStreams.delete(streamId) }
})

// Persisted window geometry so the app reopens where the user left it.
const windowStatePath = (): string => join(app.getPath('userData'), 'window-state.json')
interface WindowState { x?: number; y?: number; width: number; height: number; maximized?: boolean }
async function loadWindowState(): Promise<WindowState> {
  try {
    const s = JSON.parse(await readFile(windowStatePath(), 'utf8')) as WindowState
    if (typeof s.width === 'number' && typeof s.height === 'number') return s
  } catch { /* first run / unreadable */ }
  return { width: 1200, height: 800 }
}

// Automation hook (docs capture / E2E): CONSTELLA_WINDOW_BOUNDS="x,y,w,h" pins the
// window at an exact CONTENT size — off-screen x keeps the capture run from
// flickering on the desktop while Chromium still paints frames.
function forcedBounds(): { x: number; y: number; width: number; height: number } | null {
  const m = /^(-?\d+),(-?\d+),(\d+),(\d+)$/.exec(process.env.CONSTELLA_WINDOW_BOUNDS ?? '')
  return m ? { x: +m[1], y: +m[2], width: +m[3], height: +m[4] } : null
}

function createWindow(state: WindowState): void {
  const forced = forcedBounds()
  const win = new BrowserWindow({
    title: 'Constella',
    width: forced ? forced.width : Math.max(800, state.width),
    height: forced ? forced.height : Math.max(600, state.height),
    ...(forced ? { x: forced.x, y: forced.y, useContentSize: true } : state.x != null && state.y != null ? { x: state.x, y: state.y } : {}),
    minWidth: 800,
    minHeight: 600,
    show: false,
    backgroundColor: '#020617',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      // Enables <webview> for web cards, so sites that block <iframe> embedding
      // (X-Frame-Options / CSP frame-ancestors) can still be displayed.
      webviewTag: true
    }
  })

  mainWindow = win

  win.on('ready-to-show', () => {
    // Under forced bounds the exact content size is the whole point — a stale
    // maximized flag from a reused profile must not override it.
    if (state.maximized && !forced) win.maximize()
    win.show()
  })
  // Capture geometry on close (not 'closed' — the window is already gone there).
  win.on('close', () => {
    // Never persist automation bounds (deliberately off-screen) into the profile:
    // they would make every later normal launch restore an invisible window.
    if (forced) return
    try {
      const maximized = win.isMaximized()
      // Use the normal (restored) bounds so un-maximizing later has a sane size.
      const b = maximized ? win.getNormalBounds() : win.getBounds()
      const next: WindowState = { x: b.x, y: b.y, width: b.width, height: b.height, maximized }
      writeFile(windowStatePath(), JSON.stringify(next)).catch(() => { /* best-effort */ })
    } catch { /* ignore */ }
  })
  win.on('closed', () => { if (mainWindow === win) mainWindow = null })

  win.webContents.setWindowOpenHandler((details) => {
    // Only hand http(s)/mailto to the OS; never file:/UNC/custom schemes (a card's
    // url can be attacker-controlled via an imported backup → arbitrary launch).
    try {
      const proto = new URL(details.url).protocol
      if (proto === 'http:' || proto === 'https:' || proto === 'mailto:') shell.openExternal(details.url)
    } catch { /* not a valid URL → ignore */ }
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Single-instance guard: two live instances would take turns writing the same
// constella.db (last writer wins → silent data rollback). The second launch
// focuses the existing window instead.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    // Purge media temp files materialized for "open source" in prior sessions.
    rm(join(app.getPath('temp'), 'constella'), { recursive: true, force: true }).catch(() => { /* ignore */ })
    await startEmbedServer() // before createWindow so embedBase is ready for the preload
    createWindow(await loadWindowState())
    initUpdater(() => mainWindow) // 自動アップデート(Win)・新版通知(mac/ポータブル)
    // Auto-start LAN access if the user enabled it previously.
    if (await loadRemoteEnabled()) startLanServer().catch(() => { /* ignore */ })
    app.on('activate', async () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(await loadWindowState())
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
