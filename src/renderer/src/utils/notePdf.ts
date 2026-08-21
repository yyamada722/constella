// ノートの PDF 書き出しとスライド化。
//
// - exportNotePdf:       ノート全文を A4 縦の文書 PDF に
// - splitSlides:         `---`（水平線）区切りでスライドに分割
// - exportNoteSlidesPdf: 各スライドを 16:9 横長 1 ページに割り付けた PDF に
//
// レンダリングは Typol の renderMarkdown（hljs / KaTeX / Mermaid / wiki リンク /
// タスク正規化）をそのまま使い、印刷用に自己完結 HTML 化する:
//   - idb:/local: 画像 → data URL（印刷ウィンドウからは IndexedDB/ブリッジに届かない）
//   - Mermaid → その場で SVG 化（印刷ウィンドウは JS 無効）
//   - タスクチェックボックス → ☐/☑ グリフ（<input> の印刷見た目のばらつき回避）
//   - KaTeX / hljs の CSS は ?raw でインライン（フォントは印刷側のフォールバックに委ねる）
import { renderMarkdown } from '../components/typol/markdown'
import { renderMermaidIn } from '../components/typol/mermaid'
import { getMediaBlob } from '../persistence/media'
import { isLocalRef, getLocalBlob } from './localFile'
import { decodeMdHref } from './mdLink'
import { pdfApi } from './planPdf'
import katexCss from 'katex/dist/katex.min.css?raw'
import hljsCss from 'highlight.js/styles/github.css?raw'

const ZERO_MARGINS = { top: 0, bottom: 0, left: 0, right: 0 }
const DOC_MARGINS = { top: 0.5, bottom: 0.55, left: 0.6, right: 0.6 } // inch

/* ── スライド分割 ── */

// `---`（または ***）だけの行で分割。コードフェンス内は無視。直前の行が空行で
// ない `---` は setext 見出し（h2 の下線）の可能性があるので区切りにしない。
export function splitSlides(md: string): string[] {
  const lines = md.split('\n')
  const slides: string[] = []
  let cur: string[] = []
  let fence: string | null = null
  for (const line of lines) {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (f) {
      if (fence === null) fence = f[1][0]
      else if (f[1][0] === fence) fence = null
    }
    const prevBlank = cur.length === 0 || cur[cur.length - 1].trim() === ''
    if (fence === null && prevBlank && /^\s{0,3}(-{3,}|\*{3,})\s*$/.test(line)) {
      slides.push(cur.join('\n'))
      cur = []
      continue
    }
    cur.push(line)
  }
  slides.push(cur.join('\n'))
  const nonEmpty = slides.map(s => s.trim()).filter(Boolean)
  return nonEmpty.length ? nonEmpty : ['']
}

/* ── 印刷用 HTML の自己完結化 ── */

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = () => reject(r.error)
    r.readAsDataURL(blob)
  })
}

// renderMarkdown の HTML を、JS 無効の印刷ウィンドウでもそのまま表示できる形に
// 変換する（オフスクリーンの実 DOM 上で画像解決と Mermaid レンダリングを行う）。
export async function inlineForPrint(html: string, widthPx: number): Promise<string> {
  const host = document.createElement('div')
  host.style.cssText = `position:fixed;left:-100000px;top:0;width:${widthPx}px;`
  host.innerHTML = html
  document.body.appendChild(host)
  try {
    for (const img of Array.from(host.querySelectorAll<HTMLImageElement>('img'))) {
      const src = img.getAttribute('src') ?? ''
      try {
        let blob: Blob | null = null
        if (src.startsWith('idb:')) blob = await getMediaBlob(src)
        else if (isLocalRef(src)) blob = await getLocalBlob(decodeMdHref(src))
        else continue // http/data はそのまま（印刷ウィンドウが直接読み込む）
        if (blob) img.src = await blobToDataUrl(blob)
        else img.remove()
      } catch {
        img.remove() // 読めない画像はページを壊さず落とす
      }
    }
    await renderMermaidIn(host)
    host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach(box => {
      const glyph = document.createElement('span')
      glyph.className = 'task-glyph' + (box.checked ? ' done' : '')
      glyph.textContent = box.checked ? '☑' : '☐'
      const li = box.closest('li')
      if (li) {
        li.classList.add('task-list-item')
        li.parentElement?.classList.add('contains-task-list')
      }
      box.replaceWith(glyph)
    })
    return host.innerHTML
  } finally {
    host.remove()
  }
}

function escHtml(s: string): string {
  return s.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string))
}

// 文書・スライド共通の Markdown 印刷スタイル（ライトテーマ固定）。
const MD_PRINT_CSS = `
  .md { color: #1e293b; line-height: 1.65; overflow-wrap: anywhere; word-break: break-word; }
  .md > :first-child { margin-top: 0; }
  .md h1 { font-size: 1.7em; font-weight: 700; line-height: 1.3; margin: 0.9em 0 0.4em; padding-bottom: 0.2em; border-bottom: 2px solid #e2e8f0; }
  .md h2 { font-size: 1.35em; font-weight: 700; line-height: 1.3; margin: 0.9em 0 0.35em; }
  .md h3 { font-size: 1.15em; font-weight: 600; margin: 0.8em 0 0.3em; }
  .md h4, .md h5, .md h6 { font-weight: 600; margin: 0.7em 0 0.25em; }
  .md p { margin: 0.45em 0; }
  .md ul { list-style: disc; padding-left: 1.5em; margin: 0.45em 0; }
  .md ol { list-style: decimal; padding-left: 1.6em; margin: 0.45em 0; }
  .md li { margin: 0.15em 0; }
  .md .contains-task-list { list-style: none; padding-left: 0.3em; }
  .md li.task-list-item { list-style: none; }
  .md .task-glyph { margin-right: 0.35em; color: #64748b; }
  .md .task-glyph.done { color: #059669; }
  .md code { background: #f1f5f9; padding: 0.08em 0.35em; border-radius: 4px; font-size: 0.88em; font-family: Consolas, "Yu Gothic UI", monospace; }
  .md pre { background: #f8fafc; border: 1px solid #e2e8f0; padding: 0.7em 0.9em; border-radius: 6px; margin: 0.55em 0; white-space: pre-wrap; overflow-wrap: anywhere; break-inside: avoid; }
  .md pre code { background: none; padding: 0; font-size: 0.85em; }
  .md blockquote { border-left: 3px solid #cbd5e1; padding-left: 0.9em; color: #64748b; margin: 0.55em 0; }
  .md a { color: #4f46e5; text-decoration: underline; }
  .md hr { border: none; border-top: 1px solid #cbd5e1; margin: 1em 0; }
  .md del { color: #94a3b8; }
  .md table { border-collapse: collapse; margin: 0.55em 0; font-size: 0.95em; break-inside: avoid; }
  .md th, .md td { border: 1px solid #cbd5e1; padding: 0.25em 0.6em; text-align: left; }
  .md th { background: #f1f5f9; font-weight: 600; }
  .md img { max-width: 100%; border-radius: 4px; break-inside: avoid; }
  .md .mermaid-block { margin: 0.7em 0; text-align: center; break-inside: avoid; }
  .md .mermaid-block svg { max-width: 100%; height: auto; }
  .md .mermaid-error { color: #e11d48; font-size: 0.85em; font-family: Consolas, monospace; }
  .md .math-block { overflow: hidden; margin: 0.7em 0; text-align: center; }
  .md .katex-display { margin: 0.5em 0; }
  .md mark { background: #fde68a; color: inherit; padding: 0 0.15em; border-radius: 3px; }
  .md .md-callout { border: 1px solid; border-radius: 8px; padding: 0.5em 0.85em; margin: 0.5em 0; color: #334155; break-inside: avoid; }
  .md .md-callout > p { margin: 0.15em 0; }
  .md .md-callout-title { font-size: 0.72em; font-weight: 700; letter-spacing: 0.09em; margin-bottom: 0.15em; }
  .md .md-callout-note { background: #f0f9ff; border-color: #7dd3fc; }
  .md .md-callout-note .md-callout-title { color: #075985; }
  .md .md-callout-tip { background: #ecfdf5; border-color: #6ee7b7; }
  .md .md-callout-tip .md-callout-title { color: #065f46; }
  .md .md-callout-important { background: #f5f3ff; border-color: #c4b5fd; }
  .md .md-callout-important .md-callout-title { color: #5b21b6; }
  .md .md-callout-warning { background: #fffbeb; border-color: #fcd34d; }
  .md .md-callout-warning .md-callout-title { color: #92400e; }
  .md .md-callout-caution { background: #fff1f2; border-color: #fda4af; }
  .md .md-callout-caution .md-callout-title { color: #9f1239; }
`

function docHtml(title: string, bodyHtml: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  ${katexCss}
  ${hljsCss}
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: "Yu Gothic UI", "Hiragino Sans", "Noto Sans JP", "Meiryo", sans-serif; font-size: 12.5px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .doc-title { font-size: 21px; font-weight: 700; color: #0f172a; padding-bottom: 10px; border-bottom: 2px solid #4f46e5; margin-bottom: 16px; }
  ${MD_PRINT_CSS}
  .md h1 { font-size: 1.5em; }
  </style></head><body>
  <div class="doc-title">${escHtml(title)}</div>
  <div class="md">${bodyHtml}</div>
  </body></html>`
}

// 16:9 スライド (1280×720px = 13.333×7.5in @96dpi)
const SLIDE_W_PX = 1280
const SLIDE_H_PX = 720
const SLIDE_PAD_X = 84
const SLIDE_PAD_Y = 60

function slidesHtml(slideBodies: string[]): string {
  const n = slideBodies.length
  const pages = slideBodies.map((body, i) => `
    <div class="slide${i === n - 1 ? ' last' : ''}">
      <div class="md">${body}</div>
      <div class="pageno">${i + 1} / ${n}</div>
    </div>`)
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  ${katexCss}
  ${hljsCss}
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: "Yu Gothic UI", "Hiragino Sans", "Noto Sans JP", "Meiryo", sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .slide { position: relative; width: ${SLIDE_W_PX}px; height: ${SLIDE_H_PX}px; overflow: hidden; padding: ${SLIDE_PAD_Y}px ${SLIDE_PAD_X}px; page-break-after: always; background: #ffffff; }
  .slide.last { page-break-after: auto; }
  .slide::after { content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 6px; background: linear-gradient(90deg, #4f46e5, #818cf8); }
  .pageno { position: absolute; right: 22px; bottom: 16px; font-size: 13px; color: #94a3b8; font-variant-numeric: tabular-nums; }
  ${MD_PRINT_CSS}
  .slide .md { font-size: 21px; line-height: 1.6; }
  .slide .md h1 { font-size: 2.1em; margin: 0 0 0.5em; border-bottom: 3px solid #4f46e5; padding-bottom: 0.25em; }
  .slide .md h2 { font-size: 1.6em; margin: 0 0 0.5em; }
  .slide .md pre { font-size: 0.85em; }
  </style></head><body>${pages.join('')}</body></html>`
}

/* ── エクスポート本体 ── */

/** ノートを A4 文書 PDF に書き出す。true=保存済み / false=キャンセル。 */
export async function exportNotePdf(note: { title: string; content: string }): Promise<boolean> {
  const api = pdfApi()
  if (!api) throw new Error('PDF書き出しはデスクトップアプリでのみ利用できます')
  const { html } = renderMarkdown(note.content)
  const body = await inlineForPrint(html, 700)
  const bytes = await api.render(docHtml(note.title || '無題のノート', body), DOC_MARGINS)
  return api.save(bytes, note.title || 'ノート')
}

/** ノートを `---` 区切りの 16:9 スライド PDF に書き出す。 */
export async function exportNoteSlidesPdf(note: { title: string; content: string }): Promise<boolean> {
  const api = pdfApi()
  if (!api) throw new Error('PDF書き出しはデスクトップアプリでのみ利用できます')
  const slides = splitSlides(note.content)
  const bodies: string[] = []
  for (const s of slides) {
    bodies.push(await inlineForPrint(renderMarkdown(s).html, SLIDE_W_PX - SLIDE_PAD_X * 2))
  }
  const bytes = await api.render(slidesHtml(bodies), ZERO_MARGINS, {
    pageSizeInch: { width: SLIDE_W_PX / 96, height: SLIDE_H_PX / 96 },
  })
  return api.save(bytes, (note.title || 'ノート') + ' スライド')
}
