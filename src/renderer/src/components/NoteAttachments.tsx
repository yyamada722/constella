// ノートの付随資料パネル — MTGの先方資料（PDF/画像/動画）と自分の対応資料の
// ような関連ファイルをノートに添付して一緒に管理する。バイトは IndexedDB の
// メディアストア（idb:）に保存し、Note.attachments にメタデータだけを持つ。
// グループ（先方資料 / 自分の資料 / 自由入力）で仕分けでき、チップをクリックで
// PDF/画像/動画/音声をインラインプレビューする。
import { useMemo, useRef, useState } from 'react'
import {
  Paperclip, Plus, Trash2, X, Download, FileText, Image as ImageIcon,
  Film, Music, File as FileIcon, Loader2, FolderInput,
} from 'lucide-react'
import type { NoteAttachment } from '../types'
import { generateId } from '../utils'
import { putMedia, useMediaState } from '../persistence/media'
import { isImageFile, normalizeImageBlob } from '../utils/image'
import { localKind, type LocalKind } from '../utils/localFile'
import { PdfViewer } from './PdfViewer'
import { MediaFallback } from './MediaFallback'
import { confirmDialog, alertDialog } from './ConfirmDialog'

// よく使う仕分け先。自由入力のグループもそのまま使える（datalist 候補）。
const PRESET_GROUPS = ['先方資料', '自分の資料']
const UNGROUPED = '' // group undefined の表示バケット

function kindOf(att: NoteAttachment): LocalKind {
  const m = att.mime
  if (m.startsWith('image/')) return 'image'
  if (m === 'application/pdf') return 'pdf'
  if (m.startsWith('video/')) return 'video'
  if (m.startsWith('audio/')) return 'audio'
  // MIME が空/不明（例: 一部のOSのドロップ）→ ファイル名の拡張子から推定
  return localKind(att.name)
}

const KIND_ICON = { image: ImageIcon, pdf: FileText, video: Film, audio: Music, other: FileIcon } as const
const KIND_TINT = {
  image: 'text-emerald-500', pdf: 'text-rose-500', video: 'text-indigo-500',
  audio: 'text-violet-500', other: 'text-slate-400',
} as const

function formatSize(bytes: number): string {
  if (!bytes || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

/* ── 展開プレビュー（選択中の1件） ── */

function AttachmentDetail({ att, groups, onUpdate, onDelete, onClose }: {
  att: NoteAttachment
  groups: string[] // 既存グループ（datalist 候補に混ぜる）
  onUpdate: (next: NoteAttachment) => void
  onDelete: () => void
  onClose: () => void
}) {
  const kind = kindOf(att)
  const { url: src, status } = useMediaState(att.url)
  const groupOptions = useMemo(
    () => [...new Set([...PRESET_GROUPS, ...groups])].filter(g => g !== UNGROUPED),
    [groups]
  )

  let body: React.ReactNode
  if (!src) {
    body = <div className="h-24 flex items-center justify-center"><MediaFallback status={status} refUrl={att.url} compact /></div>
  } else if (kind === 'pdf') {
    body = <PdfViewer url={src} fixedHeight={440} />
  } else if (kind === 'image') {
    body = <div className="flex justify-center bg-slate-100 max-h-[440px] overflow-auto"><img src={src} alt={att.name} className="max-w-full object-contain" /></div>
  } else if (kind === 'video') {
    body = <video src={src} controls className="w-full max-h-[440px] bg-black" />
  } else if (kind === 'audio') {
    body = <audio src={src} controls className="w-full px-3 py-4" />
  } else {
    body = <div className="h-16 flex items-center justify-center text-xs text-slate-400">プレビュー非対応の形式です（ダウンロードして開いてください）</div>
  }

  return (
    <div className="mt-2 rounded-lg border border-slate-200 bg-white shadow-sm overflow-hidden">
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-b border-slate-100 bg-slate-50 flex-wrap">
        <Paperclip size={12} className="text-slate-400 shrink-0" />
        <input
          value={att.name}
          onChange={e => onUpdate({ ...att, name: e.target.value })}
          title="クリックで名前を編集"
          className="flex-1 min-w-[140px] px-1.5 py-0.5 text-[11px] font-medium text-slate-700 bg-transparent border border-transparent hover:border-slate-200 focus:border-indigo-300 rounded outline-none transition-colors"
        />
        <span className="text-[10px] text-slate-400 shrink-0 tabular-nums">{formatSize(att.size)}</span>
        {/* グループ変更 — プリセット + 既存グループを候補に自由入力 */}
        <label className="flex items-center gap-1 shrink-0" title="グループ（先方資料 / 自分の資料 など）">
          <FolderInput size={12} className="text-slate-400" />
          <input
            list="note-att-groups"
            value={att.group ?? ''}
            onChange={e => { const g = e.target.value.trim(); onUpdate({ ...att, group: g || undefined }) }}
            placeholder="グループなし"
            className="w-24 px-1.5 py-0.5 text-[10px] text-slate-600 bg-white border border-slate-200 focus:border-indigo-300 rounded outline-none"
          />
          <datalist id="note-att-groups">
            {groupOptions.map(g => <option key={g} value={g} />)}
          </datalist>
        </label>
        {src && (
          <a
            href={src}
            download={att.name || 'attachment'}
            title="ダウンロード"
            className="p-1 rounded hover:bg-slate-200 text-slate-400 hover:text-slate-600"
          ><Download size={12} /></a>
        )}
        <button onClick={onDelete} title="この資料を削除" className="p-1 rounded hover:bg-slate-200 text-slate-400 hover:text-rose-500">
          <Trash2 size={12} />
        </button>
        <button onClick={onClose} title="閉じる" className="p-1 rounded hover:bg-slate-200 text-slate-400 hover:text-slate-600">
          <X size={12} />
        </button>
      </div>
      {body}
    </div>
  )
}

/* ── パネル本体 ── */

export function NoteAttachments({ attachments, onChange }: {
  attachments: NoteAttachment[]
  onChange: (next: NoteAttachment[]) => void
}) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  // 「＋追加」を押したグループ（ファイル選択ダイアログをまたいで保持する）
  const addTargetGroup = useRef<string | undefined>(undefined)
  const [openId, setOpenId] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [busy, setBusy] = useState(false)

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

  async function addFiles(files: FileList | File[], group?: string) {
    const list = [...files]
    if (list.length === 0) return
    setBusy(true)
    try {
      const added: NoteAttachment[] = []
      for (const f of list) {
        // TIFF/TGA など native 表示できない画像は PNG に正規化してから保存
        const blob = isImageFile(f) ? await normalizeImageBlob(f) : f
        const url = await putMedia(blob)
        added.push({
          id: generateId(),
          name: f.name,
          url,
          mime: blob.type || f.type || '',
          size: blob.size,
          group,
          createdAt: new Date().toISOString(),
        })
      }
      onChange([...attachments, ...added])
      if (added.length === 1) setOpenId(added[0].id)
    } catch (e) {
      await alertDialog(`資料の追加に失敗しました: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  function updateAttachment(next: NoteAttachment) {
    onChange(attachments.map(a => a.id === next.id ? next : a))
  }

  async function deleteAttachment(att: NoteAttachment) {
    if (!(await confirmDialog(`資料「${att.name || '(無名)'}」を削除しますか？`, { danger: true }))) return
    // メディア実体はここでは消さない — undo でノートごと戻せるよう、参照が
    // 消えたブロブは起動時の sweep（7日猶予）に任せる。
    onChange(attachments.filter(a => a.id !== att.id))
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
      <div className="flex items-center gap-2 flex-wrap">
        <Paperclip size={14} className="text-slate-500 shrink-0" />
        <span className="text-[11px] text-slate-500 shrink-0">付随資料 {attachments.length}件</span>
        <button
          onClick={() => pickFiles()}
          disabled={busy}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] border border-slate-300 text-slate-600 bg-white hover:bg-slate-100 transition-colors disabled:opacity-50"
        >
          {busy ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />} 追加
        </button>
        <span className="text-[10px] text-slate-400">ファイルをここにドロップでも追加できます</span>
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
              const kind = kindOf(att)
              const Icon = KIND_ICON[kind]
              const isOpen = openId === att.id
              return (
                <button
                  key={att.id}
                  onClick={() => setOpenId(isOpen ? null : att.id)}
                  title={`${att.name}${att.size ? ` (${formatSize(att.size)})` : ''} — クリックでプレビュー`}
                  className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] border transition-all max-w-[220px] ${
                    isOpen
                      ? 'border-indigo-300 bg-indigo-50 text-indigo-700'
                      : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-100'
                  }`}
                >
                  <Icon size={12} className={`shrink-0 ${KIND_TINT[kind]}`} />
                  <span className="truncate">{att.name || '(無名)'}</span>
                </button>
              )
            })}
          </div>
        </div>
      ))}
      {attachments.length === 0 && (
        <p className="mt-1 text-[10px] text-slate-400">MTGの先方資料や自分の作成資料（PDF・画像・動画など）をこのノートに添付できます</p>
      )}
      {openAttachment && (
        <AttachmentDetail
          att={openAttachment}
          groups={groupNames}
          onUpdate={updateAttachment}
          onDelete={() => deleteAttachment(openAttachment)}
          onClose={() => setOpenId(null)}
        />
      )}
    </div>
  )
}
