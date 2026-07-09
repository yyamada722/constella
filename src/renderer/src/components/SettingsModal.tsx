// Settings modal — currently exposes Theme + Code colorscheme pickers.
// Triggered from the Sidebar bottom button.
import { X } from 'lucide-react'
import { useTheme } from '../theme/ThemeContext'
import { CODE_THEMES } from '../theme/hljsThemes'

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

        <section>
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
      </div>
    </div>
  )
}
