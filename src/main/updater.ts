// 自動アップデート。配布形態で2系統に分かれる:
//  - 'auto'  : Windows の NSIS インストーラー版。electron-updater が GitHub Releases の
//              latest.yml を見て自動ダウンロード → 再起動(または終了時)に適用する。
//  - 'notify': macOS(ad-hoc署名のため Squirrel の署名検証を通らない)・ポータブル exe・
//              開発実行。GitHub API で新しいリリースを検知して知らせるだけで、
//              適用はリリースページからの手動ダウンロード。
import { app, ipcMain, shell, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'

const REPO = 'yyamada722/constella'
const RELEASES_URL = `https://github.com/${REPO}/releases/latest`
const CHECK_INTERVAL = 4 * 60 * 60 * 1000 // 起動後は4時間おきに再チェック
const FIRST_CHECK_DELAY = 8_000 // 起動直後のI/Oラッシュを避けて少し待つ

export type UpdatePhase =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'uptodate' }
  // notify系統: 適用は手動なのでダウンロード先URLを持つ
  | { phase: 'available'; version: string; url: string }
  | { phase: 'downloading'; version: string; percent: number }
  | { phase: 'downloaded'; version: string }
  | { phase: 'error'; message: string }

export type UpdateMode = 'auto' | 'notify'

// ポータブル版は electron-builder のランチャーがこの環境変数を立てる。
// インストーラー版だけが NSIS の差し替え更新を適用できる。
const mode: UpdateMode =
  process.platform === 'win32' && app.isPackaged && !process.env.PORTABLE_EXECUTABLE_DIR
    ? 'auto'
    : 'notify'

let state: UpdatePhase = { phase: 'idle' }
let getWindow: () => BrowserWindow | null = () => null

function setState(next: UpdatePhase): void {
  state = next
  const win = getWindow()
  if (win && !win.isDestroyed()) win.webContents.send('update:state', state)
}

// "v0.7.2" 同士を数値セグメントで比較。>0 なら a が新しい。
function cmpVersion(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0)
  const pb = b.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

// notify系統のチェック: 公開リポジトリの最新リリースを1回のAPI呼び出しで取得。
async function checkViaGitHub(): Promise<void> {
  setState({ phase: 'checking' })
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Constella' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) throw new Error(`GitHub API ${res.status}`)
    const rel = (await res.json()) as { tag_name?: string; html_url?: string }
    const tag = rel.tag_name ?? ''
    if (tag && cmpVersion(tag, app.getVersion()) > 0) {
      setState({ phase: 'available', version: tag.replace(/^v/, ''), url: rel.html_url || RELEASES_URL })
    } else {
      setState({ phase: 'uptodate' })
    }
  } catch (err) {
    setState({ phase: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}

function checkNow(): void {
  // ダウンロード中/完了後の再チェックは進行状態を壊すだけなので無視する。
  if (state.phase === 'downloading' || state.phase === 'downloaded') return
  if (mode === 'auto') {
    autoUpdater.checkForUpdates().catch(() => { /* エラーは error イベント側で拾う */ })
  } else {
    void checkViaGitHub()
  }
}

export function initUpdater(windowGetter: () => BrowserWindow | null): void {
  getWindow = windowGetter

  if (mode === 'auto') {
    autoUpdater.autoDownload = true
    // トーストを無視して普通に終了しても、次回起動時には新バージョンになっている。
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.on('checking-for-update', () => setState({ phase: 'checking' }))
    autoUpdater.on('update-available', info => setState({ phase: 'downloading', version: info.version, percent: 0 }))
    autoUpdater.on('update-not-available', () => setState({ phase: 'uptodate' }))
    autoUpdater.on('download-progress', p => {
      if (state.phase === 'downloading') setState({ ...state, percent: Math.round(p.percent) })
    })
    autoUpdater.on('update-downloaded', info => setState({ phase: 'downloaded', version: info.version }))
    autoUpdater.on('error', err => setState({ phase: 'error', message: err.message }))
  }

  ipcMain.handle('update:get', () => ({ current: app.getVersion(), mode, state }))
  ipcMain.handle('update:check', () => { checkNow() })
  ipcMain.handle('update:open-page', () => {
    const url = state.phase === 'available' ? state.url : RELEASES_URL
    return shell.openExternal(url)
  })
  ipcMain.on('update:install', () => {
    if (mode === 'auto' && state.phase === 'downloaded') {
      // silent=true: NSIS を /S で走らせ、インストーラーUIを出さずに差し替えて再起動。
      autoUpdater.quitAndInstall(true, true)
    }
  })

  // 自動チェックはパッケージ実行のみ(開発中・E2Eではネットワークに出ない)。
  // 手動チェック(update:check)はどのモードでも可能。
  if (app.isPackaged && !process.env.CONSTELLA_USERDATA) {
    setTimeout(checkNow, FIRST_CHECK_DELAY)
    setInterval(checkNow, CHECK_INTERVAL)
  }
}
