import { useEffect, useRef, useState } from 'react'
import { HELP_CHAPTERS } from '../help'
import { renderMarkdown } from './typol/markdown'
import { renderMermaidIn } from './typol/mermaid'

// In-app manual — replaces the old shortcut-only cheat sheet. Opened with "?"
// (shortcuts chapter) or from the sidebar settings menu (intro chapter).
export default function HelpModal({ open, chapter, onClose }: {
  open: boolean
  chapter?: string
  onClose: () => void
}) {
  const [active, setActive] = useState(HELP_CHAPTERS[0].id)
  const hostRef = useRef<HTMLDivElement>(null)

  // Each open picks up the requested chapter (or falls back to the first).
  useEffect(() => {
    if (!open) return
    setActive(chapter && HELP_CHAPTERS.some(c => c.id === chapter) ? chapter : HELP_CHAPTERS[0].id)
  }, [open, chapter])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Render the active chapter through the Typol pipeline (same as note previews).
  useEffect(() => {
    if (!open || !hostRef.current) return
    const host = hostRef.current
    const body = HELP_CHAPTERS.find(c => c.id === active)?.body ?? ''
    host.innerHTML = renderMarkdown(body).html
    void renderMermaidIn(host)
    host.scrollTop = 0
  }, [open, active])

  // External links open in the browser; everything else (wiki:/anchors) is inert here.
  useEffect(() => {
    if (!open || !hostRef.current) return
    const host = hostRef.current
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement | null)?.closest?.('a') as HTMLAnchorElement | null
      if (!a) return
      const href = a.getAttribute('href') ?? ''
      if (/^https?:\/\//i.test(href)) {
        a.target = a.target || '_blank'
        a.rel = 'noreferrer'
      } else {
        e.preventDefault()
      }
    }
    host.addEventListener('click', onClick)
    return () => host.removeEventListener('click', onClick)
  }, [open])

  if (!open) return null
  return (
    <div className="fixed inset-0 z-[105] flex items-center justify-center bg-slate-900/30" onMouseDown={onClose}>
      <div
        className="w-[880px] max-w-[calc(100vw-48px)] h-[80vh] bg-white border border-slate-200 rounded-xl shadow-2xl flex overflow-hidden"
        onMouseDown={e => e.stopPropagation()}
      >
        <div className="w-[180px] shrink-0 border-r border-slate-200 bg-slate-50 flex flex-col">
          <div className="px-4 pt-4 pb-2 text-sm font-semibold text-slate-800">ヘルプ</div>
          <nav className="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
            {HELP_CHAPTERS.map(c => (
              <button
                key={c.id}
                onClick={() => setActive(c.id)}
                className={`w-full text-left px-2.5 py-1.5 rounded-md text-xs transition-colors ${
                  active === c.id
                    ? 'bg-slate-200 text-slate-900 font-medium'
                    : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800'
                }`}
              >
                {c.title}
              </button>
            ))}
          </nav>
          <div className="px-4 py-2 text-[10px] text-slate-400 border-t border-slate-200">Constella v{__APP_VERSION__}</div>
        </div>
        <div className="flex-1 min-w-0 relative">
          <button
            onClick={onClose}
            title="閉じる"
            className="absolute top-3 right-3 z-10 p-1 rounded hover:bg-slate-100 text-slate-400 hover:text-slate-700"
          >
            ✕
          </button>
          <div ref={hostRef} className="typol-root typol-preview md-content h-full overflow-y-auto px-7 py-5 text-sm" />
        </div>
      </div>
    </div>
  )
}
