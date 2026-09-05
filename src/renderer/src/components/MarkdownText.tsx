import { useState, useMemo, useRef, useEffect, isValidElement, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import hljs from 'highlight.js'
import { renderMermaidIn } from './typol/mermaid'
import { putMedia, useMediaUrl } from '../persistence/media'
import { IMAGE_ACCEPT, normalizeImageBlob } from '../utils/image'
import { isLocalRef, localFileApi, localRefPath } from '../utils/localFile'
import { decodeMdHref } from '../utils/mdLink'
import { normalizeTasks, toggleTaskAt } from '../utils/mdTask'
import { remarkConstellaSyntax } from '../utils/mdSyntax'
import { MD_CALLOUT, jpDate, jpDateTime, TPL_MINUTES, TPL_DAILY } from '../utils/mdSnippets'
import { tableKeydown } from '../utils/mdTable'
import { htmlClipboardToMarkdown, tsvToMarkdownTable } from '../utils/richPaste'
import { useWikiLink } from './WikiLink'

// Resolve idb: image refs (pasted images stored in IndexedDB) to a usable URL;
// http/data URLs pass through. Used as the Markdown <img> renderer.
function MdImage({ src, alt }: { src?: string; alt?: string }) {
  // remark percent-encodes destinations, so a local: path with spaces needs
  // decoding before the filesystem bridge sees it.
  const resolved = useMediaUrl(isLocalRef(src) ? decodeMdHref(src as string) : src)
  if (!resolved) return null
  return <img src={resolved} alt={alt ?? ''} />
}

// ```mermaid fences render as diagrams via the shared lazy renderer (same
// pipeline as the Typol note preview, so its SVG cache is shared too).
function MermaidBlock({ source }: { source: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (ref.current) void renderMermaidIn(ref.current)
  }, [source])
  return (
    <div ref={ref}>
      <div key={source} className="mermaid-block" data-source={encodeURIComponent(source)} />
    </div>
  )
}

// Fenced code with a language tag gets highlight.js markup (class names match the
// Typol note preview, so the user-selected code theme applies here as well).
function MdCode({ className, children }: { className?: string; children?: ReactNode }) {
  const lang = /language-([\w+-]+)/.exec(className ?? '')?.[1]
  if (lang && lang !== 'mermaid') {
    const language = hljs.getLanguage(lang) ? lang : 'plaintext'
    try {
      const html = hljs.highlight(String(children ?? '').replace(/\n$/, ''), { language }).value
      return <code className={`hljs language-${language}`} dangerouslySetInnerHTML={{ __html: html }} />
    } catch { /* fall through to plain rendering */ }
  }
  return <code className={className}>{children}</code>
}

// Mirror react-markdown's safe URL handling but allow our idb:/local: refs (images) and wiki: links.
function urlTransform(url: string): string {
  if (url.startsWith('idb:') || url.startsWith('local:') || url.startsWith('wiki:')) return url
  const colon = url.indexOf(':')
  if (colon === -1) return url // relative
  const scheme = url.slice(0, colon).toLowerCase()
  if (scheme === 'http' || scheme === 'https' || scheme === 'mailto' || scheme === 'tel') return url
  // a '/', '?' or '#' before the first ':' means it's relative, not a scheme
  const firstSpecial = Math.min(...['/', '?', '#'].map(c => { const i = url.indexOf(c); return i === -1 ? Infinity : i }))
  return firstSpecial < colon ? url : '' // strip javascript:, data:, etc.
}

const isHttpUrl = (s: string) => /^https?:\/\/\S+$/i.test(s)

// ── Markdown snippet helpers (right-click insert menu) ──
// Each transform takes the current text + selection and returns the new text
// plus where to put the caret/selection afterward.
type MdTransform = (v: string, s: number, e: number) => { value: string; selStart: number; selEnd: number }

const mdWrap = (pre: string, post: string, ph: string): MdTransform => (v, s, e) => {
  const sel = v.slice(s, e)
  // Toggle: if the selection is already wrapped (e.g. **sel**), unwrap instead.
  // 隣接一致だけでなく「さらに外側にも同じデリミタ文字が続く」場合は除外 —
  // **bold** の内側で斜体(*)を実行したときに太字の * を剥がさない。
  const wrapped = sel && s >= pre.length && v.slice(s - pre.length, s) === pre && v.slice(e, e + post.length) === post
  const partOfLonger = wrapped && v[s - pre.length - 1] === pre[0] && v[e + post.length] === post[post.length - 1]
  if (wrapped && !partOfLonger) {
    return { value: v.slice(0, s - pre.length) + sel + v.slice(e + post.length), selStart: s - pre.length, selEnd: e - pre.length }
  }
  const body = sel || ph
  return { value: v.slice(0, s) + pre + body + post + v.slice(e), selStart: s + pre.length, selEnd: s + pre.length + body.length }
}
// Prefix every line touched by the selection (headings, lists, quote).
const mdPrefix = (p: string): MdTransform => (v, s, e) => {
  const ls = v.lastIndexOf('\n', s - 1) + 1
  const seg = v.slice(ls, e)
  const prefixed = seg.split('\n').map((l) => p + l).join('\n')
  const value = v.slice(0, ls) + prefixed + v.slice(e)
  const pos = ls + prefixed.length
  return { value, selStart: pos, selEnd: pos }
}
const mdLink: MdTransform = (v, s, e) => {
  const sel = v.slice(s, e)
  const isUrl = /^https?:\/\//i.test(sel.trim())
  const text = isUrl ? 'リンクテキスト' : (sel || 'リンクテキスト')
  const url = isUrl ? sel.trim() : 'https://'
  const value = v.slice(0, s) + `[${text}](${url})` + v.slice(e)
  const urlStart = s + text.length + 3 // past "[text]("
  return { value, selStart: urlStart, selEnd: urlStart + url.length }
}
const mdBlock: MdTransform = (v, s, e) => {
  const sel = v.slice(s, e) || 'コード'
  const nl = s > 0 && v[s - 1] !== '\n' ? '\n' : ''
  const value = v.slice(0, s) + nl + '```\n' + sel + '\n```\n' + v.slice(e)
  const cs = s + nl.length + 4 // past "```\n"
  return { value, selStart: cs, selEnd: cs + sel.length }
}
const mdSnippet = (text: string): MdTransform => (v, s, e) => {
  const nl = s > 0 && v[s - 1] !== '\n' ? '\n' : ''
  const value = v.slice(0, s) + nl + text + v.slice(e)
  const pos = s + nl.length + text.length
  return { value, selStart: pos, selEnd: pos }
}
const mdImage: MdTransform = (v, s, e) => {
  const alt = v.slice(s, e) || '説明'
  const value = v.slice(0, s) + `![${alt}](https://)` + v.slice(e)
  const urlStart = s + alt.length + 4 // past "![alt]("
  return { value, selStart: urlStart, selEnd: urlStart + 'https://'.length }
}
// Reference-style link: [text][n] in place + a [n]: url definition at the end.
const mdRefLink: MdTransform = (v, s, e) => {
  const sel = v.slice(s, e) || 'テキスト'
  const n = ([...v.matchAll(/^\[(\d+)\]:/gm)].map((m) => +m[1]).reduce((a, b) => Math.max(a, b), 0)) + 1
  const body = v.slice(0, s) + `[${sel}][${n}]` + v.slice(e)
  const value = body + (body.endsWith('\n') ? '' : '\n') + `[${n}]: https://`
  return { value, selStart: value.length - 'https://'.length, selEnd: value.length }
}
// GFM footnote: text[^n] + a [^n]: ... definition at the end.
const mdFootnote: MdTransform = (v, s, e) => {
  const n = ([...v.matchAll(/\[\^(\d+)\]/g)].map((m) => +m[1]).reduce((a, b) => Math.max(a, b), 0)) + 1
  const body = v.slice(0, s) + `[^${n}]` + v.slice(e)
  const note = '脚注の内容'
  const value = body + (body.endsWith('\n') ? '' : '\n') + `[^${n}]: ${note}`
  return { value, selStart: value.length - note.length, selEnd: value.length }
}
const MD_TABLE = '| 見出し1 | 見出し2 |\n| --- | --- |\n| セル | セル |\n'

// テンプレート（挿入時に日付を確定させるため遅延評価）
const mdDynSnippet = (fn: () => string): MdTransform => (v, s, e) => mdSnippet(fn())(v, s, e)

// Ctrl/Cmd shortcuts in the edit textarea. Keyed by `${shift ? 'S' : ''}${key}`.
const MD_SHORTCUTS: Record<string, MdTransform> = {
  b: mdWrap('**', '**', '太字'),
  i: mdWrap('*', '*', '斜体'),
  e: mdWrap('`', '`', 'code'),
  k: mdLink,
  Sx: mdWrap('~~', '~~', 'テキスト'),
}

// A list/quote/task marker at the head of `line`, for smart-Enter continuation.
const lineMarker = (line: string) =>
  /^(\s*)([-*+]\s\[[ xX]\]\s)(.*)$/.exec(line) ||
  /^(\s*)(\[[ xX]?\]\s)(.*)$/.exec(line) ||
  /^(\s*)([-*+]\s)(.*)$/.exec(line) ||
  /^(\s*)(\d+\.\s)(.*)$/.exec(line) ||
  /^(\s*)(>\s?)(.*)$/.exec(line)

const MD_ITEMS: { label: string; run?: MdTransform; special?: 'image-file'; divider?: boolean; hint?: string }[] = [
  { label: '見出し 1 (#)', run: mdPrefix('# ') },
  { label: '見出し 2 (##)', run: mdPrefix('## ') },
  { label: '見出し 3 (###)', run: mdPrefix('### ') },
  { label: '太字', run: mdWrap('**', '**', '太字'), divider: true, hint: 'Ctrl+B' },
  { label: '斜体', run: mdWrap('*', '*', '斜体'), hint: 'Ctrl+I' },
  { label: '取り消し線', run: mdWrap('~~', '~~', 'テキスト'), hint: 'Ctrl+Shift+X' },
  { label: 'インラインコード', run: mdWrap('`', '`', 'code'), hint: 'Ctrl+E' },
  { label: 'ハイライト', run: mdWrap('==', '==', 'ハイライト') },
  { label: '箇条書きリスト', run: mdPrefix('- '), divider: true },
  { label: '番号付きリスト', run: mdPrefix('1. ') },
  { label: 'チェックリスト', run: mdPrefix('- [ ] ') },
  { label: '引用', run: mdPrefix('> ') },
  { label: 'リンク', run: mdLink, divider: true, hint: 'Ctrl+K' },
  { label: '画像 (URL)', run: mdImage },
  { label: '画像を挿入…（ファイル）', special: 'image-file' },
  { label: '参照リンク', run: mdRefLink },
  { label: '脚注', run: mdFootnote },
  { label: 'コードブロック', run: mdBlock, divider: true },
  { label: '表', run: mdSnippet(MD_TABLE) },
  { label: 'コールアウト (NOTE)', run: mdSnippet(MD_CALLOUT) },
  { label: '水平線', run: mdSnippet('---\n') },
  { label: '今日の日付', run: mdDynSnippet(jpDate), divider: true },
  { label: '現在日時', run: mdDynSnippet(jpDateTime) },
  { label: '議事録テンプレート', run: mdDynSnippet(TPL_MINUTES) },
  { label: '日報テンプレート', run: mdDynSnippet(TPL_DAILY) },
]

// An editable text area with Markdown support: shows rendered Markdown when not
// focused, and switches to a raw <textarea> on click for editing (blur returns to
// the rendered view). When readOnly (e.g. a locked card) it stays rendered.
// Pasting: an image is stored and inserted as ![](idb:id); a URL pasted over a
// text selection becomes [selection](url).
// Editing extras: Ctrl+B/I/E/K & Ctrl+Shift+X shortcuts, smart Enter (list/quote/
// task continuation, numbered increment, empty item exits), Tab/Shift+Tab indent.
// In the rendered view, task-list checkboxes toggle [ ]/[x] in the source directly.
export function MarkdownText({ value, onChange, placeholder, readOnly, textSize = 'text-sm', extraClass, editing: editingProp }: {
  value: string
  onChange?: (v: string) => void
  placeholder?: string
  readOnly?: boolean
  textSize?: string
  extraClass?: string
  // Controlled edit mode: when provided, the caller owns the edit/preview toggle
  // (an explicit button) — clicking the rendered text does NOT enter edit mode.
  editing?: boolean
}) {
  const [editingState, setEditingState] = useState(false)
  // Right-click Markdown-insert menu (position + captured selection range).
  const [mdMenu, setMdMenu] = useState<{ x: number; y: number; start: number; end: number } | null>(null)
  const controlled = editingProp !== undefined
  const editing = readOnly ? false : (controlled ? !!editingProp : editingState)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const imgInputRef = useRef<HTMLInputElement>(null)
  const plainPasteRef = useRef(false) // Ctrl+Shift+V 直後はリッチ変換をスキップ
  const onWiki = useWikiLink()
  // Layout (flex/min-height/padding) comes from extraClass so the same component
  // works in the canvas card body (flex column) and the list view (min-height).
  const base = `w-full leading-relaxed text-slate-600 ${textSize}`

  // Parse Markdown only when actually showing the rendered view (skip while editing,
  // so typing doesn't re-parse on every keystroke; skip re-parsing on drag re-renders).
  const showRendered = readOnly || !editing
  // Rendered-view checkboxes are directly toggleable when the text is editable at all.
  const canToggleTasks = !readOnly && !!onChange
  const rendered: ReactNode = useMemo(() => {
    if (!showRendered) return null
    if (!value.trim()) return <span className="text-slate-400">{placeholder}</span>
    // [[Card Title]] -> a wiki: link that jumps to that canvas card.
    // normalizeTasks: bare "[ ] foo" lines also render as checkboxes.
    const processed = normalizeTasks(value.replace(/\[\[([^[\]\n]+)\]\]/g, (_, t: string) => `[${t}](wiki:${encodeURIComponent(t.trim())})`))
    return (
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath, remarkConstellaSyntax]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false }]]}
        urlTransform={urlTransform}
        components={{
          code: MdCode,
          // ```mermaid fences: swap the whole <pre> for the rendered diagram.
          pre: ({ children, node: _node, ...rest }) => {
            const child = Array.isArray(children) ? children[0] : children
            if (isValidElement(child)) {
              const p = child.props as { className?: string; children?: ReactNode }
              if (/language-mermaid/.test(p.className ?? '')) return <MermaidBlock source={String(p.children ?? '')} />
            }
            return <pre {...rest}>{children}</pre>
          },
          a: ({ href, children }) => {
            if (href && href.startsWith('wiki:')) {
              return <a className="text-indigo-600 underline decoration-dotted cursor-pointer" onClick={e => { e.preventDefault(); e.stopPropagation(); onWiki(decodeURIComponent(href.slice(5))) }}>{children}</a>
            }
            // urlTransform lets `local:` through for images; as a link destination it
            // must not become a plain <a target="_blank"> — the browser cannot follow
            // the scheme. Hand the path to the OS instead (no-op without the bridge).
            // Rendered as a <button> because an <a> with no href is unreachable by
            // keyboard, and this "link" is really an action.
            if (isLocalRef(href)) {
              const path = localRefPath(decodeMdHref(href as string))
              return (
                <button
                  type="button"
                  title={path}
                  className="text-cyan-700 underline decoration-dotted cursor-pointer bg-transparent p-0 align-baseline"
                  onClick={e => { e.preventDefault(); e.stopPropagation(); localFileApi()?.open(path).catch(() => {}) }}
                >
                  {children}
                </button>
              )
            }
            return <a href={href} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}>{children}</a>
          },
          img: MdImage,
          // Task-list checkboxes: react-markdown emits them disabled; re-enable so a
          // click can toggle the source text (handled by delegation on the container).
          input: ({ node: _node, type, checked, disabled: _disabled, ...rest }) =>
            type === 'checkbox'
              ? <input type="checkbox" checked={!!checked} readOnly disabled={!canToggleTasks} {...rest} />
              : <input type={type} {...rest} />,
        }}
      >
        {processed}
      </ReactMarkdown>
    )
  }, [value, placeholder, showRendered, onWiki, canToggleTasks])

  // Restore focus + selection after a controlled value change re-renders the textarea.
  // setTimeout(0) rather than rAF: the React commit happens before the next macrotask,
  // and rAF is suspended entirely while the window is hidden/minimized.
  const setCaret = (start: number, end = start) => {
    setTimeout(() => {
      const ta = taRef.current
      if (ta) { ta.focus(); ta.selectionStart = start; ta.selectionEnd = end }
    }, 0)
  }

  // Apply a programmatic edit (shortcut, smart Enter/Tab, menu snippet, image insert).
  // Routed through execCommand so the edit lands in the textarea's NATIVE undo stack —
  // a plain controlled-value swap would make Ctrl+Z inside the textarea skip it.
  // Diff old vs new value to find the replaced range (execCommand needs a range, and
  // the MdTransform helpers all return whole-value results).
  const applyEdit = (next: string, selStart: number, selEnd = selStart) => {
    const ta = taRef.current
    if (ta && ta.value !== next) {
      const old = ta.value
      let p = 0
      const maxP = Math.min(old.length, next.length)
      while (p < maxP && old[p] === next[p]) p++
      let s = 0
      const maxS = Math.min(old.length, next.length) - p
      while (s < maxS && old[old.length - 1 - s] === next[next.length - 1 - s]) s++
      const insert = next.slice(p, next.length - s)
      ta.focus()
      ta.setSelectionRange(p, old.length - s)
      let ok = false
      try {
        ok = document.execCommand(insert ? 'insertText' : 'delete', false, insert || undefined)
      } catch { /* fall through */ }
      if (!ok || ta.value !== next) ta.value = next // undo is lost, but the edit still applies
      ta.setSelectionRange(selStart, selEnd)
      onChange?.(ta.value)
    } else {
      if (!ta) onChange?.(next)
      setCaret(selStart, selEnd)
    }
  }

  // Keyboard editing helpers: Ctrl shortcuts, smart Enter (list continuation),
  // Tab / Shift+Tab (indent / outdent).
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Never intercept while an IME is composing — Enter/Tab confirm candidates.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    const ta = e.currentTarget
    const s = ta.selectionStart, en = ta.selectionEnd

    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      // Ctrl+Shift+V: 直後の paste ではリッチ変換を行わない（プレーン貼り付け）
      if (e.shiftKey && e.key.toLowerCase() === 'v') {
        plainPasteRef.current = true
        setTimeout(() => { plainPasteRef.current = false }, 800)
        return
      }
      const fn = MD_SHORTCUTS[(e.shiftKey ? 'S' : '') + e.key.toLowerCase()]
      if (fn) {
        e.preventDefault()
        e.stopPropagation()
        const r = fn(value, s, en)
        applyEdit(r.value, r.selStart, r.selEnd)
      }
      return
    }

    // 表の中: Tab=セル移動 / Enter=行追加（表ブロック全体を桁揃え）
    if (!e.altKey && (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey))) {
      const r = tableKeydown(value, s, e.key === 'Enter' ? 'Enter' : e.shiftKey ? 'ShiftTab' : 'Tab')
      if (r) {
        e.preventDefault()
        e.stopPropagation()
        applyEdit(r.value, r.selStart, r.selEnd)
        return
      }
    }

    if (e.key === 'Tab') {
      e.preventDefault()
      e.stopPropagation()
      if (s !== en || e.shiftKey) {
        // Indent/outdent every line touched by the selection.
        const ls = value.lastIndexOf('\n', s - 1) + 1
        let le = value.indexOf('\n', en)
        if (le === -1) le = value.length
        const out = value.slice(ls, le).split('\n')
          .map(l => (e.shiftKey ? l.replace(/^(\s{1,2}|\t)/, '') : '  ' + l))
          .join('\n')
        applyEdit(value.slice(0, ls) + out + value.slice(le), ls, ls + out.length)
      } else {
        applyEdit(value.slice(0, s) + '  ' + value.slice(en), s + 2)
      }
      return
    }

    // Shift+Enter: Markdown の強制改行。素の Enter 1 回はプレビューで改行に
    // ならない（段落内の折り返し扱い）ので、行末にバックスラッシュを置いてから
    // 改行する。IME の変換確定 Enter には反応しない。
    if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if ((e.nativeEvent as KeyboardEvent).isComposing) return
      e.preventDefault()
      e.stopPropagation()
      const insert = '\\\n'
      applyEdit(value.slice(0, s) + insert + value.slice(en), s + insert.length)
      return
    }

    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const lineStart = value.lastIndexOf('\n', s - 1) + 1
      const m = lineMarker(value.slice(lineStart, s))
      if (!m) return
      e.preventDefault()
      const [, indent, marker, rest] = m
      // Enter on an empty item: drop the marker and leave the list.
      if (rest === '' && s === en) {
        applyEdit(value.slice(0, lineStart) + indent + value.slice(s), lineStart + indent.length)
        return
      }
      let next = marker
      const olm = /^(\d+)\.\s/.exec(marker)
      if (olm) next = `${Number(olm[1]) + 1}. `
      if (/\[[xX]\]/.test(marker)) next = marker.replace(/\[[xX]\]/, '[ ]')
      const insert = '\n' + indent + next
      applyEdit(value.slice(0, s) + insert + value.slice(en), s + insert.length)
    }
  }

  const onRenderedClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement
    if (!canToggleTasks || !(t instanceof HTMLInputElement) || t.type !== 'checkbox') return
    e.preventDefault()
    e.stopPropagation()
    const boxes = Array.from(e.currentTarget.querySelectorAll('input[type="checkbox"]'))
    const next = toggleTaskAt(value, boxes.indexOf(t), boxes.length)
    if (next !== null) onChange?.(next)
  }

  const insertText = (start: number, end: number, insert: string) => {
    applyEdit(value.slice(0, start) + insert + value.slice(end), start + insert.length)
  }

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const dt = e.clipboardData
    const ta = e.currentTarget
    const start = ta.selectionStart, end = ta.selectionEnd
    // 1. an image on the clipboard -> store it and insert a Markdown image
    const imgItem = Array.from(dt.items).find(i => i.kind === 'file' && i.type.startsWith('image/'))
    if (imgItem) {
      const file = imgItem.getAsFile()
      if (file) {
        e.preventDefault()
        putMedia(file).then(ref => insertText(start, end, `![](${ref})`))
        return
      }
    }
    const plain = plainPasteRef.current
    plainPasteRef.current = false
    const text = dt.getData('text/plain').trim()
    // 2. a URL pasted over a text selection -> Markdown link.
    //    リッチ変換より先に判定する — ブラウザからコピーしたリンクは text/html に
    //    <a> を含むため、後回しにすると選択テキストがリンクテキストで潰される。
    if (text && isHttpUrl(text) && end > start) {
      e.preventDefault()
      insertText(start, end, `[${value.slice(start, end)}](${text})`)
      return
    }
    // 3. リッチペースト: 構造のある HTML → Markdown（Ctrl+Shift+V ではスキップ）
    if (!plain) {
      const html = dt.getData('text/html')
      if (html) {
        const md = htmlClipboardToMarkdown(html)
        if (md) {
          e.preventDefault()
          insertText(start, end, md)
          return
        }
      }
      // 4. タブ区切り（Excel / Sheets のプレーン形）→ Markdown 表
      if (text) {
        const table = tsvToMarkdownTable(text)
        if (table) {
          e.preventDefault()
          insertText(start, end, table)
          return
        }
      }
    }
    // else: default paste
  }

  // Apply a Markdown-snippet transform from the right-click menu, using the
  // selection captured when the menu opened, then restore focus + caret.
  const runMd = (fn: MdTransform) => {
    if (!mdMenu) return
    const r = fn(value, mdMenu.start, mdMenu.end)
    setMdMenu(null)
    applyEdit(r.value, r.selStart, r.selEnd)
  }

  // 画像を挿入…（ファイル選択）: store the caret, open the picker; on pick, embed
  // the image as ![](idb:id) at that position.
  const pendingPos = useRef<{ start: number; end: number } | null>(null)
  const pickImage = () => {
    if (mdMenu) pendingPos.current = { start: mdMenu.start, end: mdMenu.end }
    setMdMenu(null)
    imgInputRef.current?.click()
  }
  const onImageFile = async (file: File | undefined) => {
    if (!file) return
    const ref = await putMedia(await normalizeImageBlob(file)) // TIFF/TGA → PNG
    const pos = pendingPos.current ?? { start: value.length, end: value.length }
    const ins = `![](${ref})`
    applyEdit(value.slice(0, pos.start) + ins + value.slice(pos.end), pos.start + ins.length)
  }

  if (!readOnly && editing) {
    return (
      <>
        <textarea
          ref={taRef}
          autoFocus
          value={value}
          onChange={e => onChange?.(e.target.value)}
          onMouseDown={e => e.stopPropagation()}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={() => { if (!controlled) setEditingState(false) }}
          onContextMenu={e => {
            e.preventDefault()
            e.stopPropagation()
            const ta = e.currentTarget
            setMdMenu({
              x: Math.min(e.clientX, window.innerWidth - 210),
              y: Math.min(e.clientY, window.innerHeight - 380),
              start: ta.selectionStart,
              end: ta.selectionEnd,
            })
          }}
          className={`${base} bg-transparent border-none outline-none resize-none ${extraClass ?? ''}`}
          placeholder={placeholder}
        />
        <input
          ref={imgInputRef}
          type="file"
          accept={IMAGE_ACCEPT}
          className="hidden"
          onChange={e => { onImageFile(e.target.files?.[0]); e.currentTarget.value = '' }}
        />
        {mdMenu && createPortal(
          <>
            <div className="fixed inset-0 z-40" onMouseDown={() => setMdMenu(null)} onContextMenu={e => { e.preventDefault(); setMdMenu(null) }} />
            <div
              className="fixed z-50 bg-white border border-slate-200 rounded-lg shadow-xl py-1 text-sm w-48 max-h-[380px] overflow-y-auto"
              style={{ left: mdMenu.x, top: mdMenu.y }}
              onMouseDown={e => e.stopPropagation()}
            >
              <div className="px-3 pb-1 pt-0.5 text-[11px] font-medium text-slate-400">記法を挿入</div>
              {MD_ITEMS.map(it => (
                <div key={it.label}>
                  {it.divider && <div className="h-px bg-slate-200 my-1" />}
                  <button
                    onClick={() => (it.special === 'image-file' ? pickImage() : it.run && runMd(it.run))}
                    className="w-full text-left px-3 py-1.5 hover:bg-amber-500/10 hover:text-amber-700 text-slate-700 flex items-center justify-between gap-2"
                  >
                    <span>{it.label}</span>
                    {it.hint && <span className="text-[10px] text-slate-400 shrink-0">{it.hint}</span>}
                  </button>
                </div>
              ))}
            </div>
          </>,
          document.body
        )}
      </>
    )
  }
  return (
    <div
      onMouseDown={e => e.stopPropagation()}
      onClick={onRenderedClick}
      onDoubleClick={e => {
        // A double-click on a checkbox is two toggles, not "start editing".
        const t = e.target as HTMLElement
        if (canToggleTasks && t instanceof HTMLInputElement && t.type === 'checkbox') return
        if (!readOnly && !controlled) setEditingState(true)
      }}
      title={readOnly || controlled ? undefined : 'ダブルクリックで編集'}
      className={`md-content overflow-auto select-text ${base} ${extraClass ?? ''}`}
    >
      {rendered}
    </div>
  )
}
