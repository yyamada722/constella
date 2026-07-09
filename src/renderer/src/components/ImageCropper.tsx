import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Check, X, Maximize } from 'lucide-react'

type Box = { x: number; y: number; w: number; h: number }
type Handle = 'nw' | 'ne' | 'sw' | 'se' | 'move'

// Modal image cropper. Non-destructive: it returns a NORMALIZED (0-1) crop rect for
// the card to clip-display; the original image is never modified, so the region can
// be changed again later. Rendered via a portal to <body> so it escapes the canvas
// CSS transform (position:fixed wouldn't work inside a transformed ancestor).
export function ImageCropper({ src, initialCrop, onApply, onReset, onCancel }: {
  src: string
  initialCrop?: Box
  onApply: (crop: Box) => void
  onReset?: () => void
  onCancel: () => void
}) {
  const imgRef = useRef<HTMLImageElement>(null)
  const [dims, setDims] = useState<{ dispW: number; dispH: number } | null>(null)
  const [crop, setCrop] = useState<Box | null>(null)
  const dragRef = useRef<{ mode: Handle; sx: number; sy: number; box: Box } | null>(null)

  const onImgLoad = () => {
    const img = imgRef.current
    if (!img) return
    const maxW = Math.min(window.innerWidth * 0.82, 980)
    const maxH = window.innerHeight * 0.72
    const s = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight, 1)
    const dispW = img.naturalWidth * s, dispH = img.naturalHeight * s
    setDims({ dispW, dispH })
    // Initialize the box from the existing crop (normalized) or default to 80% centered.
    const c = initialCrop ?? { x: 0.1, y: 0.1, w: 0.8, h: 0.8 }
    setCrop({ x: c.x * dispW, y: c.y * dispH, w: c.w * dispW, h: c.h * dispH })
  }

  useEffect(() => {
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
    const move = (e: MouseEvent) => {
      const d = dragRef.current
      if (!d || !dims) return
      const dx = e.clientX - d.sx, dy = e.clientY - d.sy
      const MIN = 24
      if (d.mode === 'move') {
        setCrop({ x: clamp(d.box.x + dx, 0, dims.dispW - d.box.w), y: clamp(d.box.y + dy, 0, dims.dispH - d.box.h), w: d.box.w, h: d.box.h })
        return
      }
      let left = d.box.x, top = d.box.y, right = d.box.x + d.box.w, bottom = d.box.y + d.box.h
      if (d.mode.includes('w')) left = clamp(d.box.x + dx, 0, right - MIN)
      if (d.mode.includes('e')) right = clamp(right + dx, left + MIN, dims.dispW)
      if (d.mode.includes('n')) top = clamp(d.box.y + dy, 0, bottom - MIN)
      if (d.mode.includes('s')) bottom = clamp(bottom + dy, top + MIN, dims.dispH)
      setCrop({ x: left, y: top, w: right - left, h: bottom - top })
    }
    const up = () => { dragRef.current = null }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel() } }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    window.addEventListener('keydown', key, true)
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); window.removeEventListener('keydown', key, true) }
  }, [dims, onCancel])

  const startDrag = (mode: Handle) => (e: React.MouseEvent) => {
    e.stopPropagation(); e.preventDefault()
    if (crop) dragRef.current = { mode, sx: e.clientX, sy: e.clientY, box: { ...crop } }
  }

  const apply = () => {
    if (!crop || !dims) return
    onApply({ x: crop.x / dims.dispW, y: crop.y / dims.dispH, w: crop.w / dims.dispW, h: crop.h / dims.dispH })
  }

  const handlePos = (c: Handle) => ({
    left: c.includes('w') ? -6 : undefined,
    right: c.includes('e') ? -6 : undefined,
    top: c.includes('n') ? -6 : undefined,
    bottom: c.includes('s') ? -6 : undefined,
  })
  const handleCursor: Record<string, string> = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize' }

  return createPortal(
    <div
      className="fixed inset-0 z-[80] bg-black/70 flex flex-col items-center justify-center gap-4 select-none"
      onMouseDown={e => e.stopPropagation()}
      onContextMenu={e => e.preventDefault()}
    >
      <div className="relative" style={dims ? { width: dims.dispW, height: dims.dispH } : undefined}>
        <img
          ref={imgRef}
          src={src}
          onLoad={onImgLoad}
          draggable={false}
          className="block max-w-none"
          style={dims ? { width: dims.dispW, height: dims.dispH } : undefined}
        />
        {crop && dims && (
          <div
            className="absolute border-2 border-white shadow-[0_0_0_9999px_rgba(0,0,0,0.55)]"
            style={{ left: crop.x, top: crop.y, width: crop.w, height: crop.h, cursor: 'move' }}
            onMouseDown={startDrag('move')}
          >
            {(['nw', 'ne', 'sw', 'se'] as const).map(c => (
              <div
                key={c}
                onMouseDown={startDrag(c)}
                className="absolute w-3 h-3 bg-white border border-slate-500 rounded-sm"
                style={{ ...handlePos(c), cursor: handleCursor[c] }}
              />
            ))}
          </div>
        )}
      </div>
      <div className="flex gap-2">
        <button onClick={onCancel} className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-white/90 text-slate-700 text-sm font-medium hover:bg-white">
          <X size={15} /> キャンセル
        </button>
        {onReset && (
          <button onClick={onReset} className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-white/90 text-slate-700 text-sm font-medium hover:bg-white">
            <Maximize size={15} /> 全体に戻す
          </button>
        )}
        <button onClick={apply} className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-teal-500 text-white text-sm font-medium hover:bg-teal-600">
          <Check size={15} /> この範囲で表示
        </button>
      </div>
    </div>,
    document.body,
  )
}
