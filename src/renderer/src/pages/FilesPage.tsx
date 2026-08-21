// ファイル — プロジェクト横断のファイルライブラリ（Drive風ブラウザ + Photo風グリッド）。
// FileItem は1つの所有プロジェクトに登録され、linkedMasterIds で他プロジェクトにも
// 「参照」として表示できる（共有ノートと同じ単一ソース: メタ編集はどこからでも実体へ）。
// ノートの付随資料はここのファイルへの参照リンク。
import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  Plus, Trash2, Folder, FolderPlus, ChevronDown, ChevronRight, Search, X,
  LayoutGrid, List as ListIcon, Download, ChevronLeft, Loader2,
  FileText, Share2, Boxes, Tag, HardDrive, Paperclip, Files as FilesGlyph, MessageSquare,
} from 'lucide-react'
import { useApp, type Action } from '../store'
import { FileItem, FileFolder, Note } from '../types'
import { generateId } from '../utils'
import { putMedia, useMediaState } from '../persistence/media'
import { isImageFile, normalizeImageBlob } from '../utils/image'
import { fileKind, FILE_KIND_ICON, FILE_KIND_TINT, FILE_KIND_LABEL, formatSize, type FileKind } from '../utils/fileKind'
import { PdfViewer } from '../components/PdfViewer'
import { AudioPlayer } from '../components/AudioPlayer'
import { MediaFallback } from '../components/MediaFallback'
import { BOARD_COLOR_CLASSES } from '../utils/boardColor'
import { FolderColorSwatch } from '../components/FolderColorSwatch'
import { SearchInput } from '../components/SearchInput'
import { confirmDialog, alertDialog } from '../components/ConfirmDialog'

type RailSel = 'all' | 'unfiled' | 'linked' | { folderId: string }
type SortMode = 'date' | 'name' | 'size'
type ViewMode = 'grid' | 'list'
const TYPE_FILTERS: ('all' | FileKind)[] = ['all', 'image', 'video', 'pdf', 'audio', 'other']

/* ── サムネイル（グリッドタイル / リスト行アイコンで共用） ── */

function FileThumb({ file, className }: { file: FileItem; className?: string }) {
  const kind = fileKind(file.mime, file.name)
  // 画像/動画だけバイトを読む（PDF/音声/その他はアイコン表示なのでロードしない）
  const wantsMedia = kind === 'image' || kind === 'video'
  const { url } = useMediaState(wantsMedia ? file.url : undefined)
  if (kind === 'image' && url) {
    return <img src={url} alt={file.name} draggable={false} className={`object-cover ${className ?? ''}`} />
  }
  if (kind === 'video' && url) {
    // preload=metadata で最初のフレームをサムネイルに使う（再生はライトボックスで）
    return <video src={url} muted preload="metadata" className={`object-cover pointer-events-none ${className ?? ''}`} />
  }
  const Icon = FILE_KIND_ICON[kind]
  const ext = file.name.includes('.') ? file.name.split('.').pop()!.toUpperCase().slice(0, 5) : ''
  return (
    <div className={`flex flex-col items-center justify-center gap-1 bg-slate-100 ${className ?? ''}`}>
      <Icon size={28} className={FILE_KIND_TINT[kind]} />
      {ext && <span className="text-[9px] font-semibold text-slate-400">{ext}</span>}
    </div>
  )
}

/* ── ライトボックス（大プレビュー + メタ編集） ── */

function FileLightbox({ file, list, masterName, isReference, usage, masters, folders, onNav, onUpdate, onDelete, onClose, onJumpNote }: {
  file: FileItem
  list: FileItem[] // 前後ナビの並び（現在のフィルタ結果）
  masterName: (id: string) => string
  isReference: boolean // 参照（他プロジェクト所有）として見ているか
  usage: { note: Note }[]
  masters: { id: string; name: string }[] // 紐づけ候補（所有以外のアクティブなプロジェクト）
  folders: FileFolder[] // 所有プロジェクトのフォルダ（参照表示中は空）
  onNav: (next: FileItem) => void
  onUpdate: (next: FileItem) => void
  onDelete: () => void
  onClose: () => void
  onJumpNote: (note: Note) => void
}) {
  const kind = fileKind(file.mime, file.name)
  const { url: src, status } = useMediaState(file.url)
  const idx = list.findIndex(f => f.id === file.id)
  const prev = idx > 0 ? list[idx - 1] : null
  const next = idx >= 0 && idx < list.length - 1 ? list[idx + 1] : null

  // キーボード: ← → でナビ、Esc で閉じる
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
      else if (e.key === 'ArrowLeft' && prev) { e.preventDefault(); onNav(prev) }
      else if (e.key === 'ArrowRight' && next) { e.preventDefault(); onNav(next) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [prev, next, onNav, onClose])

  let body: React.ReactNode
  if (!src) {
    body = <div className="flex-1 flex items-center justify-center"><MediaFallback status={status} refUrl={file.url} /></div>
  } else if (kind === 'image') {
    body = <div className="flex-1 min-h-0 flex items-center justify-center p-4"><img src={src} alt={file.name} className="max-w-full max-h-full object-contain rounded shadow-2xl" /></div>
  } else if (kind === 'video') {
    body = <div className="flex-1 min-h-0 flex items-center justify-center p-4"><video src={src} controls autoPlay loop className="max-w-full max-h-full rounded shadow-2xl bg-black" /></div>
  } else if (kind === 'pdf') {
    body = <div className="flex-1 min-h-0 overflow-hidden p-4 flex items-stretch justify-center"><div className="w-full max-w-[880px] bg-white rounded overflow-hidden"><PdfViewer url={src} fixedHeight={Math.max(320, window.innerHeight - 120)} /></div></div>
  } else if (kind === 'audio') {
    body = <div className="flex-1 flex items-center justify-center p-8"><div className="w-full max-w-[640px]"><AudioPlayer src={src} autoPlay /></div></div>
  } else {
    body = (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 text-slate-300">
        <FileText size={48} />
        <p className="text-sm">プレビュー非対応の形式です</p>
        {src && <a href={src} download={file.name || 'file'} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-white/10 hover:bg-white/20 text-white text-xs transition-colors"><Download size={13} /> ダウンロード</a>}
      </div>
    )
  }

  const linked = file.linkedMasterIds ?? []
  const toggleLink = (mid: string) => {
    const nextIds = linked.includes(mid) ? linked.filter(x => x !== mid) : [...linked, mid]
    onUpdate({ ...file, linkedMasterIds: nextIds.length > 0 ? nextIds : undefined })
  }

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/85 backdrop-blur-sm flex" onClick={onClose}>
      {/* プレビュー領域 */}
      <div className="flex-1 min-w-0 flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="h-12 shrink-0 flex items-center gap-2 px-4 text-white/90">
          <span className="text-sm font-medium truncate flex-1" title={file.name}>{file.name || '(無名)'}</span>
          <span className="text-[11px] text-white/50 tabular-nums shrink-0">{idx >= 0 ? `${idx + 1} / ${list.length}` : ''}</span>
          {src && (
            <a href={src} download={file.name || 'file'} title="ダウンロード" className="p-1.5 rounded hover:bg-white/10 text-white/70 hover:text-white"><Download size={16} /></a>
          )}
          <button onClick={onClose} title="閉じる (Esc)" className="p-1.5 rounded hover:bg-white/10 text-white/70 hover:text-white"><X size={16} /></button>
        </div>
        <div className="flex-1 min-h-0 flex flex-col relative">
          {body}
          {prev && (
            <button onClick={() => onNav(prev)} title="前へ (←)" className="absolute left-3 top-1/2 -translate-y-1/2 p-2 rounded-full bg-black/30 hover:bg-black/50 text-white/80 hover:text-white transition-colors">
              <ChevronLeft size={20} />
            </button>
          )}
          {next && (
            <button onClick={() => onNav(next)} title="次へ (→)" className="absolute right-3 top-1/2 -translate-y-1/2 p-2 rounded-full bg-black/30 hover:bg-black/50 text-white/80 hover:text-white transition-colors">
              <ChevronRight size={20} />
            </button>
          )}
        </div>
      </div>
      {/* 情報パネル */}
      <aside className="w-80 shrink-0 bg-white flex flex-col overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="p-4 space-y-4">
          <div>
            <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">名前</label>
            <input
              value={file.name}
              onChange={e => onUpdate({ ...file, name: e.target.value })}
              className="mt-1 w-full px-2 py-1.5 text-sm border border-slate-200 focus:border-indigo-300 rounded-md outline-none text-slate-800"
            />
          </div>
          <div className="flex items-center gap-3 text-[11px] text-slate-500">
            <span className="inline-flex items-center gap-1"><HardDrive size={11} /> {formatSize(file.size) || '—'}</span>
            <span>{FILE_KIND_LABEL[kind]}{file.mime ? ` · ${file.mime}` : ''}</span>
          </div>
          <div className="text-[11px] text-slate-400">登録: {new Date(file.createdAt).toLocaleDateString()} · <span className="inline-flex items-center gap-1"><Boxes size={10} className="text-indigo-400" />{masterName(file.masterProjectId)}</span>{isReference && <span className="ml-1 text-indigo-500">（参照）</span>}</div>

          {/* コメント（自由記入メモ — 検索対象） */}
          <div>
            <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide flex items-center gap-1"><MessageSquare size={10} /> コメント</label>
            <textarea
              value={file.comment ?? ''}
              onChange={e => { const v = e.target.value; onUpdate({ ...file, comment: v || undefined }) }}
              placeholder="このファイルについてのメモ…（例: 8/21 MTGで先方から受領）"
              rows={3}
              className="mt-1 w-full px-2 py-1.5 text-xs border border-slate-200 focus:border-indigo-300 rounded-md outline-none text-slate-700 resize-y placeholder:text-slate-400"
            />
          </div>

          {/* タグ */}
          <div>
            <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide flex items-center gap-1"><Tag size={10} /> タグ</label>
            <div className="mt-1 flex gap-1 flex-wrap items-center">
              {file.tags.map(t => (
                <span
                  key={t}
                  onClick={() => onUpdate({ ...file, tags: file.tags.filter(x => x !== t) })}
                  className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-400/10 text-amber-600 cursor-pointer hover:bg-amber-400/20"
                >{t} ×</span>
              ))}
              <input
                placeholder="タグを追加…"
                className="text-[11px] bg-transparent border-none outline-none text-slate-500 w-20"
                onKeyDown={e => {
                  if (e.nativeEvent.isComposing) return
                  if (e.key === 'Enter' && e.currentTarget.value.trim()) {
                    const t = e.currentTarget.value.trim()
                    if (!file.tags.includes(t)) onUpdate({ ...file, tags: [...file.tags, t] })
                    e.currentTarget.value = ''
                  }
                }}
              />
            </div>
          </div>

          {/* フォルダ（所有プロジェクトで見ているときのみ） */}
          {!isReference && (
            <div>
              <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide flex items-center gap-1"><Folder size={10} /> フォルダ</label>
              <select
                value={file.folderId ?? ''}
                onChange={e => onUpdate({ ...file, folderId: e.target.value || undefined })}
                className="mt-1 w-full px-2 py-1.5 text-xs border border-slate-200 rounded-md outline-none bg-white text-slate-700"
              >
                <option value="">未分類</option>
                {folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </div>
          )}

          {/* 他プロジェクトへの紐づけ */}
          <div>
            <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide flex items-center gap-1"><Share2 size={10} /> 他プロジェクトに表示</label>
            {masters.length === 0 ? (
              <p className="mt-1 text-[11px] text-slate-400">他のプロジェクトがありません</p>
            ) : (
              <div className="mt-1 space-y-0.5 max-h-40 overflow-y-auto">
                {masters.map(m => (
                  <label key={m.id} className="flex items-center gap-2 px-1.5 py-1 rounded hover:bg-slate-50 cursor-pointer text-xs text-slate-700">
                    <input type="checkbox" checked={linked.includes(m.id)} onChange={() => toggleLink(m.id)} className="accent-indigo-500" />
                    <span className="truncate">{m.name}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* 使用先（このファイルを添付しているノート） */}
          <div>
            <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide flex items-center gap-1"><Paperclip size={10} /> 使用先 {usage.length}件</label>
            {usage.length === 0 ? (
              <p className="mt-1 text-[11px] text-slate-400">まだどのノートにも添付されていません</p>
            ) : (
              <div className="mt-1 space-y-0.5">
                {usage.map(({ note }) => (
                  <button
                    key={note.id}
                    onClick={() => onJumpNote(note)}
                    title={`ノート「${note.title || '(無題)'}」を開く`}
                    className="w-full flex items-center gap-1.5 px-1.5 py-1 rounded text-xs text-amber-700 bg-amber-50 border border-amber-200 hover:brightness-95 text-left"
                  >
                    <FileText size={11} className="shrink-0" />
                    <span className="truncate">{note.title || '(無題)'}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <button
            onClick={onDelete}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md border border-rose-200 text-rose-500 hover:bg-rose-50 text-xs transition-colors"
          >
            <Trash2 size={13} /> ライブラリから削除
          </button>
        </div>
      </aside>
    </div>
  )
}

/* ── ページ本体 ── */

export default function FilesPage() {
  const { state, dispatch } = useApp()
  const navigate = useNavigate()
  const location = useLocation()
  const active = state.activeMasterProjectId
  const masterName = useCallback((id: string) => state.masterProjects.find(m => m.id === id)?.name ?? '別プロジェクト', [state.masterProjects])

  const ownFiles = useMemo(() => state.files.filter(f => f.masterProjectId === active), [state.files, active])
  const refFiles = useMemo(
    () => state.files.filter(f => f.masterProjectId !== active && (f.linkedMasterIds ?? []).includes(active)),
    [state.files, active]
  )

  const folders = useMemo(
    () => state.fileFolders.filter(f => f.masterProjectId === active).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [state.fileFolders, active]
  )
  const { rootFolders, childrenByParent } = useMemo(() => {
    const ids = new Set(folders.map(f => f.id))
    const childrenByParent = new Map<string, FileFolder[]>()
    const rootFolders: FileFolder[] = []
    for (const f of folders) {
      if (f.parentId && ids.has(f.parentId)) {
        const arr = childrenByParent.get(f.parentId) ?? []
        arr.push(f); childrenByParent.set(f.parentId, arr)
      } else rootFolders.push(f)
    }
    return { rootFolders, childrenByParent }
  }, [folders])

  // ── 表示状態 ──
  const [sel, setSel] = useState<RailSel>('all')
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState<'all' | FileKind>('all')
  const [sortMode, setSortMode] = useState<SortMode>('date')
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    try { return localStorage.getItem('constella.files.view') === 'list' ? 'list' : 'grid' } catch { return 'grid' }
  })
  useEffect(() => { try { localStorage.setItem('constella.files.view', viewMode) } catch { /* ignore */ } }, [viewMode])
  const [openId, setOpenId] = useState<string | null>(null)
  const [openFolders, setOpenFolders] = useState<Set<string>>(() => new Set())
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null)
  const [folderNameDraft, setFolderNameDraft] = useState('')
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null) // ファイルカード→フォルダD&D
  const [dropUpload, setDropUpload] = useState(false) // OSからのファイルドロップ
  const [busy, setBusy] = useState(false)
  const draggingFileRef = useRef<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // 未分類 = フォルダ未設定 or 消えたフォルダを指しているもの
  const folderIds = useMemo(() => new Set(folders.map(f => f.id)), [folders])
  const countByFolder = useMemo(() => {
    const m = new Map<string, number>()
    for (const f of ownFiles) if (f.folderId && folderIds.has(f.folderId)) m.set(f.folderId, (m.get(f.folderId) ?? 0) + 1)
    return m
  }, [ownFiles, folderIds])
  const unfiledCount = useMemo(() => ownFiles.filter(f => !f.folderId || !folderIds.has(f.folderId)).length, [ownFiles, folderIds])

  // フォルダ選択時はサブフォルダの中身も含める（Drive的な「配下すべて」ではなく直下のみが
  // 迷いにくいが、探す用途ではサブ込みが便利 — ここは直下のみ + ツリーで下る方式にする）
  const baseFiles = useMemo(() => {
    if (sel === 'all') return ownFiles
    if (sel === 'unfiled') return ownFiles.filter(f => !f.folderId || !folderIds.has(f.folderId))
    if (sel === 'linked') return refFiles
    return ownFiles.filter(f => f.folderId === sel.folderId)
  }, [sel, ownFiles, refFiles, folderIds])

  const visibleFiles = useMemo(() => {
    const q = search.trim().toLowerCase()
    return baseFiles
      .filter(f => typeFilter === 'all' || fileKind(f.mime, f.name) === typeFilter)
      .filter(f => !q || f.name.toLowerCase().includes(q) || f.tags.some(t => t.toLowerCase().includes(q)) || (f.comment || '').toLowerCase().includes(q))
      .sort((a, b) => {
        if (sortMode === 'name') return (a.name || '').localeCompare(b.name || '')
        if (sortMode === 'size') return b.size - a.size
        return b.createdAt.localeCompare(a.createdAt)
      })
  }, [baseFiles, search, typeFilter, sortMode])

  const totalSize = useMemo(() => ownFiles.reduce((s, f) => s + (f.size || 0), 0), [ownFiles])

  // 使用先: fileId → このファイルを添付しているノート（アーカイブ除く）
  const usageByFile = useMemo(() => {
    const m = new Map<string, { note: Note }[]>()
    for (const n of state.notes) {
      if (n.archivedAt) continue
      for (const a of n.attachments ?? []) {
        const arr = m.get(a.fileId) ?? []
        if (!arr.some(u => u.note.id === n.id)) arr.push({ note: n })
        m.set(a.fileId, arr)
      }
    }
    return m
  }, [state.notes])

  const openFile = useMemo(
    () => (openId ? state.files.find(f => f.id === openId) ?? null : null),
    [openId, state.files]
  )
  // ライトボックスのナビ並び: 現在の絞り込み結果（開いた対象がそこに無ければ単独）
  const lightboxList = useMemo(
    () => (openFile && visibleFiles.some(f => f.id === openFile.id) ? visibleFiles : openFile ? [openFile] : []),
    [openFile, visibleFiles]
  )

  // 他ページからのジャンプ（ノート添付の「ライブラリで表示」）
  const handledLocKey = useRef('')
  useEffect(() => {
    const st = location.state as { focusFileId?: string } | null
    if (!st?.focusFileId || handledLocKey.current === location.key) return
    handledLocKey.current = location.key
    const f = state.files.find(x => x.id === st.focusFileId)
    if (!f) return
    setSel(f.masterProjectId === active ? 'all' : 'linked')
    setSearch(''); setTypeFilter('all')
    setOpenId(f.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key, location.state])

  // ── 追加/更新/削除 ──

  async function addFiles(fileList: FileList | File[]) {
    const list = [...fileList]
    if (list.length === 0) return
    const folderId = typeof sel === 'object' ? sel.folderId : undefined
    setBusy(true)
    try {
      const actions: Action[] = []
      for (const f of list) {
        const blob = isImageFile(f) ? await normalizeImageBlob(f) : f
        const url = await putMedia(blob)
        actions.push({
          type: 'ADD_FILE_ITEM',
          payload: {
            id: generateId(), masterProjectId: active, name: f.name, url,
            mime: blob.type || f.type || '', size: blob.size, tags: [], folderId,
            createdAt: new Date().toISOString(),
          },
        })
      }
      dispatch(actions.length === 1 ? actions[0] : { type: 'BATCH', payload: actions })
    } catch (e) {
      await alertDialog(`ファイルの追加に失敗しました: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  function updateFile(next: FileItem) {
    dispatch({ type: 'UPDATE_FILE_ITEM', payload: next })
  }

  async function deleteFile(f: FileItem) {
    const used = usageByFile.get(f.id)?.length ?? 0
    const msg = used > 0
      ? `「${f.name || '(無名)'}」をライブラリから削除しますか？\n${used}件のノートの付随資料からも外れます。`
      : `「${f.name || '(無名)'}」をライブラリから削除しますか？`
    if (!(await confirmDialog(msg, { danger: true }))) return
    // メディア実体はここでは消さない — undo で戻せるよう、参照が消えたブロブは
    // 起動時 sweep（7日猶予）に任せる。
    dispatch({ type: 'DELETE_FILE_ITEM', payload: f.id })
    if (openId === f.id) setOpenId(null)
  }

  // ── フォルダ操作（NotesPage と同じイディオム） ──

  function addFolder(parentId?: string) {
    if (!active) return
    const id = generateId()
    const folder: FileFolder = { id, masterProjectId: active, name: '新しいフォルダ', createdAt: new Date().toISOString(), parentId }
    dispatch({ type: 'ADD_FILE_FOLDER', payload: folder })
    setOpenFolders(prev => { const n = new Set(prev); n.add(id); if (parentId) n.add(parentId); return n })
    setEditingFolderId(id); setFolderNameDraft(folder.name)
  }
  function commitFolderRename(f: FileFolder) {
    const name = folderNameDraft.trim()
    if (name && name !== f.name) dispatch({ type: 'UPDATE_FILE_FOLDER', payload: { ...f, name } })
    setEditingFolderId(null); setFolderNameDraft('')
  }
  async function deleteFolder(f: FileFolder) {
    const count = countByFolder.get(f.id) ?? 0
    const msg = count > 0
      ? `フォルダ「${f.name}」を削除しますか？\n中の ${count} 件は未分類になります。`
      : `フォルダ「${f.name}」を削除しますか？`
    if (!(await confirmDialog(msg))) return
    dispatch({ type: 'DELETE_FILE_FOLDER', payload: f.id })
    if (typeof sel === 'object' && sel.folderId === f.id) setSel('all')
    setOpenFolders(prev => { const n = new Set(prev); n.delete(f.id); return n })
  }
  function toggleFolder(id: string) {
    setOpenFolders(prev => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next })
  }

  // ファイルカード → フォルダ D&D
  function dropFileToFolder(folderId: string | undefined) {
    const fid = draggingFileRef.current
    draggingFileRef.current = null
    setDragOverFolderId(null)
    if (!fid) return
    const f = ownFiles.find(x => x.id === fid)
    if (f && f.folderId !== folderId) updateFile({ ...f, folderId })
  }

  function renderFolderNode(folder: FileFolder, depth: number) {
    const childFolders = childrenByParent.get(folder.id) ?? []
    const isOpen = openFolders.has(folder.id)
    const isEditing = editingFolderId === folder.id
    const isSelected = typeof sel === 'object' && sel.folderId === folder.id
    const isDropTarget = dragOverFolderId === folder.id
    const cls = folder.color ? BOARD_COLOR_CLASSES[folder.color] : null
    return (
      <div key={folder.id}>
        <div
          onClick={() => setSel({ folderId: folder.id })}
          onDragOver={e => { if (draggingFileRef.current) { e.preventDefault(); e.stopPropagation(); if (dragOverFolderId !== folder.id) setDragOverFolderId(folder.id) } }}
          onDragLeave={() => { if (dragOverFolderId === folder.id) setDragOverFolderId(null) }}
          onDrop={e => { e.preventDefault(); e.stopPropagation(); dropFileToFolder(folder.id) }}
          className={`group relative flex items-center gap-1 px-2 py-1.5 rounded-md transition-colors cursor-pointer ${
            isDropTarget ? 'bg-emerald-100/70 ring-2 ring-emerald-400 ring-inset'
              : isSelected ? 'bg-slate-200/70'
              : (cls?.bgSoft ?? 'hover:bg-slate-100')
          }`}
          style={{ paddingLeft: 8 + depth * 12 }}
        >
          {cls && <span className={`absolute left-0 top-1 bottom-1 w-[3px] rounded-r-sm ${cls.stripe}`} />}
          <button
            onClick={e => { e.stopPropagation(); toggleFolder(folder.id) }}
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
              onClick={e => e.stopPropagation()}
              onKeyDown={e => {
                if (e.nativeEvent.isComposing || (e as unknown as { keyCode: number }).keyCode === 229) return
                if (e.key === 'Enter') { e.preventDefault(); commitFolderRename(folder) }
                if (e.key === 'Escape') { setEditingFolderId(null); setFolderNameDraft('') }
              }}
              className="flex-1 min-w-0 px-1 py-0.5 text-sm border border-slate-300 rounded outline-none focus:border-amber-400"
            />
          ) : (
            <span
              onDoubleClick={e => { e.stopPropagation(); setEditingFolderId(folder.id); setFolderNameDraft(folder.name) }}
              title="ダブルクリックで名前を編集"
              className="flex-1 min-w-0 truncate text-sm text-slate-700"
            >{folder.name}</span>
          )}
          <span className="text-[10px] text-slate-400 shrink-0">{countByFolder.get(folder.id) ?? 0}</span>
          <FolderColorSwatch
            value={folder.color}
            onChange={next => dispatch({ type: 'UPDATE_FILE_FOLDER', payload: { ...folder, color: next } })}
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
        {isOpen && childFolders.length > 0 && (
          <div className="space-y-0.5">{childFolders.map(c => renderFolderNode(c, depth + 1))}</div>
        )}
      </div>
    )
  }

  // 紐づけ候補: 所有プロジェクト以外のアクティブなプロジェクト
  const linkCandidates = useCallback((file: FileItem) =>
    state.masterProjects.filter(m => !m.archivedAt && m.id !== file.masterProjectId).map(m => ({ id: m.id, name: m.name })),
    [state.masterProjects]
  )

  const railItemCls = (selected: boolean) =>
    `w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-sm transition-colors text-left ${selected ? 'bg-slate-200/70 text-slate-900' : 'text-slate-600 hover:bg-slate-100'}`

  return (
    <div className="flex h-full">
      {/* 左レール: フォルダツリー + 参照 */}
      <div className="w-64 border-r border-slate-200 flex flex-col shrink-0">
        <div className="h-14 flex items-center justify-between px-4 border-b border-slate-200">
          <h2 className="text-sm font-semibold text-slate-700">ファイル</h2>
          <div className="flex items-center gap-1">
            <button
              onClick={() => fileInputRef.current?.click()}
              title="ファイルを追加"
              className="p-1.5 rounded hover:bg-slate-100 text-slate-500 hover:text-orange-600 transition-colors"
            ><Plus size={16} /></button>
            <button
              onClick={() => addFolder()}
              title="フォルダを追加"
              className="p-1.5 rounded hover:bg-slate-100 text-slate-500 hover:text-orange-600 transition-colors"
            ><FolderPlus size={16} /></button>
          </div>
        </div>
        <div className="px-3 py-2 text-[10px] text-slate-400 border-b border-slate-200">
          {ownFiles.length}件 · {formatSize(totalSize) || '0B'}
        </div>
        <div className="flex-1 overflow-y-auto py-2 px-2 space-y-0.5">
          <button
            onClick={() => setSel('all')}
            onDragOver={e => { if (draggingFileRef.current) e.preventDefault() }}
            className={railItemCls(sel === 'all')}
          >
            <FilesGlyph size={14} className="text-orange-500 shrink-0" />
            <span className="flex-1 truncate">すべて</span>
            <span className="text-[10px] text-slate-400">{ownFiles.length}</span>
          </button>
          <button
            onClick={() => setSel('unfiled')}
            onDragOver={e => { if (draggingFileRef.current) { e.preventDefault(); setDragOverFolderId('__unfiled__') } }}
            onDragLeave={() => { if (dragOverFolderId === '__unfiled__') setDragOverFolderId(null) }}
            onDrop={e => { e.preventDefault(); dropFileToFolder(undefined) }}
            className={`${railItemCls(sel === 'unfiled')} ${dragOverFolderId === '__unfiled__' ? 'bg-emerald-100/70 ring-2 ring-emerald-400 ring-inset' : ''}`}
          >
            <Folder size={14} className="text-slate-400 shrink-0" />
            <span className="flex-1 truncate">未分類</span>
            <span className="text-[10px] text-slate-400">{unfiledCount}</span>
          </button>
          {rootFolders.map(f => renderFolderNode(f, 0))}
          {refFiles.length > 0 && (
            <>
              <div className="px-2 pt-2 pb-1 text-[10px] uppercase tracking-wide text-indigo-400 flex items-center gap-1"><Share2 size={10} /> 参照（他プロジェクト）</div>
              <button onClick={() => setSel('linked')} className={railItemCls(sel === 'linked')}>
                <Share2 size={14} className="text-indigo-400 shrink-0" />
                <span className="flex-1 truncate">参照ファイル</span>
                <span className="text-[10px] text-slate-400">{refFiles.length}</span>
              </button>
            </>
          )}
        </div>
      </div>

      {/* メイン */}
      <div
        className={`flex-1 flex flex-col min-w-0 ${dropUpload ? 'bg-emerald-50/60' : ''}`}
        onDragOver={e => {
          if (![...e.dataTransfer.types].includes('Files')) return
          e.preventDefault()
          if (!dropUpload) setDropUpload(true)
        }}
        onDragLeave={e => { if (e.currentTarget === e.target) setDropUpload(false) }}
        onDrop={e => {
          if (![...e.dataTransfer.types].includes('Files')) return
          e.preventDefault()
          setDropUpload(false)
          addFiles(e.dataTransfer.files)
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={e => { if (e.target.files?.length) addFiles(e.target.files); e.target.value = '' }}
        />
        {/* ツールバー */}
        <div className="h-14 shrink-0 flex items-center gap-2 px-4 border-b border-slate-200 flex-wrap">
          <div className="w-56">
            <SearchInput value={search} onChange={setSearch} historyKey="constella.files.search" placeholder="検索 (名前/タグ)" />
          </div>
          <div className="flex items-center rounded-md border border-slate-200 overflow-hidden text-[11px]">
            {TYPE_FILTERS.map(t => (
              <button
                key={t}
                onClick={() => setTypeFilter(t)}
                className={`px-2 py-1 transition-colors ${typeFilter === t ? 'bg-orange-500/15 text-orange-600 font-medium' : 'text-slate-500 hover:bg-slate-100'}`}
              >{t === 'all' ? 'すべて' : FILE_KIND_LABEL[t]}</button>
            ))}
          </div>
          <select
            value={sortMode}
            onChange={e => setSortMode(e.target.value as SortMode)}
            className="text-[11px] border border-slate-200 rounded-md px-1.5 py-1 outline-none bg-white text-slate-600"
          >
            <option value="date">追加順</option>
            <option value="name">名前順</option>
            <option value="size">サイズ順</option>
          </select>
          <div className="flex items-center rounded-md border border-slate-200 overflow-hidden">
            <button
              onClick={() => setViewMode('grid')}
              title="グリッド表示"
              className={`p-1.5 transition-colors ${viewMode === 'grid' ? 'bg-orange-500/15 text-orange-600' : 'text-slate-500 hover:bg-slate-100'}`}
            ><LayoutGrid size={14} /></button>
            <button
              onClick={() => setViewMode('list')}
              title="リスト表示"
              className={`p-1.5 transition-colors ${viewMode === 'list' ? 'bg-orange-500/15 text-orange-600' : 'text-slate-500 hover:bg-slate-100'}`}
            ><ListIcon size={14} /></button>
          </div>
          <div className="flex-1" />
          <span className="text-[11px] text-slate-400">{visibleFiles.length}件</span>
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={busy}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-orange-500 hover:bg-orange-600 text-white text-xs font-medium transition-colors disabled:opacity-50"
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} 追加
          </button>
        </div>

        {/* 一覧 */}
        <div className="flex-1 overflow-y-auto p-4">
          {visibleFiles.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-slate-400 gap-2">
              <FilesGlyph size={36} className="text-slate-300" />
              <p className="text-sm">{search || typeFilter !== 'all' ? '一致するファイルがありません' : 'ファイルをドロップ、または「追加」から登録'}</p>
              <p className="text-[11px] text-slate-400">PDF・画像・動画・音声など何でも。ノートの付随資料としても使えます</p>
            </div>
          ) : viewMode === 'grid' ? (
            <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
              {visibleFiles.map(f => {
                const kind = fileKind(f.mime, f.name)
                const Icon = FILE_KIND_ICON[kind]
                const used = usageByFile.get(f.id)?.length ?? 0
                return (
                  <div
                    key={f.id}
                    draggable={sel !== 'linked'}
                    onDragStart={e => { draggingFileRef.current = f.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', f.name) }}
                    onDragEnd={() => { draggingFileRef.current = null; setDragOverFolderId(null) }}
                    onClick={() => setOpenId(f.id)}
                    title={`${f.name}${f.size ? ` (${formatSize(f.size)})` : ''}${f.comment ? `\n${f.comment}` : ''}`}
                    className="group rounded-lg border border-slate-200 bg-white overflow-hidden cursor-pointer hover:border-slate-300 hover:shadow-md transition-all"
                  >
                    <div className="aspect-square w-full overflow-hidden relative">
                      <FileThumb file={f} className="w-full h-full" />
                      {f.masterProjectId !== active && (
                        <span className="absolute top-1 left-1 inline-flex items-center gap-0.5 px-1 py-0.5 rounded bg-indigo-500/85 text-white text-[8px]"><Share2 size={8} /> 参照</span>
                      )}
                      {used > 0 && (
                        <span className="absolute top-1 right-1 inline-flex items-center gap-0.5 px-1 py-0.5 rounded bg-slate-900/60 text-white text-[8px]" title={`${used}件のノートで使用中`}><Paperclip size={8} />{used}</span>
                      )}
                    </div>
                    <div className="px-2 py-1.5">
                      <p className="text-[11px] text-slate-700 truncate flex items-center gap-1">
                        <Icon size={10} className={`shrink-0 ${FILE_KIND_TINT[kind]}`} />
                        <span className="truncate">{f.name || '(無名)'}</span>
                      </p>
                      <p className="text-[9px] text-slate-400 tabular-nums">{formatSize(f.size) || '—'}</p>
                      {f.comment && (
                        <p className="text-[9px] text-slate-500 truncate flex items-center gap-0.5 mt-0.5">
                          <MessageSquare size={8} className="shrink-0 text-slate-400" />
                          <span className="truncate">{f.comment}</span>
                        </p>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="rounded-lg border border-slate-200 overflow-hidden bg-white">
              {visibleFiles.map((f, i) => {
                const kind = fileKind(f.mime, f.name)
                const Icon = FILE_KIND_ICON[kind]
                const used = usageByFile.get(f.id)?.length ?? 0
                return (
                  <div
                    key={f.id}
                    draggable={sel !== 'linked'}
                    onDragStart={e => { draggingFileRef.current = f.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', f.name) }}
                    onDragEnd={() => { draggingFileRef.current = null; setDragOverFolderId(null) }}
                    onClick={() => setOpenId(f.id)}
                    className={`flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-slate-50 transition-colors ${i > 0 ? 'border-t border-slate-100' : ''}`}
                  >
                    <div className="w-9 h-9 rounded overflow-hidden shrink-0">
                      <FileThumb file={f} className="w-full h-full" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-slate-800 truncate flex items-center gap-1.5">
                        <span className="truncate">{f.name || '(無名)'}</span>
                        {f.masterProjectId !== active && <span className="shrink-0 inline-flex items-center gap-0.5 px-1 py-px rounded bg-indigo-50 border border-indigo-200 text-indigo-500 text-[8px]"><Share2 size={8} /> {masterName(f.masterProjectId)}</span>}
                      </p>
                      {(f.comment || f.tags.length > 0) && (
                        <div className="flex items-center gap-1.5 mt-0.5 min-w-0">
                          {f.tags.map(t => <span key={t} className="shrink-0 text-[9px] px-1 py-px rounded bg-amber-400/10 text-amber-600">{t}</span>)}
                          {f.comment && (
                            <span className="text-[9px] text-slate-500 truncate flex items-center gap-0.5">
                              <MessageSquare size={8} className="shrink-0 text-slate-400" />
                              <span className="truncate">{f.comment}</span>
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                    {used > 0 && <span className="inline-flex items-center gap-0.5 text-[10px] text-slate-400 shrink-0" title={`${used}件のノートで使用中`}><Paperclip size={10} />{used}</span>}
                    <span className="text-[10px] text-slate-400 shrink-0 w-16 text-right inline-flex items-center justify-end gap-1"><Icon size={10} className={FILE_KIND_TINT[kind]} />{FILE_KIND_LABEL[kind]}</span>
                    <span className="text-[10px] text-slate-400 tabular-nums shrink-0 w-14 text-right">{formatSize(f.size) || '—'}</span>
                    <span className="text-[10px] text-slate-400 tabular-nums shrink-0 w-20 text-right">{new Date(f.createdAt).toLocaleDateString()}</span>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {openFile && (
        <FileLightbox
          file={openFile}
          list={lightboxList}
          masterName={masterName}
          isReference={openFile.masterProjectId !== active}
          usage={usageByFile.get(openFile.id) ?? []}
          masters={linkCandidates(openFile)}
          folders={folders}
          onNav={f => setOpenId(f.id)}
          onUpdate={updateFile}
          onDelete={() => deleteFile(openFile)}
          onClose={() => setOpenId(null)}
          onJumpNote={note => navigate('/', { state: { focusNoteId: note.id } })}
        />
      )}
    </div>
  )
}
