// React wrapper around Typol's vanilla-TS Markdown editor (textarea + smart Tab/Enter)
// and live preview (marked + KaTeX + Mermaid). Drop-in compatible with the existing
// MarkdownText props so call sites in NotesPage can swap with no other changes.
//
// What this preserves from the old MarkdownText:
//   - [[Card Title]] wiki-link rendering (handled by markdown.ts preprocessWikiLinks +
//     a click-delegation handler in this component).
//   - idb: image refs resolve to live blob URLs via the existing useMediaUrl path,
//     applied as a post-render mutation on the preview div.
//   - Clipboard image paste in edit mode: putMedia → ![](idb:id) inserted at caret.
//   - URL-over-selection paste: produces [selection](url) markdown.
//   - Right-click "記法を挿入" popover menu (見出し/太字/リスト/リンク/画像/表/...).
import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import {
  Bold, Italic, Strikethrough, Code,
  Heading1, Heading2, Heading3, Quote,
  List, ListOrdered, ListChecks,
  Link2, Image as ImageIcon, Table, FileCode2, Minus,
  type LucideIcon,
} from 'lucide-react'
import { Editor, type CommandName } from './editor'
import { renderMarkdown } from './markdown'
import { renderMermaidIn } from './mermaid'
import { putMedia, resolveMediaUrl } from '../../persistence/media'
import { resolveLocalUrl, releaseLocalUrl, isLocalRef, localRefPath, localFileApi } from '../../utils/localFile'
import { decodeMdHref } from '../../utils/mdLink'
import { IMAGE_ACCEPT, normalizeImageBlob } from '../../utils/image'
import { toggleTaskAt } from '../../utils/mdTask'
import { htmlClipboardToMarkdown, tsvToMarkdownTable } from '../../utils/richPaste'
import { MD_CALLOUT, jpDate, jpDateTime, TPL_MINUTES, TPL_DAILY } from '../../utils/mdSnippets'
import { useWikiLink } from '../WikiLink'

export interface TypolMarkdownProps {
  value: string
  onChange?: (next: string) => void
  placeholder?: string
  readOnly?: boolean
  textSize?: string
  extraClass?: string
  /** Controlled edit mode. When undefined, the component never auto-toggles
   *  (NotesPage always sets this explicitly). */
  editing?: boolean
}

const isHttpUrl = (s: string) => /^https?:\/\/\S+$/i.test(s)

// ── Markdown snippet transforms (mirrors the original MarkdownText menu) ──
type MdTransform = (v: string, s: number, e: number) => { value: string; selStart: number; selEnd: number }

const mdWrap = (pre: string, post: string, ph: string): MdTransform => (v, s, e) => {
  const sel = v.slice(s, e) || ph
  return { value: v.slice(0, s) + pre + sel + post + v.slice(e), selStart: s + pre.length, selEnd: s + pre.length + sel.length }
}
const mdPrefix = (p: string): MdTransform => (v, s, e) => {
  const ls = v.lastIndexOf('\n', s - 1) + 1
  const seg = v.slice(ls, e)
  const prefixed = seg.split('\n').map((l) => p + l).join('\n')
  const next = v.slice(0, ls) + prefixed + v.slice(e)
  const pos = ls + prefixed.length
  return { value: next, selStart: pos, selEnd: pos }
}
const mdLink: MdTransform = (v, s, e) => {
  const sel = v.slice(s, e)
  const isUrl = /^https?:\/\//i.test(sel.trim())
  const text = isUrl ? 'リンクテキスト' : (sel || 'リンクテキスト')
  const url = isUrl ? sel.trim() : 'https://'
  const next = v.slice(0, s) + `[${text}](${url})` + v.slice(e)
  const urlStart = s + text.length + 3
  return { value: next, selStart: urlStart, selEnd: urlStart + url.length }
}
const mdBlock: MdTransform = (v, s, e) => {
  const sel = v.slice(s, e) || 'コード'
  const nl = s > 0 && v[s - 1] !== '\n' ? '\n' : ''
  const next = v.slice(0, s) + nl + '```\n' + sel + '\n```\n' + v.slice(e)
  const cs = s + nl.length + 4
  return { value: next, selStart: cs, selEnd: cs + sel.length }
}
const mdSnippet = (text: string): MdTransform => (v, s, e) => {
  const nl = s > 0 && v[s - 1] !== '\n' ? '\n' : ''
  const next = v.slice(0, s) + nl + text + v.slice(e)
  const pos = s + nl.length + text.length
  return { value: next, selStart: pos, selEnd: pos }
}
const mdImage: MdTransform = (v, s, e) => {
  const alt = v.slice(s, e) || '説明'
  const next = v.slice(0, s) + `![${alt}](https://)` + v.slice(e)
  const urlStart = s + alt.length + 4
  return { value: next, selStart: urlStart, selEnd: urlStart + 'https://'.length }
}
const mdRefLink: MdTransform = (v, s, e) => {
  const sel = v.slice(s, e) || 'テキスト'
  const n = ([...v.matchAll(/^\[(\d+)\]:/gm)].map(m => +m[1]).reduce((a, b) => Math.max(a, b), 0)) + 1
  const body = v.slice(0, s) + `[${sel}][${n}]` + v.slice(e)
  const next = body + (body.endsWith('\n') ? '' : '\n') + `[${n}]: https://`
  return { value: next, selStart: next.length - 'https://'.length, selEnd: next.length }
}
const mdFootnote: MdTransform = (v, s, e) => {
  const n = ([...v.matchAll(/\[\^(\d+)\]/g)].map(m => +m[1]).reduce((a, b) => Math.max(a, b), 0)) + 1
  const body = v.slice(0, s) + `[^${n}]` + v.slice(e)
  const note = '脚注の内容'
  const next = body + (body.endsWith('\n') ? '' : '\n') + `[^${n}]: ${note}`
  return { value: next, selStart: next.length - note.length, selEnd: next.length }
}
const MD_TABLE = '| 見出し1 | 見出し2 |\n| --- | --- |\n| セル | セル |\n'
const MD_MATH_BLOCK = '$$\nx = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}\n$$\n'
const MD_MERMAID = '```mermaid\nflowchart LR\n  A --> B\n  B --> C\n```\n'
// テンプレート（挿入時に日付を確定させるため遅延評価）
const mdDynSnippet = (fn: () => string): MdTransform => (v, s, e) => mdSnippet(fn())(v, s, e)

const MD_ITEMS: { label: string; run?: MdTransform; special?: 'image-file'; divider?: boolean }[] = [
  { label: '見出し 1 (#)', run: mdPrefix('# ') },
  { label: '見出し 2 (##)', run: mdPrefix('## ') },
  { label: '見出し 3 (###)', run: mdPrefix('### ') },
  { label: '太字', run: mdWrap('**', '**', '太字'), divider: true },
  { label: '斜体', run: mdWrap('*', '*', '斜体') },
  { label: '取り消し線', run: mdWrap('~~', '~~', 'テキスト') },
  { label: 'インラインコード', run: mdWrap('`', '`', 'code') },
  { label: 'ハイライト', run: mdWrap('==', '==', 'ハイライト') },
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
  { label: 'Mermaid 図', run: mdSnippet(MD_MERMAID) },
  { label: '数式ブロック (KaTeX)', run: mdSnippet(MD_MATH_BLOCK) },
  { label: '表', run: mdSnippet(MD_TABLE) },
  { label: 'コールアウト (NOTE)', run: mdSnippet(MD_CALLOUT) },
  { label: '水平線', run: mdSnippet('---\n') },
  { label: '今日の日付', run: mdDynSnippet(jpDate), divider: true },
  { label: '現在日時', run: mdDynSnippet(jpDateTime) },
  { label: '議事録テンプレート', run: mdDynSnippet(TPL_MINUTES) },
  { label: '日報テンプレート', run: mdDynSnippet(TPL_DAILY) },
]

export function TypolMarkdown({
  value,
  onChange,
  placeholder,
  readOnly,
  textSize = 'text-sm',
  extraClass = '',
  editing,
}: TypolMarkdownProps) {
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const plainPasteRef = useRef(false) // Ctrl+Shift+V 直後はリッチ変換をスキップ
  const previewRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<Editor | null>(null)
  const imgInputRef = useRef<HTMLInputElement | null>(null)
  const pendingPos = useRef<{ start: number; end: number } | null>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onWiki = useWikiLink()
  const onWikiRef = useRef(onWiki)
  onWikiRef.current = onWiki
  // Latest source + toggleability for the preview's click delegation (the handler
  // is attached once per preview mount, so it reads through refs).
  const canToggleTasks = !readOnly && !!onChange
  const valueRef = useRef(value)
  valueRef.current = value
  const canToggleRef = useRef(canToggleTasks)
  canToggleRef.current = canToggleTasks

  const [mdMenu, setMdMenu] = useState<{ x: number; y: number; start: number; end: number } | null>(null)

  const effectiveEditing = !!editing && !readOnly

  // Instantiate the Typol Editor once per mount (when in edit mode). The cleanup
  // is required: without destroy(), StrictMode's double-mount (and HMR) leaves a
  // second keydown listener on the same textarea, and toggle commands (bold etc.)
  // then run twice per keystroke and cancel out.
  useEffect(() => {
    if (!effectiveEditing || !taRef.current) {
      editorRef.current = null
      return
    }
    const ta = taRef.current
    const editor = new Editor({
      textarea: ta,
      onChange: () => onChangeRef.current?.(ta.value),
    })
    editorRef.current = editor
    if (ta.value !== value) ta.value = value
    return () => {
      editor.destroy()
      if (editorRef.current === editor) editorRef.current = null
    }
  }, [effectiveEditing])

  // Push external value updates into the uncontrolled textarea. `ta.value = ...`
  // wipes the caret + scroll position + native undo stack, so use
  // execCommand('insertText') when the textarea is focused (the update likely
  // originated from the user's own keystroke and would be a no-op anyway; when
  // it isn't, execCommand preserves the browser undo history and caret). Falls
  // back to a plain assignment when execCommand isn't supported / the textarea
  // isn't focused — but even then we snapshot and restore caret + scroll.
  useEffect(() => {
    const ta = taRef.current
    if (!effectiveEditing || !ta) return
    if (ta.value === value) return
    const active = document.activeElement === ta
    if (active) {
      try {
        ta.setSelectionRange(0, ta.value.length)
        const ok = document.execCommand('insertText', false, value)
        if (ok) return
      } catch { /* fall through */ }
    }
    const { selectionStart, selectionEnd, scrollTop, scrollLeft } = ta
    ta.value = value
    // Restore caret / scroll where it was; if the new value is shorter, clamp.
    const clamp = (n: number) => Math.min(n, value.length)
    try {
      ta.setSelectionRange(clamp(selectionStart), clamp(selectionEnd))
      ta.scrollTop = scrollTop
      ta.scrollLeft = scrollLeft
    } catch { /* ignore */ }
  }, [value, effectiveEditing])

  // Render preview HTML when not editing.
  useEffect(() => {
    if (effectiveEditing || !previewRef.current) return
    const host = previewRef.current
    if (!value.trim()) {
      host.innerHTML = ''
      return
    }
    const { html } = renderMarkdown(value)
    host.innerHTML = html
    host.querySelectorAll<HTMLImageElement>('img[src^="idb:"]').forEach(img => {
      const src = img.getAttribute('src') ?? ''
      resolveMediaUrl(src).then(url => { if (url) img.src = url })
    })
    // local: refs (server/NAS file references) resolve through Electron the same way.
    // Retain each resolved URL for as long as this render is on screen so the
    // byte-budgeted local cache can't revoke an <img> out from under us.
    let live = true
    const retained: string[] = []
    host.querySelectorAll<HTMLImageElement>('img[src^="local:"]').forEach(img => {
      // marked percent-encodes the destination, so a path with spaces arrives as
      // local:C:%5C…%20… — decode before it reaches the filesystem bridge.
      const ref = decodeMdHref(img.getAttribute('src') ?? '')
      resolveLocalUrl(ref, true).then(url => {
        if (!url) return
        // Release immediately if this render was already torn down; the cleanup
        // below has come and gone by then.
        if (!live) { releaseLocalUrl(ref); return }
        retained.push(ref)
        img.src = url
      })
    })
    void renderMermaidIn(host)
    host.querySelectorAll<HTMLAnchorElement>('a[href^="wiki:"]').forEach(a => {
      a.classList.add('wiki-link')
    })
    // Task checkboxes: re-enable them so a click can toggle [ ]/[x] in the source
    // (handled by the delegation effect below), and tag their list items with the
    // GFM classes typol.css styles — marked itself emits plain <ul><li>, which
    // would show a bullet in front of every checkbox.
    host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach(i => {
      if (canToggleTasks) i.disabled = false
      const li = i.closest('li')
      if (li) {
        li.classList.add('task-list-item')
        li.parentElement?.classList.add('contains-task-list')
      }
    })
    return () => {
      live = false
      retained.forEach(releaseLocalUrl)
      // React never knew about the injected nodes, so drop them ourselves —
      // otherwise they survive a mode switch and the rendered text (no markdown
      // marks) flashes inside the editor before the textarea settles.
      host.innerHTML = ''
    }
  }, [value, effectiveEditing, canToggleTasks])

  // Delegate clicks on wiki:/external links inside the preview.
  useEffect(() => {
    if (effectiveEditing || !previewRef.current) return
    const host = previewRef.current
    const onClick = (e: MouseEvent) => {
      // Task checkbox → flip the matching [ ]/[x] in the source.
      const t = e.target as HTMLElement | null
      if (t instanceof HTMLInputElement && t.type === 'checkbox') {
        e.preventDefault()
        e.stopPropagation()
        if (!canToggleRef.current) return
        const boxes = Array.from(host.querySelectorAll('input[type="checkbox"]'))
        const next = toggleTaskAt(valueRef.current, boxes.indexOf(t), boxes.length)
        // Update the ref immediately so a second toggle in the same tick (before
        // the re-render refreshes it) composes instead of overwriting this one.
        if (next !== null) { valueRef.current = next; onChangeRef.current?.(next) }
        return
      }
      const a = t?.closest?.('a') as HTMLAnchorElement | null
      if (!a) return
      const href = a.getAttribute('href') ?? ''
      if (href.startsWith('wiki:')) {
        e.preventDefault()
        e.stopPropagation()
        onWikiRef.current?.(decodeURIComponent(href.slice(5)))
        return
      }
      // The sanitizer lets `local:` through for image srcs, so notes can also hold
      // [ticket](local:…) anchors. Following one would navigate this WebContents to
      // an unhandled scheme — hand it to the OS instead (and do nothing where there
      // is no filesystem bridge, rather than breaking the view).
      if (isLocalRef(href)) {
        e.preventDefault()
        e.stopPropagation()
        localFileApi()?.open(localRefPath(decodeMdHref(href))).catch(() => {})
        return
      }
      if (/^https?:\/\//i.test(href)) {
        a.target = a.target || '_blank'
        a.rel = 'noreferrer'
      }
    }
    host.addEventListener('click', onClick)
    return () => host.removeEventListener('click', onClick)
  }, [effectiveEditing])

  // Apply a snippet transform captured in the right-click menu, then restore caret.
  function runMd(fn: MdTransform) {
    if (!mdMenu || !taRef.current) return
    const ta = taRef.current
    const r = fn(ta.value, mdMenu.start, mdMenu.end)
    ta.value = r.value
    onChangeRef.current?.(r.value)
    setMdMenu(null)
    requestAnimationFrame(() => {
      ta.focus()
      ta.setSelectionRange(r.selStart, r.selEnd)
    })
  }

  function pickImage() {
    // When invoked from the right-click menu, remember where the caret was so
    // onImageFile inserts at that point. When invoked from the toolbar (mdMenu
    // is null), use the current live caret — but clear any stale pendingPos
    // from a previously-canceled right-click pick so we don't insert at that
    // old position.
    if (mdMenu) pendingPos.current = { start: mdMenu.start, end: mdMenu.end }
    else pendingPos.current = null
    setMdMenu(null)
    imgInputRef.current?.click()
  }

  async function onImageFile(file: File | undefined) {
    if (!file || !taRef.current) return
    const ta = taRef.current
    // Snapshot the insertion position + clear pendingPos IMMEDIATELY so a failed
    // putMedia doesn't leave a stale position waiting for the next paste.
    // When no pendingPos is remembered (toolbar image button), fall back to the
    // current caret rather than the end of the buffer.
    const pos = pendingPos.current
      ?? { start: ta.selectionStart ?? ta.value.length, end: ta.selectionEnd ?? ta.value.length }
    pendingPos.current = null
    let ref: string
    try {
      ref = await putMedia(await normalizeImageBlob(file)) // TIFF/TGA → PNG
    } catch (e) {
      console.error('画像の保存に失敗しました', e)
      return
    }
    const ins = `![](${ref})`
    const next = ta.value.slice(0, pos.start) + ins + ta.value.slice(pos.end)
    ta.value = next
    onChangeRef.current?.(next)
    const caret = pos.start + ins.length
    requestAnimationFrame(() => {
      ta.focus()
      ta.setSelectionRange(caret, caret)
    })
  }

  // Toolbar action — runs an Editor command without stealing focus from the textarea.
  function exec(cmd: CommandName) {
    editorRef.current?.exec(cmd)
  }

  // ── Edit mode ──
  // Distinct keys: the preview root carries innerHTML React doesn't own, so it
  // must be unmounted (not reused) when switching to the editor and back.
  if (effectiveEditing) {
    return (
      <div key="edit" className={`flex flex-col min-h-0 ${extraClass}`}>
        <div
          className="flex items-center gap-0.5 pb-1.5 mb-2 border-b border-slate-200 shrink-0 flex-wrap"
          onMouseDown={e => e.preventDefault()}
        >
          <TbBtn icon={Bold}          onClick={() => exec('bold')}   title="太字 (**) — Ctrl+B" />
          <TbBtn icon={Italic}        onClick={() => exec('italic')} title="斜体 (*) — Ctrl+I" />
          <TbBtn icon={Strikethrough} onClick={() => exec('strike')} title="取り消し線 (~~) — Ctrl+Shift+X" />
          <TbBtn icon={Code}          onClick={() => exec('code')}   title="インラインコード (`) — Ctrl+E" />
          <TbDivider />
          <TbBtn icon={Heading1}      onClick={() => exec('h1')}     title="見出し 1 (#)" />
          <TbBtn icon={Heading2}      onClick={() => exec('h2')}     title="見出し 2 (##)" />
          <TbBtn icon={Heading3}      onClick={() => exec('h3')}     title="見出し 3 (###)" />
          <TbBtn icon={Quote}         onClick={() => exec('quote')}  title="引用 (>)" />
          <TbDivider />
          <TbBtn icon={List}          onClick={() => exec('ul')}     title="箇条書きリスト" />
          <TbBtn icon={ListOrdered}   onClick={() => exec('ol')}     title="番号付きリスト" />
          <TbBtn icon={ListChecks}    onClick={() => exec('task')}   title="チェックリスト" />
          <TbDivider />
          <TbBtn icon={Link2}         onClick={() => exec('link')}   title="リンク — Ctrl+K" />
          <TbBtn icon={ImageIcon}     onClick={pickImage}            title="画像を挿入…（ファイル）" />
          <TbBtn icon={Table}         onClick={() => exec('table')}  title="表" />
          <TbBtn icon={FileCode2}     onClick={() => exec('codeblock')} title="コードブロック (```)" />
          <TbBtn icon={Minus}         onClick={() => exec('hr')}     title="水平線 (---)" />
        </div>
        <textarea
          ref={taRef}
          defaultValue={value}
          placeholder={placeholder}
          spellCheck={false}
          onChange={e => onChange?.(e.target.value)}
          onMouseDown={e => e.stopPropagation()}
          onKeyDown={e => {
            // Ctrl+Shift+V: 直後の paste ではリッチ変換を行わない（プレーン貼り付け）
            if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'v') {
              plainPasteRef.current = true
              setTimeout(() => { plainPasteRef.current = false }, 800)
            }
          }}
          onContextMenu={e => {
            e.preventDefault()
            e.stopPropagation()
            const ta = e.currentTarget
            setMdMenu({
              x: Math.min(e.clientX, window.innerWidth - 220),
              y: Math.min(e.clientY, window.innerHeight - 460),
              start: ta.selectionStart,
              end: ta.selectionEnd,
            })
          }}
          onPaste={async e => {
            const dt = e.clipboardData
            const ta = e.currentTarget
            const imgItem = Array.from(dt.items).find(i => i.kind === 'file' && i.type.startsWith('image/'))
            if (imgItem) {
              const file = imgItem.getAsFile()
              if (file) {
                e.preventDefault()
                const start = ta.selectionStart, end = ta.selectionEnd
                let ref: string
                try {
                  ref = await putMedia(file)
                } catch (err) {
                  console.error('画像の保存に失敗しました', err)
                  return
                }
                const ins = `![](${ref})`
                const next = ta.value.slice(0, start) + ins + ta.value.slice(end)
                ta.value = next
                const caret = start + ins.length
                ta.setSelectionRange(caret, caret)
                onChangeRef.current?.(next)
                return
              }
            }
            const plain = plainPasteRef.current
            plainPasteRef.current = false
            const insertMd = (md: string) => {
              const start = ta.selectionStart, end = ta.selectionEnd
              const next = ta.value.slice(0, start) + md + ta.value.slice(end)
              ta.value = next
              const caret = start + md.length
              ta.setSelectionRange(caret, caret)
              onChangeRef.current?.(next)
            }
            const text = dt.getData('text/plain').trim()
            // 選択範囲への URL 貼り付け = リンク化。リッチ変換より先に判定する —
            // ブラウザからコピーしたリンクは text/html に <a> を含むため。
            if (text && isHttpUrl(text) && ta.selectionEnd > ta.selectionStart) {
              e.preventDefault()
              const start = ta.selectionStart, end = ta.selectionEnd
              const sel = ta.value.slice(start, end)
              insertMd(`[${sel}](${text})`)
              return
            }
            // リッチペースト: 構造のある HTML / タブ区切り → Markdown（Ctrl+Shift+V ではスキップ）
            if (!plain) {
              const html = dt.getData('text/html')
              if (html) {
                const md = htmlClipboardToMarkdown(html)
                if (md) { e.preventDefault(); insertMd(md); return }
              }
              if (text) {
                const table = tsvToMarkdownTable(text)
                if (table) { e.preventDefault(); insertMd(table); return }
              }
            }
          }}
          className={`typol-root typol-editor flex-1 min-h-0 ${textSize}`}
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
              className="fixed z-50 bg-white border border-slate-200 rounded-lg shadow-xl py-1 text-sm w-52 max-h-[440px] overflow-y-auto"
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
      </div>
    )
  }

  // ── Preview mode ──
  if (!value.trim()) {
    return (
      <div
        key="preview-empty"
        ref={previewRef}
        onMouseDown={e => e.stopPropagation()}
        className={`typol-root typol-preview md-content ${textSize} ${extraClass}`}
      >
        <span className="text-slate-400">{placeholder}</span>
      </div>
    )
  }
  return (
    <div
      key="preview"
      ref={previewRef}
      onMouseDown={e => e.stopPropagation()}
      className={`typol-root typol-preview md-content overflow-auto ${textSize} ${extraClass}`}
    />
  )
}

// Toolbar button — onMouseDown.preventDefault keeps focus on the textarea so
// selection-based commands (wrap, prefix) operate on the user's actual selection.
function TbBtn({ icon: Icon, onClick, title }: { icon: LucideIcon; onClick: () => void; title: string }) {
  return (
    <button
      type="button"
      title={title}
      onMouseDown={e => e.preventDefault()}
      onClick={onClick}
      className="p-1 rounded hover:bg-slate-200 text-slate-600 hover:text-slate-900 transition-colors"
    >
      <Icon size={14} />
    </button>
  )
}

function TbDivider() {
  return <div className="w-px h-4 bg-slate-300 mx-0.5" />
}
