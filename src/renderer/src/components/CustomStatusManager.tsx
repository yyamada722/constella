import { useEffect, useRef, useState } from 'react'
import { Tags, Trash2, Plus } from 'lucide-react'
import { useApp } from '../store'
import { CustomStatus, Project, Task } from '../types'
import { generateId } from '../utils'
import { DEFAULT_STATUS_HEX, STATUS_HEX_PRESETS, statusHex, statusChipStyle } from '../utils/customStatus'
import { confirmDialog } from './ConfirmDialog'
import { usePopoverDismiss } from './usePopoverDismiss'

const BASE_LABEL: Record<Task['status'], string> = { 'todo': '未着手', 'in-progress': '進行中', 'done': '完了' }

// ボードのカスタムステータス (状態タグ) 管理ポップオーバー。
// 名前変更はボード内タスクのタグも追従させ、削除はタグごと外す — どちらも
// UPDATE_PROJECT 1 回なので 1 undo。
export default function CustomStatusManager({ project }: { project: Project }) {
  const { dispatch } = useApp()
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popRef = usePopoverDismiss<HTMLDivElement>(open, () => setOpen(false), triggerRef)
  const [newName, setNewName] = useState('')
  const [newBase, setNewBase] = useState<Task['status']>('in-progress')
  const [error, setError] = useState('')
  const defs = project.customStatuses ?? []

  const usage = (def: CustomStatus) => project.tasks.filter(t => t.status === def.base && t.tags.includes(def.name)).length

  // 定義更新 → タスク更新を BATCH で 1 undo に。タスク側は SET_PROJECT_TASKS を
  // 通すので状態遷移の記帳 (完了日時・進行中時計) と状態タグ正規化が新定義で走る。
  function commit(nextDefs: CustomStatus[], tasks?: Task[]) {
    const meta = { type: 'UPDATE_PROJECT' as const, payload: { ...project, customStatuses: nextDefs.length ? nextDefs : undefined } }
    if (!tasks) { dispatch(meta); return }
    dispatch({ type: 'BATCH', payload: [meta, { type: 'SET_PROJECT_TASKS', payload: { projectId: project.id, tasks } }] })
  }

  function add() {
    const name = newName.trim().replace(/^#/, '')
    if (!name) return
    if (defs.some(d => d.name === name)) { setError(`「${name}」は既にあります`); return }
    // 同じ基本状態の中で色が被らないよう、未使用の色を優先。
    const used = new Set(defs.map(d => statusHex(d.color)))
    const pref = DEFAULT_STATUS_HEX[newBase]
    const color = used.has(pref) ? (STATUS_HEX_PRESETS.find(c => !used.has(c)) ?? pref) : pref
    commit([...defs, { id: generateId(), name, base: newBase, color }])
    setNewName(''); setError('')
  }

  function rename(def: CustomStatus, raw: string) {
    const name = raw.trim().replace(/^#/, '')
    if (!name || name === def.name) return
    if (defs.some(d => d.id !== def.id && d.name === name)) { setError(`「${name}」は既にあります`); return }
    setError('')
    // 対象は「このステータスとして効いているタスク」だけ。基本状態が違うタスクの
    // 同名タグは普通のタグなので触らない。
    const tasks = project.tasks.map(t => t.status === def.base && t.tags.includes(def.name)
      ? { ...t, tags: Array.from(new Set(t.tags.map(x => x === def.name ? name : x))) }
      : t)
    commit(defs.map(d => d.id === def.id ? { ...d, name } : d), tasks)
  }

  function patch(def: CustomStatus, p: Partial<CustomStatus>) {
    commit(defs.map(d => d.id === def.id ? { ...d, ...p } : d))
  }

  // 基本状態を変えたら、そのタグを持つタスクも新しい基本状態へ寄せる
  // (そうしないと reducer の正規化で次の更新時にタグが外れてしまう)。
  function changeBase(def: CustomStatus, base: Task['status']) {
    const tasks = project.tasks.map(t => t.tags.includes(def.name) && t.status === def.base ? { ...t, status: base } : t)
    commit(defs.map(d => d.id === def.id ? { ...d, base } : d), tasks)
  }

  async function remove(def: CustomStatus) {
    const n = usage(def)
    if (n > 0 && !(await confirmDialog(`ステータス「${def.name}」を削除しますか？\n使用中の ${n} 件のタスクからも外れます（基本状態「${BASE_LABEL[def.base]}」は維持）。`, { danger: true, confirmLabel: '削除' }))) return
    const tasks = project.tasks.map(t => t.status === def.base && t.tags.includes(def.name) ? { ...t, tags: t.tags.filter(x => x !== def.name) } : t)
    commit(defs.filter(d => d.id !== def.id), tasks)
  }


  return (
    <div className="relative shrink-0">
      <button
        ref={triggerRef}
        onClick={() => setOpen(v => !v)}
        title="カスタムステータス（状態タグ）を管理"
        className={`flex items-center gap-1 px-2.5 py-1 rounded-md border text-xs transition-colors whitespace-nowrap ${open ? 'border-violet-300 bg-violet-50 text-violet-700' : 'border-slate-200 text-slate-600 hover:bg-slate-50 hover:text-slate-800 hover:border-slate-300'}`}
      >
        <Tags size={13} /> ステータス{defs.length > 0 && <span className="text-[10px] text-slate-400">({defs.length})</span>}
      </button>
      {open && (
        <div ref={popRef} className="absolute left-0 top-full mt-1 z-30 w-[340px] bg-white border border-slate-200 rounded-lg shadow-xl p-3 space-y-2">
          <p className="text-[11px] text-slate-500 leading-relaxed">
            基本状態（未着手 / 進行中 / 完了）を細分化する「状態タグ」です。タスクにはタグとして付き、カードのステータスピル横の ▾ から選べます。色の丸をクリックすると任意の色を設定できます。
          </p>
          {(['todo', 'in-progress', 'done'] as const).map(base => {
            const list = defs.filter(d => d.base === base)
            if (list.length === 0) return null
            return (
              <div key={base}>
                <div className="text-[10px] font-semibold text-slate-400 mb-1">{BASE_LABEL[base]}</div>
                <div className="space-y-1">
                  {list.map(def => {
                    return (
                      <div key={def.id} className="flex items-center gap-1.5">
                        <ColorDot value={statusHex(def.color)} onCommit={hex => patch(def, { color: hex })} />
                        <input
                          key={def.name}
                          defaultValue={def.name}
                          onBlur={e => rename(def, e.target.value)}
                          onKeyDown={e => {
                            if (e.nativeEvent.isComposing) return
                            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                            if (e.key === 'Escape') { (e.target as HTMLInputElement).value = def.name; (e.target as HTMLInputElement).blur() }
                          }}
                          style={statusChipStyle(def.color)}
                          className="flex-1 min-w-0 text-xs px-1.5 py-0.5 rounded border outline-none focus:ring-1 focus:ring-slate-300"
                        />
                        <select
                          value={def.base}
                          onChange={e => changeBase(def, e.target.value as Task['status'])}
                          className="text-[11px] bg-slate-50 border border-slate-200 rounded px-1 py-0.5 outline-none text-slate-600"
                        >
                          {(['todo', 'in-progress', 'done'] as const).map(b => <option key={b} value={b}>{BASE_LABEL[b]}</option>)}
                        </select>
                        <span className="text-[10px] text-slate-400 w-6 text-right tabular-nums" title="使用中のタスク数">{usage(def)}</span>
                        <button onClick={() => remove(def)} title="削除" className="p-0.5 rounded text-slate-400 hover:text-rose-500 hover:bg-rose-50">
                          <Trash2 size={12} />
                        </button>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
          <div className="flex items-center gap-1.5 pt-2 border-t border-slate-100">
            <input
              value={newName}
              onChange={e => { setNewName(e.target.value); setError('') }}
              onKeyDown={e => { if (!e.nativeEvent.isComposing && e.key === 'Enter') add() }}
              placeholder="例: レビュー待ち / 保留 / 確認中"
              className="flex-1 min-w-0 text-xs bg-slate-50 border border-slate-200 rounded px-1.5 py-1 outline-none focus:border-violet-400"
            />
            <select
              value={newBase}
              onChange={e => setNewBase(e.target.value as Task['status'])}
              className="text-[11px] bg-slate-50 border border-slate-200 rounded px-1 py-1 outline-none text-slate-600"
            >
              {(['todo', 'in-progress', 'done'] as const).map(b => <option key={b} value={b}>{BASE_LABEL[b]}</option>)}
            </select>
            <button onClick={add} disabled={!newName.trim()} className="flex items-center gap-0.5 text-xs px-2 py-1 rounded bg-violet-500 text-white hover:bg-violet-600 disabled:opacity-40">
              <Plus size={12} />追加
            </button>
          </div>
          {error && <p className="text-[11px] text-rose-500">{error}</p>}
          <p className="text-[10px] text-slate-400">既存のタグ名で作ると、そのタグを持つタスクがそのままこのステータスになります（基本状態が一致する場合）。</p>
        </div>
      )}
    </div>
  )
}

// 任意色ピッカー。ドラッグ中 (input イベント) はローカルにプレビューだけ反映し、
// ピッカーを閉じた時の native change で 1 回だけ確定 → undo 履歴が 1 段で済む。
function ColorDot({ value, onCommit }: { value: string; onCommit: (hex: string) => void }) {
  const [local, setLocal] = useState(value)
  const ref = useRef<HTMLInputElement>(null)
  const commitRef = useRef(onCommit); commitRef.current = onCommit
  useEffect(() => setLocal(value), [value])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onChange = () => { if (el.value.toLowerCase() !== value) commitRef.current(el.value.toLowerCase()) }
    el.addEventListener('change', onChange)
    return () => el.removeEventListener('change', onChange)
  }, [value])
  return (
    <label title="クリックで色を選択" className="relative w-4 h-4 rounded-full shrink-0 cursor-pointer ring-1 ring-black/10 overflow-hidden" style={{ backgroundColor: local }}>
      <input ref={ref} type="color" value={local} onInput={e => setLocal((e.target as HTMLInputElement).value)} onChange={() => { /* committed on native change */ }} className="absolute inset-0 opacity-0 cursor-pointer" />
    </label>
  )
}
