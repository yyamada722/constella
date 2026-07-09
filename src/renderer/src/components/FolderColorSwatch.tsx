// Reusable color swatch + popover for folder rows (Notes / Research).
// Click the dot to open a small 4-column palette; pick a color or clear.
import { useState, useRef, useEffect } from 'react'
import { ALL_BOARD_COLORS, BOARD_COLOR_CLASSES } from '../utils/boardColor'
import type { BoardColor } from '../types'

interface Props {
  value: BoardColor | undefined
  onChange: (next: BoardColor | undefined) => void
  className?: string
}

export function FolderColorSwatch({ value, onChange, className = '' }: Props) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const dotCls = value ? BOARD_COLOR_CLASSES[value].dot : 'bg-slate-300 hover:bg-slate-400'

  // Click outside dismisses.
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  return (
    <div ref={wrapRef} className={`relative ${className}`} onClick={e => e.stopPropagation()}>
      <button
        type="button"
        onClick={e => { e.stopPropagation(); setOpen(v => !v) }}
        title="フォルダの色を変更"
        className={`w-3 h-3 rounded-full ${dotCls} ring-1 ring-inset ring-black/10 transition-transform hover:scale-110`}
      />
      {open && (
        <div className="absolute right-0 top-5 z-30 bg-white border border-slate-200 rounded-lg shadow-xl p-2 grid grid-cols-4 gap-1.5 w-[120px]">
          {ALL_BOARD_COLORS.map(c => (
            <button
              key={c}
              type="button"
              onClick={e => { e.stopPropagation(); onChange(c); setOpen(false) }}
              className={`w-5 h-5 rounded-full ${BOARD_COLOR_CLASSES[c].dot} ${value === c ? 'ring-2 ring-offset-1 ring-slate-700' : 'hover:scale-110'} transition-transform`}
              title={c}
            />
          ))}
          <button
            type="button"
            onClick={e => { e.stopPropagation(); onChange(undefined); setOpen(false) }}
            className="col-span-4 mt-1 px-2 py-0.5 text-[10px] text-slate-500 hover:bg-slate-100 rounded"
          >
            色をクリア
          </button>
        </div>
      )}
    </div>
  )
}
