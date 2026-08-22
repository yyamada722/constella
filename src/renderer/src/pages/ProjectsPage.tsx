import { useState, useRef, useEffect, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Plus, MoreHorizontal, Pencil, LayoutGrid, GanttChartSquare, CalendarDays, ChevronRight, ChevronDown, ListTree, AlignLeft, CornerDownRight, PanelLeftClose, PanelLeftOpen, FileText, Trash2, Copy, X, ListPlus, Sparkles, Circle, CircleDot, CheckCircle2, Paperclip } from 'lucide-react'
import { useApp } from '../store'
import { Task, Project, BoardColor } from '../types'
import { generateId } from '../utils'
import { aggregateFor, childrenMap, descendantIds, rootsOf, wouldCycle } from '../utils/taskTree'
import { BOARD_COLOR_CLASSES, ALL_BOARD_COLORS, boardColorFor } from '../utils/boardColor'
import { SearchInput } from '../components/SearchInput'
import LinkedNotesField from '../components/LinkedNotesField'
import LinkedFilesField from '../components/LinkedFilesField'
import NotePanel from '../components/NotePanel'
import { confirmDialog, chooseDialog } from '../components/ConfirmDialog'
import { usePopoverDismiss } from '../components/usePopoverDismiss'
import GanttView from './GanttView'
import CalendarView from './CalendarView'

type ViewMode = 'kanban' | 'gantt' | 'calendar'
type KanbanMode = 'flat' | 'tree'

const columns = [
  { key: 'todo' as const, label: '未着手', color: 'border-slate-400' },
  { key: 'in-progress' as const, label: '進行中', color: 'border-amber-500' },
  { key: 'done' as const, label: '完了', color: 'border-emerald-500' },
]

// Prompt template copied to the clipboard for the "一括タスク追加" flow.
// Designed to make an AI emit a strict JSON array the parser can consume.
const BULK_PROMPT_TEMPLATE = `以下のスキーマに**厳密に**従ってタスクをJSON配列で出力してください。

[
  {
    "title": "タスク名（必須）",
    "description": "詳細説明（省略可）",
    "status": "todo",
    "startDate": "YYYY-MM-DD",
    "endDate":   "YYYY-MM-DD",
    "tags": ["タグ1", "タグ2"],
    "children": [
      { "title": "サブタスク", "status": "todo", "children": [] }
    ]
  }
]

絶対に守るルール:
1. 親子関係は **"children" キーの配列のみ** で表現する。
   - "subtasks" / "subTasks" / "tasks" / "items" / "子" など他のキー名は禁止。
   - parentId フィールドは使わない（パーサが自動で付与する）。
2. status は **"todo" / "in-progress" / "done" の3値のみ**。日本語（未着手/進行中/完了）でも可。
3. 日付は **YYYY-MM-DD** 形式。可能な限り startDate / endDate を埋めること。
4. title だけ必須、他は省略可。
5. フラット（入れ子なし）の配列にしてはいけない。タスクが階層を持つなら必ず children を使う。
6. 応答はJSON配列のみ。\`\`\`json などのコードフェンス・前置き・解説は不要。

指示:
[ここに作りたいタスクの概要・期間を書く。納期/開始日/締切も指定すると startDate/endDate が埋まる]
`

type BulkNode = {
  title?: unknown
  description?: unknown
  status?: unknown
  startDate?: unknown
  endDate?: unknown
  tags?: unknown
  // Children alias-friendly: accept whichever key the LLM emitted.
  children?: unknown
  subtasks?: unknown
  subTasks?: unknown
  sub_tasks?: unknown
  tasks?: unknown
  items?: unknown
  '子'?: unknown
  '子タスク'?: unknown
  childTasks?: unknown
  // Date aliases.
  start?: unknown
  end?: unknown
  due?: unknown
  deadline?: unknown
}

type BulkResult =
  | { ok: true; flat: Task[]; rootCount: number; childCount: number; source: 'JSON' | 'Markdown' }
  | { ok: false; error: string }

function coerceStatus(v: unknown): Task['status'] {
  if (typeof v !== 'string') return 'todo'
  const s = v.trim().toLowerCase()
  if (s === 'in-progress' || s === 'inprogress' || s === 'in_progress' || s === 'wip' || s === 'doing' || s === '進行中' || s === '作業中') return 'in-progress'
  if (s === 'done' || s === 'completed' || s === 'complete' || s === 'finished' || s === '完了' || s === '済' || s === '終了') return 'done'
  return 'todo'
}

function coerceDate(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const s = v.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  // YYYY/MM/DD → YYYY-MM-DD (LLMs occasionally emit this form).
  const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(s)
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
  return undefined
}

// Accept whichever child-array key the LLM used. Returns the first non-empty array found.
function pickChildren(n: BulkNode): BulkNode[] | undefined {
  const keys = ['children', 'subtasks', 'subTasks', 'sub_tasks', 'childTasks', 'tasks', 'items', '子', '子タスク'] as const
  for (const k of keys) {
    const v = (n as Record<string, unknown>)[k]
    if (Array.isArray(v) && v.length > 0) return v as BulkNode[]
  }
  return undefined
}

// Parse the bulk-add textarea into a flat (parent-before-children) Task[] with parentId set.
// Tries JSON first (matches the prompt template); falls back to markdown bullet-list with
// 2-space indent nesting. Returns a tagged result so the UI can show a friendly error.
function parseBulkInput(raw: string): BulkResult {
  const text = raw.trim()
  if (!text) return { ok: false, error: '' }
  // (a) JSON
  try {
    const data = JSON.parse(text)
    if (!Array.isArray(data)) throw new Error('JSONの最上位は配列である必要があります')
    const tasks: Task[] = []
    let rootCount = 0
    let childCount = 0
    const walk = (nodes: BulkNode[], parentId?: string) => {
      for (const n of nodes) {
        if (!n) continue
        // If this node has no valid title, still descend into its children — we
        // treat it as a transparent grouping node instead of silently orphaning
        // its subtree.
        if (typeof n.title !== 'string' || !n.title.trim()) {
          const kidsOnly = pickChildren(n)
          if (kidsOnly) walk(kidsOnly, parentId)
          continue
        }
        const id = generateId()
        // Date aliases: prefer the canonical key but accept common alternatives.
        const startDate = coerceDate(n.startDate) ?? coerceDate(n.start)
        const endDate = coerceDate(n.endDate) ?? coerceDate(n.end) ?? coerceDate(n.due) ?? coerceDate(n.deadline)
        const t: Task = {
          id,
          title: n.title.trim(),
          description: typeof n.description === 'string' ? n.description : '',
          status: coerceStatus(n.status),
          tags: Array.isArray(n.tags) ? n.tags.filter((x): x is string => typeof x === 'string') : [],
          createdAt: new Date().toISOString(),
          ...(startDate ? { startDate } : {}),
          ...(endDate ? { endDate } : {}),
          ...(parentId ? { parentId } : {}),
        }
        tasks.push(t)
        if (parentId) childCount++; else rootCount++
        const kids = pickChildren(n)
        if (kids) walk(kids, id)
      }
    }
    walk(data as BulkNode[])
    if (tasks.length === 0) return { ok: false, error: 'JSONは有効ですがタスクが見つかりません' }
    return { ok: true, flat: tasks, rootCount, childCount, source: 'JSON' }
  } catch {
    // fall through
  }
  // (b) Markdown bullets — "- title" with 2-space or tab nesting
  const lines = text.split(/\r?\n/).filter(l => /\S/.test(l))
  const stack: { id: string; indent: number }[] = []
  const tasks: Task[] = []
  let rootCount = 0
  let childCount = 0
  for (const line of lines) {
    const m = line.match(/^(\s*)[-*+]\s+(.+?)\s*$/)
    if (!m) return { ok: false, error: `行を解釈できません: "${line.slice(0, 40)}"` }
    const indent = m[1].replace(/\t/g, '  ').length
    const title = m[2].trim()
    if (!title) continue
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop()
    const parentId = stack.length ? stack[stack.length - 1].id : undefined
    const id = generateId()
    tasks.push({
      id,
      title,
      description: '',
      status: 'todo',
      tags: [],
      createdAt: new Date().toISOString(),
      ...(parentId ? { parentId } : {}),
    })
    if (parentId) childCount++; else rootCount++
    stack.push({ id, indent })
  }
  if (tasks.length === 0) return { ok: false, error: '箇条書きが見つかりません（行頭に "- " を付けてください）' }
  return { ok: true, flat: tasks, rootCount, childCount, source: 'Markdown' }
}

export default function ProjectsPage() {
  const { state, dispatch, undo } = useApp()
  const active = state.activeMasterProjectId
  // Task boards belonging to the active master project.
  const boards = useMemo(() => state.projects.filter(p => p.masterProjectId === active), [state.projects, active])
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(boards[0]?.id ?? null)
  const [showNewProject, setShowNewProject] = useState(false)

  // Cross-view task selection: clicking a task in Kanban/Gantt sets this; the right-side
  // NotePanel reads it and shows the task's linked notes. Reset on master-project change.
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  useEffect(() => { setSelectedTaskId(null) }, [active])
  // Kanban filters — search box + hide-done toggle, persisted to localStorage so they
  // survive reloads (filters are per-device preference, not per-project).
  const [taskFilter, setTaskFilter] = useState('')
  const [hideDone, setHideDone] = useState<boolean>(() => {
    try { return localStorage.getItem('constella.hideDone') === '1' } catch { return false }
  })
  useEffect(() => { try { localStorage.setItem('constella.hideDone', hideDone ? '1' : '0') } catch { /* ignore */ } }, [hideDone])
  // 一括追加モーダル — プロンプトテンプレートをコピーしてAI出力（JSON or マークダウン）を貼り付け、解釈してADD_TASK連発する。
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkText, setBulkText] = useState('')
  const [bulkNotice, setBulkNotice] = useState<string | null>(null)
  const bulkParsed = useMemo(() => parseBulkInput(bulkText), [bulkText])
  useEffect(() => {
    if (!bulkOpen) { setBulkText(''); setBulkNotice(null) }
  }, [bulkOpen])
  // Cross-page entry: NotesPage can navigate here with ?taskId=... to surface a specific task.
  // Consume the param once (clear it) so back/forward navigation behaves naturally.
  const [searchParams, setSearchParams] = useSearchParams()
  useEffect(() => {
    const tid = searchParams.get('taskId')
    if (!tid) return
    setSelectedTaskId(tid)
    // Switch the visible board to the one containing this task so the user sees it.
    for (const b of boards) {
      if (b.tasks.some(t => t.id === tid)) { setSelectedProjectId(b.id); break }
    }
    const next = new URLSearchParams(searchParams)
    next.delete('taskId')
    setSearchParams(next, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const selectedTaskWithBoard = useMemo(() => {
    if (!selectedTaskId) return null
    for (const b of boards) {
      const t = b.tasks.find(x => x.id === selectedTaskId)
      if (t) return { task: t, board: b }
    }
    return null
  }, [boards, selectedTaskId])
  // If the selected task disappears (deleted/moved out), clear the selection.
  useEffect(() => {
    if (selectedTaskId && !selectedTaskWithBoard) setSelectedTaskId(null)
  }, [selectedTaskId, selectedTaskWithBoard])

  const [renamingBoardId, setRenamingBoardId] = useState<string | null>(null)
  const [renamingDraft, setRenamingDraft] = useState('')
  // Board-delete undo toast — shown after a deletion so the user can bounce back
  // via undo(). Auto-hides after 6s; the timer is cleared on re-show/unmount.
  const [deletedToast, setDeletedToast] = useState(false)
  const deletedToastTimer = useRef<number | null>(null)
  function showDeletedToast() {
    if (deletedToastTimer.current) { clearTimeout(deletedToastTimer.current); deletedToastTimer.current = null }
    setDeletedToast(true)
    deletedToastTimer.current = window.setTimeout(() => { setDeletedToast(false); deletedToastTimer.current = null }, 6000)
  }
  useEffect(() => () => { if (deletedToastTimer.current) clearTimeout(deletedToastTimer.current) }, [])
  async function deleteBoard(project: Project) {
    if (project.tasks.length === 0) {
      if (!(await confirmDialog(`ボード「${project.name}」を削除しますか？`))) return
    } else {
      const others = boards.filter(b => b.id !== project.id)
      if (others.length === 0) {
        if (!(await confirmDialog(`ボード「${project.name}」には ${project.tasks.length} 件のタスクがあります。すべて削除してよいですか？\n(他のボードが無いため移動できません)`))) return
      } else {
        const choice = await chooseDialog(
          `ボード「${project.name}」には ${project.tasks.length} 件のタスクがあります。\nタスクをどうしますか？`,
          [
            ...others.map(b => ({ label: `「${b.name}」へ移動して削除`, value: b.id })),
            { label: 'タスクごと削除', value: '__discard__', danger: true },
          ]
        )
        if (choice === null) return
        if (choice !== '__discard__') {
          const target = others.find(b => b.id === choice)
          if (!target) return
          // Move all tasks from project to target (as roots so cross-board parents don't dangle locally)
          const newTargetTasks = [...target.tasks, ...project.tasks.map(t => ({ ...t, parentId: undefined }))]
          dispatch({ type: 'SET_PROJECT_TASKS', payload: { projectId: target.id, tasks: newTargetTasks } })
        }
      }
    }
    if (selectedProjectId === project.id) {
      const next = boards.find(b => b.id !== project.id)
      setSelectedProjectId(next?.id ?? null)
    }
    dispatch({ type: 'DELETE_PROJECT', payload: project.id })
    showDeletedToast()
  }

  // Board panel collapse — same idiom as the main app sidebar (persisted + hover-to-expand).
  const [boardsCollapsed, setBoardsCollapsed] = useState(() => {
    try { return localStorage.getItem('constella.boards.collapsed') === '1' } catch { return false }
  })
  const [boardsHover, setBoardsHover] = useState(false)
  const boardsHoverTimer = useRef<number | null>(null)
  useEffect(() => {
    try { localStorage.setItem('constella.boards.collapsed', boardsCollapsed ? '1' : '0') } catch { /* ignore */ }
  }, [boardsCollapsed])
  const onBoardsEnter = () => {
    if (boardsHoverTimer.current) { clearTimeout(boardsHoverTimer.current); boardsHoverTimer.current = null }
    if (!boardsCollapsed) return
    boardsHoverTimer.current = window.setTimeout(() => setBoardsHover(true), 280)
  }
  const onBoardsLeave = () => {
    if (boardsHoverTimer.current) { clearTimeout(boardsHoverTimer.current); boardsHoverTimer.current = null }
    if (!boardsCollapsed) return
    boardsHoverTimer.current = window.setTimeout(() => setBoardsHover(false), 180)
  }
  const boardsExpanded = !boardsCollapsed || boardsHover || showNewProject

  // Board panel resizable width — 160–360 px, persisted.
  const [boardsWidth, setBoardsWidth] = useState(() => {
    try { const v = Number(localStorage.getItem('constella.boards.width') || '224'); return v >= 160 && v <= 360 ? v : 224 } catch { return 224 }
  })
  const [boardsResizing, setBoardsResizing] = useState(false)
  useEffect(() => {
    try { localStorage.setItem('constella.boards.width', String(boardsWidth)) } catch { /* ignore */ }
  }, [boardsWidth])
  function startBoardsResize(e: React.MouseEvent) {
    e.preventDefault()
    const startX = e.clientX
    const base = boardsWidth
    setBoardsResizing(true)
    const onMove = (ev: MouseEvent) => {
      const next = Math.max(160, Math.min(360, base + (ev.clientX - startX)))
      setBoardsWidth(next)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      setBoardsResizing(false)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }
  const [newProjectName, setNewProjectName] = useState('')
  const [viewMode, setViewMode] = useState<ViewMode>('kanban')
  const [kanbanMode, setKanbanMode] = useState<KanbanMode>('tree')
  const [dragOverCol, setDragOverCol] = useState<Task['status'] | null>(null)
  const dragIdRef = useRef<string | null>(null)

  const selectedProject = boards.find(p => p.id === selectedProjectId) ?? null

  // Keep the selection within the active project's boards.
  useEffect(() => {
    if (selectedProjectId && !boards.find(p => p.id === selectedProjectId)) setSelectedProjectId(boards[0]?.id ?? null)
  }, [boards, selectedProjectId])

  function createProject() {
    if (!newProjectName.trim()) return
    const project: Project = {
      id: generateId(),
      masterProjectId: active,
      name: newProjectName.trim(),
      description: '',
      tasks: [],
      createdAt: new Date().toISOString()
    }
    dispatch({ type: 'ADD_PROJECT', payload: project })
    setSelectedProjectId(project.id)
    setNewProjectName('')
    setShowNewProject(false)
  }

  function addTask(status: Task['status'], parentId?: string) {
    if (!selectedProjectId) return
    const task: Task = {
      id: generateId(),
      title: parentId ? '新しいサブタスク' : '新しいタスク',
      description: '',
      status,
      tags: [],
      createdAt: new Date().toISOString(),
      ...(parentId ? { parentId } : {}),
    }
    dispatch({ type: 'ADD_TASK', payload: { projectId: selectedProjectId, task } })
  }

  function updateTask(task: Task) {
    if (!selectedProjectId) return
    dispatch({ type: 'UPDATE_TASK', payload: { projectId: selectedProjectId, task } })
  }

  // Delete a task and every descendant (so the tree never leaves orphan ids around).
  function deleteTask(taskId: string) {
    if (!selectedProjectId || !selectedProject) return
    const ids = descendantIds(selectedProject.tasks, taskId)
    ids.add(taskId)
    const remaining = selectedProject.tasks.filter(t => !ids.has(t.id))
    dispatch({ type: 'SET_PROJECT_TASKS', payload: { projectId: selectedProjectId, tasks: remaining } })
  }

  function moveTask(taskId: string, newStatus: Task['status']) {
    if (!selectedProject) return
    const task = selectedProject.tasks.find(t => t.id === taskId)
    if (!task) return
    updateTask({ ...task, status: newStatus })
  }

  // Drag-and-drop reorder: move a task to a status, optionally before a given task.
  // Dropping onto column whitespace (beforeId === null) also CLEARS parentId — this is
  // how users un-nest via D&D ("drag to column = make root + change status").
  function dropTask(toStatus: Task['status'], beforeId: string | null) {
    const taskId = dragIdRef.current
    dragIdRef.current = null
    setDragOverCol(null)
    if (!selectedProject || !taskId) return
    const without = selectedProject.tasks.filter(t => t.id !== taskId)
    const dragged = selectedProject.tasks.find(t => t.id === taskId)
    if (!dragged) return
    const moved: Task = beforeId
      ? { ...dragged, status: toStatus }
      : { ...dragged, status: toStatus, parentId: undefined }
    let idx: number
    if (beforeId) {
      idx = without.findIndex(t => t.id === beforeId)
      if (idx < 0) idx = without.length
    } else {
      idx = without.reduce((acc, t, i) => (t.status === toStatus ? i + 1 : acc), 0) // after last task of that column
    }
    const tasks = [...without.slice(0, idx), moved, ...without.slice(idx)]
    dispatch({ type: 'SET_PROJECT_TASKS', payload: { projectId: selectedProject.id, tasks } })
  }

  // Make the dragged task a child of `parentId`. Validates against self / cycle and
  // is a no-op when the dragged is already a child of this parent.
  function nestTaskInto(parentId: string) {
    const taskId = dragIdRef.current
    dragIdRef.current = null
    setDragOverCol(null)
    if (!selectedProject || !taskId || taskId === parentId) return
    if (wouldCycle(selectedProject.tasks, taskId, parentId)) return
    const dragged = selectedProject.tasks.find(t => t.id === taskId)
    if (!dragged || dragged.parentId === parentId) return
    dispatch({ type: 'UPDATE_TASK', payload: { projectId: selectedProject.id, task: { ...dragged, parentId } } })
  }

  // Move a task and its entire subtree to another board within the same master project.
  // The moved root becomes a new root in the destination (its source-side parent chain
  // wouldn't transfer cleanly across boards anyway).
  function moveTaskToBoard(taskId: string, targetBoardId: string) {
    if (!selectedProject || selectedProject.id === targetBoardId) return
    const targetBoard = boards.find(b => b.id === targetBoardId)
    if (!targetBoard) return
    const dragged = selectedProject.tasks.find(t => t.id === taskId)
    if (!dragged) return
    const descIds = descendantIds(selectedProject.tasks, taskId)
    const subtree = selectedProject.tasks.filter(t => t.id === taskId || descIds.has(t.id))
    const remaining = selectedProject.tasks.filter(t => t.id !== taskId && !descIds.has(t.id))
    const newRoot: Task = { ...dragged, parentId: undefined }
    const rest = subtree.filter(t => t.id !== taskId)
    const targetTasks = [...targetBoard.tasks, newRoot, ...rest]
    dispatch({ type: 'SET_PROJECT_TASKS', payload: { projectId: selectedProject.id, tasks: remaining } })
    dispatch({ type: 'SET_PROJECT_TASKS', payload: { projectId: targetBoardId, tasks: targetTasks } })
  }
  // Duplicate a task subtree onto another board. New IDs are generated and parent/child
  // links are remapped via an old-id → new-id table so the cloned tree's structure survives.
  function duplicateTaskToBoard(taskId: string, targetBoardId: string) {
    if (!selectedProject) return
    const targetBoard = boards.find(b => b.id === targetBoardId)
    if (!targetBoard) return
    const dragged = selectedProject.tasks.find(t => t.id === taskId)
    if (!dragged) return
    const descIds = descendantIds(selectedProject.tasks, taskId)
    const subtree = selectedProject.tasks.filter(t => t.id === taskId || descIds.has(t.id))
    const idMap = new Map<string, string>()
    for (const t of subtree) idMap.set(t.id, generateId())
    const clonedRoot: Task = { ...dragged, id: idMap.get(taskId)!, parentId: undefined }
    const clonedRest: Task[] = subtree
      .filter(t => t.id !== taskId)
      .map(t => ({ ...t, id: idMap.get(t.id)!, parentId: t.parentId ? idMap.get(t.parentId) : undefined }))
    dispatch({ type: 'SET_PROJECT_TASKS', payload: { projectId: targetBoardId, tasks: [...targetBoard.tasks, clonedRoot, ...clonedRest] } })
  }

  return (
    <div className="flex h-full">
      {/* Project list — collapsible + resizable. */}
      <div className={`relative h-full shrink-0 ${boardsResizing ? '' : 'transition-[width] duration-200'}`} style={{ width: boardsCollapsed ? 40 : boardsWidth }}>
        <div
          onMouseEnter={onBoardsEnter}
          onMouseLeave={onBoardsLeave}
          className={`absolute inset-y-0 left-0 bg-white border-r border-slate-200 flex flex-col ${boardsResizing ? '' : 'transition-[width] duration-200'} ${boardsCollapsed && boardsHover ? 'shadow-2xl z-30' : ''}`}
          style={{ width: boardsExpanded ? boardsWidth : 40 }}
        >
          <div className={`h-14 flex items-center border-b border-slate-200 ${boardsExpanded ? 'justify-between px-4' : 'justify-center px-1'}`}>
            {boardsExpanded && <h2 className="text-sm font-semibold text-slate-700">ボード</h2>}
            <div className="flex items-center gap-0.5">
              {boardsExpanded && (
                <button
                  onClick={() => setShowNewProject(true)}
                  title="新しいボード"
                  className="p-1.5 rounded-md hover:bg-slate-100 text-slate-500 hover:text-emerald-600 transition-colors"
                >
                  <Plus size={18} />
                </button>
              )}
              <button
                onClick={() => setBoardsCollapsed(c => !c)}
                title={boardsCollapsed ? 'ボードパネルを開く' : 'ボードパネルを畳む'}
                className="p-1.5 rounded-md hover:bg-slate-100 text-slate-400 hover:text-slate-700 transition-colors"
              >
                {boardsCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
              </button>
            </div>
          </div>
          {boardsExpanded ? (
            <div className="flex-1 overflow-y-auto py-2 px-2 space-y-1">
              {showNewProject && (
                <div className="px-1 py-2">
                  <input
                    autoFocus
                    type="text"
                    value={newProjectName}
                    onChange={e => setNewProjectName(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') createProject()
                      if (e.key === 'Escape') setShowNewProject(false)
                    }}
                    onBlur={() => { if (!newProjectName.trim()) setShowNewProject(false) }}
                    className="w-full text-sm bg-slate-100 border border-slate-300 rounded px-2 py-1.5 text-slate-800 outline-none focus:border-emerald-500"
                    placeholder="ボード名…"
                  />
                </div>
              )}
              {boards.map((project, pIdx) => {
                const color = boardColorFor(project, pIdx)
                const cls = BOARD_COLOR_CLASSES[color]
                return (
                  <div key={project.id} className="relative group">
                    {renamingBoardId === project.id ? (
                      <input
                        autoFocus
                        value={renamingDraft}
                        onChange={e => setRenamingDraft(e.target.value)}
                        onBlur={() => {
                          if (renamingDraft.trim() && renamingDraft !== project.name) {
                            dispatch({ type: 'UPDATE_PROJECT', payload: { ...project, name: renamingDraft.trim() } })
                          }
                          setRenamingBoardId(null)
                        }}
                        onKeyDown={e => {
                          if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur()
                          if (e.key === 'Escape') setRenamingBoardId(null)
                        }}
                        className="w-full text-sm bg-slate-100 border border-emerald-400 rounded px-2 py-1.5 text-slate-800 outline-none"
                      />
                    ) : (
                      <button
                        onClick={() => setSelectedProjectId(project.id)}
                        onDoubleClick={() => { setRenamingBoardId(project.id); setRenamingDraft(project.name) }}
                        className={`w-full text-left pl-2 pr-16 py-2.5 rounded-lg text-sm transition-all flex items-center gap-2
                          ${selectedProjectId === project.id
                            ? 'bg-slate-100 text-slate-900 border border-slate-300'
                            : 'text-slate-500 hover:text-slate-800 hover:bg-slate-100 border border-transparent'
                          }`}
                        title="ダブルクリックで名前変更"
                      >
                        <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${cls.dot}`} />
                        <span className="flex-1 min-w-0">
                          <p className="font-medium truncate">{project.name}</p>
                          <p className="text-xs text-slate-500 mt-0.5">{project.tasks.length} タスク</p>
                        </span>
                      </button>
                    )}
                    {renamingBoardId !== project.id && (
                      <div className="absolute right-1 top-1.5 z-10 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                        {/* Color swatch picker — closes on outside click / Escape. */}
                        <BoardColorSwatch
                          dotCls={cls.dot}
                          current={color}
                          onPick={c => dispatch({ type: 'UPDATE_PROJECT', payload: { ...project, color: c } })}
                        />
                        <button
                          onClick={ev => { ev.stopPropagation(); setRenamingBoardId(project.id); setRenamingDraft(project.name) }}
                          title="名前を変更"
                          className="w-5 h-5 rounded flex items-center justify-center text-slate-400 hover:text-slate-700 hover:bg-slate-200"
                        >
                          <Pencil size={11} />
                        </button>
                        <button
                          onClick={async ev => { ev.stopPropagation(); await deleteBoard(project) }}
                          title="ボードを削除"
                          className="w-5 h-5 rounded flex items-center justify-center text-slate-400 hover:text-rose-500 hover:bg-rose-50"
                        >
                          <Trash2 size={11} />
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          ) : (
            // Compact strip: a vertical dot per board, click selects.
            <div className="flex-1 overflow-y-auto py-2 flex flex-col items-center gap-1">
              {boards.map((project, pIdx) => {
                const color = boardColorFor(project, pIdx)
                const cls = BOARD_COLOR_CLASSES[color]
                return (
                  <button
                    key={project.id}
                    onClick={() => setSelectedProjectId(project.id)}
                    title={`${project.name}（${project.tasks.length} タスク）`}
                    className={`w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-semibold transition-all ${cls.dot} text-white shadow-sm ${selectedProjectId === project.id ? 'ring-2 ring-offset-1 ring-slate-700 scale-110' : 'opacity-80 hover:opacity-100 hover:scale-105'}`}
                  >
                    {project.name.charAt(0).toUpperCase()}
                  </button>
                )
              })}
            </div>
          )}
          {/* Right-edge resize handle — only when expanded */}
          {boardsExpanded && (
            <div
              onMouseDown={startBoardsResize}
              title="ドラッグで幅を調整"
              className={`absolute top-0 bottom-0 right-0 w-1.5 cursor-ew-resize hover:bg-indigo-300/60 ${boardsResizing ? 'bg-indigo-400/70' : ''} transition-colors`}
            />
          )}
        </div>
      </div>

      {/* Right pane: header (with view-mode toggle) + the chosen view */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Wraps onto a second line when the window is narrow — buttons must never
            shrink into vertically-wrapped text. */}
        <div className="min-h-14 py-2 flex flex-wrap items-center px-6 border-b border-slate-200 gap-x-3 gap-y-1.5 min-w-0">
          <h2 className="text-lg font-semibold text-slate-800 truncate min-w-0 max-w-full">
            {viewMode === 'kanban' ? (selectedProject?.name ?? 'ボード') : viewMode === 'gantt' ? 'ガントチャート' : 'カレンダー'}
          </h2>
          {viewMode !== 'kanban' && (
            <span className="text-xs text-slate-400 whitespace-nowrap">プロジェクト全体（全ボード横断）</span>
          )}
          {viewMode === 'kanban' && (
            <div className="flex items-center rounded-md border border-slate-200 overflow-hidden text-xs ml-2 shrink-0">
              {([['tree', '階層', ListTree], ['flat', 'フラット', AlignLeft]] as const).map(([m, label, Icon]) => (
                <button key={m} onClick={() => setKanbanMode(m)} title={`${label}表示`}
                  className={`flex items-center gap-1 px-2 py-1 transition-colors whitespace-nowrap ${kanbanMode === m ? 'bg-emerald-500/15 text-emerald-600' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800'}`}>
                  <Icon size={13} /> {label}
                </button>
              ))}
            </div>
          )}
          {viewMode === 'kanban' && selectedProject && (
            <>
              <div className="ml-2 w-44 shrink-0">
                <SearchInput
                  value={taskFilter}
                  onChange={setTaskFilter}
                  historyKey="constella.tasks.search"
                  placeholder="検索 (タイトル/タグ)"
                />
              </div>
              <button
                onClick={() => setHideDone(v => !v)}
                title={hideDone ? '完了タスクを表示' : '完了タスクを隠す'}
                className={`flex items-center gap-1 px-2.5 py-1 rounded-md border text-xs transition-colors whitespace-nowrap shrink-0 ${hideDone ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-slate-200 text-slate-600 hover:bg-slate-50 hover:text-slate-800 hover:border-slate-300'}`}
              >
                {hideDone ? '完了非表示' : '完了表示'}
              </button>
              <button
                onClick={() => setBulkOpen(true)}
                title="AI出力やリストから一括でタスクを追加"
                className="flex items-center gap-1 px-2.5 py-1 rounded-md border border-slate-200 text-xs text-slate-600 hover:bg-slate-50 hover:text-slate-800 hover:border-slate-300 transition-colors whitespace-nowrap shrink-0"
              >
                <ListPlus size={13} /> 一括追加
              </button>
            </>
          )}
          <div className="ml-auto flex items-center rounded-md border border-slate-200 overflow-hidden shrink-0">
            {([['kanban', 'カンバン', LayoutGrid], ['gantt', 'ガント', GanttChartSquare], ['calendar', 'カレンダー', CalendarDays]] as const).map(([mode, label, Icon]) => (
              <button
                key={mode}
                onClick={() => setViewMode(mode)}
                title={label}
                className={`flex items-center gap-1 px-2.5 py-1 text-sm transition-colors whitespace-nowrap ${viewMode === mode ? 'bg-emerald-500/15 text-emerald-600' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800'}`}
              >
                <Icon size={15} /> {label}
              </button>
            ))}
          </div>
        </div>
        {viewMode === 'kanban' ? (
          selectedProject ? (
            <div className="flex-1 flex gap-4 p-6 overflow-x-auto">
              {columns.map(col => {
                const all = selectedProject.tasks
                // Apply search filter (title/tags) + hide-done preference.
                const q = taskFilter.trim().toLowerCase()
                const allFiltered = all.filter(t => {
                  if (hideDone && t.status === 'done') return false
                  if (!q) return true
                  return (t.title || '').toLowerCase().includes(q) || (t.tags || []).some(tag => tag.toLowerCase().includes(q))
                })
                // tree mode: only root tasks; column = the root's aggregate status.
                // Compute aggregate over the UNFILTERED task set so a parent whose only
                // child is 'done' still shows in 完了 even when 完了非表示 hides that child.
                // flat mode: every task ranked by its own status (children visible too).
                const tasks = kanbanMode === 'tree'
                  ? rootsOf(allFiltered).filter(t => aggregateFor(all, t).status === col.key)
                  : allFiltered.filter(t => t.status === col.key)
                return (
                  <div
                    key={col.key}
                    className="flex-1 min-w-[250px] flex flex-col"
                    onDragOver={e => { e.preventDefault(); setDragOverCol(col.key) }}
                    onDragLeave={e => { if (e.currentTarget === e.target) setDragOverCol(null) }}
                    onDrop={e => { e.preventDefault(); dropTask(col.key, null) }}
                  >
                    <div className={`flex items-center justify-between mb-3 pb-2 border-b-2 ${col.color}`}>
                      <span className="text-sm font-semibold text-slate-700">{col.label}</span>
                      <span className="text-xs text-slate-500 bg-slate-100 px-2 py-0.5 rounded-full">{tasks.length}</span>
                    </div>
                    <div className={`flex-1 space-y-2 overflow-y-auto rounded-lg transition-colors ${dragOverCol === col.key ? 'bg-slate-100/70' : ''}`}>
                      {tasks.map(task => (
                        <TaskCard
                          key={task.id}
                          task={task}
                          boardTasks={all}
                          otherBoards={boards.filter(b => b.id !== selectedProject!.id)}
                          mode={kanbanMode}
                          columnStatus={col.key}
                          selectedTaskId={selectedTaskId}
                          onSelectTask={setSelectedTaskId}
                          onMove={moveTask}
                          onDelete={deleteTask}
                          onUpdate={updateTask}
                          onAddSubtask={(parentId) => addTask('todo', parentId)}
                          onDragStart={(id) => { dragIdRef.current = id }}
                          onDropBefore={(id, status) => dropTask(status, id)}
                          onNestInto={nestTaskInto}
                          onMoveToBoard={moveTaskToBoard}
                          onDuplicateToBoard={duplicateTaskToBoard}
                        />
                      ))}
                      <button
                        onClick={() => addTask(col.key)}
                        className="w-full py-2 rounded-lg border border-dashed border-slate-300 text-slate-500 text-sm hover:border-slate-400 hover:text-slate-500 transition-colors"
                      >
                        ＋ 追加
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-slate-400">
              <p>ボードを選択するか、新しく作成してください</p>
              {state.projects.some(p => p.masterProjectId !== active) && (
                <p className="text-[11px] text-slate-400 mt-1">他のプロジェクトにはボードがあります — 左上のプロジェクト切替から移動できます</p>
              )}
            </div>
          )
        ) : viewMode === 'gantt' ? (
          <GanttView boards={boards} selectedTaskId={selectedTaskId} onSelectTask={setSelectedTaskId} bandMasterId={active} />
        ) : (
          <CalendarView boards={boards} />
        )}
      </div>
      <NotePanel
        selectedTask={selectedTaskWithBoard?.task ?? null}
        selectedBoard={selectedTaskWithBoard?.board ?? null}
        onClose={() => setSelectedTaskId(null)}
      />

      {bulkOpen && selectedProject && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/40"
          onMouseDown={() => setBulkOpen(false)}
        >
          <div
            className="bg-white rounded-xl shadow-2xl border border-slate-200 w-[640px] max-w-[92vw] max-h-[88vh] flex flex-col"
            onMouseDown={e => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 px-5 pt-4 pb-3 border-b border-slate-100">
              <ListPlus size={16} className="text-emerald-500" />
              <span className="text-slate-800 font-semibold">一括タスク追加</span>
              <span className="ml-2 text-xs text-slate-500 truncate min-w-0">
                追加先: <span className="text-slate-700 font-medium">{selectedProject.name}</span>
              </span>
              <button
                onClick={() => setBulkOpen(false)}
                className="ml-auto p-1 rounded hover:bg-slate-100 text-slate-500"
                title="閉じる"
              ><X size={14} /></button>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-3">
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(BULK_PROMPT_TEMPLATE).then(
                      () => setBulkNotice('プロンプトをコピーしました — AIに貼り付け、出力JSONをこの下に戻してください'),
                      () => setBulkNotice('クリップボードへのコピーに失敗しました'),
                    )
                  }}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-indigo-50 border border-indigo-200 text-indigo-700 text-xs hover:bg-indigo-100 transition-colors"
                >
                  <Copy size={12} /> プロンプトテンプレートをコピー
                </button>
                <span className="text-[11px] text-slate-400">JSON または マークダウン箇条書きを貼り付け</span>
              </div>

              <textarea
                value={bulkText}
                onChange={e => { setBulkText(e.target.value); setBulkNotice(null) }}
                placeholder={'[\n  { "title": "親タスク", "status": "todo", "children": [ { "title": "子タスク" } ] }\n]\n\nまたは:\n- 親タスク\n  - 子タスク'}
                rows={14}
                className="w-full text-xs font-mono bg-slate-50 border border-slate-200 rounded-md px-3 py-2 outline-none focus:border-indigo-400 resize-none"
              />

              <div className="flex items-center justify-between gap-2 text-xs flex-wrap">
                <div className="text-slate-600">
                  {bulkParsed.ok ? (
                    <span>
                      <span className="font-semibold text-emerald-600">{bulkParsed.flat.length}件</span>
                      <span className="text-slate-400 mx-1">/</span>
                      親<span className="font-semibold text-slate-700">{bulkParsed.rootCount}</span>
                      <span className="text-slate-300 mx-1">・</span>
                      子<span className="font-semibold text-slate-700">{bulkParsed.childCount}</span>
                      <span className="ml-2 text-slate-400">（{bulkParsed.source}）</span>
                    </span>
                  ) : bulkText.trim() ? (
                    <span className="text-rose-500">{bulkParsed.error || '解析できません'}</span>
                  ) : (
                    <span className="text-slate-400">タスクを貼り付けてください</span>
                  )}
                </div>
                {bulkNotice && <span className="text-[11px] text-emerald-600">{bulkNotice}</span>}
              </div>
            </div>

            <div className="flex justify-end gap-2 px-5 py-3 border-t border-slate-100">
              <button
                onClick={() => setBulkOpen(false)}
                className="px-3 py-1.5 rounded-lg text-sm text-slate-600 hover:bg-slate-100 transition-colors"
              >キャンセル</button>
              <button
                disabled={!bulkParsed.ok || bulkParsed.flat.length === 0}
                onClick={() => {
                  if (!bulkParsed.ok || !selectedProjectId) return
                  for (const t of bulkParsed.flat) {
                    dispatch({ type: 'ADD_TASK', payload: { projectId: selectedProjectId, task: t } })
                  }
                  setBulkOpen(false)
                }}
                className="px-3 py-1.5 rounded-lg text-sm bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                {bulkParsed.ok && bulkParsed.flat.length > 0 ? `${bulkParsed.flat.length}件追加` : '追加'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Board-delete undo toast — bottom-center, auto-hides after 6s. */}
      {deletedToast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[90] flex items-center gap-3 px-4 py-2 rounded-lg bg-slate-800 text-white text-xs shadow-lg">
          <span>ボードを削除しました</span>
          <button
            onClick={() => {
              undo()
              if (deletedToastTimer.current) { clearTimeout(deletedToastTimer.current); deletedToastTimer.current = null }
              setDeletedToast(false)
            }}
            className="text-emerald-300 hover:text-emerald-200 font-semibold"
          >元に戻す</button>
        </div>
      )}
    </div>
  )
}

// Clickable status pill metadata + the click-cycle order (todo → 進行中 → 完了 → …).
const STATUS_ORDER: Task['status'][] = ['todo', 'in-progress', 'done']
const STATUS_META: Record<Task['status'], { label: string; Icon: typeof Circle; icon: string; bg: string; text: string; border: string; ring: string }> = {
  'todo':        { label: '未着手', Icon: Circle,       icon: 'text-slate-400',   bg: 'bg-slate-100',   text: 'text-slate-600',   border: 'border-slate-300',   ring: 'ring-slate-400' },
  'in-progress': { label: '進行中', Icon: CircleDot,    icon: 'text-amber-500',   bg: 'bg-amber-100',   text: 'text-amber-700',   border: 'border-amber-300',   ring: 'ring-amber-400' },
  'done':        { label: '完了',   Icon: CheckCircle2, icon: 'text-emerald-500', bg: 'bg-emerald-100', text: 'text-emerald-700', border: 'border-emerald-300', ring: 'ring-emerald-400' },
}
// Settle window: rapid clicks cycle the status in place; the card only commits &
// relocates columns after this quiet period, so mis-clicks are cheap to correct.
const STATUS_COMMIT_MS = 2600

// Visual hierarchy: tasks at each nesting depth get a distinct light tint so the
// reader can instantly tell which level a card belongs to. Root (depth 0) stays
// neutral slate; each deeper level rotates through a hue. The left guide rail on
// the children container uses the SAME hue as the children themselves, so the
// indentation reads as a coloured "shelf" of that level.
const DEPTH_THEME = [
  { card: 'bg-slate-100',     border: 'border-slate-200',   rail: 'border-slate-300'   },
  { card: 'bg-indigo-50/70',  border: 'border-indigo-200',  rail: 'border-indigo-300'  },
  { card: 'bg-emerald-50/70', border: 'border-emerald-200', rail: 'border-emerald-300' },
  { card: 'bg-amber-50/70',   border: 'border-amber-200',   rail: 'border-amber-300'   },
  { card: 'bg-rose-50/70',    border: 'border-rose-200',    rail: 'border-rose-300'    },
  { card: 'bg-sky-50/70',     border: 'border-sky-200',     rail: 'border-sky-300'     },
]
const depthTheme = (d: number) => DEPTH_THEME[Math.min(d, DEPTH_THEME.length - 1)]

function TaskCard({ task, boardTasks, otherBoards, mode, columnStatus, selectedTaskId, onSelectTask, onMove, onDelete, onUpdate, onAddSubtask, onDragStart, onDropBefore, onNestInto, onMoveToBoard, onDuplicateToBoard, depth = 0 }: {
  task: Task
  boardTasks: Task[]
  otherBoards: Project[]
  mode: KanbanMode
  // The column this card is rendered under. In tree mode this can differ from
  // task.status (the parent shows in its AGGREGATE column) — drop-before must
  // land in the VISIBLE column, not the stored status.
  columnStatus?: Task['status']
  selectedTaskId: string | null
  onSelectTask: (id: string | null) => void
  onMove: (id: string, status: Task['status']) => void
  onDelete: (id: string) => void
  onUpdate: (task: Task) => void
  onAddSubtask: (parentId: string) => void
  // Callbacks take the task id/status so the recursive subtask render uses the
  // CHILD's identity, not the outer card's (the previous pre-bound shape silently
  // misrouted subtask drags to the parent).
  onDragStart: (id: string) => void
  onDropBefore: (id: string, status: Task['status']) => void
  onNestInto: (parentId: string) => void
  onMoveToBoard: (id: string, targetBoardId: string) => void
  onDuplicateToBoard: (id: string, targetBoardId: string) => void
  depth?: number
}) {
  const [moveTargetId, setMoveTargetId] = useState<string>('')
  const [showMenu, setShowMenu] = useState(false)
  const [editing, setEditing] = useState(false)
  const [expanded, setExpanded] = useState(true)
  // Click-outside / Escape dismissal for the "…" move-to menu. The trigger button
  // lives outside the menu container, so it's passed as extraRef to avoid the
  // opening click immediately re-closing the popover.
  const menuTriggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = usePopoverDismiss<HTMLDivElement>(showMenu, () => setShowMenu(false), menuTriggerRef)
  // Click-outside / Escape closes the inline editor. Edits dispatch live, so
  // dismissing on outside click just commits whatever's already been typed.
  const editorRef = usePopoverDismiss<HTMLDivElement>(editing, () => setEditing(false))
  // Which zone of the card the cursor is over during a drag — drives the visual
  // indicator and the drop branch. 'before' = top half (reorder), 'nest' = bottom
  // half (make a child of this task).
  const [dropZone, setDropZone] = useState<'before' | 'nest' | null>(null)
  // Restrict drop detection to the "head" portion of the card (everything except the
  // expanded children list) — otherwise a parent's nest zone overlaps its own
  // children's cards, making it visually ambiguous whether you're dropping into the
  // parent or one of its children.
  const headerRef = useRef<HTMLDivElement>(null)

  // Aggregate over descendants — drives the displayed status/dates/progress when the
  // task has children. Leaves return their own values.
  const agg = useMemo(() => aggregateFor(boardTasks, task), [boardTasks, task])
  const ch = useMemo(() => childrenMap(boardTasks).get(task.id) ?? [], [boardTasks, task.id])
  const hasChildren = ch.length > 0
  // Parent-options for the editor: every task in this board except self and descendants
  // (to prevent cycles). Sorted by title for predictable order.
  const parentOptions = useMemo(() => {
    if (!editing) return []
    const desc = descendantIds(boardTasks, task.id)
    return boardTasks
      .filter(t => t.id !== task.id && !desc.has(t.id))
      .sort((a, b) => a.title.localeCompare(b.title))
  }, [boardTasks, task.id, editing])

  const displayStatus = mode === 'tree' && hasChildren ? agg.status : task.status
  const displayStart = mode === 'tree' && hasChildren ? agg.startDate : task.startDate
  const displayEnd = mode === 'tree' && hasChildren ? agg.endDate : task.endDate

  // Click-to-cycle status with a settle delay. Clicking the status pill advances
  // todo→進行中→完了→todo locally (pending), showing the new state IN PLACE. Only
  // after STATUS_COMMIT_MS of no clicks does it commit (onMove → moveTask, which
  // re-reads the task so nothing goes stale) and the card relocates columns.
  // Aggregate parents in tree mode are display-only (status is derived).
  const canCycleStatus = !(mode === 'tree' && hasChildren)
  const [pendingStatus, setPendingStatus] = useState<Task['status'] | null>(null)
  const [pendingTick, setPendingTick] = useState(0) // re-keys the countdown bar on each click
  const commitTimerRef = useRef<number | null>(null)
  const pendingRef = useRef<Task['status'] | null>(null)   // latest pending, read in the timer
  const statusRef = useRef(task.status); statusRef.current = task.status // latest committed status
  const onMoveRef = useRef(onMove); onMoveRef.current = onMove // always commit through the LATEST closure
  useEffect(() => () => { if (commitTimerRef.current) clearTimeout(commitTimerRef.current) }, [])
  // Any change to the real status — our own commit OR an external drag/edit —
  // supersedes a queued pending: cancel the settle timer and drop the preview so
  // the pill never shows a state inconsistent with the card's actual column.
  useEffect(() => {
    if (pendingRef.current != null) {
      if (commitTimerRef.current) { clearTimeout(commitTimerRef.current); commitTimerRef.current = null }
      pendingRef.current = null
      setPendingStatus(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.status])
  const effectiveStatus = pendingStatus ?? displayStatus
  function cycleStatus(e: React.MouseEvent) {
    e.stopPropagation()
    if (!canCycleStatus) return
    const cur = pendingRef.current ?? task.status
    const next = STATUS_ORDER[(STATUS_ORDER.indexOf(cur) + 1) % STATUS_ORDER.length]
    pendingRef.current = next
    setPendingStatus(next)
    setPendingTick(t => t + 1)
    if (commitTimerRef.current) clearTimeout(commitTimerRef.current)
    commitTimerRef.current = window.setTimeout(() => {
      commitTimerRef.current = null
      const p = pendingRef.current
      pendingRef.current = null
      setPendingStatus(null)
      // Commit via the LATEST moveTask closure (onMoveRef) so it reads the current
      // task — a title/date edit made during the settle window is preserved, not
      // clobbered by a stale snapshot. Dispatch is OUTSIDE any setState updater.
      if (p != null && p !== statusRef.current) onMoveRef.current(task.id, p)
    }, STATUS_COMMIT_MS)
  }

  const moveOptions = ([
    { key: 'todo', label: '未着手' },
    { key: 'in-progress', label: '進行中' },
    { key: 'done', label: '完了' },
  ] as { key: Task['status']; label: string }[]).filter(o => o.key !== task.status)

  if (editing) {
    return (
      <div ref={editorRef} className="bg-white border border-emerald-300 rounded-lg p-3 space-y-2 shadow-sm">
        <input
          autoFocus
          value={task.title}
          onChange={e => onUpdate({ ...task, title: e.target.value })}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === 'Escape') setEditing(false) }}
          placeholder="タイトル"
          className="w-full text-sm font-medium bg-slate-50 border border-slate-200 rounded px-2 py-1 text-slate-800 outline-none focus:border-emerald-400"
        />
        <textarea
          value={task.description}
          onChange={e => onUpdate({ ...task, description: e.target.value })}
          placeholder="説明（任意）"
          rows={2}
          className="w-full text-xs bg-slate-50 border border-slate-200 rounded px-2 py-1 text-slate-600 outline-none focus:border-emerald-400 resize-y leading-relaxed"
        />
        <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
          <span className="shrink-0">親</span>
          <select
            value={task.parentId ?? ''}
            onChange={e => {
              const v = e.target.value
              // Defence in depth: the dropdown already excludes descendants, but verify.
              if (v && wouldCycle(boardTasks, task.id, v)) return
              onUpdate({ ...task, parentId: v || undefined })
            }}
            className="flex-1 min-w-0 bg-slate-50 border border-slate-200 rounded px-1.5 py-0.5 outline-none focus:border-emerald-400 text-slate-700"
          >
            <option value="">（なし＝ルート）</option>
            {parentOptions.map(t => (
              <option key={t.id} value={t.id}>{t.title || '(無題)'}</option>
            ))}
          </select>
          {task.parentId && (
            <button
              onClick={() => onUpdate({ ...task, parentId: undefined })}
              title="親から外してルートに戻す"
              className="text-[10px] px-2 py-0.5 rounded border border-slate-300 text-slate-600 hover:bg-slate-100 shrink-0"
            >×親解除</button>
          )}
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
          <span className="shrink-0">優先度</span>
          <select
            value={task.priority ?? ''}
            onChange={e => {
              const v = e.target.value
              // Runtime-validate the priority so a corrupted stored value can't slip
              // through the TypeScript type assertion.
              const n = v ? Number(v) : NaN
              const next: Task['priority'] = (n === 1 || n === 2 || n === 3 || n === 4) ? n : undefined
              onUpdate({ ...task, priority: next })
            }}
            className="bg-slate-50 border border-slate-200 rounded px-1.5 py-0.5 outline-none focus:border-emerald-400 text-slate-700"
          >
            <option value="">未設定</option>
            <option value="1">P1 (最優先)</option>
            <option value="2">P2</option>
            <option value="3">P3</option>
            <option value="4">P4 (低)</option>
          </select>
          {task.completedAt && (
            <span className="text-[10px] text-slate-400 ml-auto" title={`完了: ${task.completedAt}`}>
              ✓ {task.completedAt.slice(0, 10)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
          <span className="shrink-0">期間</span>
          <input
            type="date"
            value={task.startDate ?? ''}
            onChange={e => onUpdate({ ...task, startDate: e.target.value || undefined })}
            title={hasChildren ? '空欄なら子タスクから自動集計' : ''}
            className="flex-1 bg-slate-50 border border-slate-200 rounded px-1.5 py-0.5 outline-none focus:border-emerald-400"
          />
          <span>〜</span>
          <input
            type="date"
            value={task.endDate ?? ''}
            onChange={e => onUpdate({ ...task, endDate: e.target.value || undefined })}
            title={hasChildren ? '空欄なら子タスクから自動集計' : ''}
            className="flex-1 bg-slate-50 border border-slate-200 rounded px-1.5 py-0.5 outline-none focus:border-emerald-400"
          />
        </div>
        {hasChildren && (!task.startDate || !task.endDate) && (agg.childStartDate || agg.childEndDate) && (
          <p className="text-[10px] text-slate-400 pl-9 -mt-1">未設定なら子から集計: {agg.childStartDate ?? '…'} 〜 {agg.childEndDate ?? '…'}</p>
        )}
        {hasChildren && (task.startDate || task.endDate) && (
          <div className="flex justify-end -mt-1">
            <button onClick={() => onUpdate({ ...task, startDate: undefined, endDate: undefined })} className="text-[10px] text-slate-400 hover:text-rose-500 px-1" title="親の明示日付を消して子からの集計に戻す">×集計に戻す</button>
          </div>
        )}
        {/* Cross-project schedule sharing — mirror of the Gantt popover control. */}
        <div className="rounded-md border border-slate-200 bg-slate-50/60 px-2 py-1.5">
          <label className="flex items-center gap-1.5 text-[11px] text-slate-600 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={!!task.shared}
              onChange={e => onUpdate({ ...task, shared: e.target.checked || undefined })}
              className="accent-teal-500"
            />
            他のプロジェクトのガントにも表示する
          </label>
          {task.shared && (
            <input
              type="text"
              value={task.sharedAlias ?? ''}
              onChange={e => onUpdate({ ...task, sharedAlias: e.target.value || undefined })}
              placeholder="代替タイトル（他プロジェクトでの表示名 / 例: 出張）"
              className="mt-1.5 w-full bg-slate-50 border border-slate-200 rounded px-2 py-1 text-[11px] outline-none focus:border-teal-400"
            />
          )}
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-slate-500 flex-wrap">
          <span className="shrink-0">タグ</span>
          {task.tags.map(t => (
            <button
              key={t}
              onClick={() => onUpdate({ ...task, tags: task.tags.filter(x => x !== t) })}
              title="クリックで削除"
              className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 hover:bg-rose-100 hover:text-rose-700 transition-colors inline-flex items-center gap-0.5"
            >
              #{t}<X size={9} className="ml-0.5" />
            </button>
          ))}
          <input
            type="text"
            placeholder="タグを追加…"
            className="text-[11px] bg-slate-50 border border-slate-200 rounded px-1.5 py-0.5 outline-none focus:border-emerald-400 min-w-[80px] flex-1"
            onKeyDown={e => {
              if (e.nativeEvent.isComposing || (e as unknown as { keyCode: number }).keyCode === 229) return
              if (e.key !== 'Enter') return
              e.preventDefault()
              const t = e.currentTarget.value.trim()
              if (!t) return
              if (!task.tags.includes(t)) onUpdate({ ...task, tags: [...task.tags, t] })
              e.currentTarget.value = ''
            }}
          />
        </div>
        <LinkedNotesField task={task} onChange={ids => onUpdate({ ...task, linkedNoteIds: ids.length > 0 ? ids : undefined })} />
        <LinkedFilesField task={task} onChange={ids => onUpdate({ ...task, fileIds: ids.length > 0 ? ids : undefined })} />
        {otherBoards.length > 0 && (
          <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
            <span className="shrink-0">ボード</span>
            <select
              value={moveTargetId || otherBoards[0].id}
              onChange={e => setMoveTargetId(e.target.value)}
              className="flex-1 min-w-0 bg-slate-50 border border-slate-200 rounded px-1.5 py-0.5 outline-none focus:border-emerald-400"
            >
              {otherBoards.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
            <button
              onClick={() => { onMoveToBoard(task.id, moveTargetId || otherBoards[0].id); setEditing(false) }}
              className="text-[10px] px-2 py-0.5 rounded border border-slate-300 text-slate-600 hover:bg-slate-100 shrink-0"
              title="このタスクと子孫を選択したボードへ移動"
            >移動</button>
            <button
              onClick={() => { onDuplicateToBoard(task.id, moveTargetId || otherBoards[0].id); setEditing(false) }}
              className="text-[10px] px-2 py-0.5 rounded border border-slate-300 text-slate-600 hover:bg-slate-100 shrink-0"
              title="このタスクと子孫を選択したボードへ複製"
            >複製</button>
          </div>
        )}
        <div className="flex justify-end">
          <button onClick={() => setEditing(false)} className="text-xs px-2.5 py-1 rounded bg-emerald-500 text-white hover:bg-emerald-600">完了</button>
        </div>
      </div>
    )
  }

  // Every card is draggable — including parents and sub-parents. This is needed to
  // move a whole subtree to a different parent (drop on another card's nest zone)
  // or to reorder it as a root. A parent's column position in tree mode is computed
  // from its descendants, so dropping a parent on a column changes its own stored
  // status (mostly visible in flat mode) but doesn't relocate it in tree mode — the
  // tradeoff is that subtree re-parenting via D&D becomes possible.
  const canDrag = true

  return (
    <div
      draggable={canDrag}
      onDragStart={e => {
        if (!canDrag) { e.preventDefault(); return }
        // Recursive children are nested inside the parent card's DOM. Without
        // stopPropagation, the child's dragstart bubbles up and the parent's
        // own onDragStart overwrites dragIdRef with the parent's id — so the
        // drop ends up reordering the parent instead of the child.
        e.stopPropagation()
        onDragStart(task.id)
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', task.id)
      }}
      onDragOver={e => {
        e.preventDefault()
        // Use the head (non-children) area as the detection zone so a parent's nest
        // target doesn't overlap its own child cards. If the cursor is inside the
        // children list, clear our highlight and let those handlers own the gesture.
        const head = headerRef.current ?? e.currentTarget
        const r = head.getBoundingClientRect()
        if (e.clientY > r.bottom) { if (dropZone !== null) setDropZone(null); return }
        const zone: 'before' | 'nest' = (e.clientY - r.top) < r.height * 0.5 ? 'before' : 'nest'
        if (zone !== dropZone) setDropZone(zone)
      }}
      onDragLeave={e => {
        // Only clear when the cursor actually exited this card (not just entered a child).
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropZone(null)
      }}
      onDrop={e => {
        e.preventDefault(); e.stopPropagation()
        const zone = dropZone
        setDropZone(null)
        if (zone === 'nest') onNestInto(task.id); else onDropBefore(task.id, columnStatus ?? task.status)
      }}
      onDragEnd={() => setDropZone(null)}
      onDoubleClick={e => { e.stopPropagation(); setEditing(true) }}
      onClick={e => {
        // Don't claim the click when the user hit a control (button, input, etc.)
        const t = e.target as HTMLElement
        if (t.closest('button, input, textarea, select, [draggable] [draggable]')) return
        e.stopPropagation()
        onSelectTask(task.id)
      }}
      className={`${depthTheme(depth).card} border rounded-lg p-3 group relative transition-colors ${canDrag ? 'cursor-grab active:cursor-grabbing' : 'cursor-default'} ${dropZone === 'nest' ? 'border-indigo-400 ring-2 ring-indigo-300/60' : depthTheme(depth).border} ${selectedTaskId === task.id ? 'ring-2 ring-indigo-400/60' : ''}`}
    >
      {/* Drop indicator (top of card) when 'before' zone — drawn inside so it's clipped to the card. */}
      {dropZone === 'before' && <div className="absolute left-1 right-1 top-0 h-0.5 -translate-y-1/2 bg-indigo-500 rounded" />}
      <div ref={headerRef}>
      <div className="flex items-start justify-between gap-1">
        <div className="flex items-start gap-1 flex-1 min-w-0">
          {mode === 'tree' && hasChildren && (
            <button onClick={e => { e.stopPropagation(); setExpanded(!expanded) }} className="p-0.5 -ml-0.5 mt-0.5 rounded hover:bg-slate-200 text-slate-500 shrink-0" title={expanded ? '折りたたむ' : '展開'}>
              {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              {(() => {
                const meta = STATUS_META[effectiveStatus]
                const isPending = pendingStatus != null && pendingStatus !== task.status
                const Icon = meta.Icon
                if (!canCycleStatus) {
                  // Aggregate parent — display-only status chip.
                  return (
                    <span title={`状態（子から集計）: ${meta.label}`} className={`shrink-0 inline-flex items-center gap-0.5 pl-0.5 pr-1 py-px rounded-full border ${meta.border} ${meta.bg} ${meta.text}`}>
                      <Icon size={12} className={meta.icon} /><span className="text-[9px] font-semibold leading-none">{meta.label}</span>
                    </span>
                  )
                }
                return (
                  <button
                    onClick={cycleStatus}
                    onMouseDown={e => e.stopPropagation()}
                    title={`クリックで状態を切替（${STATUS_COMMIT_MS / 1000}秒後に確定して移動）`}
                    className={`relative shrink-0 inline-flex items-center gap-0.5 pl-0.5 pr-1 py-px rounded-full border overflow-hidden transition-colors ${meta.border} ${meta.bg} ${meta.text} ${isPending ? `ring-2 ring-offset-1 ${meta.ring}` : 'hover:brightness-95'}`}
                  >
                    <Icon size={12} className={meta.icon} />
                    <span className="text-[9px] font-semibold leading-none">{meta.label}</span>
                    {isPending && (
                      <span key={pendingTick} className="status-commit-bar absolute left-0 bottom-0 h-[2px] w-full bg-current opacity-60" style={{ animationDuration: `${STATUS_COMMIT_MS}ms` }} />
                    )}
                  </button>
                )
              })()}
              {task.priority && (
                <span
                  title={`優先度 P${task.priority}`}
                  className={`shrink-0 text-[9px] font-bold px-1 py-px rounded leading-none ${
                    task.priority === 1 ? 'bg-rose-100 text-rose-700' :
                    task.priority === 2 ? 'bg-amber-100 text-amber-700' :
                    task.priority === 3 ? 'bg-sky-100 text-sky-700' :
                    'bg-slate-100 text-slate-600'
                  }`}
                >P{task.priority}</span>
              )}
              {task.tags.includes('AI') && (
                <span className="shrink-0 inline-flex" title="AI生成">
                  <Sparkles size={11} className="text-emerald-500" />
                </span>
              )}
              <p className="text-sm text-slate-800 font-medium truncate flex-1">{task.title || '(無題)'}</p>
              {(task.linkedNoteIds?.length ?? 0) > 0 && (
                <FileText size={11} className="text-indigo-400 shrink-0" />
              )}
              {(task.fileIds?.length ?? 0) > 0 && (
                <Paperclip size={11} className="text-orange-400 shrink-0" />
              )}
            </div>
            {/* In flat mode, show parent breadcrumb for context. */}
            {mode === 'flat' && task.parentId && (() => {
              const parent = boardTasks.find(t => t.id === task.parentId)
              return parent ? <p className="text-[10px] text-slate-400 mt-0.5 truncate">親: {parent.title || '(無題)'}</p> : null
            })()}
          </div>
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <button onClick={e => { e.stopPropagation(); onAddSubtask(task.id) }} title="サブタスクを追加" className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-slate-200 text-slate-500 transition-all">
            <CornerDownRight size={13} />
          </button>
          <button onClick={() => setEditing(true)} title="編集" className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-slate-200 text-slate-500 transition-all">
            <Pencil size={13} />
          </button>
          <button ref={menuTriggerRef} onClick={() => setShowMenu(!showMenu)} className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-slate-200 text-slate-500 transition-all">
            <MoreHorizontal size={14} />
          </button>
        </div>
      </div>
      {task.description && (
        <p className="text-xs text-slate-500 mt-1 whitespace-pre-wrap">{task.description}</p>
      )}
      {(displayStart || displayEnd) && (
        <p className="text-[10px] text-slate-400 mt-1 font-mono">
          {displayStart ?? '…'} 〜 {displayEnd ?? '…'}
          {mode === 'tree' && hasChildren && (
            agg.hasExplicitDates
              ? <span className="ml-1 text-[9px] text-slate-400">(明示)</span>
              : <span className="ml-1 text-[9px] text-slate-300">(集計)</span>
          )}
          {mode === 'tree' && hasChildren && (agg.childOverflowsStart || agg.childOverflowsEnd) && (
            <span className="ml-1 text-[9px] text-rose-500 font-semibold"
                  title={`子の実期間 ${agg.childStartDate ?? '…'} 〜 ${agg.childEndDate ?? '…'} が親の範囲を超えています`}>
              ⚠範囲超過
            </span>
          )}
        </p>
      )}
      {mode === 'tree' && hasChildren && (
        <div className="mt-2 flex items-center gap-2">
          {/* Tri-segment progress bar: emerald(done) | amber(doing) | slate(remaining todo).
              Shows the composition of mixed states rather than collapsing them to a single percent. */}
          <div className="flex-1 h-1 rounded-full bg-slate-200 overflow-hidden flex">
            <div className="h-full bg-emerald-500 transition-all" style={{ width: agg.totalLeaves ? `${(agg.doneLeaves / agg.totalLeaves) * 100}%` : '0%' }} />
            <div className="h-full bg-amber-500 transition-all" style={{ width: agg.totalLeaves ? `${(agg.doingLeaves / agg.totalLeaves) * 100}%` : '0%' }} />
          </div>
          <span className="text-[10px] shrink-0 flex items-center gap-1">
            <span className="text-slate-400">{agg.doneLeaves}/{agg.totalLeaves}</span>
            {agg.doingLeaves > 0 && <span className="text-amber-600">· {agg.doingLeaves}◐</span>}
          </span>
        </div>
      )}
      {/* "AI" は title 横の Sparkles アイコンで表現するので tag chips から除外。 */}
      {task.tags.filter(t => t !== 'AI').length > 0 && (
        <div className="flex gap-1 mt-2 flex-wrap">
          {task.tags.filter(t => t !== 'AI').map(tag => (
            <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-400/10 text-emerald-600">{tag}</span>
          ))}
        </div>
      )}
      </div>{/* /headerRef wrapper */}
      {/* Subtask list (recursive) — left rail uses the children's depth colour so
          the indent reads as a coloured "shelf" of that level. */}
      {mode === 'tree' && hasChildren && expanded && (
        <div className={`mt-2 ml-2 pl-2 border-l-2 ${depthTheme(depth + 1).rail} space-y-1.5`}>
          {ch.map(child => (
            <TaskCard
              key={child.id}
              task={child}
              boardTasks={boardTasks}
              mode={mode}
              otherBoards={otherBoards}
              selectedTaskId={selectedTaskId}
              onSelectTask={onSelectTask}
              onMove={onMove}
              onDelete={onDelete}
              onUpdate={onUpdate}
              onAddSubtask={onAddSubtask}
              onDragStart={onDragStart}
              onDropBefore={onDropBefore}
              onNestInto={onNestInto}
              onMoveToBoard={onMoveToBoard}
              onDuplicateToBoard={onDuplicateToBoard}
              depth={depth + 1}
            />
          ))}
          {/* Explicit "drop here to nest under THIS parent" zone — without it, the
              parent's own nest target overlaps its children and dropping at the bottom
              of the subtree often lands as a grandchild instead. */}
          <ParentNestZone onNest={() => onNestInto(task.id)} />
        </div>
      )}
      {showMenu && (
        <div ref={menuRef} className="absolute right-0 top-8 z-10 bg-white border border-slate-300 rounded-lg shadow-xl py-1 min-w-[140px]">
          {moveOptions.map(opt => (
            <button
              key={opt.key}
              onClick={() => { onMove(task.id, opt.key); setShowMenu(false) }}
              className="w-full text-left px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-100"
            >
              &rarr; {opt.label}
            </button>
          ))}
          <hr className="border-slate-300 my-1" />
          <button onClick={() => { onAddSubtask(task.id); setShowMenu(false) }} className="w-full text-left px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-100">
            ＋ サブタスクを追加
          </button>
          <button onClick={() => { onDelete(task.id); setShowMenu(false) }} className="w-full text-left px-3 py-1.5 text-xs text-red-500 hover:bg-slate-100">
            削除{hasChildren ? '（子も含む）' : ''}
          </button>
        </div>
      )}
    </div>
  )
}

// A dashed "drop here to make a child of this parent" target. Always present at the
// end of a parent's children list so the user has an unambiguous target — without
// it, the parent's own nest zone overlaps its child cards and the drop often lands
// on a child (as a grandchild) instead of the intended parent.
function ParentNestZone({ onNest }: { onNest: () => void }) {
  const [over, setOver] = useState(false)
  return (
    <div
      onDragOver={e => { e.preventDefault(); e.stopPropagation(); if (!over) setOver(true) }}
      onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false) }}
      onDrop={e => { e.preventDefault(); e.stopPropagation(); setOver(false); onNest() }}
      className={`h-7 rounded border-2 border-dashed flex items-center justify-center text-[10px] transition-colors ${over ? 'border-indigo-400 bg-indigo-50 text-indigo-700' : 'border-slate-200 text-slate-400'}`}
    >
      + ここにドロップで子タスクとして追加
    </div>
  )
}

// Board accent-colour picker. A small swatch that toggles a floating palette;
// picking a colour or clicking outside / Escape closes it (usePopoverDismiss).
function BoardColorSwatch({ dotCls, current, onPick }: {
  dotCls: string
  current: BoardColor
  onPick: (c: BoardColor) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = usePopoverDismiss<HTMLDivElement>(open, () => setOpen(false))
  return (
    <div ref={ref} className="relative">
      <button
        onClick={ev => { ev.stopPropagation(); setOpen(o => !o) }}
        title="色を変える"
        className={`w-5 h-5 rounded cursor-pointer flex items-center justify-center ${dotCls} hover:scale-110 transition-all`}
      />
      {open && (
        <div className="absolute right-0 top-6 z-20 bg-white border border-slate-200 rounded-lg shadow-xl p-2 grid grid-cols-4 gap-1.5">
          {ALL_BOARD_COLORS.map(c => (
            <button
              key={c}
              onClick={ev => { ev.stopPropagation(); onPick(c); setOpen(false) }}
              className={`w-5 h-5 rounded ${BOARD_COLOR_CLASSES[c].dot} ${current === c ? 'ring-2 ring-offset-1 ring-slate-700' : 'hover:scale-110'} transition-transform`}
              title={c}
            />
          ))}
        </div>
      )}
    </div>
  )
}
