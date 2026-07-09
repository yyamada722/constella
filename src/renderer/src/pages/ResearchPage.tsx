import { useState, useMemo, useEffect, useRef } from 'react'
import { Plus, ExternalLink, Trash2, X, BookmarkPlus, Home, Folder, FolderPlus, ChevronDown, ChevronRight, MoreHorizontal, ArrowLeft, ArrowRight, RotateCw, Loader2, Search, Archive, ArchiveRestore, Download } from 'lucide-react'
import { useApp } from '../store'
import { ResearchItem, ResearchFolder } from '../types'
import { generateId } from '../utils'
import { WebFrame, type WebFrameHandle } from './CanvasPage'
import { BOARD_COLOR_CLASSES } from '../utils/boardColor'
import { FolderColorSwatch } from '../components/FolderColorSwatch'
import { SearchInput } from '../components/SearchInput'
import { confirmDialog } from '../components/ConfirmDialog'

// Default landing page when no bookmark is selected.
const HOME_URL = 'https://www.google.com'

// Reject URL schemes that could execute code inside the embedded webview.
// `javascript:` and `data:` in a bookmark would run in whatever origin the
// webview happens to be on when the link is clicked — treat them as invalid.
const UNSAFE_SCHEME = /^(javascript|data|vbscript):/i

// Normalize URLs for equality checks so harmless server redirects
// (root-path trailing slash, hash fragment) don't keep showing "save current page".
function normalizeUrl(u: string): string {
  try {
    if (UNSAFE_SCHEME.test(u.trim())) return ''
    const url = new URL(u)
    if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.slice(0, -1)
    }
    url.hash = ''
    return url.toString()
  } catch {
    return u
  }
}

export default function ResearchPage() {
  const { state, dispatch } = useApp()
  const active = state.activeMasterProjectId
  const [search, setSearch] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const allItems = useMemo(() => state.research.filter(r => r.masterProjectId === active), [state.research, active])
  const items = useMemo(() => {
    const q = search.trim().toLowerCase()
    return allItems
      .filter(r => showArchived ? !!r.archivedAt : !r.archivedAt)
      .filter(r => !q || (r.title || '').toLowerCase().includes(q) || (r.url || '').toLowerCase().includes(q) || (r.tags || []).some(t => t.toLowerCase().includes(q)))
  }, [allItems, search, showArchived])
  const folders = useMemo(
    () => state.researchFolders
      .filter(f => f.masterProjectId === active)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [state.researchFolders, active]
  )

  // Build the folder tree: rootFolders + childrenByParent map. Folders with a
  // parentId that no longer exists in scope (e.g. stale data) are promoted to root.
  const { rootFolders, childrenByParent } = useMemo(() => {
    const folderIds = new Set(folders.map(f => f.id))
    const childrenByParent = new Map<string, ResearchFolder[]>()
    const rootFolders: ResearchFolder[] = []
    for (const f of folders) {
      if (f.parentId && folderIds.has(f.parentId)) {
        const arr = childrenByParent.get(f.parentId) ?? []
        arr.push(f)
        childrenByParent.set(f.parentId, arr)
      } else {
        rootFolders.push(f)
      }
    }
    return { rootFolders, childrenByParent }
  }, [folders])

  // Partition bookmarks into folders + unfiled. Items pointing to a non-existent / cross-project
  // folder fall back to unfiled so nothing ever vanishes.
  const { itemsByFolder, unfiled } = useMemo(() => {
    const map = new Map<string, ResearchItem[]>()
    const folderIds = new Set(folders.map(f => f.id))
    const out: ResearchItem[] = []
    for (const r of items) {
      if (r.folderId && folderIds.has(r.folderId)) {
        const arr = map.get(r.folderId) ?? []
        arr.push(r)
        map.set(r.folderId, arr)
      } else {
        out.push(r)
      }
    }
    return { itemsByFolder: map, unfiled: out }
  }, [items, folders])

  // For the move-to-folder dropdown: flatten the tree into a depth-ordered list
  // (DFS) so the menu shows folders with indentation. Used to pick a target folder.
  const folderFlat = useMemo(() => {
    const out: { folder: ResearchFolder; depth: number }[] = []
    const walk = (parents: ResearchFolder[], depth: number) => {
      for (const f of parents) {
        out.push({ folder: f, depth })
        const kids = childrenByParent.get(f.id)
        if (kids) walk(kids, depth + 1)
      }
    }
    walk(rootFolders, 0)
    return out
  }, [rootFolders, childrenByParent])

  // null = home mode (Google + free-form URL bar). Default to home on mount so users land on Google.
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [openFolders, setOpenFolders] = useState<Set<string>>(() => new Set())
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null)
  const [folderNameDraft, setFolderNameDraft] = useState('')
  const [moveMenuOpen, setMoveMenuOpen] = useState(false)
  // D&D: drop highlight state + ref to the active drag payload (avoids
  // re-renders during dragOver storms).
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null)
  const [dragOverRoot, setDragOverRoot] = useState(false)
  const draggingRef = useRef<{ kind: 'bookmark' | 'folder'; id: string } | null>(null)
  const [titleDraft, setTitleDraft] = useState('')
  const [urlDraft, setUrlDraft] = useState(HOME_URL)
  const [tagDraft, setTagDraft] = useState('')
  const [descDraft, setDescDraft] = useState('')
  // Home-mode webview target — what the embedded browser is currently pointed at when no bookmark is selected.
  const [browseUrl, setBrowseUrl] = useState(HOME_URL)
  // Live URL/title from the embedded webview as the user navigates inside it.
  const [liveUrl, setLiveUrl] = useState<string | null>(null)
  const [liveTitle, setLiveTitle] = useState<string | null>(null)
  // Real-browser feel: URL bar follows webview navigation, but stays put while the user is editing it.
  const urlInputRef = useRef<HTMLInputElement>(null)
  // Imperative handle to the embedded browser for back/forward/reload buttons.
  const webFrameRef = useRef<WebFrameHandle>(null)
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const [isLoading, setIsLoading] = useState(false)

  const selected = useMemo(() => items.find(i => i.id === selectedId) ?? null, [items, selectedId])
  const homeMode = !selected

  // Switching master project drops back to home (Google).
  useEffect(() => { setSelectedId(null) }, [active])

  // Keep drafts in sync with the selected bookmark (or home target if none).
  useEffect(() => {
    if (selected) {
      setTitleDraft(selected.title)
      setUrlDraft(selected.url)
      setDescDraft(selected.description ?? '')
    } else {
      setTitleDraft('')
      setUrlDraft(browseUrl)
      setDescDraft('')
    }
    setTagDraft('')
    setLiveUrl(null); setLiveTitle(null)
    // browseUrl deliberately excluded — see goHome / commitUrl for the home-mode URL flow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId])

  // URL bar follows webview navigation — but only when the user isn't actively editing it.
  // Mirrors how Chrome/Safari behave: click a link inside the page, address bar updates to match.
  useEffect(() => {
    if (!liveUrl) return
    if (document.activeElement === urlInputRef.current) return
    setUrlDraft(liveUrl)
  }, [liveUrl])

  function goHome() {
    setSelectedId(null)
    setBrowseUrl(HOME_URL)
    setUrlDraft(HOME_URL)
    setLiveUrl(null); setLiveTitle(null)
  }

  function createBookmark() {
    if (!active) return
    const item: ResearchItem = {
      id: generateId(),
      masterProjectId: active,
      title: '新しいブックマーク',
      url: '',
      description: '',
      category: '',
      tags: [],
      createdAt: new Date().toISOString(),
    }
    dispatch({ type: 'ADD_RESEARCH', payload: item })
    setSelectedId(item.id)
  }

  function commitTitle() {
    if (!selected || titleDraft === selected.title) return
    dispatch({ type: 'UPDATE_RESEARCH', payload: { ...selected, title: titleDraft } })
  }

  function commitDescription() {
    if (!selected || descDraft === (selected.description ?? '')) return
    dispatch({ type: 'UPDATE_RESEARCH', payload: { ...selected, description: descDraft } })
  }

  function commitUrl() {
    let v = urlDraft.trim()
    // Reject URLs that would let the bookmark execute arbitrary script when
    // opened in the embedded webview.
    if (UNSAFE_SCHEME.test(v)) {
      setUrlDraft(selected?.url ?? browseUrl)
      return
    }
    // Forgiving scheme inference so users can paste bare "example.com" too.
    // Match any RFC 3986 scheme (including schemeless-authority ones like mailto:, tel:,
    // magnet:) so we don't corrupt them by prepending https://.
    if (v && !/^[a-z][a-z0-9+.-]*:/i.test(v)) v = 'https://' + v
    if (selected) {
      if (!v || v === selected.url) return
      dispatch({ type: 'UPDATE_RESEARCH', payload: { ...selected, url: v } })
      setUrlDraft(v)
    } else {
      // Home mode: just navigate the embedded browser, don't save anything.
      const target = v || HOME_URL
      setBrowseUrl(target)
      setUrlDraft(target)
    }
  }

  function addTagOnEnter(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter' || !selected) return
    // Skip while the IME is composing — otherwise the Enter that confirms a
    // Japanese conversion candidate gets swallowed and the half-composed kana
    // is committed as a tag.
    if (e.nativeEvent.isComposing || (e as unknown as { keyCode: number }).keyCode === 229) return
    e.preventDefault()
    const t = tagDraft.trim()
    if (!t || selected.tags.includes(t)) { setTagDraft(''); return }
    dispatch({ type: 'UPDATE_RESEARCH', payload: { ...selected, tags: [...selected.tags, t] } })
    setTagDraft('')
  }

  function removeTag(t: string) {
    if (!selected) return
    dispatch({ type: 'UPDATE_RESEARCH', payload: { ...selected, tags: selected.tags.filter(x => x !== t) } })
  }

  function deleteSelected() {
    if (!selected) return
    dispatch({ type: 'DELETE_RESEARCH', payload: selected.id })
    // After deletion, drop back to home rather than auto-selecting a neighbor.
    setSelectedId(null)
  }

  function toggleFolder(id: string) {
    setOpenFolders(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  function addFolder(parentId?: string) {
    if (!active) return
    const id = generateId()
    const folder: ResearchFolder = {
      id,
      masterProjectId: active,
      name: '新しいフォルダ',
      createdAt: new Date().toISOString(),
      parentId,
    }
    dispatch({ type: 'ADD_RESEARCH_FOLDER', payload: folder })
    // Open the new folder + ensure its parent chain is expanded so it's visible.
    setOpenFolders(prev => {
      const next = new Set(prev)
      next.add(id)
      if (parentId) next.add(parentId)
      return next
    })
    setEditingFolderId(id)
    setFolderNameDraft(folder.name)
  }

  function commitFolderRename(f: ResearchFolder) {
    const name = folderNameDraft.trim()
    if (name && name !== f.name) {
      dispatch({ type: 'UPDATE_RESEARCH_FOLDER', payload: { ...f, name } })
    }
    setEditingFolderId(null)
    setFolderNameDraft('')
  }

  async function deleteFolder(f: ResearchFolder) {
    const count = (itemsByFolder.get(f.id) ?? []).length
    const msg = count > 0
      ? `フォルダ「${f.name}」を削除しますか？\n中の ${count} 件は未分類になります。`
      : `フォルダ「${f.name}」を削除しますか？`
    if (!(await confirmDialog(msg))) return
    dispatch({ type: 'DELETE_RESEARCH_FOLDER', payload: f.id })
    setOpenFolders(prev => { const next = new Set(prev); next.delete(f.id); return next })
  }

  async function deleteBookmarkRow(r: ResearchItem) {
    if (!(await confirmDialog(`「${r.title || '無題'}」を削除しますか？`))) return
    dispatch({ type: 'DELETE_RESEARCH', payload: r.id })
    if (selectedId === r.id) setSelectedId(null)
  }

  function toggleArchive(r: ResearchItem) {
    const next = r.archivedAt ? undefined : new Date().toISOString()
    dispatch({ type: 'UPDATE_RESEARCH', payload: { ...r, archivedAt: next } })
    if (selectedId === r.id) setSelectedId(null)
  }

  function exportResearchJson() {
    const payload = {
      exportedAt: new Date().toISOString(),
      masterProjectId: active,
      folders: folders,
      bookmarks: allItems.map(r => ({
        id: r.id, title: r.title, url: r.url, description: r.description,
        tags: r.tags, category: r.category, folderId: r.folderId,
        archivedAt: r.archivedAt, createdAt: r.createdAt,
      })),
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `constella-research-${new Date().toISOString().slice(0, 10)}.json`
    document.body.appendChild(a); a.click(); a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  function moveTo(folderId: string | undefined) {
    if (!selected) return
    dispatch({ type: 'UPDATE_RESEARCH', payload: { ...selected, folderId } })
    setMoveMenuOpen(false)
  }

  // Cycle check used when dragging a folder into another folder.
  // Returns true if `target` is a descendant of `source` (would create a loop).
  function isDescendantOf(target: string, source: string): boolean {
    const stack = [source]
    while (stack.length) {
      const id = stack.pop() as string
      const kids = childrenByParent.get(id) ?? []
      for (const k of kids) {
        if (k.id === target) return true
        stack.push(k.id)
      }
    }
    return false
  }

  function handleBookmarkDragStart(item: ResearchItem, e: React.DragEvent) {
    draggingRef.current = { kind: 'bookmark', id: item.id }
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', item.title || item.url || '')
  }

  function handleFolderDragStart(folder: ResearchFolder, e: React.DragEvent) {
    draggingRef.current = { kind: 'folder', id: folder.id }
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', folder.name)
  }

  function handleFolderDragOver(targetFolderId: string, e: React.DragEvent) {
    const drag = draggingRef.current
    if (!drag) return
    // Hide invalid drops: folder dropped into self or its descendant.
    if (drag.kind === 'folder' && (drag.id === targetFolderId || isDescendantOf(targetFolderId, drag.id))) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    if (dragOverFolderId !== targetFolderId) setDragOverFolderId(targetFolderId)
    if (dragOverRoot) setDragOverRoot(false)
  }

  function handleFolderDrop(targetFolderId: string, e: React.DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    const drag = draggingRef.current
    draggingRef.current = null
    setDragOverFolderId(null)
    if (!drag) return
    if (drag.kind === 'bookmark') {
      const r = items.find(i => i.id === drag.id)
      if (r && r.folderId !== targetFolderId) {
        dispatch({ type: 'UPDATE_RESEARCH', payload: { ...r, folderId: targetFolderId } })
      }
      // Auto-expand target so the dropped item is visible.
      setOpenFolders(prev => { const n = new Set(prev); n.add(targetFolderId); return n })
    } else if (drag.kind === 'folder') {
      if (drag.id === targetFolderId) return
      if (isDescendantOf(targetFolderId, drag.id)) return
      const f = folders.find(x => x.id === drag.id)
      if (f && f.parentId !== targetFolderId) {
        dispatch({ type: 'UPDATE_RESEARCH_FOLDER', payload: { ...f, parentId: targetFolderId } })
      }
      setOpenFolders(prev => { const n = new Set(prev); n.add(targetFolderId); return n })
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
    if (drag.kind === 'bookmark') {
      const r = items.find(i => i.id === drag.id)
      if (r && r.folderId !== undefined) {
        dispatch({ type: 'UPDATE_RESEARCH', payload: { ...r, folderId: undefined } })
      }
    } else if (drag.kind === 'folder') {
      const f = folders.find(x => x.id === drag.id)
      if (f && f.parentId !== undefined) {
        dispatch({ type: 'UPDATE_RESEARCH_FOLDER', payload: { ...f, parentId: undefined } })
      }
    }
  }

  function handleDragEnd() {
    draggingRef.current = null
    setDragOverFolderId(null)
    setDragOverRoot(false)
  }

  function openExternal() {
    const target = selected ? selected.url : (liveUrl || browseUrl)
    if (!target) return
    window.open(target, '_blank', 'noopener,noreferrer')
  }

  // Save whatever the webview is currently displaying as a new bookmark.
  // Works in both home mode (no selection) and within an existing bookmark
  // when the user has navigated away from its URL.
  function bookmarkCurrent() {
    if (!active) return
    const url = liveUrl ?? (homeMode ? browseUrl : null)
    if (!url) return
    const item: ResearchItem = {
      id: generateId(),
      masterProjectId: active,
      title: (liveTitle && liveTitle.trim()) || url,
      url,
      description: '',
      category: '',
      tags: [],
      createdAt: new Date().toISOString(),
    }
    dispatch({ type: 'ADD_RESEARCH', payload: item })
    setSelectedId(item.id)
  }

  // Show the "save current page" prompt when:
  // - bookmark is selected and live URL differs from the bookmark URL (after normalization), OR
  // - in home mode and the webview has loaded *something* (so user can save it).
  const showSavePrompt = !!(liveUrl && (
    selected ? normalizeUrl(liveUrl) !== normalizeUrl(selected.url) : true
  ))

  // Sanitize the URL that will be handed to <webview>/<iframe>. A stored bookmark's
  // url may have been imported/migrated from a build that predates UNSAFE_SCHEME
  // (or crafted by a manual DB edit), so we defend the render path here as well.
  const rawEffectiveUrl = selected ? selected.url : browseUrl
  const effectiveUrl = rawEffectiveUrl && UNSAFE_SCHEME.test(rawEffectiveUrl.trim()) ? 'about:blank' : rawEffectiveUrl
  const effectiveTitle = selected ? (selected.title || 'Web page') : 'ホーム'

  // Recursive sidebar folder render. Closure-captures selectedId/openFolders/etc.
  function renderFolderNode(folder: ResearchFolder, depth: number) {
    const folderItems = itemsByFolder.get(folder.id) ?? []
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
          style={{ paddingLeft: 8 + depth * 12 }}>
          {cls && <span className={`absolute left-0 top-1 bottom-1 w-[3px] rounded-r-sm ${cls.stripe}`} />}
          <button
            onClick={() => toggleFolder(folder.id)}
            className="p-0.5 rounded hover:bg-slate-200 text-slate-500 shrink-0"
            title={isOpen ? '畳む' : '開く'}
          >
            {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
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
            >
              {folder.name}
            </button>
          )}
          <span className="text-[10px] text-slate-400 shrink-0">{folderItems.length}</span>
          <FolderColorSwatch
            value={folder.color}
            onChange={next => dispatch({ type: 'UPDATE_RESEARCH_FOLDER', payload: { ...folder, color: next } })}
            className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
          />
          <button
            onClick={e => { e.stopPropagation(); addFolder(folder.id) }}
            title="サブフォルダを追加"
            className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-slate-200 text-slate-400 hover:text-amber-600 transition-all shrink-0"
          >
            <FolderPlus size={11} />
          </button>
          <button
            onClick={e => { e.stopPropagation(); deleteFolder(folder) }}
            title="フォルダを削除"
            className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-slate-200 text-slate-400 hover:text-rose-500 transition-all shrink-0"
          >
            <Trash2 size={11} />
          </button>
        </div>
        {isOpen && (
          <div className="space-y-1">
            {/* Sub-folders first (recursive), then bookmarks at this level. */}
            {childFolders.map(child => renderFolderNode(child, depth + 1))}
            {folderItems.map(item => (
              <div key={item.id} style={{ paddingLeft: (depth + 1) * 12 }}>
                <BookmarkRow
                  item={item}
                  active={selectedId === item.id}
                  onSelect={() => setSelectedId(item.id)}
                  onDelete={() => deleteBookmarkRow(item)}
                  onDragStart={e => handleBookmarkDragStart(item, e)}
                  onDragEnd={handleDragEnd}
                />
              </div>
            ))}
            {folderItems.length === 0 && childFolders.length === 0 && (
              <p className="text-[10px] text-slate-400 px-2 py-1 italic" style={{ paddingLeft: 8 + (depth + 1) * 12 }}>（空）</p>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="flex h-full">
      <aside className="w-72 border-r border-slate-200 flex flex-col shrink-0">
        <header className="h-14 flex items-center justify-between px-4 border-b border-slate-200">
          <h2 className="text-sm font-semibold text-slate-700">リサーチ {showArchived && <span className="text-[10px] text-slate-400 ml-1">(アーカイブ)</span>}</h2>
          <div className="flex items-center gap-1">
            <button
              onClick={createBookmark}
              className="p-1.5 rounded-md hover:bg-slate-100 text-slate-500 hover:text-sky-600 transition-colors"
              title="ブックマークを追加"
            >
              <Plus size={16} />
            </button>
            <button
              onClick={() => addFolder()}
              className="p-1.5 rounded-md hover:bg-slate-100 text-slate-500 hover:text-amber-600 transition-colors"
              title="フォルダを追加"
            >
              <FolderPlus size={16} />
            </button>
            <button
              onClick={exportResearchJson}
              className="p-1.5 rounded-md hover:bg-slate-100 text-slate-500 hover:text-emerald-600 transition-colors"
              title="JSONで書き出し"
            >
              <Download size={16} />
            </button>
          </div>
        </header>
        <div className="px-3 py-2 border-b border-slate-200 space-y-1.5">
          <SearchInput
            value={search}
            onChange={setSearch}
            historyKey="constella.research.search"
            placeholder="リサーチ内検索"
          />
          <div className="flex items-center justify-end">
            <button
              onClick={() => setShowArchived(v => !v)}
              title={showArchived ? '通常を表示' : 'アーカイブを表示'}
              className={`flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded transition-colors ${showArchived ? 'bg-sky-100 text-sky-700' : 'text-slate-500 hover:bg-slate-100'}`}
            >
              <Archive size={11} /> アーカイブ
            </button>
          </div>
        </div>
        <div
          onDragOver={handleRootDragOver}
          onDrop={handleRootDrop}
          onDragLeave={e => { if (e.currentTarget === e.target) setDragOverRoot(false) }}
          className={`flex-1 overflow-y-auto py-2 px-2 space-y-1 transition-colors ${dragOverRoot ? 'bg-sky-50/50' : ''}`}
        >
          {/* Pinned home entry — always available, clicking goes back to Google. */}
          <button
            onClick={goHome}
            className={`w-full text-left px-3 py-2.5 rounded-lg transition-all flex items-center gap-2 ${
              homeMode
                ? 'bg-sky-50 border border-sky-200 text-sky-700'
                : 'hover:bg-slate-100 border border-transparent text-slate-700'
            }`}
            title="ホーム (Google) に戻る"
          >
            <Home size={14} className="shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium truncate">ホーム</p>
              <p className="text-[11px] text-slate-500 truncate">Google検索</p>
            </div>
          </button>
          <div className="h-px bg-slate-200 my-1" />

          {/* Unfiled bookmarks — always visible at top (no collapse, no header label if empty). */}
          {unfiled.length > 0 && (
            <>
              <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-slate-400">未分類</div>
              {unfiled.map(item => (
                <BookmarkRow
                  key={item.id}
                  item={item}
                  active={selectedId === item.id}
                  onSelect={() => setSelectedId(item.id)}
                  onDelete={() => deleteBookmarkRow(item)}
                  onDragStart={e => handleBookmarkDragStart(item, e)}
                  onDragEnd={handleDragEnd}
                />
              ))}
            </>
          )}

          {/* Folder tree — recursive render, indented by depth. */}
          {rootFolders.map(folder => renderFolderNode(folder, 0))}

          {items.length === 0 && folders.length === 0 && (
            <p className="text-xs text-slate-400 px-3 py-4 text-center">
              「＋」でブックマークやフォルダを追加
            </p>
          )}
        </div>
      </aside>

      <main className="flex-1 flex flex-col min-w-0">
        {selected ? (
          <div className="h-14 flex items-center gap-2 px-4 border-b border-slate-200">
            <input
              value={titleDraft}
              onChange={e => setTitleDraft(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={e => {
                if (e.key !== 'Enter') return
                // Guard against IME composition — same rationale as the URL bar.
                if (e.nativeEvent.isComposing || (e as unknown as { keyCode: number }).keyCode === 229) return
                ;(e.currentTarget as HTMLInputElement).blur()
              }}
              placeholder="タイトル"
              className="flex-1 min-w-0 text-sm font-semibold bg-transparent outline-none border-b border-transparent focus:border-sky-400"
            />
            <button
              onClick={openExternal}
              disabled={!selected.url}
              title="外部ブラウザで開く"
              className="p-1.5 rounded hover:bg-slate-100 text-slate-500 hover:text-sky-600 disabled:opacity-30 disabled:hover:bg-transparent"
            >
              <ExternalLink size={16} />
            </button>
            <div className="relative shrink-0">
              <button
                onClick={() => setMoveMenuOpen(v => !v)}
                title="フォルダへ移動"
                className="p-1.5 rounded hover:bg-slate-100 text-slate-500 hover:text-amber-600"
              >
                <MoreHorizontal size={16} />
              </button>
              {moveMenuOpen && (
                <>
                  <div className="fixed inset-0 z-10" onMouseDown={() => setMoveMenuOpen(false)} />
                  <div
                    className="absolute right-0 top-9 z-20 bg-white border border-slate-200 rounded-lg shadow-xl py-1 min-w-[200px]"
                    onMouseDown={e => e.stopPropagation()}
                  >
                    <div className="px-3 py-1 text-[10px] font-medium text-slate-400 uppercase tracking-wide">フォルダへ移動</div>
                    <button
                      onClick={() => moveTo(undefined)}
                      className={`w-full text-left px-3 py-1.5 text-xs hover:bg-slate-50 ${!selected.folderId ? 'text-amber-600 font-medium' : 'text-slate-700'}`}
                    >
                      フォルダなし
                    </button>
                    {folderFlat.length > 0 && <div className="h-px bg-slate-200 my-1" />}
                    {folderFlat.map(({ folder: f, depth }) => (
                      <button
                        key={f.id}
                        onClick={() => moveTo(f.id)}
                        className={`w-full text-left px-3 py-1.5 text-xs hover:bg-slate-50 truncate flex items-center gap-1.5 ${selected.folderId === f.id ? 'text-amber-600 font-medium' : 'text-slate-700'}`}
                        style={{ paddingLeft: 12 + depth * 14 }}
                      >
                        <Folder size={11} className="shrink-0" />
                        <span className="truncate">{f.name}</span>
                      </button>
                    ))}
                    {folderFlat.length === 0 && (
                      <div className="px-3 py-1.5 text-xs text-slate-400 italic">フォルダがありません</div>
                    )}
                  </div>
                </>
              )}
            </div>
            <button
              onClick={() => selected && toggleArchive(selected)}
              title={selected.archivedAt ? 'アーカイブから戻す' : 'アーカイブ'}
              className="p-1.5 rounded hover:bg-slate-100 text-slate-500 hover:text-sky-600"
            >
              {selected.archivedAt ? <ArchiveRestore size={16} /> : <Archive size={16} />}
            </button>
            <button
              onClick={deleteSelected}
              title="完全削除"
              className="p-1.5 rounded hover:bg-rose-50 text-slate-500 hover:text-rose-500"
            >
              <Trash2 size={16} />
            </button>
          </div>
        ) : (
          <div className="h-14 flex items-center gap-2 px-4 border-b border-slate-200">
            <Home size={16} className="text-sky-500 shrink-0" />
            <span className="text-sm font-semibold text-slate-700 shrink-0">ホーム</span>
            <span className="text-[11px] text-slate-400 truncate min-w-0 ml-1">URLを直接入力して閲覧 / 気に入ったページは右の「このページを保存」で登録</span>
            <button
              onClick={openExternal}
              disabled={!liveUrl && !browseUrl}
              title="外部ブラウザで開く"
              className="ml-auto p-1.5 rounded hover:bg-slate-100 text-slate-500 hover:text-sky-600 disabled:opacity-30 disabled:hover:bg-transparent"
            >
              <ExternalLink size={16} />
            </button>
          </div>
        )}

        {selected && (
          <>
            <div className="flex items-center gap-1.5 px-4 py-2 border-b border-slate-200 flex-wrap">
              {selected.tags.map(t => (
                <button
                  key={t}
                  onClick={() => removeTag(t)}
                  className="text-[11px] px-2 py-0.5 rounded-full bg-sky-100 text-sky-700 hover:bg-rose-100 hover:text-rose-700 transition-colors inline-flex items-center gap-0.5"
                  title="タグを削除"
                >
                  #{t}<X size={9} className="ml-0.5" />
                </button>
              ))}
              <input
                value={tagDraft}
                onChange={e => setTagDraft(e.target.value)}
                onKeyDown={addTagOnEnter}
                placeholder="タグを追加…"
                className="text-[11px] bg-transparent outline-none placeholder-slate-400 min-w-[80px] flex-1"
              />
            </div>
            <div className="px-4 py-2 border-b border-slate-200">
              <textarea
                value={descDraft}
                onChange={e => setDescDraft(e.target.value)}
                onBlur={commitDescription}
                placeholder="メモ・説明…"
                rows={2}
                className="w-full text-xs bg-slate-50 border border-slate-200 rounded px-2 py-1.5 outline-none focus:border-sky-400 placeholder-slate-400 resize-y leading-relaxed"
              />
            </div>
          </>
        )}

        <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-slate-200 bg-slate-50 shrink-0">
          <button
            onClick={() => webFrameRef.current?.goBack()}
            disabled={!canGoBack}
            title="戻る"
            className="shrink-0 p-1 rounded hover:bg-slate-200 text-slate-500 hover:text-slate-800 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-slate-500"
          >
            <ArrowLeft size={13} />
          </button>
          <button
            onClick={() => webFrameRef.current?.goForward()}
            disabled={!canGoForward}
            title="進む"
            className="shrink-0 p-1 rounded hover:bg-slate-200 text-slate-500 hover:text-slate-800 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-slate-500"
          >
            <ArrowRight size={13} />
          </button>
          <button
            onClick={() => isLoading ? webFrameRef.current?.stop() : webFrameRef.current?.reload()}
            title={isLoading ? '読み込みを停止' : 'リロード'}
            className="shrink-0 p-1 rounded hover:bg-slate-200 text-slate-500 hover:text-slate-800"
          >
            {isLoading ? <X size={13} /> : <RotateCw size={13} />}
          </button>
          <button
            onClick={goHome}
            title="ホーム (Google) に戻る"
            className="shrink-0 p-1 rounded hover:bg-slate-200 text-slate-500 hover:text-sky-600"
          >
            <Home size={12} />
          </button>
          <input
            ref={urlInputRef}
            type="text"
            value={urlDraft}
            onChange={e => setUrlDraft(e.target.value)}
            onBlur={commitUrl}
            // Guard against IME composition Enter (Japanese conversion confirm) so the URL bar
            // only navigates on a real user-intent Enter.
            onKeyDown={e => {
              if (e.key !== 'Enter') return
              if (e.nativeEvent.isComposing || (e as unknown as { keyCode: number }).keyCode === 229) return
              e.preventDefault()
              commitUrl()
              ;(e.currentTarget as HTMLInputElement).blur()
            }}
            placeholder="https://..."
            className="flex-1 min-w-0 bg-white rounded px-2 py-0.5 text-[11px] border border-slate-300 outline-none text-cyan-700 placeholder-slate-400 focus:border-cyan-500/60"
          />
          <button
            onClick={() => { commitUrl() }}
            className="px-2 py-0.5 text-[11px] rounded bg-sky-500 hover:bg-sky-600 text-white"
          >
            {homeMode ? '移動' : '開く'}
          </button>
          {isLoading && <Loader2 size={12} className="text-slate-400 animate-spin shrink-0" />}
        </div>

        {showSavePrompt && (
          <div className="flex items-center gap-2 px-3 py-1 border-b border-slate-200 bg-emerald-50/60 text-[11px] shrink-0">
            <span className="text-slate-500 shrink-0">表示中:</span>
            <span className="truncate flex-1 min-w-0 text-cyan-700" title={liveUrl ?? undefined}>
              {liveTitle && liveTitle !== liveUrl ? `${liveTitle} — ` : ''}{liveUrl}
            </span>
            <button
              onClick={bookmarkCurrent}
              title="このページを新しいブックマークとして保存"
              className="shrink-0 flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-500 hover:bg-emerald-600 text-white text-[11px]"
            >
              <BookmarkPlus size={11} /> このページを保存
            </button>
          </div>
        )}

        {effectiveUrl ? (
          <WebFrame
            ref={webFrameRef}
            key={(selected?.id ?? 'home') + '|' + effectiveUrl}
            url={effectiveUrl}
            title={effectiveTitle}
            onNavigate={(u, t) => { setLiveUrl(u); setLiveTitle(t) }}
            onLoadState={({ canGoBack, canGoForward, isLoading }) => {
              setCanGoBack(canGoBack)
              setCanGoForward(canGoForward)
              setIsLoading(isLoading)
            }}
            className="flex-1 min-h-0 w-full border-none bg-white"
          />
        ) : (
          <div className="flex-1 flex items-center justify-center text-sm text-slate-400">
            URLを入力してください
          </div>
        )}
      </main>
    </div>
  )
}

// Sidebar row for a single bookmark. Hover reveals an inline trash button so users can
// delete without selecting first. Click anywhere else selects the bookmark.
function BookmarkRow({ item, active, onSelect, onDelete, onDragStart, onDragEnd }: {
  item: ResearchItem
  active: boolean
  onSelect: () => void
  onDelete: () => void
  onDragStart?: (e: React.DragEvent) => void
  onDragEnd?: (e: React.DragEvent) => void
}) {
  return (
    <div
      onClick={onSelect}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={`group relative px-3 py-2 rounded-lg cursor-pointer transition-all ${
        active
          ? 'bg-slate-100 border border-slate-300'
          : 'hover:bg-slate-100 border border-transparent'
      }`}
    >
      <div className="pr-6">
        <p className="text-sm font-medium text-slate-800 truncate">{item.title || '無題'}</p>
        <p className="text-[11px] text-slate-500 truncate">{item.url || 'URL未設定'}</p>
        {item.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {item.tags.map(t => (
              <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-sky-50 text-sky-700">{t}</span>
            ))}
          </div>
        )}
      </div>
      <button
        onClick={e => { e.stopPropagation(); onDelete() }}
        title="削除"
        className="absolute right-2 top-2 p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-rose-100 text-slate-400 hover:text-rose-600 transition-all"
      >
        <Trash2 size={12} />
      </button>
    </div>
  )
}
