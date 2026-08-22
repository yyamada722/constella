// Code-editor style minimap for a note: one bar per source line (headings bolder,
// width ∝ line length), a translucent viewport box that tracks the attached
// scroller, and click / drag on the map to scroll. The scroller is looked up
// lazily (it is the editor textarea or the preview div, mounted by a sibling),
// so the component only needs a getter and a key that changes when it swaps.
import { useEffect, useRef, useState } from 'react'

const MAP_W = 88
const MAX_LINE_H = 3 // px per source line at most (shrinks so the whole note fits)

type Kind = 'h' | 'text' | 'list' | 'quote' | 'code' | 'blank'

function classify(lines: string[]): { kind: Kind; len: number }[] {
  let fence = false
  return lines.map(raw => {
    const l = raw.trimEnd()
    if (/^\s*(```|~~~)/.test(l)) { fence = !fence; return { kind: 'code', len: l.length } }
    if (fence) return { kind: 'code', len: l.length }
    if (!l.trim()) return { kind: 'blank', len: 0 }
    if (/^#{1,6}\s/.test(l)) return { kind: 'h', len: l.length }
    if (/^\s*>/.test(l)) return { kind: 'quote', len: l.length }
    if (/^\s*([-*+]|\d+\.)\s/.test(l)) return { kind: 'list', len: l.length }
    return { kind: 'text', len: l.length }
  })
}

export function NoteMinimap({ content, scrollerKey, getScroller }: {
  content: string
  /** Changes whenever the scroll target is (re)mounted (note id + view mode). */
  scrollerKey: string
  getScroller: () => HTMLElement | null
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const scrollerRef = useRef<HTMLElement | null>(null)
  const [mapH, setMapH] = useState(0)
  // Viewport box in map pixels.
  const [view, setView] = useState({ top: 0, h: 0 })
  const dragRef = useRef(false)
  const getScrollerRef = useRef(getScroller)
  getScrollerRef.current = getScroller
  const updateRef = useRef<() => void>(() => {})

  const lines = content.split('\n')
  const lineH = Math.min(MAX_LINE_H, mapH > 0 ? mapH / Math.max(1, lines.length) : MAX_LINE_H)
  const docH = lines.length * lineH

  // Measure own height.
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setMapH(el.clientHeight))
    ro.observe(el)
    setMapH(el.clientHeight)
    return () => ro.disconnect()
  }, [])

  // Attach to the scroller (retry briefly: it mounts in a sibling's effect).
  useEffect(() => {
    let el: HTMLElement | null = null
    let ro: ResizeObserver | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    let dead = false
    const update = () => {
      if (!el) return
      const sh = Math.max(1, el.scrollHeight)
      setView({ top: (el.scrollTop / sh) * docH, h: (el.clientHeight / sh) * docH })
    }
    const attach = (attempt: number) => {
      if (dead) return
      el = getScrollerRef.current()
      if (!el) { if (attempt < 10) timer = setTimeout(() => attach(attempt + 1), 50); return }
      scrollerRef.current = el
      updateRef.current = update
      el.addEventListener('scroll', update, { passive: true })
      ro = new ResizeObserver(update)
      ro.observe(el)
      update()
    }
    attach(0)
    return () => {
      dead = true
      if (timer) clearTimeout(timer)
      el?.removeEventListener('scroll', update)
      ro?.disconnect()
      if (scrollerRef.current === el) scrollerRef.current = null
    }
    // docH: the viewport box is expressed in map px, so re-derive when the map scale changes.
  }, [scrollerKey, docH])

  // Typing changes scrollHeight without a scroll/resize event — refresh the box.
  useEffect(() => { updateRef.current() }, [content])

  // Paint the bars.
  useEffect(() => {
    const cv = canvasRef.current
    if (!cv || mapH <= 0) return
    const dpr = window.devicePixelRatio || 1
    cv.width = Math.floor(MAP_W * dpr)
    cv.height = Math.floor(mapH * dpr)
    const ctx = cv.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, MAP_W, mapH)
    const ink = getComputedStyle(cv).color || '#64748b'
    const rows = classify(lines)
    const usable = MAP_W - 10
    const barH = Math.max(1, lineH - (lineH >= 2 ? 1 : 0))
    rows.forEach((r, i) => {
      if (r.kind === 'blank') return
      const y = i * lineH
      let w = Math.min(1, r.len / 70) * usable
      let alpha = 0.35
      let x = 5
      switch (r.kind) {
        case 'h': alpha = 0.95; w = Math.max(w, usable * 0.55); break
        case 'list': x = 11; alpha = 0.4; break
        case 'quote': x = 9; alpha = 0.3; break
        case 'code': alpha = 0.22; break
      }
      ctx.globalAlpha = alpha
      ctx.fillStyle = ink
      ctx.fillRect(x, y, Math.max(2, w), barH)
    })
    ctx.globalAlpha = 1
  }, [content, mapH, lineH]) // eslint-disable-line react-hooks/exhaustive-deps

  const scrollToMapY = (y: number) => {
    const el = scrollerRef.current
    if (!el || docH <= 0) return
    const ratio = Math.min(1, Math.max(0, y / docH))
    el.scrollTop = ratio * el.scrollHeight - el.clientHeight / 2
  }

  return (
    <div
      ref={wrapRef}
      className="relative shrink-0 h-full border-l border-slate-200 bg-slate-50/60 cursor-pointer select-none text-slate-500"
      style={{ width: MAP_W }}
      title="ミニマップ — クリック/ドラッグでスクロール"
      onPointerDown={e => {
        if (e.button !== 0) return
        dragRef.current = true
        e.currentTarget.setPointerCapture(e.pointerId)
        scrollToMapY(e.clientY - e.currentTarget.getBoundingClientRect().top)
      }}
      onPointerMove={e => {
        if (!dragRef.current) return
        scrollToMapY(e.clientY - e.currentTarget.getBoundingClientRect().top)
      }}
      onPointerUp={() => { dragRef.current = false }}
      onPointerCancel={() => { dragRef.current = false }}
    >
      <canvas ref={canvasRef} className="block" style={{ width: MAP_W, height: mapH }} />
      {view.h > 0 && view.h < docH - 0.5 && (
        <div
          className="absolute left-0 right-0 bg-amber-400/20 border-y border-amber-400/50 pointer-events-none"
          style={{ top: view.top, height: Math.max(6, view.h) }}
        />
      )}
    </div>
  )
}
