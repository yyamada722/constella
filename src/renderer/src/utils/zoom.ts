// Shared wheel→zoom conversion for Canvas / Flow / Sketch / Mindtrain.
//
// The zoom factor is proportional to deltaY instead of a fixed step per event:
// a trackpad pinch arrives as a rapid stream of small-delta ctrlKey wheels
// (a fixed 8%/event made it race), while a mouse wheel notch (deltaY ≈ ±100)
// still moves a visible ~10% step. The exponent scales with a user-tunable
// speed (constella.zoomSpeed) shared by every zoomable surface.

const KEY = 'constella.zoomSpeed'
export const ZOOM_SPEED_MIN = 0.2
export const ZOOM_SPEED_MAX = 3
export const ZOOM_SPEED_DEFAULT = 1

let cached: number | null = null

export function getZoomSpeed(): number {
  if (cached == null) {
    let v = ZOOM_SPEED_DEFAULT
    try { v = Number(localStorage.getItem(KEY) || String(ZOOM_SPEED_DEFAULT)) } catch { /* ignore */ }
    cached = Number.isFinite(v) && v >= ZOOM_SPEED_MIN && v <= ZOOM_SPEED_MAX ? v : ZOOM_SPEED_DEFAULT
  }
  return cached
}

export function setZoomSpeed(v: number): void {
  cached = Math.min(ZOOM_SPEED_MAX, Math.max(ZOOM_SPEED_MIN, v))
  try { localStorage.setItem(KEY, String(cached)) } catch { /* ignore */ }
}

// Multiply the current zoom by this per wheel event. >1 zooms in (deltaY < 0).
export function wheelZoomFactor(e: WheelEvent): number {
  // deltaMode: 0=pixels, 1=lines, 2=pages — normalize to pixels.
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1
  // Clamp so an inertia spike can't teleport the zoom level in one event.
  const dy = Math.max(-240, Math.min(240, e.deltaY * unit))
  return Math.exp(-dy * 0.001 * getZoomSpeed())
}
