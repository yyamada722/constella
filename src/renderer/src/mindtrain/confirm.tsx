// Lightweight promise-based confirm dialog for the 路線図 mode, replacing the
// native window.confirm so deletions match Constella's in-app modal style.
// Usage: `if (await mtConfirm('消しますか？', '削除')) { ... }`
import { useEffect, useState, type CSSProperties } from 'react'

type Pending = { message: string; confirmLabel: string; resolve: (ok: boolean) => void } | null

let current: Pending = null
let listeners: Array<(p: Pending) => void> = []
function emit(p: Pending) { current = p; listeners.forEach((l) => l(p)) }

export function mtConfirm(message: string, confirmLabel = 'OK'): Promise<boolean> {
  return new Promise((resolve) => {
    emit({ message, confirmLabel, resolve: (ok) => { emit(null); resolve(ok) } })
  })
}

export function MtConfirmHost() {
  const [p, setP] = useState<Pending>(current)
  useEffect(() => {
    const l = (np: Pending) => setP(np)
    listeners.push(l)
    return () => { listeners = listeners.filter((x) => x !== l) }
  }, [])
  useEffect(() => {
    if (!p) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); p.resolve(false) }
      else if (e.key === 'Enter') { e.preventDefault(); p.resolve(true) }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [p])
  if (!p) return null
  // May render outside .mt-root (portal-style overlay), so key the dark
  // palette off the global --surface / fall back to the light colors.
  const dark = document.documentElement.classList.contains('dark')
  const btn: CSSProperties = { padding: '7px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', border: `1px solid ${dark ? '#3a3a40' : '#d2d6dd'}`, background: 'var(--surface, #fff)', color: dark ? '#c9c9ce' : '#383c43' }
  return (
    <div onMouseDown={() => p.resolve(false)} style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onMouseDown={(e) => e.stopPropagation()} style={{ background: 'var(--surface, #fff)', borderRadius: 12, padding: '20px 22px', width: 360, maxWidth: '90vw', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
        <div style={{ fontSize: 13.5, color: dark ? '#e7e7ea' : '#1a1d22', whiteSpace: 'pre-wrap', lineHeight: 1.65, marginBottom: 18 }}>{p.message}</div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button style={btn} onClick={() => p.resolve(false)}>キャンセル</button>
          <button autoFocus style={{ ...btn, border: '1px solid #dc3545', background: '#dc3545', color: '#fff' }} onClick={() => p.resolve(true)}>{p.confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}
