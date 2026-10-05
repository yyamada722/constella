// Settings modal — Theme + Code colorscheme pickers + folder sync + app update check.
// Triggered from the Sidebar bottom button.
import { useEffect, useState } from 'react'
import { X, RefreshCw, FolderOpen, Copy, Check, Terminal } from 'lucide-react'
import { useTheme } from '../theme/ThemeContext'
import { CODE_THEMES } from '../theme/hljsThemes'
import { ZoomSpeedSlider } from './ZoomSpeedControl'
import { updateApi, useUpdateState } from './UpdateNotifier'
import { syncApi, useFolderSyncStatus, manualFolderSync } from '../persistence/folderSync'

// 他のマシンと同期 — OneDrive/Dropbox/NAS などの共有フォルダを媒介にした
// 「1台ずつ」前提の丸ごと同期。デスクトップ(Electron)のみ表示。
function FolderSyncSection() {
  const api = syncApi()
  const st = useFolderSyncStatus()
  const [cfg, setCfg] = useState<{ folder: string | null; enabled: boolean } | null>(null)
  const [name, setName] = useState('')
  useEffect(() => {
    api?.get()
      .then(s => { setCfg({ folder: s.folder, enabled: s.enabled }); setName(s.deviceName) })
      .catch(() => { /* ignore */ })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  if (!api) return null

  const pick = async (): Promise<void> => {
    const p = await api.pickFolder()
    if (!p) return
    const next = await api.configure({ folder: p, enabled: true })
    setCfg({ folder: next.folder, enabled: next.enabled })
    void manualFolderSync()
  }
  const toggle = async (): Promise<void> => {
    if (!cfg) return
    const next = await api.configure({ enabled: !cfg.enabled })
    setCfg({ folder: next.folder, enabled: next.enabled })
    void manualFolderSync()
  }
  const saveName = async (): Promise<void> => {
    if (!name.trim()) return
    const next = await api.configure({ deviceName: name })
    setName(next.deviceName)
  }

  const phaseText = (() => {
    switch (st.phase) {
      case 'checking': return <span className="text-slate-400">確認中…</span>
      case 'idle': return <span className="text-emerald-600">同期済み{st.lastSyncAt ? `(${new Date(st.lastSyncAt).toLocaleString()})` : ''}</span>
      case 'pushing': return <span className="text-indigo-600">送信中…</span>
      case 'pulling': return <span className="text-indigo-600">受信中…</span>
      case 'conflict': return <span className="text-rose-500">競合 — 画面上部のバナーからどちらを採用するか選択してください</span>
      case 'waiting': return <span className="text-amber-600">{st.message ?? 'クラウドの転送待ち…'}</span>
      case 'error': return <span className="text-rose-500">{st.message ?? '同期エラー'}</span>
      default: return null
    }
  })()

  return (
    <section className="mb-5">
      <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-2">他のマシンと同期</label>
      <div className="rounded-lg border border-slate-200 dark:border-slate-700 p-3 space-y-2.5">
        <div className="flex items-center gap-2">
          <span className="flex-1 min-w-0 text-xs text-slate-600 dark:text-slate-300 truncate" title={cfg?.folder ?? undefined}>
            {cfg?.folder ?? '同期フォルダ未設定'}
          </span>
          <button
            onClick={() => { void pick() }}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-slate-200 dark:border-slate-700 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors shrink-0"
          >
            <FolderOpen size={12} /> {cfg?.folder ? '変更' : 'フォルダを選択'}
          </button>
          {cfg?.folder && (
            <button
              onClick={() => { void toggle() }}
              title="同期のオン/オフ"
              className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${cfg.enabled ? 'bg-indigo-500' : 'bg-slate-300 dark:bg-slate-600'}`}
            >
              <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${cfg.enabled ? 'translate-x-4' : ''}`} />
            </button>
          )}
        </div>
        {cfg?.folder && cfg.enabled && (
          <>
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-500 dark:text-slate-400 shrink-0">このマシンの名前</span>
              <input
                value={name}
                onChange={e => setName(e.target.value)}
                onBlur={() => { void saveName() }}
                className="flex-1 min-w-0 px-2 py-1 text-xs bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-700 dark:text-slate-200"
                placeholder="例: 自宅デスクトップ"
              />
              <button
                onClick={() => { void manualFolderSync() }}
                disabled={st.phase === 'pushing' || st.phase === 'pulling' || st.phase === 'checking'}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-slate-200 dark:border-slate-700 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 transition-colors shrink-0"
              >
                <RefreshCw size={12} className={st.phase === 'checking' || st.phase === 'pushing' || st.phase === 'pulling' ? 'animate-spin' : ''} /> 今すぐ同期
              </button>
            </div>
            {phaseText && <div className="text-[11px]">{phaseText}</div>}
          </>
        )}
        <p className="text-[11px] text-slate-400">
          OneDrive / Dropbox / NAS などの共有フォルダを指定すると、起動時・保存後・ウィンドウ切替時に自動で同期します。
          複数のマシンで同時に編集する使い方は想定していません(両方で変更があった場合はどちらを採用するか選択します)。
        </p>
      </div>
    </section>
  )
}

// コマンドライン (CLI) — `constella` コマンドの置き場所と使い方の案内。
// 実体は main が起動毎に userData/bin へ書き出す。デスクトップ(Electron)のみ表示。
function CliSection() {
  const api = (window as unknown as { api?: { cli?: { info: () => Promise<{ dir: string; command: string } | null> } } }).api?.cli
  const [info, setInfo] = useState<{ dir: string; command: string } | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  useEffect(() => { api?.info().then(setInfo).catch(() => { /* ignore */ }) }, [api])
  if (!api || !info) return null
  const ua = navigator.userAgent
  const isWin = ua.includes('Windows')
  // パスに ' が入っても壊れないよう、各シェルの引用規則でエスケープする。
  // PowerShell: '…' 内の ' は ''。sh: 'a'\''b' 形式。プロファイルへ書く行自体も
  // ' で囲んで追記するので二重にエスケープする。
  const psq = (s: string): string => `'${s.replace(/'/g, "''")}'`
  const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
  const pathCmd = isWin
    ? `[Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ';' + ${psq(info.dir)}, 'User')`
    : null
  // mac の既定シェルは zsh、Linux は bash。fish 等は案内文で補う。
  const shellRows = isWin ? [] : (ua.includes('Mac') ? ['zsh', 'bash'] : ['bash', 'zsh']).map(sh => ({
    sh,
    cmd: `echo ${shq(`export PATH="$PATH":${shq(info.dir)}`)} >> ~/.${sh === 'zsh' ? 'zshrc' : 'bashrc'}`,
  }))
  const copy = (key: string, text: string): void => {
    navigator.clipboard.writeText(text).then(() => { setCopied(key); setTimeout(() => setCopied(c => (c === key ? null : c)), 1500) }).catch(() => { /* ignore */ })
  }
  const Row = ({ k, label, text }: { k: string; label: string; text: string }) => (
    <div>
      <div className="text-[11px] text-slate-500 dark:text-slate-400 mb-0.5">{label}</div>
      <div className="flex items-center gap-1.5">
        <code className="flex-1 min-w-0 truncate px-2 py-1 rounded bg-slate-50 dark:bg-slate-800 text-[11px] text-slate-700 dark:text-slate-200" title={text}>{text}</code>
        <button onClick={() => copy(k, text)} className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 shrink-0" title="コピー">
          {copied === k ? <Check size={12} className="text-emerald-600" /> : <Copy size={12} />}
        </button>
      </div>
    </div>
  )
  return (
    <section className="mb-5">
      <label className="flex items-center gap-1.5 text-xs font-medium text-slate-500 dark:text-slate-400 mb-2"><Terminal size={12} /> コマンドライン (CLI)</label>
      <div className="rounded-lg border border-slate-200 dark:border-slate-700 p-3 space-y-2">
        <Row k="cmd" label="コマンド" text={info.command} />
        {pathCmd && <Row k="path" label="PATH に追加 (PowerShell で1回実行 → ターミナルを開き直す)" text={pathCmd} />}
        {shellRows.map(r => (
          <Row key={r.sh} k={`path-${r.sh}`} label={`PATH に追加 — ${r.sh} の場合 (1回実行 → ターミナルを開き直す)`} text={r.cmd} />
        ))}
        {!isWin && <p className="text-[11px] text-slate-400">それ以外のシェル (fish など) では、上のフォルダを PATH に加えてください。</p>}
        <p className="text-[11px] text-slate-400">
          <code>constella tasks</code> / <code>constella note get &lt;id&gt;</code> などで、タスクとノートを読み書きできます(<code>constella --help</code>)。
          アプリが起動していなければ自動で起動します。書き込みは <code>-y</code> を付けたときだけ適用され、アプリで Ctrl+Z 1回で戻せます。
        </p>
      </div>
    </section>
  )
}

// アップデート欄 — 現在のバージョンと手動チェック。デスクトップ(Electron)のみ表示。
function UpdateSection() {
  const { current, mode, state } = useUpdateState()
  if (!updateApi) return null

  const status = (() => {
    switch (state.phase) {
      case 'checking': return <span className="text-slate-400">確認中…</span>
      case 'uptodate': return <span className="text-emerald-600">最新です</span>
      case 'available': return (
        <span className="text-indigo-600">
          v{state.version} があります —{' '}
          <button onClick={() => { void updateApi!.openPage() }} className="underline hover:text-indigo-700">
            ダウンロードページを開く
          </button>
        </span>
      )
      case 'downloading': return <span className="text-indigo-600">v{state.version} をダウンロード中… {state.percent}%</span>
      case 'downloaded': return (
        <span className="text-indigo-600">
          v{state.version} の準備完了 —{' '}
          <button onClick={() => updateApi!.install()} className="underline hover:text-indigo-700">
            再起動して更新
          </button>
        </span>
      )
      case 'error': return <span className="text-rose-500" title={state.message}>確認できませんでした</span>
      default: return null
    }
  })()

  return (
    <section>
      <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-2">アップデート</label>
      <div className="rounded-lg border border-slate-200 dark:border-slate-700 p-3">
        <div className="flex items-center gap-2">
          <span className="text-sm text-slate-700 dark:text-slate-200">現在のバージョン: v{current || '…'}</span>
          <button
            onClick={() => { void updateApi!.check() }}
            disabled={state.phase === 'checking' || state.phase === 'downloading'}
            className="ml-auto flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-slate-200 dark:border-slate-700 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 transition-colors"
          >
            <RefreshCw size={12} className={state.phase === 'checking' ? 'animate-spin' : ''} /> 更新を確認
          </button>
        </div>
        {status && <div className="mt-1.5 text-[11px]">{status}</div>}
        <p className="mt-1.5 text-[11px] text-slate-400">
          {mode === 'auto'
            ? '新しいバージョンは自動でダウンロードされ、再起動時に適用されます。'
            : 'この版は自動適用に対応していないため、新版はリリースページから入手してください。'}
        </p>
      </div>
    </section>
  )
}

interface Props {
  open: boolean
  onClose: () => void
}

export function SettingsModal({ open, onClose }: Props) {
  const { mode, setMode, codeTheme, setCodeTheme } = useTheme()
  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/40"
      onMouseDown={onClose}
    >
      <div
        className="w-[460px] max-w-[92vw] max-h-[90vh] overflow-y-auto bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-2xl p-5"
        onMouseDown={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">設定</h2>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500"
          >
            <X size={16} />
          </button>
        </div>

        <section className="mb-5">
          <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-2">外観テーマ</label>
          <div className="inline-flex rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden">
            {(['light', 'dark'] as const).map(m => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`px-4 py-1.5 text-sm transition ${
                  mode === m
                    ? 'bg-slate-800 text-white dark:bg-slate-100 dark:text-slate-900'
                    : 'bg-white text-slate-600 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800'
                }`}
              >
                {m === 'light' ? 'ライト' : 'ダーク'}
              </button>
            ))}
          </div>
        </section>

        <section className="mb-5">
          <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-2">ズーム / ピンチ感度</label>
          <div className="rounded-lg border border-slate-200 dark:border-slate-700 p-3">
            <ZoomSpeedSlider />
          </div>
        </section>

        <section className="mb-5">
          <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-2">コードハイライト</label>
          <select
            value={codeTheme}
            onChange={e => setCodeTheme(e.target.value as never)}
            className="w-full px-3 py-1.5 text-sm bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-700 dark:text-slate-200"
          >
            {CODE_THEMES.map(t => (
              <option key={t.id} value={t.id}>{t.label}</option>
            ))}
          </select>
          <p className="mt-2 text-[11px] text-slate-400">プレビューとマークダウンのコードブロックに反映されます。</p>
        </section>

        <FolderSyncSection />

        <CliSection />

        <UpdateSection />
      </div>
    </div>
  )
}
