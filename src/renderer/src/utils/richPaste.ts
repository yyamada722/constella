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
