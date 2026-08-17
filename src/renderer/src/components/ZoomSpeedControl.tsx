import { useState } from 'react'
import { usePopoverDismiss } from './usePopoverDismiss'
import { getZoomSpeed, setZoomSpeed, ZOOM_SPEED_MIN, ZOOM_SPEED_MAX, ZOOM_SPEED_DEFAULT } from '../utils/zoom'

// Slider body shared by the toolbar popover below and the app SettingsModal.
// Reads the current speed at mount, so mount it fresh when shown (both hosts do).
export function ZoomSpeedSlider() {
  const [speed, setSpeed] = useState(getZoomSpeed)
  const apply = (v: number) => { setSpeed(v); setZoomSpeed(v) }
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-slate-600">ズーム速度</span>
        <span className="text-xs tabular-nums text-slate-500">×{speed.toFixed(1)}</span>
      </div>
      <input
        type="range"
        min={ZOOM_SPEED_MIN}
        max={ZOOM_SPEED_MAX}
        step={0.1}
        value={speed}
        onChange={e => apply(Number(e.target.value))}
        className="w-full accent-indigo-500"
      />
      <div className="flex justify-between text-[10px] text-slate-400 mt-0.5">
        <span>遅い</span>
        <span>速い</span>
      </div>
      <button
        onClick={() => apply(ZOOM_SPEED_DEFAULT)}
        className="mt-2 w-full text-[11px] text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded py-1"
      >
        標準に戻す（×1.0）
      </button>
      <p className="mt-1.5 text-[10px] leading-relaxed text-slate-400">
        トラックパッドのピンチ / Ctrl+ホイールのズーム速度。キャンバス・フロー・スケッチ共通。
      </p>
    </div>
  )
}

// Zoom % readout that doubles as the zoom-speed setting: click to open a small
// slider popover. The speed is app-wide (localStorage) and shared by the
// Canvas / Flow / Sketch / Mindtrain wheel handlers via wheelZoomFactor().
export default function ZoomSpeedControl({ zoom, className }: { zoom: number; className?: string }) {
  const [open, setOpen] = useState(false)
  const popRef = usePopoverDismiss<HTMLDivElement>(open, () => setOpen(false))
  return (
    <div className="relative" ref={popRef}>
      <button
        onClick={() => setOpen(v => !v)}
        title="ズーム速度を設定"
        className={className ?? 'text-xs text-slate-500 w-12 text-center rounded hover:bg-slate-100 py-0.5'}
      >
        {Math.round(zoom * 100)}%
      </button>
      {open && (
        <div className="absolute top-full right-0 mt-1 z-50 w-56 rounded-lg border border-slate-200 bg-white shadow-lg p-3">
          <ZoomSpeedSlider />
        </div>
      )}
    </div>
  )
}
