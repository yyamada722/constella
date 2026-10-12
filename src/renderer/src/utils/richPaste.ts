// リッチペースト: クリップボードの HTML / タブ区切りテキストを Markdown に変換する。
// - Web ページからのコピー → 見出し/リスト/リンク/表を保った Markdown
// - Excel / Sheets のセル範囲 → Markdown 表（HTML の <table> 経由、または TSV から）
// Ctrl+Shift+V（プレーン貼り付け）では変換しない — 呼び出し側がフラグで制御する。
import TurndownService from 'turndown'
// @ts-expect-error @joplin/turndown-plugin-gfm は型定義を同梱しない
import { gfm } from '@joplin/turndown-plugin-gfm'

let td: TurndownService | null = null
function turndown(): TurndownService {
  if (!td) {
    td = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      bulletListMarker: '-',
      emDelimiter: '*',
      hr: '---',
    })
    td.use(gfm)
  }
  return td
}

// 「構造のある」HTML だけ変換する。エディタ類が付ける装飾だけの HTML
// （<span style> や <br> の羅列）をプレーン貼り付けのままにするためのゲート。
const STRUCTURAL_RE = /<(h[1-6]|ul|ol|table|blockquote|pre|a\s|img\s|strong|em|mark)\b/i

/** HTML クリップボード → Markdown。変換に値しない HTML なら null。 */
export function htmlClipboardToMarkdown(html: string): string | null {
  if (!STRUCTURAL_RE.test(html)) return null
  try {
    const md = turndown().turndown(html).trim()
    return md || null
  } catch {
    return null
  }
}

// htmlDocumentToMarkdown で取り除く非本文要素。script/style は turndown が本文へ
// 吐き出してしまうため必須、残りはナビやアイコン類のノイズ対策。
const DOC_STRIP_SELECTOR = 'script, style, noscript, template, link, meta, iframe, object, embed, svg, canvas, button, input, select, textarea, [aria-hidden="true"]'
// 本文領域が特定できなかったとき (body 全体を使うとき) だけ追加で剥がす骨格要素。
const DOC_CHROME_SELECTOR = 'nav, header, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"]'

/**
 * ページ全体の HTML 文書 → Markdown。リサーチのオフラインクリップ変換用。
 * - <article> / <main> があれば本文として優先し、無ければ body からナビ等を除いて使う
 * - 相対 URL は baseUrl で絶対化、MHTML 内部参照 (cid:) の画像は落とす
 * 変換結果が空なら null。
 */
export function htmlDocumentToMarkdown(html: string, baseUrl?: string): string | null {
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(html, 'text/html')
  } catch {
    return null
  }
  const root: Element =
    doc.querySelector('article') ?? doc.querySelector('main') ?? doc.querySelector('[role="main"]') ?? doc.body
  if (!root) return null
  root.querySelectorAll(DOC_STRIP_SELECTOR).forEach(el => el.remove())
  if (root === doc.body) root.querySelectorAll(DOC_CHROME_SELECTOR).forEach(el => el.remove())

  const resolve = (u: string): string | null => {
    // 空文字は new URL('', base) がページ自身の URL に解決されてしまう
    // (src 無しの遅延読込 <img> が ![](ページURL) になる) ので、無効扱いにする。
    if (!u.trim()) return null
    try {
      const abs = baseUrl ? new URL(u, baseUrl) : new URL(u)
      return abs.protocol === 'http:' || abs.protocol === 'https:' ? abs.href : null
    } catch {
      return null
    }
  }
  root.querySelectorAll('img').forEach(img => {
    const abs = resolve(img.getAttribute('src') ?? '')
    if (abs) img.setAttribute('src', abs)
    else img.remove() // cid: / data 欠損 / 解決不能 — Markdown に残しても壊れ画像になるだけ
  })
  root.querySelectorAll('a').forEach(a => {
    // 表示テキストを持たないリンク（ロゴ・見出しアンカー等、画像除去後に空になった
    // ものも含む）は `[](url)` ノイズになるだけなので丸ごと落とす。
    if (!a.textContent?.trim() && !a.querySelector('img')) { a.remove(); return }
    const abs = resolve(a.getAttribute('href') ?? '')
    if (abs) a.setAttribute('href', abs)
    else a.removeAttribute('href') // turndown はリンク化せずテキストとして残す
  })

  try {
    const md = turndown().turndown(root as HTMLElement).trim()
    return md || null
  } catch {
    return null
  }
}

/** タブ区切りテキスト（Excel / Sheets のプレーン形）→ Markdown 表。対象外なら null。 */
export function tsvToMarkdownTable(text: string): string | null {
  const lines = text.replace(/\r/g, '').split('\n').filter(l => l.trim().length > 0)
  // 2行以上・全行にタブ・タブ始まりの行なし（タブ字下げのコード断片や
  // Makefile レシピを表に誤変換しない — 表計算のコピーは行頭セルが非空）。
  if (lines.length < 2 || !lines.every(l => l.includes('\t')) || lines.some(l => l.startsWith('\t'))) return null
  const rows = lines.map(l => l.split('\t').map(c => c.trim().replace(/\|/g, '\\|')))
  const n = Math.max(...rows.map(r => r.length))
  if (n < 2) return null
  const pad = (r: string[]) => Array.from({ length: n }, (_, i) => r[i] ?? '')
  return [
    '| ' + pad(rows[0]).join(' | ') + ' |',
    '| ' + Array(n).fill('---').join(' | ') + ' |',
    ...rows.slice(1).map(r => '| ' + pad(r).join(' | ') + ' |'),
  ].join('\n') + '\n'
}
