// ノートの付随資料パネル — MTGの先方資料（PDF/画像/動画）と自分の対応資料の
// ような関連ファイルをノートに添付して一緒に管理する。実体はファイルライブラリ
// (FileItem) にあり、添付はそこへの参照リンク: 同じ資料を複数ノートで使い回せる。
// ここでのアップロードはライブラリへの登録＋リンクを1 undoステップ (BATCH) で行う。
// グループ（先方資料 / 自分の資料 / 自由入力）はリンク側に持つノート内の仕分け。
import { useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Paperclip, Plus, Trash2, X, Download, Loader2, FolderInput, Search, Library, MessageSquare,
} from 'lucide-react'
import type { Note, NoteAttachment, FileItem } from '../types'
import { generateId } from '../utils'
import { useApp, type Action } from '../store'
import { putMedia, useMediaState } from '../persistence/media'
import { isImageFile, normalizeImageBlob } from '../utils/image'
import { fileKind, FILE_KIND_ICON, FILE_KIND_TINT, formatSize } from '../utils/fileKind'
import { PdfViewer } from './PdfViewer'
import { AudioPlayer } from './AudioPlayer'
import { MediaFallback } from './MediaFallback'
import { confirmDialog, alertDialog } from './ConfirmDialog'

// よく使う仕分け先。自由入力のグループもそのまま使える（datalist 候補）。
const PRESET_GROUPS = ['先方資料', '自分の資料']
const UNGROUPED = '' // group undefined の表示バケット

/* ── 展開プレビュー（選択中の1件） ── */

function AttachmentDetail({ att, file, groups, onUpdateLink, onRenameFile, onDetach, onClose }: {
  att: NoteAttachment
  file: FileItem
  groups: string[] // 既存グループ（datalist 候補に混ぜる）
  onUpdateLink: (next: NoteAttachment) => void
  onRenameFile: (name: string) => void
  onDetach: () => void
  onClose: () => void
}) {
  const navigate = useNavigate()
  const kind = fileKind(file.mime, file.name)
  const { url: src, status } = useMediaState(file.url)
  const groupOptions = useMemo(
    () => [...new Set([...PRESET_GROUPS, ...groups])].filter(g => g !== UNGROUPED),
    [groups]
  )

  let body: React.ReactNode
  if (!src) {
    body = <div className="h-24 flex items-center justify-center"><MediaFallback status={status} refUrl={file.url} compact /></div>
  } else if (kind === 'pdf') {
    body = <PdfViewer url={src} fixedHeight={440} />
  } else if (kind === 'image') {
    body = <div className="flex justify-center bg-slate-100 max-h-[440px] overflow-auto"><img src={src} alt={file.name} className="max-w-full object-contain" /></div>
  } else if (kind === 'video') {
    body = <video src={src} controls loop className="w-full max-h-[440px] bg-black" />
  } else if (kind === 'audio') {
    body = <div className="p-3"><AudioPlayer src={src} /></div>
  } else {
    body = <div className="h-16 flex items-center justify-center text-xs text-slate-400">プレビュー非対応の形式です（ダウンロードして開いてください）</div>
  }

  return (
    <div className="mt-2 rounded-lg border border-slate-200 bg-white shadow-sm overflow-hidden">
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-b border-slate-100 bg-slate-50 flex-wrap">
        <Paperclip size={12} className="text-slate-400 shrink-0" />
        <input
          value={file.name}
          onChange={e => onRenameFile(e.target.value)}
          title="クリックで名前を編集（ライブラリの名前も変わります）"
          className="flex-1 min-w-[140px] px-1.5 py-0.5 text-[11px] font-medium text-slate-700 bg-transparent border border-transparent hover:border-slate-200 focus:border-indigo-300 rounded outline-none transition-colors"
        />
        <span className="text-[10px] text-slate-400 shrink-0 tabular-nums">{formatSize(file.size)}</span>
        {/* グループ変更 — プリセット + 既存グループを候補に自由入力 */}
        <label className="flex items-center gap-1 shrink-0" title="グループ（先方資料 / 自分の資料 など）">
          <FolderInput size={12} className="text-slate-400" />
          <input
            list="note-att-groups"
            value={att.group ?? ''}
            onChange={e => { const g = e.target.value.trim(); onUpdateLink({ ...att, group: g || undefined }) }}
            placeholder="グループなし"
            className="w-24 px-1.5 py-0.5 text-[10px] text-slate-600 bg-white border border-slate-200 focus:border-indigo-300 rounded outline-none"
          />
          <datalist id="note-att-groups">
            {groupOptions.map(g => <option key={g} value={g} />)}
          </datalist>
        </label>
        <button
          onClick={() => navigate('/files', { state: { focusFileId: file.id } })}
          title="ファイルライブラリで表示"
          className="p-1 rounded hover:bg-slate-200 text-slate-400 hover:text-indigo-600"
        ><Library size={12} /></button>
        {src && (
          <a
            href={src}
            download={file.name || 'attachment'}
            title="ダウンロード"
            className="p-1 rounded hover:bg-slate-200 text-slate-400 hover:text-slate-600"
          ><Download size={12} /></a>
        )}
        <button onClick={onDetach} title="このノートから外す（ライブラリには残ります）" className="p-1 rounded hover:bg-slate-200 text-slate-400 hover:text-rose-500">
          <Trash2 size={12} />
        </button>
        <button onClick={onClose} title="閉じる" className="p-1 rounded hover:bg-slate-200 text-slate-400 hover:text-slate-600">
          <X size={12} />
        </button>
      </div>
      {/* ライブラリ側のコメント（編集は「ライブラリで表示」から） */}
      {file.comment && (
        <div className="px-2.5 py-1 border-b border-slate-100 bg-amber-50/60 flex items-start gap-1.5">
          <MessageSquare size={11} className="shrink-0 text-amber-500 mt-0.5" />
          <p className="text-[10px] text-slate-600 whitespace-pre-wrap flex-1">{file.comment}</p>
        </div>
      )}
      {body}
    </div>
  )
}

/* ── パネル本体 ── */

export function NoteAttachments({ note }: { note: Note }) {
  const { state, dispatch } = useApp()
  const attachments = note.attachments ?? []
  const fileInputRef = useRef<HTMLInputElement>(null)
  // 「＋追加」を押したグループ（ファイル選択ダイアログをまたいで保持する）
  const addTargetGroup = useRef<string | undefined>(undefined)
  const [openId, setOpenId] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [busy, setBusy] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerQ, setPickerQ] = useState('')

  const fileById = useMemo(() => new Map(state.files.map(f => [f.id, f])), [state.files])

  // グループ→添付のバケット分け。登場順を保ちつつ 未分類 を先頭に。
  const grouped = useMemo(() => {
    const map = new Map<string, NoteAttachment[]>()
    for (const a of attachments) {
      const g = a.group?.trim() || UNGROUPED
      const arr = map.get(g) ?? []
      arr.push(a)
      map.set(g, arr)
    }
    const keys = [...map.keys()].sort((a, b) => (a === UNGROUPED ? -1 : b === UNGROUPED ? 1 : 0))
    return keys.map(k => ({ group: k, items: map.get(k)! }))
  }, [attachments])
  const groupNames = useMemo(() => grouped.map(g => g.group).filter(g => g !== UNGROUPED), [grouped])

  const openAttachment = useMemo(() => attachments.find(a => a.id === openId) ?? null, [attachments, openId])
  const openFile = openAttachment ? fileById.get(openAttachment.fileId) ?? null : null

  // このノートのプロジェクトで使えるライブラリファイル（所有 + 参照）で未添付のもの。
  const attachedFileIds = useMemo(() => new Set(attachments.map(a => a.fileId)), [attachments])
  const pickableFiles = useMemo(() => {
    const q = pickerQ.trim().toLowerCase()
    return state.files
      .filter(f => f.masterProjectId === note.masterProjectId || (f.linkedMasterIds ?? []).includes(note.masterProjectId))
      .filter(f => !attachedFileIds.has(f.id))
      .filter(f => !q || f.name.toLowerCase().includes(q) || f.tags.some(t => t.toLowerCase().includes(q)) || (f.comment || '').toLowerCase().includes(q))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }, [state.files, note.masterProjectId, attachedFileIds, pickerQ])

  // ノートの添付リンクを書き換える（updatedAt も進める — NotesPage の updateNote と同じ扱い）。
  function noteUpdateAction(next: NoteAttachment[]): Action {
    return {
      type: 'UPDATE_NOTE',
      payload: { ...note, attachments: next.length > 0 ? next : undefined, updatedAt: new Date().toISOString() },
    }
  }

  async function addFiles(fileList: FileList | File[], group?: string) {
    const list = [...fileList]
    if (list.length === 0) return
    setBusy(true)
    try {
      const actions: Action[] = []
      const links: NoteAttachment[] = [...attachments]
      for (const f of list) {
        // TIFF/TGA など native 表示できない画像は PNG に正規化してから保存
        const blob = isImageFile(f) ? await normalizeImageBlob(f) : f
        const url = await putMedia(blob)
        const item: FileItem = {
          id: generateId(),
          masterProjectId: note.masterProjectId, // ノートのプロジェクトに登録
          name: f.name,
          url,
          mime: blob.type || f.type || '',
          size: blob.size,
          tags: [],
          createdAt: new Date().toISOString(),
        }
        actions.push({ type: 'ADD_FILE_ITEM', payload: item })
        links.push({ id: generateId(), fileId: item.id, group, createdAt: item.createdAt })
      }
      // ライブラリ登録＋ノートへのリンクを 1 undo ステップで
      dispatch({ type: 'BATCH', payload: [...actions, noteUpdateAction(links)] })
      if (list.length === 1) setOpenId(links[links.length - 1].id)
    } catch (e) {
      await alertDialog(`資料の追加に失敗しました: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  function attachExisting(file: FileItem) {
    const link: NoteAttachment = { id: generateId(), fileId: file.id, createdAt: new Date().toISOString() }
    dispatch(noteUpdateAction([...attachments, link]))
    setPickerOpen(false)
    setPickerQ('')
    setOpenId(link.id)
  }

  function updateLink(next: NoteAttachment) {
    dispatch(noteUpdateAction(attachments.map(a => a.id === next.id ? next : a)))
  }

  function renameFile(file: FileItem, name: string) {
    dispatch({ type: 'UPDATE_FILE_ITEM', payload: { ...file, name } })
  }

  async function detach(att: NoteAttachment) {
    const name = fileById.get(att.fileId)?.name ?? '(不明)'
    if (!(await confirmDialog(`資料「${name}」をこのノートから外しますか？\n（ファイル自体はライブラリに残ります）`))) return
    dispatch(noteUpdateAction(attachments.filter(a => a.id !== att.id)))
    if (openId === att.id) setOpenId(null)
  }

  const pickFiles = (group?: string) => {
    addTargetGroup.current = group
    fileInputRef.current?.click()
  }

  return (
    <div
      onDragOver={e => {
        if (![...e.dataTransfer.types].includes('Files')) return
        e.preventDefault(); e.stopPropagation()
        if (!dragOver) setDragOver(true)
      }}
      onDragLeave={e => { if (e.currentTarget === e.target) setDragOver(false) }}
      onDrop={e => {
        if (![...e.dataTransfer.types].includes('Files')) return
        e.preventDefault(); e.stopPropagation()
        setDragOver(false)
        addFiles(e.dataTransfer.files)
      }}
      className={`px-6 py-2 border-b border-slate-200 transition-colors ${dragOver ? 'bg-emerald-50 ring-2 ring-inset ring-emerald-300' : 'bg-slate-50/50'}`}
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={e => {
          if (e.target.files?.length) addFiles(e.target.files, addTargetGroup.current)
          e.target.value = ''
          addTargetGroup.current = undefined
        }}
      />
      <div className="flex items-center gap-2 flex-wrap relative">
        <Paperclip size={14} className="text-slate-500 shrink-0" />
        <span className="text-[11px] text-slate-500 shrink-0">付随資料 {attachments.length}件</span>
        <button
          onClick={() => pickFiles()}
          disabled={busy}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] border border-slate-300 text-slate-600 bg-white hover:bg-slate-100 transition-colors disabled:opacity-50"
        >
          {busy ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />} 追加
        </button>
        <button
          onClick={() => setPickerOpen(o => !o)}
          title="ファイルライブラリから既存の資料を選んで添付"
          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] border transition-colors ${pickerOpen ? 'border-indigo-300 bg-indigo-50 text-indigo-700' : 'border-slate-300 text-slate-600 bg-white hover:bg-slate-100'}`}
        >
          <Library size={11} /> ライブラリから
        </button>
        <span className="text-[10px] text-slate-400">ファイルをここにドロップでも追加できます</span>
        {pickerOpen && (
          <>
            <div className="fixed inset-0 z-20" onClick={() => setPickerOpen(false)} />
            <div className="absolute left-0 top-7 z-30 w-[320px] bg-white border border-slate-200 rounded-lg shadow-xl p-2">
              <div className="flex items-center gap-1.5 bg-slate-100 rounded px-2 py-1 mb-1.5">
                <Search size={12} className="text-slate-400 shrink-0" />
                <input
                  autoFocus
                  value={pickerQ}
                  onChange={e => setPickerQ(e.target.value)}
                  placeholder="ライブラリを検索…"
                  className="flex-1 min-w-0 bg-transparent outline-none text-xs text-slate-700 placeholder:text-slate-400"
                />
              </div>
              {pickableFiles.length === 0 ? (
                <div className="text-[10px] text-slate-400 px-1 py-3 text-center">
                  添付できるファイルがありません<br />（「ファイル」ページでライブラリに登録できます）
                </div>
              ) : (
                <div className="max-h-[240px] overflow-y-auto">
                  {pickableFiles.map(f => {
                    const kind = fileKind(f.mime, f.name)
                    const Icon = FILE_KIND_ICON[kind]
                    return (
                      <button
                        key={f.id}
                        onClick={() => attachExisting(f)}
                        className="w-full text-left px-1.5 py-1 hover:bg-indigo-50 rounded text-xs flex items-center gap-1.5"
                      >
                        <Icon size={12} className={`shrink-0 ${FILE_KIND_TINT[kind]}`} />
                        <span className="truncate flex-1">{f.name}</span>
                        <span className="text-[9px] text-slate-400 shrink-0 tabular-nums">{formatSize(f.size)}</span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          </>
        )}
      </div>
      {grouped.map(({ group, items }) => (
        <div key={group || '(none)'} className="mt-1.5">
          {(group !== UNGROUPED || grouped.length > 1) && (
            <div className="flex items-center gap-1.5 mb-1">
              <span className="text-[10px] font-medium text-slate-500">{group === UNGROUPED ? '未分類' : group}</span>
              <span className="text-[9px] text-slate-400">{items.length}</span>
              <button
                onClick={() => pickFiles(group === UNGROUPED ? undefined : group)}
                title={`「${group === UNGROUPED ? '未分類' : group}」に資料を追加`}
                className="p-0.5 rounded hover:bg-slate-200 text-slate-400 hover:text-emerald-600 transition-colors"
              ><Plus size={10} /></button>
            </div>
          )}
          <div className="flex items-center gap-1.5 flex-wrap">
            {items.map(att => {
              const file = fileById.get(att.fileId)
              if (!file) {
                // 参照先が消えた（通常は DELETE_FILE_ITEM のカスケードで残らないが防御）
                return (
                  <button
                    key={att.id}
                    onClick={() => dispatch(noteUpdateAction(attachments.filter(a => a.id !== att.id)))}
                    title="参照先のファイルが見つかりません — クリックでこのリンクを外す"
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] border border-rose-200 bg-rose-50 text-rose-500"
                  >
                    <X size={12} className="shrink-0" />
                    <span className="truncate">リンク切れ</span>
                  </button>
                )
              }
              const kind = fileKind(file.mime, file.name)
              const Icon = FILE_KIND_ICON[kind]
              const isOpen = openId === att.id
              return (
                <button
                  key={att.id}
                  onClick={() => setOpenId(isOpen ? null : att.id)}
                  title={`${file.name}${file.size ? ` (${formatSize(file.size)})` : ''} — クリックでプレビュー`}
                  className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] border transition-all max-w-[220px] ${
                    isOpen
                      ? 'border-indigo-300 bg-indigo-50 text-indigo-700'
                      : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-100'
                  }`}
                >
                  <Icon size={12} className={`shrink-0 ${FILE_KIND_TINT[kind]}`} />
                  <span className="truncate">{file.name || '(無名)'}</span>
                </button>
              )
            })}
          </div>
        </div>
      ))}
      {attachments.length === 0 && (
        <p className="mt-1 text-[10px] text-slate-400">MTGの先方資料や自分の作成資料（PDF・画像・動画など）をこのノートに添付できます</p>
      )}
      {openAttachment && openFile && (
        <AttachmentDetail
          att={openAttachment}
          file={openFile}
          groups={groupNames}
          onUpdateLink={updateLink}
          onRenameFile={name => renameFile(openFile, name)}
          onDetach={() => detach(openAttachment)}
          onClose={() => setOpenId(null)}
        />
      )}
    </div>
  )
}
