// Settings modal — Theme + Code colorscheme pickers + app update check.
// Triggered from the Sidebar bottom button.
import { X, RefreshCw } from 'lucide-react'
import { useTheme } from '../theme/ThemeContext'
import { CODE_THEMES } from '../theme/hljsThemes'
import { ZoomSpeedSlider } from './ZoomSpeedControl'
import { updateApi, useUpdateState } from './UpdateNotifier'

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
        className="w-[460px] max-w-[92vw] bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-2xl p-5"
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

        <UpdateSection />
      </div>
    </div>
  )
}
