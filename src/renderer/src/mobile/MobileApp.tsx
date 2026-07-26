// Mobile (phone) shell for the remote client. Deliberately a small subset of the
// desktop app: capture & reference only — Notes / Tasks / Research / Search plus a
// tiny "today" home. Arranging tools (canvas, flow, mindtrain, sketch, gantt) are
// desktop-only; a phone gets quick input and lookup, not layout work.
//
// Data flows through the same AppProvider store as the desktop UI, so the existing
// remote persistence (debounced full-DB PUT, pull-on-focus sync) applies unchanged.
import { useMemo, useState } from 'react'
import { useApp } from '../store'
import { generateId } from '../utils'
import { isoToday, isoToDate } from '../utils/date'
import { MarkdownText } from '../components/MarkdownText'
import { ItineraryView } from '../components/ItineraryView'
import { parseItinerary, formatDayLabel } from '../utils/itinerary'
import type { Note, Task, ResearchItem } from '../types'
import {
  Home, FileText, CheckSquare, Globe, Search as SearchIcon, RefreshCw, Plus,
  ChevronDown, Check, Circle, CircleDot, CheckCircle2, ExternalLink, X, Pencil,
  Map as MapIcon, CalendarDays,
} from 'lucide-react'

type Tab = 'home' | 'notes' | 'tasks' | 'plan' | 'research' | 'search'

const TABS: { id: Tab; label: string; icon: typeof Home }[] = [
  { id: 'home', label: 'ホーム', icon: Home },
  { id: 'notes', label: 'ノート', icon: FileText },
  { id: 'tasks', label: 'タスク', icon: CheckSquare },
  { id: 'plan', label: '計画', icon: MapIcon },
  { id: 'research', label: 'リサーチ', icon: Globe },
  { id: 'search', label: '検索', icon: SearchIcon },
]

// Date-only task fields (startDate/endDate) are LOCAL calendar dates — parse and
// compare them with the shared local-date helpers, never via toISOString/new Date
// (both interpret in UTC and go off-by-one outside it). A start-only task counts
// as a 1-day item due on its startDate, same as the desktop agenda.
const taskDue = (t: Task): string | undefined => t.endDate ?? t.startDate

// Full timestamps (updatedAt etc.) → local M/D.
function fmtDate(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  return `${d.getMonth() + 1}/${d.getDate()}`
}

// Date-only YYYY-MM-DD strings → local M/D (no UTC drift).
function fmtDay(iso?: string): string {
  if (!iso) return ''
  const d = isoToDate(iso)
  if (isNaN(d.getTime())) return iso
  return `${d.getMonth() + 1}/${d.getDate()}`
}

function domainOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return url }
}

// ── Header: active project switcher + manual pull-sync ──
function Header() {
  const { state, dispatch, syncNow } = useApp()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const active = state.masterProjects.find(p => p.id === state.activeMasterProjectId)
  return (
    <header className="shrink-0 h-12 flex items-center gap-1 px-3 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 relative z-30">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 min-w-0 px-2 py-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800"
      >
        <span className="font-bold text-sm truncate text-slate-800 dark:text-slate-100">{active?.name ?? 'Constella'}</span>
        <ChevronDown size={14} className="shrink-0 text-slate-400" />
      </button>
      <div className="flex-1" />
      <button
        onClick={async () => {
          if (busy) return
          setBusy(true)
          try { await syncNow() }
          catch (e) { console.error('sync failed', e); alert('同期に失敗しました。接続を確認してください。') }
          finally { setBusy(false) }
        }}
        title="最新データを取得"
        className="p-2 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
      >
        <RefreshCw size={16} className={busy ? 'animate-spin' : ''} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute top-12 left-2 z-50 w-64 max-h-[60vh] overflow-y-auto bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl py-1">
            {state.masterProjects.map(p => (
              <button
                key={p.id}
                onClick={() => { dispatch({ type: 'SET_ACTIVE_MASTER_PROJECT', payload: p.id }); setOpen(false) }}
                className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-left hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200"
              >
                <Check size={14} className={p.id === state.activeMasterProjectId ? 'opacity-100 text-indigo-500' : 'opacity-0'} />
                <span className="truncate">{p.name}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </header>
  )
}

// ── Note viewer/editor overlay (full screen) ──
function NoteOverlay({ noteId, startEditing, onClose }: { noteId: string; startEditing: boolean; onClose: () => void }) {
  const { state, dispatch } = useApp()
  const note = state.notes.find(n => n.id === noteId)
  const [editing, setEditing] = useState(startEditing)
  const [title, setTitle] = useState(note?.title ?? '')
  const [content, setContent] = useState(note?.content ?? '')
  if (!note) return null
  const save = () => {
    dispatch({ type: 'UPDATE_NOTE', payload: { ...note, title: title.trim() || '無題', content, updatedAt: new Date().toISOString() } })
    setEditing(false)
  }
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-white dark:bg-slate-900">
      <div className="shrink-0 h-12 flex items-center gap-1 px-2 border-b border-slate-200 dark:border-slate-800">
        <button onClick={onClose} className="p-2 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"><X size={18} /></button>
        <div className="flex-1 min-w-0 text-sm font-semibold truncate text-slate-800 dark:text-slate-100">{editing ? 'ノートを編集' : (note.title || '無題')}</div>
        {editing ? (
          <button onClick={save} className="px-3 py-1.5 rounded-lg bg-indigo-500 text-white text-xs font-semibold">保存</button>
        ) : (
          <button onClick={() => { setTitle(note.title); setContent(note.content); setEditing(true) }} className="p-2 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"><Pencil size={16} /></button>
        )}
      </div>
      {editing ? (
        <div className="flex-1 flex flex-col min-h-0 p-3 gap-2">
          <input
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="タイトル"
            className="shrink-0 w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm font-semibold text-slate-800 dark:text-slate-100 outline-none focus:border-indigo-400"
          />
          <textarea
            value={content}
            onChange={e => setContent(e.target.value)}
            placeholder="内容（Markdown可）"
            className="flex-1 w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm text-slate-800 dark:text-slate-100 outline-none focus:border-indigo-400 resize-none"
          />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-4">
          {note.content
            ? <MarkdownText value={note.content} readOnly />
            : <div className="text-sm text-slate-400">（内容なし）</div>}
        </div>
      )}
    </div>
  )
}

// ── Notes tab ──
function NotesTab({ openNote }: { openNote: (id: string, edit: boolean) => void }) {
  const { state, dispatch } = useApp()
  const active = state.activeMasterProjectId
  const notes = useMemo(() =>
    state.notes
      .filter(n => !n.archivedAt && (n.masterProjectId === active || (n.shared && n.refByMasterIds?.includes(active))))
      .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updatedAt.localeCompare(a.updatedAt)),
  [state.notes, active])
  const addNote = () => {
    const now = new Date().toISOString()
    const n: Note = { id: generateId(), masterProjectId: active, title: '', content: '', tags: [], createdAt: now, updatedAt: now }
    dispatch({ type: 'ADD_NOTE', payload: n })
    openNote(n.id, true)
  }
  return (
    <div className="flex-1 overflow-y-auto">
      {notes.length === 0 && <div className="p-8 text-center text-sm text-slate-400">ノートはまだありません</div>}
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {notes.map(n => (
          <li key={n.id}>
            <button onClick={() => openNote(n.id, false)} className="w-full px-4 py-3 text-left active:bg-slate-50 dark:active:bg-slate-800">
              <div className="flex items-center gap-2">
                {n.pinned && <span className="shrink-0 text-[10px] text-amber-500">📌</span>}
                <span className="text-sm font-medium text-slate-800 dark:text-slate-100 truncate">{n.title || '無題'}</span>
                <span className="ml-auto shrink-0 text-[10px] text-slate-400">{fmtDate(n.updatedAt)}</span>
              </div>
              {n.content && <div className="mt-0.5 text-xs text-slate-400 truncate">{n.content.replace(/[#*`>\-\[\]!]/g, '').slice(0, 80)}</div>}
            </button>
          </li>
        ))}
      </ul>
      <button
        onClick={addNote}
        className="fixed right-4 bottom-20 z-30 w-12 h-12 rounded-full bg-indigo-500 text-white shadow-lg flex items-center justify-center active:bg-indigo-600"
        style={{ marginBottom: 'env(safe-area-inset-bottom)' }}
        title="新規ノート"
      >
        <Plus size={22} />
      </button>
    </div>
  )
}

// ── Tasks tab ──
const STATUS_ICON = { 'todo': Circle, 'in-progress': CircleDot, 'done': CheckCircle2 } as const

function TaskRow({ projectId, task }: { projectId: string; task: Task }) {
  const { dispatch } = useApp()
  const Icon = STATUS_ICON[task.status]
  const due = taskDue(task)
  const overdue = task.status !== 'done' && due && due < isoToday()
  const toggle = () => {
    const done = task.status !== 'done'
    dispatch({
      type: 'UPDATE_TASK',
      payload: { projectId, task: { ...task, status: done ? 'done' : 'todo', completedAt: done ? new Date().toISOString() : undefined } },
    })
  }
  return (
    <div className="flex items-start gap-2.5 px-4 py-2.5">
      <button onClick={toggle} className={`shrink-0 mt-0.5 ${task.status === 'done' ? 'text-emerald-500' : task.status === 'in-progress' ? 'text-indigo-500' : 'text-slate-300 dark:text-slate-600'}`}>
        <Icon size={18} />
      </button>
      <div className="min-w-0 flex-1">
        <div className={`text-sm ${task.status === 'done' ? 'line-through text-slate-400' : 'text-slate-800 dark:text-slate-100'}`}>{task.title}</div>
        <div className="flex items-center gap-2 mt-0.5">
          {task.priority && <span className={`text-[10px] font-bold ${task.priority === 1 ? 'text-rose-500' : task.priority === 2 ? 'text-amber-500' : 'text-slate-400'}`}>P{task.priority}</span>}
          {due && <span className={`text-[10px] ${overdue ? 'text-rose-500 font-semibold' : 'text-slate-400'}`}>〜{fmtDay(due)}</span>}
        </div>
      </div>
    </div>
  )
}

// タスク追加シート — ボード選択（新規ボード作成も）+ 期日 + 優先度をまとめて指定
// して1タップで追加。ボードが無いプロジェクトでもここから作れる。
function AddTaskSheet({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useApp()
  const active = state.activeMasterProjectId
  const boards = useMemo(() => state.projects.filter(p => p.masterProjectId === active), [state.projects, active])
  const [boardId, setBoardId] = useState<string>(boards[0]?.id ?? '__new__')
  const [newBoard, setNewBoard] = useState('')
  const [title, setTitle] = useState('')
  const [due, setDue] = useState('') // '' = 期日なし / YYYY-MM-DD
  const [priority, setPriority] = useState(0) // 0 = なし
  const pad2 = (n: number) => String(n).padStart(2, '0')
  const today = isoToday()
  const tomorrow = (() => {
    const d = isoToDate(today)
    d.setDate(d.getDate() + 1)
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
  })()

  const add = () => {
    const t = title.trim()
    if (!t) return
    let pid = boardId
    if (pid === '__new__') {
      pid = generateId()
      dispatch({
        type: 'ADD_PROJECT',
        payload: { id: pid, masterProjectId: active, name: newBoard.trim() || '新しいボード', description: '', tasks: [], createdAt: new Date().toISOString() },
      })
    }
    const task: Task = {
      id: generateId(), title: t, description: '', status: 'todo', tags: [], createdAt: new Date().toISOString(),
      ...(due ? { endDate: due } : {}),
      ...(priority ? { priority: priority as Task['priority'] } : {}),
    }
    dispatch({ type: 'ADD_TASK', payload: { projectId: pid, task } })
    onClose()
  }

  const chip = (selected: boolean) =>
    `shrink-0 px-3 py-2 rounded-lg border text-sm transition-colors ${
      selected
        ? 'border-indigo-400 bg-indigo-50 dark:bg-indigo-500/20 text-indigo-600 dark:text-indigo-300 font-semibold'
        : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'
    }`

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      <div className="absolute inset-0 bg-slate-900/40" onClick={onClose} />
      <div
        className="relative bg-white dark:bg-slate-900 rounded-t-2xl p-4 space-y-3 shadow-2xl"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 16px)' }}
      >
        <div className="flex items-center">
          <h2 className="flex-1 text-sm font-bold text-slate-800 dark:text-slate-100">新しいタスク</h2>
          <button onClick={onClose} className="p-2 rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"><X size={18} /></button>
        </div>
        <input
          autoFocus
          value={title}
          onChange={e => setTitle(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') add() }}
          placeholder="タスク名"
          className="w-full px-3 py-2.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm outline-none focus:border-indigo-400 text-slate-800 dark:text-slate-100"
        />
        {/* ボード */}
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-1.5">ボード</div>
          <div className="flex gap-1.5 overflow-x-auto pb-1">
            {boards.map(b => (
              <button key={b.id} onClick={() => setBoardId(b.id)} className={chip(boardId === b.id)}>{b.name}</button>
            ))}
            <button onClick={() => setBoardId('__new__')} className={chip(boardId === '__new__')}>＋ 新規ボード</button>
          </div>
          {boardId === '__new__' && (
            <input
              value={newBoard}
              onChange={e => setNewBoard(e.target.value)}
              placeholder="ボード名"
              className="mt-1.5 w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm outline-none focus:border-indigo-400 text-slate-800 dark:text-slate-100"
            />
          )}
        </div>
        {/* 期日 */}
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-1.5">期日</div>
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
            <button onClick={() => setDue('')} className={chip(due === '')}>なし</button>
            <button onClick={() => setDue(today)} className={chip(due === today)}>今日</button>
            <button onClick={() => setDue(tomorrow)} className={chip(due === tomorrow)}>明日</button>
            <input
              type="date"
              value={due}
              onChange={e => setDue(e.target.value)}
              className={`shrink-0 px-2 py-1.5 rounded-lg border text-sm bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 ${
                due && due !== today && due !== tomorrow ? 'border-indigo-400' : 'border-slate-200 dark:border-slate-700'
              }`}
            />
          </div>
        </div>
        {/* 優先度 */}
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-1.5">優先度</div>
          <div className="flex gap-1.5">
            <button onClick={() => setPriority(0)} className={chip(priority === 0)}>なし</button>
            {[1, 2, 3].map(p => (
              <button key={p} onClick={() => setPriority(p)} className={chip(priority === p)}>
                <span className={p === 1 ? 'text-rose-500 font-bold' : p === 2 ? 'text-amber-500 font-bold' : ''}>P{p}</span>
              </button>
            ))}
          </div>
        </div>
        <button
          onClick={add}
          disabled={!title.trim()}
          className="w-full py-3 rounded-xl bg-indigo-500 text-white text-sm font-semibold disabled:opacity-40 active:bg-indigo-600"
        >
          追加
        </button>
      </div>
    </div>
  )
}

function TasksTab() {
  const { state, dispatch } = useApp()
  const active = state.activeMasterProjectId
  const projects = useMemo(() => state.projects.filter(p => p.masterProjectId === active), [state.projects, active])
  const [adding, setAdding] = useState<string | null>(null) // projectId with the quick-add open
  const [text, setText] = useState('')
  const [showDone, setShowDone] = useState<Record<string, boolean>>({})
  const [sheetOpen, setSheetOpen] = useState(false)
  const add = (projectId: string) => {
    const t = text.trim()
    if (!t) { setAdding(null); return }
    const task: Task = { id: generateId(), title: t, description: '', status: 'todo', tags: [], createdAt: new Date().toISOString() }
    dispatch({ type: 'ADD_TASK', payload: { projectId, task } })
    setText('')
  }
  return (
    <div className="flex-1 overflow-y-auto pb-24">
      {projects.length === 0 && <div className="p-8 text-center text-sm text-slate-400">ボードはまだありません</div>}
      {projects.map(p => {
        const undone = p.tasks.filter(t => t.status !== 'done')
        const done = p.tasks.filter(t => t.status === 'done')
        return (
          <section key={p.id} className="mb-2">
            <div className="sticky top-0 z-10 flex items-center gap-2 px-4 py-2 bg-slate-50/95 dark:bg-slate-950/95 backdrop-blur border-b border-slate-100 dark:border-slate-800">
              <h2 className="text-xs font-bold text-slate-500 dark:text-slate-400 truncate">{p.name}</h2>
              <span className="text-[10px] text-slate-400">{undone.length}</span>
              <button onClick={() => { setAdding(a => a === p.id ? null : p.id); setText('') }} className="ml-auto p-1 rounded text-slate-400 hover:text-indigo-500"><Plus size={16} /></button>
            </div>
            {adding === p.id && (
              <div className="px-4 py-2 flex gap-2">
                <input
                  autoFocus
                  value={text}
                  onChange={e => setText(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') add(p.id); if (e.key === 'Escape') setAdding(null) }}
                  placeholder="タスクを追加…"
                  className="flex-1 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm outline-none focus:border-indigo-400 text-slate-800 dark:text-slate-100"
                />
                <button onClick={() => add(p.id)} className="px-3 rounded-lg bg-indigo-500 text-white text-xs font-semibold">追加</button>
              </div>
            )}
            <div className="divide-y divide-slate-50 dark:divide-slate-800/60">
              {undone.map(t => <TaskRow key={t.id} projectId={p.id} task={t} />)}
            </div>
            {done.length > 0 && (
              <button onClick={() => setShowDone(s => ({ ...s, [p.id]: !s[p.id] }))} className="px-4 py-1.5 text-[11px] text-slate-400">
                完了 {done.length} 件 {showDone[p.id] ? '▲' : '▼'}
              </button>
            )}
            {showDone[p.id] && <div className="divide-y divide-slate-50 dark:divide-slate-800/60 opacity-60">
              {done.map(t => <TaskRow key={t.id} projectId={p.id} task={t} />)}
            </div>}
          </section>
        )
      })}
      {!sheetOpen && (
        <button
          onClick={() => setSheetOpen(true)}
          className="fixed right-4 bottom-20 z-30 w-12 h-12 rounded-full bg-indigo-500 text-white shadow-lg flex items-center justify-center active:bg-indigo-600"
          style={{ marginBottom: 'env(safe-area-inset-bottom)' }}
          title="タスクを追加"
        >
          <Plus size={22} />
        </button>
      )}
      {sheetOpen && <AddTaskSheet onClose={() => setSheetOpen(false)} />}
    </div>
  )
}

// ── Plan (計画) tab — 出張先で行程・eチケットを参照する閲覧専用ビュー ──
function PlanOverlay({ planId, onClose }: { planId: string; onClose: () => void }) {
  const { state } = useApp()
  const plan = state.plans.find(p => p.id === planId)
  if (!plan) return null
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-white">
      <div className="shrink-0 h-12 flex items-center gap-1 px-2 border-b border-slate-200">
        <button onClick={onClose} className="p-2 rounded-lg text-slate-500 hover:bg-slate-100"><X size={18} /></button>
        <div className="flex-1 min-w-0 text-sm font-semibold truncate text-slate-800">{plan.name || '無題の計画'}</div>
      </div>
      <div className="flex-1 overflow-y-auto overscroll-contain bg-white">
        <ItineraryView content={plan.content} fallbackTitle={plan.name} />
        <div className="h-8" style={{ marginBottom: 'env(safe-area-inset-bottom)' }} />
      </div>
    </div>
  )
}

function PlanTab({ openPlan }: { openPlan: (id: string) => void }) {
  const { state } = useApp()
  const active = state.activeMasterProjectId
  const plans = useMemo(() =>
    state.plans
      .filter(p => p.masterProjectId === active)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  [state.plans, active])
  // 一覧に日程チップを出すため軽くパース（計画数は少ない前提）。
  const summaries = useMemo(() => new Map(plans.map(p => {
    const it = parseItinerary(p.content)
    return [p.id, it] as const
  })), [plans])
  return (
    <div className="flex-1 overflow-y-auto">
      {plans.length === 0 && (
        <div className="p-8 text-center text-sm text-slate-400 leading-relaxed">
          計画はまだありません。<br />PC側の「計画」で撮影出張の行程を作成すると<br />ここから参照できます
        </div>
      )}
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {plans.map(p => {
          const it = summaries.get(p.id)
          return (
            <li key={p.id}>
              <button onClick={() => openPlan(p.id)} className="w-full px-4 py-3 text-left active:bg-slate-50 dark:active:bg-slate-800">
                <div className="flex items-center gap-2">
                  <MapIcon size={14} className="shrink-0 text-cyan-600" />
                  <span className="text-sm font-medium text-slate-800 dark:text-slate-100 truncate">{p.name || '無題の計画'}</span>
                  <span className="ml-auto shrink-0 text-[10px] text-slate-400">{fmtDate(p.updatedAt)}</span>
                </div>
                <div className="mt-1 flex items-center gap-2 pl-6">
                  {it?.firstDate && (
                    <span className="inline-flex items-center gap-1 text-[11px] text-indigo-600">
                      <CalendarDays size={11} />
                      {formatDayLabel(it.firstDate)}{it.lastDate && it.lastDate !== it.firstDate ? ` 〜 ${formatDayLabel(it.lastDate)}` : ''}
                    </span>
                  )}
                  {!!it?.eventCount && <span className="text-[10px] text-slate-400">{it.eventCount} 件の予定</span>}
                </div>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

// ── Research tab ──
function ResearchTab() {
  const { state, dispatch } = useApp()
  const active = state.activeMasterProjectId
  const items = useMemo(() =>
    state.research.filter(r => r.masterProjectId === active && !r.archivedAt).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  [state.research, active])
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState('')
  const [title, setTitle] = useState('')
  const add = () => {
    const u = url.trim()
    if (!u) return
    const item: ResearchItem = {
      id: generateId(), masterProjectId: active, title: title.trim() || domainOf(u), url: u,
      description: '', tags: [], category: 'その他', createdAt: new Date().toISOString(),
    }
    dispatch({ type: 'ADD_RESEARCH', payload: item })
    setUrl(''); setTitle(''); setOpen(false)
  }
  return (
    <div className="flex-1 overflow-y-auto pb-24">
      {open && (
        <div className="p-3 space-y-2 border-b border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-900">
          <input value={url} onChange={e => setUrl(e.target.value)} placeholder="URL" inputMode="url"
            className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm outline-none focus:border-indigo-400 text-slate-800 dark:text-slate-100" />
          <input value={title} onChange={e => setTitle(e.target.value)} placeholder="タイトル（省略可）"
            onKeyDown={e => { if (e.key === 'Enter') add() }}
            className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm outline-none focus:border-indigo-400 text-slate-800 dark:text-slate-100" />
          <div className="flex gap-2 justify-end">
            <button onClick={() => setOpen(false)} className="px-3 py-1.5 rounded-lg text-xs text-slate-500">キャンセル</button>
            <button onClick={add} className="px-3 py-1.5 rounded-lg bg-indigo-500 text-white text-xs font-semibold">追加</button>
          </div>
        </div>
      )}
      {items.length === 0 && !open && <div className="p-8 text-center text-sm text-slate-400">リサーチはまだありません</div>}
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {items.map(r => (
          <li key={r.id}>
            <a href={r.url} target="_blank" rel="noreferrer" className="flex items-start gap-2.5 px-4 py-3 active:bg-slate-50 dark:active:bg-slate-800">
              <ExternalLink size={14} className="shrink-0 mt-0.5 text-slate-300 dark:text-slate-600" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-slate-800 dark:text-slate-100 truncate">{r.title}</div>
                <div className="text-[11px] text-slate-400 truncate">{domainOf(r.url)}{r.tags.length > 0 && ` ・ ${r.tags.join(', ')}`}</div>
              </div>
            </a>
          </li>
        ))}
      </ul>
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="fixed right-4 bottom-20 z-30 w-12 h-12 rounded-full bg-indigo-500 text-white shadow-lg flex items-center justify-center active:bg-indigo-600"
          style={{ marginBottom: 'env(safe-area-inset-bottom)' }}
          title="URLを追加"
        >
          <Plus size={22} />
        </button>
      )}
    </div>
  )
}

// ── Search tab ──
function SearchTab({ openNote, goTab }: { openNote: (id: string, edit: boolean) => void; goTab: (t: Tab) => void }) {
  const { state } = useApp()
  const active = state.activeMasterProjectId
  const [q, setQ] = useState('')
  const query = q.trim().toLowerCase()
  const hit = (s?: string) => !!s && s.toLowerCase().includes(query)
  const results = useMemo(() => {
    if (!query) return null
    const notes = state.notes.filter(n => !n.archivedAt && n.masterProjectId === active && (hit(n.title) || hit(n.content))).slice(0, 20)
    const tasks: { projectId: string; projectName: string; task: Task }[] = []
    for (const p of state.projects.filter(p => p.masterProjectId === active)) {
      for (const t of p.tasks) if (hit(t.title) || hit(t.description)) tasks.push({ projectId: p.id, projectName: p.name, task: t })
    }
    const research = state.research.filter(r => !r.archivedAt && r.masterProjectId === active && (hit(r.title) || hit(r.description) || hit(r.url))).slice(0, 20)
    return { notes, tasks: tasks.slice(0, 20), research }
  }, [query, state.notes, state.projects, state.research, active]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="sticky top-0 p-3 bg-white dark:bg-slate-900 border-b border-slate-100 dark:border-slate-800 z-10">
        <input
          autoFocus
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="ノート・タスク・リサーチを検索"
          className="w-full px-3 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm outline-none focus:border-indigo-400 text-slate-800 dark:text-slate-100"
        />
      </div>
      {results && (
        <div className="pb-8">
          {results.notes.length > 0 && <h3 className="px-4 pt-4 pb-1 text-[10px] font-bold uppercase tracking-wide text-slate-400">ノート</h3>}
          {results.notes.map(n => (
            <button key={n.id} onClick={() => openNote(n.id, false)} className="w-full px-4 py-2.5 text-left active:bg-slate-50 dark:active:bg-slate-800">
              <div className="text-sm font-medium text-slate-800 dark:text-slate-100 truncate">{n.title || '無題'}</div>
              <div className="text-xs text-slate-400 truncate">{n.content.slice(0, 70)}</div>
            </button>
          ))}
          {results.tasks.length > 0 && <h3 className="px-4 pt-4 pb-1 text-[10px] font-bold uppercase tracking-wide text-slate-400">タスク</h3>}
          {results.tasks.map(({ projectId, projectName, task }) => (
            <button key={task.id} onClick={() => goTab('tasks')} className="w-full px-4 py-2.5 text-left active:bg-slate-50 dark:active:bg-slate-800">
              <div className={`text-sm truncate ${task.status === 'done' ? 'line-through text-slate-400' : 'text-slate-800 dark:text-slate-100'}`}>{task.title}</div>
              <div className="text-xs text-slate-400 truncate">{projectName}</div>
            </button>
          ))}
          {results.research.length > 0 && <h3 className="px-4 pt-4 pb-1 text-[10px] font-bold uppercase tracking-wide text-slate-400">リサーチ</h3>}
          {results.research.map(r => (
            <a key={r.id} href={r.url} target="_blank" rel="noreferrer" className="block px-4 py-2.5 active:bg-slate-50 dark:active:bg-slate-800">
              <div className="text-sm font-medium text-slate-800 dark:text-slate-100 truncate">{r.title}</div>
              <div className="text-xs text-slate-400 truncate">{domainOf(r.url)}</div>
            </a>
          ))}
          {results.notes.length === 0 && results.tasks.length === 0 && results.research.length === 0 && (
            <div className="p-8 text-center text-sm text-slate-400">見つかりませんでした</div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Home tab: today's work at a glance ──
function HomeTab({ openNote, goTab }: { openNote: (id: string, edit: boolean) => void; goTab: (t: Tab) => void }) {
  const { state } = useApp()
  const active = state.activeMasterProjectId
  const t = isoToday()
  const { due, doing } = useMemo(() => {
    const due: { projectName: string; task: Task; projectId: string }[] = []
    const doing: { projectName: string; task: Task; projectId: string }[] = []
    for (const p of state.projects.filter(p => p.masterProjectId === active)) {
      for (const task of p.tasks) {
        if (task.status === 'done') continue
        const deadline = taskDue(task)
        if (deadline && deadline <= t) due.push({ projectName: p.name, task, projectId: p.id })
        else if (task.status === 'in-progress') doing.push({ projectName: p.name, task, projectId: p.id })
      }
    }
    due.sort((a, b) => (taskDue(a.task) ?? '').localeCompare(taskDue(b.task) ?? ''))
    return { due, doing }
  }, [state.projects, active, t])
  const recentNotes = useMemo(() =>
    state.notes
      .filter(n => !n.archivedAt && n.masterProjectId === active)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 5),
  [state.notes, active])
  const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <section className="mb-5">
      <h2 className="px-4 pb-1.5 text-[10px] font-bold uppercase tracking-wide text-slate-400">{title}</h2>
      <div className="mx-3 rounded-xl bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 divide-y divide-slate-50 dark:divide-slate-800/60 overflow-hidden">
        {children}
      </div>
    </section>
  )
  return (
    <div className="flex-1 overflow-y-auto py-4 bg-slate-50 dark:bg-slate-950">
      {due.length > 0 && (
        <Section title="期限切れ・今日まで">
          {due.map(({ projectName, task, projectId }) => <TaskRowLite key={task.id} projectId={projectId} projectName={projectName} task={task} onGo={() => goTab('tasks')} />)}
        </Section>
      )}
      <Section title="進行中">
        {doing.length === 0
          ? <div className="px-4 py-5 text-center text-xs text-slate-400">進行中のタスクはありません</div>
          : doing.map(({ projectName, task, projectId }) => <TaskRowLite key={task.id} projectId={projectId} projectName={projectName} task={task} onGo={() => goTab('tasks')} />)}
      </Section>
      <Section title="最近のノート">
        {recentNotes.length === 0
          ? <div className="px-4 py-5 text-center text-xs text-slate-400">ノートはまだありません</div>
          : recentNotes.map(n => (
            <button key={n.id} onClick={() => openNote(n.id, false)} className="w-full px-4 py-2.5 text-left active:bg-slate-50 dark:active:bg-slate-800">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-slate-800 dark:text-slate-100 truncate">{n.title || '無題'}</span>
                <span className="ml-auto shrink-0 text-[10px] text-slate-400">{fmtDate(n.updatedAt)}</span>
              </div>
            </button>
          ))}
      </Section>
    </div>
  )
}

// Home-screen task row: checkbox toggles done, body jumps to the tasks tab.
function TaskRowLite({ projectId, projectName, task, onGo }: { projectId: string; projectName: string; task: Task; onGo: () => void }) {
  const { dispatch } = useApp()
  const due = taskDue(task)
  const overdue = due && due < isoToday()
  const toggle = () => dispatch({
    type: 'UPDATE_TASK',
    payload: { projectId, task: { ...task, status: 'done', completedAt: new Date().toISOString() } },
  })
  return (
    <div className="flex items-center gap-2.5 px-4 py-2.5">
      <button onClick={toggle} className="shrink-0 text-slate-300 dark:text-slate-600 active:text-emerald-500"><Circle size={18} /></button>
      <button onClick={onGo} className="min-w-0 flex-1 text-left">
        <div className="text-sm text-slate-800 dark:text-slate-100 truncate">{task.title}</div>
        <div className="flex items-center gap-2 text-[10px] text-slate-400">
          <span className="truncate">{projectName}</span>
          {due && <span className={overdue ? 'text-rose-500 font-semibold' : ''}>〜{fmtDay(due)}</span>}
        </div>
      </button>
    </div>
  )
}

export default function MobileApp() {
  const [tab, setTab] = useState<Tab>('home')
  const [openedNote, setOpenedNote] = useState<{ id: string; edit: boolean } | null>(null)
  const [openedPlan, setOpenedPlan] = useState<string | null>(null)
  const openNote = (id: string, edit: boolean) => setOpenedNote({ id, edit })
  return (
    <div className="fixed inset-0 flex flex-col bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100">
      <Header />
      {tab === 'home' && <HomeTab openNote={openNote} goTab={setTab} />}
      {tab === 'notes' && <NotesTab openNote={openNote} />}
      {tab === 'tasks' && <TasksTab />}
      {tab === 'plan' && <PlanTab openPlan={setOpenedPlan} />}
      {tab === 'research' && <ResearchTab />}
      {tab === 'search' && <SearchTab openNote={openNote} goTab={setTab} />}
      <nav
        className="shrink-0 flex border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex-1 flex flex-col items-center gap-0.5 pt-2 pb-1.5 text-[10px] font-medium ${tab === id ? 'text-indigo-500' : 'text-slate-400'}`}
          >
            <Icon size={20} />
            {label}
          </button>
        ))}
      </nav>
      {openedNote && <NoteOverlay noteId={openedNote.id} startEditing={openedNote.edit} onClose={() => setOpenedNote(null)} />}
      {openedPlan && <PlanOverlay planId={openedPlan} onClose={() => setOpenedPlan(null)} />}
    </div>
  )
}
