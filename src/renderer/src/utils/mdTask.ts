// Task-checkbox markers in Markdown source, shared by MarkdownText (react-markdown)
// and TypolMarkdown (marked). Two syntaxes count as a task:
//   - GFM list tasks:  "- [ ] foo", "1. [x] foo" (any list marker, any indent)
//   - bare lines:      "[ ] foo", "[] foo", "[x] foo" (no list marker needed)
// normalizeTasks() rewrites both into canonical GFM syntax before rendering, and
// scanTasks() enumerates them in source order so a clicked checkbox in the rendered
// view can be mapped back to its source position. Both walk lines with the same
// fence-aware scan, so their indexes always agree.

interface TaskMarker {
  /** offset of the state character between the brackets (of ']' for the empty [] form) */
  charPos: number
  /** ' ' | 'x' | 'X' | '' (the [] form) */
  char: string
  /** offset of the '[' */
  bracketPos: number
  /** the line already carries a list marker */
  inList: boolean
  /** the ']' sits at the end of the line (GFM then needs a trailing space to render) */
  atEol: boolean
}

// ']' must be followed by whitespace/EOL so [text](url), [x](url), [n]: defs
// and footnotes stay plain links. Bare form caps the indent at 3 spaces —
// deeper is an indented code block.
const LIST_TASK = /^((?:\s*>\s?)*\s*(?:[-*+]|\d+[.)])\s+\[)([ xX]?)\](?=\s|$)/
const BARE_TASK = /^((?:\s*>\s?)*[ ]{0,3}\[)([ xX]?)\](?=\s|$)/

/* ── コードフェンス走査（Markdown 行スキャナ共通） ── */

export interface FenceState { char: string; len: number }
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/

// 1行ぶんフェンス状態を進める。CommonMark: 閉じフェンスは開きと同じ文字で
// 開きと同じ長さ以上（``` の中の ```` は閉じない）。
export function updateFence(state: FenceState | null, line: string): FenceState | null {
  const m = FENCE_RE.exec(line)
  if (!m) return state
  if (state === null) return { char: m[1][0], len: m[1].length }
  return m[1][0] === state.char && m[1].length >= state.len ? null : state
}

/** offset を含む行がコードフェンスの内側（閉じフェンス行を含む）かどうか。 */
export function inFenceAt(md: string, offset: number): boolean {
  let state: FenceState | null = null
  let pos = 0
  for (const line of md.split('\n')) {
    const end = pos + line.length
    if (offset <= end) return state !== null
    state = updateFence(state, line)
    pos = end + 1
  }
  return false
}

function scanTasks(md: string): TaskMarker[] {
  const out: TaskMarker[] = []
  let fence: FenceState | null = null
  let pos = 0
  for (const line of md.split('\n')) {
    const next = updateFence(fence, line)
    if (fence === null && next === fence) {
      const lm = LIST_TASK.exec(line)
      const m = lm ?? BARE_TASK.exec(line)
      if (m) {
        out.push({
          bracketPos: pos + m[1].length - 1,
          charPos: pos + m[1].length,
          char: m[2],
          inList: !!lm,
          atEol: m[1].length + m[2].length + 1 === line.length,
        })
      }
    }
    fence = next
    pos += line.length + 1
  }
  return out
}

// Rewrite every task marker into canonical GFM syntax ("- [ ] " etc.) so the
// renderer shows a checkbox for all of them. Line count is preserved.
export function normalizeTasks(md: string): string {
  const tasks = scanTasks(md)
  let out = ''
  let last = 0
  for (const t of tasks) {
    // Already canonical: in a list, explicit state char, text after the ']'.
    if (t.inList && t.char !== '' && !t.atEol) continue
    out += md.slice(last, t.bracketPos)
    out += (t.inList ? '' : '- ') + '[' + (t.char === '' ? ' ' : t.char) + ']' + (t.atEol ? ' ' : '')
    last = t.charPos + t.char.length + 1 // past the ']'
  }
  return out + md.slice(last)
}

// Flip the idx-th checkbox and return the new source. `total` is the number of
// checkboxes actually rendered: when it disagrees with the scan (e.g. the render
// produced one we did not count), the mapping is unreliable — return null and
// leave the text untouched rather than flipping the wrong line.
export function toggleTaskAt(md: string, idx: number, total: number): string | null {
  const tasks = scanTasks(md)
  if (tasks.length !== total || idx < 0 || idx >= tasks.length) return null
  const t = tasks[idx]
  const next = t.char === 'x' || t.char === 'X' ? ' ' : 'x'
  return md.slice(0, t.charPos) + next + md.slice(t.charPos + t.char.length)
}
