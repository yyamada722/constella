import { useState, useRef, useMemo, useEffect, useCallback } from 'react'
import { Plus, Trash2, Pencil, Eraser, Undo2, Redo2, Eraser as ClearIcon, ZoomIn, ZoomOut, Maximize, ImageDown, FileDown } from 'lucide-react'
import { useApp } from '../store'
import { Sketch, SketchStroke } from '../types'
import { generateId } from '../utils'

const COLORS = ['#1e293b', '#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#ffffff']
const WIDTHS = [2, 4, 8, 14]
// Initial canvas extent in content units. Strokes can live outside it; we still pan/zoom freely.
const CONTENT_W = 2000
const CONTENT_H = 1400

export default function SketchPage() {
  const { state, dispatch, canUndo, canRedo, undo, redo } = useApp()
  const active = state.activeMasterProjectId
  const sketches = useMemo(() => state.sketches.filter(s => s.masterProjectId === active), [state.sketches, active])
  const [selectedId, setSelectedId] = useState<string | null>(sketches[0]?.id ?? null)
  const [tool, setTool] = useState<'pen' | 'eraser'>('pen')
  const [eraseMode, setEraseMode] = useState<'brush' | 'stroke'>('brush')
  const [color, setColor] = useState(COLORS[0])
  const [width, setWidth] = useState(WIDTHS[1])
  // Viewport — `x,y` is the top-left of the visible rect in *content* space.
  // Strokes live in content space; pointer events convert through this.
  const [viewport, setViewport] = useState<{ x: number; y: number; zoom: number }>({ x: 0, y: 0, zoom: 1 })
  const spaceRef = useRef(false)
  const panRef = useRef<{ x0: number; y0: number; vx: number; vy: number } | null>(null)

  const selected = sketches.find(s => s.id === selectedId) ?? null

  // Keep the selection within the active project's sketches.
  useEffect(() => {
    if (selectedId && !sketches.find(s => s.id === selectedId)) setSelectedId(sketches[0]?.id ?? null)
  }, [sketches, selectedId])

  const svgRef = useRef<SVGSVGElement>(null)
  const drawingRef = useRef(false)
  const ptsRef = useRef<number[]>([])
  const eraseWorkingRef = useRef<SketchStroke[]>([])
  // The in-progress pen stroke is drawn by mutating this <polyline>'s points directly
  // (no React state/re-render per pointermove), so freehand drawing stays smooth even
  // on a tablet with a long stroke. It's committed to the store only on pointerup.
  const liveRef = useRef<SVGPolylineElement>(null)
  // While erasing, the in-progress (partially-cut) stroke set, shown instead of the
  // saved strokes until the gesture commits.
  const [liveErase, setLiveErase] = useState<SketchStroke[] | null>(null)

  // Sketch identity changed (deleted mid-stroke, list swap, etc.) — abort any
  // in-progress pen/erase gesture so its accumulated points don't get committed
  // to the newly-selected sketch.
  useEffect(() => {
    drawingRef.current = false
    ptsRef.current = []
    eraseWorkingRef.current = []
    liveRef.current?.points.clear()
    setLiveErase(null)
  }, [selectedId])

  const liveAppend = (x: number, y: number) => {
    const pl = liveRef.current, svg = svgRef.current
    if (!pl || !svg) return
    const pt = svg.createSVGPoint(); pt.x = x; pt.y = y
    pl.points.appendItem(pt)
  }

  function createSketch() {
    const sketch: Sketch = {
      id: generateId(),
      masterProjectId: active,
      name: `スケッチ ${sketches.length + 1}`,
      strokes: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    dispatch({ type: 'ADD_SKETCH', payload: sketch })
    setSelectedId(sketch.id)
  }

  const update = useCallback((updates: Partial<Sketch>) => {
    if (!selected) return
    dispatch({ type: 'UPDATE_SKETCH', payload: { ...selected, ...updates, updatedAt: new Date().toISOString() } })
  }, [selected, dispatch])

  function deleteSketch(id: string) {
    dispatch({ type: 'DELETE_SKETCH', payload: id })
    if (selectedId === id) setSelectedId(sketches.find(s => s.id !== id)?.id ?? null)
  }

  const pos = (e: React.PointerEvent): [number, number] => {
    const r = svgRef.current!.getBoundingClientRect()
    // Screen-to-content via viewport: (screen - origin)/zoom + content offset.
    return [
      Math.round((e.clientX - r.left) / viewport.zoom + viewport.x),
      Math.round((e.clientY - r.top) / viewport.zoom + viewport.y),
    ]
  }

  // Two eraser modes:
  //  - 'brush'  : cut where the brush passes, splitting a stroke into surviving parts.
  //  - 'stroke' : remove any whole stroke the brush touches.
  const eraseAt = (x: number, y: number) => {
    const r = Math.max(12, width * 2)
    let next: SketchStroke[]
    if (eraseMode === 'stroke') {
      next = eraseWorkingRef.current.filter(s => !strokeTouched(s.points, x, y, r))
    } else {
      next = []
      for (const s of eraseWorkingRef.current) {
        const runs = splitPointsByBrush(s.points, x, y, r)
        if (runs.length === 1 && runs[0].length === s.points.length) next.push(s)
        else for (const run of runs) next.push({ points: run, color: s.color, width: s.width })
      }
    }
    eraseWorkingRef.current = next
    setLiveErase(next)
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (!selected) return
    // Pan: middle-button OR space+left-button. Skip the regular draw path.
    if (e.button === 1 || (spaceRef.current && e.button === 0)) {
      svgRef.current?.setPointerCapture(e.pointerId)
      panRef.current = { x0: e.clientX, y0: e.clientY, vx: viewport.x, vy: viewport.y }
      return
    }
    if (e.button !== 0) return
    svgRef.current?.setPointerCapture(e.pointerId)
    drawingRef.current = true
    const [x, y] = pos(e)
    if (tool === 'pen') {
      ptsRef.current = [x, y]
      liveRef.current?.points.clear()
      liveAppend(x, y)
    } else {
      eraseWorkingRef.current = selected.strokes
      eraseAt(x, y)
    }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (panRef.current) {
      // Snapshot the pan anchor values here — the setViewport updater is
      // evaluated during the next render, and by then panRef.current may
      // already have been cleared by pointerup, causing a null deref that
      // (in production React) surfaces as an uncaught "Cannot read 'vx' of
      // null" and blanks the whole page.
      const { x0, y0, vx, vy } = panRef.current
      const dx = (e.clientX - x0) / viewport.zoom
      const dy = (e.clientY - y0) / viewport.zoom
      const strokes = selected?.strokes ?? []
      const svg = svgRef.current
      setViewport(v => clampViewport({ ...v, x: vx - dx, y: vy - dy }, strokes, svg))
      return
    }
    if (!drawingRef.current || !selected) return
    const [x, y] = pos(e)
    if (tool === 'pen') {
      ptsRef.current.push(x, y)
      liveAppend(x, y) // direct DOM update — no React re-render per move
    } else {
      eraseAt(x, y)
    }
  }

  const onPointerUp = () => {
    if (panRef.current) { panRef.current = null; return }
    if (!drawingRef.current || !selected) return
    drawingRef.current = false
    if (tool === 'pen') {
      const pts = ptsRef.current
      ptsRef.current = []
      liveRef.current?.points.clear()
      if (pts.length >= 2) {
        // A single tap becomes a dot; longer strokes are resampled to evenly-spaced
        // points so the brush eraser can later cut anywhere, not just at vertices.
        const points = pts.length === 2 ? [pts[0], pts[1], pts[0], pts[1]] : resamplePoints(pts, 4)
        update({ strokes: [...selected.strokes, { points, color, width }] })
      }
    } else {
      const w = eraseWorkingRef.current
      eraseWorkingRef.current = []
      setLiveErase(null)
      const same = w.length === selected.strokes.length && w.every((s, i) => s === selected.strokes[i])
      if (!same) update({ strokes: w })
    }
  }

  // Plain wheel = zoom, centered on the cursor (Ctrl/⌘+wheel works too, but isn't
  // required) — same gesture as the Canvas / Flow views. Attached as a NON-passive
  // native listener so preventDefault stops the page from scrolling (React's onWheel
  // is passive and can't preventDefault reliably).
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const handler = (e: WheelEvent) => {
      e.preventDefault()
      const r = svg.getBoundingClientRect()
      const cx = e.clientX - r.left
      const cy = e.clientY - r.top
      setViewport(v => {
        const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
        const nz = Math.max(0.1, Math.min(8, v.zoom * factor))
        // Keep the content point under the cursor stationary on screen.
        const ax = cx / v.zoom + v.x
        const ay = cy / v.zoom + v.y
        const next = { x: ax - cx / nz, y: ay - cy / nz, zoom: nz }
        return clampViewport(next, selected?.strokes ?? [], svgRef.current)
      })
    }
    svg.addEventListener('wheel', handler, { passive: false })
    return () => svg.removeEventListener('wheel', handler)
  }, [selected?.id])

  function fitToContent() {
    if (!selected || selected.strokes.length === 0) {
      setViewport({ x: 0, y: 0, zoom: 1 }); return
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const s of selected.strokes) {
      for (let i = 0; i < s.points.length; i += 2) {
        const px = s.points[i], py = s.points[i + 1]
        if (px < minX) minX = px; if (px > maxX) maxX = px
        if (py < minY) minY = py; if (py > maxY) maxY = py
      }
    }
    const r = svgRef.current?.getBoundingClientRect()
    if (!r) return
    const pad = 40
    const w = maxX - minX + pad * 2, h = maxY - minY + pad * 2
    const zoom = Math.min(r.width / w, r.height / h, 4)
    setViewport({ x: minX - pad, y: minY - pad, zoom })
  }

  // PNG export — render the strokes (full extent) into a canvas at 2x DPR.
  function exportPng() {
    if (!selected || !svgRef.current) return
    const svgEl = buildExportSvg(selected.strokes)
    const xml = new XMLSerializer().serializeToString(svgEl)
    const url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml' }))
    const img = new Image()
    img.onload = () => {
      try {
        const cw = Number(svgEl.getAttribute('width') || CONTENT_W) * 2
        const ch = Number(svgEl.getAttribute('height') || CONTENT_H) * 2
        const canvas = document.createElement('canvas')
        canvas.width = cw; canvas.height = ch
        const ctx = canvas.getContext('2d')!
        ctx.fillStyle = 'white'
        ctx.fillRect(0, 0, cw, ch)
        ctx.drawImage(img, 0, 0, cw, ch)
        canvas.toBlob(blob => {
          URL.revokeObjectURL(url)
          if (!blob) return
          const dl = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = dl
          a.download = `${(selected.name || 'sketch').replace(/[\\/:*?"<>|]/g, '_')}.png`
          document.body.appendChild(a); a.click(); a.remove()
          setTimeout(() => URL.revokeObjectURL(dl), 1000)
        }, 'image/png')
      } catch (e) {
        URL.revokeObjectURL(url)
        console.error('PNG export failed', e)
      }
    }
    img.onerror = () => {
      // Always release the blob URL — otherwise repeated failed exports leak memory.
      URL.revokeObjectURL(url)
      console.error('PNG export: image load failed')
    }
    img.src = url
  }

  function exportSvg() {
    if (!selected) return
    const svgEl = buildExportSvg(selected.strokes)
    const xml = new XMLSerializer().serializeToString(svgEl)
    const blob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' })
    const dl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = dl
    a.download = `${(selected.name || 'sketch').replace(/[\\/:*?"<>|]/g, '_')}.svg`
    document.body.appendChild(a); a.click(); a.remove()
    setTimeout(() => URL.revokeObjectURL(dl), 1000)
  }

  // Keyboard shortcuts (ignore while typing in a text field):
  //   Ctrl+Z / Ctrl+Shift+Z      undo / redo
  //   P / E                       pen / eraser
  //   1-8                         color
  //   [ / ]                       thinner / thicker
  //   Space (hold)                pan mode
  //   Ctrl+0                      reset zoom
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo(); else undo()
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault(); redo(); return
      }
      if ((e.ctrlKey || e.metaKey) && e.key === '0') {
        e.preventDefault(); setViewport({ x: 0, y: 0, zoom: 1 }); return
      }
      if (e.code === 'Space') {
        // preventDefault so Space doesn't also click whichever toolbar button
        // has focus (buttons don't match the INPUT/TEXTAREA early-return above).
        e.preventDefault()
        spaceRef.current = true
        return
      }
      if (e.key === 'p' || e.key === 'P') { setTool('pen'); return }
      if (e.key === 'e' || e.key === 'E') { setTool('eraser'); return }
      if (/^[1-8]$/.test(e.key)) {
        const idx = Number(e.key) - 1
        if (COLORS[idx]) { setColor(COLORS[idx]); setTool('pen') }
        return
      }
      if (e.key === '[') { setWidth(w => WIDTHS[Math.max(0, WIDTHS.indexOf(w) - 1)] ?? WIDTHS[0]); return }
      if (e.key === ']') { setWidth(w => WIDTHS[Math.min(WIDTHS.length - 1, WIDTHS.indexOf(w) + 1)] ?? WIDTHS[WIDTHS.length - 1]); return }
    }
    const onKeyUp = (e: KeyboardEvent) => { if (e.code === 'Space') spaceRef.current = false }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onKeyUp) }
  }, [undo, redo])

  const renderStrokes = liveErase ?? (selected ? selected.strokes : [])

  // iPad: prevent page scroll / pull-to-refresh while the finger is on the canvas,
  // which otherwise interrupts the pen stroke and cuts the line.
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const stop = (e: TouchEvent) => e.preventDefault()
    // touchmove must be a NON-PASSIVE listener for preventDefault() to take effect.
    svg.addEventListener('touchstart', stop, { passive: false })
    svg.addEventListener('touchmove', stop, { passive: false })
    svg.addEventListener('touchend', stop, { passive: false })
    return () => {
      svg.removeEventListener('touchstart', stop)
      svg.removeEventListener('touchmove', stop)
      svg.removeEventListener('touchend', stop)
    }
  }, [selected?.id])

  return (
    <div className="flex h-full">
      {/* Sketch list */}
      <div className="w-60 border-r border-slate-200 flex flex-col">
        <div className="h-14 flex items-center justify-between px-4 border-b border-slate-200">
          <h2 className="text-sm font-semibold text-slate-700">スケッチ</h2>
          <button onClick={createSketch} className="p-1.5 rounded-md hover:bg-slate-100 text-slate-500 hover:text-fuchsia-600 transition-colors">
            <Plus size={18} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto py-2 px-2 space-y-1">
          {sketches.map(s => (
            <button
              key={s.id}
              onClick={() => setSelectedId(s.id)}
              className={`w-full text-left px-3 py-2.5 rounded-lg text-sm transition-all flex items-center justify-between group ${
                selectedId === s.id ? 'bg-slate-100 text-slate-900 border border-slate-300' : 'text-slate-500 hover:text-slate-800 hover:bg-slate-100 border border-transparent'
              }`}
            >
              <span className="truncate">{s.name}</span>
              <span className="text-[10px] text-slate-400 shrink-0 ml-2">{s.strokes.length}本</span>
            </button>
          ))}
          {sketches.length === 0 && (
            <p className="text-xs text-slate-400 px-3 py-4 text-center">「＋」で新しいスケッチを作成</p>
          )}
        </div>
      </div>

      {/* Sketch surface */}
      <div className="flex-1 flex flex-col min-w-0">
        {selected ? (
          <>
            <div className="min-h-[3.5rem] flex flex-wrap items-center gap-2 px-4 py-2 border-b border-slate-200 shrink-0">
              <input
                type="text"
                value={selected.name}
                onChange={e => update({ name: e.target.value })}
                className="text-base font-semibold bg-transparent border-none outline-none text-slate-900 flex-1 min-w-[110px] max-w-[200px]"
                placeholder="スケッチ名"
              />
              <div className="flex items-center rounded-md border border-slate-200 overflow-hidden">
                <button onClick={() => setTool('pen')} title="ペン" className={`p-1.5 ${tool === 'pen' ? 'bg-fuchsia-500/15 text-fuchsia-600' : 'text-slate-500 hover:bg-slate-100'}`}><Pencil size={16} /></button>
                <button onClick={() => setTool('eraser')} title="消しゴム" className={`p-1.5 ${tool === 'eraser' ? 'bg-fuchsia-500/15 text-fuchsia-600' : 'text-slate-500 hover:bg-slate-100'}`}><Eraser size={16} /></button>
              </div>
              {tool === 'eraser' && (
                <div className="flex items-center rounded-md border border-slate-200 overflow-hidden text-xs">
                  <button onClick={() => setEraseMode('brush')} title="なぞった部分だけ消す" className={`px-2 py-1.5 ${eraseMode === 'brush' ? 'bg-fuchsia-500/15 text-fuchsia-600' : 'text-slate-500 hover:bg-slate-100'}`}>部分</button>
                  <button onClick={() => setEraseMode('stroke')} title="触れた線を丸ごと消す" className={`px-2 py-1.5 ${eraseMode === 'stroke' ? 'bg-fuchsia-500/15 text-fuchsia-600' : 'text-slate-500 hover:bg-slate-100'}`}>ストローク</button>
                </div>
              )}
              <div className="flex items-center gap-1">
                {COLORS.map(c => (
                  <button key={c} onClick={() => { setColor(c); setTool('pen') }} title="色"
                    className={`w-5 h-5 rounded-full border transition-transform hover:scale-110 ${color === c && tool === 'pen' ? 'ring-2 ring-fuchsia-400 ring-offset-1' : 'border-slate-300'}`}
                    style={{ backgroundColor: c }} />
                ))}
              </div>
              <div className="flex items-center gap-1 ml-1">
                {WIDTHS.map(w => (
                  <button key={w} onClick={() => setWidth(w)} title="太さ"
                    className={`w-7 h-7 rounded flex items-center justify-center hover:bg-slate-100 ${width === w ? 'bg-slate-200' : ''}`}>
                    <span className="rounded-full bg-slate-700" style={{ width: w, height: w }} />
                  </button>
                ))}
              </div>
              <div className="ml-auto flex items-center gap-1">
                <button onClick={() => setViewport(v => ({ ...v, zoom: Math.max(0.1, v.zoom / 1.25) }))} title="縮小" className="p-1.5 rounded hover:bg-slate-100 text-slate-600"><ZoomOut size={16} /></button>
                <span className="text-[10px] text-slate-500 w-10 text-center">{Math.round(viewport.zoom * 100)}%</span>
                <button onClick={() => setViewport(v => ({ ...v, zoom: Math.min(8, v.zoom * 1.25) }))} title="拡大" className="p-1.5 rounded hover:bg-slate-100 text-slate-600"><ZoomIn size={16} /></button>
                <button onClick={fitToContent} title="全体表示" className="p-1.5 rounded hover:bg-slate-100 text-slate-600"><Maximize size={16} /></button>
                <div className="w-px h-5 bg-slate-200 mx-1" />
                <button onClick={exportPng} title="PNGで書き出し" className="p-1.5 rounded hover:bg-slate-100 text-slate-600"><ImageDown size={16} /></button>
                <button onClick={exportSvg} title="SVGで書き出し" className="p-1.5 rounded hover:bg-slate-100 text-slate-600"><FileDown size={16} /></button>
                <div className="w-px h-5 bg-slate-200 mx-1" />
                <button onClick={undo} disabled={!canUndo} title="元に戻す (Ctrl+Z)" className="p-1.5 rounded hover:bg-slate-100 text-slate-600 disabled:opacity-30"><Undo2 size={16} /></button>
                <button onClick={redo} disabled={!canRedo} title="やり直す (Ctrl+Shift+Z)" className="p-1.5 rounded hover:bg-slate-100 text-slate-600 disabled:opacity-30"><Redo2 size={16} /></button>
                <button onClick={() => { if (selected.strokes.length) update({ strokes: [] }) }} title="全消去" className="p-1.5 rounded hover:bg-slate-100 text-slate-500 hover:text-rose-500"><ClearIcon size={16} /></button>
                <button onClick={() => deleteSketch(selected.id)} title="このスケッチを削除" className="p-1.5 rounded hover:bg-slate-100 text-slate-500 hover:text-rose-500"><Trash2 size={16} /></button>
              </div>
            </div>
            <div className="flex-1 min-h-0 bg-slate-50 p-4">
              <svg
                ref={svgRef}
                className="w-full h-full bg-white rounded-lg border border-slate-200 touch-none overscroll-contain select-none"
                style={{
                  cursor: panRef.current ? 'grabbing' : (spaceRef.current ? 'grab' : (tool === 'eraser' ? 'cell' : 'crosshair')),
                  WebkitUserSelect: 'none',
                  WebkitTouchCallout: 'none',
                }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
              >
                <g transform={`translate(${-viewport.x * viewport.zoom},${-viewport.y * viewport.zoom}) scale(${viewport.zoom})`}>
                  {renderStrokes.map((s, i) => (
                    <polyline
                      key={i}
                      points={ptsToStr(s.points)}
                      fill="none"
                      stroke={s.color}
                      strokeWidth={s.width}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  ))}
                  {/* In-progress pen stroke — points mutated directly in the handlers. */}
                  <polyline ref={liveRef} fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" />
                </g>
              </svg>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-slate-400">
            <p>スケッチを選択するか、新しく作成してください</p>
          </div>
        )}
      </div>
    </div>
  )
}

function ptsToStr(p: number[]): string {
  let s = ''
  for (let i = 0; i < p.length; i += 2) s += `${p[i]},${p[i + 1]} `
  return s.trim()
}

// Clamp viewport so at least a margin of the content bbox stays inside the visible SVG.
// Without this, panning past the strokes pushes everything off-screen and the canvas
// looks blank — even though just hitting "全体表示" recovers it.
function clampViewport(
  v: { x: number; y: number; zoom: number },
  strokes: SketchStroke[],
  svgEl: SVGSVGElement | null,
): { x: number; y: number; zoom: number } {
  if (!svgEl || strokes.length === 0) return v
  const r = svgEl.getBoundingClientRect()
  if (r.width <= 0 || r.height <= 0) return v
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const s of strokes) {
    for (let i = 0; i < s.points.length; i += 2) {
      const px = s.points[i], py = s.points[i + 1]
      if (px < minX) minX = px; if (px > maxX) maxX = px
      if (py < minY) minY = py; if (py > maxY) maxY = py
    }
  }
  if (!isFinite(minX)) return v
  const visW = r.width / v.zoom
  const visH = r.height / v.zoom
  // Keep at least 80px of overlap between the visible viewport rect and the
  // content bbox so the user can always see something.
  const margin = 80 / v.zoom
  const xMin = minX - visW + margin
  const xMax = maxX - margin
  const yMin = minY - visH + margin
  const yMax = maxY - margin
  const nx = xMin > xMax ? (minX + maxX - visW) / 2 : Math.max(xMin, Math.min(xMax, v.x))
  const ny = yMin > yMax ? (minY + maxY - visH) / 2 : Math.max(yMin, Math.min(yMax, v.y))
  return { ...v, x: nx, y: ny }
}

// Build a standalone SVG that contains just the strokes, sized to fit them with padding.
// Used for both PNG and SVG export.
function buildExportSvg(strokes: SketchStroke[]): SVGSVGElement {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const s of strokes) {
    for (let i = 0; i < s.points.length; i += 2) {
      const px = s.points[i], py = s.points[i + 1]
      if (px < minX) minX = px; if (px > maxX) maxX = px
      if (py < minY) minY = py; if (py > maxY) maxY = py
    }
  }
  if (!isFinite(minX)) { minX = 0; minY = 0; maxX = CONTENT_W; maxY = CONTENT_H }
  const pad = 24
  const x = minX - pad, y = minY - pad, w = (maxX - minX) + pad * 2, h = (maxY - minY) + pad * 2
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('xmlns', ns)
  svg.setAttribute('viewBox', `${x} ${y} ${w} ${h}`)
  svg.setAttribute('width', String(Math.round(w)))
  svg.setAttribute('height', String(Math.round(h)))
  const bg = document.createElementNS(ns, 'rect')
  bg.setAttribute('x', String(x)); bg.setAttribute('y', String(y))
  bg.setAttribute('width', String(w)); bg.setAttribute('height', String(h))
  bg.setAttribute('fill', 'white')
  svg.appendChild(bg)
  for (const s of strokes) {
    const p = document.createElementNS(ns, 'polyline')
    p.setAttribute('points', ptsToStr(s.points))
    p.setAttribute('fill', 'none')
    p.setAttribute('stroke', s.color)
    p.setAttribute('stroke-width', String(s.width))
    p.setAttribute('stroke-linecap', 'round')
    p.setAttribute('stroke-linejoin', 'round')
    svg.appendChild(p)
  }
  return svg
}

// Resample a polyline into evenly-spaced points so the brush eraser can cut
// anywhere, not only at the (possibly sparse) vertices captured while drawing.
function resamplePoints(pts: number[], step: number): number[] {
  if (pts.length < 4) return pts.slice()
  const out = [pts[0], pts[1]]
  let px = pts[0], py = pts[1]
  let acc = 0
  for (let i = 2; i < pts.length; i += 2) {
    const tx = pts[i], ty = pts[i + 1]
    let dx = tx - px, dy = ty - py
    let dist = Math.hypot(dx, dy)
    if (dist === 0) continue
    while (acc + dist >= step) {
      const t = (step - acc) / dist
      px = px + dx * t; py = py + dy * t
      out.push(px, py)
      dx = tx - px; dy = ty - py
      dist = Math.hypot(dx, dy)
      acc = 0
    }
    acc += dist
    px = tx; py = ty
  }
  const ex = pts[pts.length - 2], ey = pts[pts.length - 1]
  if (Math.hypot(ex - out[out.length - 2], ey - out[out.length - 1]) > step * 0.25) out.push(ex, ey)
  return out
}

// Whether the eraser brush at (ex,ey) touches any vertex of a stroke (stroke-mode).
function strokeTouched(pts: number[], ex: number, ey: number, r: number): boolean {
  for (let i = 0; i < pts.length; i += 2) {
    if (Math.hypot(pts[i] - ex, pts[i + 1] - ey) <= r) return true
  }
  return false
}

// Split a stroke's points into runs, dropping the vertices within the eraser brush.
function splitPointsByBrush(pts: number[], ex: number, ey: number, r: number): number[][] {
  const runs: number[][] = []
  let cur: number[] = []
  for (let i = 0; i < pts.length; i += 2) {
    if (Math.hypot(pts[i] - ex, pts[i + 1] - ey) <= r) {
      if (cur.length >= 4) runs.push(cur)
      cur = []
    } else {
      cur.push(pts[i], pts[i + 1])
    }
  }
  if (cur.length >= 4) runs.push(cur)
  return runs
}
