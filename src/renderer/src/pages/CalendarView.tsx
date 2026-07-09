import { useMemo, useState, useRef, useEffect } from 'react'
import { ChevronLeft, ChevronRight, ChevronDown, ChevronRight as ChevRight } from 'lucide-react'
import { useApp } from '../store'
import { Task, Project } from '../types'
import { addDaysIso, dateToIso, isoToday, monthGrid, taskSpan } from '../utils/date'
import { childrenMap } from '../utils/taskTree'

const STATUS_COLOR: Record<Task['status'], string> = {
  'todo': 'bg-slate-300 text-slate-700 border-slate-400',
  'in-progress': 'bg-amber-100 text-amber-700 border-amber-300',
  'done': 'bg-emerald-100 text-emerald-700 border-emerald-300',
}
// Solid dot colours for the undated chip strip — matches GanttView's status dots.
const DOT_COLOR: Record<Task['status'], string> = {
  'todo': 'bg-slate-400',
  'in-progress': 'bg-amber-500',
  'done': 'bg-emerald-500',
}
const DOW = ['日', '月', '火', '水', '木', '金', '土']

interface Item { board: Project; task: Task; span: { start: string; end: string } }
interface UndatedItem { board: Project; task: Task }

// Project-wide month calendar across every board of the active master project.
// Tasks span every day from start to end (chip rendered per day they touch).
export default function CalendarView({ boards }: { boards: Project[] }) {
  const { dispatch } = useApp()
  const today = isoToday()
  const [cursor, setCursor] = useState<{ year: number; month: number }>(() => {
    const d = new Date()
    return { year: d.getFullYear(), month: d.getMonth() }
  })

  // Walk every board's leaves. Yields two lists:
  //   items   — leaves with a span; rendered as day chips on the grid below.
  //   undated — leaves with no start/end; surfaced as clickable chips in the strip above.
  // Parents are skipped either way (they're aggregates — see the Gantt for them).
  const { items, undated } = useMemo(() => {
    const out: Item[] = []
    const un: UndatedItem[] = []
    for (const b of boards) {
      const ch = childrenMap(b.tasks)
      for (const t of b.tasks) {
        if ((ch.get(t.id) ?? []).length > 0) continue
        const sp = taskSpan(t.startDate, t.endDate)
        if (sp) out.push({ board: b, task: t, span: sp })
        else un.push({ board: b, task: t })
      }
    }
    return { items: out, undated: un }
  }, [boards])

  // Undated chip strip — auto-collapses past 8 entries so the month grid stays prominent.
  const [undatedOpen, setUndatedOpen] = useState(true)
  useEffect(() => { setUndatedOpen(undated.length > 0 && undated.length <= 8) }, [undated.length])

  // Click a chip → small floating menu with 今日 / 今週 quick actions (mirrors GanttView).
  const [chipMenu, setChipMenu] = useState<{ item: UndatedItem; x: number; y: number } | null>(null)
  useEffect(() => {
    if (!chipMenu) return
    const close = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      if (!t.closest('[data-chip-menu]')) setChipMenu(null)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setChipMenu(null) }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', onKey) }
  }, [chipMenu])
  function applyChipDate(item: UndatedItem, kind: 'today' | 'week') {
    const start = isoToday()
    const end = kind === 'today' ? start : addDaysIso(start, 6)
    dispatch({ type: 'UPDATE_TASK', payload: { projectId: item.board.id, task: { ...item.task, startDate: start, endDate: end } } })
    setChipMenu(null)
  }

  const grid = useMemo(() => monthGrid(cursor.year, cursor.month), [cursor.year, cursor.month])

  // Map of YYYY-MM-DD → items active on that day.
  const byDay = useMemo(() => {
    const m = new Map<string, Item[]>()
    for (const it of items) {
      // walk start→end inclusive
      let cur = it.span.start
      let safety = 0
      while (cur <= it.span.end && safety < 800) {
        const list = m.get(cur) ?? []
        list.push(it); m.set(cur, list)
        cur = addDaysIso(cur, 1); safety++
      }
    }
    return m
  }, [items])

  // Month label.
  const monthLabel = `${cursor.year}年 ${cursor.month + 1}月`

  // ── Drag a task chip to another day to shift the whole task by that day-delta. ──
  const dragSrcRef = useRef<{ taskId: string; boardId: string; fromIso: string } | null>(null)
  const [dragOverIso, setDragOverIso] = useState<string | null>(null)
  function onChipDragStart(e: React.DragEvent, it: Item, dayIso: string) {
    dragSrcRef.current = { taskId: it.task.id, boardId: it.board.id, fromIso: dayIso }
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', it.task.id)
  }
  function onDayDrop(toIso: string) {
    const src = dragSrcRef.current
    dragSrcRef.current = null
    setDragOverIso(null)
    if (!src) return
    const board = boards.find(b => b.id === src.boardId)
    const task = board?.tasks.find(t => t.id === src.taskId)
    if (!board || !task) return
    const sp = taskSpan(task.startDate, task.endDate)
    if (!sp) return
    // Day-delta: how many days the user dragged.
    const dx = (new Date(toIso).getTime() - new Date(src.fromIso).getTime()) / 86400000
    if (dx === 0) return
    const newStart = addDaysIso(sp.start, dx)
    const newEnd = addDaysIso(sp.end, dx)
    dispatch({ type: 'UPDATE_TASK', payload: { projectId: board.id, task: { ...task, startDate: newStart, endDate: newEnd } } })
  }

  if (boards.length === 0) {
    return <div className="flex-1 flex items-center justify-center text-slate-400 text-sm">ボードを作成するとここにカレンダーが表示されます</div>
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Top bar */}
      <div className="h-10 px-4 flex items-center gap-2 border-b border-slate-200 shrink-0">
        <button
          onClick={() => setCursor(c => c.month === 0 ? { year: c.year - 1, month: 11 } : { year: c.year, month: c.month - 1 })}
          className="p-1.5 rounded hover:bg-slate-100 text-slate-600" title="前の月へ"><ChevronLeft size={16} /></button>
        <button
          onClick={() => { const d = new Date(); setCursor({ year: d.getFullYear(), month: d.getMonth() }) }}
          className="px-2 py-0.5 rounded text-xs text-slate-600 hover:bg-slate-100">今月へ</button>
        <button
          onClick={() => setCursor(c => c.month === 11 ? { year: c.year + 1, month: 0 } : { year: c.year, month: c.month + 1 })}
          className="p-1.5 rounded hover:bg-slate-100 text-slate-600" title="次の月へ"><ChevronRight size={16} /></button>
        <span className="ml-2 text-sm font-medium text-slate-700">{monthLabel}</span>
        <span className="ml-auto text-xs text-slate-500">
          {items.length} 件
          {undated.length > 0 && <span className="ml-2 text-amber-600">・未設定 {undated.length}</span>}
        </span>
      </div>

      {/* Undated chip strip: surfaces leaf tasks with no dates so they're not lost. */}
      {undated.length > 0 && (
        <div className="shrink-0 border-b border-amber-200/70 bg-amber-50/40">
          <button
            onClick={() => setUndatedOpen(o => !o)}
            className="w-full px-3 py-1 flex items-center gap-1.5 text-[11px] text-amber-700 hover:bg-amber-100/50"
            title="未設定タスクを表示/折りたたみ"
          >
            {undatedOpen ? <ChevronDown size={12} /> : <ChevRight size={12} />}
            <span>未設定 <span className="font-semibold">{undated.length}</span> 件</span>
            <span className="ml-2 text-amber-600/70">クリックして日付を割り当て</span>
          </button>
          {undatedOpen && (
            <div className="flex flex-wrap gap-1.5 px-3 pb-2 max-h-32 overflow-y-auto">
              {undated.map(u => (
                <button
                  key={`${u.board.id}/${u.task.id}`}
                  onClick={e => {
                    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                    setChipMenu({ item: u, x: r.left, y: r.bottom + 4 })
                  }}
                  className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-white border border-amber-200/70 hover:border-amber-400 hover:bg-amber-50 text-[11px] text-slate-700 shadow-sm"
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${DOT_COLOR[u.task.status]}`} />
                  <span className="truncate max-w-[160px]">{u.task.title || '(無題)'}</span>
                  <span className="text-[9px] text-slate-400 truncate max-w-[80px]">{u.board.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Chip quick-action menu (positioned at the clicked chip). */}
      {chipMenu && (
        <div
          data-chip-menu
          className="fixed z-50 bg-white border border-slate-200 rounded-lg shadow-xl text-xs py-1 min-w-[140px]"
          style={{ top: chipMenu.y, left: chipMenu.x }}
        >
          <div className="px-2 py-1 text-[10px] text-slate-400 truncate">{chipMenu.item.task.title || '(無題)'}</div>
          <button onClick={() => applyChipDate(chipMenu.item, 'today')} className="w-full text-left px-3 py-1.5 hover:bg-slate-100">今日 1日</button>
          <button onClick={() => applyChipDate(chipMenu.item, 'week')} className="w-full text-left px-3 py-1.5 hover:bg-slate-100">今日 〜 +6日</button>
        </div>
      )}

      {/* Week-day header */}
      <div className="grid grid-cols-7 border-b border-slate-200 shrink-0 bg-slate-50">
        {DOW.map((d, i) => (
          <div key={d} className={`text-center text-[11px] py-1.5 font-medium ${i === 0 ? 'text-red-500' : i === 6 ? 'text-blue-500' : 'text-slate-500'}`}>{d}</div>
        ))}
      </div>

      {/* Days grid (6 weeks × 7 days) */}
      <div className="flex-1 grid grid-cols-7 grid-rows-6 min-h-0">
        {grid.map(d => {
          const iso = dateToIso(d)
          const inMonth = d.getMonth() === cursor.month
          const isToday = iso === today
          const dayItems = byDay.get(iso) ?? []
          const dragOver = dragOverIso === iso
          return (
            <div
              key={iso}
              onDragOver={e => { e.preventDefault(); if (dragOverIso !== iso) setDragOverIso(iso) }}
              onDragLeave={() => { if (dragOverIso === iso) setDragOverIso(null) }}
              onDrop={e => { e.preventDefault(); onDayDrop(iso) }}
              className={`border-r border-b border-slate-100 p-1 overflow-hidden flex flex-col ${inMonth ? 'bg-white' : 'bg-slate-50/60'} ${dragOver ? 'ring-2 ring-emerald-400 ring-inset' : ''}`}
            >
              <div className="flex items-center justify-between mb-0.5">
                <span className={`text-[11px] font-medium ${isToday ? 'bg-indigo-500 text-white rounded-full w-5 h-5 flex items-center justify-center' : inMonth ? 'text-slate-700' : 'text-slate-400'}`}>
                  {d.getDate()}
                </span>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto space-y-0.5">
                {dayItems.slice(0, 6).map(it => {
                  const isStart = it.span.start === iso
                  const isEnd = it.span.end === iso
                  return (
                    <div
                      key={it.task.id + iso}
                      draggable
                      onDragStart={e => onChipDragStart(e, it, iso)}
                      title={`${it.task.title || '(無題)'}\n${it.span.start} 〜 ${it.span.end}\n${it.board.name}`}
                      className={`px-1.5 py-0.5 rounded text-[10px] truncate border cursor-grab active:cursor-grabbing ${STATUS_COLOR[it.task.status]} ${isStart ? 'rounded-l' : 'rounded-l-none'} ${isEnd ? 'rounded-r' : 'rounded-r-none'}`}
                    >
                      {it.task.title || '(無題)'}
                    </div>
                  )
                })}
                {dayItems.length > 6 && (
                  <div className="text-[9px] text-slate-400 px-1">+{dayItems.length - 6}</div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
