// 作業ファイル(受け渡し)モーダル — シーンファイルのように作業単位を単一ファイルで
// 他人に渡し、返却を 3方向マージで取り込む。Sidebar の設定メニューから開く。
//   書き出し: アクティブプロジェクト内のユニットを選択 → .json(base は app_kv に控える)
//   取り込み: handoff → 専用プロジェクトとして追加 / return → base とマージ(競合は選択)
import { useEffect, useMemo, useRef, useState } from 'react'
import { X, Package, Upload, Download, CornerUpLeft } from 'lucide-react'
import { useApp } from '../store'
import {
  emptySelection, buildPackItems, packItemCount, exportHandoff, parsePack, receiveHandoff,
  exportReturn, computeReturnMerge, applyReturnMerge,
  loadHandoffIndex, loadRecvIndex,
  type HandoffSelection, type HandoffIndexEntry, type RecvIndexEntry, type PendingMerge, type MergeConflict,
} from '../persistence/handoff'

interface Props {
  open: boolean
  onClose: () => void
}

// 選択リストの1行(チェックボックス+ラベル)。
function Row({ checked, onToggle, label, indent, hint }: { checked: boolean; onToggle: () => void; label: string; indent?: boolean; hint?: string }) {
  return (
    <label className={`flex items-center gap-2 py-0.5 text-xs text-slate-700 hover:bg-slate-50 rounded cursor-pointer ${indent ? 'pl-6' : 'pl-1'}`}>
      <input type="checkbox" checked={checked} onChange={onToggle} className="accent-indigo-500" />
      <span className="truncate">{label}</span>
      {hint && <span className="text-[10px] text-slate-400 shrink-0">{hint}</span>}
    </label>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-2">
      <div className="text-[11px] font-semibold text-slate-500 mb-0.5">{title}</div>
      <div className="max-h-32 overflow-y-auto pr-1">{children}</div>
    </div>
  )
}

const CONFLICT_KIND_LABEL: Record<MergeConflict['kind'], string> = {
  'both-edited': '両方で変更',
  'they-edited-i-deleted': '相手が変更 / 自分は削除',
  'they-deleted-i-edited': '相手が削除 / 自分は変更',
}

export function HandoffModal({ open, onClose }: Props) {
  const { state, dispatch, getLatestState } = useApp()
  const active = state.activeMasterProjectId
  const [sel, setSel] = useState<HandoffSelection>(emptySelection)
  const [name, setName] = useState('')
  const [excludeVideos, setExcludeVideos] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [lent, setLent] = useState<HandoffIndexEntry[]>([])
  const [received, setReceived] = useState<RecvIndexEntry[]>([])
  const [pending, setPending] = useState<PendingMerge | null>(null)
  const [resolutions, setResolutions] = useState<MergeConflict[]>([])
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setSel(emptySelection())
    setNotice(null)
    setPending(null)
    const master = state.masterProjects.find(m => m.id === active)
    setName(master ? master.name : '作業ファイル')
    loadHandoffIndex().then(setLent).catch(() => { /* ignore */ })
    loadRecvIndex().then(setReceived).catch(() => { /* ignore */ })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // アクティブプロジェクト内のユニット一覧
  const units = useMemo(() => ({
    noteFolders: state.noteFolders.filter(f => f.masterProjectId === active && !f.parentId),
    notes: state.notes.filter(n => n.masterProjectId === active && !n.archivedAt),
    projects: state.projects.filter(p => p.masterProjectId === active),
    boards: state.canvasBoards.filter(b => b.projectId === active),
    looseTabs: state.canvasTabs.filter(t => t.projectId === active && !t.boardId),
    flows: state.flows.filter(f => f.masterProjectId === active),
    plans: state.plans.filter(p => p.masterProjectId === active),
    researchFolders: state.researchFolders.filter(f => f.masterProjectId === active && !f.parentId),
    research: state.research.filter(r => r.masterProjectId === active && !r.archivedAt),
    sketches: state.sketches.filter(s => s.masterProjectId === active),
  }), [state, active])

  const recvEntry = received.find(r => r.masterId === active)
  const selectedCount = useMemo(() => packItemCount(buildPackItems(state, sel)), [state, sel])

  if (!open) return null

  const toggle = (key: keyof HandoffSelection, id: string): void => {
    setSel(prev => {
      const next = { ...prev, [key]: new Set(prev[key]) }
      if (next[key].has(id)) next[key].delete(id)
      else next[key].add(id)
      return next
    })
  }

  const doExport = async (): Promise<void> => {
    setBusy('書き出し中…')
    try {
      await exportHandoff(state, sel, name.trim() || '作業ファイル', excludeVideos)
      setLent(await loadHandoffIndex())
      setSel(emptySelection())
      setNotice('書き出しました。生成されたファイルを相手に渡してください(返却ファイルはこの画面の「取り込み」で受け取ります)')
    } catch (e) {
      setNotice(String(e instanceof Error ? e.message : e))
    } finally { setBusy(null) }
  }

  const doReturnExport = async (): Promise<void> => {
    if (!recvEntry) return
    setBusy('書き出し中…')
    try {
      await exportReturn(state, recvEntry, excludeVideos)
      setNotice('返却ファイルを書き出しました。元の相手に渡してください')
    } catch (e) {
      setNotice(String(e instanceof Error ? e.message : e))
    } finally { setBusy(null) }
  }

  const doImport = async (file: File | undefined): Promise<void> => {
    if (!file) return
    setBusy('読み込み中…')
    setNotice(null)
    try {
      const pack = parsePack(await file.text())
      if (pack.kind === 'return') {
        // 返却 → 3方向マージ。貸出記録(base)が無いマシンでは受領として取り込む道を案内。
        try {
          const p = await computeReturnMerge(state, pack)
          if (p.result.conflicts.length === 0) {
            // 土台は「今」の状態(ここまでの await 中に入った編集を巻き戻さない)。
            const { patch, skipped } = await applyReturnMerge(p, [], getLatestState())
            dispatch({ type: 'APPLY_STATE_PATCH', payload: patch })
            const a = p.result.applied
            setLent(await loadHandoffIndex())
            setNotice(`返却を取り込みました(更新 ${a.updated} / 追加 ${a.added} / 削除 ${a.deleted})。Ctrl+Z で丸ごと取り消せます${skipped > 0 ? `
この画面を開いている間に変更された ${skipped} 件は、変更を失わないよう適用を見送りました` : ''}`)
          } else {
            setPending(p)
            setResolutions(p.result.conflicts.map(c => ({ ...c })))
          }
          return
        } catch (e) {
          setNotice(String(e instanceof Error ? e.message : e))
          return
        }
      }
      // 受領: 専用の新プロジェクトとして追加
      const { patch, master } = await receiveHandoff(getLatestState(), pack, getLatestState)
      dispatch({ type: 'APPLY_STATE_PATCH', payload: patch })
      setReceived(await loadRecvIndex())
      const omitted = pack.mediaOmitted?.length ? `(動画など ${pack.mediaOmitted.length} 件は同梱されていません)` : ''
      setNotice(`「${master.name}」として取り込みました${omitted}。作業後はこの画面から返却ファイルを書き出せます`)
    } catch (e) {
      setNotice(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy(null)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const applyWithResolutions = async (): Promise<void> => {
    if (!pending) return
    setBusy('マージ中…')
    try {
      // 適用の土台は「今」の状態(競合の選択中に進んだ編集を巻き戻さない)。
      const { patch, skipped } = await applyReturnMerge(pending, resolutions, getLatestState())
      dispatch({ type: 'APPLY_STATE_PATCH', payload: patch })
      const a = pending.result.applied
      setLent(await loadHandoffIndex())
      setNotice(`返却を取り込みました(更新 ${a.updated} / 追加 ${a.added} / 削除 ${a.deleted} + 競合 ${resolutions.length} 件を解決)。Ctrl+Z で丸ごと取り消せます${skipped > 0 ? `
この画面を開いている間に変更された ${skipped} 件は、変更を失わないよう適用を見送りました` : ''}`)
      setPending(null)
    } catch (e) {
      setNotice(String(e instanceof Error ? e.message : e))
    } finally { setBusy(null) }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-900/40" onMouseDown={onClose}>
      <div
        className="w-[560px] max-w-[94vw] max-h-[86vh] overflow-y-auto bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-2xl p-5"
        onMouseDown={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h2 className="flex items-center gap-2 text-base font-semibold text-slate-800 dark:text-slate-100">
            <Package size={17} /> 作業ファイル(受け渡し)
          </h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500"><X size={16} /></button>
        </div>

        {notice && <div className="mb-3 px-3 py-2 rounded-lg bg-indigo-50 border border-indigo-200 text-indigo-900 text-xs whitespace-pre-wrap">{notice}</div>}

        {pending ? (
          /* ── 競合の解決 ── */
          <div>
            <p className="text-xs text-slate-600 dark:text-slate-300 mb-2">
              「{pending.pack.name}」の返却と手元の変更が {resolutions.length} 件ぶつかっています。どちらを残すか選んでください(それ以外の変更は自動で取り込まれます)。
            </p>
            <div className="max-h-[46vh] overflow-y-auto border border-slate-200 dark:border-slate-700 rounded-lg divide-y divide-slate-100 dark:divide-slate-800 mb-3">
              {resolutions.map((c, i) => (
                <div key={c.key} className="px-3 py-2 flex items-center gap-2 text-xs">
                  <span className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500 shrink-0">{c.typeLabel}</span>
                  <span className="flex-1 min-w-0 truncate text-slate-700 dark:text-slate-200" title={c.label}>{c.label}</span>
                  <span className="text-[10px] text-slate-400 shrink-0">{CONFLICT_KIND_LABEL[c.kind]}</span>
                  <div className="flex rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden shrink-0">
                    {(['theirs', 'mine'] as const).map(r => (
                      <button
                        key={r}
                        onClick={() => setResolutions(prev => prev.map((x, j) => (j === i ? { ...x, resolution: r } : x)))}
                        className={`px-2 py-0.5 text-[11px] ${c.resolution === r ? 'bg-indigo-500 text-white' : 'bg-white dark:bg-slate-900 text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800'}`}
                      >
                        {r === 'theirs' ? '相手' : '自分'}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setPending(null)} className="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800">キャンセル</button>
              <button onClick={() => { void applyWithResolutions() }} disabled={!!busy} className="px-3 py-1.5 rounded-lg bg-indigo-500 text-white text-xs font-semibold hover:bg-indigo-600 disabled:opacity-50">
                {busy ?? 'この内容でマージ'}
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* ── 受け取ったプロジェクトの返却 ── */}
            {recvEntry && (
              <div className="mb-4 px-3 py-2.5 rounded-lg border border-amber-200 bg-amber-50 text-xs text-amber-900">
                <div className="mb-1.5">このプロジェクトは受け取った作業ファイル「{recvEntry.name}」です。作業が終わったら返却ファイルを書き出して相手に渡してください。</div>
                <button onClick={() => { void doReturnExport() }} disabled={!!busy} className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-amber-300 bg-white hover:bg-amber-100 font-semibold disabled:opacity-50">
                  <CornerUpLeft size={12} /> 返却ファイルを書き出し
                </button>
              </div>
            )}

            {/* ── 書き出し(貸出) ── */}
            <div className="mb-4 rounded-lg border border-slate-200 dark:border-slate-700 p-3">
              <div className="flex items-center gap-2 mb-2">
                <Download size={14} className="text-slate-500" />
                <span className="text-sm font-medium text-slate-700 dark:text-slate-200">渡す項目を選んで書き出し</span>
                <input
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="作業ファイル名"
                  className="ml-auto w-40 px-2 py-1 text-xs bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-700 dark:text-slate-200"
                />
              </div>
              <div className="grid grid-cols-2 gap-x-4">
                <div>
                  {(units.noteFolders.length > 0 || units.notes.length > 0) && (
                    <Section title="ノート">
                      {units.noteFolders.map(f => <Row key={f.id} checked={sel.noteFolderIds.has(f.id)} onToggle={() => toggle('noteFolderIds', f.id)} label={`📁 ${f.name}`} hint="配下ごと" />)}
                      {units.notes.map(n => <Row key={n.id} indent={!!n.folderId} checked={sel.noteIds.has(n.id)} onToggle={() => toggle('noteIds', n.id)} label={n.title || '(無題)'} />)}
                    </Section>
                  )}
                  {units.projects.length > 0 && (
                    <Section title="タスクボード">
                      {units.projects.map(p => <Row key={p.id} checked={sel.projectIds.has(p.id)} onToggle={() => toggle('projectIds', p.id)} label={p.name} hint={`${p.tasks.length}件`} />)}
                    </Section>
                  )}
                  {(units.boards.length > 0 || units.looseTabs.length > 0) && (
                    <Section title="キャンバス">
                      {units.boards.map(b => <Row key={b.id} checked={sel.canvasBoardIds.has(b.id)} onToggle={() => toggle('canvasBoardIds', b.id)} label={`🗂 ${b.name}`} hint="タブごと" />)}
                      {units.looseTabs.map(t => <Row key={t.id} checked={sel.canvasTabIds.has(t.id)} onToggle={() => toggle('canvasTabIds', t.id)} label={t.name} />)}
                    </Section>
                  )}
                  {units.sketches.length > 0 && (
                    <Section title="スケッチ">
                      {units.sketches.map(s => <Row key={s.id} checked={sel.sketchIds.has(s.id)} onToggle={() => toggle('sketchIds', s.id)} label={s.name} />)}
                    </Section>
                  )}
                </div>
                <div>
                  {units.flows.length > 0 && (
                    <Section title="フロー">
                      {units.flows.map(f => <Row key={f.id} checked={sel.flowIds.has(f.id)} onToggle={() => toggle('flowIds', f.id)} label={f.name} />)}
                    </Section>
                  )}
                  {units.plans.length > 0 && (
                    <Section title="計画">
                      {units.plans.map(p => <Row key={p.id} checked={sel.planIds.has(p.id)} onToggle={() => toggle('planIds', p.id)} label={p.name} />)}
                    </Section>
                  )}
                  {(units.researchFolders.length > 0 || units.research.length > 0) && (
                    <Section title="リサーチ">
                      {units.researchFolders.map(f => <Row key={f.id} checked={sel.researchFolderIds.has(f.id)} onToggle={() => toggle('researchFolderIds', f.id)} label={`📁 ${f.name}`} hint="配下ごと" />)}
                      {units.research.map(r => <Row key={r.id} indent={!!r.folderId} checked={sel.researchIds.has(r.id)} onToggle={() => toggle('researchIds', r.id)} label={r.title} />)}
                    </Section>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-3 mt-2 pt-2 border-t border-slate-100 dark:border-slate-800">
                <label className="flex items-center gap-1.5 text-[11px] text-slate-500 cursor-pointer">
                  <input type="checkbox" checked={excludeVideos} onChange={e => setExcludeVideos(e.target.checked)} className="accent-indigo-500" />
                  動画を同梱しない(ファイルを軽くする)
                </label>
                <span className="ml-auto text-[11px] text-slate-400">{selectedCount} 項目</span>
                <button
                  onClick={() => { void doExport() }}
                  disabled={!!busy || selectedCount === 0}
                  className="px-3 py-1.5 rounded-lg bg-indigo-500 text-white text-xs font-semibold hover:bg-indigo-600 disabled:opacity-50"
                >
                  {busy ?? '書き出し'}
                </button>
              </div>
            </div>

            {/* ── 取り込み ── */}
            <div className="mb-4 rounded-lg border border-slate-200 dark:border-slate-700 p-3">
              <div className="flex items-center gap-2">
                <Upload size={14} className="text-slate-500" />
                <span className="text-sm font-medium text-slate-700 dark:text-slate-200">作業ファイルを取り込み</span>
                <button
                  onClick={() => fileRef.current?.click()}
                  disabled={!!busy}
                  className="ml-auto px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
                >
                  ファイルを選択…
                </button>
              </div>
              <p className="mt-1.5 text-[11px] text-slate-400">
                受け取ったファイルは専用のプロジェクトとして追加されます。自分が渡したファイルの返却は、貸出時からの双方の変更を突き合わせて取り込みます(ぶつかった箇所だけ選択)。
              </p>
              <input ref={fileRef} data-handoff-file-input="1" type="file" accept="application/json,.json" className="hidden" onChange={e => { void doImport(e.target.files?.[0]) }} />
            </div>

            {/* ── 貸出中リスト ── */}
            {lent.length > 0 && (
              <div className="rounded-lg border border-slate-200 dark:border-slate-700 p-3">
                <div className="text-sm font-medium text-slate-700 dark:text-slate-200 mb-1.5">貸し出した作業ファイル</div>
                <div className="max-h-28 overflow-y-auto">
                  {lent.map(e => (
                    <div key={e.id + e.exportedAt} className="flex items-center gap-2 py-0.5 text-xs">
                      <span className="flex-1 min-w-0 truncate text-slate-600 dark:text-slate-300">{e.name}</span>
                      <span className="text-[10px] text-slate-400 shrink-0">{new Date(e.exportedAt).toLocaleDateString()}</span>
                      <span className={`text-[10px] shrink-0 ${e.returnedAt ? 'text-emerald-600' : 'text-amber-600'}`}>{e.returnedAt ? '返却済み' : '貸出中'}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
