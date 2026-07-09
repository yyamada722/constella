import { useMemo, useRef, useState, useEffect } from 'react'
import { ChevronLeft, ChevronRight, ChevronDown, ChevronRight as ChevRight, PanelLeftClose, PanelLeftOpen, FileText, CalendarRange } from 'lucide-react'
import { useApp } from '../store'
import { Task, Project, MasterProject, BoardColor } from '../types'
import { addDaysIso, daysBetween, isoToday, isoToDate, isValidIso, maxIso, minIso, pad2, taskSpan } from '../utils/date'
import { aggregateFor, childrenMap, descendantIds, rootsOf, wouldCycle } from '../utils/taskTree'
import { BOARD_COLOR_CLASSES, boardColorFor } from '../utils/boardColor'
import { holidayNameFor } from '../utils/jpHolidays'
import { generateId } from '../utils'
import LinkedNotesField from '../components/LinkedNotesField'

const ROW_H = 30
const LEFT_W_DEFAULT = 280
const LEFT_W_COLLAPSED = 40
const LEFT_W_MIN = 160
const LEFT_W_MAX = 800
// Zoom presets — DAY_W and rangeDays move together so today stays centered and the
// chart density matches the chosen overview. 'default' keeps the auto-fit behaviour
// (range snaps to tasks ±14d), the others lock to fixed windows centred on today.
const ZOOM_PRESETS = {
  default: { dayW: 36, rangeDays: 90 },
  quarter: { dayW: 24, rangeDays: 90 },  // ~2160px wide — day numbers breathe, today pill fits within one cell
  half:    { dayW: 10, rangeDays: 183 }, // ~1830px wide — text degraded but the cell rhythm stays readable
} as const
type ZoomPreset = keyof typeof ZOOM_PRESETS
const STATUS_COLOR: Record<Task['status'], string> = {
  'todo': 'bg-slate-300 border border-slate-400/60 text-slate-700',
  'in-progress': 'bg-amber-500 text-white',
  'done': 'bg-emerald-500 text-white',
}
const STATUS_DOT: Record<Task['status'], string> = {
  'todo': 'bg-slate-400',
  'in-progress': 'bg-amber-500',
  'done': 'bg-emerald-500',
}
const WEEKDAY = ['日', '月', '火', '水', '木', '金', '土'] as const

interface TaskRow {
  kind: 'task'
  board: Project; task: Task; depth: number
  span: { start: string; end: string } | null
  hasChildren: boolean
  // True iff this row is a parent with at least one explicit own date (drag becomes enabled).
  hasExplicitParentDates: boolean
  // For explicit-parent rows that contain overshooting children: the wider child-aggregate span used for the warning overlay.
  childRange: { start?: string; end?: string } | null
  // For leaves whose effective span pokes past the closest explicit-parent ancestor: that ancestor's box.
  violatesAncestor: { title: string; start?: string; end?: string } | null
}
interface HeaderRow {
  kind: 'header'
  label: string
  // Optional tint anchor: we use a board's color when grouping per board; for master groups
  // we pick a stable palette colour based on the master's index (computed by the caller).
  colorKey: 'slate' | 'emerald' | 'indigo' | 'rose' | 'amber' | 'sky' | 'violet' | 'fuchsia'
  taskCount: number
}
type Row = TaskRow | HeaderRow

// Project-wide Gantt across every board of the active master project. Tasks with dates
// render as draggable bars; undated leaves still occupy a row (so hierarchy stays intact)
// and show a dashed「未設定」pill at the today column — click it to assign 今日 / 今週.
export default function GanttView({ boards, selectedTaskId, onSelectTask, groupByMaster, masters, bandMasterId }: {
  boards: Project[]
  selectedTaskId?: string | null
  onSelectTask?: (id: string | null) => void
  // When true, insert a section header per master project (used by the cross-master Dashboard).
  // Otherwise the gantt is flat — no per-board sectioning, just contiguous task rows.
  groupByMaster?: boolean
  masters?: MasterProject[]
  // The master project being viewed. When set, tasks shared from OTHER masters
  // are overlaid (read-only) in the shared-schedule lane under their alias.
  bandMasterId?: string
}) {
  const { state, dispatch } = useApp()
  // Collapsed task ids — clicked rows hide their subtree from the chart.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const toggleCollapse = (id: string) => setCollapsed(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  // Cross-pane row hover: light up the left list row + corresponding chart strip.
  const [hoveredId, setHoveredId] = useState<string | null>(null)

  // Left task-list panel — collapsible + resizable, persisted to localStorage.
  const [leftCollapsed, setLeftCollapsed] = useState(() => {
    try { return localStorage.getItem('constella.gantt.leftCollapsed') === '1' } catch { return false }
  })
  const [leftHover, setLeftHover] = useState(false)
  const leftHoverTimer = useRef<number | null>(null)
  useEffect(() => {
    try { localStorage.setItem('constella.gantt.leftCollapsed', leftCollapsed ? '1' : '0') } catch { /* ignore */ }
  }, [leftCollapsed])
  const onLeftEnter = () => {
    if (leftHoverTimer.current) { clearTimeout(leftHoverTimer.current); leftHoverTimer.current = null }
    if (!leftCollapsed) return
    leftHoverTimer.current = window.setTimeout(() => setLeftHover(true), 280)
  }
  const onLeftLeave = () => {
    if (leftHoverTimer.current) { clearTimeout(leftHoverTimer.current); leftHoverTimer.current = null }
    if (!leftCollapsed) return
    leftHoverTimer.current = window.setTimeout(() => setLeftHover(false), 180)
  }
  const [leftWidth, setLeftWidth] = useState(() => {
    try { const v = Number(localStorage.getItem('constella.gantt.leftWidth') || String(LEFT_W_DEFAULT)); return v >= LEFT_W_MIN && v <= LEFT_W_MAX ? v : LEFT_W_DEFAULT } catch { return LEFT_W_DEFAULT }
  })
  const [leftResizing, setLeftResizing] = useState(false)
  useEffect(() => {
    try { localStorage.setItem('constella.gantt.leftWidth', String(leftWidth)) } catch { /* ignore */ }
  }, [leftWidth])
  function startLeftResize(e: React.MouseEvent) {
    e.preventDefault()
    const startX = e.clientX
    const base = leftWidth
    setLeftResizing(true)
    const onMove = (ev: MouseEvent) => {
      const next = Math.max(LEFT_W_MIN, Math.min(LEFT_W_MAX, base + (ev.clientX - startX)))
      setLeftWidth(next)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      setLeftResizing(false)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }
  const leftExpanded = !leftCollapsed || leftHover
  const leftPanelW = leftExpanded ? leftWidth : LEFT_W_COLLAPSED
  const leftSlotW = leftCollapsed ? LEFT_W_COLLAPSED : leftWidth

  // Zoom preset (standard / 3-month / half-year). DAY_W derives from this and so do
  // the initial rangeDays. Auto-fit useEffect is skipped for non-default presets so
  // the preset wins over data-driven snapping.
  const [zoomPreset, setZoomPreset] = useState<ZoomPreset>(() => {
    try { const v = localStorage.getItem('constella.gantt.zoomPreset'); return (v === 'quarter' || v === 'half') ? v : 'default' } catch { return 'default' }
  })
  useEffect(() => {
    try { localStorage.setItem('constella.gantt.zoomPreset', zoomPreset) } catch { /* ignore */ }
  }, [zoomPreset])

  // Track the chart's available width so we can stretch DAY_W to fill it — otherwise
  // wide viewports leave a lot of empty space on the right (especially at the 半年 preset).
  const [chartHostW, setChartHostW] = useState(0)

  // Board filter: when non-empty, only boards in this set are shown in rows.
  const [boardFilter, setBoardFilter] = useState<Set<string>>(new Set())
  const filteredBoards = useMemo(
    () => boardFilter.size === 0 ? boards : boards.filter(b => boardFilter.has(b.id)),
    [boards, boardFilter]
  )
  // Stable index lookup so the board's palette colour stays constant regardless of filter state.
  const boardIndex = useMemo(() => {
    const m = new Map<string, number>()
    boards.forEach((b, i) => m.set(b.id, i))
    return m
  }, [boards])

  // Walk every board's task tree in display order. Dated tasks (and parents whose subtree
  // aggregates to a span) get a span; undated leaves are kept with span=null so they still
  // occupy a row but get a placeholder pill instead of a bar. Parents whose entire subtree
  // is undated are skipped — their dates would come from children, so the user dates a leaf
  // first and the parent automatically lifts in on the next render.
  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    const all: Task[] = []
    const boardByTaskId = new Map<string, Project>()
    for (const b of filteredBoards) {
      for (const t of b.tasks) { all.push(t); boardByTaskId.set(t.id, b) }
    }
    const ch = childrenMap(all)
    type Frame = { title: string; start?: string; end?: string }
    const ancestorStack: Frame[] = []
    // Master-projects in display order (for header colors). Boards inherit their master's
    // colour key when groupByMaster is on so all boards within one master sit under one band.
    const MASTER_PALETTE: BoardColor[] = ['emerald', 'indigo', 'rose', 'amber', 'sky', 'violet', 'fuchsia', 'slate']
    const masterIdxOf = new Map<string, number>()
    if (masters) masters.forEach((m, i) => masterIdxOf.set(m.id, i))
    // Group boards by master (only used when groupByMaster). Order follows master list order.
    const visibleMasters: { id: string; name: string; boards: Project[] }[] = []
    if (groupByMaster && masters) {
      const m = new Map<string, { id: string; name: string; boards: Project[] }>()
      for (const mp of masters) m.set(mp.id, { id: mp.id, name: mp.name, boards: [] })
      for (const b of filteredBoards) m.get(b.masterProjectId)?.boards.push(b)
      for (const v of m.values()) if (v.boards.length > 0) visibleMasters.push(v)
    }
    // Helper: walk one board's tree, emitting task rows. Cross-board children resolve via
    // the combined pool but get anchored to their OWN board (skipped here when not match).
    const walkBoard = (b: Project) => {
      const boardTaskIds = new Set(b.tasks.map(t => t.id))
      const localRoots = b.tasks.filter(t => !t.parentId || !boardTaskIds.has(t.parentId))
      const walk = (t: Task, depth: number) => {
        const agg = aggregateFor(all, t)
        const sp = agg.hasChildren
          ? (agg.startDate && agg.endDate ? { start: agg.startDate, end: agg.endDate } : null)
          : taskSpan(t.startDate, t.endDate)
        const hasExplicit = agg.hasChildren && agg.hasExplicitDates
        let violates: TaskRow['violatesAncestor'] = null
        if (!agg.hasChildren && sp && ancestorStack.length > 0) {
          const top = ancestorStack[ancestorStack.length - 1]
          const overStart = !!(top.start && sp.start < top.start)
          const overEnd = !!(top.end && sp.end > top.end)
          if (overStart || overEnd) violates = { title: t.title || '(無題)', start: top.start, end: top.end }
        }
        const frame: Frame | null = hasExplicit
          ? { title: t.title || '(無題)', start: isValidIso(t.startDate) ? t.startDate : undefined, end: isValidIso(t.endDate) ? t.endDate : undefined }
          : null
        const childRange = (hasExplicit && (agg.childOverflowsStart || agg.childOverflowsEnd))
          ? { start: agg.childStartDate, end: agg.childEndDate }
          : null
        if (sp) out.push({ kind: 'task', board: b, task: t, depth, span: sp, hasChildren: agg.hasChildren, hasExplicitParentDates: hasExplicit, childRange, violatesAncestor: violates })
        else if (!agg.hasChildren) out.push({ kind: 'task', board: b, task: t, depth, span: null, hasChildren: false, hasExplicitParentDates: false, childRange: null, violatesAncestor: null })
        if (collapsed.has(t.id)) return
        if (frame) ancestorStack.push(frame)
        for (const c of ch.get(t.id) ?? []) {
          if (boardByTaskId.get(c.id) === b) walk(c, depth + 1)
        }
        if (frame) ancestorStack.pop()
      }
      for (const r of localRoots) walk(r, 0)
    }
    if (groupByMaster && visibleMasters.length > 0) {
      // Per-master section header + flat task list (no per-board sectioning within a master).
      for (const m of visibleMasters) {
        const idx = masterIdxOf.get(m.id) ?? 0
        const color = MASTER_PALETTE[idx % MASTER_PALETTE.length]
        const headerIdx = out.length
        out.push({ kind: 'header', label: m.name, colorKey: color, taskCount: 0 })
        for (const b of m.boards) walkBoard(b)
        const header = out[headerIdx] as HeaderRow
        header.taskCount = out.length - headerIdx - 1
      }
    } else {
      // Flat — no section headers. Boards are emitted in order without grouping cues.
      for (const b of filteredBoards) walkBoard(b)
    }
    return out
  }, [filteredBoards, collapsed, groupByMaster, masters])

  const undatedCount = useMemo(() => rows.reduce((n, r) => n + (r.kind === 'task' && !r.span ? 1 : 0), 0), [rows])

  // Click an undated row's placeholder pill → small floating menu with 今日 / 今週 quick actions.
  const [pillMenu, setPillMenu] = useState<{ row: TaskRow; x: number; y: number } | null>(null)
  useEffect(() => {
    if (!pillMenu) return
    const close = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      if (!t.closest('[data-pill-menu]')) setPillMenu(null)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPillMenu(null) }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', onKey) }
  }, [pillMenu])
  function applyPillDate(row: TaskRow, kind: 'today' | 'week') {
    const today = isoToday()
    const end = kind === 'today' ? today : addDaysIso(today, 6)
    dispatch({ type: 'UPDATE_TASK', payload: { projectId: row.board.id, task: { ...row.task, startDate: today, endDate: end } } })
    setPillMenu(null)
  }

  // Pen-tool drag for undated rows: mousedown on the pill → cursor drags across the chart →
  // mouseup commits a date range. If the user releases without moving (or barely), we fall back
  // to the existing popover so a single tap still works.
  const penDragRef = useRef<{ row: TaskRow; downX: number; downY: number; startCol: number; pointerCol: number; moved: boolean } | null>(null)
  const [penDragTick, setPenDragTick] = useState(0)
  function startPenDrag(e: React.MouseEvent, row: TaskRow) {
    if (e.button !== 0) return
    const bodyEl = bodyScrollRef.current
    if (!bodyEl) return
    e.preventDefault()
    e.stopPropagation()
    const bodyRect = bodyEl.getBoundingClientRect()
    const startX = e.clientX - bodyRect.left + bodyEl.scrollLeft
    const col = Math.max(0, Math.floor(startX / DAY_W))
    penDragRef.current = { row, downX: e.clientX, downY: e.clientY, startCol: col, pointerCol: col, moved: false }
    setPenDragTick(t => t + 1)
    const onMove = (ev: MouseEvent) => {
      const d = penDragRef.current
      if (!d) return
      if (!d.moved && (Math.abs(ev.clientX - d.downX) > 4 || Math.abs(ev.clientY - d.downY) > 4)) d.moved = true
      const x = ev.clientX - bodyRect.left + bodyEl.scrollLeft
      d.pointerCol = Math.max(0, Math.floor(x / DAY_W))
      setPenDragTick(t => t + 1)
    }
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      const d = penDragRef.current
      penDragRef.current = null
      setPenDragTick(t => t + 1)
      if (!d) return
      if (!d.moved) {
        // Tap (no drag) = open the quick-assign popover at the cursor — works
        // whether the press landed on the pill or anywhere on the timeline row.
        setPillMenu({ row: d.row, x: d.downX, y: d.downY + 8 })
        return
      }
      const a = Math.min(d.startCol, d.pointerCol)
      const b = Math.max(d.startCol, d.pointerCol)
      const start = addDaysIso(rangeStart, a)
      const end = addDaysIso(rangeStart, b)
      dispatch({ type: 'UPDATE_TASK', payload: { projectId: d.row.board.id, task: { ...d.row.task, startDate: start, endDate: end } } })
      // suppress click event that follows mouseup, since we already handled it
      ev.preventDefault()
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // ── Shared cross-project schedules (read-only overlay) ──
  // Tasks in OTHER master projects that were marked "shared" show here — under
  // their sharedAlias so the real title stays private. Read-only: to change one,
  // open it in its own project. Own-project shared tasks render as normal bars.
  const sharedExternal = useMemo(() => {
    if (!bandMasterId) return [] as { id: string; alias: string; start: string; end: string; color: BoardColor; boardName: string }[]
    const out: { id: string; alias: string; start: string; end: string; color: BoardColor; boardName: string }[] = []
    state.projects.forEach((p, pi) => {
      if (p.masterProjectId === bandMasterId) return // own master → shown as normal bars
      for (const t of p.tasks) {
        if (!t.shared) continue
        const span = taskSpan(t.startDate, t.endDate)
        if (!span) continue
        out.push({ id: t.id, alias: (t.sharedAlias || '').trim() || '予定', start: span.start, end: span.end, color: (p.color ?? boardColorFor(p, pi)) as BoardColor, boardName: p.name })
      }
    })
    return out
  }, [state.projects, bandMasterId])
  const bandCols = (b: { start: string; end: string }): [number, number] =>
    [daysBetween(rangeStart, b.start), daysBetween(rangeStart, b.end)]

  // Edit popover — opens when the user clicks a bar (drag uses mousedown, click is the no-drag tap).
  const [editing, setEditing] = useState<{ row: TaskRow; x: number; y: number } | null>(null)
  useEffect(() => {
    if (!editing) return
    const close = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      if (!t.closest('[data-edit-popover]')) setEditing(null)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setEditing(null) }
    // Defer one tick so the same mousedown that opened the popover doesn't close it.
    const id = window.setTimeout(() => window.addEventListener('mousedown', close), 0)
    window.addEventListener('keydown', onKey)
    return () => { clearTimeout(id); window.removeEventListener('mousedown', close); window.removeEventListener('keydown', onKey) }
  }, [editing])
  function patchTask(row: TaskRow, patch: Partial<Task>) {
    dispatch({ type: 'UPDATE_TASK', payload: { projectId: row.board.id, task: { ...row.task, ...patch } } })
  }
  // Drag-vs-click discrimination: capture the mousedown position; if mouseup lands within 4px
  // of it (no real drag happened) treat it as a click and open the editor instead of doing nothing.
  const mouseDownRef = useRef<{ x: number; y: number } | null>(null)
  // Drag-and-drop for task list rows: reorder (drop on top half = drop BEFORE) and re-parent
  // (drop on bottom half = nest INTO). Operations are constrained to within the same board
  // for simplicity — cross-board moves require a separate UI affordance.
  const dragTaskRef = useRef<{ taskId: string; boardId: string } | null>(null)
  const [dropTarget, setDropTarget] = useState<{ taskId: string; zone: 'before' | 'nest' } | null>(null)
  function ganttDropBefore(targetRow: TaskRow) {
    const drag = dragTaskRef.current
    dragTaskRef.current = null
    setDropTarget(null)
    if (!drag || drag.boardId !== targetRow.board.id || drag.taskId === targetRow.task.id) return
    const board = targetRow.board
    const dragged = board.tasks.find(t => t.id === drag.taskId)
    if (!dragged) return
    const without = board.tasks.filter(t => t.id !== drag.taskId)
    const idx = without.findIndex(t => t.id === targetRow.task.id)
    if (idx < 0) return
    // Adopt the target's parent so the dragged task becomes a same-level sibling.
    const moved: Task = { ...dragged, parentId: targetRow.task.parentId }
    const tasks = [...without.slice(0, idx), moved, ...without.slice(idx)]
    dispatch({ type: 'SET_PROJECT_TASKS', payload: { projectId: board.id, tasks } })
  }
  function ganttNestInto(targetRow: TaskRow) {
    const drag = dragTaskRef.current
    dragTaskRef.current = null
    setDropTarget(null)
    if (!drag || drag.taskId === targetRow.task.id) return
    // Cross-board parenting is allowed on the gantt: build the cross-board pool so the
    // cycle check spans every visible board, and dispatch UPDATE_TASK on the SOURCE board.
    const sourceBoard = boards.find(b => b.tasks.some(t => t.id === drag.taskId))
    if (!sourceBoard) return
    const dragged = sourceBoard.tasks.find(t => t.id === drag.taskId)
    if (!dragged || dragged.parentId === targetRow.task.id) return
    const pool: Task[] = []
    for (const b of boards) for (const t of b.tasks) pool.push(t)
    if (wouldCycle(pool, drag.taskId, targetRow.task.id)) return
    dispatch({ type: 'UPDATE_TASK', payload: { projectId: sourceBoard.id, task: { ...dragged, parentId: targetRow.task.id } } })
  }

  // Move a task (and its entire subtree) to another board. The task becomes a root
  // in the destination — its parent chain wouldn't survive a cross-board move anyway.
  function moveTaskToBoard(row: TaskRow, targetBoardId: string) {
    if (row.board.id === targetBoardId) return
    const targetBoard = boards.find(b => b.id === targetBoardId)
    if (!targetBoard) return
    const sourceBoard = row.board
    const descIds = descendantIds(sourceBoard.tasks, row.task.id)
    const subtree = sourceBoard.tasks.filter(t => t.id === row.task.id || descIds.has(t.id))
    const remaining = sourceBoard.tasks.filter(t => t.id !== row.task.id && !descIds.has(t.id))
    const newRoot: Task = { ...row.task, parentId: undefined }
    const rest = subtree.filter(t => t.id !== row.task.id)
    const targetTasks = [...targetBoard.tasks, newRoot, ...rest]
    dispatch({ type: 'SET_PROJECT_TASKS', payload: { projectId: sourceBoard.id, tasks: remaining } })
    dispatch({ type: 'SET_PROJECT_TASKS', payload: { projectId: targetBoardId, tasks: targetTasks } })
    setEditing(null)
  }
  // Duplicate a task subtree onto another board, generating new IDs for each task
  // and remapping parent/child links via an old-id → new-id table.
  function duplicateTaskToBoard(row: TaskRow, targetBoardId: string) {
    const targetBoard = boards.find(b => b.id === targetBoardId)
    if (!targetBoard) return
    const sourceBoard = row.board
    const descIds = descendantIds(sourceBoard.tasks, row.task.id)
    const subtree = sourceBoard.tasks.filter(t => t.id === row.task.id || descIds.has(t.id))
    const idMap = new Map<string, string>()
    for (const t of subtree) idMap.set(t.id, generateId())
    const clonedRoot: Task = { ...row.task, id: idMap.get(row.task.id)!, parentId: undefined }
    const clonedRest: Task[] = subtree
      .filter(t => t.id !== row.task.id)
      .map(t => ({ ...t, id: idMap.get(t.id)!, parentId: t.parentId ? idMap.get(t.parentId) : undefined }))
    const targetTasks = [...targetBoard.tasks, clonedRoot, ...clonedRest]
    dispatch({ type: 'SET_PROJECT_TASKS', payload: { projectId: targetBoardId, tasks: targetTasks } })
    setEditing(null)
  }
  const [moveTargetBoardId, setMoveTargetBoardId] = useState<string>('')

  function openEditorAtRect(row: TaskRow, rect: DOMRect) {
    // Clamp x so the 280px popover always fits in viewport.
    const popW = 280
    const x = Math.max(8, Math.min(window.innerWidth - popW - 8, rect.left))
    setEditing({ row, x, y: rect.bottom + 6 })
  }

  // 3ヶ月/半年 presets are forward-looking project views — anchor the LEFT EDGE at today-7
  // (gives a 1-week lookback) so most of the range shows what's coming. The user pans
  // earlier via the < button or by scrolling. 'default' keeps the auto-fit (data-driven) behaviour.
  const PRESET_LOOKBACK_DAYS = 7
  const [rangeStart, setRangeStart] = useState(() => addDaysIso(isoToday(), -PRESET_LOOKBACK_DAYS))
  const [rangeDays, setRangeDays] = useState<number>(ZOOM_PRESETS[zoomPreset].rangeDays)
  useEffect(() => {
    const rd = ZOOM_PRESETS[zoomPreset].rangeDays
    setRangeDays(rd)
    setRangeStart(addDaysIso(isoToday(), -PRESET_LOOKBACK_DAYS))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomPreset])
  // DAY_W stretches to fill the chart area when there's empty space on the right.
  // The preset's dayW is the FLOOR (always at least that wide for legibility); when the
  // viewport is wider than presetDayW × rangeDays, each cell grows to soak the slack.
  const DAY_W = Math.max(
    ZOOM_PRESETS[zoomPreset].dayW,
    chartHostW > 0 && rangeDays > 0 ? Math.floor(chartHostW / rangeDays) : ZOOM_PRESETS[zoomPreset].dayW,
  )
  // Render extra "buffer" days past the preset range so the chart is always horizontally
  // scrollable — the user can drag/scroll to see further into the future without the < / >
  // buttons. Buffer = max(60 days, ~30% of a viewport's worth) so it scales with screen size.
  const renderedDays = rangeDays + Math.max(60, chartHostW > 0 ? Math.ceil(chartHostW * 0.3 / DAY_W) : 60)
  useEffect(() => {
    if (rows.length === 0) return
    if (zoomPreset !== 'default') return  // presets win; only 'default' lets data drive the range.
    let lo: string | undefined, hi: string | undefined
    for (const r of rows) { if (r.kind !== 'task' || !r.span) continue; lo = minIso(lo, r.span.start); hi = maxIso(hi, r.span.end) }
    if (lo && hi) {
      const start = addDaysIso(lo, -7)
      const dayCount = Math.max(60, daysBetween(start, hi) + 14)
      setRangeStart(start); setRangeDays(dayCount)
    }
    // Only fit once on first non-empty load — afterwards the user navigates manually.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.length > 0])

  const days = useMemo(() => {
    const out: { iso: string; date: Date }[] = []
    for (let i = 0; i < renderedDays; i++) {
      const iso = addDaysIso(rangeStart, i)
      out.push({ iso, date: isoToDate(iso) })
    }
    return out
  }, [rangeStart, renderedDays])

  // Month header spans: contiguous runs of the same year-month in `days`.
  const monthSpans = useMemo(() => {
    const out: { label: string; start: number; len: number }[] = []
    let cur = '', startIdx = 0
    days.forEach((d, i) => {
      const key = `${d.date.getFullYear()}-${pad2(d.date.getMonth() + 1)}`
      if (key !== cur) { if (cur) out.push({ label: cur, start: startIdx, len: i - startIdx }); cur = key; startIdx = i }
    })
    if (cur) out.push({ label: cur, start: startIdx, len: days.length - startIdx })
    return out
  }, [days])

  const todayIso = useMemo(() => isoToday(), [])
  const todayIdx = days.findIndex(d => d.iso === todayIso)

  const headerScrollRef = useRef<HTMLDivElement>(null)
  const bodyScrollRef = useRef<HTMLDivElement>(null)
  const taskListRef = useRef<HTMLDivElement>(null)
  // Avoid the obvious onScroll → setScroll → onScroll loop when syncing two panes.
  const syncingScrollRef = useRef(false)
  // Keep the date header horizontally aligned with the chart body; keep the task list
  // vertically aligned with the chart body so rows match up regardless of which side scrolls.
  const onBodyScroll = () => {
    if (headerScrollRef.current && bodyScrollRef.current) headerScrollRef.current.scrollLeft = bodyScrollRef.current.scrollLeft
    if (syncingScrollRef.current) return
    if (taskListRef.current && bodyScrollRef.current && taskListRef.current.scrollTop !== bodyScrollRef.current.scrollTop) {
      syncingScrollRef.current = true
      taskListRef.current.scrollTop = bodyScrollRef.current.scrollTop
      requestAnimationFrame(() => { syncingScrollRef.current = false })
    }
  }
  const onTaskListScroll = () => {
    if (syncingScrollRef.current) return
    if (bodyScrollRef.current && taskListRef.current && bodyScrollRef.current.scrollTop !== taskListRef.current.scrollTop) {
      syncingScrollRef.current = true
      bodyScrollRef.current.scrollTop = taskListRef.current.scrollTop
      requestAnimationFrame(() => { syncingScrollRef.current = false })
    }
  }
  // The date area (header + chart body) scrolls the DATE axis (horizontal) ONLY.
  // A vertical wheel here must never scroll the body vertically, because that is
  // mirrored onto the task list (row alignment) — the user would see the task
  // list "move" while scrolling the timeline. Row scrolling is done over the
  // task-list pane instead.
  //
  // This MUST be a native, non-passive listener: React's synthetic onWheel is
  // passive, so e.preventDefault() there is a no-op and the native vertical
  // scroll leaks through (the exact bug). Folding both axes into the horizontal
  // delta keeps plain-wheel / shift+wheel / trackpad-horizontal all working.
  useEffect(() => {
    const body = bodyScrollRef.current
    if (!body) return
    const targets = [body, headerScrollRef.current].filter(Boolean) as HTMLElement[]
    const onWheel = (e: WheelEvent) => {
      // Let a genuine pinch-zoom (ctrl+wheel) fall through to the browser.
      if (e.ctrlKey) return
      e.preventDefault() // block native vertical scroll → task list stays put
      const dx = e.deltaX + e.deltaY
      if (dx === 0) return
      const max = body.scrollWidth - body.clientWidth
      if (max <= 0) return
      body.scrollLeft = Math.max(0, Math.min(max, body.scrollLeft + dx))
    }
    for (const t of targets) t.addEventListener('wheel', onWheel, { passive: false })
    return () => { for (const t of targets) t.removeEventListener('wheel', onWheel) }
  }, [])
  // Observe the chart container width so DAY_W can stretch to fill empty right-side space.
  useEffect(() => {
    const el = bodyScrollRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(es => { for (const e of es) setChartHostW(e.contentRect.width) })
    ro.observe(el)
    setChartHostW(el.clientWidth)
    return () => ro.disconnect()
  }, [])
  // Track horizontal scroll so the undated pill can stay pinned to the chart's visible left edge.
  // rAF-throttled to keep per-frame work bounded even with many rows.
  const [scrollLeft, setScrollLeft] = useState(0)
  useEffect(() => {
    const el = bodyScrollRef.current
    if (!el) return
    let raf = 0
    const onScroll = () => {
      if (raf) return
      raf = requestAnimationFrame(() => { raf = 0; setScrollLeft(el.scrollLeft) })
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => { el.removeEventListener('scroll', onScroll); if (raf) cancelAnimationFrame(raf) }
  }, [])

  // Scroll position when the range changes. Presets are forward-looking (rangeStart already
  // sits at today−PRESET_LOOKBACK_DAYS), so we just scroll to the left edge to honour that
  // intent. Default mode auto-fits to data, and centring on today there isn't meaningful when
  // tasks may be far in the past or future — also start from left for consistency.
  useEffect(() => {
    const el = bodyScrollRef.current
    if (!el) return
    el.scrollLeft = 0
  }, [rangeStart, rangeDays])

  // ── Drag: move bar (preserve duration) / resize left / resize right ──
  type Drag = { taskId: string; mode: 'move' | 'left' | 'right'; startX: number; origStart: string; origEnd: string; previewStart: string; previewEnd: string }
  const dragRef = useRef<Drag | null>(null)
  const [, setDragTick] = useState(0)
  function onBarDown(e: React.MouseEvent, r: TaskRow, mode: Drag['mode']) {
    if (e.button !== 0) return
    // Only undated rows are non-draggable; aggregated parents are non-draggable; explicit-date parents drag like leaves.
    if (!r.span) return
    if (r.hasChildren && !r.hasExplicitParentDates) return
    e.stopPropagation()
    e.preventDefault()
    dragRef.current = { taskId: r.task.id, mode, startX: e.clientX, origStart: r.span.start, origEnd: r.span.end, previewStart: r.span.start, previewEnd: r.span.end }
    setDragTick(t => t + 1)
    const onMove = (ev: MouseEvent) => {
      const d = dragRef.current
      if (!d) return
      const delta = Math.round((ev.clientX - d.startX) / DAY_W)
      let s = d.origStart, e2 = d.origEnd
      if (d.mode === 'move') { s = addDaysIso(d.origStart, delta); e2 = addDaysIso(d.origEnd, delta) }
      else if (d.mode === 'left') { s = addDaysIso(d.origStart, delta); if (s > e2) s = e2 }
      else if (d.mode === 'right') { e2 = addDaysIso(d.origEnd, delta); if (e2 < s) e2 = s }
      d.previewStart = s; d.previewEnd = e2
      setDragTick(t => t + 1)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      const d = dragRef.current
      dragRef.current = null
      setDragTick(t => t + 1)
      if (!d) return
      if (d.previewStart === d.origStart && d.previewEnd === d.origEnd) return
      const board = boards.find(b => b.tasks.some(t => t.id === d.taskId))
      const task = board?.tasks.find(t => t.id === d.taskId)
      if (!board || !task) return
      dispatch({ type: 'UPDATE_TASK', payload: { projectId: board.id, task: { ...task, startDate: d.previewStart, endDate: d.previewEnd } } })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  if (boards.length === 0) {
    return <div className="flex-1 flex items-center justify-center text-slate-400 text-sm">ボードを作成するとここにガントチャートが表示されます</div>
  }

  // Nav step scales with the preset so a "page" of scroll is meaningful at any zoom.
  const navStep = Math.max(7, Math.floor(rangeDays / 3))

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0 select-none">
      {/* Top bar: nav + summary */}
      <div className="h-10 px-4 flex items-center gap-2 border-b border-slate-200 shrink-0">
        <button onClick={() => setRangeStart(addDaysIso(rangeStart, -navStep))} className="p-1 rounded hover:bg-slate-100 text-slate-600" title={`${navStep}日前へ`}><ChevronLeft size={16} /></button>
        <button onClick={() => setRangeStart(addDaysIso(isoToday(), -PRESET_LOOKBACK_DAYS))} className="px-2 py-0.5 rounded text-xs text-slate-600 hover:bg-slate-100" title="左端を今日付近に">今日へ</button>
        <button onClick={() => setRangeStart(addDaysIso(rangeStart, navStep))} className="p-1 rounded hover:bg-slate-100 text-slate-600" title={`${navStep}日後へ`}><ChevronRight size={16} /></button>
        <span className="text-xs text-slate-400 ml-2 truncate min-w-0 shrink-0">{rangeStart} ～ {addDaysIso(rangeStart, rangeDays - 1)}</span>
        {/* Board filter chips — toggle to hide/show a board's tasks. Click filtering OR Alt-click to solo. */}
        {boards.length > 1 && (
          <div className="flex items-center gap-1 ml-3 min-w-0 overflow-x-auto">
            {boards.map(b => {
              const color = boardColorFor(b, boardIndex.get(b.id) ?? 0)
              const cls = BOARD_COLOR_CLASSES[color]
              const hidden = boardFilter.size > 0 && !boardFilter.has(b.id)
              return (
                <button
                  key={b.id}
                  onClick={ev => {
                    setBoardFilter(s => {
                      const n = new Set(s)
                      if (ev.altKey) {
                        // Alt-click = solo (show only this)
                        return n.size === 1 && n.has(b.id) ? new Set() : new Set([b.id])
                      }
                      if (n.size === 0) {
                        // No filter active → start with everyone except clicked
                        for (const bb of boards) if (bb.id !== b.id) n.add(bb.id)
                      } else if (n.has(b.id)) {
                        n.delete(b.id)
                        if (n.size === 0) return new Set()  // back to "show all"
                      } else {
                        n.add(b.id)
                        if (n.size === boards.length) return new Set()  // all selected = show all
                      }
                      return n
                    })
                  }}
                  title={`${b.name}（クリックで表示/非表示、Alt+クリックで単独表示）`}
                  className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] border transition-all shrink-0 ${hidden ? 'border-slate-200 text-slate-400 bg-white opacity-50' : `${cls.border} ${cls.text} ${cls.bg}`}`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${cls.dot} ${hidden ? 'opacity-30' : ''}`} />
                  <span className="truncate max-w-[80px]">{b.name}</span>
                </button>
              )
            })}
          </div>
        )}
        {/* Zoom preset segmented control — matches the kanban/gantt/calendar view-switcher style */}
        <div className="ml-auto flex items-center rounded-md border border-slate-200 overflow-hidden shrink-0 text-xs">
          {(['default', 'quarter', 'half'] as const).map(k => (
            <button
              key={k}
              onClick={() => setZoomPreset(k)}
              title={k === 'default' ? '標準表示' : k === 'quarter' ? '3ヶ月表示' : '半年表示'}
              className={`px-2 py-0.5 transition-colors ${zoomPreset === k ? 'bg-emerald-500/15 text-emerald-600' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800'}`}
            >
              {k === 'default' ? '標準' : k === 'quarter' ? '3ヶ月' : '半年'}
            </button>
          ))}
        </div>
        <span className="ml-3 text-xs text-slate-500 shrink-0">
          {rows.length - undatedCount} 件
          {undatedCount > 0 && <span className="ml-2 text-amber-600">・未設定 {undatedCount}</span>}
        </span>
      </div>

      {/* Undated row pill quick-action menu (positioned at the clicked pill). */}
      {pillMenu && (
        <div
          data-pill-menu
          className="fixed z-50 bg-white border border-slate-200 rounded-lg shadow-xl text-xs py-1 min-w-[150px]"
          style={{ top: pillMenu.y, left: pillMenu.x }}
        >
          <div className="px-2 py-1 text-[10px] text-slate-400 truncate">{pillMenu.row.task.title || '(無題)'}</div>
          <button onClick={() => applyPillDate(pillMenu.row, 'today')} className="w-full text-left px-3 py-1.5 hover:bg-slate-100">今日 1日</button>
          <button onClick={() => applyPillDate(pillMenu.row, 'week')} className="w-full text-left px-3 py-1.5 hover:bg-slate-100">今日 〜 +6日</button>
        </div>
      )}

      {/* Bar click → inline edit popover. Reuses the same UPDATE_TASK dispatch as the kanban editor. */}
      {editing && (
        <div
          data-edit-popover
          className="fixed z-50 bg-white border border-slate-200 rounded-lg shadow-xl p-3 w-[280px] text-sm"
          style={{ top: Math.min(editing.y, window.innerHeight - 280), left: editing.x }}
        >
          <div className="flex items-center gap-2 mb-2">
            <span className={`w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[editing.row.hasChildren ? aggregateFor(editing.row.board.tasks, editing.row.task).status : editing.row.task.status]}`} />
            <input
              value={editing.row.task.title}
              onChange={e => { patchTask(editing.row, { title: e.target.value }); setEditing(s => s ? { ...s, row: { ...s.row, task: { ...s.row.task, title: e.target.value } } } : s) }}
              placeholder="(無題)"
              className="flex-1 min-w-0 bg-transparent border-b border-slate-200 focus:border-emerald-400 outline-none text-slate-800 font-medium px-0.5 py-0.5"
            />
            <span className="text-[10px] text-slate-400 truncate max-w-[80px]" title={editing.row.board.name}>{editing.row.board.name}</span>
          </div>
          <textarea
            value={editing.row.task.description}
            onChange={e => { patchTask(editing.row, { description: e.target.value }); setEditing(s => s ? { ...s, row: { ...s.row, task: { ...s.row.task, description: e.target.value } } } : s) }}
            placeholder="メモ…"
            rows={2}
            className="w-full bg-slate-50 border border-slate-200 rounded px-2 py-1 text-xs text-slate-700 outline-none focus:border-emerald-400 mb-2 resize-none"
          />
          <div className="flex items-center gap-2 mb-2">
            <span className="text-[10px] text-slate-500 w-10 shrink-0">状態</span>
            {editing.row.hasChildren ? (
              <div className="flex-1 flex flex-col gap-1">
                <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded px-2 py-1 text-xs text-slate-500" title="親タスクの状態は子タスクから自動集計されます。子タスクを変更してください。">
                  <span className={`w-2 h-2 rounded-full ${STATUS_DOT[aggregateFor(editing.row.board.tasks, editing.row.task).status]}`} />
                  <span className="flex-1">
                    {(() => { const s = aggregateFor(editing.row.board.tasks, editing.row.task).status; return s === 'todo' ? '未着手' : s === 'in-progress' ? '進行中' : '完了' })()}
                  </span>
                  <span className="text-[9px] text-slate-400">子から集計</span>
                </div>
                {(() => {
                  const a = aggregateFor(editing.row.board.tasks, editing.row.task)
                  const todoLeaves = a.totalLeaves - a.doneLeaves - a.doingLeaves
                  return (
                    <div className="text-[10px] text-slate-500 px-1 flex items-center gap-1.5">
                      <span className="text-emerald-600">完了 {a.doneLeaves}</span>
                      <span className="text-slate-300">・</span>
                      <span className="text-amber-600">進行中 {a.doingLeaves}</span>
                      <span className="text-slate-300">・</span>
                      <span className="text-slate-500">未着手 {todoLeaves}</span>
                    </div>
                  )
                })()}
              </div>
            ) : (
              <select
                value={editing.row.task.status}
                onChange={e => { patchTask(editing.row, { status: e.target.value as Task['status'] }); setEditing(s => s ? { ...s, row: { ...s.row, task: { ...s.row.task, status: e.target.value as Task['status'] } } } : s) }}
                className="flex-1 bg-slate-50 border border-slate-200 rounded px-2 py-1 text-xs outline-none focus:border-emerald-400"
              >
                <option value="todo">未着手</option>
                <option value="in-progress">進行中</option>
                <option value="done">完了</option>
              </select>
            )}
          </div>
          {/* Parent picker — can be any task across visible boards (cross-board parenting). */}
          {(() => {
            const pool: Task[] = []
            for (const b of boards) for (const t of b.tasks) pool.push(t)
            const blocked = descendantIds(pool, editing.row.task.id)
            blocked.add(editing.row.task.id)
            const boardOf = (id: string) => boards.find(b => b.tasks.some(t => t.id === id))
            const candidates = pool.filter(t => !blocked.has(t.id))
            return (
              <div className="flex items-center gap-1.5 mb-2 text-[11px] text-slate-500">
                <span className="w-10 shrink-0">親</span>
                <select
                  value={editing.row.task.parentId ?? ''}
                  onChange={e => {
                    const v = e.target.value || undefined
                    patchTask(editing.row, { parentId: v })
                    setEditing(s => s ? { ...s, row: { ...s.row, task: { ...s.row.task, parentId: v } } } : s)
                  }}
                  className="flex-1 min-w-0 bg-slate-50 border border-slate-200 rounded px-1.5 py-0.5 outline-none focus:border-emerald-400"
                >
                  <option value="">（ルート）</option>
                  {candidates.map(t => {
                    const b = boardOf(t.id)
                    return <option key={t.id} value={t.id}>{(t.title || '(無題)') + (b ? ` — ${b.name}` : '')}</option>
                  })}
                </select>
                {editing.row.task.parentId && (
                  <button
                    onClick={() => { patchTask(editing.row, { parentId: undefined }); setEditing(s => s ? { ...s, row: { ...s.row, task: { ...s.row.task, parentId: undefined } } } : s) }}
                    title="親から外してルートに戻す"
                    className="text-[10px] px-2 py-0.5 rounded border border-slate-300 text-slate-600 hover:bg-slate-100 shrink-0"
                  >×親解除</button>
                )}
              </div>
            )
          })()}
          <div className="flex items-center gap-1.5 mb-2 text-[11px] text-slate-500">
            <span className="w-10 shrink-0">期間</span>
            <input
              type="date"
              value={editing.row.task.startDate ?? ''}
              onChange={e => { const v = e.target.value || undefined; patchTask(editing.row, { startDate: v }); setEditing(s => s ? { ...s, row: { ...s.row, task: { ...s.row.task, startDate: v } } } : s) }}
              className="flex-1 min-w-0 bg-slate-50 border border-slate-200 rounded px-1.5 py-0.5 outline-none focus:border-emerald-400"
            />
            <span>〜</span>
            <input
              type="date"
              value={editing.row.task.endDate ?? ''}
              onChange={e => { const v = e.target.value || undefined; patchTask(editing.row, { endDate: v }); setEditing(s => s ? { ...s, row: { ...s.row, task: { ...s.row.task, endDate: v } } } : s) }}
              className="flex-1 min-w-0 bg-slate-50 border border-slate-200 rounded px-1.5 py-0.5 outline-none focus:border-emerald-400"
            />
          </div>
          {/* Cross-project sharing: expose this task's span to every other project's
              Gantt — under an alias so the real title stays private. */}
          <div className="mb-2 rounded-md border border-slate-200 bg-slate-50/60 px-2 py-1.5">
            <label className="flex items-center gap-1.5 text-[11px] text-slate-600 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={!!editing.row.task.shared}
                onChange={e => { const v = e.target.checked; patchTask(editing.row, { shared: v || undefined }); setEditing(s => s ? { ...s, row: { ...s.row, task: { ...s.row.task, shared: v || undefined } } } : s) }}
                className="accent-teal-500"
              />
              <CalendarRange size={12} className="text-teal-500" />他のプロジェクトのガントにも表示する
            </label>
            {editing.row.task.shared && (
              <input
                type="text"
                value={editing.row.task.sharedAlias ?? ''}
                onChange={e => { const v = e.target.value; patchTask(editing.row, { sharedAlias: v || undefined }); setEditing(s => s ? { ...s, row: { ...s.row, task: { ...s.row.task, sharedAlias: v || undefined } } } : s) }}
                placeholder="代替タイトル（他プロジェクトでの表示名 / 例: 出張）"
                className="mt-1.5 w-full bg-slate-50 border border-slate-200 rounded px-2 py-1 text-[11px] outline-none focus:border-emerald-400"
              />
            )}
          </div>
          <div className="mb-2">
            <LinkedNotesField task={editing.row.task} onChange={ids => { const v = ids.length > 0 ? ids : undefined; patchTask(editing.row, { linkedNoteIds: v }); setEditing(s => s ? { ...s, row: { ...s.row, task: { ...s.row.task, linkedNoteIds: v } } } : s) }} />
          </div>
          {/* Move / duplicate to another board — operates on the whole subtree. */}
          {boards.filter(b => b.id !== editing.row.board.id).length > 0 && (
            <div className="flex items-center gap-1.5 mb-2 text-[11px] text-slate-500">
              <span className="w-10 shrink-0">ボード</span>
              <select
                value={moveTargetBoardId || boards.find(b => b.id !== editing.row.board.id)?.id || ''}
                onChange={e => setMoveTargetBoardId(e.target.value)}
                className="flex-1 min-w-0 bg-slate-50 border border-slate-200 rounded px-1.5 py-0.5 outline-none focus:border-emerald-400"
              >
                {boards.filter(b => b.id !== editing.row.board.id).map(b => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
              <button
                onClick={() => moveTaskToBoard(editing!.row, moveTargetBoardId || boards.find(b => b.id !== editing!.row.board.id)!.id)}
                className="text-[10px] px-2 py-0.5 rounded border border-slate-300 text-slate-600 hover:bg-slate-100 shrink-0"
                title="このタスクと子孫を選択したボードへ移動"
              >移動</button>
              <button
                onClick={() => duplicateTaskToBoard(editing!.row, moveTargetBoardId || boards.find(b => b.id !== editing!.row.board.id)!.id)}
                className="text-[10px] px-2 py-0.5 rounded border border-slate-300 text-slate-600 hover:bg-slate-100 shrink-0"
                title="このタスクと子孫を選択したボードへ複製"
              >複製</button>
            </div>
          )}
          <div className="flex justify-end gap-2">
            {editing.row.hasChildren && (editing.row.task.startDate || editing.row.task.endDate) && (
              <button
                onClick={() => { patchTask(editing.row, { startDate: undefined, endDate: undefined }); setEditing(s => s ? { ...s, row: { ...s.row, task: { ...s.row.task, startDate: undefined, endDate: undefined } } } : s) }}
                className="text-[10px] text-slate-400 hover:text-rose-500 px-2"
                title="親の明示日付を消して子からの集計に戻す"
              >×集計に戻す</button>
            )}
            <button onClick={() => setEditing(null)} className="text-xs px-3 py-1 rounded bg-emerald-500 text-white hover:bg-emerald-600">閉じる</button>
          </div>
        </div>
      )}

      {/* Date header (sticky on top, mirrors body's horizontal scroll) */}
      <div className="flex border-b border-slate-200 shrink-0">
        <div className={`shrink-0 border-r border-slate-200 bg-slate-50 ${leftResizing ? '' : 'transition-[width] duration-200'}`} style={{ width: leftSlotW }}>
          <div className="h-14 px-3 flex items-center justify-between text-[11px] font-semibold text-slate-500 uppercase tracking-wide">
            {leftCollapsed ? (
              <button onClick={() => setLeftCollapsed(false)} title="タスクパネルを開く" className="w-full flex items-center justify-center text-slate-400 hover:text-slate-700"><PanelLeftOpen size={14} /></button>
            ) : (
              <>
                <span className="truncate">タスク（{rows.length}件{undatedCount > 0 && <span className="ml-1 text-amber-600 normal-case">・未設定 {undatedCount}</span>}）</span>
                <button onClick={() => setLeftCollapsed(true)} title="タスクパネルを畳む" className="p-0.5 rounded hover:bg-slate-200 text-slate-400 hover:text-slate-700 shrink-0"><PanelLeftClose size={14} /></button>
              </>
            )}
          </div>
          {/* Shared-schedule lane label — only when other projects have shared tasks. */}
          {bandMasterId && sharedExternal.length > 0 && !leftCollapsed && (
            <div className="h-[22px] px-3 flex items-center border-t border-slate-100 text-[10px] text-slate-400 normal-case tracking-normal"
                 title="他のプロジェクトで「他プロジェクトにも表示」にしたタスクの予定（代替タイトルで表示・ここでは編集不可）">
              <span className="flex items-center gap-1 truncate"><CalendarRange size={11} className="text-teal-500 shrink-0" />他プロジェクトの予定</span>
            </div>
          )}
        </div>
        <div ref={headerScrollRef} className="flex-1 min-w-0 overflow-hidden">
          <div className="relative" style={{ width: days.length * DAY_W }}>
            {/* Month strip — labels only; alternate-month tint helps the eye snap to month chunks. */}
            <div className="h-6 flex relative">
              {monthSpans.map((m, idx) => (
                <div key={m.label} className={`absolute top-0 h-6 flex items-center justify-center text-[11px] font-medium text-slate-700 ${idx % 2 === 0 ? 'bg-slate-50' : 'bg-slate-100/80'}`}
                     style={{ left: m.start * DAY_W, width: m.len * DAY_W }}>
                  {m.label}
                </div>
              ))}
            </div>
            {/* Day cells: weekday glyph above day number, with Sat/Sun tinted. The month-start
                boundary is drawn separately so it sits on the exact same pixel column as the month strip. */}
            <div className="h-8 flex relative">
              {days.map(d => {
                const dow = d.date.getDay()
                const weekend = dow === 0 || dow === 6
                const isToday = d.iso === todayIso
                const holiday = holidayNameFor(d.iso)
                // 色: 日曜 + 祝日 = rose, 土曜 = sky, 平日 = slate. 今日は sky-700。
                const colorClass = isToday
                  ? 'text-sky-700'
                  : (holiday || dow === 0) ? 'text-rose-600'
                  : dow === 6 ? 'text-sky-600'
                  : 'text-slate-600'
                const wdColorClass = isToday ? 'text-sky-600'
                  : (holiday || dow === 0) ? 'text-rose-500'
                  : dow === 6 ? 'text-sky-500'
                  : 'text-slate-400'
                return (
                  <div key={d.iso}
                       title={holiday ? `祝日: ${holiday}` : ''}
                       className={`flex flex-col items-center justify-center leading-none border-r border-slate-100 shrink-0 ${weekend ? 'bg-slate-100/70' : ''} ${holiday ? 'bg-rose-50/60' : ''} ${dow === 6 ? 'border-l border-slate-200/70' : ''} ${isToday ? 'bg-sky-50 font-semibold' : ''}`}
                       style={{ width: DAY_W }}>
                    {DAY_W >= 14 && <span className={`text-[8px] ${wdColorClass}`}>{WEEKDAY[dow]}</span>}
                    {DAY_W >= 12 && (
                      DAY_W >= 18
                        ? <span className={`text-[11px] ${colorClass}`}>{d.date.getDate()}</span>
                        : <span className={`text-[10px] ${colorClass}`}>{d.date.getDate()}</span>
                    )}
                  </div>
                )
              })}
              {/* Today pill anchored to today's column — slim so it fits within one cell at quarter zoom. */}
              {todayIdx >= 0 && (
                <div className="absolute -top-[1px] z-10 px-0.5 h-3.5 flex items-center text-[8px] font-semibold text-white bg-sky-500 rounded-sm shadow-sm pointer-events-none"
                     style={{ left: todayIdx * DAY_W + DAY_W / 2, transform: 'translateX(-50%)' }}>
                  今日
                </div>
              )}
            </div>
            {/* Shared-schedule lane — READ-ONLY spans of tasks shared from OTHER
                projects, shown under their alias. Edit them in their own project. */}
            {bandMasterId && sharedExternal.length > 0 && (
              <div className="relative h-[22px] border-t border-slate-100 bg-slate-50/40 z-20">
                {sharedExternal.map(s => {
                  const [a, b] = bandCols(s)
                  const cls = BOARD_COLOR_CLASSES[s.color]
                  return (
                    <div key={s.id}
                         title={`${s.alias}（${s.boardName} の共有予定 / ${s.start} 〜 ${s.end}）`}
                         className={`absolute top-[2px] h-[18px] rounded border border-dashed ${cls.bg} ${cls.border} ${cls.text} text-[10px] flex items-center px-1.5 overflow-hidden shadow-sm`}
                         style={{ left: a * DAY_W + 1, width: Math.max(10, (b - a + 1) * DAY_W - 2) }}>
                      <span className="truncate font-medium">{s.alias}</span>
                    </div>
                  )
                })}
              </div>
            )}
            {/* Month boundary lines — single 2px column shared by the month strip and the day strip so they
                never look offset against each other. Skip the very first span (no boundary before day 0). */}
            {monthSpans.slice(1).map(m => (
              <div key={`mb-${m.label}`} className="absolute top-0 bottom-0 w-[2px] bg-slate-300 pointer-events-none"
                   style={{ left: m.start * DAY_W }} />
            ))}
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 flex min-h-0 min-w-0">
        {/* Left: task list — collapsible + resizable. */}
        <div className={`relative shrink-0 ${leftResizing ? '' : 'transition-[width] duration-200'}`} style={{ width: leftSlotW }}>
          <div
            ref={taskListRef}
            onScroll={onTaskListScroll}
            onMouseEnter={onLeftEnter}
            onMouseLeave={onLeftLeave}
            className={`absolute inset-y-0 left-0 border-r border-slate-200 overflow-y-auto bg-white ${leftResizing ? '' : 'transition-[width] duration-200'} ${leftCollapsed && leftHover ? 'shadow-2xl z-20' : ''}`}
            style={{ width: leftPanelW }}
          >
          {leftCollapsed && !leftHover ? (
            <button
              onClick={() => setLeftCollapsed(false)}
              title="タスクパネルを開く"
              className="w-full flex items-center justify-center p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100"
            >
              <PanelLeftOpen size={16} />
            </button>
          ) : rows.length === 0 ? (
            <div className="p-4 text-xs text-slate-400">カンバンでタスクを追加するとここに並びます。</div>
          ) : (
            rows.map((r, i) => {
              if (r.kind === 'header') {
                const cls = BOARD_COLOR_CLASSES[r.colorKey]
                return (
                  <div key={`hdr-${i}`} className={`flex items-center gap-2 px-3 border-b border-t border-slate-200 text-[11px] font-semibold ${cls.bg} ${cls.text}`}
                       style={{ height: ROW_H }}>
                    <span className={`w-2 h-2 rounded-full shrink-0 ${cls.dot}`} />
                    <span className="truncate flex-1">{r.label}</span>
                    <span className="text-[10px] opacity-70 shrink-0">{r.taskCount}件</span>
                  </div>
                )
              }
              const isCollapsed = collapsed.has(r.task.id)
              const undated = !r.span
              const rowStatus = r.hasChildren ? aggregateFor(r.board.tasks, r.task).status : r.task.status
              const hov = hoveredId === r.task.id
              // Tree guides: render full-height ancestor lines at each ancestor depth,
              // plus an L-bracket at this row's own depth. The L stops at row mid if this is
              // the last sibling at that depth (└), continues full-height otherwise (├).
              const next = rows[i + 1]
              const lastSibling = !next || next.kind === 'header' || next.depth < r.depth
              const isDropBefore = dropTarget?.taskId === r.task.id && dropTarget.zone === 'before'
              const isDropNest = dropTarget?.taskId === r.task.id && dropTarget.zone === 'nest'
              return (
                <div key={r.task.id}
                     draggable
                     onDragStart={ev => {
                       ev.stopPropagation()
                       dragTaskRef.current = { taskId: r.task.id, boardId: r.board.id }
                       ev.dataTransfer.effectAllowed = 'copyMove'
                       ev.dataTransfer.setData('text/plain', r.task.id)
                       // Cross-page payload so the Canvas drop handler can create a linked card.
                       ev.dataTransfer.setData('application/x-constella-ref', JSON.stringify({ kind: 'task', id: r.task.id }))
                     }}
                     onDragOver={ev => {
                       const drag = dragTaskRef.current
                       if (!drag || drag.taskId === r.task.id) return
                       const sameBoard = drag.boardId === r.board.id
                       ev.preventDefault()
                       const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect()
                       const zone = ev.clientY < rect.top + rect.height / 2 ? 'before' : 'nest'
                       // Reorder ("before") still requires same board — order within a board's task list is per-board.
                       // Nest, by contrast, can now cross boards (parentId points anywhere in the master project).
                       if (zone === 'before' && !sameBoard) return
                       if (zone === 'nest') {
                         const pool: Task[] = []
                         for (const b of boards) for (const t of b.tasks) pool.push(t)
                         if (wouldCycle(pool, drag.taskId, r.task.id)) return
                       }
                       setDropTarget(p => (p?.taskId === r.task.id && p.zone === zone) ? p : { taskId: r.task.id, zone })
                     }}
                     onDragLeave={ev => {
                       const next = (ev.relatedTarget as HTMLElement | null)?.closest('[data-gantt-row]')
                       if (!next || next === ev.currentTarget) setDropTarget(p => p?.taskId === r.task.id ? null : p)
                     }}
                     onDrop={ev => {
                       ev.preventDefault()
                       ev.stopPropagation()
                       const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect()
                       const zone = ev.clientY < rect.top + rect.height / 2 ? 'before' : 'nest'
                       if (zone === 'before') ganttDropBefore(r); else ganttNestInto(r)
                     }}
                     onMouseEnter={() => setHoveredId(r.task.id)}
                     onMouseLeave={() => setHoveredId(p => p === r.task.id ? null : p)}
                     onClick={ev => {
                       // Don't fire when the user clicked the chevron (toggleCollapse) or a nested control.
                       const tgt = ev.target as HTMLElement
                       if (tgt.closest('button')) return
                       onSelectTask?.(r.task.id)
                       openEditorAtRect(r, (ev.currentTarget as HTMLElement).getBoundingClientRect())
                     }}
                     data-gantt-row
                     className={`relative flex items-center gap-1.5 pr-2 border-b border-slate-100 text-sm transition-colors cursor-pointer ${hov ? 'bg-indigo-50/60' : (undated ? 'bg-amber-50/40' : '')} ${isDropNest ? 'ring-2 ring-inset ring-emerald-400 bg-emerald-50/60' : ''} ${selectedTaskId === r.task.id ? 'ring-2 ring-inset ring-indigo-400/60' : ''}`}
                     style={{ height: ROW_H, paddingLeft: 10 + r.depth * 14 }}
                     title="クリックで編集 ／ ドラッグで並べ替え・親子化">
                  {/* Drop-BEFORE indicator: thin emerald line at the row's top edge */}
                  {isDropBefore && (
                    <span className="pointer-events-none absolute -top-px left-0 right-0 h-0.5 bg-emerald-500 z-10" />
                  )}
                  {/* status stripe — vertical pill on the left edge, replaces the tiny dot */}
                  <span className={`absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r ${STATUS_DOT[rowStatus]}`} />
                  {/* Tree connector guides: vertical hairline per ancestor depth + L-bracket at own depth */}
                  {Array.from({ length: r.depth }).map((_, k) => {
                    const isOwn = k === r.depth - 1
                    const x = 10 + k * 14 + 6
                    const vertH = isOwn && lastSibling ? ROW_H / 2 : ROW_H
                    return (
                      <span key={`g-${k}`} className="pointer-events-none">
                        <span className="absolute bg-slate-300/80" style={{ left: x, top: 0, width: 1, height: vertH }} />
                        {isOwn && (
                          <span className="absolute bg-slate-300/80" style={{ left: x, top: ROW_H / 2 - 0.5, width: 9, height: 1 }} />
                        )}
                      </span>
                    )
                  })}
                  {r.hasChildren ? (
                    <button onClick={() => toggleCollapse(r.task.id)} className="p-0.5 -ml-0.5 rounded hover:bg-slate-200 text-slate-400 shrink-0">
                      {isCollapsed ? <ChevRight size={12} /> : <ChevronDown size={12} />}
                    </button>
                  ) : <span className="w-4 shrink-0" />}
                  <span className={`truncate ${r.hasChildren ? 'font-medium text-slate-700' : undated ? 'text-slate-500 italic' : 'text-slate-600'}`}>{r.task.title || '(無題)'}</span>
                  {r.task.shared && <span className="shrink-0" title={`他プロジェクトのガントに「${r.task.sharedAlias || '予定'}」として表示中`}><CalendarRange size={11} className="text-teal-500" /></span>}
                  {(r.task.linkedNoteIds?.length ?? 0) > 0 && (
                    <FileText size={10} className="text-indigo-400 shrink-0" />
                  )}
                  {(() => {
                    const boardCol = boardColorFor(r.board, boardIndex.get(r.board.id) ?? 0)
                    const bcCls = BOARD_COLOR_CLASSES[boardCol]
                    return (
                      <span className={`ml-auto text-[10px] truncate max-w-[80px] inline-flex items-center gap-1 ${bcCls.text}`} title={r.board.name}>
                        <span className={`w-1.5 h-1.5 rounded-full ${bcCls.dot} shrink-0`} />
                        <span className="truncate">{r.board.name}</span>
                      </span>
                    )
                  })()}
                </div>
              )
            })
          )}
          {/* + add task button — appended to the bottom of the list when expanded. Picks the first board
              of the active master project; the user can re-parent via Kanban after creation. */}
          {!leftCollapsed && boards.length > 0 && (
            <button
              onClick={() => {
                const targetBoard = boards[0]
                const task: Task = {
                  id: generateId(),
                  title: '新しいタスク',
                  description: '',
                  status: 'todo',
                  tags: [],
                  createdAt: new Date().toISOString(),
                }
                dispatch({ type: 'ADD_TASK', payload: { projectId: targetBoard.id, task } })
              }}
              className="w-full flex items-center gap-1.5 px-3 py-2 text-xs text-slate-500 hover:text-emerald-600 hover:bg-emerald-50/60 border-t border-slate-100 sticky bottom-0 bg-white/95 backdrop-blur-sm"
              title={`「${boards[0]?.name ?? ''}」にタスクを追加`}
            >
              <span className="text-base leading-none">+</span> タスクを追加
            </button>
          )}
          </div>
          {/* Right-edge resize handle — only when expanded */}
          {leftExpanded && (
            <div
              onMouseDown={startLeftResize}
              title="ドラッグで幅を調整"
              className={`absolute top-0 bottom-0 right-0 w-1.5 cursor-ew-resize hover:bg-indigo-300/60 ${leftResizing ? 'bg-indigo-400/70' : ''} transition-colors z-30`}
            />
          )}
        </div>
        {/* Right: chart */}
        <div ref={bodyScrollRef} onScroll={onBodyScroll} className="flex-1 min-w-0 overflow-auto relative">
          <div className="relative" style={{ width: days.length * DAY_W, height: rows.length * ROW_H }}>
            {/* Alternate-month background tint — odd-index months get a slightly darker wash so the eye
                groups bars by month at a glance. Rendered BEHIND the day grid lines so weekends still read. */}
            {monthSpans.map((m, idx) => (
              idx % 2 === 1 ? (
                <div key={`mbg-${m.label}`} className="absolute top-0 bottom-0 bg-slate-100/60 pointer-events-none"
                     style={{ left: m.start * DAY_W, width: m.len * DAY_W }} />
              ) : null
            ))}
            {/* Day grid lines — weekends cool-tinted; Saturday picks up the weekly boundary line.
                Month boundaries are drawn as separate overlay lines below so they share the exact
                pixel column as the header strip. */}
            <div className="absolute inset-0 flex">
              {days.map(d => {
                const dow = d.date.getDay()
                const weekend = dow === 0 || dow === 6
                const holiday = !!holidayNameFor(d.iso)
                return <div key={d.iso} className={`border-r border-slate-100 shrink-0 ${weekend ? 'bg-slate-100/60' : ''} ${holiday ? 'bg-rose-50/50' : ''} ${dow === 6 ? 'border-l border-slate-200/70' : ''}`} style={{ width: DAY_W }} />
              })}
            </div>
            {/* Month boundary lines spanning the full chart body — pixel-aligned with the header boundary lines. */}
            {monthSpans.slice(1).map(m => (
              <div key={`mb-body-${m.label}`} className="absolute top-0 bottom-0 w-[2px] bg-slate-300/80 pointer-events-none"
                   style={{ left: m.start * DAY_W }} />
            ))}
            {/* Shared-schedule tint — a pale full-height wash over each external shared
                task's span so you can see when other projects claim your time. */}
            {bandMasterId && sharedExternal.map(s => {
              const [a, b] = bandCols(s)
              const cls = BOARD_COLOR_CLASSES[s.color]
              return (
                <div key={`sharedbg-${s.id}`} className={`absolute top-0 bottom-0 ${cls.bgSoft} pointer-events-none`}
                     style={{ left: a * DAY_W, width: (b - a + 1) * DAY_W }} />
              )
            })}
            {/* Today line — thicker, sky-tinted to match the date header pill */}
            {todayIdx >= 0 && (
              <div className="absolute top-0 bottom-0 w-[1.5px] bg-sky-500/80 pointer-events-none" style={{ left: todayIdx * DAY_W + DAY_W / 2 - 0.75 }} />
            )}
            {/* Row separators + cross-pane hover highlight strip. Headers get a tinted band. */}
            {rows.map((r, i) => {
              if (r.kind === 'header') {
                // Body-side header: lightweight border markers only (no opaque bg) so the
                // day grid, weekends, today line, and month boundary lines all keep showing through.
                return (
                  <div key={`bg-hdr-${i}`} className="absolute left-0 right-0 border-b-2 border-t-2 border-slate-300 pointer-events-none" style={{ top: i * ROW_H, height: ROW_H }} />
                )
              }
              return (
                <div key={r.task.id + '-bg'}>
                  <div className="absolute left-0 right-0 border-b border-slate-100" style={{ top: (i + 1) * ROW_H - 1, height: 1 }} />
                  {hoveredId === r.task.id && (
                    <div className="absolute left-0 right-0 bg-indigo-50/60 pointer-events-none" style={{ top: i * ROW_H, height: ROW_H }} />
                  )}
                </div>
              )
            })}
            {/* Full-row hit zones for cross-pane hover. For UNDATED task rows the
                whole timeline row is also the pen-drag surface — press anywhere on
                the row and drag to draw the period (not just on the 未設定 pill). */}
            {rows.map((r, i) => r.kind === 'task' && (
              <div key={r.task.id + '-hit'}
                   onMouseEnter={() => setHoveredId(r.task.id)}
                   onMouseLeave={() => setHoveredId(p => p === r.task.id ? null : p)}
                   onMouseDown={!r.span ? (ev => startPenDrag(ev, r)) : undefined}
                   className={`absolute left-0 right-0 pointer-events-auto ${!r.span ? 'cursor-crosshair' : ''}`}
                   style={{ top: i * ROW_H, height: ROW_H, zIndex: 0 }} />
            ))}
            {/* Pen-drag ghost: shows the date range the user is drawing for an undated row */}
            {penDragRef.current && (() => {
              const d = penDragRef.current!
              const _ = penDragTick // ensure re-render on tick
              void _
              const i = rows.findIndex(r => r.kind === 'task' && r.task.id === d.row.task.id)
              if (i < 0) return null
              const a = Math.min(d.startCol, d.pointerCol)
              const b = Math.max(d.startCol, d.pointerCol)
              return (
                <div
                  className="absolute pointer-events-none rounded-md bg-amber-400/70 border-2 border-amber-500 shadow-md flex items-center justify-center text-[10px] text-white font-semibold"
                  style={{ top: i * ROW_H + 4, left: a * DAY_W + 2, width: (b - a + 1) * DAY_W - 4, height: ROW_H - 8 }}
                >
                  {addDaysIso(rangeStart, a)} 〜 {addDaysIso(rangeStart, b)}
                </div>
              )
            })()}
            {/* Bars */}
            {rows.map((r, i) => {
              if (r.kind === 'header') return null
              // Undated rows: dashed placeholder pill pinned to the chart's left edge (column 0 of
               // the rendered range). Re-positioned on horizontal scroll so it stays visible.
              if (!r.span) {
                const pillW = 96
                const pillLeft = scrollLeft + 4
                return (
                  <div key={r.task.id} className="absolute z-[5]" style={{ top: i * ROW_H + 5, left: pillLeft, width: pillW, height: ROW_H - 10 }}>
                    <button
                      onMouseDown={ev => startPenDrag(ev, r)}
                      title="日付未設定 — ドラッグして期間を描く / クリックで割り当て"
                      className="w-full h-full rounded-md border border-dashed border-amber-400/80 bg-amber-50 hover:bg-amber-100 text-[10px] text-amber-700 flex items-center justify-center gap-1 transition-all shadow-sm cursor-crosshair"
                    >
                      <span className="w-1 h-1 rounded-full bg-amber-500" />
                      未設定
                    </button>
                  </div>
                )
              }
              const drag = dragRef.current?.taskId === r.task.id ? dragRef.current : null
              const sIso = drag ? drag.previewStart : r.span.start
              const eIso = drag ? drag.previewEnd : r.span.end
              const startIdx = daysBetween(rangeStart, sIso)
              const len = daysBetween(sIso, eIso) + 1
              if (startIdx + len <= 0 || startIdx >= days.length) return null
              const clipL = Math.max(0, -startIdx)
              const clipR = Math.max(0, startIdx + len - days.length)
              const left = (startIdx + clipL) * DAY_W + 2
              const width = (len - clipL - clipR) * DAY_W - 4
              // Parents show as a thinner outline-style bar (computed from children);
              // leaves are solid in their own status colour and are the draggable ones.
              const status = r.hasChildren ? aggregateFor(r.board.tasks, r.task).status : r.task.status
              const color = STATUS_COLOR[status]
              // Overflow striped overlay for explicit parents whose children poke out.
              const overflowOverlay = (r.hasChildren && r.hasExplicitParentDates && r.childRange && r.span)
                ? (() => {
                    const cs = r.childRange!.start && r.childRange!.start < r.span!.start ? r.childRange!.start : r.span!.start
                    const ce = r.childRange!.end && r.childRange!.end > r.span!.end ? r.childRange!.end : r.span!.end
                    const oStart = daysBetween(rangeStart, cs)
                    const oLen = daysBetween(cs, ce) + 1
                    if (oStart + oLen <= 0 || oStart >= days.length) return null
                    const oClipL = Math.max(0, -oStart)
                    const oClipR = Math.max(0, oStart + oLen - days.length)
                    const oLeft = (oStart + oClipL) * DAY_W + 2
                    const oWidth = (oLen - oClipL - oClipR) * DAY_W - 4
                    return { left: oLeft, width: oWidth }
                  })()
                : null
              if (r.hasChildren && !r.hasExplicitParentDates) {
                const aggP = aggregateFor(r.board.tasks, r.task)
                const donePct = aggP.totalLeaves ? (aggP.doneLeaves / aggP.totalLeaves) * 100 : 0
                const doingPct = aggP.totalLeaves ? (aggP.doingLeaves / aggP.totalLeaves) * 100 : 0
                return (
                  <div key={r.task.id} className="absolute cursor-pointer" style={{ top: i * ROW_H + 12, left, width, height: ROW_H - 22, zIndex: 2 }}
                       onClick={ev => { onSelectTask?.(r.task.id); openEditorAtRect(r, (ev.currentTarget as HTMLElement).getBoundingClientRect()) }}
                       title={`${r.task.title || '(無題)'}\n${sIso} 〜 ${eIso}（子から集計）\n完了 ${aggP.doneLeaves} ・ 進行中 ${aggP.doingLeaves} ・ 未着手 ${aggP.totalLeaves - aggP.doneLeaves - aggP.doingLeaves} — クリックで編集`}>
                    <div className="relative h-full rounded-md border border-slate-500/50 overflow-hidden bg-slate-200/40">
                      <div className="absolute inset-y-0 left-0 flex h-full">
                        <div className="h-full bg-emerald-500/70" style={{ width: `${donePct}%` }} />
                        <div className="h-full bg-amber-500/80" style={{ width: `${doingPct}%` }} />
                      </div>
                    </div>
                  </div>
                )
              }
              const overflowTitle = r.hasChildren && r.hasExplicitParentDates && r.childRange
                ? `\n⚠ 子タスクが親の期間を超えています (${r.childRange.start ?? '…'} 〜 ${r.childRange.end ?? '…'})`
                : (r.violatesAncestor ? `\n⚠ 親「${r.violatesAncestor.title}」(${r.violatesAncestor.start ?? '…'} 〜 ${r.violatesAncestor.end ?? '…'}) の範囲を超えています` : '')
              // Slipping = leaf, not done, end date already passed today (today line present).
              const isSlipping = !r.hasChildren && r.task.status !== 'done' && todayIdx >= 0 && eIso < todayIso
              const slipBy = isSlipping ? daysBetween(eIso, todayIso) : 0
              const barWarnRing = (r.hasChildren && r.childRange) || r.violatesAncestor
                ? 'ring-2 ring-rose-400'
                : (isSlipping ? 'ring-1 ring-rose-300/70' : '')
              const explicitParentDecor = r.hasChildren && r.hasExplicitParentDates ? 'ring-2 ring-inset ring-white/60 border border-slate-700/40' : ''
              // Slipping tail geometry: dashed line from bar's right edge to today's column.
              const tail = isSlipping ? (() => {
                const tailL = (startIdx + clipL + (len - clipL - clipR)) * DAY_W + 2 - 2
                const tailR = todayIdx * DAY_W + DAY_W / 2
                return { left: tailL, width: Math.max(0, tailR - tailL) }
              })() : null
              return (
                <div key={r.task.id} className="group/row" style={{ zIndex: 2 }}>
                  {overflowOverlay && (
                    <div className="absolute pointer-events-none rounded-md border border-rose-400/70"
                         style={{
                           top: i * ROW_H + 10, left: overflowOverlay.left, width: overflowOverlay.width, height: ROW_H - 20,
                           backgroundImage: 'repeating-linear-gradient(45deg, rgba(244,63,94,0.35) 0 4px, transparent 4px 8px)',
                         }}
                         title={`子タスクが親の期間を超えています`} />
                  )}
                  {tail && tail.width > 4 && (
                    <>
                      <div className="absolute pointer-events-none border-t-2 border-dashed border-rose-400"
                           style={{ top: i * ROW_H + ROW_H / 2, left: tail.left, width: tail.width, height: 0 }} />
                      <div className="absolute pointer-events-none text-[9px] font-semibold text-rose-500"
                           style={{ top: i * ROW_H + 2, left: tail.left + 4 }}>
                        +{slipBy}d
                      </div>
                    </>
                  )}
                  <div className="absolute" style={{ top: i * ROW_H + 4, left, width, height: ROW_H - 8 }}>
                    <div
                      onMouseDown={ev => { mouseDownRef.current = { x: ev.clientX, y: ev.clientY }; onBarDown(ev, r, 'move') }}
                      onClick={ev => {
                        const md = mouseDownRef.current
                        if (md && Math.hypot(ev.clientX - md.x, ev.clientY - md.y) < 4) {
                          onSelectTask?.(r.task.id)
                          openEditorAtRect(r, (ev.currentTarget as HTMLElement).getBoundingClientRect())
                        }
                      }}
                      title={`${r.task.title || '(無題)'} \n${sIso} 〜 ${eIso}${r.hasChildren && r.hasExplicitParentDates ? '（明示）' : ''}${isSlipping ? `\n⚠ 期限を ${slipBy}日 過ぎています` : ''}${overflowTitle}\n— クリックで編集`}
                      className={`relative h-full rounded-md ${color} ${explicitParentDecor} ${barWarnRing} text-[11px] flex items-center px-2 shadow-sm hover:shadow-md hover:-translate-y-[1px] transition-all duration-150 cursor-grab active:cursor-grabbing group/bar overflow-hidden`}
                    >
                      {/* Board accent stripe — left edge tells you which board the bar belongs to at a glance */}
                      <span className={`absolute left-0 top-0 bottom-0 w-1 ${BOARD_COLOR_CLASSES[boardColorFor(r.board, boardIndex.get(r.board.id) ?? 0)].stripe} pointer-events-none`} />
                      <span className="truncate flex-1 pointer-events-none pl-1">{r.task.title || '(無題)'}</span>
                      {/* Resize handles — wider hit zone (w-2.5), with double-bar grip that fades in on bar hover */}
                      <div onMouseDown={ev => onBarDown(ev, r, 'left')} className="absolute left-0 top-0 bottom-0 w-2.5 cursor-ew-resize z-10 flex items-center justify-center gap-[1.5px] opacity-0 group-hover/bar:opacity-70 transition-opacity">
                        <div className="w-[1.5px] h-2.5 rounded-full bg-white/80" />
                        <div className="w-[1.5px] h-2.5 rounded-full bg-white/80" />
                      </div>
                      <div onMouseDown={ev => onBarDown(ev, r, 'right')} className="absolute right-0 top-0 bottom-0 w-2.5 cursor-ew-resize z-10 flex items-center justify-center gap-[1.5px] opacity-0 group-hover/bar:opacity-70 transition-opacity">
                        <div className="w-[1.5px] h-2.5 rounded-full bg-white/80" />
                        <div className="w-[1.5px] h-2.5 rounded-full bg-white/80" />
                      </div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
