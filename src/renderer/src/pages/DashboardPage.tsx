import { useMemo, useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Boxes, Activity, AlertTriangle, CheckCircle2, Circle, CircleDot, GanttChartSquare, Bell, CalendarClock } from 'lucide-react'
import { useApp, Action } from '../store'
import { Task, Project } from '../types'
import { BOARD_COLOR_CLASSES, boardColorFor } from '../utils/boardColor'
import { isoToday, daysBetween, addDaysIso } from '../utils/date'
import GanttView from './GanttView'

// Urgency buckets for the "やること" agenda / header alert.
type AgendaBucket = 'overdue' | 'today' | 'tomorrow' | 'soon'
interface AgendaItem { task: Task; board: Project; bIdx: number; masterId: string; masterName: string; due: string; bucket: AgendaBucket }
const BUCKET_ORDER: AgendaBucket[] = ['overdue', 'today', 'tomorrow', 'soon']
const BUCKET_META: Record<AgendaBucket, { label: string; head: string; chip: string }> = {
  overdue:  { label: '遅延',            head: 'bg-rose-50 text-rose-700 border-rose-100',     chip: 'text-rose-600' },
  today:    { label: '今日',            head: 'bg-orange-50 text-orange-700 border-orange-100', chip: 'text-orange-600' },
  tomorrow: { label: '明日',            head: 'bg-amber-50 text-amber-700 border-amber-100',  chip: 'text-amber-600' },
  soon:     { label: '近日（〜約1週間）', head: 'bg-sky-50 text-sky-700 border-sky-100',        chip: 'text-sky-600' },
}

// Cross-master-project dashboard. Aggregates task counts per master project, surfaces
// "this week", "slipping", and "undated" buckets so you can sanity-check load across
// every workspace without switching the active master project.
export default function DashboardPage() {
  const { state, dispatch } = useApp()
  const navigate = useNavigate()
  const today = useMemo(() => isoToday(), [])
  const weekEnd = useMemo(() => addDaysIso(today, 6), [today])
  const tomorrow = useMemo(() => addDaysIso(today, 1), [today])
  const soonEnd = useMemo(() => addDaysIso(today, 7), [today]) // 近日 = up to ~a week out

  // Cross-master agenda: every non-done, dated task that is overdue / due today /
  // tomorrow / soon, so the dashboard can surface "what must be done" at a glance.
  const agenda = useMemo(() => {
    const items: AgendaItem[] = []
    for (const master of state.masterProjects) {
      state.projects.filter(p => p.masterProjectId === master.id).forEach((board, bIdx) => {
        for (const t of board.tasks) {
          if (t.status === 'done') continue
          const due = t.endDate ?? t.startDate // end is the deadline; start-only = 1-day item
          if (!due) continue
          let bucket: AgendaBucket | null = null
          if (due < today) bucket = 'overdue'
          else if (due === today) bucket = 'today'
          else if (due === tomorrow) bucket = 'tomorrow'
          else if (due <= soonEnd) bucket = 'soon'
          if (!bucket) continue
          items.push({ task: t, board, bIdx, masterId: master.id, masterName: master.name, due, bucket })
        }
      })
    }
    return items
  }, [state.masterProjects, state.projects, today, tomorrow, soonEnd])
  const agendaCounts = useMemo(() => {
    const c: Record<AgendaBucket, number> = { overdue: 0, today: 0, tomorrow: 0, soon: 0 }
    for (const a of agenda) c[a.bucket]++
    return c
  }, [agenda])
  const urgentTotal = agendaCounts.overdue + agendaCounts.today + agendaCounts.tomorrow + agendaCounts.soon
  // Cross-master Gantt: aggregate every project across every master into one boards list.
  // Selection is local — clicking a bar surfaces a "詳細を編集" CTA that jumps to /projects.
  const allBoards = useMemo(() => state.projects, [state.projects])
  const [ganttSelectedId, setGanttSelectedId] = useState<string | null>(null)
  const selectedTaskWithMaster = useMemo(() => {
    if (!ganttSelectedId) return null
    for (const p of allBoards) {
      const t = p.tasks.find(x => x.id === ganttSelectedId)
      if (t) return { task: t, board: p, masterId: p.masterProjectId }
    }
    return null
  }, [allBoards, ganttSelectedId])
  function jumpToSelectedTask() {
    if (!selectedTaskWithMaster) return
    if (state.activeMasterProjectId !== selectedTaskWithMaster.masterId) {
      dispatch({ type: 'SET_ACTIVE_MASTER_PROJECT', payload: selectedTaskWithMaster.masterId })
    }
    navigate(`/projects?taskId=${selectedTaskWithMaster.task.id}`)
  }
  // View mode toggle — default is full-screen Gantt. "agenda" = やること list,
  // "summary" = per-master cards.
  const [view, setView] = useState<'gantt' | 'summary' | 'agenda'>(() => {
    try { const s = localStorage.getItem('constella.dashboard.view'); return (s === 'summary' || s === 'agenda') ? s : 'gantt' } catch { return 'gantt' }
  })
  useEffect(() => {
    try { localStorage.setItem('constella.dashboard.view', view) } catch { /* ignore */ }
  }, [view])

  // Group projects (boards) by master. Empty masters still show with an empty card.
  const byMaster = useMemo(() => {
    const m = new Map<string, { master: typeof state.masterProjects[number]; boards: Project[]; tasks: Task[] }>()
    for (const mp of state.masterProjects) m.set(mp.id, { master: mp, boards: [], tasks: [] })
    for (const p of state.projects) {
      const e = m.get(p.masterProjectId)
      if (e) { e.boards.push(p); for (const t of p.tasks) e.tasks.push(t) }
    }
    return [...m.values()]
  }, [state.masterProjects, state.projects])

  function statusCounts(tasks: Task[]) {
    let todo = 0, doing = 0, done = 0
    for (const t of tasks) {
      if (t.status === 'done') done++
      else if (t.status === 'in-progress') doing++
      else todo++
    }
    return { todo, doing, done }
  }
  function thisWeek(tasks: Task[]) {
    return tasks.filter(t => {
      const e = t.endDate || t.startDate
      if (!e) return false
      return e >= today && e <= weekEnd
    })
  }
  function slipping(tasks: Task[]) {
    return tasks.filter(t => {
      if (t.status === 'done') return false
      const e = t.endDate
      if (!e) return false
      return e < today
    })
  }
  function undated(tasks: Task[]) {
    return tasks.filter(t => !t.startDate && !t.endDate && t.status !== 'done')
  }
  function jumpToMaster(masterId: string) {
    if (state.activeMasterProjectId !== masterId) {
      dispatch({ type: 'SET_ACTIVE_MASTER_PROJECT', payload: masterId })
    }
    navigate('/projects')
  }
  function jumpToTask(masterId: string, taskId: string) {
    if (state.activeMasterProjectId !== masterId) {
      dispatch({ type: 'SET_ACTIVE_MASTER_PROJECT', payload: masterId })
    }
    navigate(`/projects?taskId=${taskId}`)
  }

  const grandTotal = useMemo(() => byMaster.reduce((n, m) => n + m.tasks.length, 0), [byMaster])

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-slate-50/50">
      <div className="h-14 flex items-center px-6 border-b border-slate-200 bg-white shrink-0 gap-3">
        <h2 className="text-lg font-semibold text-slate-800 flex items-center gap-2 min-w-0 truncate">
          <Activity size={18} className="text-emerald-500 shrink-0" /> ダッシュボード
        </h2>
        <span className="text-xs text-slate-400 truncate min-w-0">全プロジェクト横断: {byMaster.length} プロジェクト・{grandTotal} タスク</span>
        <div className="ml-auto flex items-center gap-3 shrink-0">
          {/* Urgency alert — always visible; jumps to the やること agenda. */}
          {urgentTotal > 0 && view !== 'agenda' && (
            <button
              onClick={() => setView('agenda')}
              title="やること（遅延・今日・明日・近日）を表示"
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-xs font-semibold transition-colors ${
                agendaCounts.overdue > 0 ? 'border-rose-300 bg-rose-50 text-rose-700 hover:bg-rose-100'
                  : agendaCounts.today > 0 ? 'border-orange-300 bg-orange-50 text-orange-700 hover:bg-orange-100'
                    : 'border-sky-300 bg-sky-50 text-sky-700 hover:bg-sky-100'}`}
            >
              <Bell size={14} className="shrink-0" />
              {agendaCounts.overdue > 0 && <span>遅延{agendaCounts.overdue}</span>}
              {agendaCounts.today > 0 && <span>今日{agendaCounts.today}</span>}
              {agendaCounts.tomorrow > 0 && <span>明日{agendaCounts.tomorrow}</span>}
              {agendaCounts.soon > 0 && <span className="font-medium opacity-80">近日{agendaCounts.soon}</span>}
            </button>
          )}
          {/* View toggle */}
          <div className="flex items-center rounded-md border border-slate-200 overflow-hidden text-xs">
            {([['agenda', 'やること', CalendarClock], ['gantt', 'ガント', GanttChartSquare], ['summary', 'プロジェクト別', Activity]] as const).map(([k, label, Icon]) => (
              <button
                key={k}
                onClick={() => setView(k)}
                className={`flex items-center gap-1 px-2.5 py-1 transition-colors ${view === k ? 'bg-emerald-500/15 text-emerald-600' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800'}`}
              >
                <Icon size={14} /> {label}
              </button>
            ))}
          </div>
          {view === 'gantt' && selectedTaskWithMaster && (
            <button
              onClick={jumpToSelectedTask}
              className="text-xs px-2.5 py-1 rounded bg-emerald-500 text-white hover:bg-emerald-600 max-w-[260px] truncate"
              title={selectedTaskWithMaster.task.title || '(無題)'}
            >
              {selectedTaskWithMaster.task.title || '(無題)'} を編集 →
            </button>
          )}
        </div>
      </div>
      {view === 'gantt' ? (
        <div className="flex-1 flex min-h-0 min-w-0">
          <GanttView boards={allBoards} selectedTaskId={ganttSelectedId} onSelectTask={setGanttSelectedId} groupByMaster masters={state.masterProjects} />
        </div>
      ) : view === 'agenda' ? (
        <div className="flex-1 overflow-y-auto p-6">
          <div className="max-w-2xl mx-auto space-y-4">
            {urgentTotal === 0 ? (
              <div className="text-center text-slate-400 py-24 flex flex-col items-center gap-2">
                <CheckCircle2 size={32} className="text-emerald-400" />
                <p className="text-sm">差し迫ったタスクはありません 🎉</p>
                <p className="text-xs">遅延・今日・明日・近日（約1週間先まで）の期限タスクがここに出ます。</p>
              </div>
            ) : (
              BUCKET_ORDER.map(bucket => {
                const items = agenda.filter(a => a.bucket === bucket).sort((a, b) => a.due.localeCompare(b.due))
                if (items.length === 0) return null
                const meta = BUCKET_META[bucket]
                return (
                  <div key={bucket} className="bg-white border border-slate-200 rounded-lg shadow-sm overflow-hidden">
                    <div className={`px-4 py-2 border-b flex items-center gap-2 ${meta.head}`}>
                      {bucket === 'overdue' ? <AlertTriangle size={14} /> : <CalendarClock size={14} />}
                      <span className="font-semibold text-sm">{meta.label}</span>
                      <span className="text-xs opacity-70">{items.length}件</span>
                    </div>
                    <div className="divide-y divide-slate-50">
                      {items.map(a => (
                        <AgendaRow key={a.task.id} item={a} today={today} multiMaster={byMaster.length > 1} dispatch={dispatch} onClick={() => jumpToTask(a.masterId, a.task.id)} />
                      ))}
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>
      ) : (
      <div className="flex-1 overflow-y-auto p-6 grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))' }}>
        {byMaster.map(({ master, boards, tasks }) => {
          const sc = statusCounts(tasks)
          const week = thisWeek(tasks)
          const slip = slipping(tasks)
          const und = undated(tasks)
          const isActive = master.id === state.activeMasterProjectId
          return (
            <div key={master.id} className={`bg-white border rounded-lg shadow-sm overflow-hidden ${isActive ? 'border-emerald-400' : 'border-slate-200'}`}>
              <button onClick={() => jumpToMaster(master.id)} className="w-full text-left px-4 py-3 border-b border-slate-100 hover:bg-slate-100 flex items-center gap-2">
                <Boxes size={16} className={isActive ? 'text-emerald-500' : 'text-indigo-500'} />
                <span className="font-medium text-slate-800 truncate flex-1">{master.name}</span>
                <span className="text-[10px] text-slate-400 shrink-0">{boards.length}ボード・{tasks.length}件</span>
              </button>
              {/* Status counts */}
              <div className="px-4 py-3 grid grid-cols-3 gap-2 border-b border-slate-100">
                <CountCell icon={<Circle size={12} />} label="未着手" value={sc.todo} colorClass="text-slate-600" />
                <CountCell icon={<CircleDot size={12} />} label="進行中" value={sc.doing} colorClass="text-amber-600" />
                <CountCell icon={<CheckCircle2 size={12} />} label="完了" value={sc.done} colorClass="text-emerald-600" />
              </div>
              {/* Buckets — only render if any */}
              {slip.length > 0 && (
                <Bucket title={<span className="flex items-center gap-1 text-rose-600"><AlertTriangle size={11} /> 遅延 {slip.length}件</span>}>
                  {slip.slice(0, 5).map(t => <TaskRow key={t.id} task={t} boards={boards} onClick={() => jumpToTask(master.id, t.id)} suffix={daysBetween(t.endDate!, today) + '日超過'} />)}
                </Bucket>
              )}
              {week.length > 0 && (
                <Bucket title={<span className="text-sky-600">今週 {week.length}件</span>}>
                  {week.slice(0, 5).map(t => <TaskRow key={t.id} task={t} boards={boards} onClick={() => jumpToTask(master.id, t.id)} suffix={t.endDate || t.startDate!} />)}
                </Bucket>
              )}
              {und.length > 0 && (
                <Bucket title={<span className="text-amber-600">未設定 {und.length}件</span>}>
                  {und.slice(0, 5).map(t => <TaskRow key={t.id} task={t} boards={boards} onClick={() => jumpToTask(master.id, t.id)} suffix="" />)}
                </Bucket>
              )}
              {slip.length === 0 && week.length === 0 && und.length === 0 && (
                <div className="px-4 py-6 text-xs text-slate-400 text-center">差し迫ったタスクはありません</div>
              )}
            </div>
          )
        })}
      </div>
      )}
    </div>
  )
}

function CountCell({ icon, label, value, colorClass }: { icon: React.ReactNode; label: string; value: number; colorClass: string }) {
  return (
    <div className={`flex flex-col items-start gap-0.5 ${colorClass}`}>
      <span className="flex items-center gap-1 text-[10px] text-slate-500">{icon} {label}</span>
      <span className="text-lg font-semibold">{value}</span>
    </div>
  )
}

function Bucket({ title, children }: { title: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="px-4 py-2 border-b border-slate-100 last:border-b-0">
      <div className="text-[11px] font-semibold mb-1">{title}</div>
      <div className="space-y-0.5">{children}</div>
    </div>
  )
}

function AgendaRow({ item, today, multiMaster, dispatch, onClick }: { item: AgendaItem; today: string; multiMaster: boolean; dispatch: React.Dispatch<Action>; onClick: () => void }) {
  const { task, board, bIdx, masterName, due, bucket } = item
  const cls = BOARD_COLOR_CLASSES[boardColorFor(board, bIdx)]
  // Due label: overdue → "N日超過", today/tomorrow → word, soon → "N日後 (M/D)".
  const dueLabel =
    bucket === 'overdue' ? `${daysBetween(due, today)}日超過`
      : bucket === 'today' ? '今日'
        : bucket === 'tomorrow' ? '明日'
          : `${daysBetween(today, due)}日後・${due.slice(5).replace('-', '/')}`
  // Quick status cycle (todo→in-progress→done→todo). Reaching 'done' drops the row
  // from the agenda (the filter excludes done) — intended. stopPropagation so the
  // row's jump-click doesn't also fire.
  const cycleStatus = (e: React.MouseEvent) => {
    e.stopPropagation()
    const next: Task['status'] = task.status === 'todo' ? 'in-progress' : task.status === 'in-progress' ? 'done' : 'todo'
    dispatch({ type: 'UPDATE_TASK', payload: { projectId: board.id, task: { ...task, status: next } } })
  }
  const statusDotCls =
    task.status === 'done' ? 'bg-emerald-500 border-emerald-500'
      : task.status === 'in-progress' ? 'bg-amber-400 border-amber-400'
        : 'bg-white border-slate-400'
  return (
    <button onClick={onClick} className="w-full flex items-center gap-2 px-4 py-2 hover:bg-slate-100 text-left">
      <span onClick={cycleStatus} title="クリックでステータス切替" className={`w-3.5 h-3.5 rounded-full border-2 shrink-0 cursor-pointer ${statusDotCls}`} />
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${cls.dot}`} />
      <span className="text-sm text-slate-800 truncate flex-1">{task.title || '(無題)'}</span>
      <span className="text-[11px] text-slate-400 truncate max-w-[160px] shrink-0">{multiMaster ? `${masterName} / ` : ''}{board.name}</span>
      <span className={`text-[11px] font-medium shrink-0 w-20 text-right ${BUCKET_META[bucket].chip}`}>{dueLabel}</span>
    </button>
  )
}

function TaskRow({ task, boards, onClick, suffix }: { task: Task; boards: Project[]; onClick: () => void; suffix: string }) {
  const board = boards.find(b => b.tasks.some(t => t.id === task.id))
  const bIdx = board ? boards.indexOf(board) : 0
  const color = board ? boardColorFor(board, bIdx) : 'slate' as const
  const cls = BOARD_COLOR_CLASSES[color]
  return (
    <button onClick={onClick} className="w-full flex items-center gap-2 px-1.5 py-1 rounded hover:bg-slate-100 text-left">
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${cls.dot}`} />
      <span className="text-xs text-slate-700 truncate flex-1">{task.title || '(無題)'}</span>
      <span className="text-[10px] text-slate-400 truncate max-w-[80px]">{board?.name}</span>
      {suffix && <span className="text-[10px] text-slate-400 shrink-0">{suffix}</span>}
    </button>
  )
}
