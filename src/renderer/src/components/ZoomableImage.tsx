// Image preview with the same zoom grammar as PdfViewer: Ctrl+wheel / pinch
// zooms around the cursor, ± buttons step, the % pill resets, and a zoomed
// image pans by drag (or plain wheel). 1 = fit-to-box (object-contain).
import { useEffect, useRef, useState } from 'react'
import { ZoomIn, ZoomOut } from 'lucide-react'

const ZOOM_MIN = 0.5
const ZOOM_MAX = 8
const ZOOM_STEP = 1.25
const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z))

export function ZoomableImage({ src, alt, onError }: { src: string; alt?: string; onError?: () => void }) {
  const boxRef = useRef<HTMLDivElement>(null)
  const [t, setT] = useState({ s: 1, x: 0, y: 0 })
  const tRef = useRef(t)
  tRef.current = t
  const dragRef = useRef<{ px: number; py: number; x: number; y: number } | null>(null)

  useEffect(() => { setT({ s: 1, x: 0, y: 0 }) }, [src])

  // Zoom so the box point (cx, cy — relative to the box centre) stays put.
  const zoomAt = (next: number, cx: number, cy: number) => {
    const cur = tRef.current
    const s = clampZoom(next)
    if (s === cur.s) return
    const k = s / cur.s
    const nt = s <= 1
      ? { s, x: 0, y: 0 }
      : { s, x: cx - (cx - cur.x) * k, y: cy - (cy - cur.y) * k }
    setT(nt)
  }
  const zoomCentre = (next: number) => zoomAt(next, 0, 0)

  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const r = el.getBoundingClientRect()
      const cx = e.clientX - (r.left + r.width / 2)
      const cy = e.clientY - (r.top + r.height / 2)
      if (e.ctrlKey || e.metaKey) {
        zoomAt(tRef.current.s * Math.exp(-e.deltaY * 0.0015), cx, cy)
      } else if (tRef.current.s > 1) {
        setT(p => ({ ...p, x: p.x - e.deltaX, y: p.y - e.deltaY }))
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const zoomed = t.s > 1.001
  return (
    <div
      ref={boxRef}
      className={`relative w-full h-full overflow-hidden flex items-center justify-center select-none ${zoomed ? (dragRef.current ? 'cursor-grabbing' : 'cursor-grab') : ''}`}
      onPointerDown={e => {
        if (!zoomed || e.button !== 0) return
        dragRef.current = { px: e.clientX, py: e.clientY, x: t.x, y: t.y }
        e.currentTarget.setPointerCapture(e.pointerId)
      }}
      onPointerMove={e => {
        const d = dragRef.current
        if (!d) return
        setT(p => ({ ...p, x: d.x + (e.clientX - d.px), y: d.y + (e.clientY - d.py) }))
      }}
      onPointerUp={() => { dragRef.current = null }}
      onPointerCancel={() => { dragRef.current = null }}
      onDoubleClick={e => {
        const r = e.currentTarget.getBoundingClientRect()
        const cx = e.clientX - (r.left + r.width / 2)
        const cy = e.clientY - (r.top + r.height / 2)
        zoomAt(zoomed ? 1 : 2.5, cx, cy)
      }}
    >
      <img
        src={src}
        alt={alt}
        draggable={false}
        onError={onError}
        className="max-w-full max-h-full object-contain rounded shadow-2xl"
        style={{ transform: `translate(${t.x}px, ${t.y}px) scale(${t.s})`, transformOrigin: 'center' }}
      />
      <div
        className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-1 px-1.5 py-1 rounded-full bg-slate-900/70 text-white/80 backdrop-blur-sm"
        onPointerDown={e => e.stopPropagation()}
        onDoubleClick={e => e.stopPropagation()}
      >
        <button onClick={() => zoomCentre(t.s / ZOOM_STEP)} disabled={t.s <= ZOOM_MIN + 0.001} className="p-1 rounded-full hover:bg-white/15 disabled:opacity-30" title="縮小 (Ctrl+ホイール)"><ZoomOut size={14} /></button>
        <button onClick={() => zoomCentre(1)} className="px-1.5 text-[11px] tabular-nums hover:text-white" title="全体表示に戻す（ダブルクリックでも切替）">{Math.round(t.s * 100)}%</button>
        <button onClick={() => zoomCentre(t.s * ZOOM_STEP)} disabled={t.s >= ZOOM_MAX - 0.001} className="p-1 rounded-full hover:bg-white/15 disabled:opacity-30" title="拡大 (Ctrl+ホイール)"><ZoomIn size={14} /></button>
      </div>
    </div>
  )
}
