import { useState, useEffect } from 'react'

// Displays an image, optionally clipped to a normalized (0-1) crop region.
// The crop is non-destructive: the original `src` is shown through an SVG viewBox
// that frames just the chosen region (object-contain within the box), so the
// region can be changed again at any time without altering the original image.
export function ClippedImage({ src, crop, alt }: {
  src: string
  crop?: { x: number; y: number; w: number; h: number }
  alt?: string
}) {
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null)

  useEffect(() => {
    if (!crop) { setNat(null); return }
    let alive = true
    const img = new Image()
    img.onload = () => { if (alive) setNat({ w: img.naturalWidth, h: img.naturalHeight }) }
    img.src = src
    return () => { alive = false }
  }, [src, crop])

  if (!crop) {
    return <img src={src} alt={alt ?? ''} className="max-w-full max-h-full object-contain select-none" draggable={false} />
  }
  if (!nat) return <div className="text-slate-400 text-[11px]">読み込み中…</div>

  const viewBox = `${crop.x * nat.w} ${crop.y * nat.h} ${crop.w * nat.w} ${crop.h * nat.h}`
  return (
    <svg viewBox={viewBox} preserveAspectRatio="xMidYMid meet" className="w-full h-full select-none" role="img" aria-label={alt}>
      <image href={src} width={nat.w} height={nat.h} />
    </svg>
  )
}
