// Shared search input — clear button + localStorage-backed history dropdown.
// Used everywhere a search bar appears (Notes / Tasks / Research / Canvas /
// Mindtrain / Global Search). Keep this small: no fancy ranking, just plumbing.
import { useEffect, useRef, useState } from 'react'
import { Search, X, Clock } from 'lucide-react'

interface Props {
  value: string
  onChange: (next: string) => void
  /** localStorage key for the per-input history. Distinct keys per surface so they
   *  don't pollute each other (notes vs tasks vs research). */
  historyKey: string
  placeholder?: string
  /** Max history entries to remember. */
  maxHistory?: number
  /** Visual size tuning — "sm" matches the existing sidebar inputs (11px font). */
  size?: 'sm' | 'md'
  /** Optional tailwind classes for the outer wrapper. */
  className?: string
  /** Called on Enter; also called on blur so a typed query is auto-committed
   *  to history. */
  onSubmit?: (value: string) => void
  /** Auto-focus on mount (e.g. when opening a modal). */
  autoFocus?: boolean
}

const MAX_DEFAULT = 12

function loadHistory(key: string): string[] {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return []
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((x: unknown): x is string => typeof x === 'string') : []
  } catch { return [] }
}

function saveHistory(key: string, hist: string[]) {
  // Storage can throw QuotaExceededError (per-origin ~5MB cap on most browsers /
  // Electron renderers). Trim aggressively and retry so history keeps working
  // instead of silently freezing on the last size before the quota was hit.
  let attempt = hist
  for (let tries = 0; tries < 3; tries++) {
    try { localStorage.setItem(key, JSON.stringify(attempt)); return } catch {
      if (attempt.length === 0) return
      attempt = attempt.slice(0, Math.max(1, Math.floor(attempt.length / 2)))
    }
  }
}

export function SearchInput({
  value, onChange, historyKey, placeholder = '検索', maxHistory = MAX_DEFAULT,
  size = 'sm', className = '', onSubmit, autoFocus,
}: Props) {
  const [history, setHistory] = useState<string[]>(() => loadHistory(historyKey))
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Click-outside dismisses the dropdown.
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  function commit(q: string) {
    const t = q.trim()
    if (!t) return
    setHistory(prev => {
      const next = [t, ...prev.filter(x => x !== t)].slice(0, maxHistory)
      saveHistory(historyKey, next)
      return next
    })
    onSubmit?.(t)
  }

  function pick(q: string) {
    onChange(q)
    setOpen(false)
    inputRef.current?.focus()
  }

  function removeHistory(q: string) {
    setHistory(prev => {
      const next = prev.filter(x => x !== q)
      saveHistory(historyKey, next)
      return next
    })
  }

  function clearAllHistory() {
    setHistory([])
    saveHistory(historyKey, [])
  }

  const inputCls = size === 'sm'
    ? 'text-[11px] py-1 pl-6 pr-6'
    : 'text-sm py-1.5 pl-7 pr-7'
  const iconSize = size === 'sm' ? 12 : 14

  return (
    <div ref={wrapRef} className={`relative ${className}`}>
      <Search size={iconSize} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        onFocus={() => setOpen(true)}
        onBlur={() => commit(value)}
        onKeyDown={e => {
          if (e.key === 'Escape') {
            e.preventDefault()
            if (value) onChange('')
            else setOpen(false)
            return
          }
          if (e.key === 'Enter' && !e.nativeEvent.isComposing && (e as unknown as { keyCode: number }).keyCode !== 229) {
            e.preventDefault()
            commit(value)
            setOpen(false)
          }
        }}
        placeholder={placeholder}
        autoFocus={autoFocus}
        className={`w-full bg-slate-50 border border-slate-200 rounded-md outline-none focus:border-amber-400 ${inputCls}`}
      />
      {value && (
        <button
          type="button"
          onMouseDown={e => e.preventDefault() /* keep input focused */}
          onClick={() => { onChange(''); inputRef.current?.focus() }}
          title="クリア (Esc)"
          className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-slate-200 text-slate-400 hover:text-slate-700"
        >
          <X size={iconSize} />
        </button>
      )}
      {open && history.length > 0 && (
        <div className="absolute left-0 right-0 top-full mt-1 z-30 bg-white border border-slate-200 rounded-md shadow-xl py-1 max-h-[240px] overflow-y-auto">
          <div className="px-2 py-0.5 flex items-center justify-between text-[9px] uppercase tracking-wide text-slate-400">
            <span className="flex items-center gap-1"><Clock size={9} /> 履歴</span>
            <button onMouseDown={e => e.preventDefault()} onClick={clearAllHistory} className="hover:text-rose-500">全消去</button>
          </div>
          {history.map(h => (
            <div key={h} className="group flex items-center hover:bg-slate-50">
              <button
                type="button"
                onMouseDown={e => e.preventDefault()}
                onClick={() => pick(h)}
                className="flex-1 text-left px-2 py-1 text-[11px] text-slate-700 truncate"
                title={h}
              >{h}</button>
              <button
                type="button"
                onMouseDown={e => e.preventDefault()}
                onClick={() => removeHistory(h)}
                title="この履歴を消す"
                className="p-1 text-slate-300 hover:text-rose-500 opacity-0 group-hover:opacity-100"
              ><X size={10} /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
