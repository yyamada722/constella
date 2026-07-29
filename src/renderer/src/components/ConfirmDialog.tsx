import { useEffect, useState } from 'react'

// App-styled replacement for the native confirm() dialog.
//
//   if (!(await confirmDialog('「メモ」を削除しますか？'))) return
//
// Mount <ConfirmHost /> once (App.tsx). confirmDialog() resolves true on 削除/OK,
// false on cancel — which includes clicking the backdrop or pressing Escape, per
// the app-wide "click outside to dismiss" convention. Enter confirms.

export interface ChoiceOption {
  label: string
  value: string
  danger?: boolean
}

interface ConfirmRequest {
  message: string
  confirmLabel: string
  danger: boolean
  // When set, the dialog shows a vertical option list instead of OK/cancel;
  // settle() then receives the picked value (or null on cancel).
  options: ChoiceOption[] | null
  resolve: (result: boolean | string | null) => void
}

let enqueue: ((req: ConfirmRequest) => void) | null = null

export function confirmDialog(message: string, opts?: { confirmLabel?: string; danger?: boolean }): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (!enqueue) { resolve(window.confirm(message)); return } // host not mounted — degrade to native
    enqueue({ message, confirmLabel: opts?.confirmLabel ?? '削除する', danger: opts?.danger ?? true, options: null, resolve: r => resolve(r === true) })
  })
}

// Choice variant: resolves with the picked option's value, or null on cancel
// (backdrop click / Escape). window.prompt is unavailable in Electron, so this
// is the way to ask "which one?" questions.
export function chooseDialog(message: string, options: ChoiceOption[]): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    if (!enqueue) { resolve(null); return } // host not mounted — treat as cancel
    enqueue({ message, confirmLabel: '', danger: false, options, resolve: r => resolve(typeof r === 'string' ? r : null) })
  })
}

export function ConfirmHost() {
  const [queue, setQueue] = useState<ConfirmRequest[]>([])
  const current = queue[0] ?? null

  useEffect(() => {
    enqueue = (req) => setQueue(q => [...q, req])
    return () => { enqueue = null }
  }, [])

  useEffect(() => {
    if (!current) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); settle(current.options ? null : false) }
      else if (e.key === 'Enter' && !current.options) { e.stopPropagation(); settle(true) }
    }
    // Capture phase so page-level Escape handlers (clear selection etc.) don't
    // also fire while the dialog is up.
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current])

  function settle(result: boolean | string | null) {
    if (!current) return
    current.resolve(result)
    setQueue(q => q.slice(1))
  }

  if (!current) return null
  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-slate-900/30"
      onMouseDown={() => settle(current.options ? null : false)} // backdrop click = cancel (app-wide dismiss convention)
    >
      <div
        className="w-[380px] max-w-[calc(100vw-48px)] bg-white border border-slate-200 rounded-lg shadow-xl p-4"
        onMouseDown={e => e.stopPropagation()}
      >
        <p className="text-sm text-slate-800 whitespace-pre-wrap leading-relaxed">{current.message}</p>
        {current.options ? (
          <>
            <div className="mt-3 max-h-[40vh] overflow-y-auto flex flex-col gap-1">
              {current.options.map(opt => (
                <button
                  key={opt.value}
                  onClick={() => settle(opt.value)}
                  className={`w-full text-left px-3 py-2 text-xs rounded-md border transition-colors ${
                    opt.danger
                      ? 'border-rose-200 text-rose-600 hover:bg-rose-50'
                      : 'border-slate-200 text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <div className="mt-3 flex justify-end">
              <button
                onClick={() => settle(null)}
                className="px-3 py-1.5 text-xs rounded-md text-slate-600 hover:bg-slate-100 transition-colors"
              >
                キャンセル
              </button>
            </div>
          </>
        ) : (
          <div className="mt-4 flex justify-end gap-2">
            <button
              onClick={() => settle(false)}
              className="px-3 py-1.5 text-xs rounded-md text-slate-600 hover:bg-slate-100 transition-colors"
            >
              キャンセル
            </button>
            <button
              autoFocus
              onClick={() => settle(true)}
              className={`px-3 py-1.5 text-xs rounded-md text-white font-semibold transition-colors ${
                current.danger ? 'bg-rose-500 hover:bg-rose-600' : 'bg-emerald-500 hover:bg-emerald-600'
              }`}
            >
              {current.confirmLabel}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
