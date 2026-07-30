import { useState, useMemo, useRef, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { putMedia, useMediaUrl } from '../persistence/media'
import { IMAGE_ACCEPT, normalizeImageBlob } from '../utils/image'
import { isLocalRef, localFileApi, localRefPath } from '../utils/localFile'
import { decodeMdHref } from '../utils/mdLink'
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
  const sel = v.slice(s, e) || ph
  return { value: v.slice(0, s) + pre + sel + post + v.slice(e), selStart: s + pre.length, selEnd: s + pre.length + sel.length }
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

const MD_ITEMS: { label: string; run?: MdTransform; special?: 'image-file'; divider?: boolean }[] = [
  { label: '見出し 1 (#)', run: mdPrefix('# ') },
  { label: '見出し 2 (##)', run: mdPrefix('## ') },
  { label: '見出し 3 (###)', run: mdPrefix('### ') },
  { label: '太字', run: mdWrap('**', '**', '太字'), divider: true },
  { label: '斜体', run: mdWrap('*', '*', '斜体') },
  { label: '取り消し線', run: mdWrap('~~', '~~', 'テキスト') },
  { label: 'インラインコード', run: mdWrap('`', '`', 'code') },
  { label: '箇条書きリスト', run: mdPrefix('- '), divider: true },
  { label: '番号付きリスト', run: mdPrefix('1. ') },
  { label: 'チェックリスト', run: mdPrefix('- [ ] ') },
  { label: '引用', run: mdPrefix('> ') },
  { label: 'リンク', run: mdLink, divider: true },
  { label: '画像 (URL)', run: mdImage },
  { label: '画像を挿入…（ファイル）', special: 'image-file' },
  { label: '参照リンク', run: mdRefLink },
  { label: '脚注', run: mdFootnote },
  { label: 'コードブロック', run: mdBlock, divider: true },
  { label: '表', run: mdSnippet(MD_TABLE) },
  { label: '水平線', run: mdSnippet('---\n') },
]

// An editable text area with Markdown support: shows rendered Markdown when not
// focused, and switches to a raw <textarea> on click for editing (blur returns to
// the rendered view). When readOnly (e.g. a locked card) it stays rendered.
// Pasting: an image is stored and inserted as ![](idb:id); a URL pasted over a
// text selection becomes [selection](url).
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
  const onWiki = useWikiLink()
  // Layout (flex/min-height/padding) comes from extraClass so the same component
  // works in the canvas card body (flex column) and the list view (min-height).
  const base = `w-full leading-relaxed text-slate-600 ${textSize}`

  // Parse Markdown only when actually showing the rendered view (skip while editing,
  // so typing doesn't re-parse on every keystroke; skip re-parsing on drag re-renders).
  const showRendered = readOnly || !editing
  const rendered: ReactNode = useMemo(() => {
    if (!showRendered) return null
    if (!value.trim()) return <span className="text-slate-400">{placeholder}</span>
    // [[Card Title]] -> a wiki: link that jumps to that canvas card.
    const processed = value.replace(/\[\[([^[\]\n]+)\]\]/g, (_, t: string) => `[${t}](wiki:${encodeURIComponent(t.trim())})`)
    return (
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={urlTransform}
        components={{
          a: ({ href, children }) => {
            if (href && href.startsWith('wiki:')) {
              return <a className="text-indigo-600 underline decoration-dotted cursor-pointer" onClick={e => { e.preventDefault(); e.stopPropagation(); onWiki(decodeURIComponent(href.slice(5))) }}>{children}</a>
            }
            // urlTransform lets `local:` through for images; as a link destination it
            // must not become a plain <a target="_blank"> — the browser cannot follow
            // the scheme. Hand the path to the OS instead (no-op without the bridge).
            if (isLocalRef(href)) {
              return (
                <a
                  className="text-cyan-700 underline decoration-dotted cursor-pointer"
                  title={localRefPath(decodeMdHref(href as string))}
                  onClick={e => { e.preventDefault(); e.stopPropagation(); localFileApi()?.open(localRefPath(decodeMdHref(href as string))).catch(() => {}) }}
                >
                  {children}
                </a>
              )
            }
            return <a href={href} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}>{children}</a>
          },
          img: MdImage,
        }}
      >
        {processed}
      </ReactMarkdown>
    )
  }, [value, placeholder, showRendered, onWiki])

  const insertText = (start: number, end: number, insert: string) => {
    onChange?.(value.slice(0, start) + insert + value.slice(end))
    const caret = start + insert.length
    requestAnimationFrame(() => {
      const ta = taRef.current
      if (ta) { ta.focus(); ta.selectionStart = ta.selectionEnd = caret }
    })
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
    // 2. a URL pasted over a text selection -> Markdown link
    const text = dt.getData('text/plain').trim()
    if (text && isHttpUrl(text) && end > start) {
      e.preventDefault()
      insertText(start, end, `[${value.slice(start, end)}](${text})`)
    }
    // else: default paste
  }

  // Apply a Markdown-snippet transform from the right-click menu, using the
  // selection captured when the menu opened, then restore focus + caret.
  const runMd = (fn: MdTransform) => {
    if (!mdMenu) return
    const r = fn(value, mdMenu.start, mdMenu.end)
    onChange?.(r.value)
    setMdMenu(null)
    requestAnimationFrame(() => {
      const ta = taRef.current
      if (ta) { ta.focus(); ta.selectionStart = r.selStart; ta.selectionEnd = r.selEnd }
    })
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
    onChange?.(value.slice(0, pos.start) + ins + value.slice(pos.end))
    const caret = pos.start + ins.length
    requestAnimationFrame(() => {
      const ta = taRef.current
      if (ta) { ta.focus(); ta.selectionStart = ta.selectionEnd = caret }
    })
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
                    className="w-full text-left px-3 py-1.5 hover:bg-amber-500/10 hover:text-amber-700 text-slate-700"
                  >
                    {it.label}
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
      onDoubleClick={() => { if (!readOnly && !controlled) setEditingState(true) }}
      title={readOnly || controlled ? undefined : 'ダブルクリックで編集'}
      className={`md-content overflow-auto ${base} ${extraClass ?? ''}`}
    >
      {rendered}
    </div>
  )
}
