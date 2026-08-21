// タスクの「資料」フィールド — ファイルライブラリ (FileItem) への参照リンクを
// 管理する。LinkedNotesField と同じUX: チップ行 + `+` でピッカー（検索 + 新規
// アップロード）。カンバンのタスク編集とガントの編集ポップオーバーの両方で使う。
// チップクリックでライブラリのライトボックスへジャンプ（プレビューはそちらで）。
import { useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, Share2, Loader2 } from 'lucide-react'
import { FileItem, Task } from '../types'
import { useApp } from '../store'
import { generateId } from '../utils'
import { putMedia } from '../persistence/media'
import { isImageFile, normalizeImageBlob } from '../utils/image'
import { fileKind, FILE_KIND_ICON, FILE_KIND_TINT, formatSize } from '../utils/fileKind'
import { alertDialog } from './ConfirmDialog'

export default function LinkedFilesField({ task, onChange }: {
  task: Task
  onChange: (fileIds: string[]) => void
}) {
  const { state, dispatch } = useApp()
  const navigate = useNavigate()
  const active = state.activeMasterProjectId
  // このプロジェクトで使えるファイル: 所有 + 他プロジェクトからの参照リンク
  const filesInScope = useMemo(
    () => state.files
      .filter(f => f.masterProjectId === active || (f.linkedMasterIds ?? []).includes(active))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [state.files, active]
  )
  const linkedIds = task.fileIds ?? []
  const linkedFiles = useMemo(() => {
    const m = new Map(state.files.map(f => [f.id, f]))
    return linkedIds.map(id => m.get(id)).filter((f): f is FileItem => !!f)
  }, [linkedIds, state.files])
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return filesInScope
    return filesInScope.filter(f =>
      f.name.toLowerCase().includes(q) || f.tags.some(t => t.toLowerCase().includes(q)) || (f.comment || '').toLowerCase().includes(q))
  }, [filesInScope, query])

  function toggle(id: string) {
    const has = linkedIds.includes(id)
    onChange(has ? linkedIds.filter(x => x !== id) : [...linkedIds, id])
  }

  // 新しいファイルをアップロードしてライブラリ登録＋このタスクへリンク
  async function uploadAndLink(fileList: FileList) {
    const list = [...fileList]
    if (list.length === 0 || !active) return
    setBusy(true)
    try {
      const ids: string[] = []
      for (const f of list) {
        const blob = isImageFile(f) ? await normalizeImageBlob(f) : f
        const url = await putMedia(blob)
        const item: FileItem = {
          id: generateId(), masterProjectId: active, name: f.name, url,
          mime: blob.type || f.type || '', size: blob.size, tags: [],
          createdAt: new Date().toISOString(),
        }
        dispatch({ type: 'ADD_FILE_ITEM', payload: item })
        ids.push(item.id)
      }
      onChange([...linkedIds, ...ids])
    } catch (e) {
      await alertDialog(`ファイルの追加に失敗しました: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-start gap-1.5 text-[11px] text-slate-500">
      <span className="shrink-0 mt-0.5">資料</span>
      <div className="flex-1 flex flex-wrap gap-1 min-w-0">
        {linkedFiles.map(f => {
          const kind = fileKind(f.mime, f.name)
          const Icon = FILE_KIND_ICON[kind]
          const external = f.masterProjectId !== active
          return (
            <span key={f.id} className="inline-flex items-center gap-0.5 max-w-[150px] bg-orange-50 border border-orange-200 text-orange-700 rounded px-1.5 py-0.5 text-[10px]">
              {external ? <Share2 size={9} className="shrink-0" /> : <Icon size={9} className={`shrink-0 ${FILE_KIND_TINT[kind]}`} />}
              <button
                onClick={() => navigate('/files', { state: { focusFileId: f.id } })}
                className="truncate hover:underline"
                title={`${f.name}${f.comment ? `\n${f.comment}` : ''} — ライブラリで開く`}
              >{f.name || '(無名)'}</button>
              <button onClick={() => toggle(f.id)} className="text-orange-400 hover:text-rose-500 -mr-0.5" title="リンクを外す">×</button>
            </span>
          )
        })}
        {linkedFiles.length === 0 && <span className="text-[10px] text-slate-400 italic self-center">(未リンク)</span>}
      </div>
      <details className="relative shrink-0">
        <summary className="list-none cursor-pointer w-5 h-5 rounded hover:bg-slate-100 flex items-center justify-center text-slate-400 hover:text-slate-700" title="ファイルをリンク">
          <Plus size={12} />
        </summary>
        <div className="absolute right-0 top-6 z-30 w-[280px] bg-white border border-slate-200 rounded-lg shadow-xl p-2"
             onClick={e => e.stopPropagation()}>
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="ファイルを検索…（名前/タグ/コメント）"
            className="w-full text-xs bg-slate-50 border border-slate-200 rounded px-2 py-1 outline-none focus:border-orange-400 mb-1"
          />
          <div className="max-h-[200px] overflow-y-auto">
            {filtered.length === 0 && <div className="text-[10px] text-slate-400 px-1 py-2">該当なし（「ファイル」ページで登録できます）</div>}
            {filtered.map(f => {
              const checked = linkedIds.includes(f.id)
              const kind = fileKind(f.mime, f.name)
              const Icon = FILE_KIND_ICON[kind]
              return (
                <label key={f.id} className={`flex items-center gap-2 px-1.5 py-1 hover:bg-slate-50 rounded cursor-pointer text-xs ${checked ? 'text-orange-700' : 'text-slate-600'}`}>
                  <input type="checkbox" checked={checked} onChange={() => toggle(f.id)} className="shrink-0" />
                  <Icon size={11} className={`shrink-0 ${FILE_KIND_TINT[kind]}`} />
                  <span className="truncate flex-1" title={f.comment || undefined}>{f.name || '(無名)'}</span>
                  <span className="shrink-0 text-[9px] text-slate-400 tabular-nums">{formatSize(f.size)}</span>
                  {f.masterProjectId !== active && <Share2 size={9} className="shrink-0 text-indigo-400" />}
                </label>
              )
            })}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={e => { if (e.target.files?.length) uploadAndLink(e.target.files); e.target.value = '' }}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={busy}
            className="w-full mt-1 text-[10px] px-2 py-1 rounded border border-dashed border-slate-300 text-slate-500 hover:border-orange-400 hover:text-orange-600 flex items-center justify-center gap-1 disabled:opacity-50"
          >
            {busy ? <Loader2 size={10} className="animate-spin" /> : <Plus size={10} />} 新しいファイルを登録してリンク
          </button>
        </div>
      </details>
    </div>
  )
}
