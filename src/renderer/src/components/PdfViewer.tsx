import { useState, useRef, useEffect, useLayoutEffect, memo } from 'react'
import { createPortal } from 'react-dom'
import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { ChevronLeft, ChevronRight, List, Maximize, Maximize2, BookOpen, ListTree, X, ZoomIn, ZoomOut } from 'lucide-react'
import type { PDFDocumentProxy } from 'pdfjs-dist'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

// Bundled (offline) resources for base-14 fonts and CJK (Japanese etc.) CMaps
const PDF_BASE = import.meta.env.BASE_URL || '/'
const CMAP_URL = `${PDF_BASE}cmaps/`
const STANDARD_FONT_URL = `${PDF_BASE}standard_fonts/`

type PdfMode = 'scroll' | 'single' | 'spread'

// タッチ主体の端末ではツールバーの各ボタンを一回り大きくする（タップしやすさ優先）。
const IS_TOUCH = typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches

type OutlineItem = { title: string; depth: number; pageNum: number | null }

/* ── Single page rendered to canvas ── */

// Upper bound on rendered canvas pixels — a zoomed-in page would otherwise ask
// for a 10k×14k bitmap (slow to paint, may exceed the GPU texture limit).
const MAX_RENDER_PIXELS = 24_000_000

const PdfPage = memo(function PdfPage({ doc, pageNum, maxW, maxH, zoom = 1 }: {
  doc: PDFDocumentProxy
  pageNum: number
  maxW: number
  maxH?: number
  /** Multiplier on top of the fit-to-box scale (1 = fit). */
  zoom?: number
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // Identity of the bitmap currently on the canvas — when only the zoom changes
  // we can keep it and stretch it via CSS (instant), then re-render behind a
  // short debounce so wheel-zooming stays fluid instead of re-painting per tick.
  const bitmapRef = useRef<{ doc: PDFDocumentProxy; pageNum: number } | null>(null)

  useEffect(() => {
    if (!doc || maxW <= 0 || pageNum < 1 || pageNum > doc.numPages) return
    let cancelled = false
    let renderTask: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | null = null
    let timer: ReturnType<typeof setTimeout> | null = null

    doc.getPage(pageNum).then(pg => {
      if (cancelled) return
      const base = pg.getViewport({ scale: 1 })
      let fit = maxW / base.width
      if (maxH && maxH > 0) fit = Math.min(fit, maxH / base.height)
      const scale = fit * zoom
      const displayVp = pg.getViewport({ scale })
      const canvas = canvasRef.current
      if (!canvas) return
      const cssW = Math.floor(displayVp.width)
      const cssH = Math.floor(displayVp.height)
      canvas.style.width = `${cssW}px`
      canvas.style.height = `${cssH}px`

      const paint = () => {
        if (cancelled) return
        // Supersample: render at 2–3× the display resolution for crisp text,
        // then let the browser downscale via the CSS size above.
        const dpr = window.devicePixelRatio || 1
        // The pixel cap wins over DPR: a huge zoom renders slightly soft rather
        // than allocating a bitmap the GPU may refuse.
        const preferredRatio = Math.min(Math.max(dpr, 1) * 2.5, 3.5)
        const maxRatio = Math.sqrt(MAX_RENDER_PIXELS / Math.max(1, cssW * cssH))
        const renderRatio = Math.min(preferredRatio, maxRatio)
        const renderVp = pg.getViewport({ scale: scale * renderRatio })
        // Render off-screen and blit on completion, so a render cancelled by the
        // next zoom tick never leaves the visible canvas blank / half-painted.
        const off = document.createElement('canvas')
        off.width = Math.floor(renderVp.width)
        off.height = Math.floor(renderVp.height)
        const offCtx = off.getContext('2d')
        if (!offCtx) return
        renderTask = pg.render({ canvasContext: offCtx, viewport: renderVp })
        renderTask.promise
          .then(() => {
            if (cancelled) return
            canvas.width = off.width
            canvas.height = off.height
            canvas.getContext('2d')?.drawImage(off, 0, 0)
            bitmapRef.current = { doc, pageNum }
          })
          .catch(() => { /* cancelled */ })
      }

      const b = bitmapRef.current
      const reusable = b && b.doc === doc && b.pageNum === pageNum && canvas.width > 0
      if (reusable) timer = setTimeout(paint, 140)
      else {
        // Different page: blank the canvas (white box) rather than stretching
        // the previous page's bitmap while the new one renders.
        canvas.width = 0
        canvas.height = 0
        bitmapRef.current = null
        paint()
      }
    }).catch(() => { /* page load failed */ })

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      try { renderTask?.cancel() } catch { /* noop */ }
    }
  }, [doc, pageNum, maxW, maxH, zoom])

  return <canvas ref={canvasRef} className="bg-white shadow-md rounded-sm block shrink-0" />
})

/* ── Lazily-rendered page for scroll mode (only renders when near viewport) ── */

const LazyScrollPage = memo(function LazyScrollPage({ doc, pageNum, width, aspect, scrollRef }: {
  doc: PDFDocumentProxy
  pageNum: number
  width: number
  aspect: number
  scrollRef: React.RefObject<HTMLDivElement>
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(
      entries => setVisible(entries[0].isIntersecting),
      { root: scrollRef.current, rootMargin: '800px 0px' }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [scrollRef])

  const height = aspect > 0 ? width / aspect : width * 1.414
  return (
    <div
      ref={ref}
      style={{ width, height }}
      className="bg-white shadow-md rounded-sm shrink-0 flex items-center justify-center overflow-hidden"
    >
      {visible
        ? <PdfPage doc={doc} pageNum={pageNum} maxW={width} />
        : <span className="text-slate-700 text-xs">{pageNum}</span>}
    </div>
  )
})

/* ── PDF viewer with 3 modes ── */

const ZOOM_MIN = 0.5
const ZOOM_MAX = 8
const ZOOM_STEP = 1.25

export const PdfViewer = memo(function PdfViewer({ url, fixedHeight, initial, onStateChange, noFullscreen, zoomable, autoFocus, initialZoom, onZoomChange }: {
  url: string
  fixedHeight?: number
  initial?: { page?: number; mode?: PdfMode }
  onStateChange?: (s: { page: number; mode: PdfMode }) => void
  /** Internal: set on the instance INSIDE the fullscreen overlay (no nested expand). */
  noFullscreen?: boolean
  /** Ctrl+wheel / pinch and ±ボタン zoom. Off by default so a viewer embedded in
   *  the canvas keeps Ctrl+wheel for the canvas itself. */
  zoomable?: boolean
  /** Focus the render area once the document is in, so PageUp/Down・Home/End
   *  work without a click (lightbox use). */
  autoFocus?: boolean
  /** Internal: fullscreen ↔ inline zoom hand-off (not persisted). */
  initialZoom?: number
  onZoomChange?: (z: number) => void
}) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [numPages, setNumPages] = useState(0)
  const [page, setPage] = useState(initial?.page && initial.page > 0 ? initial.page : 1)
  const [pageInput, setPageInput] = useState('1')
  const [mode, setMode] = useState<PdfMode>(initial?.mode ?? 'single')
  // Page to restore once the document loads (from persisted view state); only the
  // first load honours it — a later document swap starts at page 1.
  const restorePageRef = useRef(initial?.page && initial.page > 0 ? initial.page : 1)
  const [box, setBox] = useState({ w: 0, h: 0 })
  const [aspect, setAspect] = useState(0)
  const [outline, setOutline] = useState<OutlineItem[]>([])
  const [showOutline, setShowOutline] = useState(false)
  // 1 = fit to the render area (height-bound for portrait pages, width-bound for
  // landscape). >1 overflows and the area becomes scrollable.
  const [zoom, setZoom] = useState(initialZoom && initialZoom > 0 ? initialZoom : 1)
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  const onZoomChangeRef = useRef(onZoomChange)
  onZoomChangeRef.current = onZoomChange
  useEffect(() => { onZoomChangeRef.current?.(zoom) }, [zoom])
  // Cursor position (relative to the area) to keep fixed while the zoom applies.
  const zoomAnchorRef = useRef<{ x: number; y: number; prev: number } | null>(null)
  // 全画面表示 — the toolbar expand button portals a screen-filling copy of this
  // viewer (own doc instance); page/mode changes there sync back on the fly so
  // closing it keeps the reading position.
  const [fullscreen, setFullscreen] = useState(false)
  const areaRef = useRef<HTMLDivElement>(null)
  const outlineRef = useRef<HTMLDivElement>(null)
  const fsRef = useRef<HTMLDivElement>(null)
  const fsOpenerRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!fullscreen) return
    const overlay = fsRef.current
    // The overlay covers the page but lives in a portal at the end of <body>, so
    // without this Tab walks straight onto the controls behind it and keyboard
    // users can drive a UI they cannot see.
    const focusables = (): HTMLElement[] =>
      Array.from(overlay?.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])') ?? [])
        .filter(el => !el.hasAttribute('disabled'))
    focusables()[0]?.focus()

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.stopPropagation(); setFullscreen(false); return }
      if (e.key !== 'Tab') return
      const items = focusables()
      if (items.length === 0) return
      const i = items.indexOf(document.activeElement as HTMLElement)
      const next = e.shiftKey
        ? items[(i <= 0 ? items.length : i) - 1]
        : items[i === items.length - 1 ? 0 : i + 1]
      e.stopPropagation(); e.preventDefault()
      next?.focus()
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      // Hand focus back to the expand button so the tab order resumes where it was.
      fsOpenerRef.current?.focus()
      fsOpenerRef.current = null
    }
  }, [fullscreen])

  // Load the document whenever the URL changes
  useEffect(() => {
    if (!url) { setDoc(null); setNumPages(0); return }
    let cancelled = false
    const task = pdfjsLib.getDocument({
      url,
      cMapUrl: CMAP_URL,
      cMapPacked: true,
      standardFontDataUrl: STANDARD_FONT_URL,
    })
    task.promise.then(pdf => {
      if (cancelled) { pdf.destroy(); return }
      setDoc(pdf)
      setNumPages(pdf.numPages)
      setPage(Math.min(Math.max(1, restorePageRef.current), pdf.numPages))
      restorePageRef.current = 1 // subsequent document swaps start at page 1
    }).catch(() => { /* invalid pdf */ })
    return () => {
      cancelled = true
      task.destroy().catch(() => { /* noop */ })
    }
  }, [url])

  // Page aspect ratio (from page 1) to reserve scroll-mode layout space
  useEffect(() => {
    if (!doc) { setAspect(0); return }
    let cancelled = false
    doc.getPage(1).then(pg => {
      if (cancelled) return
      const vp = pg.getViewport({ scale: 1 })
      setAspect(vp.width / vp.height)
    }).catch(() => { /* noop */ })
    return () => { cancelled = true }
  }, [doc])

  // Extract the embedded outline (bookmarks / しおり) and resolve page numbers
  useEffect(() => {
    if (!doc) { setOutline([]); setShowOutline(false); return }
    let cancelled = false
    ;(async () => {
      try {
        const raw = await doc.getOutline()
        if (cancelled || !raw || raw.length === 0) { setOutline([]); return }
        const flat: OutlineItem[] = []
        const walk = async (items: typeof raw, depth: number) => {
          for (const it of items) {
            let pageNum: number | null = null
            try {
              let dest = it.dest
              if (typeof dest === 'string') dest = await doc.getDestination(dest)
              if (Array.isArray(dest) && dest[0]) pageNum = (await doc.getPageIndex(dest[0]) as number) + 1
            } catch { /* unresolved destination */ }
            flat.push({ title: it.title, depth, pageNum })
            if (it.items && it.items.length) await walk(it.items, depth + 1)
          }
        }
        await walk(raw, 0)
        if (!cancelled) setOutline(flat)
      } catch { if (!cancelled) setOutline([]) }
    })()
    return () => { cancelled = true }
  }, [doc])

  // Keep wheel scrolling inside the outline panel (don't zoom the canvas)
  useEffect(() => {
    const el = outlineRef.current
    if (!el || !showOutline) return
    const stop = (e: WheelEvent) => e.stopPropagation()
    el.addEventListener('wheel', stop)
    return () => el.removeEventListener('wheel', stop)
  }, [showOutline])

  // Measure the render area. Sub-pixel churn is ignored: the rendered canvas can
  // nudge the measured rect by <1px, and echoing that back into the canvas size
  // would oscillate the preview (shrink → re-measure → shrink …).
  useEffect(() => {
    const el = areaRef.current
    if (!el) return
    const apply = (w: number, h: number) => {
      setBox(prev => (Math.abs(prev.w - w) < 1 && Math.abs(prev.h - h) < 1 ? prev : { w, h }))
    }
    const ro = new ResizeObserver(entries => {
      const r = entries[0].contentRect
      apply(r.width, r.height)
    })
    ro.observe(el)
    apply(el.clientWidth, el.clientHeight)
    return () => ro.disconnect()
  }, [doc])

  // Wheel policy inside the render area:
  //  - zoomable + Ctrl/⌘ (pinch arrives as a ctrlKey wheel in Chromium): zoom
  //    around the cursor, never let it reach the page.
  //  - scroll mode, or a zoomed-in page: the area scrolls natively — stop the
  //    event so an enclosing canvas doesn't pan/zoom underneath.
  useEffect(() => {
    const el = areaRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (zoomable && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        e.stopPropagation()
        const r = el.getBoundingClientRect()
        const prev = zoomRef.current
        const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, prev * Math.exp(-e.deltaY * 0.0015)))
        if (next === prev) return
        zoomAnchorRef.current = { x: e.clientX - r.left, y: e.clientY - r.top, prev }
        setZoom(next)
        return
      }
      if (mode === 'scroll' || zoomRef.current > 1) e.stopPropagation()
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [mode, zoomable, doc])

  // Once the zoomed layout is committed, shift the scroll so the point under the
  // cursor stays put (content scales proportionally around the origin).
  useLayoutEffect(() => {
    const a = zoomAnchorRef.current
    const el = areaRef.current
    if (!a || !el) return
    zoomAnchorRef.current = null
    const r = zoom / a.prev
    el.scrollLeft = (el.scrollLeft + a.x) * r - a.x
    el.scrollTop = (el.scrollTop + a.y) * r - a.y
  }, [zoom])

  // A new document or display mode starts back at "fit" — except the very first
  // load, which may carry a zoom handed over from the inline/fullscreen twin.
  const zoomResetArmedRef = useRef(false)
  useEffect(() => {
    if (!zoomResetArmedRef.current) { zoomResetArmedRef.current = !!doc; return }
    setZoom(1)
  }, [doc, mode])

  // Lightbox: take keyboard focus so paging keys work immediately.
  useEffect(() => {
    if (autoFocus && doc) areaRef.current?.focus({ preventScroll: true })
  }, [autoFocus, doc])

  const onAreaKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!doc || numPages === 0) return
    if ((e.target as HTMLElement).tagName === 'INPUT') return
    const paged = mode !== 'scroll'
    const st = mode === 'spread' ? 2 : 1
    let handled = true
    switch (e.key) {
      case 'PageDown': if (paged) go(page + st); else handled = false; break
      case 'PageUp': if (paged) go(page - st); else handled = false; break
      case 'Home':
        if (paged) go(1)
        else if (areaRef.current) areaRef.current.scrollTop = 0
        break
      case 'End':
        if (paged) go(numPages)
        else if (areaRef.current) areaRef.current.scrollTop = areaRef.current.scrollHeight
        break
      default: handled = false
    }
    if (handled) { e.preventDefault(); e.stopPropagation() }
  }

  const zoomTo = (z: number) => {
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z))
    const el = areaRef.current
    if (el) zoomAnchorRef.current = { x: el.clientWidth / 2, y: el.clientHeight / 2, prev: zoomRef.current }
    setZoom(next)
  }

  const step = mode === 'spread' ? 2 : 1
  const go = (p: number) => {
    const n = Math.max(1, Math.min(numPages, p))
    setPage(n)
    onStateChange?.({ page: n, mode }) // persist (view-only; not an undo step)
  }

  // Keep the page-number input in sync with the current page
  useEffect(() => { setPageInput(String(page)) }, [page])

  const commitPageInput = () => {
    const n = parseInt(pageInput, 10)
    if (!isNaN(n) && n >= 1 && n <= numPages) go(n)
    else setPageInput(String(page))
  }

  const modes: { key: PdfMode; icon: typeof List; label: string }[] = [
    { key: 'scroll', icon: List, label: 'スクロール' },
    { key: 'single', icon: Maximize, label: '1ページ' },
    { key: 'spread', icon: BookOpen, label: '見開き' },
  ]

  const pad = 16
  const availW = box.w - pad
  const availH = box.h - pad
  const zoomed = zoom > 1.001
  // Page box: fills the area (so the page sits centred) and grows with the page
  // once it overflows, giving the scroll container real extents in both axes.
  const zoomedBoxStyle = { minWidth: '100%', minHeight: '100%', width: 'max-content', padding: pad / 2 } as const

  // Jump to a page from the outline (scrolls the container in scroll mode)
  const jumpTo = (p: number) => {
    go(p)
    if (mode === 'scroll' && areaRef.current && aspect > 0) {
      const pageH = (availW * zoom) / aspect
      areaRef.current.scrollTop = (p - 1) * (pageH + 12) + 8
    }
    setShowOutline(false)
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* fixedHeight: `flex: 0 0 auto` is REQUIRED — with the default flex-1
          (basis 0) an ancestor that is a plain block collapses this box to its
          content height, and the ResizeObserver then chases the shrinking canvas
          in a feedback loop (preview がだんだん小さくなる). */}
      <div
        className={`relative min-h-0 ${fixedHeight ? '' : 'flex-1'}`}
        style={fixedHeight ? { height: fixedHeight, flex: '0 0 auto' } : undefined}
      >
        <div
          ref={areaRef}
          tabIndex={0}
          onKeyDown={onAreaKeyDown}
          className={`h-full bg-slate-100 outline-none ${mode === 'scroll' || zoomed ? 'overflow-auto' : 'overflow-hidden'}`}
          // Reserve the scrollbar lane permanently whenever the area can scroll —
          // otherwise the bar's appearance shrinks the pages, the shorter content
          // hides the bar, the pages grow back, and the preview visibly pulses
          // (and the fit size jumps when crossing 100%).
          style={mode === 'scroll' || zoomed ? { scrollbarGutter: 'stable' } : undefined}
        >
          {!doc ? (
            <div className="h-full flex items-center justify-center text-slate-400 text-xs">
              読み込み中...
            </div>
          ) : mode === 'scroll' ? (
            <div className="flex flex-col items-center gap-3 py-2" style={{ minWidth: '100%', width: 'max-content' }}>
              {Array.from({ length: numPages }, (_, i) => (
                <LazyScrollPage key={i + 1} doc={doc} pageNum={i + 1} width={availW * zoom} aspect={aspect} scrollRef={areaRef} />
              ))}
            </div>
          ) : mode === 'single' ? (
            <div className="flex items-center justify-center" style={zoomedBoxStyle}>
              <PdfPage doc={doc} pageNum={page} maxW={availW} maxH={availH} zoom={zoom} />
            </div>
          ) : (
            <div className="flex items-center justify-center gap-2" style={zoomedBoxStyle}>
              <PdfPage doc={doc} pageNum={page} maxW={availW / 2 - 6} maxH={availH} zoom={zoom} />
              {page + 1 <= numPages && (
                <PdfPage doc={doc} pageNum={page + 1} maxW={availW / 2 - 6} maxH={availH} zoom={zoom} />
              )}
            </div>
          )}
        </div>

        {showOutline && (
          <div
            ref={outlineRef}
            className="absolute inset-y-0 left-0 w-[60%] max-w-[240px] bg-white/95 backdrop-blur-sm border-r border-slate-300 overflow-y-auto z-10 flex flex-col"
          >
            <div className="sticky top-0 flex items-center justify-between px-2 py-1.5 bg-white/95 border-b border-slate-200 shrink-0">
              <span className="text-[11px] font-semibold text-slate-700">しおり</span>
              <button onClick={() => setShowOutline(false)} className="text-slate-500 hover:text-slate-800">
                <X size={12} />
              </button>
            </div>
            <div className="py-1">
              {outline.map((it, i) => (
                <button
                  key={i}
                  onClick={() => it.pageNum && jumpTo(it.pageNum)}
                  disabled={!it.pageNum}
                  style={{ paddingLeft: 8 + it.depth * 12 }}
                  className="w-full text-left pr-2 py-1 text-[11px] flex items-start gap-1.5 text-slate-600 hover:text-rose-600 hover:bg-slate-100 disabled:text-slate-400 disabled:hover:bg-transparent disabled:cursor-default transition-colors"
                >
                  <span className="flex-1 leading-snug line-clamp-2">{it.title}</span>
                  {it.pageNum && <span className="text-slate-400 tabular-nums shrink-0">{it.pageNum}</span>}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className={`flex items-center gap-1.5 px-2 shrink-0 border-t border-slate-200 bg-slate-50 ${IS_TOUCH ? 'py-1.5' : 'py-1'}`}>
        {outline.length > 0 && (
          <>
            <button
              onClick={() => setShowOutline(v => !v)}
              className={`rounded transition-colors ${IS_TOUCH ? 'p-2.5' : 'p-1'} ${showOutline ? 'bg-rose-500/20 text-rose-600' : 'text-slate-500 hover:text-slate-800'}`}
              title="しおり"
            >
              <ListTree size={IS_TOUCH ? 20 : 13} />
            </button>
            <div className="w-px h-3.5 bg-slate-300" />
          </>
        )}
        <button
          onClick={() => go(page - step)}
          disabled={page <= 1 || mode === 'scroll'}
          className={`rounded text-slate-600 hover:text-slate-900 disabled:text-slate-300 disabled:cursor-default ${IS_TOUCH ? 'p-2' : 'p-0.5'}`}
        >
          <ChevronLeft size={IS_TOUCH ? 22 : 14} />
        </button>
        <input
          type="range"
          min={1}
          max={Math.max(1, numPages)}
          step={step}
          value={page}
          disabled={mode === 'scroll'}
          onChange={e => go(parseInt(e.target.value))}
          className="flex-1 h-1 accent-rose-500 cursor-pointer disabled:opacity-30 disabled:cursor-default"
        />
        <div className={`flex items-center gap-0.5 text-slate-600 tabular-nums shrink-0 ${IS_TOUCH ? 'text-sm' : 'text-[11px]'}`}>
          <input
            type="text"
            inputMode="numeric"
            value={pageInput}
            onChange={e => setPageInput(e.target.value.replace(/[^0-9]/g, ''))}
            onFocus={e => e.target.select()}
            onKeyDown={e => { if (e.key === 'Enter') { commitPageInput(); e.currentTarget.blur() } }}
            onBlur={commitPageInput}
            className={`bg-slate-100 border border-slate-300 rounded text-center text-slate-700 outline-none focus:border-rose-500/50 px-0.5 ${IS_TOUCH ? 'w-12 py-1.5' : 'w-9 py-px'}`}
          />
          {mode === 'spread' && page + 1 <= numPages && <span>-{page + 1}</span>}
          <span className="text-slate-500">/ {numPages || '–'}</span>
        </div>
        <button
          onClick={() => go(page + step)}
          disabled={page >= numPages || mode === 'scroll'}
          className={`rounded text-slate-600 hover:text-slate-900 disabled:text-slate-300 disabled:cursor-default ${IS_TOUCH ? 'p-2' : 'p-0.5'}`}
        >
          <ChevronRight size={IS_TOUCH ? 22 : 14} />
        </button>
        <div className="w-px h-3.5 bg-slate-300" />
        <div className="flex rounded overflow-hidden border border-slate-300">
          {modes.map(m => (
            <button
              key={m.key}
              onClick={() => { setMode(m.key); onStateChange?.({ page, mode: m.key }) }}
              className={`transition-colors ${IS_TOUCH ? 'p-2.5' : 'p-1'} ${mode === m.key ? 'bg-rose-500/20 text-rose-600' : 'text-slate-400 hover:text-slate-800'}`}
              title={m.label}
            >
              <m.icon size={IS_TOUCH ? 18 : 12} />
            </button>
          ))}
        </div>
        {zoomable && (
          <>
            <div className="w-px h-3.5 bg-slate-300" />
            <button
              onClick={() => zoomTo(zoom / ZOOM_STEP)}
              disabled={zoom <= ZOOM_MIN + 0.001}
              className={`rounded text-slate-500 hover:text-slate-800 disabled:text-slate-300 disabled:cursor-default ${IS_TOUCH ? 'p-2.5' : 'p-1'}`}
              title="縮小 (Ctrl+ホイール)"
            >
              <ZoomOut size={IS_TOUCH ? 18 : 13} />
            </button>
            <button
              onClick={() => zoomTo(1)}
              className={`rounded text-slate-600 hover:text-rose-600 tabular-nums ${IS_TOUCH ? 'text-sm px-1.5 py-1' : 'text-[11px] px-1 py-0.5'}`}
              title="全体表示に戻す"
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              onClick={() => zoomTo(zoom * ZOOM_STEP)}
              disabled={zoom >= ZOOM_MAX - 0.001}
              className={`rounded text-slate-500 hover:text-slate-800 disabled:text-slate-300 disabled:cursor-default ${IS_TOUCH ? 'p-2.5' : 'p-1'}`}
              title="拡大 (Ctrl+ホイール)"
            >
              <ZoomIn size={IS_TOUCH ? 18 : 13} />
            </button>
          </>
        )}
        {!noFullscreen && (
          <>
            <div className="w-px h-3.5 bg-slate-300" />
            <button
              onClick={e => { fsOpenerRef.current = e.currentTarget; setFullscreen(true) }}
              className={`rounded text-slate-500 hover:text-rose-600 transition-colors ${IS_TOUCH ? 'p-2.5' : 'p-1'}`}
              title="全画面で表示"
            >
              <Maximize2 size={IS_TOUCH ? 20 : 13} />
            </button>
          </>
        )}
      </div>

      {fullscreen && createPortal(
        <div
          ref={fsRef}
          role="dialog"
          aria-modal="true"
          aria-label="PDF 全画面表示"
          className="fixed inset-0 z-[140] flex flex-col bg-slate-900/95"
          onMouseDown={e => e.stopPropagation()}
        >
          <div className="shrink-0 flex items-center gap-2 px-3 py-2">
            <span className="text-xs text-slate-300 truncate flex-1">PDF 全画面表示</span>
            <span className="text-[10px] text-slate-500">Esc で閉じる</span>
            <button
              onClick={() => setFullscreen(false)}
              className={`rounded-lg text-slate-300 hover:text-white hover:bg-white/10 transition-colors ${IS_TOUCH ? 'p-2.5' : 'p-1.5'}`}
              title="閉じる"
            >
              <X size={IS_TOUCH ? 22 : 16} />
            </button>
          </div>
          <div className="flex-1 min-h-0 mx-auto w-full max-w-[1400px] px-3 pb-3 flex flex-col">
            <div className="flex-1 min-h-0 flex flex-col rounded-lg overflow-hidden bg-white shadow-2xl">
              <PdfViewer
                url={url}
                initial={{ page, mode }}
                noFullscreen
                zoomable
                autoFocus
                initialZoom={zoom}
                onZoomChange={setZoom}
                onStateChange={s => {
                  // Mirror the fullscreen reading position back into this (inline)
                  // viewer and the persisted card view state.
                  setPage(s.page)
                  setMode(s.mode)
                  onStateChange?.(s)
                }}
              />
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  )
})
