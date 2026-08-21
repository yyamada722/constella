// ノートのスライドショー表示。`---` 区切り（utils/notePdf.splitSlides）の各
// スライドを 16:9 の固定キャンバス (1280×720) に描き、ウィンドウに合わせて
// transform: scale でフィットさせる。レンダリングは Typol の renderMarkdown
// （hljs / KaTeX / Mermaid / タスク正規化）を流用。
// 操作: ← → Space PageUp/Down Home End / クリック(右=次・左=前) / Esc で閉じる。
import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { X, ChevronLeft, ChevronRight, FileDown, Loader2 } from 'lucide-react'
import { renderMarkdown } from './typol/markdown'
import { renderMermaidIn } from './typol/mermaid'
import { resolveMediaUrl } from '../persistence/media'
import { resolveLocalUrl, releaseLocalUrl, isLocalRef } from '../utils/localFile'
import { decodeMdHref } from '../utils/mdLink'

const SLIDE_W = 1280
const SLIDE_H = 720

export function SlideShow({ slides, onClose, onExportPdf }: {
  /** splitSlides 済みの Markdown 断片（1要素 = 1スライド） */
  slides: string[]
  onClose: () => void
  /** 未指定ならPDFボタンは出さない（Web プレビューなど pdfApi が無い環境） */
  onExportPdf?: () => Promise<void>
}) {
  const [idx, setIdx] = useState(0)
  const [scale, setScale] = useState(1)
  const [exporting, setExporting] = useState(false)
  const slideRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const n = slides.length

  // モーダルとして初期フォーカスを取り、閉じたら元の位置へ戻す
  useEffect(() => {
    const prevFocus = document.activeElement as HTMLElement | null
    rootRef.current?.focus()
    return () => prevFocus?.focus?.()
  }, [])

  const html = useMemo(() => renderMarkdown(slides[idx] ?? '').html, [slides, idx])

  // idb:/local: 画像の解決と Mermaid のレンダリング（Typol プレビューと同じ流儀）
  useEffect(() => {
    const host = slideRef.current
    if (!host) return
    let live = true
    const retained: string[] = []
    host.querySelectorAll<HTMLImageElement>('img[src^="idb:"]').forEach(img => {
      const src = img.getAttribute('src') ?? ''
      resolveMediaUrl(src).then(url => { if (live && url) img.src = url })
    })
    host.querySelectorAll<HTMLImageElement>('img[src^="local:"]').forEach(img => {
      const ref = decodeMdHref(img.getAttribute('src') ?? '')
      if (!isLocalRef(ref)) return
      resolveLocalUrl(ref, true).then(url => {
        if (!url) return
        if (!live) { releaseLocalUrl(ref); return }
        retained.push(ref)
        img.src = url
      })
    })
    void renderMermaidIn(host)
    return () => {
      live = false
      retained.forEach(releaseLocalUrl)
    }
    // idx も deps に含める: DOM は key={idx} で再マウントされるので、同一内容の
    // スライドが並ぶと html 文字列は変わらず、新しいノードが未処理のまま残る。
  }, [html, idx])

  // ウィンドウに 16:9 キャンバスをフィット
  useEffect(() => {
    const fit = () => setScale(Math.min(window.innerWidth / SLIDE_W, window.innerHeight / SLIDE_H) * 0.92)
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [])

  const step = useCallback((d: number) => {
    setIdx(i => Math.max(0, Math.min(n - 1, i + d)))
  }, [n])

  // キーボード操作。capture でアプリ側のグローバルショートカットより先に取る。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // プレゼン中は背後のページショートカット（Ctrl+F/H の検索バー等）を起動させない
      if ((e.ctrlKey || e.metaKey) && ['f', 'h'].includes(e.key.toLowerCase())) {
        e.preventDefault()
        e.stopPropagation()
        return
      }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return }
      if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); step(1); return }
      if (e.key === 'ArrowLeft' || e.key === 'PageUp' || e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); step(-1); return }
      if (e.key === 'Home') { e.preventDefault(); e.stopPropagation(); setIdx(0); return }
      if (e.key === 'End') { e.preventDefault(); e.stopPropagation(); setIdx(n - 1); return }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose, step, n])

  const doExport = async () => {
    if (!onExportPdf || exporting) return
    setExporting(true)
    try { await onExportPdf() } finally { setExporting(false) }
  }

  return createPortal(
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label="スライドショー"
      tabIndex={-1}
      className="fixed inset-0 z-[100] bg-slate-950/95 flex items-center justify-center select-none outline-none"
      onMouseDown={e => e.stopPropagation()}
      onClick={e => {
        const t = e.target as HTMLElement
        // スライド内リンク: レンダラウィンドウごと遷移させない。http(s) は既定ブラウザで
        // 開き（setWindowOpenHandler 経由）、wiki:/local: 等はプレゼン中は無視する。
        const a = t.closest('a')
        if (a) {
          e.preventDefault()
          e.stopPropagation()
          const href = a.getAttribute('href') ?? ''
          if (/^https?:\/\//i.test(href)) window.open(href, '_blank', 'noreferrer')
          return
        }
        // スライド外も含め、右半分クリック=次 / 左半分=前
        if (t.closest('button')) return
        if (e.clientX > window.innerWidth / 2) step(1); else step(-1)
      }}
    >
      <div
        className="bg-white rounded shadow-2xl overflow-hidden relative shrink-0"
        style={{ width: SLIDE_W, height: SLIDE_H, transform: `scale(${scale})` }}
      >
        <div
          ref={slideRef}
          key={idx}
          className="md-content slideshow-slide w-full h-full overflow-hidden"
          style={{ padding: '60px 84px', color: '#1e293b' }}
          dangerouslySetInnerHTML={{ __html: html }}
        />
        <div className="absolute left-0 right-0 bottom-0 h-1.5" style={{ background: 'linear-gradient(90deg, #4f46e5, #818cf8)' }} />
      </div>

      {/* コントロール（クリック送り対象外） */}
      <div className="absolute top-3 right-3 flex items-center gap-1.5">
        {onExportPdf && (
          <button
            onClick={doExport}
            disabled={exporting}
            title="スライドPDFとして書き出し"
            className="p-2 rounded-md text-slate-300 hover:text-white hover:bg-white/10 transition-colors disabled:opacity-40"
          >
            {exporting ? <Loader2 size={18} className="animate-spin" /> : <FileDown size={18} />}
          </button>
        )}
        <button onClick={onClose} title="閉じる (Esc)" className="p-2 rounded-md text-slate-300 hover:text-white hover:bg-white/10 transition-colors">
          <X size={18} />
        </button>
      </div>
      <div className="absolute bottom-3 right-4 flex items-center gap-2 text-slate-400 text-sm tabular-nums">
        <button onClick={() => step(-1)} disabled={idx === 0} title="前へ (←)" className="p-1.5 rounded hover:bg-white/10 hover:text-white disabled:opacity-30 transition-colors">
          <ChevronLeft size={17} />
        </button>
        <span>{idx + 1} / {n}</span>
        <button onClick={() => step(1)} disabled={idx === n - 1} title="次へ (→)" className="p-1.5 rounded hover:bg-white/10 hover:text-white disabled:opacity-30 transition-colors">
          <ChevronRight size={17} />
        </button>
      </div>
    </div>,
    document.body
  )
}
