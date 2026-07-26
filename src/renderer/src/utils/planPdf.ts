// 計画 (Plan) の PDF 書き出し。
//
// 構成: [本文 (行程タイムライン)] → [目次 (別紙一覧)] → [別紙1..N (添付PDF/画像)]
//  1. 行程本文を印刷用の自己完結 HTML にし、Electron 側 (pdf:render-html) の
//     hidden BrowserWindow + printToPDF でレンダリング
//  2. 本文中の [label](idb:…) / [label](local:…) のうち PDF と画像を「別紙」と
//     して収集し、PDF はページごと結合、画像は A4 1ページに収めて追加
//  3. 別紙が1件でもあれば本文の直後に目次ページを挟む。目次は固定行高で自前
//     ページ分割する（printToPDF 余白 0 + 高さ固定の page div）ので、各行の
//     リンク矩形が決定論的に計算でき、pdf-lib の Link annotation (Dest) で
//     目次行 → 別紙先頭ページへ飛べる。
// 本文・目次の全テキストは escHtml() を通す（ユーザー入力を HTML に埋めるため）。
import { PDFDocument, PDFName, type PDFImage, type PDFRef } from 'pdf-lib'
import {
  parseItinerary, formatDayLabel, formatPrice,
  type Itinerary, type ItBlock, type ItEvent, type ItAlertLevel, type TimePoint,
} from './itinerary'
import { typeStyle, type Tone } from '../components/ItineraryView'
import { getMediaBlob } from '../persistence/media'
import { isLocalRef, localKind, getLocalBlob, localFileName } from './localFile'
import type { Plan } from '../types'

/* ── preload bridge ── */

interface PdfApi {
  render: (html: string, margins: { top: number; bottom: number; left: number; right: number }) => Promise<Uint8Array>
  save: (bytes: Uint8Array, defaultName: string) => Promise<boolean>
}

export function pdfApi(): PdfApi | null {
  const api = (window as unknown as { api?: { pdf?: PdfApi } }).api
  return api?.pdf ?? null
}

/* ── ジオメトリ定数 (A4) ──
 * printToPDF は CSS px を 96dpi として 72pt/in に変換する → px * 0.75 = pt。
 * 目次ページは余白 0 でレンダリングし、下記の固定寸法で自前分割する。 */
const PX2PT = 0.75
const A4_W_PT = 595.28
const A4_H_PT = 841.89
const TOC_PAGE_H_PX = 1120 // A4実寸(1122.5px)より僅かに低くして丸め誤差の溢れを防ぐ
const TOC_PAD_PX = 48
const TOC_HEADER_PX = 76 // 1ページ目の見出しブロック（高さ固定）
const TOC_ROW_PX = 36
const TOC_FIRST_CAP = Math.floor((TOC_PAGE_H_PX - TOC_PAD_PX * 2 - TOC_HEADER_PX) / TOC_ROW_PX)
const TOC_NEXT_CAP = Math.floor((TOC_PAGE_H_PX - TOC_PAD_PX * 2) / TOC_ROW_PX)

const BODY_MARGINS = { top: 0.5, bottom: 0.55, left: 0.55, right: 0.55 } // inch
const ZERO_MARGINS = { top: 0, bottom: 0, left: 0, right: 0 }

/* ── 添付の収集 ── */

const LINK_RE = /\[([^\]\n]+)\]\(([^)\s]+)\)/g

interface PlanAttachment {
  href: string
  label: string
  kind: 'pdf' | 'image'
  blob: Blob
}

function kindFromMime(mime: string): 'pdf' | 'image' | 'other' {
  if (mime === 'application/pdf') return 'pdf'
  if (mime.startsWith('image/')) return 'image'
  return 'other'
}

// 本文の出現順に、埋め込み可能な添付 (idb:/local: の PDF・画像) を重複なしで集める。
async function collectAttachments(content: string): Promise<PlanAttachment[]> {
  const seen = new Map<string, PlanAttachment>()
  for (const m of content.matchAll(LINK_RE)) {
    const label = m[1]
    const href = m[2]
    if (seen.has(href)) continue
    try {
      if (href.startsWith('idb:')) {
        const blob = await getMediaBlob(href)
        if (!blob) continue
        let kind = kindFromMime(blob.type)
        if (kind === 'other') {
          const k = localKind(label) // idb: は拡張子情報が blob 側に無いことがある → ラベルから推定
          if (k === 'pdf' || k === 'image') kind = k
        }
        if (kind === 'pdf' || kind === 'image') seen.set(href, { href, label, kind, blob })
      } else if (isLocalRef(href)) {
        const k = localKind(href)
        if (k !== 'pdf' && k !== 'image') continue
        const blob = await getLocalBlob(href)
        if (!blob) continue
        seen.set(href, { href, label: label || localFileName(href), kind: k, blob })
      }
    } catch { /* 読めない添付は別紙化しない（本文にはチップとして残る） */ }
  }
  return [...seen.values()]
}

/* ── HTML 生成 ── */

function escHtml(s: string): string {
  return s.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string))
}

// トーン → [チップ背景, 文字色, 枠色]。ItineraryView の Tailwind パレットの印刷用近似。
const TONE_HEX: Record<Tone, [string, string, string]> = {
  sky: ['#e0f2fe', '#0284c7', '#bae6fd'],
  indigo: ['#e0e7ff', '#4f46e5', '#c7d2fe'],
  amber: ['#fef3c7', '#d97706', '#fde68a'],
  orange: ['#ffedd5', '#ea580c', '#fed7aa'],
  cyan: ['#cffafe', '#0891b2', '#a5f3fc'],
  violet: ['#ede9fe', '#7c3aed', '#ddd6fe'],
  rose: ['#ffe4e6', '#e11d48', '#fecdd3'],
  emerald: ['#d1fae5', '#059669', '#a7f3d0'],
  fuchsia: ['#fae8ff', '#c026d3', '#f5d0fe'],
  blue: ['#dbeafe', '#2563eb', '#bfdbfe'],
  teal: ['#ccfbf1', '#0d9488', '#99f6e4'],
  slate: ['#f1f5f9', '#64748b', '#e2e8f0'],
}

const ALERT_HEX: Record<ItAlertLevel, [string, string, string, string]> = {
  note: ['#f0f9ff', '#075985', '#7dd3fc', 'NOTE'],
  tip: ['#ecfdf5', '#065f46', '#6ee7b7', 'TIP'],
  important: ['#f5f3ff', '#5b21b6', '#c4b5fd', 'IMPORTANT'],
  warning: ['#fffbeb', '#92400e', '#fcd34d', 'WARNING'],
  caution: ['#fff1f2', '#9f1239', '#fda4af', 'CAUTION'],
}

// **bold** / `code` / word^ALIAS を含む素のテキスト → 印刷 HTML
function plainHtml(text: string): string {
  let out = ''
  let rest = text
  const TOKEN = /\*\*([^*]+)\*\*|`([^`]+)`|\^([A-Za-z0-9][\w-]*)/
  while (rest) {
    const m = TOKEN.exec(rest)
    if (!m) { out += escHtml(rest); break }
    out += escHtml(rest.slice(0, m.index))
    if (m[1] != null) out += `<strong>${escHtml(m[1])}</strong>`
    else if (m[2] != null) out += `<code>${escHtml(m[2])}</code>`
    else if (m[3] != null) out += `<span class="alias">${escHtml(m[3])}</span>`
    rest = rest.slice(m.index + m[0].length)
  }
  return out
}

// リンク入りテキスト → 印刷 HTML。別紙化された添付には〔別紙N〕バッジを付ける。
function richHtml(text: string, attNo: Map<string, number>): string {
  let out = ''
  let last = 0
  LINK_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = LINK_RE.exec(text))) {
    if (m.index > last) out += plainHtml(text.slice(last, m.index))
    const label = m[1]
    const href = m[2]
    const no = attNo.get(href)
    if (no != null) {
      out += `<span class="att">📎 ${escHtml(label)}<span class="attno">別紙${no}</span></span>`
    } else if (/^https?:/i.test(href)) {
      out += `<span class="lnk">${escHtml(label)}</span>`
    } else {
      out += `<span class="att">📎 ${escHtml(label)}</span>`
    }
    last = m.index + m[0].length
  }
  if (last < text.length) out += plainHtml(text.slice(last))
  return out
}

function timeText(t?: TimePoint): string {
  if (!t) return ''
  const base = t.time === 'am' ? '午前' : t.time === 'pm' ? '午後' : t.time
  return base + (t.dayOffset ? `+${t.dayOffset}` : '')
}

function eventHtml(ev: ItEvent, attNo: Map<string, number>): string {
  const [, tone] = typeStyle(ev.type)
  const [bg, tx, bd] = TONE_HEX[tone]
  const start = timeText(ev.start)
  const end = timeText(ev.end)
  const parts: string[] = []
  parts.push(`<div class="ev">`)
  parts.push(`<div class="ev-time"><div class="t1">${escHtml(start || '—')}</div>${end ? `<div class="t2">${escHtml(end)}</div>` : ''}</div>`)
  parts.push(`<span class="dot" style="background:${bg};border-color:${bd};"></span>`)
  parts.push(`<div class="ev-c">`)
  parts.push(`<div class="ev-h"><span class="ty" style="color:${tx};">${escHtml((ev.type || 'plan').toUpperCase())}</span>${ev.title ? `<span class="ti">${richHtml(ev.title, attNo)}</span>` : ''}${ev.dest ? `<span class="dest">${ev.title ? ' — ' : ''}${richHtml(ev.dest, attNo)}</span>` : ''}</div>`)
  if (ev.from || ev.to) {
    parts.push(`<div class="route">${ev.from ? richHtml(ev.from, attNo) : ''} → ${ev.to ? richHtml(ev.to, attNo) : ''}</div>`)
  } else if (ev.at) {
    parts.push(`<div class="route">📍 ${richHtml(ev.at, attNo)}</div>`)
  }
  const chips: string[] = []
  if (ev.price) chips.push(`<span class="price">${escHtml(formatPrice(ev.price))}</span>`)
  for (const mt of ev.meta.filter(x => x.key !== 'price' && x.key !== 'cost')) {
    chips.push(`<span class="meta"><span class="mk">${escHtml(mt.key)}:</span> ${richHtml(mt.value, attNo)}</span>`)
  }
  if (chips.length) parts.push(`<div class="chips">${chips.join('')}</div>`)
  if (ev.notes.length) parts.push(`<div class="notes">${ev.notes.map(n => `<div>${richHtml(n, attNo)}</div>`).join('')}</div>`)
  parts.push(`</div></div>`)
  return parts.join('')
}

function buildBodyHtml(it: Itinerary, planName: string, attNo: Map<string, number>): string {
  const title = it.meta.title || planName || '撮影計画'
  const head: string[] = []
  if (it.firstDate) {
    head.push(`<span class="chip chip-date">📅 ${escHtml(formatDayLabel(it.firstDate))}${it.lastDate && it.lastDate !== it.firstDate ? ` 〜 ${escHtml(formatDayLabel(it.lastDate))}` : ''}${it.dayCount > 1 ? `・${it.dayCount}日間` : ''}</span>`)
  }
  if (it.eventCount > 0) head.push(`<span class="chip">${it.eventCount} 件の予定</span>`)
  for (const t of it.totals) head.push(`<span class="chip chip-price">合計 ${escHtml(formatPrice(t))}</span>`)
  if (it.meta.timezone) head.push(`<span class="chip chip-dim">${escHtml(it.meta.timezone)}</span>`)

  // 日付ごとに区切る（ItineraryView と同じ束ね方）
  type Section = { day?: { date: string; tz?: string }; items: ItBlock[] }
  const secs: Section[] = []
  let cur: Section = { items: [] }
  for (const b of it.blocks) {
    if (b.kind === 'day') {
      if (cur.day || cur.items.length) secs.push(cur)
      cur = { day: { date: b.date, tz: b.tz }, items: [] }
    } else cur.items.push(b)
  }
  if (cur.day || cur.items.length) secs.push(cur)

  const body: string[] = []
  for (const sec of secs) {
    body.push('<div class="sec">')
    if (sec.day) {
      body.push(`<div class="day"><span class="d1">${escHtml(formatDayLabel(sec.day.date))}</span><span class="d2">${escHtml(sec.day.date)}</span>${sec.day.tz ? `<span class="d3">@${escHtml(sec.day.tz)}</span>` : ''}</div>`)
    }
    for (const b of sec.items) {
      if (b.kind === 'event') body.push(eventHtml(b.event, attNo))
      else if (b.kind === 'alert') {
        const [bg, tx, bd, label] = ALERT_HEX[b.level]
        body.push(`<div class="alert" style="background:${bg};color:${tx};border-color:${bd};"><div class="al-h"><span class="al-l">${label}</span>${richHtml(b.title, attNo)}</div>${b.lines.length ? `<div class="al-b">${b.lines.map(l => `<div>${richHtml(l, attNo)}</div>`).join('')}</div>` : ''}</div>`)
      } else if (b.kind === 'heading') {
        body.push(`<div class="hd hd${Math.min(b.depth, 3)}">${plainHtml(b.text)}</div>`)
      } else if (b.kind === 'list') {
        body.push(`<ul class="ls">${b.items.map(x => `<li>${richHtml(x, attNo)}</li>`).join('')}</ul>`)
      } else if (b.kind === 'para') {
        body.push(`<div class="para">${b.text.split('\n').map(l => richHtml(l, attNo)).join('<br>')}</div>`)
      }
    }
    body.push('</div>')
  }

  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: "Yu Gothic UI", "Hiragino Sans", "Noto Sans JP", "Meiryo", sans-serif; color: #1e293b; font-size: 12px; line-height: 1.55; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  h1 { font-size: 19px; color: #0f172a; margin-bottom: 8px; }
  .hchips { display: flex; flex-wrap: wrap; gap: 6px; padding-bottom: 12px; border-bottom: 1.5px solid #e2e8f0; margin-bottom: 16px; }
  .chip { display: inline-block; padding: 2px 9px; border-radius: 999px; background: #f1f5f9; border: 1px solid #e2e8f0; color: #475569; font-size: 10.5px; }
  .chip-date { background: #eef2ff; border-color: #c7d2fe; color: #4338ca; font-weight: 600; }
  .chip-price { background: #fffbeb; border-color: #fde68a; color: #b45309; font-weight: 700; }
  .chip-dim { background: none; border: none; color: #94a3b8; }
  .sec { margin-bottom: 10px; }
  .day { break-inside: avoid; break-after: avoid; display: flex; align-items: baseline; gap: 8px; margin: 14px 0 10px; padding-bottom: 5px; border-bottom: 1px solid #e2e8f0; }
  .day .d1 { font-size: 14.5px; font-weight: 700; color: #0f172a; }
  .day .d2 { font-family: Consolas, monospace; font-size: 10px; color: #94a3b8; }
  .day .d3 { font-family: Consolas, monospace; font-size: 9px; color: #64748b; background: #f1f5f9; border: 1px solid #e2e8f0; border-radius: 4px; padding: 0 5px; }
  .ev { position: relative; break-inside: avoid; padding: 0 0 13px 100px; }
  .ev::before { content: ''; position: absolute; left: 79px; top: 4px; bottom: -4px; width: 1.5px; background: #e2e8f0; }
  .ev:last-child::before { bottom: auto; height: 14px; }
  .ev-time { position: absolute; left: 0; top: 0; width: 64px; text-align: right; }
  .ev-time .t1 { font-weight: 700; color: #334155; font-variant-numeric: tabular-nums; }
  .ev-time .t2 { font-size: 10px; color: #94a3b8; font-variant-numeric: tabular-nums; }
  .dot { position: absolute; left: 74px; top: 3px; width: 12px; height: 12px; border-radius: 999px; border: 1.5px solid; }
  .ev-h .ty { font-family: Consolas, monospace; font-size: 9px; letter-spacing: 0.08em; margin-right: 6px; }
  .ev-h .ti { font-weight: 600; }
  .ev-h .dest { color: #475569; }
  .route { color: #64748b; font-size: 11px; margin-top: 1px; }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
  .price { display: inline-block; padding: 1px 6px; border-radius: 4px; background: #fffbeb; border: 1px solid #fde68a; color: #b45309; font-size: 10px; font-weight: 700; }
  .meta { display: inline-block; padding: 1px 6px; border-radius: 4px; background: #f8fafc; border: 1px solid #e2e8f0; color: #475569; font-size: 10px; }
  .meta .mk { color: #94a3b8; }
  .notes { color: #64748b; font-size: 11px; margin-top: 3px; }
  .att { display: inline-block; padding: 0 5px; border-radius: 4px; background: #eef2ff; border: 1px solid #c7d2fe; color: #4f46e5; font-size: 10.5px; }
  .att .attno { margin-left: 4px; padding: 0 4px; border-radius: 3px; background: #4f46e5; color: #fff; font-size: 9px; font-weight: 700; }
  .lnk { color: #4f46e5; text-decoration: underline; text-underline-offset: 2px; }
  .alias { margin-left: 2px; padding: 0 4px; border-radius: 3px; background: #f1f5f9; border: 1px solid #e2e8f0; color: #64748b; font-family: Consolas, monospace; font-size: 9px; }
  code { padding: 0 4px; border-radius: 3px; background: #f1f5f9; color: #475569; font-family: Consolas, monospace; font-size: 0.9em; }
  .alert { break-inside: avoid; border: 1px solid; border-radius: 8px; padding: 7px 11px; margin: 8px 0; }
  .al-h { font-weight: 700; font-size: 11.5px; }
  .al-l { font-size: 8.5px; letter-spacing: 0.1em; opacity: 0.6; margin-right: 6px; }
  .al-b { font-size: 11px; margin-top: 3px; opacity: 0.9; }
  .hd { font-weight: 700; color: #0f172a; margin: 12px 0 4px; }
  .hd1, .hd2 { font-size: 14px; }
  .hd3 { font-size: 12.5px; }
  .ls { padding-left: 20px; color: #475569; margin: 6px 0; }
  .para { color: #475569; margin: 6px 0; }
  </style></head><body>
  <h1>${escHtml(title)}</h1>
  <div class="hchips">${head.join('')}</div>
  ${body.join('\n')}
  </body></html>`
}

/* ── 目次 ── */

interface TocEntry {
  no: number
  label: string
  kindLabel: string
  page: number | null // 1-based (null = 読み込み失敗)
}

// エントリを目次ページごとに分割（1ページ目だけ見出しの分だけ行数が少ない）。
function tocChunks<T>(rows: T[]): T[][] {
  const chunks: T[][] = []
  let i = 0
  chunks.push(rows.slice(0, TOC_FIRST_CAP))
  i = TOC_FIRST_CAP
  while (i < rows.length) { chunks.push(rows.slice(i, i + TOC_NEXT_CAP)); i += TOC_NEXT_CAP }
  return chunks
}

function buildTocHtml(planName: string, entries: TocEntry[]): string {
  const chunks = tocChunks(entries)
  const pages = chunks.map((chunk, ci) => {
    const rows = chunk.map(e => `
      <div class="row${e.page == null ? ' dim' : ''}">
        <span class="no">別紙${e.no}</span>
        <span class="lbl">${escHtml(e.label)}</span>
        <span class="kind">${e.kindLabel}</span>
        <span class="dots"></span>
        <span class="pg">${e.page == null ? '—' : `p.${e.page}`}</span>
      </div>`).join('')
    return `<div class="page${ci === chunks.length - 1 ? ' last' : ''}">
      ${ci === 0 ? `<div class="toc-h"><div class="t">添付資料 目次</div><div class="s">${escHtml(planName || '計画')}</div></div>` : ''}
      ${rows}
    </div>`
  })
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: "Yu Gothic UI", "Hiragino Sans", "Noto Sans JP", "Meiryo", sans-serif; color: #1e293b; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .page { height: ${TOC_PAGE_H_PX}px; padding: ${TOC_PAD_PX}px; overflow: hidden; page-break-after: always; }
  .page.last { page-break-after: auto; }
  .toc-h { height: ${TOC_HEADER_PX}px; overflow: hidden; }
  .toc-h .t { font-size: 18px; font-weight: 700; color: #0f172a; }
  .toc-h .s { font-size: 11px; color: #64748b; margin-top: 4px; padding-bottom: 8px; border-bottom: 1.5px solid #e2e8f0; }
  .row { height: ${TOC_ROW_PX}px; display: flex; align-items: center; gap: 8px; font-size: 12px; border-bottom: 1px dotted #e2e8f0; }
  .row.dim { opacity: 0.45; }
  .no { flex: none; width: 52px; font-size: 10px; font-weight: 700; color: #4f46e5; background: #eef2ff; border: 1px solid #c7d2fe; border-radius: 4px; text-align: center; padding: 1px 0; }
  .lbl { flex: none; max-width: 430px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #1e293b; }
  .kind { flex: none; font-size: 9px; color: #64748b; background: #f1f5f9; border: 1px solid #e2e8f0; border-radius: 3px; padding: 0 5px; }
  .dots { flex: 1; }
  .pg { flex: none; font-variant-numeric: tabular-nums; color: #475569; font-weight: 600; }
  </style></head><body>${pages.join('')}</body></html>`
}

/* ── 画像 → 埋め込み可能バイト列 ── */

interface EmbeddableImage { kind: 'png' | 'jpg'; bytes: Uint8Array }

async function toEmbeddableImage(blob: Blob): Promise<EmbeddableImage> {
  if (blob.type === 'image/jpeg') return { kind: 'jpg', bytes: new Uint8Array(await blob.arrayBuffer()) }
  if (blob.type === 'image/png') return { kind: 'png', bytes: new Uint8Array(await blob.arrayBuffer()) }
  // webp / avif / bmp / gif / svg … → canvas 経由で PNG 化
  let w = 0
  let h = 0
  let src: CanvasImageSource
  try {
    const bmp = await createImageBitmap(blob)
    w = bmp.width; h = bmp.height; src = bmp
  } catch {
    // createImageBitmap が拒否する形式 (寸法なし SVG 等) は <img> でデコード
    const url = URL.createObjectURL(blob)
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const im = new Image()
        im.onload = () => resolve(im)
        im.onerror = () => reject(new Error('image decode failed'))
        im.src = url
      })
      w = img.naturalWidth || 800; h = img.naturalHeight || 600; src = img
    } finally { URL.revokeObjectURL(url) }
  }
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, w)
  canvas.height = Math.max(1, h)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas unavailable')
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height)
  const png = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
  if (!png) throw new Error('png encode failed')
  return { kind: 'png', bytes: new Uint8Array(await png.arrayBuffer()) }
}

function drawImagePage(doc: PDFDocument, img: PDFImage): void {
  const page = doc.addPage([A4_W_PT, A4_H_PT])
  const m = 36
  const bw = A4_W_PT - m * 2
  const bh = A4_H_PT - m * 2
  const s = Math.min(bw / img.width, bh / img.height)
  const w = img.width * s
  const h = img.height * s
  page.drawImage(img, { x: (A4_W_PT - w) / 2, y: (A4_H_PT - h) / 2, width: w, height: h })
}

/* ── 目次 → 別紙の内部リンク注釈 ── */

function addTocLinks(
  doc: PDFDocument,
  bodyPageCount: number,
  entries: { page: number | null }[],
): void {
  const annotsByPage = new Map<number, PDFRef[]>()
  entries.forEach((e, idx) => {
    if (e.page == null) return
    // idx 行が乗る目次ページとページ内行位置
    const pageOffset = idx < TOC_FIRST_CAP ? 0 : 1 + Math.floor((idx - TOC_FIRST_CAP) / TOC_NEXT_CAP)
    const rowInPage = idx < TOC_FIRST_CAP ? idx : (idx - TOC_FIRST_CAP) % TOC_NEXT_CAP
    const rowTopPx = TOC_PAD_PX + (pageOffset === 0 ? TOC_HEADER_PX : 0) + rowInPage * TOC_ROW_PX
    const y2 = A4_H_PT - rowTopPx * PX2PT
    const y1 = y2 - TOC_ROW_PX * PX2PT
    const target = doc.getPage(e.page - 1)
    const annot = doc.context.register(doc.context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [TOC_PAD_PX * PX2PT, y1, A4_W_PT - TOC_PAD_PX * PX2PT, y2],
      Border: [0, 0, 0],
      Dest: [target.ref, 'Fit'],
    }))
    const tocPageIdx = bodyPageCount + pageOffset
    const arr = annotsByPage.get(tocPageIdx) ?? []
    arr.push(annot)
    annotsByPage.set(tocPageIdx, arr)
  })
  for (const [pageIdx, annots] of annotsByPage) {
    doc.getPage(pageIdx).node.set(PDFName.of('Annots'), doc.context.obj(annots))
  }
}

/* ── エクスポート本体 ── */

/** 計画をPDFへ書き出す。true=保存済み / false=ダイアログでキャンセル。 */
export async function exportPlanPdf(plan: Plan): Promise<boolean> {
  const api = pdfApi()
  if (!api) throw new Error('PDF書き出しはデスクトップアプリでのみ利用できます')

  const it = parseItinerary(plan.content)
  const atts = await collectAttachments(plan.content)
  const attNo = new Map(atts.map((a, i) => [a.href, i + 1]))

  // 1) 本文
  const bodyBytes = await api.render(buildBodyHtml(it, plan.name, attNo), BODY_MARGINS)
  const out = await PDFDocument.create()
  const bodyDoc = await PDFDocument.load(new Uint8Array(bodyBytes))
  for (const p of await out.copyPages(bodyDoc, bodyDoc.getPageIndices())) out.addPage(p)
  const bodyPageCount = out.getPageCount()

  if (atts.length === 0) {
    return api.save(await out.save(), plan.name || '計画')
  }

  // 2) 別紙を先に読み込んでページ数を確定（目次のページ番号計算に必要）
  type Loaded =
    | { att: PlanAttachment; pages: number; doc: PDFDocument; img?: undefined }
    | { att: PlanAttachment; pages: number; img: EmbeddableImage; doc?: undefined }
    | { att: PlanAttachment; pages: 0; doc?: undefined; img?: undefined }
  const loaded: Loaded[] = []
  for (const att of atts) {
    try {
      if (att.kind === 'pdf') {
        const d = await PDFDocument.load(new Uint8Array(await att.blob.arrayBuffer()), { ignoreEncryption: true })
        loaded.push({ att, pages: d.getPageCount(), doc: d })
      } else {
        loaded.push({ att, pages: 1, img: await toEmbeddableImage(att.blob) })
      }
    } catch {
      loaded.push({ att, pages: 0 }) // 壊れた添付は目次に「—」で残す
    }
  }

  const tocPageCount = tocChunks(loaded).length
  let cursor = bodyPageCount + tocPageCount + 1 // 別紙1の開始ページ (1-based)
  const entries = loaded.map((l, i) => {
    const page = l.pages > 0 ? cursor : null
    cursor += l.pages
    return {
      no: i + 1,
      label: l.att.label,
      kindLabel: l.att.kind === 'pdf' ? 'PDF' : '画像',
      page,
      loaded: l,
    }
  })

  // 3) 目次（固定行高の自前分割なのでページ数は tocChunks と必ず一致する）
  const tocBytes = await api.render(buildTocHtml(it.meta.title || plan.name, entries), ZERO_MARGINS)
  const tocDoc = await PDFDocument.load(new Uint8Array(tocBytes))
  for (const p of await out.copyPages(tocDoc, tocDoc.getPageIndices())) out.addPage(p)

  // 4) 別紙ページを追記
  for (const e of entries) {
    if (e.page == null) continue
    const l = e.loaded
    if (l.doc) {
      for (const p of await out.copyPages(l.doc, l.doc.getPageIndices())) out.addPage(p)
    } else if (l.img) {
      const img = l.img.kind === 'jpg' ? await out.embedJpg(l.img.bytes) : await out.embedPng(l.img.bytes)
      drawImagePage(out, img)
    }
  }

  // 5) 目次の各行から別紙先頭ページへの内部リンク
  addTocLinks(out, bodyPageCount, entries)

  return api.save(await out.save(), plan.name || '計画')
}
