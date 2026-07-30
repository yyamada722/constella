// 計画ページ (/plan) — アセット撮影の出張・ロケハンなどを TripMD 互換の markdown で
// 記述し、日別タイムラインとして表示する。eチケットの PDF は「添付」(idb: に取り込み)
// または「サーバー参照」(local: パス参照) としてリンクし、プレビューでクリック展開。
// サイドバーのフォルダーはノートと同じ操作感: FolderPlus で即作成→インライン改名、
// 行の D&D で出し入れ、ネスト、色スウォッチ。複製で「v2/v3…」のバージョン違いを作る。
import { useState, useMemo, useRef, useEffect } from 'react'
import {
  Plus, Trash2, Pencil, Eye, Columns2, Map as MapGlyph, Paperclip, HardDrive, CircleHelp,
  Copy, Folder, FolderPlus, ChevronDown, ChevronRight, FileDown,
} from 'lucide-react'
import { useApp } from '../store'
import { Plan, PlanFolder } from '../types'
import { generateId } from '../utils'
import { putMedia } from '../persistence/media'
import { localFileApi, localFileName, toLocalRef } from '../utils/localFile'
import { mdLink } from '../utils/mdLink'
import { ItineraryView } from '../components/ItineraryView'
import { confirmDialog, alertDialog } from '../components/ConfirmDialog'
import { exportPlanPdf, pdfApi } from '../utils/planPdf'
import { BOARD_COLOR_CLASSES } from '../utils/boardColor'
import { FolderColorSwatch } from '../components/FolderColorSwatch'

const TEMPLATE = `---
title: アセット撮影 出張計画
timezone: Asia/Tokyo
currency: JPY
---

## 2026-08-01

> [!NOTE] 持ち物
> カメラ本体 / 予備バッテリー / カラーチェッカー / 三脚 / ND フィルター

> [07:30] - [09:45] flight NH000 from 羽田空港^HND to 新千歳空港^CTS
> - price: JPY {28000}
> - note: eチケットは「添付」からPDFをリンク

> [11:00] hotel チェックイン :: ホテル名
> [13:00] - [17:00] shoot 街並みアセット撮影 at 撮影場所
> - note: フォトグラメトリ用に全周撮影

## 2026-08-02

> [09:00] - [12:00] scan 素材スキャン at ロケ地
> [pm] shopping 資料・小物調達
> [18:00] flight NH001 from 新千歳空港^CTS to 羽田空港^HND
> - price: JPY {28000}
`

const SYNTAX_HELP: [string, string][] = [
  ['## 2026-08-01', '日付見出し（@Asia/Tokyo でTZ指定可）'],
  ['> [09:00] shoot タイトル', '予定行（時刻+種別+内容）'],
  ['> [09:00] - [17:00] …', '時間の範囲'],
  ['> [am] / [pm] / []', 'おおまかな時刻・未定'],
  ['… from 羽田^HND to 新千歳^CTS', '出発地 → 到着地（^は略号バッジ）'],
  ['… at 場所  /  … :: 場所', '場所の指定'],
  ['> - price: JPY {28000*2}', '費用（{}内は計算式可・自動合計）'],
  ['> - note: メモ', '任意のメタデータ'],
  ['> [!NOTE] 持ち物', 'アラート（NOTE/TIP/WARNING/CAUTION）'],
  ['[名前](https://…)', 'リンク（クリックで内容をインライン表示）'],
  ['[チケット.pdf](idb:… / local:…)', '添付・サーバー参照（クリックでPDF等を展開）'],
]

const EVENT_TYPES = 'flight / train / bus / car / ferry / walk / hotel / meal / cafe / museum / activity / shoot / scan / location / meeting / shopping / prep'

export default function PlanPage() {
  const { state, dispatch } = useApp()
  const active = state.activeMasterProjectId
  const plans = useMemo(
    () => state.plans.filter(p => p.masterProjectId === active).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [state.plans, active]
  )
  const [selectedId, setSelectedId] = useState<string | null>(plans[0]?.id ?? null)
  const selected = plans.find(p => p.id === selectedId) ?? null
  // マスター切替や削除で選択が消えたら先頭へフォールバック。
  useEffect(() => {
    if (!selected && plans.length > 0) setSelectedId(plans[0].id)
    if (plans.length === 0 && selectedId) setSelectedId(null)
  }, [plans, selected, selectedId])

  const [viewMode, setViewMode] = useState<'edit' | 'split' | 'preview'>(() => {
    try {
      const v = localStorage.getItem('constella.plan.viewMode')
      return v === 'edit' || v === 'preview' ? v : 'split'
    } catch { return 'split' }
  })
  useEffect(() => { try { localStorage.setItem('constella.plan.viewMode', viewMode) } catch { /* ignore */ } }, [viewMode])

  const textRef = useRef<HTMLTextAreaElement>(null)
  const localApi = localFileApi()
  const canPdf = !!pdfApi()
  const [exporting, setExporting] = useState(false)

  // ── フォルダー（ノートのフォルダと同じ実体+操作感） ──
  const folders = useMemo(
    () => state.planFolders.filter(f => f.masterProjectId === active).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [state.planFolders, active]
  )
  const { rootFolders, childrenByParent } = useMemo(() => {
    const ids = new Set(folders.map(f => f.id))
    const childrenByParent = new Map<string, PlanFolder[]>()
    const rootFolders: PlanFolder[] = []
    for (const f of folders) {
      if (f.parentId && ids.has(f.parentId)) {
        const arr = childrenByParent.get(f.parentId) ?? []
        arr.push(f); childrenByParent.set(f.parentId, arr)
      } else rootFolders.push(f)
    }
    return { rootFolders, childrenByParent }
  }, [folders])
  const { plansByFolder, unfiledPlans } = useMemo(() => {
    const map = new Map<string, Plan[]>()
    const folderIds = new Set(folders.map(f => f.id))
    const unfiled: Plan[] = []
    for (const p of plans) {
      if (p.folderId && folderIds.has(p.folderId)) {
        const arr = map.get(p.folderId) ?? []
        arr.push(p); map.set(p.folderId, arr)
      } else unfiled.push(p)
    }
    return { plansByFolder: map, unfiledPlans: unfiled }
  }, [plans, folders])

  const [openFolders, setOpenFolders] = useState<Set<string>>(() => new Set())
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null)
  const [folderNameDraft, setFolderNameDraft] = useState('')
  // D&D — フォルダのハイライトとドラッグ中の対象（再レンダー抑制のため ref）。
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null)
  const [dragOverRoot, setDragOverRoot] = useState(false)
  const draggingRef = useRef<{ kind: 'plan' | 'folder'; id: string } | null>(null)

  const update = (patch: Partial<Plan>) => {
    if (!selected) return
    dispatch({ type: 'UPDATE_PLAN', payload: { ...selected, ...patch, updatedAt: new Date().toISOString() } })
  }

  const addPlan = () => {
    const now = new Date().toISOString()
    const p: Plan = { id: generateId(), masterProjectId: active, name: '新しい撮影計画', content: TEMPLATE, createdAt: now, updatedAt: now }
    dispatch({ type: 'ADD_PLAN', payload: p })
    setSelectedId(p.id)
    if (viewMode === 'preview') setViewMode('split')
  }

  const deletePlan = async (p: Plan) => {
    if (!(await confirmDialog(`計画「${p.name}」を削除します。よろしいですか？`))) return
    dispatch({ type: 'DELETE_PLAN', payload: p.id })
    if (selectedId === p.id) setSelectedId(null)
  }

  // 複製 — バージョン違いを作るための機能。「名前 v2」「名前 v3」… と採番する。
  const duplicatePlan = (p: Plan) => {
    const now = new Date().toISOString()
    const m = /^(.*?)\s+v(\d+)$/.exec(p.name)
    const base = m ? m[1] : p.name || '無題の計画'
    const used = new Set(plans.map(x => x.name))
    let n = m ? Number(m[2]) + 1 : 2
    while (used.has(`${base} v${n}`)) n++
    const copy: Plan = { ...p, id: generateId(), name: `${base} v${n}`, createdAt: now, updatedAt: now }
    dispatch({ type: 'ADD_PLAN', payload: copy })
    setSelectedId(copy.id)
    if (p.folderId) setOpenFolders(prev => { const x = new Set(prev); x.add(p.folderId as string); return x }) // 複製先が見えるよう展開
  }

  const doExportPdf = async () => {
    if (!selected || exporting) return
    setExporting(true)
    try {
      await exportPlanPdf(selected)
    } catch (e) {
      await alertDialog(`PDFの書き出しに失敗しました: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setExporting(false)
    }
  }

  // ── フォルダー操作（NotesPage と同じ流儀） ──
  const toggleFolder = (id: string) => {
    setOpenFolders(prev => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next })
  }

  const addFolder = (parentId?: string) => {
    if (!active) return
    const id = generateId()
    const folder: PlanFolder = { id, masterProjectId: active, name: '新しいフォルダ', createdAt: new Date().toISOString(), parentId }
    dispatch({ type: 'ADD_PLAN_FOLDER', payload: folder })
    setOpenFolders(prev => { const n = new Set(prev); n.add(id); if (parentId) n.add(parentId); return n })
    setEditingFolderId(id); setFolderNameDraft(folder.name)
  }

  const commitFolderRename = (f: PlanFolder) => {
    const name = folderNameDraft.trim()
    if (name && name !== f.name) dispatch({ type: 'UPDATE_PLAN_FOLDER', payload: { ...f, name } })
    setEditingFolderId(null); setFolderNameDraft('')
  }

  const deleteFolder = async (f: PlanFolder) => {
    const count = (plansByFolder.get(f.id) ?? []).length
    const msg = count > 0
      ? `フォルダ「${f.name}」を削除しますか？\n中の ${count} 件は未分類になります。`
      : `フォルダ「${f.name}」を削除しますか？`
    if (!(await confirmDialog(msg))) return
    dispatch({ type: 'DELETE_PLAN_FOLDER', payload: f.id })
    setOpenFolders(prev => { const n = new Set(prev); n.delete(f.id); return n })
  }

  // 循環チェック: target が source の子孫なら true。
  const isDescendantOf = (target: string, source: string): boolean => {
    const stack = [source]
    while (stack.length) {
      const id = stack.pop() as string
      const kids = childrenByParent.get(id) ?? []
      for (const k of kids) { if (k.id === target) return true; stack.push(k.id) }
    }
    return false
  }

  const handlePlanDragStart = (p: Plan, e: React.DragEvent) => {
    draggingRef.current = { kind: 'plan', id: p.id }
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', p.name || '無題の計画')
  }
  const handleFolderDragStart = (f: PlanFolder, e: React.DragEvent) => {
    draggingRef.current = { kind: 'folder', id: f.id }
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', f.name)
  }
  const handleFolderDragOver = (targetId: string, e: React.DragEvent) => {
    const drag = draggingRef.current
    if (!drag) return
    if (drag.kind === 'folder' && (drag.id === targetId || isDescendantOf(targetId, drag.id))) return
    e.preventDefault(); e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    if (dragOverFolderId !== targetId) setDragOverFolderId(targetId)
    if (dragOverRoot) setDragOverRoot(false)
  }
  const handleFolderDrop = (targetId: string, e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation()
    const drag = draggingRef.current
    draggingRef.current = null
    setDragOverFolderId(null)
    if (!drag) return
    if (drag.kind === 'plan') {
      const p = plans.find(x => x.id === drag.id)
      if (p && p.folderId !== targetId) {
        dispatch({ type: 'UPDATE_PLAN', payload: { ...p, folderId: targetId, updatedAt: new Date().toISOString() } })
      }
      setOpenFolders(prev => { const x = new Set(prev); x.add(targetId); return x })
    } else {
      if (drag.id === targetId || isDescendantOf(targetId, drag.id)) return
      const f = folders.find(x => x.id === drag.id)
      if (f && f.parentId !== targetId) dispatch({ type: 'UPDATE_PLAN_FOLDER', payload: { ...f, parentId: targetId } })
      setOpenFolders(prev => { const x = new Set(prev); x.add(targetId); return x })
    }
  }
  const handleRootDragOver = (e: React.DragEvent) => {
    if (!draggingRef.current) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (!dragOverRoot) setDragOverRoot(true)
    if (dragOverFolderId) setDragOverFolderId(null)
  }
  const handleRootDrop = (e: React.DragEvent) => {
    e.preventDefault()
    const drag = draggingRef.current
    draggingRef.current = null
    setDragOverRoot(false)
    if (!drag) return
    if (drag.kind === 'plan') {
      const p = plans.find(x => x.id === drag.id)
      if (p && p.folderId !== undefined) {
        dispatch({ type: 'UPDATE_PLAN', payload: { ...p, folderId: undefined, updatedAt: new Date().toISOString() } })
      }
    } else {
      const f = folders.find(x => x.id === drag.id)
      if (f && f.parentId !== undefined) dispatch({ type: 'UPDATE_PLAN_FOLDER', payload: { ...f, parentId: undefined } })
    }
  }
  const handleDragEnd = () => {
    draggingRef.current = null
    setDragOverFolderId(null)
    setDragOverRoot(false)
  }

  // ── caret 位置に markdown を挿入 ──
  const insertAtCaret = (text: string) => {
    if (!selected) return
    const ta = textRef.current
    const v = selected.content
    if (!ta) { update({ content: v + (v.endsWith('\n') || !v ? '' : '\n') + text }); return }
    const s = ta.selectionStart ?? v.length
    const e = ta.selectionEnd ?? s
    const next = v.slice(0, s) + text + v.slice(e)
    update({ content: next })
    requestAnimationFrame(() => {
      ta.focus()
      const pos = s + text.length
      ta.setSelectionRange(pos, pos)
    })
  }

  // 添付: ファイルを media ストアへ取り込み → [name](idb:…) を挿入
  const attachFile = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.onchange = async () => {
      const files = [...(input.files ?? [])]
      const parts: string[] = []
      for (const f of files) {
        try { parts.push(`[${f.name}](${await putMedia(f)})`) } catch { /* remote 等 */ }
      }
      if (parts.length) insertAtCaret(parts.join(' '))
    }
    input.click()
  }

  // サーバー参照: パスだけを保存する local: リンクを挿入（Electron のみ）
  const insertLocalRef = async () => {
    if (!localApi) return
    const paths = await localApi.pick().catch(() => null)
    if (!paths?.length) return
    // mdLink() bracket-wraps destinations with spaces — otherwise a path like
    // "C:\Trip Files\ticket.pdf" would not parse back out as a link at all.
    insertAtCaret(paths.map(p => mdLink(localFileName(p), toLocalRef(p))).join(' '))
  }

  const showEditor = viewMode !== 'preview' && !!selected
  const showPreview = viewMode !== 'edit' && !!selected

  const planRow = (p: Plan) => (
    <div
      key={p.id}
      onClick={() => setSelectedId(p.id)}
      draggable
      onDragStart={e => handlePlanDragStart(p, e)}
      onDragEnd={handleDragEnd}
      className={`group px-2 py-1.5 rounded-md cursor-pointer flex items-center gap-1 ${
        p.id === selectedId ? 'bg-cyan-50 border border-cyan-200' : 'border border-transparent hover:bg-slate-100'
      }`}
    >
      <div className="flex-1 min-w-0">
        <div className={`text-xs truncate ${p.id === selectedId ? 'text-cyan-800 font-medium' : 'text-slate-700'}`}>{p.name || '無題の計画'}</div>
        <div className="text-[9px] text-slate-400">{p.updatedAt.slice(0, 10)}</div>
      </div>
      <button
        onClick={e => { e.stopPropagation(); duplicatePlan(p) }}
        title="複製（バージョン違いを作成）"
        className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-slate-400 hover:bg-slate-200 hover:text-cyan-600 transition-all shrink-0"
      ><Copy size={12} /></button>
      <button
        onClick={e => { e.stopPropagation(); deletePlan(p) }}
        title="削除"
        className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-slate-400 hover:bg-rose-100 hover:text-rose-500 transition-all shrink-0"
      ><Trash2 size={12} /></button>
    </div>
  )

  const renderFolderNode = (folder: PlanFolder, depth: number) => {
    const folderPlans = plansByFolder.get(folder.id) ?? []
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
          className={`group relative flex items-center gap-1 px-1.5 py-1 rounded-md transition-colors ${
            isDropTarget ? 'bg-emerald-100/70 ring-2 ring-emerald-400 ring-inset' : (cls?.bgSoft ?? 'hover:bg-slate-100')
          }`}
          style={{ paddingLeft: 6 + depth * 12 }}
        >
          {cls && <span className={`absolute left-0 top-1 bottom-1 w-[3px] rounded-r-sm ${cls.stripe}`} />}
          <button
            onClick={() => toggleFolder(folder.id)}
            className="p-0.5 rounded hover:bg-slate-200 text-slate-500 shrink-0"
            title={isOpen ? '畳む' : '開く'}
          >{isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button>
          <Folder size={12} className={`shrink-0 ${cls?.text ?? 'text-amber-500'}`} />
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
              className="flex-1 min-w-0 px-1 py-0.5 text-xs border border-slate-300 rounded outline-none focus:border-amber-400 bg-transparent"
            />
          ) : (
            <button
              onClick={() => { setEditingFolderId(folder.id); setFolderNameDraft(folder.name) }}
              title="クリックで名前を編集"
              className="flex-1 min-w-0 truncate text-xs text-slate-700 text-left"
            >{folder.name}</button>
          )}
          <span className="text-[10px] text-slate-400 shrink-0">{folderPlans.length}</span>
          <FolderColorSwatch
            value={folder.color}
            onChange={next => dispatch({ type: 'UPDATE_PLAN_FOLDER', payload: { ...folder, color: next } })}
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
          <div className="space-y-0.5">
            {childFolders.map(c => renderFolderNode(c, depth + 1))}
            {folderPlans.map(p => (
              <div key={p.id} style={{ paddingLeft: (depth + 1) * 12 }}>
                {planRow(p)}
              </div>
            ))}
            {folderPlans.length === 0 && childFolders.length === 0 && (
              <p className="text-[10px] text-slate-400 px-2 py-1 italic" style={{ paddingLeft: 6 + (depth + 1) * 12 }}>（空）</p>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="h-full flex bg-white">
      {/* ── 計画リスト ── */}
      <div className="w-56 shrink-0 border-r border-slate-200 flex flex-col bg-slate-50/60">
        <div className="px-3 py-2.5 border-b border-slate-200 flex items-center justify-between">
          <span className="text-xs font-semibold text-slate-500 flex items-center gap-1.5"><MapGlyph size={13} className="text-cyan-600" /> 撮影計画</span>
          <div className="flex items-center">
            <button onClick={addPlan} title="新しい計画" className="p-1 rounded hover:bg-slate-200 text-slate-500 hover:text-cyan-600 transition-colors">
              <Plus size={15} />
            </button>
            <button onClick={() => addFolder()} title="フォルダを追加" className="p-1 rounded hover:bg-slate-200 text-slate-500 hover:text-amber-600 transition-colors">
              <FolderPlus size={15} />
            </button>
          </div>
        </div>
        <div
          onDragOver={handleRootDragOver}
          onDrop={handleRootDrop}
          onDragLeave={e => { if (e.currentTarget === e.target) setDragOverRoot(false) }}
          className={`flex-1 overflow-y-auto py-1 px-1.5 space-y-0.5 transition-colors ${dragOverRoot ? 'bg-amber-50/50' : ''}`}
        >
          {plans.length === 0 && folders.length === 0 && (
            <div className="px-3 py-6 text-[11px] text-slate-400 text-center leading-relaxed">
              計画がまだありません。<br />+ で撮影出張の行程を作成
            </div>
          )}
          {unfiledPlans.length > 0 && folders.length > 0 && (
            <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-slate-400">未分類</div>
          )}
          {unfiledPlans.map(p => planRow(p))}
          {rootFolders.map(f => renderFolderNode(f, 0))}
        </div>
      </div>

      {/* ── メイン ── */}
      <div className="flex-1 min-w-0 flex flex-col">
        {selected ? (
          <>
            {/* ヘッダ */}
            <div className="px-4 py-2 border-b border-slate-200 flex items-center gap-2">
              <input
                value={selected.name}
                onChange={e => update({ name: e.target.value })}
                placeholder="計画名"
                className="flex-1 min-w-0 text-sm font-semibold text-slate-800 bg-transparent outline-none focus:bg-slate-50 rounded px-1.5 py-1"
              />
              {/* 添付ボタン群（編集時のみ） */}
              {showEditor && (
                <>
                  <button
                    onClick={attachFile}
                    title="ファイルを添付（アプリ内に取り込み、[名前](idb:…) を挿入）"
                    className="flex items-center gap-1 px-2 py-1 rounded-md border border-slate-200 text-[11px] text-slate-600 hover:border-indigo-300 hover:text-indigo-600 transition-colors"
                  >
                    <Paperclip size={12} /> 添付
                  </button>
                  {localApi && (
                    <button
                      onClick={insertLocalRef}
                      title="サーバー / ローカルのファイルをパス参照でリンク（取り込まず [名前](local:パス) を挿入）"
                      className="flex items-center gap-1 px-2 py-1 rounded-md border border-slate-200 text-[11px] text-slate-600 hover:border-cyan-300 hover:text-cyan-600 transition-colors"
                    >
                      <HardDrive size={12} /> サーバー参照
                    </button>
                  )}
                  <details className="relative">
                    <summary className="list-none cursor-pointer p-1 rounded hover:bg-slate-100 text-slate-400 hover:text-slate-600 flex" title="記法ヘルプ">
                      <CircleHelp size={15} />
                    </summary>
                    <div className="absolute right-0 top-7 z-30 w-[380px] p-3 rounded-lg border border-slate-200 bg-white shadow-xl">
                      <div className="text-[11px] font-semibold text-slate-600 mb-2">記法（TripMD 互換）</div>
                      <div className="space-y-1">
                        {SYNTAX_HELP.map(([syn, desc]) => (
                          <div key={syn} className="flex items-start gap-2 text-[11px]">
                            <code className="shrink-0 px-1 py-0.5 rounded bg-slate-100 font-mono text-slate-600 text-[10px]">{syn}</code>
                            <span className="text-slate-500">{desc}</span>
                          </div>
                        ))}
                      </div>
                      <div className="mt-2 pt-2 border-t border-slate-100 text-[10px] text-slate-400 leading-relaxed">
                        種別の例: {EVENT_TYPES}
                      </div>
                    </div>
                  </details>
                </>
              )}
              {/* PDF 書き出し（Electron のみ）: 添付PDF・画像は目次付きの別紙ページとして展開 */}
              {canPdf && (
                <button
                  onClick={doExportPdf}
                  disabled={exporting}
                  title="この計画をPDFに書き出し（添付のPDF・画像は別紙ページ化し、目次から飛べます）"
                  className="flex items-center gap-1 px-2 py-1 rounded-md border border-slate-200 text-[11px] text-slate-600 hover:border-rose-300 hover:text-rose-600 transition-colors disabled:opacity-50"
                >
                  <FileDown size={12} /> {exporting ? '生成中…' : 'PDF'}
                </button>
              )}
              {/* 表示切替 */}
              <div className="flex rounded-md border border-slate-200 overflow-hidden">
                {([['edit', Pencil, '編集'], ['split', Columns2, '分割'], ['preview', Eye, 'プレビュー']] as const).map(([mode, Icon, label]) => (
                  <button
                    key={mode}
                    onClick={() => setViewMode(mode)}
                    title={label}
                    className={`px-2 py-1 flex items-center gap-1 text-[11px] transition-colors ${
                      viewMode === mode ? 'bg-cyan-50 text-cyan-700' : 'text-slate-500 hover:bg-slate-50'
                    }`}
                  >
                    <Icon size={12} /> {label}
                  </button>
                ))}
              </div>
            </div>

            {/* 本文 */}
            <div className="flex-1 min-h-0 flex">
              {showEditor && (
                <textarea
                  ref={textRef}
                  value={selected.content}
                  onChange={e => update({ content: e.target.value })}
                  spellCheck={false}
                  placeholder={'## 2026-08-01\n\n> [09:00] shoot 撮影内容 at 場所'}
                  className={`${showPreview ? 'w-1/2 border-r border-slate-200' : 'flex-1'} min-w-0 resize-none outline-none p-4 font-mono text-[12.5px] leading-relaxed text-slate-700 bg-slate-50/40`}
                />
              )}
              {showPreview && (
                <div className={`${showEditor ? 'w-1/2' : 'flex-1'} min-w-0 overflow-y-auto`}>
                  <ItineraryView content={selected.content} fallbackTitle={selected.name} />
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 text-slate-400">
            <MapGlyph size={40} className="opacity-30" />
            <div className="text-sm">撮影出張・ロケハンの行程を markdown で計画できます</div>
            <button
              onClick={addPlan}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-500/10 border border-cyan-500/30 text-cyan-600 hover:bg-cyan-500/20 transition-colors text-sm"
            >
              <Plus size={15} /> 撮影計画を作成
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
