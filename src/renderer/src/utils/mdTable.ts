// Markdown パイプ表の編集支援（MarkdownText / Typol Editor 共通）。
// caret が表の行にあるとき:
//   Tab       = 次のセルへ（最終セルなら次の行、最終行なら空行を追加）
//   Shift+Tab = 前のセルへ
//   Enter     = 下に空行を挿入
// どの操作でも表ブロック全体を桁揃えで整形する（全角文字は幅2として揃える）。

interface EditResult { value: string; selStart: number; selEnd: number }

const isTableLine = (l: string) => /^\s*\|/.test(l)

// 全角 (CJK 等) を 2、それ以外を 1 として表示幅を数える
function dispWidth(s: string): number {
  let w = 0
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0
    const wide =
      (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x20000 && c <= 0x3fffd)
    w += wide ? 2 : 1
  }
  return w
}

interface Row { indent: string; cells: string[] }

function splitRow(line: string): Row {
  const m = /^(\s*)\|(.*)$/.exec(line)
  if (!m) return { indent: '', cells: [line.trim()] }
  const body = m[2].replace(/\|\s*$/, '')
  return { indent: m[1], cells: body.split('|').map(c => c.trim()) }
}

const isSepRow = (r: Row) => r.cells.length > 0 && r.cells.every(c => /^:?-+:?$/.test(c) || c === '') && r.cells.some(c => c.includes('-'))

// 整形後のセル文字列（パディング込み）の文字数
const cellCharLen = (cell: string, width: number) => cell.length + Math.max(0, width - dispWidth(cell))

export function tableKeydown(value: string, selStart: number, key: 'Tab' | 'ShiftTab' | 'Enter'): EditResult | null {
  const lineStart = value.lastIndexOf('\n', selStart - 1) + 1
  let lineEnd = value.indexOf('\n', selStart)
  if (lineEnd === -1) lineEnd = value.length
  if (!isTableLine(value.slice(lineStart, lineEnd))) return null

  // 表ブロック（| で始まる連続行）の範囲
  let blockStart = lineStart
  while (blockStart > 0) {
    const prevStart = value.lastIndexOf('\n', blockStart - 2) + 1
    if (!isTableLine(value.slice(prevStart, blockStart - 1))) break
    blockStart = prevStart
  }
  let blockEnd = lineEnd
  while (blockEnd < value.length) {
    let nextEnd = value.indexOf('\n', blockEnd + 1)
    if (nextEnd === -1) nextEnd = value.length
    if (!isTableLine(value.slice(blockEnd + 1, nextEnd))) break
    blockEnd = nextEnd
  }

  const rows = value.slice(blockStart, blockEnd).split('\n').map(splitRow)
  const rowIdx = value.slice(blockStart, lineStart).split('\n').length - 1
  const nCols = Math.max(...rows.map(r => r.cells.length))
  // caret の列 = 行頭〜caret の '|' の数 - 1
  const pipesBefore = (value.slice(lineStart, selStart).match(/\|/g) ?? []).length
  const colIdx = Math.max(0, Math.min(pipesBefore - 1, nCols - 1))

  // 目標セル
  let tRow = rowIdx
  let tCol = colIdx
  if (key === 'Tab') {
    tCol++
    if (tCol >= nCols) { tCol = 0; tRow++ }
    while (tRow < rows.length && isSepRow(rows[tRow])) tRow++
    if (tRow >= rows.length) rows.push({ indent: rows[0].indent, cells: Array(nCols).fill('') })
  } else if (key === 'ShiftTab') {
    tCol--
    if (tCol < 0) { tCol = nCols - 1; tRow-- }
    while (tRow >= 0 && isSepRow(rows[tRow])) tRow--
    if (tRow < 0) { tRow = rowIdx; tCol = colIdx } // 先頭より前へは行かず、整形だけ
  } else {
    rows.splice(rowIdx + 1, 0, { indent: rows[0].indent, cells: Array(nCols).fill('') })
    tRow = rowIdx + 1
    tCol = 0
  }

  // 列幅（区切り行は除外して実セルの最大幅、最低 3）
  const widths = Array.from({ length: nCols }, (_, i) =>
    Math.max(3, ...rows.filter(r => !isSepRow(r)).map(r => dispWidth(r.cells[i] ?? ''))))

  const fmtRow = (r: Row): string => {
    const cells = Array.from({ length: nCols }, (_, i) => r.cells[i] ?? '')
    if (isSepRow(r)) {
      const seps = cells.map((c, i) => {
        const l = c.startsWith(':')
        const rr = c.endsWith(':') && c.length > 1
        return (l ? ':' : '') + '-'.repeat(Math.max(3, widths[i] - (l ? 1 : 0) - (rr ? 1 : 0))) + (rr ? ':' : '')
      })
      return r.indent + '| ' + seps.join(' | ') + ' |'
    }
    return r.indent + '| ' + cells.map((c, i) => c + ' '.repeat(Math.max(0, widths[i] - dispWidth(c)))).join(' | ') + ' |'
  }
  const block = rows.map(fmtRow).join('\n')
  const newValue = value.slice(0, blockStart) + block + value.slice(blockEnd)

  // 目標セルの内容範囲を選択する caret 位置
  const fmtLines = block.split('\n')
  let pos = blockStart
  for (let i = 0; i < tRow; i++) pos += fmtLines[i].length + 1
  const target = rows[tRow]
  pos += target.indent.length + 2 // '| '
  for (let i = 0; i < tCol; i++) pos += cellCharLen(target.cells[i] ?? '', widths[i]) + 3 // ' | '
  const content = target.cells[tCol] ?? ''
  return { value: newValue, selStart: pos, selEnd: pos + content.length }
}
