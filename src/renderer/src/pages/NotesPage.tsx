import { useState, useEffect, useMemo, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Plus, Trash2, Tag, Pencil, Eye, Columns2, FolderKanban, Folder, FolderPlus, ChevronDown, ChevronRight, Star, Archive, ArchiveRestore, Download, ArrowDownAZ, Minus, Type, Share2, Unlink } from 'lucide-react'
import { useApp } from '../store'
import { Note, NoteFolder } from '../types'
import { generateId } from '../utils'
import { TypolMarkdown as MarkdownText } from '../components/typol/TypolMarkdown'
import { BOARD_COLOR_CLASSES, boardColorFor } from '../utils/boardColor'
import { FolderColorSwatch } from '../components/FolderColorSwatch'
import { SearchInput } from '../components/SearchInput'
import { confirmDialog } from '../components/ConfirmDialog'

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

  const allNotes = useMemo(() => state.notes.filter(n => n.masterProjectId === active), [state.notes, active])
  // Apply archive visibility + search.
  const notes = useMemo(() => {
    const q = search.trim().toLowerCase()
    return allNotes
      .filter(n => showArchived ? !!n.archivedAt : !n.archivedAt)
      .filter(n => !q || (n.title || '').toLowerCase().includes(q) || (n.content || '').toLowerCase().includes(q) || (n.tags || []).some(t => t.toLowerCase().includes(q)))
      .sort((a, b) => {
        // Pinned float to the top regardless of other sort.
        const pa = a.pinned ? 1 : 0, pb = b.pinned ? 1 : 0
        if (pa !== pb) return pb - pa
        if (sortMode === 'title') return (a.title || '').localeCompare(b.title || '')
        if (sortMode === 'created') return b.createdAt.localeCompare(a.createdAt)
        return b.updatedAt.localeCompare(a.updatedAt)
      })
  }, [allNotes, search, sortMode, showArchived])

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
                    onClick={() => setViewMode(mode)}
                    title={label}
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
              {isReference ? (
                <>
                  <button
                    onClick={() => exportMarkdown(selectedNote)}
                    title="Markdown(.md) として書き出し"
                    className="ml-1 p-1.5 rounded-md hover:bg-slate-100 text-slate-500 hover:text-amber-600 transition-colors"
                  >
                    <Download size={16} />
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
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-slate-400">
            <p>ノートを選択するか、新しく作成してください</p>
          </div>
        )}
      </div>
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
