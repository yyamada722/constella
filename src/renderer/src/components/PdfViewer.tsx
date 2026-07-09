import { useState, useRef, useEffect, memo } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { ChevronLeft, ChevronRight, List, Maximize, BookOpen, ListTree, X } from 'lucide-react'
import type { PDFDocumentProxy } from 'pdfjs-dist'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

// Bundled (offline) resources for base-14 fonts and CJK (Japanese etc.) CMaps
const PDF_BASE = import.meta.env.BASE_URL || '/'
const CMAP_URL = `${PDF_BASE}cmaps/`
const STANDARD_FONT_URL = `${PDF_BASE}standard_fonts/`

type PdfMode = 'scroll' | 'single' | 'spread'

type OutlineItem = { title: string; depth: number; pageNum: number | null }

/* ── Single page rendered to canvas ── */

const PdfPage = memo(function PdfPage({ doc, pageNum, maxW, maxH }: {
  doc: PDFDocumentProxy
  pageNum: number
  maxW: number
  maxH?: number
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    if (!doc || maxW <= 0 || pageNum < 1 || pageNum > doc.numPages) return
    let cancelled = false
    let renderTask: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | null = null

    doc.getPage(pageNum).then(pg => {
      if (cancelled) return
      const base = pg.getViewport({ scale: 1 })
      let scale = maxW / base.width
      if (maxH && maxH > 0) scale = Math.min(scale, maxH / base.height)
      // Supersample: render at 2–3× the display resolution for crisp text,
      // then let the browser downscale via the CSS size below.
      const dpr = window.devicePixelRatio || 1
      const renderRatio = Math.min(Math.max(dpr, 1) * 2.5, 3.5)
      const displayVp = pg.getViewport({ scale })
      const renderVp = pg.getViewport({ scale: scale * renderRatio })
      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      canvas.width = Math.floor(renderVp.width)
      canvas.height = Math.floor(renderVp.height)
      canvas.style.width = `${Math.floor(displayVp.width)}px`
      canvas.style.height = `${Math.floor(displayVp.height)}px`
      renderTask = pg.render({ canvasContext: ctx, viewport: renderVp })
      renderTask.promise.catch(() => { /* cancelled */ })
    }).catch(() => { /* page load failed */ })

    return () => {
      cancelled = true
      try { renderTask?.cancel() } catch { /* noop */ }
    }
  }, [doc, pageNum, maxW, maxH])

  return <canvas ref={canvasRef} className="bg-white shadow-md rounded-sm block" />
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

export const PdfViewer = memo(function PdfViewer({ url, fixedHeight, initial, onStateChange }: {
  url: string
  fixedHeight?: number
  initial?: { page?: number; mode?: PdfMode }
  onStateChange?: (s: { page: number; mode: PdfMode }) => void
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
  const areaRef = useRef<HTMLDivElement>(null)
  const outlineRef = useRef<HTMLDivElement>(null)

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

  // Measure the render area
  useEffect(() => {
    const el = areaRef.current
    if (!el) return
    const ro = new ResizeObserver(entries => {
      const r = entries[0].contentRect
      setBox({ w: r.width, h: r.height })
    })
    ro.observe(el)
    setBox({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [doc])

  // In scroll mode, keep wheel scrolling inside the PDF (don't zoom the canvas)
  useEffect(() => {
    const el = areaRef.current
    if (!el || mode !== 'scroll') return
    const stop = (e: WheelEvent) => e.stopPropagation()
    el.addEventListener('wheel', stop)
    return () => el.removeEventListener('wheel', stop)
  }, [mode])

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

  // Jump to a page from the outline (scrolls the container in scroll mode)
  const jumpTo = (p: number) => {
    go(p)
    if (mode === 'scroll' && areaRef.current && aspect > 0) {
      const pageH = availW / aspect
      areaRef.current.scrollTop = (p - 1) * (pageH + 12) + 8
    }
    setShowOutline(false)
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="relative flex-1 min-h-0" style={fixedHeight ? { height: fixedHeight } : undefined}>
        <div
          ref={areaRef}
          className={`h-full bg-slate-100 ${mode === 'scroll' ? 'overflow-y-auto' : 'overflow-hidden'}`}
        >
          {!doc ? (
            <div className="h-full flex items-center justify-center text-slate-400 text-xs">
              読み込み中...
            </div>
          ) : mode === 'scroll' ? (
            <div className="flex flex-col items-center gap-3 py-2">
              {Array.from({ length: numPages }, (_, i) => (
                <LazyScrollPage key={i + 1} doc={doc} pageNum={i + 1} width={availW} aspect={aspect} scrollRef={areaRef} />
              ))}
            </div>
          ) : mode === 'single' ? (
            <div className="h-full flex items-center justify-center">
              <PdfPage doc={doc} pageNum={page} maxW={availW} maxH={availH} />
            </div>
          ) : (
            <div className="h-full flex items-center justify-center gap-2">
              <PdfPage doc={doc} pageNum={page} maxW={availW / 2 - 6} maxH={availH} />
              {page + 1 <= numPages && (
                <PdfPage doc={doc} pageNum={page + 1} maxW={availW / 2 - 6} maxH={availH} />
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

      <div className="flex items-center gap-1.5 px-2 py-1 shrink-0 border-t border-slate-200 bg-slate-50">
        {outline.length > 0 && (
          <>
            <button
              onClick={() => setShowOutline(v => !v)}
              className={`p-1 rounded transition-colors ${showOutline ? 'bg-rose-500/20 text-rose-600' : 'text-slate-500 hover:text-slate-800'}`}
              title="しおり"
            >
              <ListTree size={13} />
            </button>
            <div className="w-px h-3.5 bg-slate-300" />
          </>
        )}
        <button
          onClick={() => go(page - step)}
          disabled={page <= 1 || mode === 'scroll'}
          className="p-0.5 rounded text-slate-600 hover:text-slate-900 disabled:text-slate-300 disabled:cursor-default"
        >
          <ChevronLeft size={14} />
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
        <div className="flex items-center gap-0.5 text-[11px] text-slate-600 tabular-nums shrink-0">
          <input
            type="text"
            inputMode="numeric"
            value={pageInput}
            onChange={e => setPageInput(e.target.value.replace(/[^0-9]/g, ''))}
            onFocus={e => e.target.select()}
            onKeyDown={e => { if (e.key === 'Enter') { commitPageInput(); e.currentTarget.blur() } }}
            onBlur={commitPageInput}
            className="w-9 bg-slate-100 border border-slate-300 rounded text-center text-slate-700 outline-none focus:border-rose-500/50 px-0.5 py-px"
          />
          {mode === 'spread' && page + 1 <= numPages && <span>-{page + 1}</span>}
          <span className="text-slate-500">/ {numPages || '–'}</span>
        </div>
        <button
          onClick={() => go(page + step)}
          disabled={page >= numPages || mode === 'scroll'}
          className="p-0.5 rounded text-slate-600 hover:text-slate-900 disabled:text-slate-300 disabled:cursor-default"
        >
          <ChevronRight size={14} />
        </button>
        <div className="w-px h-3.5 bg-slate-300" />
        <div className="flex rounded overflow-hidden border border-slate-300">
          {modes.map(m => (
            <button
              key={m.key}
              onClick={() => { setMode(m.key); onStateChange?.({ page, mode: m.key }) }}
              className={`p-1 transition-colors ${mode === m.key ? 'bg-rose-500/20 text-rose-600' : 'text-slate-400 hover:text-slate-800'}`}
              title={m.label}
            >
              <m.icon size={12} />
            </button>
          ))}
        </div>
      </div>
    </div>
  )
})
