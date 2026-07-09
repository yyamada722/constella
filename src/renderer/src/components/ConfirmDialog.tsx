import { useEffect, useState } from 'react'

// App-styled replacement for the native confirm() dialog.
//
//   if (!(await confirmDialog('「メモ」を削除しますか？'))) return
//
// Mount <ConfirmHost /> once (App.tsx). confirmDialog() resolves true on 削除/OK,
// false on cancel — which includes clicking the backdrop or pressing Escape, per
// the app-wide "click outside to dismiss" convention. Enter confirms.

interface ConfirmRequest {
  message: string
  confirmLabel: string
  danger: boolean
  resolve: (ok: boolean) => void
}

let enqueue: ((req: ConfirmRequest) => void) | null = null

export function confirmDialog(message: string, opts?: { confirmLabel?: string; danger?: boolean }): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (!enqueue) { resolve(window.confirm(message)); return } // host not mounted — degrade to native
    enqueue({ message, confirmLabel: opts?.confirmLabel ?? '削除する', danger: opts?.danger ?? true, resolve })
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
      if (e.key === 'Escape') { e.stopPropagation(); settle(false) }
      else if (e.key === 'Enter') { e.stopPropagation(); settle(true) }
    }
    // Capture phase so page-level Escape handlers (clear selection etc.) don't
    // also fire while the dialog is up.
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current])

  function settle(ok: boolean) {
    if (!current) return
    current.resolve(ok)
    setQueue(q => q.slice(1))
  }

  if (!current) return null
  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-slate-900/30"
      onMouseDown={() => settle(false)} // backdrop click = cancel (app-wide dismiss convention)
    >
      <div
        className="w-[380px] max-w-[calc(100vw-48px)] bg-white border border-slate-200 rounded-lg shadow-xl p-4"
        onMouseDown={e => e.stopPropagation()}
      >
        <p className="text-sm text-slate-800 whitespace-pre-wrap leading-relaxed">{current.message}</p>
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
      </div>
    </div>
  )
}
