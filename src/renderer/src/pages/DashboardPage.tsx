import { useMemo, useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Boxes, Activity, AlertTriangle, CheckCircle2, Circle, CircleDot, GanttChartSquare, Bell, CalendarClock, SlidersHorizontal, Search, ArrowDownWideNarrow, ChevronDown, ChevronRight, Files } from 'lucide-react'
import { fileKind, FILE_KIND_ICON, FILE_KIND_TINT } from '../utils/fileKind'
import { useApp, Action } from '../store'
import { Task, Project } from '../types'
import { BOARD_COLOR_CLASSES, boardColorFor } from '../utils/boardColor'
import { isoToday, daysBetween, addDaysIso } from '../utils/date'
import { aggregateFor } from '../utils/taskTree'
import { usePopoverDismiss } from '../components/usePopoverDismiss'
import GanttView from './GanttView'

// Urgency buckets for the "やること" agenda / header alert.
type AgendaBucket = 'overdue' | 'today' | 'tomorrow' | 'soon'
interface AgendaItem { task: Task; board: Project; bIdx: number; masterId: string; masterName: string; due: string; bucket: AgendaBucket; effStatus: Task['status']; hasChildren: boolean }

// Effective status per task: parents mirror their child aggregate — the same status the
// gantt/kanban display — so a parent whose children are all done never counts as overdue
// even if its own raw status was left at todo. Leaves use their own status.
// Cached per pool array (WeakMap keyed on the array reference — state updates produce
// new arrays, invalidating naturally): the buckets, the sort and the agenda all hit the
// same pool several times per render, and aggregateFor rebuilds its child map per call.
interface EffStatus { statusOf: (t: Task) => Task['status']; hasChildren: (t: Task) => boolean }
const effCache = new WeakMap<Task[], EffStatus>()
function effStatusLookup(pool: Task[]): EffStatus {
  const hit = effCache.get(pool)
  if (hit) return hit
  const known = new Set(pool.map(t => t.id))
  const parentIds = new Set<string>()
  for (const t of pool) if (t.parentId && known.has(t.parentId)) parentIds.add(t.parentId)
  const statusCache = new Map<string, Task['status']>()
  const api: EffStatus = {
    statusOf: t => {
      if (!parentIds.has(t.id)) return t.status
      let s = statusCache.get(t.id)
      if (!s) { s = aggregateFor(pool, t).status; statusCache.set(t.id, s) }
      return s
    },
    hasChildren: t => parentIds.has(t.id),
  }
  effCache.set(pool, api)
  return api
}
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

  // Archived (finished) master projects are excluded from every dashboard view —
  // they stay reachable from the sidebar switcher's archive section.
  const liveMasters = useMemo(() => state.masterProjects.filter(m => !m.archivedAt), [state.masterProjects])
  const liveProjects = useMemo(() => {
    const ids = new Set(liveMasters.map(m => m.id))
    return state.projects.filter(p => ids.has(p.masterProjectId))
  }, [state.projects, liveMasters])

  // Master-project filter — narrows every dashboard view (gantt / agenda / summary)
  // to the checked masters. Empty set = show all. Persisted; stale ids (deleted
  // masters) are dropped on read, and "everything checked" collapses back to "all".
  const [masterFilter, setMasterFilter] = useState<Set<string>>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem('constella.dashboard.masterFilter') || '[]')
      return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [])
    } catch { return new Set() }
  })
  useEffect(() => {
    try { localStorage.setItem('constella.dashboard.masterFilter', JSON.stringify([...masterFilter])) } catch { /* ignore */ }
  }, [masterFilter])
  const activeFilter = useMemo(() => {
    const ids = new Set(liveMasters.map(m => m.id))
    const v = new Set([...masterFilter].filter(id => ids.has(id)))
    return v.size === 0 || v.size === liveMasters.length ? new Set<string>() : v
  }, [masterFilter, liveMasters])
  // Prune ids that stopped being live (deleted/archived masters) from the STORED set
  // too — sanitizing only the derived value would leave a stale id in localStorage
  // that silently re-activates the old filter when the project is restored.
  useEffect(() => {
    const live = new Set(liveMasters.map(m => m.id))
    const kept = [...masterFilter].filter(id => live.has(id))
    if (kept.length === masterFilter.size) return
    setMasterFilter(kept.length === 0 || kept.length === liveMasters.length ? new Set() : new Set(kept))
  }, [liveMasters, masterFilter])
  const filteredMasters = useMemo(
    () => activeFilter.size === 0 ? liveMasters : liveMasters.filter(m => activeFilter.has(m.id)),
    [liveMasters, activeFilter]
  )
  const filteredProjects = useMemo(
    () => activeFilter.size === 0 ? liveProjects : liveProjects.filter(p => activeFilter.has(p.masterProjectId)),
    [liveProjects, activeFilter]
  )
  const [filterMenuOpen, setFilterMenuOpen] = useState(false)
  const [filterSearch, setFilterSearch] = useState('')
  const filterMenuRef = usePopoverDismiss<HTMLDivElement>(filterMenuOpen, () => setFilterMenuOpen(false))

  // Cross-master agenda: every non-done, dated task that is overdue / due today /
  // tomorrow / soon, so the dashboard can surface "what must be done" at a glance.
  const agenda = useMemo(() => {
    const items: AgendaItem[] = []
    for (const master of filteredMasters) {
      filteredProjects.filter(p => p.masterProjectId === master.id).forEach((board, bIdx) => {
        const eff = effStatusLookup(board.tasks)
        for (const t of board.tasks) {
          const effStatus = eff.statusOf(t)
          if (effStatus === 'done') continue
          const due = t.endDate ?? t.startDate // end is the deadline; start-only = 1-day item
          if (!due) continue
          let bucket: AgendaBucket | null = null
          if (due < today) bucket = 'overdue'
          else if (due === today) bucket = 'today'
          else if (due === tomorrow) bucket = 'tomorrow'
          else if (due <= soonEnd) bucket = 'soon'
          if (!bucket) continue
          items.push({ task: t, board, bIdx, masterId: master.id, masterName: master.name, due, bucket, effStatus, hasChildren: eff.hasChildren(t) })
        }
      })
    }
    return items
  }, [filteredMasters, filteredProjects, today, tomorrow, soonEnd])
  const agendaCounts = useMemo(() => {
    const c: Record<AgendaBucket, number> = { overdue: 0, today: 0, tomorrow: 0, soon: 0 }
    for (const a of agenda) c[a.bucket]++
    return c
  }, [agenda])
  const urgentTotal = agendaCounts.overdue + agendaCounts.today + agendaCounts.tomorrow + agendaCounts.soon
  // Cross-master Gantt: aggregate every project across the (filtered) masters into one boards list.
  // Selection is local — clicking a bar surfaces a "詳細を編集" CTA that jumps to /projects.
  const allBoards = filteredProjects
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

  // やること sub-tabs: 'all' renders every bucket as a collapsible section;
  // a specific bucket tab shows only that list. Both persisted.
  const [agendaTab, setAgendaTab] = useState<'all' | AgendaBucket>(() => {
    try {
      const s = localStorage.getItem('constella.dashboard.agendaTab')
      return s && (BUCKET_ORDER as string[]).includes(s) ? s as AgendaBucket : 'all'
    } catch { return 'all' }
  })
  useEffect(() => {
    try { localStorage.setItem('constella.dashboard.agendaTab', agendaTab) } catch { /* ignore */ }
  }, [agendaTab])
  const [collapsedBuckets, setCollapsedBuckets] = useState<Set<AgendaBucket>>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem('constella.dashboard.agendaCollapsed') || '[]')
      return new Set(Array.isArray(raw) ? raw.filter((x): x is AgendaBucket => (BUCKET_ORDER as string[]).includes(x)) : [])
    } catch { return new Set() }
  })
  useEffect(() => {
    try { localStorage.setItem('constella.dashboard.agendaCollapsed', JSON.stringify([...collapsedBuckets])) } catch { /* ignore */ }
  }, [collapsedBuckets])
  const toggleBucketCollapsed = (b: AgendaBucket) =>
    setCollapsedBuckets(s => { const n = new Set(s); if (n.has(b)) n.delete(b); else n.add(b); return n })

  // Group projects (boards) by master. Empty masters still show with an empty card.
  const byMaster = useMemo(() => {
    const m = new Map<string, { master: typeof state.masterProjects[number]; boards: Project[]; tasks: Task[] }>()
    for (const mp of filteredMasters) m.set(mp.id, { master: mp, boards: [], tasks: [] })
    for (const p of filteredProjects) {
      const e = m.get(p.masterProjectId)
      if (e) { e.boards.push(p); for (const t of p.tasks) e.tasks.push(t) }
    }
    return [...m.values()]
  }, [filteredMasters, filteredProjects])

  // Summary card order: 既定 = creation order, 要対応順 = most urgent first
  // (slipping ≫ due this week ≫ undated), so problem projects surface on top.
  const [summarySort, setSummarySort] = useState<'default' | 'attention'>(() => {
    try { return localStorage.getItem('constella.dashboard.summarySort') === 'attention' ? 'attention' : 'default' } catch { return 'default' }
  })
  useEffect(() => {
    try { localStorage.setItem('constella.dashboard.summarySort', summarySort) } catch { /* ignore */ }
  }, [summarySort])
  const summaryMasters = useMemo(() => {
    if (summarySort === 'default') return byMaster
    // Score once per master, then sort — the comparator would otherwise re-run the
    // bucket scans O(n log n) times.
    const score = (tasks: Task[]) => slipping(tasks).length * 10000 + thisWeek(tasks).length * 100 + undated(tasks).length
    return byMaster
      .map(m => ({ m, s: score(m.tasks) }))
      .sort((a, b) => b.s - a.s)
      .map(x => x.m)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [byMaster, summarySort, today])

  // All bucket helpers judge by effective status (parents = child aggregate), so a
  // parent that displays as 完了/進行中 elsewhere is bucketed the same way here.
  function statusCounts(tasks: Task[]) {
    const eff = effStatusLookup(tasks)
    let todo = 0, doing = 0, done = 0
    for (const t of tasks) {
      const s = eff.statusOf(t)
      if (s === 'done') done++
      else if (s === 'in-progress') doing++
      else todo++
    }
    return { todo, doing, done }
  }
  function thisWeek(tasks: Task[]) {
    const eff = effStatusLookup(tasks)
    return tasks.filter(t => {
      if (eff.statusOf(t) === 'done') return false // finished work isn't "やること" anymore
      const e = t.endDate || t.startDate
      if (!e) return false
      return e >= today && e <= weekEnd
    })
  }
  function slipping(tasks: Task[]) {
    const eff = effStatusLookup(tasks)
    return tasks.filter(t => {
      if (eff.statusOf(t) === 'done') return false
      const e = t.endDate
      if (!e) return false
      return e < today
    })
  }
  function undated(tasks: Task[]) {
    const eff = effStatusLookup(tasks)
    return tasks.filter(t => !t.startDate && !t.endDate && eff.statusOf(t) !== 'done')
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

  // 最近の資料 — 表示中プロジェクト（絞り込み反映）のファイルを追加日降順で。
  const recentFiles = useMemo(() => {
    const ids = new Set(summaryMasters.map(m => m.master.id))
    return state.files
      .filter(f => ids.has(f.masterProjectId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 8)
  }, [state.files, summaryMasters])
  function jumpToFile(masterId: string, fileId: string) {
    if (state.activeMasterProjectId !== masterId) {
      dispatch({ type: 'SET_ACTIVE_MASTER_PROJECT', payload: masterId })
    }
    navigate('/files', { state: { focusFileId: fileId } })
  }

  return (
    // h-full (not flex-1): the <main> route outlet is a plain block, so the page
    // must claim its full height itself for inner overflow-y-auto scrolling to work.
    <div className="h-full flex flex-col min-h-0 bg-slate-50/50">
      <div className="min-h-14 flex flex-wrap items-center px-6 py-2 border-b border-slate-200 bg-white shrink-0 gap-x-3 gap-y-2">
        <h2 className="text-lg font-semibold text-slate-800 flex items-center gap-2 min-w-0 truncate">
          <Activity size={18} className="text-emerald-500 shrink-0" /> ダッシュボード
        </h2>
        <span className="text-xs text-slate-400 truncate min-w-0">
          {activeFilter.size > 0
            ? `表示中: ${filteredMasters.length}/${liveMasters.length} プロジェクト・${grandTotal} タスク`
            : `全プロジェクト横断: ${byMaster.length} プロジェクト・${grandTotal} タスク`}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-2">
          {/* Master-project filter — narrows all three views at once. */}
          <div className="relative" ref={filterMenuRef}>
            <button
              onClick={() => { if (!filterMenuOpen) setFilterSearch(''); setFilterMenuOpen(o => !o) }}
              title="表示するプロジェクトを絞り込み"
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-xs transition-colors ${
                activeFilter.size > 0
                  ? 'border-indigo-300 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 font-semibold'
                  : 'border-slate-200 text-slate-500 hover:bg-slate-100 hover:text-slate-800'}`}
            >
              <SlidersHorizontal size={13} className="shrink-0" />
              絞り込み
              {activeFilter.size > 0 && <span className="px-1 rounded bg-indigo-500 text-white text-[10px] leading-4">{activeFilter.size}</span>}
            </button>
            {filterMenuOpen && (
              <div className="absolute right-0 mt-1 z-30 w-64 bg-white border border-slate-200 rounded-lg shadow-xl py-1 text-sm">
                {liveMasters.length >= 6 && (
                  <div className="px-2 pt-1 pb-1.5 border-b border-slate-100">
                    <div className="flex items-center gap-1.5 bg-slate-100 rounded px-2 py-1">
                      <Search size={12} className="text-slate-400 shrink-0" />
                      <input
                        autoFocus
                        type="text"
                        value={filterSearch}
                        onChange={e => setFilterSearch(e.target.value)}
                        placeholder="プロジェクトを検索…"
                        className="flex-1 min-w-0 bg-transparent outline-none text-xs text-slate-700 placeholder:text-slate-400"
                      />
                    </div>
                  </div>
                )}
                <div className="max-h-72 overflow-y-auto">
                  {liveMasters
                    .filter(m => !filterSearch.trim() || m.name.toLowerCase().includes(filterSearch.trim().toLowerCase()))
                    .map(m => {
                      const checked = activeFilter.size === 0 || activeFilter.has(m.id)
                      return (
                        <button
                          key={m.id}
                          onClick={() => {
                            // Same idiom as the gantt board chips: with no filter active the
                            // first click solos the clicked master; after that clicks toggle.
                            // Full coverage or an empty result collapse back to "show all".
                            if (activeFilter.size === 0) { setMasterFilter(new Set([m.id])); return }
                            const effective = new Set(activeFilter)
                            if (effective.has(m.id)) effective.delete(m.id)
                            else effective.add(m.id)
                            if (effective.size === 0 || effective.size === liveMasters.length) setMasterFilter(new Set())
                            else setMasterFilter(effective)
                          }}
                          title={activeFilter.size === 0 ? 'クリックでこのプロジェクトのみ表示' : 'クリックで表示/非表示を切替'}
                          className="w-full flex items-center gap-2 px-2.5 py-1.5 hover:bg-slate-100 text-left"
                        >
                          <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 ${checked ? 'bg-indigo-500 border-indigo-500 text-white' : 'border-slate-300 bg-white'}`}>
                            {checked && <CheckCircle2 size={10} className="text-white" />}
                          </span>
                          <Boxes size={13} className="text-indigo-400 shrink-0" />
                          <span className="flex-1 min-w-0 truncate text-slate-700">{m.name}</span>
                        </button>
                      )
                    })}
                </div>
                {activeFilter.size > 0 && (
                  <div className="border-t border-slate-100 mt-1 pt-1">
                    <button onClick={() => setMasterFilter(new Set())} className="w-full px-2.5 py-1.5 text-xs text-indigo-600 hover:bg-indigo-50 text-left">
                      すべて表示に戻す
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
          {/* Summary sort — only meaningful on the per-project cards view. */}
          {view === 'summary' && (
            <div className="flex items-center rounded-md border border-slate-200 overflow-hidden text-xs">
              {([['default', '既定順'], ['attention', '要対応順']] as const).map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => setSummarySort(k)}
                  title={k === 'attention' ? '遅延・今週・未設定が多いプロジェクトを上に' : '作成順'}
                  className={`flex items-center gap-1 px-2 py-1 transition-colors ${summarySort === k ? 'bg-indigo-500/15 text-indigo-600' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800'}`}
                >
                  {k === 'attention' && <ArrowDownWideNarrow size={13} />} {label}
                </button>
              ))}
            </div>
          )}
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
          <GanttView boards={allBoards} selectedTaskId={ganttSelectedId} onSelectTask={setGanttSelectedId} groupByMaster masters={filteredMasters} />
        </div>
      ) : view === 'agenda' ? (
        <div className="flex-1 min-h-0 overflow-y-auto p-6">
          <div className="max-w-2xl mx-auto space-y-4">
            {/* Bucket tabs — すべて renders collapsible sections, a bucket tab shows just its list. */}
            <div className="flex items-center gap-1 bg-white border border-slate-200 rounded-lg p-1 shadow-sm text-xs w-fit mx-auto">
              <button
                onClick={() => setAgendaTab('all')}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md transition-colors ${agendaTab === 'all' ? 'bg-slate-100 text-slate-800 font-semibold' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-800'}`}
              >
                すべて <span className="opacity-60">{urgentTotal}</span>
              </button>
              {BUCKET_ORDER.map(b => {
                const meta = BUCKET_META[b]
                const n = agendaCounts[b]
                return (
                  <button
                    key={b}
                    onClick={() => setAgendaTab(b)}
                    className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md transition-colors ${agendaTab === b ? `${meta.head} font-semibold` : 'text-slate-500 hover:bg-slate-50 hover:text-slate-800'}`}
                  >
                    {b === 'overdue' ? '遅延' : b === 'today' ? '今日' : b === 'tomorrow' ? '明日' : '近日'}
                    <span className={agendaTab === b ? 'opacity-70' : meta.chip}>{n}</span>
                  </button>
                )
              })}
            </div>
            {urgentTotal === 0 ? (
              <div className="text-center text-slate-400 py-24 flex flex-col items-center gap-2">
                <CheckCircle2 size={32} className="text-emerald-400" />
                <p className="text-sm">差し迫ったタスクはありません 🎉</p>
                <p className="text-xs">遅延・今日・明日・近日（約1週間先まで）の期限タスクがここに出ます。</p>
                {activeFilter.size > 0 && (
                  <p className="text-xs text-indigo-500">プロジェクトを絞り込み中です（{filteredMasters.length}/{liveMasters.length}件を表示）。</p>
                )}
              </div>
            ) : (
              (agendaTab === 'all' ? BUCKET_ORDER : [agendaTab]).map(bucket => {
                const items = agenda.filter(a => a.bucket === bucket).sort((a, b) => a.due.localeCompare(b.due))
                const meta = BUCKET_META[bucket]
                if (items.length === 0) {
                  // In すべて empty buckets vanish; on a dedicated tab show a quiet note instead.
                  return agendaTab === 'all' ? null : (
                    <div key={bucket} className="text-center text-slate-400 text-xs py-16">「{meta.label}」のタスクはありません</div>
                  )
                }
                const collapsible = agendaTab === 'all'
                const collapsed = collapsible && collapsedBuckets.has(bucket)
                return (
                  <div key={bucket} className="bg-white border border-slate-200 rounded-lg shadow-sm overflow-hidden">
                    <button
                      onClick={() => collapsible && toggleBucketCollapsed(bucket)}
                      className={`w-full px-4 py-2 flex items-center gap-2 text-left ${collapsed ? '' : 'border-b'} ${meta.head} ${collapsible ? 'cursor-pointer' : 'cursor-default'}`}
                      title={collapsible ? (collapsed ? 'クリックで展開' : 'クリックで折りたたむ') : undefined}
                    >
                      {collapsible && (collapsed ? <ChevronRight size={14} className="shrink-0 opacity-60" /> : <ChevronDown size={14} className="shrink-0 opacity-60" />)}
                      {bucket === 'overdue' ? <AlertTriangle size={14} /> : <CalendarClock size={14} />}
                      <span className="font-semibold text-sm">{meta.label}</span>
                      <span className="text-xs opacity-70">{items.length}件</span>
                    </button>
                    {!collapsed && (
                      <div className="divide-y divide-slate-50">
                        {items.map(a => (
                          <AgendaRow key={a.task.id} item={a} today={today} multiMaster={byMaster.length > 1} dispatch={dispatch} onClick={() => jumpToTask(a.masterId, a.task.id)} />
                        ))}
                      </div>
                    )}
                  </div>
                )
              })
            )}
          </div>
        </div>
      ) : (
      // auto-rows-max: without it, auto rows compress to fit the definite container
      // height (the cards' overflow-hidden collapses their min-size), clipping cards
      // instead of overflowing into the scrollbar.
      <div className="flex-1 min-h-0 overflow-y-auto p-6 grid gap-4 content-start auto-rows-max" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(360px, 100%), 1fr))' }}>
        {summaryMasters.map(({ master, boards, tasks }) => {
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
        {/* 最近の資料 — ファイルライブラリへの入り口 */}
        {recentFiles.length > 0 && (
          <div className="bg-white border border-slate-200 rounded-lg shadow-sm overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2">
              <Files size={16} className="text-orange-500" />
              <span className="font-medium text-slate-800">最近の資料</span>
            </div>
            <div className="divide-y divide-slate-50">
              {recentFiles.map(f => {
                const kind = fileKind(f.mime, f.name)
                const Icon = FILE_KIND_ICON[kind]
                const mName = state.masterProjects.find(m => m.id === f.masterProjectId)?.name ?? ''
                return (
                  <button
                    key={f.id}
                    onClick={() => jumpToFile(f.masterProjectId, f.id)}
                    title={`${f.name}${f.comment ? `\n${f.comment}` : ''}`}
                    className="w-full flex items-center gap-2 px-4 py-1.5 text-left hover:bg-slate-50 transition-colors"
                  >
                    <Icon size={13} className={`shrink-0 ${FILE_KIND_TINT[kind]}`} />
                    <span className="text-xs text-slate-700 truncate flex-1">{f.name || '(無名)'}</span>
                    <span className="text-[9px] text-slate-400 shrink-0 max-w-[90px] truncate">{mName}</span>
                    <span className="text-[9px] text-slate-400 tabular-nums shrink-0">{new Date(f.createdAt).toLocaleDateString()}</span>
                  </button>
                )
              })}
            </div>
          </div>
        )}
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
    if (item.hasChildren) return // parent status is aggregated from children — nothing to cycle
    const next: Task['status'] = task.status === 'todo' ? 'in-progress' : task.status === 'in-progress' ? 'done' : 'todo'
    dispatch({ type: 'UPDATE_TASK', payload: { projectId: board.id, task: { ...task, status: next } } })
  }
  // Dot reflects the effective status (parents = child aggregate), matching gantt/kanban.
  const statusDotCls =
    item.effStatus === 'done' ? 'bg-emerald-500 border-emerald-500'
      : item.effStatus === 'in-progress' ? 'bg-amber-400 border-amber-400'
        : 'bg-white border-slate-400'
  return (
    <button onClick={onClick} className="w-full flex items-center gap-2 px-4 py-2 hover:bg-slate-100 text-left">
      <span
        onClick={cycleStatus}
        title={item.hasChildren ? '親タスク（状態は子から自動集計）' : 'クリックでステータス切替'}
        className={`w-3.5 h-3.5 rounded-full border-2 shrink-0 ${item.hasChildren ? 'cursor-default' : 'cursor-pointer'} ${statusDotCls}`}
      />
      <span className="text-sm text-slate-800 truncate flex-1">{task.title || '(無題)'}</span>
      {/* Origin, colour-coded: project = indigo (+Boxes icon, matching the switcher),
          board = its own board colour (+dot) — the two levels read apart at a glance. */}
      <span className="flex items-center gap-1 shrink-0 min-w-0 max-w-[220px] text-[11px]" title={`${multiMaster ? `${masterName} / ` : ''}${board.name}`}>
        {multiMaster && (
          <>
            <Boxes size={10} className="text-indigo-400 shrink-0" />
            <span className="text-indigo-500 truncate max-w-[100px]">{masterName}</span>
            <span className="text-slate-300 shrink-0">/</span>
          </>
        )}
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${cls.dot}`} />
        <span className={`truncate max-w-[100px] ${cls.text}`}>{board.name}</span>
      </span>
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
      <span className={`text-[10px] truncate max-w-[80px] ${cls.text}`}>{board?.name}</span>
      {suffix && <span className="text-[10px] text-slate-400 shrink-0">{suffix}</span>}
    </button>
  )
}
