import { useState, useEffect, useMemo, useRef, useDeferredValue } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Plus, Trash2, Tag, Pencil, Eye, Columns2, FolderKanban, Folder, FolderPlus, ChevronDown, ChevronRight, Star, Archive, ArchiveRestore, Download, ArrowDownAZ, Minus, Type, Share2, Unlink, FileDown, Presentation, Loader2, Search, X, ChevronUp, ListTree, Link2, FileText, StickyNote, Paperclip } from 'lucide-react'
import { useApp } from '../store'
import { Note, NoteFolder, CanvasCard } from '../types'
import { NoteAttachments } from '../components/NoteAttachments'
import { generateId } from '../utils'
import { TypolMarkdown as MarkdownText } from '../components/typol/TypolMarkdown'
import { NoteMinimap } from '../components/NoteMinimap'
import { BOARD_COLOR_CLASSES, boardColorFor } from '../utils/boardColor'
import { FolderColorSwatch } from '../components/FolderColorSwatch'
import { SearchInput } from '../components/SearchInput'
import { confirmDialog, alertDialog } from '../components/ConfirmDialog'
import { SlideShow } from '../components/SlideShow'
import { exportNotePdf, exportNoteSlidesPdf, splitSlides } from '../utils/notePdf'
import { updateFence, type FenceState } from '../utils/mdTask'
import { pdfApi } from '../utils/planPdf'

export default function NotesPage() {
  const { state, dispatch } = useApp()
  const navigate = useNavigate()
  const location = useLocation()
  const active = state.activeMasterProjectId
  // Only the active master project's notes.
  // Sidebar state — search query, sort mode, archived-visibility toggle.
  // Sort order: 'updated' (newest first), 'created' (newest first), 'title' (A→Z).
  const [search, setSearch] = useState('')
  const [sortMode, setSortMode] = useState<'updated' | 'created' | 'title'>('updated')
  const [showArchived, setShowArchived] = useState(false)
  // Font scale for the editor + preview (applies via CSS vars on typol-root).
  // 1.0 = 14px editor / 15px preview. Range 0.75 (very small) to 2.0 (very large).
  const [fontScale, setFontScale] = useState<number>(() => {
    try {
      const v = parseFloat(localStorage.getItem('constella.notes.fontScale') || '1')
      // Bounds must match the +/- buttons (0.75-2.0). Out-of-range stored values
      // — from an older build or manual localStorage edit — fall back to 1.0.
      return Number.isFinite(v) && v >= 0.75 && v <= 2 ? v : 1
    } catch { return 1 }
  })
  useEffect(() => { try { localStorage.setItem('constella.notes.fontScale', String(fontScale)) } catch { /* ignore */ } }, [fontScale])
  const fontVars = useMemo(() => ({
    '--tp-edit-size': `${Math.round(14 * fontScale)}px`,
    '--tp-preview-size': `${Math.round(15 * fontScale)}px`,
  }) as React.CSSProperties, [fontScale])

  // 付随資料パネルの開閉（グローバルに記憶 — ノート切替では閉じない）
  const [attachOpen, setAttachOpen] = useState<boolean>(() => {
    try { return localStorage.getItem('constella.notes.attachPanel') === '1' } catch { return false }
  })
  useEffect(() => { try { localStorage.setItem('constella.notes.attachPanel', attachOpen ? '1' : '0') } catch { /* ignore */ } }, [attachOpen])

  // PDF書き出し / スライドショー（--- 区切り）
  const [exportingPdf, setExportingPdf] = useState(false)
  const [slideshowOpen, setSlideshowOpen] = useState(false)
  const canPdf = pdfApi() != null
  const doExportPdf = async (note: Note) => {
    if (exportingPdf) return
    setExportingPdf(true)
    try {
      await exportNotePdf(note)
    } catch (e) {
      await alertDialog(`PDFの書き出しに失敗しました: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setExportingPdf(false)
    }
  }
  const doExportSlidesPdf = async (note: Note) => {
    try {
      await exportNoteSlidesPdf(note)
    } catch (e) {
      await alertDialog(`スライドPDFの書き出しに失敗しました: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const allNotes = useMemo(() => state.notes.filter(n => n.masterProjectId === active), [state.notes, active])
  // 添付の検索ヒット用: fileId → 小文字ファイル名（添付はライブラリ参照なので解決が要る）
  const fileNameById = useMemo(() => new Map(state.files.map(f => [f.id, (f.name || '').toLowerCase()])), [state.files])
  // Apply archive visibility + search.
  const notes = useMemo(() => {
    const q = search.trim().toLowerCase()
    return allNotes
      .filter(n => showArchived ? !!n.archivedAt : !n.archivedAt)
      .filter(n => !q || (n.title || '').toLowerCase().includes(q) || (n.content || '').toLowerCase().includes(q) || (n.tags || []).some(t => t.toLowerCase().includes(q)) || (n.attachments || []).some(a => (fileNameById.get(a.fileId) || '').includes(q)))
      .sort((a, b) => {
        // Pinned float to the top regardless of other sort.
        const pa = a.pinned ? 1 : 0, pb = b.pinned ? 1 : 0
        if (pa !== pb) return pb - pa
        if (sortMode === 'title') return (a.title || '').localeCompare(b.title || '')
        if (sortMode === 'created') return b.createdAt.localeCompare(a.createdAt)
        return b.updatedAt.localeCompare(a.updatedAt)
      })
  }, [allNotes, search, sortMode, showArchived, fileNameById])

  const folders = useMemo(
    () => state.noteFolders.filter(f => f.masterProjectId === active).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [state.noteFolders, active]
  )

  // Build the folder tree + partition notes into per-folder buckets + unfiled.
  const { rootFolders, childrenByParent } = useMemo(() => {
    const ids = new Set(folders.map(f => f.id))
    const childrenByParent = new Map<string, NoteFolder[]>()
    const rootFolders: NoteFolder[] = []
    for (const f of folders) {
      if (f.parentId && ids.has(f.parentId)) {
        const arr = childrenByParent.get(f.parentId) ?? []
        arr.push(f); childrenByParent.set(f.parentId, arr)
      } else rootFolders.push(f)
    }
    return { rootFolders, childrenByParent }
  }, [folders])

  const { notesByFolder, unfiledNotes } = useMemo(() => {
    const map = new Map<string, Note[]>()
    const folderIds = new Set(folders.map(f => f.id))
    const unfiled: Note[] = []
    for (const n of notes) {
      if (n.folderId && folderIds.has(n.folderId)) {
        const arr = map.get(n.folderId) ?? []
        arr.push(n); map.set(n.folderId, arr)
      } else unfiled.push(n)
    }
    return { notesByFolder: map, unfiledNotes: unfiled }
  }, [notes, folders])

  const [selectedId, setSelectedId] = useState<string | null>(notes[0]?.id ?? null)
  const [openFolders, setOpenFolders] = useState<Set<string>>(() => new Set())
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null)
  const [folderNameDraft, setFolderNameDraft] = useState('')
  // D&D state — folder highlight + drag payload ref to avoid re-render storms.
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null)
  const [dragOverRoot, setDragOverRoot] = useState(false)
  const draggingRef = useRef<{ kind: 'note' | 'folder'; id: string } | null>(null)
  // View mode: edit is the default so the page feels like a plain text editor;
  // preview / split are available on demand. Persisted across selections — switching
  // notes does NOT force back to preview.
  const [viewMode, setViewMode] = useState<'preview' | 'edit' | 'split'>('edit')
  const viewModeRef = useRef(viewMode)
  viewModeRef.current = viewMode
  // Scroll position (0–1 of the scrollable range) captured just before a mode
  // switch, re-applied to whichever scroller the new mode mounts.
  const pendingScrollRef = useRef<{ ratio: number; focus: boolean } | null>(null)

  // Shared notes from OTHER master projects that THIS project references (live instances).
  const referencedNotes = useMemo(() => {
    const q = search.trim().toLowerCase()
    return state.notes
      .filter(n => n.masterProjectId !== active && n.shared && (n.refByMasterIds ?? []).includes(active) && !n.archivedAt)
      .filter(n => !q || (n.title || '').toLowerCase().includes(q) || (n.content || '').toLowerCase().includes(q) || (n.tags || []).some(t => t.toLowerCase().includes(q)))
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
  }, [state.notes, active, search])
  const masterName = (id: string) => state.masterProjects.find(m => m.id === id)?.name ?? '別プロジェクト'
  // Resolve the selected note from own notes OR referenced (foreign) shared notes.
  const selectedNote = useMemo(
    () => state.notes.find(n => n.id === selectedId && (n.masterProjectId === active || (n.shared && (n.refByMasterIds ?? []).includes(active)))) ?? null,
    [state.notes, selectedId, active]
  )
  const isReference = !!selectedNote && selectedNote.masterProjectId !== active
  // 検索/アウトライン等のイベントハンドラから最新の選択ノートを読むための ref
  const selectedNoteRef = useRef(selectedNote)
  selectedNoteRef.current = selectedNote

  // Reverse lookup: which tasks (across all boards in the active master project) link to this note?
  // Computed lazily per selectedId so list interactions stay snappy as the user clicks around.
  const boardsInScope = useMemo(() => state.projects.filter(p => p.masterProjectId === active), [state.projects, active])
  const linkedTasks = useMemo(() => {
    if (!selectedNote) return [] as { task: typeof state.projects[number]['tasks'][number]; board: typeof state.projects[number]; boardIdx: number }[]
    const out: { task: typeof state.projects[number]['tasks'][number]; board: typeof state.projects[number]; boardIdx: number }[] = []
    boardsInScope.forEach((b, bi) => {
      for (const t of b.tasks) {
        if (t.linkedNoteIds?.includes(selectedNote.id)) out.push({ task: t, board: b, boardIdx: bi })
      }
    })
    return out
  }, [selectedNote, boardsInScope])

  // Keep the selection valid (own note or a referenced foreign note) after project
  // switches / list changes.
  useEffect(() => {
    if (selectedId && !selectedNote) setSelectedId(notes[0]?.id ?? null)
  }, [selectedNote, selectedId, notes])

  // Cross-page entry: Canvas / Mindtrain / etc. can navigate('/', { state: { focusNoteId } }) to surface a note.
  const handledLocKey = useRef('')
  useEffect(() => {
    const st = location.state as { focusNoteId?: string } | null
    if (!st?.focusNoteId || handledLocKey.current === location.key) return
    handledLocKey.current = location.key
    setSelectedId(st.focusNoteId)
    // Don't override viewMode — keep whatever the user last chose so the editor
    // experience stays consistent.
  }, [location.key, location.state])

  function selectNote(id: string) {
    setSelectedId(id)
    // Don't force preview — leave the current viewMode alone so opening a note
    // feels like switching tabs in a text editor.
  }

  function createNote() {
    const note: Note = {
      id: generateId(),
      masterProjectId: active,
      title: '新しいノート',
      content: '',
      tags: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    dispatch({ type: 'ADD_NOTE', payload: note })
    setSelectedId(note.id)
    setViewMode('edit')
  }

  function updateNote(updates: Partial<Note>) {
    if (!selectedNote) return
    dispatch({
      type: 'UPDATE_NOTE',
      payload: { ...selectedNote, ...updates, updatedAt: new Date().toISOString() }
    })
  }

  // ── ノート内検索・置換 (Ctrl+F / Ctrl+H) ──
  const [findOpen, setFindOpen] = useState(false)
  const [findQ, setFindQ] = useState('')
  const [replQ, setReplQ] = useState('')
  const [findIdx, setFindIdx] = useState(0)
  const [showRepl, setShowRepl] = useState(false)
  const findInputRef = useRef<HTMLInputElement>(null)
  const editorTa = () => document.querySelector<HTMLTextAreaElement>('textarea.typol-editor')

  const findMatches = useMemo(() => {
    if (!findOpen || !findQ || !selectedNote) return [] as number[]
    const hay = selectedNote.content.toLowerCase()
    const needle = findQ.toLowerCase()
    const out: number[] = []
    let i = 0
    while (out.length < 2000) {
      i = hay.indexOf(needle, i)
      if (i === -1) break
      out.push(i)
      i += Math.max(1, needle.length)
    }
    return out
  }, [findOpen, findQ, selectedNote])

  // マッチ位置へジャンプ（選択表示はエディタでのみ可能なのでプレビュー時は編集へ）
  const jumpToMatch = (k: number) => {
    if (findMatches.length === 0) return
    const idx = ((k % findMatches.length) + findMatches.length) % findMatches.length
    setFindIdx(idx)
    if (viewMode === 'preview') setViewMode('edit')
    // プレビュー→編集切替直後はエディタ未マウントのことがあるので少しリトライ
    const apply = (attempt: number) => {
      const ta = editorTa()
      if (!ta) {
        if (attempt < 4) setTimeout(() => apply(attempt + 1), 50)
        return
      }
      const content = selectedNoteRef.current?.content ?? ''
      const pos = findMatches[idx]
      ta.setSelectionRange(pos, pos + findQ.length)
      const lh = parseFloat(getComputedStyle(ta).lineHeight) || 22
      const lineNo = content.slice(0, pos).split('\n').length - 1
      ta.scrollTop = Math.max(0, lineNo * lh - ta.clientHeight / 2)
    }
    setTimeout(() => apply(0), 0)
  }
  useEffect(() => { setFindIdx(0) }, [findQ, selectedId])
  // 入力のたびに先頭マッチへライブジャンプ
  useEffect(() => {
    if (findOpen && findQ && findMatches.length > 0) jumpToMatch(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findQ])

  const replaceCurrent = () => {
    if (!selectedNote || findMatches.length === 0) return
    const pos = findMatches[Math.min(findIdx, findMatches.length - 1)]
    updateNote({ content: selectedNote.content.slice(0, pos) + replQ + selectedNote.content.slice(pos + findQ.length) })
  }
  // findMatches は表示用に 2000 件で打ち切るので、すべて置換は自前で全走査する
  const replaceAll = () => {
    if (!selectedNote || !findQ) return
    const hay = selectedNote.content
    const lower = hay.toLowerCase()
    const needle = findQ.toLowerCase()
    let out = ''
    let i = 0
    for (;;) {
      const j = lower.indexOf(needle, i)
      if (j === -1) { out += hay.slice(i); break }
      out += hay.slice(i, j) + replQ
      i = j + Math.max(1, needle.length)
    }
    if (out !== hay) updateNote({ content: out })
  }
  const closeFind = () => { setFindOpen(false); setShowRepl(false) }

  // ── Mode switch that keeps the reading position ──
  // The editor textarea and the preview div are different elements (the preview
  // is even re-created on switch), so without this every toggle lands at the top.
  const previewEl = () => document.querySelector<HTMLElement>('.typol-preview')
  const primaryScroller = (mode: 'preview' | 'edit' | 'split'): HTMLElement | null =>
    mode === 'preview' ? previewEl() : editorTa()
  const scrollRatio = (el: HTMLElement) => el.scrollTop / Math.max(1, el.scrollHeight - el.clientHeight)
  const switchMode = (next: 'preview' | 'edit' | 'split') => {
    const cur = viewModeRef.current
    if (next === cur) return
    const el = primaryScroller(cur)
    pendingScrollRef.current = { ratio: el ? scrollRatio(el) : 0, focus: next !== 'preview' }
    setViewMode(next)
  }
  useEffect(() => {
    const p = pendingScrollRef.current
    if (!p) return
    pendingScrollRef.current = null
    // Every timer is tracked so a quick second switch cancels the stale restore
    // instead of letting it overwrite the new pane with the old ratio.
    let dead = false
    const timers: ReturnType<typeof setTimeout>[] = []
    const later = (fn: () => void, ms: number) => { timers.push(setTimeout(() => { if (!dead) fn() }, ms)) }
    const apply = (attempt: number) => {
      const el = primaryScroller(viewMode)
      if (!el) { if (attempt < 6) later(() => apply(attempt + 1), 40); return }
      if (p.focus && el instanceof HTMLTextAreaElement) {
        // Put the caret on the first line of the visible region BEFORE scrolling —
        // focusing scrolls to the caret, which would otherwise undo the restore.
        const lines = el.value.split('\n')
        const lineIdx = Math.min(lines.length - 1, Math.round(p.ratio * Math.max(0, lines.length - 1)))
        let pos = 0
        for (let i = 0; i < lineIdx; i++) pos += lines[i].length + 1
        el.focus({ preventScroll: true })
        el.setSelectionRange(pos, pos)
      }
      el.scrollTop = p.ratio * (el.scrollHeight - el.clientHeight)
      // The preview's images / mermaid blocks settle a moment later and grow the
      // content; re-apply once so the ratio refers to the final height.
      if (viewMode === 'preview') later(() => { el.scrollTop = p.ratio * (el.scrollHeight - el.clientHeight) }, 120)
    }
    later(() => apply(0), 0)
    return () => { dead = true; timers.forEach(clearTimeout) }
  }, [viewMode]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Split view: keep editor and preview scrolled to the same relative position ──
  useEffect(() => {
    if (viewMode !== 'split') return
    let ta: HTMLTextAreaElement | null = null
    let pv: HTMLElement | null = null
    let lock: HTMLElement | null = null
    let unlockTimer: ReturnType<typeof setTimeout> | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    let dead = false
    const follow = (from: HTMLElement, to: HTMLElement) => () => {
      // A programmatic scrollTop on `to` fires its own scroll event; ignore that
      // echo (and only that one) so the two panes don't fight.
      if (lock === from) return
      lock = to
      to.scrollTop = scrollRatio(from) * (to.scrollHeight - to.clientHeight)
      if (unlockTimer) clearTimeout(unlockTimer)
      unlockTimer = setTimeout(() => { lock = null }, 60)
    }
    let onTa: (() => void) | null = null
    let onPv: (() => void) | null = null
    const attach = (attempt: number) => {
      if (dead) return
      ta = editorTa(); pv = previewEl()
      if (!ta || !pv) { if (attempt < 10) timer = setTimeout(() => attach(attempt + 1), 50); return }
      onTa = follow(ta, pv); onPv = follow(pv, ta)
      ta.addEventListener('scroll', onTa, { passive: true })
      pv.addEventListener('scroll', onPv, { passive: true })
    }
    attach(0)
    return () => {
      dead = true
      if (timer) clearTimeout(timer)
      if (unlockTimer) clearTimeout(unlockTimer)
      if (ta && onTa) ta.removeEventListener('scroll', onTa)
      if (pv && onPv) pv.removeEventListener('scroll', onPv)
    }
  }, [viewMode, selectedId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return
      // Ctrl+Shift+E: 編集 ⇔ プレビュー（Ctrl+E はエディタのインラインコードと衝突するため Shift 付き）
      if (e.shiftKey) {
        if (e.key.toLowerCase() === 'e' && selectedNoteRef.current) {
          e.preventDefault()
          switchMode(viewModeRef.current === 'edit' ? 'preview' : 'edit')
        }
        return
      }
      const k = e.key.toLowerCase()
      if ((k === 'f' || k === 'h') && selectedNoteRef.current) {
        e.preventDefault()
        setFindOpen(true)
        if (k === 'h') setShowRepl(true)
        const ta = editorTa()
        if (ta && ta.selectionEnd > ta.selectionStart) setFindQ(ta.value.slice(ta.selectionStart, ta.selectionEnd))
        setTimeout(() => findInputRef.current?.select(), 0)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ── アウトライン（見出しの目次） ──
  const [outlineOpen, setOutlineOpen] = useState<boolean>(() => {
    try { return localStorage.getItem('constella.notes.outline') === '1' } catch { return false }
  })
  useEffect(() => { try { localStorage.setItem('constella.notes.outline', outlineOpen ? '1' : '0') } catch { /* ignore */ } }, [outlineOpen])
  const outline = useMemo(() => {
    // パネルが閉じているときは走査しない（大きいノートのキー入力ホットパス）
    if (!outlineOpen || !selectedNote) return [] as { level: number; text: string; line: number }[]
    const out: { level: number; text: string; line: number }[] = []
    let fence: FenceState | null = null
    selectedNote.content.split('\n').forEach((l, i) => {
      const next = updateFence(fence, l)
      if (fence === null && next === fence) {
        const m = /^(#{1,6})\s+(.+)/.exec(l)
        if (m) out.push({ level: m[1].length, text: m[2].replace(/\s#+\s*$/, '').trim(), line: i })
      }
      fence = next
    })
    return out
  }, [outlineOpen, selectedNote])

  const jumpToHeading = (h: { text: string; line: number }, idx: number) => {
    const prev = document.querySelector('.typol-preview')
    if (prev) {
      const els = [...prev.querySelectorAll('h1,h2,h3,h4,h5,h6')]
      // 同名見出しが複数ある場合に備え、n番目の同名を選ぶ（テキスト一致優先、崩れたら index）
      const nth = outline.slice(0, idx).filter(o => o.text === h.text).length
      const sameText = els.filter(x => (x.textContent || '').trim() === h.text)
      const el = sameText[nth] ?? sameText[0] ?? els[idx]
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
    const ta = editorTa()
    const content = selectedNoteRef.current?.content
    if (ta && content != null) {
      const lines = content.split('\n')
      let pos = 0
      for (let i = 0; i < h.line && i < lines.length; i++) pos += lines[i].length + 1
      ta.setSelectionRange(pos, pos + (lines[h.line]?.length ?? 0))
      const lh = parseFloat(getComputedStyle(ta).lineHeight) || 22
      ta.scrollTop = Math.max(0, h.line * lh - 40)
    }
  }

  // ── バックリンク: このノートを [[タイトル]] で言及するノート/カード + 参照カード ──
  // 全ノート+全カードの全文走査になるため、タイピングの緊急レンダーを塞がないよう
  // 遅延値で評価する（deps は選択ノートの id/title だけ — 本文編集では再計算しない）。
  const deferredNotes = useDeferredValue(state.notes)
  const deferredCards = useDeferredValue(state.canvasCards)
  const selTitle = (selectedNote?.title || '').trim().toLowerCase()
  const backlinks = useMemo(() => {
    if (!selectedId) return { notes: [] as Note[], cards: [] as CanvasCard[] }
    const mentions = (content?: string) =>
      !!selTitle && !!content && [...content.matchAll(/\[\[([^[\]\n]+)\]\]/g)].some(m => m[1].trim().toLowerCase() === selTitle)
    // テキスト/メモ系カードは複数ページ制: 本文は card.content ではなく pages[].content 側に
    // あることが多いので、両方を言及判定の対象にする。
    const cardMentions = (c: CanvasCard) =>
      mentions(c.content) || (c.pages ?? []).some(p => mentions(p.content))
    return {
      notes: deferredNotes.filter(n => n.id !== selectedId && !n.archivedAt && mentions(n.content)),
      cards: deferredCards.filter(c => c.refNoteId === selectedId || cardMentions(c)),
    }
  }, [selectedId, selTitle, deferredNotes, deferredCards])

  // スライド配列の identity を安定させる（毎レンダー生成すると SlideShow が現在スライドを再パースする）
  const slideshowSlides = useMemo(
    () => (slideshowOpen && selectedNote ? splitSlides(selectedNote.content) : []),
    [slideshowOpen, selectedNote]
  )

  async function deleteNote(id: string) {
    const title = state.notes.find(n => n.id === id)?.title
    if (!(await confirmDialog(`ノート「${title || '(無題)'}」を完全に削除しますか？`))) return
    dispatch({ type: 'DELETE_NOTE', payload: id })
    if (selectedId === id) {
      setSelectedId(notes.find(n => n.id !== id)?.id ?? null)
    }
  }

  function togglePin(n: Note) {
    dispatch({ type: 'UPDATE_NOTE', payload: { ...n, pinned: !n.pinned, updatedAt: new Date().toISOString() } })
  }

  function toggleArchive(n: Note) {
    const next = n.archivedAt ? undefined : new Date().toISOString()
    dispatch({ type: 'UPDATE_NOTE', payload: { ...n, archivedAt: next, updatedAt: new Date().toISOString() } })
    if (selectedId === n.id) setSelectedId(null)
  }

  // ── cross-project sharing ──
  // Mark/unmark a note as a shareable master. (No updatedAt bump — sharing is
  // metadata, not a content edit, so it doesn't reorder the updated-sort list.)
  function toggleShared(n: Note) {
    dispatch({ type: 'UPDATE_NOTE', payload: { ...n, shared: !n.shared } })
  }
  // Add / remove the active project as a referrer of a foreign shared note.
  function addReference(n: Note) {
    const refs = n.refByMasterIds ?? []
    if (refs.includes(active)) return
    dispatch({ type: 'UPDATE_NOTE', payload: { ...n, refByMasterIds: [...refs, active] } })
  }
  function removeReference(n: Note) {
    const refs = (n.refByMasterIds ?? []).filter(id => id !== active)
    dispatch({ type: 'UPDATE_NOTE', payload: { ...n, refByMasterIds: refs.length > 0 ? refs : undefined } })
    if (selectedId === n.id) setSelectedId(notes[0]?.id ?? null)
  }
  // Foreign shared notes not yet referenced here — offered in the "参照を追加" picker.
  const addableSharedNotes = useMemo(
    () => state.notes.filter(n => n.masterProjectId !== active && n.shared && !n.archivedAt && !(n.refByMasterIds ?? []).includes(active))
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')),
    [state.notes, active]
  )

  function exportMarkdown(n: Note) {
    const front = [
      '---',
      `title: ${n.title || '(無題)'}`,
      `created: ${n.createdAt}`,
      `updated: ${n.updatedAt}`,
      n.tags.length ? `tags: [${n.tags.map(t => JSON.stringify(t)).join(', ')}]` : '',
      '---',
      '',
      '# ' + (n.title || '(無題)'),
      '',
      n.content || '',
    ].filter(l => l !== '').join('\n')
    const blob = new Blob([front], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${(n.title || 'untitled').replace(/[\\/:*?"<>|]/g, '_')}.md`
    document.body.appendChild(a); a.click(); a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  function toggleFolder(id: string) {
    setOpenFolders(prev => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next })
  }

  function addFolder(parentId?: string) {
    if (!active) return
    const id = generateId()
    const folder: NoteFolder = {
      id, masterProjectId: active, name: '新しいフォルダ', createdAt: new Date().toISOString(), parentId,
    }
    dispatch({ type: 'ADD_NOTE_FOLDER', payload: folder })
    setOpenFolders(prev => { const n = new Set(prev); n.add(id); if (parentId) n.add(parentId); return n })
    setEditingFolderId(id); setFolderNameDraft(folder.name)
  }

  function commitFolderRename(f: NoteFolder) {
    const name = folderNameDraft.trim()
    if (name && name !== f.name) dispatch({ type: 'UPDATE_NOTE_FOLDER', payload: { ...f, name } })
    setEditingFolderId(null); setFolderNameDraft('')
  }

  async function deleteFolder(f: NoteFolder) {
    const count = (notesByFolder.get(f.id) ?? []).length
    const msg = count > 0
      ? `フォルダ「${f.name}」を削除しますか？\n中の ${count} 件は未分類になります。`
      : `フォルダ「${f.name}」を削除しますか？`
    if (!(await confirmDialog(msg))) return
    dispatch({ type: 'DELETE_NOTE_FOLDER', payload: f.id })
    setOpenFolders(prev => { const n = new Set(prev); n.delete(f.id); return n })
  }

  // Cycle check: returns true if `target` is a descendant of `source`.
  function isDescendantOf(target: string, source: string): boolean {
    const stack = [source]
    while (stack.length) {
      const id = stack.pop() as string
      const kids = childrenByParent.get(id) ?? []
      for (const k of kids) { if (k.id === target) return true; stack.push(k.id) }
    }
    return false
  }

  function handleNoteDragStart(n: Note, e: React.DragEvent) {
    draggingRef.current = { kind: 'note', id: n.id }
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', n.title || '(無題)')
  }
  function handleFolderDragStart(f: NoteFolder, e: React.DragEvent) {
    draggingRef.current = { kind: 'folder', id: f.id }
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', f.name)
  }
  function handleFolderDragOver(targetId: string, e: React.DragEvent) {
    const drag = draggingRef.current
    if (!drag) return
    if (drag.kind === 'folder' && (drag.id === targetId || isDescendantOf(targetId, drag.id))) return
    e.preventDefault(); e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    if (dragOverFolderId !== targetId) setDragOverFolderId(targetId)
    if (dragOverRoot) setDragOverRoot(false)
  }
  function handleFolderDrop(targetId: string, e: React.DragEvent) {
    e.preventDefault(); e.stopPropagation()
    const drag = draggingRef.current
    draggingRef.current = null
    setDragOverFolderId(null)
    if (!drag) return
    if (drag.kind === 'note') {
      const n = notes.find(x => x.id === drag.id)
      if (n && n.folderId !== targetId) {
        dispatch({ type: 'UPDATE_NOTE', payload: { ...n, folderId: targetId, updatedAt: new Date().toISOString() } })
      }
      setOpenFolders(prev => { const x = new Set(prev); x.add(targetId); return x })
    } else {
      if (drag.id === targetId || isDescendantOf(targetId, drag.id)) return
      const f = folders.find(x => x.id === drag.id)
      if (f && f.parentId !== targetId) dispatch({ type: 'UPDATE_NOTE_FOLDER', payload: { ...f, parentId: targetId } })
      setOpenFolders(prev => { const x = new Set(prev); x.add(targetId); return x })
    }
  }
  function handleRootDragOver(e: React.DragEvent) {
    if (!draggingRef.current) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (!dragOverRoot) setDragOverRoot(true)
    if (dragOverFolderId) setDragOverFolderId(null)
  }
  function handleRootDrop(e: React.DragEvent) {
    e.preventDefault()
    const drag = draggingRef.current
    draggingRef.current = null
    setDragOverRoot(false)
    if (!drag) return
    if (drag.kind === 'note') {
      const n = notes.find(x => x.id === drag.id)
      if (n && n.folderId !== undefined) {
        dispatch({ type: 'UPDATE_NOTE', payload: { ...n, folderId: undefined, updatedAt: new Date().toISOString() } })
      }
    } else {
      const f = folders.find(x => x.id === drag.id)
      if (f && f.parentId !== undefined) dispatch({ type: 'UPDATE_NOTE_FOLDER', payload: { ...f, parentId: undefined } })
    }
  }
  function handleDragEnd() {
    draggingRef.current = null
    setDragOverFolderId(null)
    setDragOverRoot(false)
  }

  function renderFolderNode(folder: NoteFolder, depth: number) {
    const folderNotes = notesByFolder.get(folder.id) ?? []
    const childFolders = childrenByParent.get(folder.id) ?? []
    const isOpen = openFolders.has(folder.id)
    const isEditing = editingFolderId === folder.id
    const isDropTarget = dragOverFolderId === folder.id
    const cls = folder.color ? BOARD_COLOR_CLASSES[folder.color] : null
    return (
      <div key={folder.id}>
        <div
          draggable={!isEditing}
          onDragStart={e => { if (!isEditing) handleFolderDragStart(folder, e) }}
          onDragEnd={handleDragEnd}
          onDragOver={e => handleFolderDragOver(folder.id, e)}
          onDragLeave={() => { if (dragOverFolderId === folder.id) setDragOverFolderId(null) }}
          onDrop={e => handleFolderDrop(folder.id, e)}
          className={`group relative flex items-center gap-1 px-2 py-1.5 rounded-md transition-colors ${
            isDropTarget ? 'bg-emerald-100/70 ring-2 ring-emerald-400 ring-inset' : (cls?.bgSoft ?? 'hover:bg-slate-100')
          }`}
          style={{ paddingLeft: 8 + depth * 12 }}
        >
          {cls && <span className={`absolute left-0 top-1 bottom-1 w-[3px] rounded-r-sm ${cls.stripe}`} />}
          <button
            onClick={() => toggleFolder(folder.id)}
            className="p-0.5 rounded hover:bg-slate-200 text-slate-500 shrink-0"
            title={isOpen ? '畳む' : '開く'}
          >{isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>
          <Folder size={13} className={`shrink-0 ${cls?.text ?? 'text-amber-500'}`} />
          {isEditing ? (
            <input
              autoFocus
              value={folderNameDraft}
              onChange={e => setFolderNameDraft(e.target.value)}
              onBlur={() => commitFolderRename(folder)}
              onKeyDown={e => {
                if (e.nativeEvent.isComposing || (e as unknown as { keyCode: number }).keyCode === 229) return
                if (e.key === 'Enter') { e.preventDefault(); commitFolderRename(folder) }
                if (e.key === 'Escape') { setEditingFolderId(null); setFolderNameDraft('') }
              }}
              className="flex-1 min-w-0 px-1 py-0.5 text-sm border border-slate-300 rounded outline-none focus:border-amber-400"
            />
          ) : (
            <button
              onClick={() => { setEditingFolderId(folder.id); setFolderNameDraft(folder.name) }}
              title="クリックで名前を編集"
              className="flex-1 min-w-0 truncate text-sm text-slate-700 text-left"
            >{folder.name}</button>
          )}
          <span className="text-[10px] text-slate-400 shrink-0">{folderNotes.length}</span>
          <FolderColorSwatch
            value={folder.color}
            onChange={next => dispatch({ type: 'UPDATE_NOTE_FOLDER', payload: { ...folder, color: next } })}
            className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
          />
          <button
            onClick={e => { e.stopPropagation(); addFolder(folder.id) }}
            title="サブフォルダを追加"
            className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-slate-200 text-slate-400 hover:text-amber-600 transition-all shrink-0"
          ><FolderPlus size={11} /></button>
          <button
            onClick={e => { e.stopPropagation(); deleteFolder(folder) }}
            title="フォルダを削除"
            className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-slate-200 text-slate-400 hover:text-rose-500 transition-all shrink-0"
          ><Trash2 size={11} /></button>
        </div>
        {isOpen && (
          <div className="space-y-1">
            {childFolders.map(c => renderFolderNode(c, depth + 1))}
            {folderNotes.map(n => (
              <div key={n.id} style={{ paddingLeft: (depth + 1) * 12 }}>
                <NoteRow
                  note={n}
                  active={selectedId === n.id}
                  onSelect={() => selectNote(n.id)}
                  onDragStart={e => handleNoteDragStart(n, e)}
                  onDragEnd={handleDragEnd}
                />
              </div>
            ))}
            {folderNotes.length === 0 && childFolders.length === 0 && (
              <p className="text-[10px] text-slate-400 px-2 py-1 italic" style={{ paddingLeft: 8 + (depth + 1) * 12 }}>（空）</p>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="flex h-full">
      {/* Note list */}
      <div className="w-72 border-r border-slate-200 flex flex-col">
        <div className="h-14 flex items-center justify-between px-4 border-b border-slate-200">
          <h2 className="text-sm font-semibold text-slate-700">ノート {showArchived && <span className="text-[10px] text-slate-400 ml-1">(アーカイブ)</span>}</h2>
          <div className="flex items-center gap-1">
            <button
              onClick={createNote}
              title="ノートを追加"
              className="p-1.5 rounded hover:bg-slate-100 text-slate-500 hover:text-amber-600 transition-colors"
            >
              <Plus size={16} />
            </button>
            <button
              onClick={() => addFolder()}
              title="フォルダを追加"
              className="p-1.5 rounded hover:bg-slate-100 text-slate-500 hover:text-amber-600 transition-colors"
            >
              <FolderPlus size={16} />
            </button>
            <details className="relative">
              <summary className="list-none cursor-pointer p-1.5 rounded-md hover:bg-slate-100 text-slate-500 hover:text-indigo-600 transition-colors" title="他プロジェクトの共有ノートを参照に追加">
                <Share2 size={16} />
              </summary>
              <div className="absolute right-0 top-9 z-30 w-[280px] bg-white border border-slate-200 rounded-lg shadow-xl p-2" onClick={e => e.stopPropagation()}>
                <p className="text-[10px] text-slate-400 px-1 pb-1">他プロジェクトの共有ノートを参照</p>
                {addableSharedNotes.length === 0 ? (
                  <div className="text-[10px] text-slate-400 px-1 py-3 text-center">参照できる共有ノートがありません<br />（ノートを「共有」にすると他プロジェクトから参照できます）</div>
                ) : (
                  <div className="max-h-[260px] overflow-y-auto">
                    {addableSharedNotes.map(n => (
                      <button
                        key={n.id}
                        onClick={() => addReference(n)}
                        className="w-full text-left px-1.5 py-1 hover:bg-indigo-50 rounded text-xs flex items-center gap-1.5"
                      >
                        <Share2 size={11} className="text-indigo-400 shrink-0" />
                        <span className="truncate flex-1">{n.title || '(無題)'}</span>
                        <span className="text-[9px] text-slate-400 shrink-0 max-w-[90px] truncate">{masterName(n.masterProjectId)}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </details>
          </div>
        </div>
        {/* Search + sort + archive toggle row */}
        <div className="px-3 py-2 border-b border-slate-200 space-y-1.5">
          <SearchInput
            value={search}
            onChange={setSearch}
            historyKey="constella.notes.search"
            placeholder="検索 (タイトル/本文/タグ)"
          />
          <div className="flex items-center gap-1 text-[10px] text-slate-500">
            <ArrowDownAZ size={11} className="shrink-0" />
            <select
              value={sortMode}
              onChange={e => setSortMode(e.target.value as 'updated' | 'created' | 'title')}
              className="bg-transparent border-none outline-none text-[10px] text-slate-600 cursor-pointer flex-1"
            >
              <option value="updated">更新順</option>
              <option value="created">作成順</option>
              <option value="title">タイトル順</option>
            </select>
            <button
              onClick={() => setShowArchived(v => !v)}
              title={showArchived ? '通常のノートを表示' : 'アーカイブを表示'}
              className={`p-1 rounded transition-colors ${showArchived ? 'bg-amber-500/15 text-amber-700' : 'text-slate-500 hover:bg-slate-100'}`}
            >
              <Archive size={11} />
            </button>
          </div>
        </div>
        <div
          onDragOver={handleRootDragOver}
          onDrop={handleRootDrop}
          onDragLeave={e => { if (e.currentTarget === e.target) setDragOverRoot(false) }}
          className={`flex-1 overflow-y-auto py-2 px-2 space-y-1 transition-colors ${dragOverRoot ? 'bg-amber-50/50' : ''}`}
        >
          {!showArchived && referencedNotes.length > 0 && (
            <>
              <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-indigo-400 flex items-center gap-1"><Share2 size={10} /> 参照（他プロジェクト）</div>
              {referencedNotes.map(note => (
                <NoteRow
                  key={note.id}
                  note={note}
                  active={selectedId === note.id}
                  onSelect={() => selectNote(note.id)}
                  badge={masterName(note.masterProjectId)}
                />
              ))}
            </>
          )}
          {unfiledNotes.length > 0 && (
            <>
              <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-slate-400">未分類</div>
              {unfiledNotes.map(note => (
                <NoteRow
                  key={note.id}
                  note={note}
                  active={selectedId === note.id}
                  onSelect={() => selectNote(note.id)}
                  onDragStart={e => handleNoteDragStart(note, e)}
                  onDragEnd={handleDragEnd}
                />
              ))}
            </>
          )}
          {rootFolders.map(f => renderFolderNode(f, 0))}
          {notes.length === 0 && folders.length === 0 && (
            <div className="px-3 py-4 text-center">
              <p className="text-xs text-slate-400">
                「＋」でノートやフォルダを追加
              </p>
              {state.notes.some(n => n.masterProjectId !== active) && (
                <p className="text-[10px] text-slate-400 mt-1">他のプロジェクトにはノートがあります — 左上のプロジェクト切替から移動できます</p>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Note editor */}
      <div className="flex-1 flex flex-col">
        {selectedNote ? (
          <>
            <div className="h-14 flex items-center justify-between px-6 border-b border-slate-200">
              <input
                type="text"
                value={selectedNote.title}
                onChange={e => updateNote({ title: e.target.value })}
                className="text-lg font-semibold bg-transparent border-none outline-none text-slate-900 flex-1"
                placeholder="タイトル"
              />
              {isReference && (
                <span className="mr-1 shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-indigo-50 border border-indigo-200 text-indigo-600 text-[10px]" title={`共有ノートの参照（元: ${masterName(selectedNote.masterProjectId)}）。編集は元ノートに反映されます。`}>
                  <Share2 size={11} /> 参照 · {masterName(selectedNote.masterProjectId)}
                </span>
              )}
              <div className="flex items-center rounded-md border border-slate-200 overflow-hidden text-sm">
                {([['edit', '編集', Pencil], ['split', '分割', Columns2], ['preview', 'プレビュー', Eye]] as const).map(([mode, label, Icon]) => (
                  <button
                    key={mode}
                    onClick={() => switchMode(mode)}
                    title={mode === 'split' ? label : `${label} (Ctrl+Shift+E で切替)`}
                    className={`flex items-center gap-1 px-2.5 py-1 transition-colors ${viewMode === mode ? 'bg-amber-500/15 text-amber-600' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800'}`}
                  >
                    <Icon size={15} /> {label}
                  </button>
                ))}
              </div>
              {/* Font size adjuster — applies to editor + preview via CSS vars. */}
              <div className="ml-1 flex items-center rounded-md border border-slate-200 overflow-hidden text-xs">
                <button
                  onClick={() => setFontScale(s => Math.max(0.75, Math.round((s - 0.1) * 100) / 100))}
                  title="文字を小さく"
                  className="p-1 text-slate-500 hover:bg-slate-100"
                ><Minus size={13} /></button>
                <button
                  onClick={() => setFontScale(1)}
                  title={`現在 ${Math.round(fontScale * 100)}% — クリックで100%に戻す`}
                  className="px-1.5 text-[10px] text-slate-600 hover:bg-slate-100 min-w-[42px] flex items-center justify-center gap-1"
                >
                  <Type size={11} /> {Math.round(fontScale * 100)}%
                </button>
                <button
                  onClick={() => setFontScale(s => Math.min(2.0, Math.round((s + 0.1) * 100) / 100))}
                  title="文字を大きく"
                  className="p-1 text-slate-500 hover:bg-slate-100"
                ><Plus size={13} /></button>
              </div>
              {/* 付随資料パネルの開閉 — 添付があるときは件数バッジを出す */}
              <button
                onClick={() => setAttachOpen(v => !v)}
                title="付随資料（PDF・画像・動画などをこのノートに添付）"
                className={`relative ml-1 p-1.5 rounded-md hover:bg-slate-100 transition-colors ${attachOpen ? 'text-emerald-600' : 'text-slate-500 hover:text-emerald-600'}`}
              >
                <Paperclip size={16} />
                {(selectedNote.attachments?.length ?? 0) > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-0.5 rounded-full bg-emerald-500 text-white text-[9px] leading-[14px] text-center font-semibold">
                    {selectedNote.attachments!.length}
                  </span>
                )}
              </button>
              {isReference ? (
                <>
                  <button
                    onClick={() => exportMarkdown(selectedNote)}
                    title="Markdown(.md) として書き出し"
                    className="ml-1 p-1.5 rounded-md hover:bg-slate-100 text-slate-500 hover:text-amber-600 transition-colors"
                  >
                    <Download size={16} />
                  </button>
                  {canPdf && (
                    <button
                      onClick={() => doExportPdf(selectedNote)}
                      disabled={exportingPdf}
                      title="PDFとして書き出し"
                      className="p-1.5 rounded-md hover:bg-slate-100 text-slate-500 hover:text-rose-600 transition-colors disabled:opacity-40"
                    >
                      {exportingPdf ? <Loader2 size={16} className="animate-spin" /> : <FileDown size={16} />}
                    </button>
                  )}
                  <button
                    onClick={() => setSlideshowOpen(true)}
                    title="スライドショー（--- の行でスライドに分割）"
                    className="p-1.5 rounded-md hover:bg-slate-100 text-slate-500 hover:text-indigo-600 transition-colors"
                  >
                    <Presentation size={16} />
                  </button>
                  <button
                    onClick={() => setOutlineOpen(v => !v)}
                    title="アウトライン（見出しの目次）"
                    className={`p-1.5 rounded-md hover:bg-slate-100 transition-colors ${outlineOpen ? 'text-indigo-600' : 'text-slate-500 hover:text-indigo-600'}`}
                  >
                    <ListTree size={16} />
                  </button>
                  <button
                    onClick={() => removeReference(selectedNote)}
                    title="この参照を解除（元ノートは削除されません）"
                    className="p-1.5 rounded-md hover:bg-slate-100 text-slate-500 hover:text-rose-500 transition-colors"
                  >
                    <Unlink size={16} />
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => toggleShared(selectedNote)}
                    title={selectedNote.shared ? '共有を解除（他プロジェクトの参照は非表示になります）' : '共有 — 他プロジェクトから参照できるマスターにする'}
                    className={`ml-1 p-1.5 rounded-md hover:bg-slate-100 transition-colors ${selectedNote.shared ? 'text-indigo-600' : 'text-slate-500 hover:text-indigo-600'}`}
                  >
                    <Share2 size={16} />
                  </button>
                  <button
                    onClick={() => togglePin(selectedNote)}
                    title={selectedNote.pinned ? 'ピンを外す' : 'ピン留め'}
                    className={`p-1.5 rounded-md hover:bg-slate-100 transition-colors ${selectedNote.pinned ? 'text-amber-500' : 'text-slate-500 hover:text-amber-500'}`}
                  >
                    <Star size={16} fill={selectedNote.pinned ? 'currentColor' : 'none'} />
                  </button>
                  <button
                    onClick={() => exportMarkdown(selectedNote)}
                    title="Markdown(.md) として書き出し"
                    className="p-1.5 rounded-md hover:bg-slate-100 text-slate-500 hover:text-amber-600 transition-colors"
                  >
                    <Download size={16} />
                  </button>
                  {canPdf && (
                    <button
                      onClick={() => doExportPdf(selectedNote)}
                      disabled={exportingPdf}
                      title="PDFとして書き出し"
                      className="p-1.5 rounded-md hover:bg-slate-100 text-slate-500 hover:text-rose-600 transition-colors disabled:opacity-40"
                    >
                      {exportingPdf ? <Loader2 size={16} className="animate-spin" /> : <FileDown size={16} />}
                    </button>
                  )}
                  <button
                    onClick={() => setSlideshowOpen(true)}
                    title="スライドショー（--- の行でスライドに分割）"
                    className="p-1.5 rounded-md hover:bg-slate-100 text-slate-500 hover:text-indigo-600 transition-colors"
                  >
                    <Presentation size={16} />
                  </button>
                  <button
                    onClick={() => setOutlineOpen(v => !v)}
                    title="アウトライン（見出しの目次）"
                    className={`p-1.5 rounded-md hover:bg-slate-100 transition-colors ${outlineOpen ? 'text-indigo-600' : 'text-slate-500 hover:text-indigo-600'}`}
                  >
                    <ListTree size={16} />
                  </button>
                  <button
                    onClick={() => toggleArchive(selectedNote)}
                    title={selectedNote.archivedAt ? 'アーカイブから戻す' : 'アーカイブする'}
                    className="p-1.5 rounded-md hover:bg-slate-100 text-slate-500 hover:text-amber-600 transition-colors"
                  >
                    {selectedNote.archivedAt ? <ArchiveRestore size={16} /> : <Archive size={16} />}
                  </button>
                  <button
                    onClick={() => deleteNote(selectedNote.id)}
                    title="完全削除"
                    className="p-1.5 rounded-md hover:bg-slate-100 text-slate-500 hover:text-rose-500 transition-colors"
                  >
                    <Trash2 size={16} />
                  </button>
                </>
              )}
            </div>
            <div className="px-6 py-2 border-b border-slate-200 flex items-center gap-2">
              <Tag size={14} className="text-slate-500" />
              <div className="flex gap-1 flex-wrap items-center">
                {selectedNote.tags.map(tag => (
                  <span
                    key={tag}
                    className="text-xs px-2 py-0.5 rounded-full bg-amber-400/10 text-amber-600 cursor-pointer hover:bg-amber-400/20"
                    onClick={() => updateNote({ tags: selectedNote.tags.filter(t => t !== tag) })}
                  >
                    {tag} &times;
                  </span>
                ))}
                <input
                  type="text"
                  placeholder="タグを追加…"
                  className="text-xs bg-transparent border-none outline-none text-slate-500 w-24"
                  onKeyDown={e => {
                    if (e.key === 'Enter' && e.currentTarget.value.trim()) {
                      const newTag = e.currentTarget.value.trim()
                      if (!selectedNote.tags.includes(newTag)) {
                        updateNote({ tags: [...selectedNote.tags, newTag] })
                      }
                      e.currentTarget.value = ''
                    }
                  }}
                />
              </div>
            </div>
            {/* 付随資料 — 先方資料/自分の資料などのファイルをこのノートに添付して管理。
                実体はファイルライブラリ (FileItem)、ここは参照リンクの管理。 */}
            {attachOpen && <NoteAttachments note={selectedNote} />}
            {/* Reverse links: tasks that point to this note. Click jumps into the Projects page with
                the task pre-selected (the NotePanel there will re-surface this very note). */}
            {linkedTasks.length > 0 && (
              <div className="px-6 py-2 border-b border-slate-200 flex items-center gap-2 flex-wrap">
                <FolderKanban size={14} className="text-slate-500 shrink-0" />
                <span className="text-[11px] text-slate-500 shrink-0">関連タスク {linkedTasks.length}件</span>
                {linkedTasks.map(({ task, board, boardIdx }) => {
                  const color = boardColorFor(board, boardIdx)
                  const cls = BOARD_COLOR_CLASSES[color]
                  return (
                    <button
                      key={`${board.id}/${task.id}`}
                      onClick={() => navigate(`/projects?taskId=${task.id}`)}
                      title={`${board.name} のタスク「${task.title || '(無題)'}」を開く`}
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] border ${cls.border} ${cls.text} ${cls.bg} hover:brightness-95 transition-all max-w-[200px]`}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${cls.dot}`} />
                      <span className="truncate">{task.title || '(無題)'}</span>
                      <span className="text-[9px] opacity-60 truncate shrink-0">{board.name}</span>
                    </button>
                  )
                })}
              </div>
            )}
            {(backlinks.notes.length > 0 || backlinks.cards.length > 0) && (
              <div className="px-6 py-2 border-b border-slate-200 flex items-center gap-2 flex-wrap">
                <Link2 size={14} className="text-slate-500 shrink-0" />
                <span className="text-[11px] text-slate-500 shrink-0">バックリンク {backlinks.notes.length + backlinks.cards.length}件</span>
                {backlinks.notes.map(n => (
                  <button
                    key={n.id}
                    onClick={() => setSelectedId(n.id)}
                    title={`ノート「${n.title || '(無題)'}」を開く`}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] border border-amber-200 text-amber-700 bg-amber-50 hover:brightness-95 transition-all max-w-[200px]"
                  >
                    <FileText size={10} className="shrink-0" />
                    <span className="truncate">{n.title || '(無題)'}</span>
                  </button>
                ))}
                {backlinks.cards.map(c => (
                  <button
                    key={c.id}
                    onClick={() => navigate('/canvas', { state: { focusCardId: c.id } })}
                    title={`キャンバスのカード「${c.title || '(無題)'}」へジャンプ`}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] border border-indigo-200 text-indigo-700 bg-indigo-50 hover:brightness-95 transition-all max-w-[200px]"
                  >
                    <StickyNote size={10} className="shrink-0" />
                    <span className="truncate">{c.title || '(無題)'}</span>
                  </button>
                ))}
              </div>
            )}
            {findOpen && (
              <div className="px-6 py-1.5 border-b border-slate-200 bg-slate-50 flex items-center gap-1.5 flex-wrap">
                <Search size={13} className="text-slate-400 shrink-0" />
                <input
                  ref={findInputRef}
                  value={findQ}
                  onChange={e => setFindQ(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') { e.preventDefault(); jumpToMatch(e.shiftKey ? findIdx - 1 : findIdx + 1) }
                    else if (e.key === 'Escape') { e.preventDefault(); closeFind() }
                  }}
                  placeholder="ノート内を検索"
                  className="px-2 py-0.5 text-xs border border-slate-300 rounded w-44 outline-none focus:border-indigo-400 bg-white"
                />
                <span className="text-[11px] text-slate-500 tabular-nums min-w-[52px]">
                  {findMatches.length ? `${Math.min(findIdx + 1, findMatches.length)} / ${findMatches.length}` : findQ ? '0 件' : ''}
                </span>
                <button onClick={() => jumpToMatch(findIdx - 1)} disabled={!findMatches.length} title="前へ (Shift+Enter)" className="p-1 rounded hover:bg-slate-200 text-slate-500 disabled:opacity-30"><ChevronUp size={13} /></button>
                <button onClick={() => jumpToMatch(findIdx + 1)} disabled={!findMatches.length} title="次へ (Enter)" className="p-1 rounded hover:bg-slate-200 text-slate-500 disabled:opacity-30"><ChevronDown size={13} /></button>
                <button onClick={() => setShowRepl(v => !v)} className={`px-1.5 py-0.5 rounded text-[11px] ${showRepl ? 'bg-indigo-100 text-indigo-700' : 'text-slate-500 hover:bg-slate-200'}`}>置換</button>
                {showRepl && (
                  <>
                    <input
                      value={replQ}
                      onChange={e => setReplQ(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); closeFind() } }}
                      placeholder="置換後のテキスト"
                      className="px-2 py-0.5 text-xs border border-slate-300 rounded w-44 outline-none focus:border-indigo-400 bg-white"
                    />
                    <button onClick={replaceCurrent} disabled={!findMatches.length} className="px-1.5 py-0.5 rounded text-[11px] text-slate-600 hover:bg-slate-200 disabled:opacity-30">1件置換</button>
                    <button onClick={replaceAll} disabled={!findMatches.length} className="px-1.5 py-0.5 rounded text-[11px] text-slate-600 hover:bg-slate-200 disabled:opacity-30">すべて置換</button>
                  </>
                )}
                <button onClick={closeFind} title="閉じる (Esc)" className="ml-auto p-1 rounded hover:bg-slate-200 text-slate-500"><X size={13} /></button>
              </div>
            )}
            <div className="flex-1 flex min-h-0">
              {outlineOpen && (
                <aside className="w-52 shrink-0 border-r border-slate-200 overflow-y-auto py-2 px-1.5 bg-slate-50/50">
                  <div className="px-2 pb-1 text-[10px] font-medium text-slate-400">アウトライン</div>
                  {outline.length === 0 && <div className="px-2 text-[11px] text-slate-400">見出しがありません</div>}
                  {outline.map((h, i) => (
                    <button
                      key={`${h.line}-${i}`}
                      onClick={() => jumpToHeading(h, i)}
                      title={h.text}
                      className="w-full text-left py-1 pr-2 rounded text-[12px] text-slate-600 hover:bg-slate-100 hover:text-slate-900 truncate block"
                      style={{ paddingLeft: 8 + (h.level - 1) * 12 }}
                    >
                      {h.text}
                    </button>
                  ))}
                </aside>
              )}
              <div className="flex-1 flex flex-col min-h-0 min-w-0">
                {viewMode === 'split' ? (
                  <div className="flex-1 flex min-h-0 overflow-hidden" style={fontVars}>
                    <MarkdownText
                      key={selectedNote.id + '-edit'}
                      value={selectedNote.content}
                      onChange={v => updateNote({ content: v })}
                      editing={true}
                      extraClass="flex-1 min-h-0 px-6 py-4 border-r border-slate-200"
                      placeholder="ここにメモを書く…（マークダウン対応）"
                    />
                    <MarkdownText
                      key={selectedNote.id + '-preview'}
                      value={selectedNote.content}
                      onChange={v => updateNote({ content: v })}
                      editing={false}
                      extraClass="flex-1 min-h-0 px-6 py-4"
                      placeholder="プレビュー"
                    />
                  </div>
                ) : (
                  <div className="flex-1 flex flex-col min-h-0" style={fontVars}>
                    <MarkdownText
                      key={selectedNote.id}
                      value={selectedNote.content}
                      onChange={v => updateNote({ content: v })}
                      editing={viewMode === 'edit'}
                      extraClass="flex-1 min-h-0 px-6 py-4"
                      placeholder="ここにメモを書く…（マークダウン対応）"
                    />
                  </div>
                )}
              </div>
              {/* Minimap follows the editor (edit/split) or the preview (preview mode). */}
              <NoteMinimap
                content={selectedNote.content}
                scrollerKey={`${selectedNote.id}:${viewMode}`}
                getScroller={viewMode === 'preview' ? previewEl : editorTa}
              />
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-slate-400">
            <p>ノートを選択するか、新しく作成してください</p>
          </div>
        )}
      </div>
      {slideshowOpen && selectedNote && (
        <SlideShow
          slides={slideshowSlides}
          onClose={() => setSlideshowOpen(false)}
          onExportPdf={canPdf ? () => doExportSlidesPdf(selectedNote) : undefined}
        />
      )}
    </div>
  )
}

// Sidebar row for a single note. Draggable for both intra-Notes folder D&D and
// the existing cross-page "drop into Canvas to link as card" flow (set both payloads).
function NoteRow({ note, active, onSelect, onDragStart, onDragEnd, badge }: {
  note: Note
  active: boolean
  onSelect: () => void
  onDragStart?: (e: React.DragEvent) => void
  onDragEnd?: (e: React.DragEvent) => void
  badge?: string // when set (referenced foreign note), shows the source project name
}) {
  return (
    <div
      onClick={onSelect}
      draggable
      onDragStart={e => {
        // Cross-page Canvas-link payload (preserves the old behaviour).
        e.dataTransfer.setData('application/x-constella-ref', JSON.stringify({ kind: 'note', id: note.id }))
        // Intra-Notes folder D&D — only for own notes (foreign references have no onDragStart).
        onDragStart?.(e)
      }}
      onDragEnd={onDragEnd}
      className={`w-full text-left px-3 py-2.5 rounded-lg cursor-pointer transition-all
        ${active
          ? 'bg-slate-100 border border-slate-300'
          : 'hover:bg-slate-100 border border-transparent'
        }`}
    >
      <p className="text-sm font-medium text-slate-800 truncate flex items-center gap-1">
        {note.pinned && <Star size={10} className="text-amber-500 shrink-0" fill="currentColor" />}
        {badge && <Share2 size={10} className="text-indigo-400 shrink-0" />}
        <span className="truncate">{note.title || '(無題)'}</span>
        {(note.attachments?.length ?? 0) > 0 && (
          <span className="inline-flex items-center gap-0.5 shrink-0 text-[9px] text-emerald-600" title={`付随資料 ${note.attachments!.length}件`}>
            <Paperclip size={9} />{note.attachments!.length}
          </span>
        )}
        {badge && <span className="ml-auto shrink-0 text-[9px] text-indigo-400 max-w-[80px] truncate" title={`元: ${badge}`}>{badge}</span>}
      </p>
      <p className="text-xs text-slate-500 mt-1 line-clamp-2">{note.content || '空のノート'}</p>
      {note.tags.length > 0 && (
        <div className="flex gap-1 mt-2 flex-wrap">
          {note.tags.map(tag => (
            <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded bg-amber-400/10 text-amber-600">
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
