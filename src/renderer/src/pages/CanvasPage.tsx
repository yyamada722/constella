import { useState, useRef, useCallback, useEffect, memo, useMemo, createElement, forwardRef, useImperativeHandle } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Plus, ZoomIn, ZoomOut, Maximize, FileText, StickyNote, CheckSquare, Globe, Lightbulb, Trash2, List, LayoutGrid, X, ExternalLink, FileDown, Image as ImageIcon, MousePointer2, ArrowUpRight, Frame, Pencil, Eraser, Type, Video, Undo2, Redo2, Grid3x3, Copy, AlignStartVertical, AlignCenterVertical, AlignEndVertical, AlignStartHorizontal, AlignCenterHorizontal, AlignEndHorizontal, AlignHorizontalSpaceBetween, AlignVerticalSpaceBetween, BringToFront, SendToBack, Ban, Lock, Unlock, ClipboardPaste, Spline, Map as MapIcon, Crop, AudioLines, Play, Pause, ImageDown, FolderKanban, ChevronDown, Check, BookmarkPlus, Clock, CornerDownLeft, Link2, Camera, Layers, SkipBack, SkipForward, GripVertical, TrainFront, Unlink, Search, ListTodo, ListChecks, Volume2, VolumeX } from 'lucide-react'
import { useApp } from '../store'
import { CanvasCard, CanvasTab, CardPage, CanvasArrow, CanvasGroup, CanvasStroke, CanvasLabel, Bookmark, Task, Note, Project } from '../types'
import { generateId } from '../utils'
import { DRAFT_WHEN_OPTIONS, draftWhenToEndDate } from '../utils/draftWhen'
import { PdfViewer } from '../components/PdfViewer'
import { MarkdownText } from '../components/MarkdownText'
import { ImageCropper } from '../components/ImageCropper'
import { ClippedImage } from '../components/ClippedImage'
import { putMedia, deleteMedia, isMediaRef, useMediaUrl, getMediaBlob, resolveMediaUrl } from '../persistence/media'
import { IMAGE_ACCEPT, isImageFile, normalizeImageBlob } from '../utils/image'
import { usePopoverDismiss } from '../components/usePopoverDismiss'
import WaveSurfer from 'wavesurfer.js'

const cardTypes = {
  text: { label: 'テキスト', icon: FileText, bg: 'bg-white', border: 'border-slate-300', text: 'text-slate-500', header: 'bg-slate-50', defaultWidth: 360, defaultHeight: 280 },
  note: { label: 'メモ', icon: StickyNote, bg: 'bg-amber-50', border: 'border-amber-200', text: 'text-amber-600', header: 'bg-amber-100/50', defaultWidth: 220, defaultHeight: 140 },
  todo: { label: 'TODO', icon: CheckSquare, bg: 'bg-emerald-50', border: 'border-emerald-200', text: 'text-emerald-600', header: 'bg-emerald-100/50', defaultWidth: 220, defaultHeight: 140 },
  research: { label: 'リサーチ', icon: Globe, bg: 'bg-sky-50', border: 'border-sky-200', text: 'text-sky-600', header: 'bg-sky-100/50', defaultWidth: 220, defaultHeight: 140 },
  idea: { label: 'アイデア', icon: Lightbulb, bg: 'bg-violet-50', border: 'border-violet-200', text: 'text-violet-600', header: 'bg-violet-100/50', defaultWidth: 220, defaultHeight: 140 },
  web: { label: 'Webページ', icon: ExternalLink, bg: 'bg-cyan-50', border: 'border-cyan-200', text: 'text-cyan-600', header: 'bg-cyan-100/50', defaultWidth: 480, defaultHeight: 400 },
  pdf: { label: 'PDF', icon: FileDown, bg: 'bg-rose-50', border: 'border-rose-200', text: 'text-rose-600', header: 'bg-rose-100/50', defaultWidth: 480, defaultHeight: 500 },
  image: { label: '画像', icon: ImageIcon, bg: 'bg-teal-50', border: 'border-teal-200', text: 'text-teal-600', header: 'bg-teal-100/50', defaultWidth: 320, defaultHeight: 260 },
  video: { label: '動画', icon: Video, bg: 'bg-fuchsia-50', border: 'border-fuchsia-200', text: 'text-fuchsia-600', header: 'bg-fuchsia-100/50', defaultWidth: 480, defaultHeight: 300 },
  audio: { label: '音声', icon: AudioLines, bg: 'bg-orange-50', border: 'border-orange-200', text: 'text-orange-600', header: 'bg-orange-100/50', defaultWidth: 360, defaultHeight: 150 },
  sequence: { label: '連番再生', icon: Layers, bg: 'bg-indigo-50', border: 'border-indigo-200', text: 'text-indigo-600', header: 'bg-indigo-100/50', defaultWidth: 360, defaultHeight: 360 },
  // タスク下書き — a lightweight planning sticky. Scatter these, wire parent→child
  // with arrows, then タスク化 converts the whole flow into real tasks.
  taskDraft: { label: 'タスク下書き', icon: ListTodo, bg: 'bg-yellow-50', border: 'border-yellow-400 border-dashed', text: 'text-yellow-700', header: 'bg-yellow-100/60', defaultWidth: 210, defaultHeight: 112 },
} as const

/* ── タスク下書きカード body ── */

const TaskDraftCardBody = memo(function TaskDraftCardBody({ card, onUpdate, onSelect, locked }: {
  card: CanvasCard
  onUpdate: (updates: Partial<CanvasCard>) => void
  onSelect?: () => void
  locked: boolean
}) {
  return (
    <div className="flex-1 min-h-0 flex flex-col gap-1.5 px-3 py-2">
      <input
        type="text"
        value={card.title}
        data-draft-title="1"
        onChange={e => onUpdate({ title: e.target.value })}
        onMouseDown={e => e.stopPropagation()}
        // Focusing the title also selects the card — Tab-to-extend chains from
        // selectedIds[0], so typing into a draft must make IT the chain source.
        onFocus={() => onSelect?.()}
        onKeyDown={e => {
          if (e.key !== 'Enter') return
          // IME composition guard — don't commit mid-conversion.
          if (e.nativeEvent.isComposing || (e as unknown as { keyCode: number }).keyCode === 229) return
          ;(e.currentTarget as HTMLInputElement).blur()
        }}
        placeholder="やること…"
        readOnly={locked}
        // Only steal focus for FRESH cards (scatter/Tab spawn) — an empty draft
        // left on a tab must not grab the keyboard on every remount (tab switch,
        // list↔canvas toggle), which would swallow global shortcuts.
        autoFocus={!card.title && !locked && Date.now() - new Date(card.createdAt).getTime() < 3000}
        className="w-full bg-transparent text-[12px] font-medium text-slate-800 outline-none border-b border-transparent focus:border-yellow-400 placeholder-slate-400"
      />
      <div className="flex flex-wrap gap-1 mt-auto">
        {DRAFT_WHEN_OPTIONS.map(o => (
          <button
            key={o.key}
            disabled={locked}
            onMouseDown={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); onUpdate({ draftWhen: card.draftWhen === o.key ? undefined : o.key }) }}
            title={`目安: ${draftWhenToEndDate(o.key)}`}
            className={`px-1.5 py-0.5 rounded-full text-[9px] border transition-colors ${card.draftWhen === o.key ? 'bg-yellow-400/30 border-yellow-500 text-yellow-800 font-semibold' : 'border-slate-200 text-slate-400 hover:border-yellow-400 hover:text-yellow-700'}`}
          >{o.label}</button>
        ))}
      </div>
      <div className="text-[9px] text-slate-400 truncate">
        {card.draftWhen ? `期日目安 ${draftWhenToEndDate(card.draftWhen)}` : '期日チップは任意 / 矢印で 親→子'}
      </div>
    </div>
  )
})

// Per-card color overrides (key stored on card.color). Two intensities per hue (淡 / 濃).
const COLOR_THEMES: Record<string, { bg: string; border: string; text: string; header: string; dot: string }> = {
  slate: { bg: 'bg-slate-50', border: 'border-slate-300', text: 'text-slate-600', header: 'bg-slate-100/60', dot: '#94a3b8' },
  rose: { bg: 'bg-rose-50', border: 'border-rose-200', text: 'text-rose-600', header: 'bg-rose-100/50', dot: '#fb7185' },
  amber: { bg: 'bg-amber-50', border: 'border-amber-200', text: 'text-amber-600', header: 'bg-amber-100/50', dot: '#fbbf24' },
  emerald: { bg: 'bg-emerald-50', border: 'border-emerald-200', text: 'text-emerald-600', header: 'bg-emerald-100/50', dot: '#34d399' },
  sky: { bg: 'bg-sky-50', border: 'border-sky-200', text: 'text-sky-600', header: 'bg-sky-100/50', dot: '#38bdf8' },
  violet: { bg: 'bg-violet-50', border: 'border-violet-200', text: 'text-violet-600', header: 'bg-violet-100/50', dot: '#a78bfa' },
  teal: { bg: 'bg-teal-50', border: 'border-teal-200', text: 'text-teal-600', header: 'bg-teal-100/50', dot: '#2dd4bf' },
  fuchsia: { bg: 'bg-fuchsia-50', border: 'border-fuchsia-200', text: 'text-fuchsia-600', header: 'bg-fuchsia-100/50', dot: '#e879f9' },
  slate2: { bg: 'bg-slate-200', border: 'border-slate-400', text: 'text-slate-800', header: 'bg-slate-300/60', dot: '#475569' },
  rose2: { bg: 'bg-rose-200', border: 'border-rose-400', text: 'text-rose-800', header: 'bg-rose-300/60', dot: '#e11d48' },
  amber2: { bg: 'bg-amber-200', border: 'border-amber-400', text: 'text-amber-800', header: 'bg-amber-300/60', dot: '#d97706' },
  emerald2: { bg: 'bg-emerald-200', border: 'border-emerald-400', text: 'text-emerald-800', header: 'bg-emerald-300/60', dot: '#059669' },
  sky2: { bg: 'bg-sky-200', border: 'border-sky-400', text: 'text-sky-800', header: 'bg-sky-300/60', dot: '#0284c7' },
  violet2: { bg: 'bg-violet-200', border: 'border-violet-400', text: 'text-violet-800', header: 'bg-violet-300/60', dot: '#7c3aed' },
  teal2: { bg: 'bg-teal-200', border: 'border-teal-400', text: 'text-teal-800', header: 'bg-teal-300/60', dot: '#0d9488' },
  fuchsia2: { bg: 'bg-fuchsia-200', border: 'border-fuchsia-400', text: 'text-fuchsia-800', header: 'bg-fuchsia-300/60', dot: '#c026d3' },
}

const HUE_KEYS = ['slate', 'rose', 'amber', 'emerald', 'sky', 'violet', 'teal', 'fuchsia']

const PEN_COLORS = ['#1e293b', '#ef4444', '#3b82f6', '#16a34a', '#eab308']
const PEN_WIDTHS = [2, 4, 8]
// Arrow palette: indigo default first (so it doubles as "reset to default"), then the pen colors.
const ARROW_DEFAULT_COLOR = '#6366f1'
const ARROW_COLORS = [ARROW_DEFAULT_COLOR, '#1e293b', '#ef4444', '#3b82f6', '#16a34a', '#eab308']
const ARROW_DEFAULT_WIDTH = 2
const ARROW_WIDTHS = [2, 3.5, 6]
// Dropped text/markdown files open as a text card holding the file's contents.
const TEXT_FILE_RE = /\.(md|markdown|txt|text|csv|tsv|log|json|ya?ml|xml|ini|toml)$/i
const isTextFile = (f: File) => f.type.startsWith('text/') || f.type === 'application/json' || TEXT_FILE_RE.test(f.name)
const ERASER_SIZES = [8, 16, 28] // brush radius in screen px

function strokePointsStr(pts: number[]) {
  let s = ''
  for (let i = 0; i < pts.length - 1; i += 2) s += `${pts[i]},${pts[i + 1]} `
  return s.trim()
}

// Resample a polyline into evenly-spaced points so the eraser can cut anywhere,
// not only at the (possibly sparse) vertices captured while drawing.
function resamplePoints(pts: number[], step: number): number[] {
  if (pts.length < 4) return pts.slice()
  const out = [pts[0], pts[1]]
  let px = pts[0], py = pts[1]
  let acc = 0
  for (let i = 2; i < pts.length; i += 2) {
    const tx = pts[i], ty = pts[i + 1]
    let dx = tx - px, dy = ty - py
    let dist = Math.hypot(dx, dy)
    if (dist === 0) continue
    while (acc + dist >= step) {
      const t = (step - acc) / dist
      px = px + dx * t
      py = py + dy * t
      out.push(px, py)
      dx = tx - px; dy = ty - py
      dist = Math.hypot(dx, dy)
      acc = 0
    }
    acc += dist
    px = tx; py = ty
  }
  const ex = pts[pts.length - 2], ey = pts[pts.length - 1]
  if (Math.hypot(ex - out[out.length - 2], ey - out[out.length - 1]) > step * 0.25) out.push(ex, ey)
  return out
}

// Point on a card's border along the line from its center toward (tx, ty)
function cardBorderPoint(card: CanvasCard, tx: number, ty: number) {
  const cx = card.x + card.width / 2, cy = card.y + card.height / 2
  const dx = tx - cx, dy = ty - cy
  if (dx === 0 && dy === 0) return { x: cx, y: cy }
  const s = 1 / Math.max(Math.abs(dx) / (card.width / 2), Math.abs(dy) / (card.height / 2))
  return { x: cx + dx * s, y: cy + dy * s }
}

// Resolve an arrow's visual endpoints: attached ends follow their card (clipped to border)
function resolveArrowEnds(arrow: CanvasArrow, byId: Map<string, CanvasCard>) {
  const fc = arrow.fromCardId ? byId.get(arrow.fromCardId) : undefined
  const tc = arrow.toCardId ? byId.get(arrow.toCardId) : undefined
  let p1 = fc ? { x: fc.x + fc.width / 2, y: fc.y + fc.height / 2 } : { x: arrow.x1, y: arrow.y1 }
  let p2 = tc ? { x: tc.x + tc.width / 2, y: tc.y + tc.height / 2 } : { x: arrow.x2, y: arrow.y2 }
  if (fc) p1 = cardBorderPoint(fc, p2.x, p2.y)
  if (tc) p2 = cardBorderPoint(tc, p1.x, p1.y)
  return { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y }
}

// Arrow path + label point (straight L or curved quadratic Q)
function arrowGeometry(e: { x1: number; y1: number; x2: number; y2: number }, curved?: boolean) {
  const mx = (e.x1 + e.x2) / 2, my = (e.y1 + e.y2) / 2
  if (!curved) return { d: `M ${e.x1} ${e.y1} L ${e.x2} ${e.y2}`, lx: mx, ly: my }
  const dx = e.x2 - e.x1, dy = e.y2 - e.y1
  const len = Math.hypot(dx, dy) || 1
  const off = Math.min(len * 0.25, 80)
  const px = -dy / len, py = dx / len // perpendicular unit
  return { d: `M ${e.x1} ${e.y1} Q ${mx + px * off} ${my + py * off} ${e.x2} ${e.y2}`, lx: mx + px * off / 2, ly: my + py * off / 2 }
}

// Split a stroke's points into runs, dropping vertices within the eraser brush
function splitPointsByBrush(pts: number[], ex: number, ey: number, r: number): number[][] {
  const runs: number[][] = []
  let cur: number[] = []
  for (let i = 0; i < pts.length; i += 2) {
    if (Math.hypot(pts[i] - ex, pts[i + 1] - ey) <= r) {
      if (cur.length >= 4) runs.push(cur)
      cur = []
    } else {
      cur.push(pts[i], pts[i + 1])
    }
  }
  if (cur.length >= 4) runs.push(cur)
  return runs
}

interface DragState {
  kind: 'pan' | 'card' | 'resize' | 'arrow-p1' | 'arrow-p2' | 'group-move' | 'group-resize' | 'label-move' | 'select-rect'
  cardId?: string
  cards?: { id: string; x: number; y: number }[]
  arrow?: CanvasArrow
  group?: CanvasGroup
  groupCards?: { id: string; x: number; y: number }[]
  groupGroups?: CanvasGroup[]
  // Labels moved alongside the drag: the selected labels (kind 'card') or the
  // labels contained in a dragged group (kind 'group-move').
  labels?: CanvasLabel[]
  label?: CanvasLabel
  startMouseX: number
  startMouseY: number
  startX: number
  startY: number
  startW?: number
  startH?: number
  moved: boolean
}

const LABEL_SIZES = [14, 20, 28]

export default function CanvasPage() {
  const { state, dispatch, undo, redo, canUndo, canRedo } = useApp()
  const canvasRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const dragDepthRef = useRef(0)
  const viewportRef = useRef({ x: 0, y: 0, zoom: 1 })
  const [viewport, setViewport] = useState({ x: 0, y: 0, zoom: 1 })
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [selectRect, setSelectRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const selectRectRef = useRef<{ x0: number; y0: number } | null>(null)
  const spaceRef = useRef(false)
  const [spacePan, setSpacePan] = useState(false)
  const [snapToGrid, setSnapToGrid] = useState(false)
  const snapRef = useRef(snapToGrid)
  snapRef.current = snapToGrid
  const [canvasLocked, setCanvasLocked] = useState(false)
  const canvasLockedRef = useRef(canvasLocked)
  canvasLockedRef.current = canvasLocked
  // Canvas in-tab search — click toolbar magnifier → popover with input + result rows → jump.
  const [canvasSearch, setCanvasSearch] = useState('')
  const [canvasSearchOpen, setCanvasSearchOpen] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; kind: 'card' | 'canvas' | 'label' | 'arrow' | 'group'; canvasX: number; canvasY: number } | null>(null)
  // Note/Task link picker + detach popovers (canvas-level so only one is open at a time).
  const [pickerOpenCardId, setPickerOpenCardId] = useState<string | null>(null)
  const [detachOpenCardId, setDetachOpenCardId] = useState<string | null>(null)
  const [pickerTab, setPickerTab] = useState<'existing' | 'new'>('existing')
  const [pickerSearch, setPickerSearch] = useState('')
  // Deletion is gated behind a confirmation modal (no more accidental one-click deletes).
  const [confirmDelete, setConfirmDelete] = useState<{ message: string; run: () => void } | null>(null)
  const clipboardRef = useRef<CanvasCard[]>([])
  // True while the most recent copy was an in-app card copy (no window blur since),
  // so Ctrl+V prefers pasting cards over a stale image left in the OS clipboard.
  const internalCopyFreshRef = useRef(false)
  const [canvasSize, setCanvasSize] = useState({ w: 0, h: 0 })
  const [showMinimap, setShowMinimap] = useState(true)
  const [showAddMenu, setShowAddMenu] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [dragFileOver, setDragFileOver] = useState(false)
  const [viewMode, setViewMode] = useState<'canvas' | 'list'>('canvas')
  // Canvas categories (tabs) are scoped directly by the global active master
  // project — there is no canvas-local project layer anymore.
  const activeProjectId = state.activeMasterProjectId
  const [activeTabId, setActiveTabId] = useState<string>(state.canvasTabs[0]?.id ?? '')
  const [editingTabId, setEditingTabId] = useState<string | null>(null)
  const [tool, setTool] = useState<'select' | 'arrow' | 'group' | 'pen' | 'eraser' | 'label' | 'taskdraft'>('select')
  const [selectedArrowId, setSelectedArrowId] = useState<string | null>(null)
  const [editingArrowId, setEditingArrowId] = useState<string | null>(null)
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null)
  const [selectedLabelIds, setSelectedLabelIds] = useState<string[]>([])
  const [editingLabelId, setEditingLabelId] = useState<string | null>(null)
  const [drawArrow, setDrawArrow] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null)
  const drawArrowRef = useRef<{ x1: number; y1: number; x2: number; y2: number } | null>(null)
  const [drawGroup, setDrawGroup] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const drawGroupRef = useRef<{ x0: number; y0: number; x: number; y: number; w: number; h: number } | null>(null)
  const [penColor, setPenColor] = useState(PEN_COLORS[0])
  const [penWidth, setPenWidth] = useState(PEN_WIDTHS[1])
  const [strokePreview, setStrokePreview] = useState<number[] | null>(null)
  const strokeRef = useRef<number[] | null>(null)
  const eraserRef = useRef(false)
  const [eraserSize, setEraserSize] = useState(ERASER_SIZES[1])
  const eraserSizeRef = useRef(eraserSize)
  eraserSizeRef.current = eraserSize
  const [eraserMode, setEraserMode] = useState<'partial' | 'stroke'>('partial')
  const eraserModeRef = useRef(eraserMode)
  eraserModeRef.current = eraserMode
  const [eraserCursor, setEraserCursor] = useState<{ x: number; y: number } | null>(null)
  const [erasePreview, setErasePreview] = useState<CanvasStroke[] | null>(null)
  const eraseWorkingRef = useRef<CanvasStroke[] | null>(null)
  // タスク化 popover: target board choice ('__new__' = create a board named after the tab).
  const [convertOpen, setConvertOpen] = useState(false)
  const [convertBoardId, setConvertBoardId] = useState<string>('__new__')
  const [convertNewBoardName, setConvertNewBoardName] = useState('')

  // Click-outside / Escape dismissal for the toolbar dropdowns (these wrap both
  // their trigger and popover, so a click on the trigger doesn't self-close).
  const addMenuRef = usePopoverDismiss<HTMLDivElement>(showAddMenu, () => setShowAddMenu(false))
  const convertRef = usePopoverDismiss<HTMLDivElement>(convertOpen, () => setConvertOpen(false))

  viewportRef.current = viewport

  const tabCards = useMemo(
    () => state.canvasCards.filter(c => c.tabId === activeTabId),
    [state.canvasCards, activeTabId]
  )

  // Draft cards on the active tab — drive the タスク化 button visibility/count.
  const draftCards = useMemo(() => tabCards.filter(c => c.type === 'taskDraft'), [tabCards])
  // Boards of the active master project — conversion targets.
  const convertBoards = useMemo(
    () => state.projects.filter(p => p.masterProjectId === activeProjectId),
    [state.projects, activeProjectId]
  )

  const tabArrows = useMemo(
    () => state.canvasArrows.filter(a => a.tabId === activeTabId),
    [state.canvasArrows, activeTabId]
  )

  const cardsById = useMemo(() => new Map(tabCards.map(c => [c.id, c])), [tabCards])
  const tabCardsRef = useRef(tabCards); tabCardsRef.current = tabCards
  const tabArrowsRef = useRef(tabArrows); tabArrowsRef.current = tabArrows
  // Topmost card containing the point. Array order == z-order (BRING_CARD_FRONT
  // moves cards to the END), so scan from the back — otherwise arrows drawn over
  // overlapping cards attach to the card UNDERNEATH the one the user sees.
  const cardAtPoint = useCallback((x: number, y: number) => {
    const arr = tabCardsRef.current
    for (let i = arr.length - 1; i >= 0; i--) {
      const c = arr[i]
      if (x >= c.x && x <= c.x + c.width && y >= c.y && y <= c.y + c.height) return c
    }
    return undefined
  }, [])

  const tabGroups = useMemo(
    () => state.canvasGroups.filter(g => g.tabId === activeTabId),
    [state.canvasGroups, activeTabId]
  )

  const tabStrokes = useMemo(
    () => state.canvasStrokes.filter(s => s.tabId === activeTabId),
    [state.canvasStrokes, activeTabId]
  )
  const tabStrokesRef = useRef(tabStrokes)
  tabStrokesRef.current = tabStrokes

  const tabLabels = useMemo(
    () => state.canvasLabels.filter(l => l.tabId === activeTabId),
    [state.canvasLabels, activeTabId]
  )
  const tabLabelsRef = useRef(tabLabels)
  tabLabelsRef.current = tabLabels
  // The single-label toolbar (size/color) only applies when exactly one label is selected.
  const selectedLabel = selectedLabelIds.length === 1 ? (tabLabels.find(l => l.id === selectedLabelIds[0]) ?? null) : null
  const selectedArrow = tabArrows.find(a => a.id === selectedArrowId) ?? null

  const toCanvas = useCallback((clientX: number, clientY: number) => {
    const vp = viewportRef.current
    const rect = canvasRef.current?.getBoundingClientRect()
    return {
      x: (clientX - (rect?.left ?? 0) - vp.x) / vp.zoom,
      y: (clientY - (rect?.top ?? 0) - vp.y) / vp.zoom,
    }
  }, [])

  // Categories (tabs) belonging to the active master project.
  const projectTabs = useMemo(
    () => state.canvasTabs.filter(t => t.projectId === activeProjectId),
    [state.canvasTabs, activeProjectId]
  )

  // Keep the active category inside the active master project: if it was deleted or
  // belongs to another project (e.g. after switching the master), jump to the first.
  useEffect(() => {
    if (!projectTabs.find(t => t.id === activeTabId)) {
      setActiveTabId(projectTabs[0]?.id ?? '')
    }
  }, [projectTabs, activeTabId])

  useEffect(() => {
    if (viewMode !== 'canvas') return
    const el = canvasRef.current
    if (!el) return
    // True if the wheel is over a card region that can still scroll vertically in
    // the wheel's direction — in that case we let it scroll natively instead of
    // zooming the canvas. (At a scroll boundary, falls through to zoom.)
    const overScrollable = (start: EventTarget | null, dir: number): boolean => {
      let node = start as Element | null
      while (node && node !== el) {
        if (node instanceof HTMLElement && node.scrollHeight > node.clientHeight + 1) {
          const oy = getComputedStyle(node).overflowY
          if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') {
            const canDown = node.scrollTop + node.clientHeight < node.scrollHeight - 1
            const canUp = node.scrollTop > 0
            if ((dir > 0 && canDown) || (dir < 0 && canUp)) return true
          }
        }
        node = node.parentElement
      }
      return false
    }
    const handler = (e: WheelEvent) => {
      if (overScrollable(e.target, e.deltaY)) return // let the card's text scroll
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      // Pinch-zoom on a trackpad arrives as a wheel with ctrlKey set; Cmd/Ctrl+wheel
      // is the explicit zoom gesture for a mouse. A plain wheel — including a
      // two-finger trackpad swipe — pans the board (Figma/Miro-style), so the
      // MacBook trackpad can move the canvas instead of only zooming it.
      if (e.ctrlKey || e.metaKey) {
        const factor = e.deltaY > 0 ? 0.92 : 1.08
        setViewport(v => {
          const newZoom = Math.min(Math.max(v.zoom * factor, 0.1), 5)
          const wx = (mx - v.x) / v.zoom
          const wy = (my - v.y) / v.zoom
          return { x: mx - wx * newZoom, y: my - wy * newZoom, zoom: newZoom }
        })
      } else {
        setViewport(v => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }))
      }
    }
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [viewMode])

  // Track the canvas viewport size (for the minimap)
  useEffect(() => {
    if (viewMode !== 'canvas') return
    const el = canvasRef.current
    if (!el) return
    const ro = new ResizeObserver(entries => { const r = entries[0].contentRect; setCanvasSize({ w: r.width, h: r.height }) })
    ro.observe(el)
    setCanvasSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [viewMode])

  const navigateTo = useCallback((wx: number, wy: number) => {
    setViewport(v => ({ ...v, x: canvasSize.w / 2 - wx * v.zoom, y: canvasSize.h / 2 - wy * v.zoom }))
  }, [canvasSize])

  // Focus a card/label when navigated here from search or a [[wiki-link]]
  // (via router location state: { focusCardId } / { focusLabelId }).
  const location = useLocation()
  const navigate = useNavigate()
  const handledFocusRef = useRef('')
  useEffect(() => {
    const st = location.state as { focusCardId?: string; focusLabelId?: string } | null
    if (!st || handledFocusRef.current === location.key) return
    // The target may live in a different master project (wiki-links / search):
    // switch the active master to its category's owner so it isn't filtered out.
    const focusTab = (tabId: string) => {
      const master = state.canvasTabs.find(t => t.id === tabId)?.projectId
      if (master && master !== activeProjectId) dispatch({ type: 'SET_ACTIVE_MASTER_PROJECT', payload: master })
      setViewMode('canvas'); setActiveTabId(tabId)
    }
    // Coming from list-view / another page, the canvas div may not have been
    // laid out yet — canvasSize is still {0,0} on the RAF right after mount,
    // and centering against it lands the target in the top-left corner.
    // Poll a few frames until the ResizeObserver populates canvasSize.
    const waitAndCenter = (wx: number, wy: number) => {
      let tries = 0
      const step = () => {
        if (canvasSize.w > 0 && canvasSize.h > 0) { navigateTo(wx, wy); return }
        if (++tries > 30) { navigateTo(wx, wy); return } // give up after ~500ms — better than never
        requestAnimationFrame(step)
      }
      requestAnimationFrame(step)
    }
    if (st.focusCardId) {
      const card = state.canvasCards.find(c => c.id === st.focusCardId)
      if (!card) return
      handledFocusRef.current = location.key
      focusTab(card.tabId)
      setSelectedArrowId(null); setSelectedGroupId(null); setSelectedLabelIds([]); setSelectedIds([card.id])
      waitAndCenter(card.x + card.width / 2, card.y + card.height / 2)
    } else if (st.focusLabelId) {
      const label = state.canvasLabels.find(l => l.id === st.focusLabelId)
      if (!label) return
      handledFocusRef.current = location.key
      focusTab(label.tabId)
      setSelectedIds([]); setSelectedArrowId(null); setSelectedGroupId(null); setSelectedLabelIds([label.id])
      waitAndCenter(label.x, label.y)
    }
  }, [location, state.canvasCards, state.canvasLabels, state.canvasTabs, activeProjectId, dispatch, navigateTo, canvasSize])

  // Hold Space to temporarily pan with a left-drag (rubber-band select otherwise)
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return
      const ae = document.activeElement as HTMLElement | null
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return
      e.preventDefault()
      spaceRef.current = true
      setSpacePan(true)
    }
    const up = (e: KeyboardEvent) => { if (e.code === 'Space') { spaceRef.current = false; setSpacePan(false) } }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up) }
  }, [])

  // Block the browser from opening a file dropped anywhere, and reliably clear
  // the drop overlay after any drop (capture phase runs before a card's
  // stopPropagation, so dropping onto a card still resets it)
  useEffect(() => {
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types || []).includes('Files')
    const prevent = (e: DragEvent) => { if (hasFiles(e)) e.preventDefault() }
    const reset = () => { dragDepthRef.current = 0; setDragFileOver(false) }
    window.addEventListener('dragover', prevent)
    window.addEventListener('drop', prevent)
    window.addEventListener('drop', reset, true)
    return () => {
      window.removeEventListener('dragover', prevent)
      window.removeEventListener('drop', prevent)
      window.removeEventListener('drop', reset, true)
    }
  }, [])

  const handleBgMouseDown = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement
    if (!target.dataset.canvasBg) return
    // Pan with Space held + left drag (middle-button pan is handled globally below,
    // so it also works when starting over a card).
    if (e.button === 0 && spaceRef.current) {
      const vp = viewportRef.current
      dragRef.current = { kind: 'pan', startMouseX: e.clientX, startMouseY: e.clientY, startX: vp.x, startY: vp.y, moved: false }
      setIsDragging(true)
      e.preventDefault()
      return
    }
    if (e.button !== 0) return
    setSelectedArrowId(null)
    setEditingArrowId(null)
    setSelectedGroupId(null)
    setSelectedLabelIds([])
    setEditingLabelId(null)
    setShowAddMenu(false)
    setConvertOpen(false)
    if (!canvasLocked && tool === 'label') {
      const p = toCanvas(e.clientX, e.clientY)
      const label: CanvasLabel = { id: generateId(), tabId: activeTabId, text: '', x: p.x, y: p.y, fontSize: 20, color: '#1e293b', createdAt: new Date().toISOString() }
      dispatch({ type: 'ADD_CANVAS_LABEL', payload: label })
      setSelectedLabelIds([label.id])
      setEditingLabelId(label.id)
      setTool('select')
      e.preventDefault()
      return
    }
    if (!canvasLocked && tool === 'taskdraft') {
      // Scatter mode: each click drops a draft card and the tool STAYS active so
      // the user can rapid-fire click out a whole plan (Esc / 選択 to exit).
      const p = toCanvas(e.clientX, e.clientY)
      const cfg = cardTypes.taskDraft
      const card: CanvasCard = {
        id: generateId(), tabId: activeTabId, type: 'taskDraft', title: '', content: '',
        x: p.x - cfg.defaultWidth / 2, y: p.y - 16,
        width: cfg.defaultWidth, height: cfg.defaultHeight, createdAt: new Date().toISOString(),
      }
      dispatch({ type: 'ADD_CANVAS_CARD', payload: card })
      setSelectedIds([card.id])
      e.preventDefault()
      return
    }
    if (!canvasLocked && tool === 'arrow') {
      const p = toCanvas(e.clientX, e.clientY)
      const a = { x1: p.x, y1: p.y, x2: p.x, y2: p.y }
      drawArrowRef.current = a
      setDrawArrow(a)
      setIsDragging(true)
      e.preventDefault()
      return
    }
    if (!canvasLocked && tool === 'group') {
      const p = toCanvas(e.clientX, e.clientY)
      const g = { x0: p.x, y0: p.y, x: p.x, y: p.y, w: 0, h: 0 }
      drawGroupRef.current = g
      setDrawGroup({ x: p.x, y: p.y, w: 0, h: 0 })
      setIsDragging(true)
      e.preventDefault()
      return
    }
    // Select tool on empty canvas: rubber-band selection
    const p = toCanvas(e.clientX, e.clientY)
    selectRectRef.current = { x0: p.x, y0: p.y }
    setSelectRect({ x: p.x, y: p.y, w: 0, h: 0 })
    setSelectedIds([])
    setIsDragging(true)
    e.preventDefault()
  }, [tool, toCanvas, dispatch, activeTabId, canvasLocked])

  const selectCard = useCallback((id: string, additive: boolean) => {
    setSelectedArrowId(null)
    setSelectedGroupId(null)
    if (!additive) setSelectedLabelIds([]) // keep labels when shift-extending a mixed selection
    if (additive) setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
    else setSelectedIds(prev => (prev.length > 1 && prev.includes(id)) ? prev : [id])
  }, [])

  const handleCardHeaderDown = useCallback((e: React.MouseEvent, card: CanvasCard) => {
    if (e.button !== 0) return
    e.stopPropagation()
    setSelectedArrowId(null)
    setSelectedGroupId(null)
    // Keep the multi-selection (cards + labels) when grabbing one of its members.
    const inMulti = selectedIds.includes(card.id) && (selectedIds.length > 1 || selectedLabelIds.length > 0)
    const movingCards = inMulti ? selectedIds : [card.id]
    const movingLabels = inMulti ? selectedLabelIds : []
    if (!inMulti) { setSelectedIds([card.id]); setSelectedLabelIds([]) }
    const cards = canvasLockedRef.current ? [] : tabCards.filter(c => movingCards.includes(c.id) && !c.locked).map(c => ({ id: c.id, x: c.x, y: c.y }))
    const labels = canvasLockedRef.current ? [] : tabLabels.filter(l => movingLabels.includes(l.id))
    dragRef.current = { kind: 'card', cards, labels, startMouseX: e.clientX, startMouseY: e.clientY, startX: 0, startY: 0, moved: false }
    // Don't enter "dragging" (which mounts the full-screen overlay) until the pointer
    // actually moves — otherwise the overlay intercepts the mouseup between a header
    // double-click's two clicks and title editing never opens (handled in handleMouseMove).
  }, [selectedIds, selectedLabelIds, tabCards, tabLabels])

  const handleResizeDown = useCallback((e: React.MouseEvent, card: CanvasCard) => {
    if (e.button !== 0) return
    e.stopPropagation()
    if (card.locked || canvasLockedRef.current) return
    dragRef.current = { kind: 'resize', cardId: card.id, startMouseX: e.clientX, startMouseY: e.clientY, startX: 0, startY: 0, startW: card.width, startH: card.height, moved: false }
    setIsDragging(true)
  }, [])

  // Set after handleMouseUp is defined; lets handleMouseMove end a drag without a
  // forward reference.
  const handleMouseUpRef = useRef<() => void>(() => {})

  // Eraser brush: split strokes where the brush passes (partial erase).
  // Defined before handleMouseMove because that handler depends on it.
  const applyBrush = useCallback((ex: number, ey: number) => {
    const work = eraseWorkingRef.current
    if (!work) return
    const r = eraserSizeRef.current / viewportRef.current.zoom
    const mode = eraserModeRef.current
    let changed = false
    const next: CanvasStroke[] = []
    for (const s of work) {
      const rr = r + s.width / 2
      let hit = false
      for (let i = 0; i < s.points.length; i += 2) {
        if (Math.hypot(s.points[i] - ex, s.points[i + 1] - ey) <= rr) { hit = true; break }
      }
      if (!hit) { next.push(s); continue }
      changed = true
      if (mode === 'partial') {
        for (const run of splitPointsByBrush(s.points, ex, ey, rr)) {
          next.push({ ...s, id: generateId(), points: run })
        }
      }
      // mode === 'stroke' → drop the whole stroke (don't push)
    }
    if (changed) { eraseWorkingRef.current = next; setErasePreview(next) }
  }, [])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    // Pen / eraser drawing. handleOverlayDown (on the z-5 pen overlay) starts the
    // stroke and sets isDragging, which mounts the full-window z-50 overlay that
    // sits above webviews/iframes — so the rest of the stroke arrives HERE, not on
    // the pen overlay. Track it through to completion.
    if (strokeRef.current) {
      if (e.buttons === 0) { handleMouseUpRef.current(); return }
      const p = toCanvas(e.clientX, e.clientY)
      const pts = strokeRef.current
      const dx = p.x - pts[pts.length - 2], dy = p.y - pts[pts.length - 1]
      if (dx * dx + dy * dy >= 4) { pts.push(p.x, p.y); setStrokePreview(pts.slice()) }
      return
    }
    if (eraserRef.current) {
      if (e.buttons === 0) { handleMouseUpRef.current(); return }
      const rect = canvasRef.current?.getBoundingClientRect()
      if (rect) setEraserCursor({ x: e.clientX - rect.left, y: e.clientY - rect.top })
      const p = toCanvas(e.clientX, e.clientY)
      applyBrush(p.x, p.y)
      return
    }
    // Status check: if no button is held but a drag is still active, the release was
    // missed (e.g. over a webview/iframe or outside the window) — end it now so pan
    // doesn't stay "stuck" on.
    if (e.buttons === 0 && (dragRef.current || selectRectRef.current || drawArrowRef.current || drawGroupRef.current)) {
      handleMouseUpRef.current()
      return
    }
    if (drawArrowRef.current) {
      const p = toCanvas(e.clientX, e.clientY)
      const a = { ...drawArrowRef.current, x2: p.x, y2: p.y }
      drawArrowRef.current = a
      setDrawArrow(a)
      return
    }
    if (drawGroupRef.current) {
      const p = toCanvas(e.clientX, e.clientY)
      const g0 = drawGroupRef.current
      const x = Math.min(g0.x0, p.x), y = Math.min(g0.y0, p.y)
      const w = Math.abs(p.x - g0.x0), h = Math.abs(p.y - g0.y0)
      drawGroupRef.current = { ...g0, x, y, w, h }
      setDrawGroup({ x, y, w, h })
      return
    }
    if (selectRectRef.current) {
      const p = toCanvas(e.clientX, e.clientY)
      const r = selectRectRef.current
      const x = Math.min(r.x0, p.x), y = Math.min(r.y0, p.y)
      const w = Math.abs(p.x - r.x0), h = Math.abs(p.y - r.y0)
      setSelectRect({ x, y, w, h })
      setSelectedIds(tabCards.filter(c => c.x < x + w && c.x + c.width > x && c.y < y + h && c.y + c.height > y).map(c => c.id))
      setSelectedLabelIds(tabLabels.filter(l => { const b = labelBox(l); return b.x < x + w && b.x + b.w > x && b.y < y + h && b.y + b.h > y }).map(l => l.id))
      return
    }
    const d = dragRef.current
    if (!d) return
    const dx = e.clientX - d.startMouseX
    const dy = e.clientY - d.startMouseY
    if (!d.moved) {
      // Ignore sub-threshold jitter so a click / double-click on a draggable header
      // (e.g. to edit a card/group title) isn't treated as a drag. Only once the
      // pointer truly moves do we commit to dragging and mount the overlay (which
      // covers webviews/iframes for the rest of the drag).
      if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return
      d.moved = true
      setIsDragging(true)
    }
    const zoom = viewportRef.current.zoom
    const snap = (v: number) => snapRef.current ? Math.round(v / 20) * 20 : v
    if (d.kind === 'pan') {
      setViewport(v => ({ ...v, x: d.startX + dx, y: d.startY + dy }))
    } else if (d.kind === 'card') {
      d.cards?.forEach(c => dispatch({ type: 'MOVE_CANVAS_CARD', payload: { id: c.id, x: snap(c.x + dx / zoom), y: snap(c.y + dy / zoom) } }))
      d.labels?.forEach(l => dispatch({ type: 'UPDATE_CANVAS_LABEL', payload: { ...l, x: snap(l.x + dx / zoom), y: snap(l.y + dy / zoom) } }))
    } else if (d.kind === 'resize' && d.cardId) {
      const w = Math.max(160, snap((d.startW ?? 220) + dx / zoom))
      const h = Math.max(80, snap((d.startH ?? 140) + dy / zoom))
      dispatch({ type: 'RESIZE_CANVAS_CARD', payload: { id: d.cardId, width: w, height: h } })
    } else if ((d.kind === 'arrow-p1' || d.kind === 'arrow-p2') && d.arrow) {
      const p = toCanvas(e.clientX, e.clientY)
      const upd = d.kind === 'arrow-p1' ? { x1: p.x, y1: p.y, fromCardId: undefined } : { x2: p.x, y2: p.y, toCardId: undefined }
      dispatch({ type: 'UPDATE_CANVAS_ARROW', payload: { ...d.arrow, ...upd } })
    } else if (d.kind === 'group-move' && d.group) {
      const gx = snap(d.startX + dx / zoom), gy = snap(d.startY + dy / zoom)
      dispatch({ type: 'UPDATE_CANVAS_GROUP', payload: { ...d.group, x: gx, y: gy } })
      d.groupCards?.forEach(c => dispatch({ type: 'MOVE_CANVAS_CARD', payload: { id: c.id, x: snap(c.x + dx / zoom), y: snap(c.y + dy / zoom) } }))
      d.groupGroups?.forEach(g => dispatch({ type: 'UPDATE_CANVAS_GROUP', payload: { ...g, x: snap(g.x + dx / zoom), y: snap(g.y + dy / zoom) } }))
      d.labels?.forEach(l => dispatch({ type: 'UPDATE_CANVAS_LABEL', payload: { ...l, x: snap(l.x + dx / zoom), y: snap(l.y + dy / zoom) } }))
    } else if (d.kind === 'group-resize' && d.group) {
      const w = Math.max(120, snap((d.startW ?? 200) + dx / zoom))
      const h = Math.max(80, snap((d.startH ?? 120) + dy / zoom))
      dispatch({ type: 'UPDATE_CANVAS_GROUP', payload: { ...d.group, width: w, height: h } })
    } else if (d.kind === 'label-move' && d.label) {
      dispatch({ type: 'UPDATE_CANVAS_LABEL', payload: { ...d.label, x: snap(d.startX + dx / zoom), y: snap(d.startY + dy / zoom) } })
    }
  }, [dispatch, toCanvas, tabCards, tabLabels, applyBrush])

  const handleMouseUp = useCallback(() => {
    // Commit the pen stroke / eraser edit that was driven through handleMouseMove
    // (see the note there — the z-50 drag overlay owns the whole gesture).
    if (strokeRef.current) {
      const pts = strokeRef.current
      strokeRef.current = null
      setStrokePreview(null)
      setIsDragging(false)
      if (pts.length >= 4) {
        dispatch({ type: 'ADD_CANVAS_STROKE', payload: { id: generateId(), tabId: activeTabId, points: resamplePoints(pts, 4), color: penColor, width: penWidth, createdAt: new Date().toISOString() } })
      }
      return
    }
    if (eraserRef.current) {
      eraserRef.current = false
      setIsDragging(false)
      if (eraseWorkingRef.current) {
        dispatch({ type: 'REPLACE_CANVAS_STROKES', payload: { tabId: activeTabId, strokes: eraseWorkingRef.current } })
      }
      eraseWorkingRef.current = null
      setErasePreview(null)
      return
    }
    if (selectRectRef.current) {
      selectRectRef.current = null
      setSelectRect(null)
      setIsDragging(false)
      return
    }
    if (drawArrowRef.current) {
      const a = drawArrowRef.current
      drawArrowRef.current = null
      setDrawArrow(null)
      setIsDragging(false)
      const len = Math.hypot(a.x2 - a.x1, a.y2 - a.y1)
      if (len >= 8) {
        const fromCard = cardAtPoint(a.x1, a.y1), toCard = cardAtPoint(a.x2, a.y2)
        const arrow: CanvasArrow = { id: generateId(), tabId: activeTabId, x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2, fromCardId: fromCard?.id, toCardId: toCard?.id, createdAt: new Date().toISOString() }
        dispatch({ type: 'ADD_CANVAS_ARROW', payload: arrow })
        setSelectedArrowId(arrow.id)
        setTool('select')
      }
      return
    }
    if (drawGroupRef.current) {
      const g = drawGroupRef.current
      drawGroupRef.current = null
      setDrawGroup(null)
      setIsDragging(false)
      if (g.w >= 40 && g.h >= 40) {
        const group: CanvasGroup = { id: generateId(), tabId: activeTabId, title: 'グループ', x: g.x, y: g.y, width: g.w, height: g.h, createdAt: new Date().toISOString() }
        dispatch({ type: 'ADD_CANVAS_GROUP', payload: group })
        setSelectedGroupId(group.id)
        setTool('select')
      }
      return
    }
    // Arrow endpoint released: attach to a card under it, or detach if on empty canvas
    const d = dragRef.current
    if (d && (d.kind === 'arrow-p1' || d.kind === 'arrow-p2') && d.arrow) {
      const arrow = tabArrowsRef.current.find(a => a.id === d.arrow!.id)
      if (arrow) {
        const ex = d.kind === 'arrow-p1' ? arrow.x1 : arrow.x2
        const ey = d.kind === 'arrow-p1' ? arrow.y1 : arrow.y2
        const card = cardAtPoint(ex, ey)
        const upd = d.kind === 'arrow-p1' ? { fromCardId: card?.id } : { toCardId: card?.id }
        dispatch({ type: 'UPDATE_CANVAS_ARROW', payload: { ...arrow, ...upd } })
      }
    }
    dragRef.current = null
    setIsDragging(false)
  }, [dispatch, activeTabId, cardAtPoint, penColor, penWidth])
  handleMouseUpRef.current = handleMouseUp

  const handleArrowEndDown = useCallback((e: React.MouseEvent, arrow: CanvasArrow, which: 'p1' | 'p2') => {
    if (e.button !== 0) return
    e.stopPropagation()
    if (canvasLockedRef.current) return
    dragRef.current = { kind: which === 'p1' ? 'arrow-p1' : 'arrow-p2', arrow, startMouseX: e.clientX, startMouseY: e.clientY, startX: 0, startY: 0, moved: false }
    setIsDragging(true)
  }, [])

  const handleGroupHeaderDown = useCallback((e: React.MouseEvent, group: CanvasGroup) => {
    if (e.button !== 0) return
    e.stopPropagation()
    setSelectedGroupId(group.id)
    setSelectedIds([])
    setSelectedArrowId(null)
    if (canvasLockedRef.current) return
    const contained = tabCards.filter(c => {
      const cx = c.x + c.width / 2, cy = c.y + c.height / 2
      return cx >= group.x && cx <= group.x + group.width && cy >= group.y && cy <= group.y + group.height
    }).map(c => ({ id: c.id, x: c.x, y: c.y }))
    // Nested groups (fully inside this one) move with it so nesting isn't broken.
    const containedGroups = tabGroups.filter(g =>
      g.id !== group.id &&
      g.x >= group.x && g.y >= group.y &&
      g.x + g.width <= group.x + group.width && g.y + g.height <= group.y + group.height
    )
    // Labels whose center is inside the group move with it too.
    const containedLabels = tabLabels.filter(l => {
      const b = labelBox(l); const cx = b.x + b.w / 2, cy = b.y + b.h / 2
      return cx >= group.x && cx <= group.x + group.width && cy >= group.y && cy <= group.y + group.height
    })
    dragRef.current = { kind: 'group-move', group, groupCards: contained, groupGroups: containedGroups, labels: containedLabels, startMouseX: e.clientX, startMouseY: e.clientY, startX: group.x, startY: group.y, moved: false }
    // Defer the drag overlay until real movement so a double-click on the group title
    // (to rename) isn't swallowed by the overlay (handled in handleMouseMove).
  }, [tabCards, tabGroups, tabLabels])

  const handleGroupResizeDown = useCallback((e: React.MouseEvent, group: CanvasGroup) => {
    if (e.button !== 0) return
    e.stopPropagation()
    if (canvasLockedRef.current) return
    setSelectedGroupId(group.id)
    dragRef.current = { kind: 'group-resize', group, startMouseX: e.clientX, startMouseY: e.clientY, startX: 0, startY: 0, startW: group.width, startH: group.height, moved: false }
    setIsDragging(true)
  }, [])

  const handleLabelDown = useCallback((e: React.MouseEvent, label: CanvasLabel) => {
    if (e.button !== 0) return
    e.stopPropagation()
    setSelectedArrowId(null)
    setSelectedGroupId(null)
    if (e.shiftKey) {
      // toggle this label in/out of the multi-selection (no drag)
      setSelectedLabelIds(prev => prev.includes(label.id) ? prev.filter(x => x !== label.id) : [...prev, label.id])
      return
    }
    // Clicking a member of an existing multi-selection keeps it and drags the whole set.
    const inMulti = selectedLabelIds.includes(label.id) && (selectedLabelIds.length + selectedIds.length > 1)
    const labelSel = inMulti ? selectedLabelIds : [label.id]
    const cardSel = inMulti ? selectedIds : []
    if (!inMulti) { setSelectedLabelIds([label.id]); setSelectedIds([]) }
    if (canvasLockedRef.current) return
    const labels = tabLabels.filter(l => labelSel.includes(l.id))
    const cards = tabCards.filter(c => cardSel.includes(c.id) && !c.locked).map(c => ({ id: c.id, x: c.x, y: c.y }))
    dragRef.current = { kind: 'card', cards, labels, startMouseX: e.clientX, startMouseY: e.clientY, startX: 0, startY: 0, moved: false }
    setIsDragging(true)
  }, [selectedLabelIds, selectedIds, tabLabels, tabCards])

  const handleOverlayDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    // Prevent the browser's native drag-to-select from starting — otherwise the
    // stroke drag highlights the text of note/task cards underneath the overlay
    // instead of drawing.
    e.preventDefault()
    const sel = window.getSelection()
    if (sel && !sel.isCollapsed) sel.removeAllRanges()
    const p = toCanvas(e.clientX, e.clientY)
    if (tool === 'pen') {
      strokeRef.current = [p.x, p.y]
      setStrokePreview([p.x, p.y])
      setIsDragging(true)
    } else if (tool === 'eraser') {
      eraserRef.current = true
      eraseWorkingRef.current = tabStrokesRef.current.map(s => ({ ...s, points: s.points.slice() }))
      setErasePreview(eraseWorkingRef.current)
      applyBrush(p.x, p.y)
      setIsDragging(true)
    }
  }, [tool, toCanvas, applyBrush])

  const handleOverlayMove = useCallback((e: React.MouseEvent) => {
    if (tool === 'eraser') {
      const rect = canvasRef.current?.getBoundingClientRect()
      if (rect) setEraserCursor({ x: e.clientX - rect.left, y: e.clientY - rect.top })
    }
    if (strokeRef.current) {
      const p = toCanvas(e.clientX, e.clientY)
      const pts = strokeRef.current
      const dx = p.x - pts[pts.length - 2], dy = p.y - pts[pts.length - 1]
      if (dx * dx + dy * dy >= 4) { pts.push(p.x, p.y); setStrokePreview(pts.slice()) }
    } else if (eraserRef.current) {
      const p = toCanvas(e.clientX, e.clientY)
      applyBrush(p.x, p.y)
    }
  }, [tool, toCanvas, applyBrush])

  const handleOverlayUp = useCallback(() => {
    if (strokeRef.current) {
      const pts = strokeRef.current
      strokeRef.current = null
      setStrokePreview(null)
      setIsDragging(false)
      if (pts.length >= 4) {
        dispatch({ type: 'ADD_CANVAS_STROKE', payload: { id: generateId(), tabId: activeTabId, points: resamplePoints(pts, 4), color: penColor, width: penWidth, createdAt: new Date().toISOString() } })
      }
    } else if (eraserRef.current) {
      eraserRef.current = false
      setIsDragging(false)
      if (eraseWorkingRef.current) {
        dispatch({ type: 'REPLACE_CANVAS_STROKES', payload: { tabId: activeTabId, strokes: eraseWorkingRef.current } })
      }
      eraseWorkingRef.current = null
      setErasePreview(null)
    }
  }, [dispatch, activeTabId, penColor, penWidth])

  // NOTE: deliberately does NOT end the gesture. When a stroke starts,
  // setIsDragging(true) mounts the z-50 overlay under the stationary cursor and
  // Chromium recomputes hover state, firing a synthetic mouseleave on this pen
  // overlay with the mouse button still down — ending the gesture here killed
  // every stroke at birth (real input only; synthetic-event tests never fire
  // boundary events, which is why this looked fine in the browser preview).
  // Gesture end is owned by the z-50 overlay's handleMouseMove (buttons===0
  // stuck-release check) and handleMouseUp.
  const handleOverlayLeave = useCallback(() => {
    setEraserCursor(null)
  }, [])

  // Duplicate the selected cards (offset by a grid step)
  const duplicateSelection = useCallback(() => {
    if (canvasLockedRef.current || selectedIds.length === 0) return
    const newIds: string[] = []
    tabCards.filter(c => selectedIds.includes(c.id)).forEach(c => {
      const copy: CanvasCard = {
        ...c,
        id: generateId(),
        x: c.x + 24, y: c.y + 24,
        pages: c.pages ? c.pages.map(p => ({ ...p, id: generateId() })) : undefined,
        createdAt: new Date().toISOString(),
      }
      dispatch({ type: 'ADD_CANVAS_CARD', payload: copy })
      newIds.push(copy.id)
    })
    setSelectedIds(newIds)
    setSelectedArrowId(null); setSelectedGroupId(null); setSelectedLabelIds([])
  }, [selectedIds, tabCards, dispatch])

  const copyCards = useCallback(() => {
    const sel = tabCards.filter(c => selectedIds.includes(c.id))
    if (sel.length > 0) {
      clipboardRef.current = sel.map(c => ({ ...c, pages: c.pages?.map(p => ({ ...p })) }))
      internalCopyFreshRef.current = true
    }
  }, [tabCards, selectedIds])

  const pasteCards = useCallback((atX?: number, atY?: number) => {
    if (canvasLockedRef.current) return
    const clip = clipboardRef.current
    if (clip.length === 0) return
    let ox = 24, oy = 24
    if (atX != null && atY != null) {
      ox = atX - Math.min(...clip.map(c => c.x))
      oy = atY - Math.min(...clip.map(c => c.y))
    }
    const newIds: string[] = []
    clip.forEach(c => {
      const copy: CanvasCard = {
        ...c, id: generateId(), tabId: activeTabId, locked: false,
        x: c.x + ox, y: c.y + oy,
        pages: c.pages?.map(p => ({ ...p, id: generateId() })),
        createdAt: new Date().toISOString(),
      }
      dispatch({ type: 'ADD_CANVAS_CARD', payload: copy })
      newIds.push(copy.id)
    })
    setSelectedIds(newIds)
    setSelectedArrowId(null); setSelectedGroupId(null); setSelectedLabelIds([])
  }, [activeTabId, dispatch])

  // Align the selected cards (2+) along an edge or center
  const alignSelection = useCallback((mode: 'left' | 'center-h' | 'right' | 'top' | 'middle-v' | 'bottom') => {
    const cards = tabCards.filter(c => selectedIds.includes(c.id))
    if (cards.length < 2) return
    const minX = Math.min(...cards.map(c => c.x)), maxX = Math.max(...cards.map(c => c.x + c.width))
    const minY = Math.min(...cards.map(c => c.y)), maxY = Math.max(...cards.map(c => c.y + c.height))
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2
    cards.forEach(c => {
      let x = c.x, y = c.y
      if (mode === 'left') x = minX
      else if (mode === 'center-h') x = cx - c.width / 2
      else if (mode === 'right') x = maxX - c.width
      else if (mode === 'top') y = minY
      else if (mode === 'middle-v') y = cy - c.height / 2
      else if (mode === 'bottom') y = maxY - c.height
      dispatch({ type: 'MOVE_CANVAS_CARD', payload: { id: c.id, x, y } })
    })
  }, [tabCards, selectedIds, dispatch])

  // Distribute the selected cards (3+) with equal gaps along an axis
  const distributeSelection = useCallback((axis: 'h' | 'v') => {
    const cards = tabCards.filter(c => selectedIds.includes(c.id))
    if (cards.length < 3) return
    const sorted = [...cards].sort((a, b) => axis === 'h' ? a.x - b.x : a.y - b.y)
    const last = sorted[sorted.length - 1]
    if (axis === 'h') {
      const span = (last.x + last.width) - sorted[0].x
      const gap = (span - sorted.reduce((s, c) => s + c.width, 0)) / (sorted.length - 1)
      let cx = sorted[0].x
      sorted.forEach(c => { dispatch({ type: 'MOVE_CANVAS_CARD', payload: { id: c.id, x: Math.round(cx), y: c.y } }); cx += c.width + gap })
    } else {
      const span = (last.y + last.height) - sorted[0].y
      const gap = (span - sorted.reduce((s, c) => s + c.height, 0)) / (sorted.length - 1)
      let cy = sorted[0].y
      sorted.forEach(c => { dispatch({ type: 'MOVE_CANVAS_CARD', payload: { id: c.id, x: c.x, y: Math.round(cy) } }); cy += c.height + gap })
    }
  }, [tabCards, selectedIds, dispatch])

  const setCardColor = useCallback((color: string | undefined) => {
    tabCards.filter(c => selectedIds.includes(c.id)).forEach(c => dispatch({ type: 'UPDATE_CANVAS_CARD', payload: { ...c, color } }))
  }, [tabCards, selectedIds, dispatch])

  const lockSelection = useCallback((locked: boolean) => {
    tabCards.filter(c => selectedIds.includes(c.id)).forEach(c => dispatch({ type: 'UPDATE_CANVAS_CARD', payload: { ...c, locked } }))
  }, [tabCards, selectedIds, dispatch])

  // Wrap the selected cards + labels (2+ items) in a new group area enclosing them.
  // Dragging the group moves everything whose center is inside it.
  const groupSelection = useCallback(() => {
    if (canvasLockedRef.current) return
    const cards = tabCards.filter(c => selectedIds.includes(c.id))
    const labels = tabLabels.filter(l => selectedLabelIds.includes(l.id))
    if (cards.length + labels.length < 2) return
    const PAD = 28
    const boxes = [
      ...cards.map(c => ({ x: c.x, y: c.y, r: c.x + c.width, b: c.y + c.height })),
      ...labels.map(l => { const lb = labelBox(l); return { x: lb.x, y: lb.y, r: lb.x + lb.w, b: lb.y + lb.h } }),
    ]
    const minX = Math.min(...boxes.map(b => b.x)) - PAD
    const minY = Math.min(...boxes.map(b => b.y)) - PAD
    const maxX = Math.max(...boxes.map(b => b.r)) + PAD
    const maxY = Math.max(...boxes.map(b => b.b)) + PAD
    const group: CanvasGroup = {
      id: generateId(), tabId: activeTabId, title: 'グループ',
      x: minX, y: minY, width: maxX - minX, height: maxY - minY, createdAt: new Date().toISOString(),
    }
    dispatch({ type: 'ADD_CANVAS_GROUP', payload: group })
    setSelectedIds([])
    setSelectedLabelIds([])
    setSelectedGroupId(group.id)
  }, [tabCards, tabLabels, selectedIds, selectedLabelIds, activeTabId, dispatch])

  const handleCardContextMenu = useCallback((e: React.MouseEvent, card: CanvasCard) => {
    e.preventDefault()
    e.stopPropagation()
    if (!selectedIds.includes(card.id)) {
      setSelectedIds([card.id])
      setSelectedArrowId(null); setSelectedGroupId(null); setSelectedLabelIds([])
    }
    setContextMenu({ x: Math.min(e.clientX, window.innerWidth - 230), y: Math.min(e.clientY, window.innerHeight - 300), kind: 'card', canvasX: 0, canvasY: 0 })
  }, [selectedIds])

  // Right-click menus for the other element types, so every element shares the same
  // delete flow (right-click → 削除 → confirm modal). Skipped while view-locked.
  const handleLabelContextMenu = useCallback((e: React.MouseEvent, label: CanvasLabel) => {
    if (canvasLockedRef.current) return
    e.preventDefault(); e.stopPropagation()
    setSelectedLabelIds([label.id]); setSelectedIds([]); setSelectedArrowId(null); setSelectedGroupId(null)
    setContextMenu({ x: Math.min(e.clientX, window.innerWidth - 230), y: Math.min(e.clientY, window.innerHeight - 160), kind: 'label', canvasX: 0, canvasY: 0 })
  }, [])

  const handleArrowContextMenu = useCallback((e: React.MouseEvent, arrow: CanvasArrow) => {
    if (canvasLockedRef.current) return
    e.preventDefault(); e.stopPropagation()
    setSelectedArrowId(arrow.id); setSelectedIds([]); setSelectedLabelIds([]); setSelectedGroupId(null)
    setContextMenu({ x: Math.min(e.clientX, window.innerWidth - 230), y: Math.min(e.clientY, window.innerHeight - 160), kind: 'arrow', canvasX: 0, canvasY: 0 })
  }, [])

  const handleGroupContextMenu = useCallback((e: React.MouseEvent, group: CanvasGroup) => {
    if (canvasLockedRef.current) return
    e.preventDefault(); e.stopPropagation()
    setSelectedGroupId(group.id); setSelectedIds([]); setSelectedLabelIds([]); setSelectedArrowId(null)
    setContextMenu({ x: Math.min(e.clientX, window.innerWidth - 230), y: Math.min(e.clientY, window.innerHeight - 160), kind: 'group', canvasX: 0, canvasY: 0 })
  }, [])

  const handleCanvasContextMenu = useCallback((e: React.MouseEvent) => {
    if (canvasLockedRef.current) return
    const target = e.target as HTMLElement
    if (!target.dataset.canvasBg) return
    e.preventDefault()
    const p = toCanvas(e.clientX, e.clientY)
    setContextMenu({ x: Math.min(e.clientX, window.innerWidth - 230), y: Math.min(e.clientY, window.innerHeight - 340), kind: 'canvas', canvasX: p.x, canvasY: p.y })
  }, [toCanvas])

  // Open the delete-confirmation modal for whatever is currently selected
  // (cards/labels, or a single arrow or group). Every delete path funnels here.
  const requestDeleteSelection = useCallback(() => {
    const nCards = selectedIds.length, nLabels = selectedLabelIds.length
    if (nCards + nLabels > 0) {
      const parts: string[] = []
      if (nCards) parts.push(`カード${nCards}枚`)
      if (nLabels) parts.push(`ラベル${nLabels}個`)
      const ids = [...selectedIds], lids = [...selectedLabelIds]
      setConfirmDelete({
        message: `${parts.join('・')}を削除します。元に戻すには Ctrl+Z。`,
        run: () => {
          ids.forEach(id => dispatch({ type: 'DELETE_CANVAS_CARD', payload: id }))
          lids.forEach(id => dispatch({ type: 'DELETE_CANVAS_LABEL', payload: id }))
          setSelectedIds([]); setSelectedLabelIds([])
        },
      })
    } else if (selectedArrowId) {
      const id = selectedArrowId
      setConfirmDelete({ message: '矢印を削除します。元に戻すには Ctrl+Z。', run: () => { dispatch({ type: 'DELETE_CANVAS_ARROW', payload: id }); setSelectedArrowId(null) } })
    } else if (selectedGroupId) {
      const id = selectedGroupId
      setConfirmDelete({ message: 'グループ枠を削除します（中のカードは残ります）。元に戻すには Ctrl+Z。', run: () => { dispatch({ type: 'DELETE_CANVAS_GROUP', payload: id }); setSelectedGroupId(null) } })
    }
  }, [selectedIds, selectedLabelIds, selectedArrowId, selectedGroupId, dispatch])

  // Keyboard: Delete removes the selection, Ctrl+D duplicates, Escape exits the active tool
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // While the delete-confirmation modal is open, only Enter (confirm) / Escape (cancel) apply.
      if (confirmDelete) {
        if (e.key === 'Enter') { e.preventDefault(); confirmDelete.run(); setConfirmDelete(null) }
        else if (e.key === 'Escape') { e.preventDefault(); setConfirmDelete(null) }
        return
      }
      const ae = document.activeElement as HTMLElement | null
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) {
        // Escape blurs whatever input is focused so the NEXT Escape reaches the
        // canvas-level handler (exit tool / clear selection).
        if (e.key === 'Escape') { ae.blur(); return }
        // Tab inside a タスク下書き title commits the title (blur) and falls
        // THROUGH to the Tab-to-extend branch below — this is what makes
        // type→Tab→type→Tab task-tree sketching work without mouse round-trips.
        if (e.key === 'Tab' && ae.dataset.draftTitle) ae.blur()
        else return
      }
      const mod = e.ctrlKey || e.metaKey
      const locked = canvasLockedRef.current
      if (mod && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return }
      if (mod && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); redo(); return }
      if (mod && (e.key === 'd' || e.key === 'D')) { e.preventDefault(); if (!locked) duplicateSelection(); return }
      if (mod && (e.key === 'g' || e.key === 'G')) {
        e.preventDefault()
        if (!locked) {
          if (e.shiftKey) { if (selectedGroupId) { dispatch({ type: 'DELETE_CANVAS_GROUP', payload: selectedGroupId }); setSelectedGroupId(null) } }
          else groupSelection()
        }
        return
      }
      if (mod && (e.key === 'a' || e.key === 'A')) { e.preventDefault(); setSelectedIds(tabCardsRef.current.map(c => c.id)); setSelectedArrowId(null); setSelectedGroupId(null); setSelectedLabelIds([]); return }
      if (mod && (e.key === 'c' || e.key === 'C')) { e.preventDefault(); copyCards(); return }
      // Ctrl+V is handled by the native 'paste' event listener (so clipboard image
      // data is available); preventing it here would suppress that event.
      if (!locked && (selectedIds.length > 0 || selectedLabelIds.length > 0) && e.key.startsWith('Arrow')) {
        e.preventDefault()
        const base = snapRef.current ? 20 : 1
        const step = e.shiftKey ? base * 10 : base
        const nx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
        const ny = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0
        const sel = new Set(selectedIds)
        tabCardsRef.current.forEach(c => { if (sel.has(c.id) && !c.locked) dispatch({ type: 'MOVE_CANVAS_CARD', payload: { id: c.id, x: c.x + nx, y: c.y + ny } }) })
        const lsel = new Set(selectedLabelIds)
        tabLabelsRef.current.forEach(l => { if (lsel.has(l.id)) dispatch({ type: 'UPDATE_CANVAS_LABEL', payload: { ...l, x: l.x + nx, y: l.y + ny } }) })
        return
      }
      if (e.key === 'Escape') { setTool('select'); setSelectedIds([]); setSelectedArrowId(null); setEditingArrowId(null); setSelectedGroupId(null); setSelectedLabelIds([]); setEditingLabelId(null); setShowAddMenu(false); setContextMenu(null); setConvertOpen(false) }
      if (!locked && (e.key === 'Delete' || e.key === 'Backspace')) {
        if (selectedIds.length > 0 || selectedLabelIds.length > 0 || selectedArrowId || selectedGroupId) {
          e.preventDefault()
          requestDeleteSelection() // every delete path goes through the confirm modal
        }
      }
      // Tab-to-extend: from a single selected card, spawn a new card to the right + arrow,
      // and select the new card so the user can chain Tab presses to draw a flow.
      if (!locked && e.key === 'Tab' && selectedIds.length === 1 && !editingLabelId && !editingArrowId) {
        const src = tabCardsRef.current.find(c => c.id === selectedIds[0])
        if (!src) return
        e.preventDefault()
        const GAP = 80
        // Chaining from a タスク下書き extends the flow with another draft (so
        // Tab-Tab-Tab sketches a task tree); anything else extends with text.
        const extendDraft = src.type === 'taskDraft'
        const newCard: CanvasCard = {
          id: generateId(), tabId: activeTabId, type: extendDraft ? 'taskDraft' : 'text',
          title: '', content: '',
          ...(extendDraft ? {} : { pages: [{ id: generateId(), name: 'ページ1', content: '' }] }),
          x: src.x + src.width + GAP,
          y: src.y,
          width: src.width, height: src.height, createdAt: new Date().toISOString(),
        }
        const arrow: CanvasArrow = {
          id: generateId(), tabId: activeTabId,
          x1: src.x + src.width, y1: src.y + src.height / 2,
          x2: newCard.x, y2: newCard.y + newCard.height / 2,
          fromCardId: src.id, toCardId: newCard.id,
          createdAt: new Date().toISOString(),
        }
        dispatch({ type: 'ADD_CANVAS_CARD', payload: newCard })
        dispatch({ type: 'ADD_CANVAS_ARROW', payload: arrow })
        setSelectedIds([newCard.id]); setSelectedArrowId(null); setSelectedGroupId(null); setSelectedLabelIds([])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedIds, selectedLabelIds, selectedArrowId, selectedGroupId, dispatch, undo, redo, duplicateSelection, copyCards, pasteCards, groupSelection, confirmDelete, requestDeleteSelection])

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    if (canvasLockedRef.current) return
    const target = e.target as HTMLElement
    if (!target.dataset.canvasBg) return
    const vp = viewportRef.current
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return
    const x = (e.clientX - rect.left - vp.x) / vp.zoom
    const y = (e.clientY - rect.top - vp.y) / vp.zoom
    const card: CanvasCard = { id: generateId(), tabId: activeTabId, type: 'text', title: '', content: '', pages: [{ id: generateId(), name: 'ページ1', content: '' }], x, y, width: 360, height: 280, createdAt: new Date().toISOString() }
    dispatch({ type: 'ADD_CANVAS_CARD', payload: card })
    setSelectedIds([card.id])
  }, [dispatch, activeTabId])

  // Create a card from a dropped file (image / PDF / video), centered on the drop point.
  // The bytes are persisted to IndexedDB and referenced by a stable idb: URL so they survive reloads.
  const addFileCard = useCallback((file: File, dropX: number, dropY: number) => {
    // `blob` is what actually gets stored — for TIFF/TGA it's the PNG-converted
    // version; for everything else it's the original file.
    const place = async (type: CanvasCard['type'], w: number, h: number, blob: Blob = file) => {
      const url = await putMedia(blob)
      const card: CanvasCard = {
        id: generateId(), tabId: activeTabId, type, title: file.name, url, content: file.name,
        x: dropX - w / 2, y: dropY - h / 2, width: w, height: h, createdAt: new Date().toISOString()
      }
      dispatch({ type: 'ADD_CANVAS_CARD', payload: card })
      setSelectedIds([card.id])
    }
    if (isImageFile(file)) {
      // Convert TIFF/TGA → PNG first so it both measures and renders.
      normalizeImageBlob(file).then(blob => {
        const HEADER = 34
        const measureUrl = URL.createObjectURL(blob)
        const img = new Image()
        img.onload = () => {
          const max = 360
          const s = Math.min(max / img.naturalWidth, max / img.naturalHeight, 1)
          place('image', Math.max(120, Math.round(img.naturalWidth * s)), Math.max(90, Math.round(img.naturalHeight * s)) + HEADER, blob)
          URL.revokeObjectURL(measureUrl)
        }
        img.onerror = () => { place('image', 320, 260, blob); URL.revokeObjectURL(measureUrl) }
        img.src = measureUrl
      })
    } else if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
      place('pdf', cardTypes.pdf.defaultWidth, cardTypes.pdf.defaultHeight)
    } else if (file.type.startsWith('video/')) {
      place('video', cardTypes.video.defaultWidth, cardTypes.video.defaultHeight)
    } else if (file.type.startsWith('audio/')) {
      place('audio', cardTypes.audio.defaultWidth, cardTypes.audio.defaultHeight)
    } else if (isTextFile(file)) {
      // Markdown / plain-text files become a text card holding their contents.
      file.text().then(text => {
        const w = cardTypes.text.defaultWidth, h = cardTypes.text.defaultHeight
        const card: CanvasCard = {
          id: generateId(), tabId: activeTabId, type: 'text', title: file.name, content: '',
          pages: [{ id: generateId(), name: file.name, content: text }],
          x: dropX - w / 2, y: dropY - h / 2, width: w, height: h, createdAt: new Date().toISOString()
        }
        dispatch({ type: 'ADD_CANVAS_CARD', payload: card })
        setSelectedIds([card.id])
      }).catch(() => { /* ignore unreadable file */ })
    }
  }, [dispatch, activeTabId])

  const handleCanvasDrop = useCallback((e: React.DragEvent) => {
    if (canvasLockedRef.current) return
    const vp = viewportRef.current
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return
    const baseX = (e.clientX - rect.left - vp.x) / vp.zoom
    const baseY = (e.clientY - rect.top - vp.y) / vp.zoom
    // Cross-page reference drop: a Note or Task being dragged in from NotesPage/Gantt becomes
    // a linked card here. We branch on the constella-ref payload BEFORE file handling so a
    // ref-drop never gets accidentally treated as a file.
    const refRaw = e.dataTransfer.getData('application/x-constella-ref')
    if (refRaw) {
      try {
        const ref = JSON.parse(refRaw) as { kind: 'note' | 'task'; id: string }
        if (ref && ref.id) {
          e.preventDefault()
          dragDepthRef.current = 0
          setDragFileOver(false)
          const cfg = cardTypes[ref.kind === 'note' ? 'note' : 'todo']
          const card: CanvasCard = {
            id: generateId(), tabId: activeTabId, type: ref.kind === 'note' ? 'note' : 'todo',
            title: '', content: '',
            ...(ref.kind === 'note' ? { refNoteId: ref.id } : { refTaskId: ref.id }),
            x: baseX - cfg.defaultWidth / 2, y: baseY - 20,
            width: cfg.defaultWidth, height: cfg.defaultHeight,
            createdAt: new Date().toISOString(),
          }
          dispatch({ type: 'ADD_CANVAS_CARD', payload: card })
          setSelectedIds([card.id])
          return
        }
      } catch { /* fall through to file handling */ }
    }
    const files = Array.from(e.dataTransfer.files).filter(
      f => isImageFile(f) || f.type.startsWith('video/') || f.type.startsWith('audio/') || f.type === 'application/pdf' || /\.pdf$/i.test(f.name) || isTextFile(f)
    )
    if (files.length === 0) return
    e.preventDefault()
    dragDepthRef.current = 0
    setDragFileOver(false)
    files.forEach((file, i) => addFileCard(file, baseX + i * 24, baseY + i * 24))
  }, [addFileCard, activeTabId, dispatch])

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (canvasLockedRef.current) return
    if (!Array.from(e.dataTransfer.types).includes('Files')) return
    dragDepthRef.current++
    setDragFileOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setDragFileOver(false)
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    const types = Array.from(e.dataTransfer.types)
    if (types.includes('Files') || types.includes('application/x-constella-ref')) e.preventDefault()
  }, [])

  // Ctrl+V handling: a clipboard image becomes a new image card; otherwise paste
  // the copied cards. Uses the native 'paste' event so clipboard image data is available.
  useEffect(() => {
    const onWindowBlur = () => { internalCopyFreshRef.current = false }
    const onPaste = (e: ClipboardEvent) => {
      const ae = document.activeElement as HTMLElement | null
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return // let inputs handle paste
      if (canvasLockedRef.current) return
      const items = e.clipboardData?.items
      const imgItem = items && Array.from(items).find(i => i.kind === 'file' && i.type.startsWith('image/'))
      const hasCards = clipboardRef.current.length > 0
      // A fresh in-app card copy wins over a stale OS-clipboard image (keeps card duplication working).
      if (imgItem && !(internalCopyFreshRef.current && hasCards)) {
        const file = imgItem.getAsFile()
        if (file) {
          e.preventDefault()
          const rect = canvasRef.current?.getBoundingClientRect()
          const vp = viewportRef.current
          const cx = ((rect?.width ?? 800) / 2 - vp.x) / vp.zoom
          const cy = ((rect?.height ?? 600) / 2 - vp.y) / vp.zoom
          addFileCard(file, cx, cy)
          return
        }
      }
      if (hasCards) { e.preventDefault(); pasteCards() }
    }
    window.addEventListener('paste', onPaste)
    window.addEventListener('blur', onWindowBlur)
    return () => { window.removeEventListener('paste', onPaste); window.removeEventListener('blur', onWindowBlur) }
  }, [addFileCard, pasteCards])

  // Middle-button pan, started in the capture phase so it works even over a card
  // (whose content stops propagation of normal mousedowns).
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const onDown = (e: MouseEvent) => {
      if (e.button !== 1) return
      e.preventDefault()
      const vp = viewportRef.current
      dragRef.current = { kind: 'pan', startMouseX: e.clientX, startMouseY: e.clientY, startX: vp.x, startY: vp.y, moved: false }
      setIsDragging(true)
    }
    el.addEventListener('mousedown', onDown, true)
    return () => el.removeEventListener('mousedown', onDown, true)
  }, [viewMode])

  // `at` (canvas coords) places the card at a specific point — e.g. where the
  // user right-clicked; otherwise it lands in the middle of the viewport.
  function addCard(type: CanvasCard['type'], at?: { x: number; y: number }) {
    if (canvasLockedRef.current) return
    const vp = viewportRef.current
    const rect = canvasRef.current?.getBoundingClientRect()
    const cx = rect ? rect.width / 2 : 400
    const cy = rect ? rect.height / 2 : 300
    const cfg = cardTypes[type]
    const x = at ? at.x - cfg.defaultWidth / 2 : (cx - vp.x) / vp.zoom - cfg.defaultWidth / 2
    const y = at ? at.y : (cy - vp.y) / vp.zoom - 60
    const card: CanvasCard = {
      id: generateId(), tabId: activeTabId, type, title: type === 'text' || type === 'taskDraft' ? '' : cfg.label, content: '',
      ...(type === 'text' ? { pages: [{ id: generateId(), name: 'ページ1', content: '' }] } : {}),
      ...(type === 'web' ? { url: 'https://www.google.com' } : {}),
      x, y,
      width: cfg.defaultWidth, height: cfg.defaultHeight, createdAt: new Date().toISOString()
    }
    dispatch({ type: 'ADD_CANVAS_CARD', payload: card })
    setSelectedIds([card.id])
    setShowAddMenu(false)
  }

  // ── フロー図 → タスク一括変換 ──
  // Every タスク下書き card on the active tab becomes a real Task in the chosen
  // board. Arrows between two drafts define parent→child; an arrow from an
  // existing task-ref card (whose task already lives in the target board) makes
  // the draft a child of that existing task. Converted cards flip in place into
  // live task-ref cards, so the flow diagram becomes a living task map.
  function performDraftConversion() {
    const drafts = tabCards.filter(c => c.type === 'taskDraft')
    if (drafts.length === 0) return
    // Resolve the target board (create one named after the tab if requested).
    let boardId = convertBoardId
    let targetBoardTasks: Task[] = []
    const existing = convertBoards.find(b => b.id === boardId)
    if (!existing) {
      const fallback = state.canvasTabs.find(t => t.id === activeTabId)?.name ?? 'キャンバス'
      const project: Project = {
        id: generateId(), masterProjectId: activeProjectId,
        name: convertNewBoardName.trim() || fallback,
        description: '', tasks: [], createdAt: new Date().toISOString(),
      }
      dispatch({ type: 'ADD_PROJECT', payload: project })
      boardId = project.id
    } else {
      targetBoardTasks = existing.tasks
    }
    const draftIds = new Set(drafts.map(d => d.id))
    const cardById = new Map(tabCards.map(c => [c.id, c]))
    const targetTaskIds = new Set(targetBoardTasks.map(t => t.id))
    // child draft-card id → its parent (another draft card, or an existing task id)
    const parentOf = new Map<string, { draft?: string; existing?: string }>()
    for (const a of tabArrows) {
      if (!a.fromCardId || !a.toCardId || a.fromCardId === a.toCardId) continue
      if (!draftIds.has(a.toCardId) || parentOf.has(a.toCardId)) continue // first arrow wins
      if (draftIds.has(a.fromCardId)) { parentOf.set(a.toCardId, { draft: a.fromCardId }); continue }
      const from = cardById.get(a.fromCardId)
      if (from?.refTaskId && targetTaskIds.has(from.refTaskId)) parentOf.set(a.toCardId, { existing: from.refTaskId })
    }
    // Break cycles among draft→draft links. When a walk revisits a node, THAT
    // node is provably inside the cycle (the chain returned to it), so we drop
    // ITS parent edge — deleting the walk's starting edge instead would orphan
    // drafts that merely descend from a cycle without being part of it.
    for (const id of [...parentOf.keys()]) {
      const seen = new Set([id])
      let cur = parentOf.get(id)?.draft
      while (cur) {
        if (seen.has(cur)) { parentOf.delete(cur); break }
        seen.add(cur)
        cur = parentOf.get(cur)?.draft
      }
    }
    // Parents before children so the tree renders correctly from the first paint.
    const depthOf = (id: string): number => {
      let d = 0
      const seen = new Set<string>()
      let cur = parentOf.get(id)?.draft
      while (cur && !seen.has(cur)) { seen.add(cur); d++; cur = parentOf.get(cur)?.draft }
      return d
    }
    const ordered = [...drafts].sort((a, b) => depthOf(a.id) - depthOf(b.id))
    const idMap = new Map(drafts.map(d => [d.id, generateId()]))
    for (const d of ordered) {
      const endDate = draftWhenToEndDate(d.draftWhen)
      const p = parentOf.get(d.id)
      const parentId = p?.draft ? idMap.get(p.draft) : p?.existing
      const task: Task = {
        id: idMap.get(d.id)!,
        title: (d.title || '').trim() || '無題タスク',
        description: (d.content || '').trim(),
        status: 'todo',
        tags: [],
        createdAt: new Date().toISOString(),
        ...(endDate ? { endDate } : {}),
        ...(parentId ? { parentId } : {}),
      }
      dispatch({ type: 'ADD_TASK', payload: { projectId: boardId, task } })
    }
    // Flip each draft card into a live task-ref card in place — arrows survive,
    // so the flow drawing keeps working as a status map of the new tasks.
    for (const d of drafts) {
      dispatch({
        type: 'UPDATE_CANVAS_CARD',
        payload: { ...d, type: 'todo', refTaskId: idMap.get(d.id)!, draftWhen: undefined, title: (d.title || '').trim() || '無題タスク' },
      })
    }
    setConvertOpen(false)
    setConvertNewBoardName('')
  }

  function addTab() {
    if (!activeProjectId) return
    const tab: CanvasTab = { id: generateId(), projectId: activeProjectId, name: '新しいカテゴリー', createdAt: new Date().toISOString() }
    dispatch({ type: 'ADD_CANVAS_TAB', payload: tab })
    setActiveTabId(tab.id)
    setEditingTabId(tab.id)
    setViewport({ x: 0, y: 0, zoom: 1 })
  }

  function deleteTab(tabId: string) {
    if (projectTabs.length <= 1) return
    const tab = state.canvasTabs.find(t => t.id === tabId)
    const cardCount = state.canvasCards.filter(c => c.tabId === tabId).length
    setConfirmDelete({
      message: `カテゴリー「${tab?.name ?? ''}」${cardCount ? `とカード${cardCount}枚` : ''}を削除します。元に戻すには Ctrl+Z。`,
      run: () => dispatch({ type: 'DELETE_CANVAS_TAB', payload: tabId }),
    })
  }

  function fitToScreen() {
    const cards = tabCards
    if (!cards.length) { setViewport({ x: 0, y: 0, zoom: 1 }); return }
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return
    const pad = 60
    const minX = Math.min(...cards.map(c => c.x)) - pad
    const minY = Math.min(...cards.map(c => c.y)) - pad
    const maxX = Math.max(...cards.map(c => c.x + c.width)) + pad
    const maxY = Math.max(...cards.map(c => c.y + c.height)) + pad
    const w = maxX - minX
    const h = maxY - minY
    const zoom = Math.min(rect.width / w, rect.height / h, 2)
    setViewport({ x: (rect.width - w * zoom) / 2 - minX * zoom, y: (rect.height - h * zoom) / 2 - minY * zoom, zoom })
  }

  // Export the visible canvas as a PNG (cards/text/images; cross-origin web cards render blank).
  const exportImage = useCallback(async () => {
    const el = canvasRef.current
    if (!el) return
    const { toPng } = await import('html-to-image')
    try {
      const dataUrl = await toPng(el, {
        pixelRatio: 2,
        backgroundColor: '#ffffff',
        filter: node => !(node instanceof HTMLElement && node.dataset.exportIgnore === '1'),
      })
      const a = document.createElement('a')
      const tabName = state.canvasTabs.find(t => t.id === activeTabId)?.name || 'canvas'
      a.href = dataUrl
      a.download = `constella-${tabName}.png`
      a.click()
    } catch { /* ignore */ }
  }, [state.canvasTabs, activeTabId])

  return (
    <div className="flex flex-col h-full">
      {/* Category bar — each category is a separate canvas under the active master project */}
      <div className="flex items-center gap-0 px-2 pt-2 bg-slate-100 shrink-0 border-b border-slate-200">
        <div className="flex items-center gap-0 overflow-x-auto min-w-0">
        {projectTabs.map(tab => (
          <div
            key={tab.id}
            className={`group flex items-center gap-1 px-3 py-1.5 text-sm cursor-pointer border-b-2 transition-colors shrink-0 ${
              activeTabId === tab.id
                ? 'border-indigo-400 text-slate-800'
                : 'border-transparent text-slate-500 hover:text-slate-800 hover:border-slate-400'
            }`}
            onClick={() => { setActiveTabId(tab.id); setViewport({ x: 0, y: 0, zoom: 1 }) }}
          >
            {editingTabId === tab.id ? (
              <input
                autoFocus
                type="text"
                value={tab.name}
                onChange={e => dispatch({ type: 'UPDATE_CANVAS_TAB', payload: { ...tab, name: e.target.value } })}
                onBlur={() => setEditingTabId(null)}
                onKeyDown={e => { if (e.key === 'Enter') setEditingTabId(null) }}
                onClick={e => e.stopPropagation()}
                className="bg-transparent border-none outline-none text-sm text-slate-800 w-24"
              />
            ) : (
              <span onDoubleClick={e => { e.stopPropagation(); setEditingTabId(tab.id) }}>{tab.name}</span>
            )}
            {projectTabs.length > 1 && (
              <button
                onClick={e => { e.stopPropagation(); deleteTab(tab.id) }}
                className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-slate-200 text-slate-400 hover:text-rose-500 transition-all"
              >
                <X size={12} />
              </button>
            )}
          </div>
        ))}
        <button onClick={addTab} className="p-1.5 text-slate-400 hover:text-slate-800 transition-colors shrink-0" title="カテゴリー追加">
          <Plus size={14} />
        </button>
        </div>
      </div>

      {/* Toolbar */}
      <div className="h-11 flex items-center justify-between px-4 border-b border-slate-200 bg-slate-50 shrink-0 z-10">
        <div className="flex items-center gap-2">
          {!canvasLocked && (
            <div className="relative" ref={addMenuRef}>
              <button
                onClick={() => setShowAddMenu(!showAddMenu)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-500/10 text-indigo-600 text-sm hover:bg-indigo-500/20 transition-colors"
              >
                <Plus size={16} /> カード追加
              </button>
              {showAddMenu && (
                <div className="absolute left-0 top-10 z-20 bg-slate-100 border border-slate-300 rounded-lg shadow-xl py-1 min-w-[140px]">
                  {(Object.keys(cardTypes) as CanvasCard['type'][]).map(key => {
                    const c = cardTypes[key]
                    const Icon = c.icon
                    return (
                      <button key={key} onClick={() => addCard(key)} className="w-full text-left px-3 py-2 text-sm text-slate-700 hover:bg-slate-200 flex items-center gap-2">
                        <Icon size={14} className={c.text} /> {c.label}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )}
          {canvasLocked && (
            <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500/10 text-amber-600 text-sm">
              <Lock size={15} /> 編集ロック中（閲覧のみ）
            </span>
          )}
          <span className="text-xs text-slate-400 ml-1">{tabCards.length} カード</span>
          {viewMode === 'canvas' && !canvasLocked && (
            <div className="flex items-center gap-0.5 ml-2 pl-2 border-l border-slate-200">
              <button
                onClick={() => setTool('select')}
                title="選択 / 移動"
                className={`p-1.5 rounded transition-colors ${tool === 'select' ? 'bg-indigo-500/15 text-indigo-600' : 'text-slate-500 hover:text-slate-800 hover:bg-slate-100'}`}
              >
                <MousePointer2 size={16} />
              </button>
              <button
                onClick={() => setTool('arrow')}
                title="矢印を引く"
                className={`p-1.5 rounded transition-colors ${tool === 'arrow' ? 'bg-indigo-500/15 text-indigo-600' : 'text-slate-500 hover:text-slate-800 hover:bg-slate-100'}`}
              >
                <ArrowUpRight size={16} />
              </button>
              <button
                onClick={() => setTool('group')}
                title="グループエリアを描く"
                className={`p-1.5 rounded transition-colors ${tool === 'group' ? 'bg-indigo-500/15 text-indigo-600' : 'text-slate-500 hover:text-slate-800 hover:bg-slate-100'}`}
              >
                <Frame size={16} />
              </button>
              <button
                onClick={() => setTool('pen')}
                title="ペン（手書き）"
                className={`p-1.5 rounded transition-colors ${tool === 'pen' ? 'bg-indigo-500/15 text-indigo-600' : 'text-slate-500 hover:text-slate-800 hover:bg-slate-100'}`}
              >
                <Pencil size={16} />
              </button>
              <button
                onClick={() => setTool('eraser')}
                title="消しゴム"
                className={`p-1.5 rounded transition-colors ${tool === 'eraser' ? 'bg-indigo-500/15 text-indigo-600' : 'text-slate-500 hover:text-slate-800 hover:bg-slate-100'}`}
              >
                <Eraser size={16} />
              </button>
              <button
                onClick={() => setTool('label')}
                title="ラベル（テキスト）"
                className={`p-1.5 rounded transition-colors ${tool === 'label' ? 'bg-indigo-500/15 text-indigo-600' : 'text-slate-500 hover:text-slate-800 hover:bg-slate-100'}`}
              >
                <Type size={16} />
              </button>
              <button
                onClick={() => setTool(t => t === 'taskdraft' ? 'select' : 'taskdraft')}
                title="タスク下書きをばらまく（クリックで連続配置 / Escで終了）— 矢印で 親→子 をつなぎ「タスク化」で一括登録"
                className={`p-1.5 rounded transition-colors ${tool === 'taskdraft' ? 'bg-yellow-500/20 text-yellow-700' : 'text-slate-500 hover:text-slate-800 hover:bg-slate-100'}`}
              >
                <ListTodo size={16} />
              </button>
            </div>
          )}
          {viewMode === 'canvas' && !canvasLocked && draftCards.length > 0 && (
            <div className="relative ml-1 pl-2 border-l border-slate-200" ref={convertRef}>
              <button
                onClick={() => {
                  setConvertOpen(v => !v)
                  // Default to the first existing board, or 新規 when none exist.
                  setConvertBoardId(prev => (prev !== '__new__' && convertBoards.some(b => b.id === prev)) ? prev : (convertBoards[0]?.id ?? '__new__'))
                }}
                title="下書きカードをまとめて実タスクに変換（矢印 = 親→子）"
                className="px-2 py-1 rounded-md bg-yellow-400/20 hover:bg-yellow-400/40 text-yellow-800 text-[11px] font-semibold flex items-center gap-1 transition-colors"
              >
                <ListChecks size={14} /> タスク化 {draftCards.length}
              </button>
              {convertOpen && (
                <div className="absolute left-0 top-full mt-1.5 z-40 w-64 bg-white border border-slate-200 rounded-lg shadow-xl p-3 space-y-2">
                  <p className="text-[11px] font-semibold text-slate-700">下書き {draftCards.length}枚 をタスクに変換</p>
                  <div className="space-y-1">
                    <label className="text-[10px] text-slate-500">追加先ボード</label>
                    <select
                      value={convertBoardId}
                      onChange={e => setConvertBoardId(e.target.value)}
                      className="w-full text-[11px] border border-slate-200 rounded-md px-2 py-1 bg-slate-50 outline-none focus:border-yellow-400"
                    >
                      {convertBoards.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                      <option value="__new__">＋ 新しいボードを作成</option>
                    </select>
                    {convertBoardId === '__new__' && (
                      <input
                        type="text"
                        value={convertNewBoardName}
                        onChange={e => setConvertNewBoardName(e.target.value)}
                        placeholder={state.canvasTabs.find(t => t.id === activeTabId)?.name ?? '新しいボード'}
                        className="w-full text-[11px] border border-slate-200 rounded-md px-2 py-1 outline-none focus:border-yellow-400"
                      />
                    )}
                  </div>
                  <p className="text-[10px] text-slate-400 leading-relaxed">
                    矢印（下書き→下書き）は親→子として登録。期日チップは期日(終了日)になります。変換後のカードはタスクと連動します。
                  </p>
                  <div className="flex justify-end gap-1.5 pt-0.5">
                    <button onClick={() => setConvertOpen(false)} className="px-2 py-1 text-[11px] rounded-md text-slate-500 hover:bg-slate-100">キャンセル</button>
                    <button onClick={performDraftConversion} className="px-2.5 py-1 text-[11px] rounded-md bg-yellow-500 hover:bg-yellow-600 text-white font-semibold">変換する</button>
                  </div>
                </div>
              )}
            </div>
          )}
          {viewMode === 'canvas' && !canvasLocked && selectedIds.length + selectedLabelIds.length >= 2 && (
            <div className="flex items-center gap-0.5 ml-1 pl-2 border-l border-slate-200">
              <button onClick={groupSelection} title="グループ化 (Ctrl+G)" className="p-1.5 rounded text-slate-500 hover:text-indigo-600 hover:bg-slate-100"><Frame size={15} /></button>
              {selectedIds.length >= 2 && (
                <>
                  <div className="w-px h-4 bg-slate-200 mx-0.5" />
                  {([
                    ['left', AlignStartVertical, '左揃え'],
                    ['center-h', AlignCenterVertical, '左右中央'],
                    ['right', AlignEndVertical, '右揃え'],
                    ['top', AlignStartHorizontal, '上揃え'],
                    ['middle-v', AlignCenterHorizontal, '上下中央'],
                    ['bottom', AlignEndHorizontal, '下揃え'],
                  ] as const).map(([mode, Icon, label]) => (
                    <button key={mode} onClick={() => alignSelection(mode)} title={label} className="p-1.5 rounded text-slate-500 hover:text-slate-800 hover:bg-slate-100">
                      <Icon size={15} />
                    </button>
                  ))}
                </>
              )}
              {selectedIds.length >= 3 && (
                <>
                  <div className="w-px h-4 bg-slate-200 mx-0.5" />
                  <button onClick={() => distributeSelection('h')} title="左右に均等配置" className="p-1.5 rounded text-slate-500 hover:text-slate-800 hover:bg-slate-100"><AlignHorizontalSpaceBetween size={15} /></button>
                  <button onClick={() => distributeSelection('v')} title="上下に均等配置" className="p-1.5 rounded text-slate-500 hover:text-slate-800 hover:bg-slate-100"><AlignVerticalSpaceBetween size={15} /></button>
                </>
              )}
            </div>
          )}
          {viewMode === 'canvas' && !canvasLocked && selectedIds.length >= 1 && (
            <div className="flex items-center gap-1.5 ml-1 pl-2 border-l border-slate-200">
              <button onClick={() => setCardColor(undefined)} title="色をデフォルトに" className="w-4 h-4 rounded-full border border-slate-300 flex items-center justify-center text-slate-400 hover:text-slate-600 shrink-0"><Ban size={11} /></button>
              <div className="grid grid-cols-8 gap-1">
                {HUE_KEYS.map(h => (
                  <button key={h} onClick={() => setCardColor(h)} title="淡い色" className="w-3.5 h-3.5 rounded-full hover:scale-110 transition-transform" style={{ backgroundColor: COLOR_THEMES[h].dot }} />
                ))}
                {HUE_KEYS.map(h => (
                  <button key={h + '2'} onClick={() => setCardColor(h + '2')} title="濃い色" className="w-3.5 h-3.5 rounded-full hover:scale-110 transition-transform" style={{ backgroundColor: COLOR_THEMES[h + '2'].dot }} />
                ))}
              </div>
              <div className="w-px h-4 bg-slate-200 mx-0.5" />
              <button onClick={() => dispatch({ type: 'BRING_CARD_FRONT', payload: selectedIds })} title="最前面へ" className="p-1.5 rounded text-slate-500 hover:text-slate-800 hover:bg-slate-100"><BringToFront size={15} /></button>
              <button onClick={() => dispatch({ type: 'SEND_CARD_BACK', payload: selectedIds })} title="最背面へ" className="p-1.5 rounded text-slate-500 hover:text-slate-800 hover:bg-slate-100"><SendToBack size={15} /></button>
            </div>
          )}
          {viewMode === 'canvas' && !canvasLocked && selectedArrow && (
            <div className="flex items-center gap-1.5 ml-1 pl-2 border-l border-slate-200">
              <button
                onClick={() => dispatch({ type: 'UPDATE_CANVAS_ARROW', payload: { ...selectedArrow, curved: !selectedArrow.curved } })}
                title={selectedArrow.curved ? '直線にする' : '曲線にする'}
                className={`p-1.5 rounded transition-colors ${selectedArrow.curved ? 'bg-indigo-500/15 text-indigo-600' : 'text-slate-500 hover:text-slate-800 hover:bg-slate-100'}`}
              >
                <Spline size={16} />
              </button>
              <div className="w-px h-4 bg-slate-200 mx-0.5" />
              {ARROW_WIDTHS.map(w => (
                <button
                  key={w}
                  onClick={() => dispatch({ type: 'UPDATE_CANVAS_ARROW', payload: { ...selectedArrow, width: w } })}
                  title="太さ"
                  className={`w-6 h-6 flex items-center justify-center rounded transition-colors ${(selectedArrow.width || ARROW_DEFAULT_WIDTH) === w ? 'bg-indigo-500/15' : 'hover:bg-slate-100'}`}
                >
                  <span className="rounded-full bg-slate-700" style={{ width: w + 2, height: w + 2 }} />
                </button>
              ))}
              <div className="w-px h-4 bg-slate-200 mx-0.5" />
              {ARROW_COLORS.map(c => (
                <button
                  key={c}
                  onClick={() => dispatch({ type: 'UPDATE_CANVAS_ARROW', payload: { ...selectedArrow, color: c } })}
                  title="色"
                  className={`w-4 h-4 rounded-full transition-transform ${(selectedArrow.color || ARROW_DEFAULT_COLOR) === c ? 'ring-2 ring-offset-1 ring-slate-400 scale-110' : ''}`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          )}
          {viewMode === 'canvas' && !canvasLocked && selectedLabel && (
            <div className="flex items-center gap-1.5 ml-1 pl-2 border-l border-slate-200">
              {LABEL_SIZES.map((sz, i) => (
                <button
                  key={sz}
                  onClick={() => dispatch({ type: 'UPDATE_CANVAS_LABEL', payload: { ...selectedLabel, fontSize: sz } })}
                  title="文字サイズ"
                  className={`px-1.5 rounded font-semibold transition-colors ${selectedLabel.fontSize === sz ? 'bg-indigo-500/15 text-indigo-600' : 'text-slate-500 hover:bg-slate-100'}`}
                  style={{ fontSize: 11 + i * 3 }}
                >
                  A
                </button>
              ))}
              <div className="w-px h-4 bg-slate-200 mx-0.5" />
              {PEN_COLORS.map(c => (
                <button
                  key={c}
                  onClick={() => dispatch({ type: 'UPDATE_CANVAS_LABEL', payload: { ...selectedLabel, color: c } })}
                  title="文字色"
                  className={`w-4 h-4 rounded-full transition-transform ${selectedLabel.color === c ? 'ring-2 ring-offset-1 ring-slate-400 scale-110' : ''}`}
                  style={{ backgroundColor: c }}
                />
              ))}
              <button
                onClick={() => { dispatch({ type: 'DELETE_CANVAS_LABEL', payload: selectedLabel.id }); setSelectedLabelIds([]) }}
                title="ラベルを削除"
                className="ml-1 p-1 rounded text-slate-500 hover:text-rose-500 hover:bg-slate-100"
              >
                <Trash2 size={14} />
              </button>
            </div>
          )}
          {viewMode === 'canvas' && !canvasLocked && tool === 'pen' && (
            <div className="flex items-center gap-1.5 ml-1 pl-2 border-l border-slate-200">
              {PEN_COLORS.map(c => (
                <button
                  key={c}
                  onClick={() => setPenColor(c)}
                  title="色"
                  className={`w-4 h-4 rounded-full transition-transform ${penColor === c ? 'ring-2 ring-offset-1 ring-slate-400 scale-110' : ''}`}
                  style={{ backgroundColor: c }}
                />
              ))}
              <div className="w-px h-4 bg-slate-200 mx-0.5" />
              {PEN_WIDTHS.map(w => (
                <button
                  key={w}
                  onClick={() => setPenWidth(w)}
                  title="太さ"
                  className={`w-6 h-6 flex items-center justify-center rounded transition-colors ${penWidth === w ? 'bg-indigo-500/15' : 'hover:bg-slate-100'}`}
                >
                  <span className="rounded-full bg-slate-700" style={{ width: w + 2, height: w + 2 }} />
                </button>
              ))}
            </div>
          )}
          {viewMode === 'canvas' && !canvasLocked && tool === 'eraser' && (
            <div className="flex items-center gap-1.5 ml-1 pl-2 border-l border-slate-200">
              <div className="flex rounded overflow-hidden border border-slate-300">
                <button
                  onClick={() => setEraserMode('partial')}
                  title="部分消し（ブラシ）"
                  className={`px-2 py-0.5 text-[11px] transition-colors ${eraserMode === 'partial' ? 'bg-indigo-500/15 text-indigo-600' : 'text-slate-500 hover:bg-slate-100'}`}
                >
                  部分
                </button>
                <button
                  onClick={() => setEraserMode('stroke')}
                  title="ストロークごと削除"
                  className={`px-2 py-0.5 text-[11px] transition-colors ${eraserMode === 'stroke' ? 'bg-indigo-500/15 text-indigo-600' : 'text-slate-500 hover:bg-slate-100'}`}
                >
                  ストローク
                </button>
              </div>
              <div className="w-px h-4 bg-slate-200 mx-0.5" />
              {ERASER_SIZES.map(sz => (
                <button
                  key={sz}
                  onClick={() => setEraserSize(sz)}
                  title="消しゴムの大きさ"
                  className={`w-7 h-7 flex items-center justify-center rounded transition-colors ${eraserSize === sz ? 'bg-indigo-500/15' : 'hover:bg-slate-100'}`}
                >
                  <span className="rounded-full border border-slate-400" style={{ width: Math.min(sz, 18), height: Math.min(sz, 18) }} />
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={undo}
            disabled={!canUndo}
            className="p-1.5 rounded transition-colors text-slate-500 hover:text-slate-800 hover:bg-slate-100 disabled:text-slate-300 disabled:hover:bg-transparent"
            title="元に戻す (Ctrl+Z)"
          >
            <Undo2 size={16} />
          </button>
          <button
            onClick={redo}
            disabled={!canRedo}
            className="p-1.5 rounded transition-colors text-slate-500 hover:text-slate-800 hover:bg-slate-100 disabled:text-slate-300 disabled:hover:bg-transparent"
            title="やり直す (Ctrl+Shift+Z)"
          >
            <Redo2 size={16} />
          </button>
          <div className="w-px h-5 bg-slate-200 mx-1" />
          <button
            onClick={() => setViewMode('canvas')}
            className={`p-1.5 rounded transition-colors ${viewMode === 'canvas' ? 'bg-slate-100 text-slate-800' : 'text-slate-500 hover:text-slate-800'}`}
            title="キャンバス"
          >
            <LayoutGrid size={16} />
          </button>
          <button
            onClick={() => setViewMode('list')}
            className={`p-1.5 rounded transition-colors ${viewMode === 'list' ? 'bg-slate-100 text-slate-800' : 'text-slate-500 hover:text-slate-800'}`}
            title="リスト"
          >
            <List size={16} />
          </button>
          {viewMode === 'canvas' && (
            <>
              <button
                onClick={() => { setCanvasLocked(l => { const next = !l; if (next) { setTool('select'); setShowAddMenu(false); setContextMenu(null); setEditingLabelId(null); setEditingArrowId(null) } return next }) }}
                className={`p-1.5 rounded transition-colors ${canvasLocked ? 'bg-amber-500/20 text-amber-600' : 'text-slate-500 hover:text-slate-800 hover:bg-slate-100'}`}
                title={canvasLocked ? '編集ロックを解除' : '編集ロック（閲覧のみ・移動/編集を禁止）'}
              >
                {canvasLocked ? <Lock size={16} /> : <Unlock size={16} />}
              </button>
              {!canvasLocked && selectedIds.length > 0 && (
                <button onClick={duplicateSelection} className="p-1.5 rounded hover:bg-slate-100 text-slate-500 hover:text-slate-800" title="複製 (Ctrl+D)"><Copy size={16} /></button>
              )}
              {!canvasLocked && (
                <button
                  onClick={() => setSnapToGrid(s => !s)}
                  className={`p-1.5 rounded transition-colors ${snapToGrid ? 'bg-indigo-500/15 text-indigo-600' : 'text-slate-500 hover:text-slate-800 hover:bg-slate-100'}`}
                  title="グリッドスナップ"
                >
                  <Grid3x3 size={16} />
                </button>
              )}
              <button
                onClick={() => setShowMinimap(s => !s)}
                className={`p-1.5 rounded transition-colors ${showMinimap ? 'bg-indigo-500/15 text-indigo-600' : 'text-slate-500 hover:text-slate-800 hover:bg-slate-100'}`}
                title="ミニマップ"
              >
                <MapIcon size={16} />
              </button>
              <div className="w-px h-5 bg-slate-200 mx-1" />
              <button onClick={() => setViewport(v => ({ ...v, zoom: Math.max(v.zoom * 0.8, 0.1) }))} className="p-1.5 rounded hover:bg-slate-100 text-slate-600"><ZoomOut size={16} /></button>
              <span className="text-xs text-slate-500 w-12 text-center">{Math.round(viewport.zoom * 100)}%</span>
              <button onClick={() => setViewport(v => ({ ...v, zoom: Math.min(v.zoom * 1.25, 5) }))} className="p-1.5 rounded hover:bg-slate-100 text-slate-600"><ZoomIn size={16} /></button>
              <button onClick={fitToScreen} className="p-1.5 rounded hover:bg-slate-100 text-slate-600 ml-1" title="全体表示"><Maximize size={16} /></button>
              <button onClick={exportImage} className="p-1.5 rounded hover:bg-slate-100 text-slate-600" title="表示中のキャンバスをPNG書き出し"><ImageDown size={16} /></button>
              <button onClick={() => {
                // Export the current tab's state (cards/arrows/groups/strokes/labels) as JSON.
                const tabId = activeTabId
                if (!tabId) return
                const payload = {
                  exportedAt: new Date().toISOString(),
                  tab: state.canvasTabs.find(t => t.id === tabId),
                  cards: tabCards,
                  arrows: tabArrows,
                  groups: tabGroups,
                  strokes: tabStrokes,
                  labels: tabLabels,
                }
                const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
                const url = URL.createObjectURL(blob)
                const a = document.createElement('a')
                a.href = url
                a.download = `constella-canvas-${(payload.tab?.name || 'tab').replace(/[\\/:*?"<>|]/g, '_')}-${new Date().toISOString().slice(0,10)}.json`
                document.body.appendChild(a); a.click(); a.remove()
                setTimeout(() => URL.revokeObjectURL(url), 1000)
              }} className="p-1.5 rounded hover:bg-slate-100 text-slate-600" title="現在のタブをJSONで書き出し"><FileDown size={16} /></button>
              <div className="relative">
                <button
                  onClick={() => setCanvasSearchOpen(v => !v)}
                  title="このキャンバス内を検索"
                  className={`p-1.5 rounded transition-colors ${canvasSearchOpen ? 'bg-indigo-500/15 text-indigo-600' : 'text-slate-600 hover:bg-slate-100'}`}
                >
                  <Search size={16} />
                </button>
                {canvasSearchOpen && (
                  <>
                    <div className="fixed inset-0 z-30" onMouseDown={() => setCanvasSearchOpen(false)} />
                    <div
                      className="absolute right-0 top-9 z-40 w-[320px] bg-white border border-slate-200 rounded-lg shadow-xl p-2"
                      onMouseDown={e => e.stopPropagation()}
                    >
                      <input
                        autoFocus
                        type="text"
                        value={canvasSearch}
                        onChange={e => setCanvasSearch(e.target.value)}
                        placeholder="カード/ラベルを検索…"
                        className="w-full text-xs bg-slate-50 border border-slate-200 rounded px-2 py-1 outline-none focus:border-indigo-400 mb-2"
                      />
                      <div className="max-h-[280px] overflow-y-auto">
                        {(() => {
                          const q = canvasSearch.trim().toLowerCase()
                          if (!q) return <p className="text-[10px] text-slate-400 px-1 py-1">タイトル/本文/ページ/ラベル を検索</p>
                          const cardHits = tabCards.filter(c => {
                            const pagesText = (c.pages || []).map(p => `${p.name} ${p.content}`).join(' ')
                            return `${c.title} ${c.content} ${c.url ?? ''} ${pagesText}`.toLowerCase().includes(q)
                          }).slice(0, 30)
                          const labelHits = tabLabels.filter(l => l.text.toLowerCase().includes(q)).slice(0, 10)
                          if (cardHits.length + labelHits.length === 0) return <p className="text-[10px] text-slate-400 px-1 py-1">一致なし</p>
                          return (
                            <>
                              {cardHits.map(c => {
                                const cfg = cardTypes[c.type]
                                const Icon = cfg.icon
                                return (
                                  <button
                                    key={'c:' + c.id}
                                    onClick={() => {
                                      navigateTo(c.x + c.width / 2, c.y + c.height / 2)
                                      setSelectedIds([c.id])
                                      setCanvasSearchOpen(false)
                                    }}
                                    className="w-full text-left px-2 py-1 rounded hover:bg-slate-50 text-[11px] text-slate-700 flex items-center gap-1.5 truncate"
                                  >
                                    <Icon size={11} className={`${cfg.text} shrink-0`} />
                                    <span className="truncate">{c.title || cfg.label}</span>
                                  </button>
                                )
                              })}
                              {labelHits.map(l => (
                                <button
                                  key={'l:' + l.id}
                                  onClick={() => {
                                    navigateTo(l.x, l.y)
                                    setSelectedLabelIds([l.id])
                                    setCanvasSearchOpen(false)
                                  }}
                                  className="w-full text-left px-2 py-1 rounded hover:bg-slate-50 text-[11px] text-slate-700 flex items-center gap-1.5 truncate"
                                >
                                  <Type size={11} className="text-violet-500 shrink-0" />
                                  <span className="truncate">{l.text || '(空のラベル)'}</span>
                                </button>
                              ))}
                            </>
                          )
                        })()}
                      </div>
                    </div>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {!activeTabId ? (
        <div className="flex-1 flex items-center justify-center">
          <button onClick={addTab} className="px-4 py-2 rounded-lg bg-indigo-500/10 text-indigo-600 text-sm hover:bg-indigo-500/20">カテゴリーを作成</button>
        </div>
      ) : viewMode === 'canvas' ? (
        /* Canvas view */
        <div
          ref={canvasRef}
          data-canvas-bg="1"
          className="flex-1 overflow-hidden relative"
          style={{
            cursor: spacePan ? (isDragging ? 'grabbing' : 'grab') : tool === 'label' ? 'text' : (tool === 'arrow' || tool === 'group' || tool === 'pen' || tool === 'eraser') ? 'crosshair' : 'default',
            // Dot grid aligned to the 20px snap grid; dots sit exactly on snap intersections.
            // Hidden when zoomed out enough that cells get too dense to read.
            ...(20 * viewport.zoom >= 8 ? {
              backgroundImage: 'radial-gradient(circle, rgba(100,116,139,0.35) 1px, transparent 1.6px)',
              backgroundSize: `${20 * viewport.zoom}px ${20 * viewport.zoom}px`,
              backgroundPosition: `${viewport.x - 10 * viewport.zoom}px ${viewport.y - 10 * viewport.zoom}px`,
            } : {}),
          }}
          onMouseDown={handleBgMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onDoubleClick={handleDoubleClick}
          onContextMenu={handleCanvasContextMenu}
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleCanvasDrop}
        >
          {/* While dragging/panning, a full-window overlay sits above cards AND the
              video webviews/iframes (which otherwise swallow mousemove/mouseup), so a
              drag always tracks and ends reliably — no more "stuck" pan. */}
          {isDragging && (
            <div
              className="fixed inset-0 select-none"
              style={{ zIndex: 50, cursor: (dragRef.current?.kind === 'pan' || spacePan) ? 'grabbing' : 'default' }}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
            />
          )}
          <div
            data-canvas-bg="1"
            // While the pen/eraser/arrow tool is active, mark the whole card layer
            // click-through (see index.css .canvas-drawing) so the gesture — not a
            // card or its <webview> — receives the mouse. For 'arrow' this is what
            // lets the user drag card→card directly: the mousedown lands on the
            // canvas bg INSIDE the card's bbox, so cardAtPoint attaches both ends.
            className={!canvasLocked && (tool === 'pen' || tool === 'eraser' || tool === 'arrow') ? 'canvas-drawing' : undefined}
            style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`, transformOrigin: '0 0', position: 'absolute', top: 0, left: 0 }}
          >
            {/* Group areas (backmost) */}
            {tabGroups.map((group, gi) => {
              // Nesting depth = how many groups fully contain this one; used to
              // offset the title chip so nested headers don't overlap.
              const ga = group.width * group.height
              const depth = tabGroups.filter((h, hi) => {
                if (h.id === group.id) return false
                const contains = group.x >= h.x && group.y >= h.y && group.x + group.width <= h.x + h.width && group.y + group.height <= h.y + h.height
                if (!contains) return false
                const ha = h.width * h.height
                return ha > ga || (ha === ga && hi < gi)
              }).length
              return (
              <GroupItem
                key={group.id}
                group={group}
                depth={depth}
                selected={selectedGroupId === group.id}
                viewLocked={canvasLocked}
                onHeaderDown={handleGroupHeaderDown}
                onResizeDown={handleGroupResizeDown}
                onUpdate={updates => dispatch({ type: 'UPDATE_CANVAS_GROUP', payload: { ...group, ...updates } })}
                onDelete={() => { dispatch({ type: 'DELETE_CANVAS_GROUP', payload: group.id }); if (selectedGroupId === group.id) setSelectedGroupId(null) }}
                onContextMenu={e => handleGroupContextMenu(e, group)}
              />
              )
            })}
            {drawGroup && drawGroup.w > 0 && (
              <div
                className="absolute rounded-xl border-2 border-dashed border-indigo-400 bg-indigo-500/[0.04] pointer-events-none"
                style={{ left: drawGroup.x, top: drawGroup.y, width: drawGroup.w, height: drawGroup.h }}
              />
            )}

            {/* Arrow layer (behind cards) */}
            <svg className="absolute top-0 left-0 overflow-visible" style={{ width: 1, height: 1, pointerEvents: 'none' }}>
              <defs>
                {/* markerUnits=strokeWidth → arrowhead scales with the line thickness;
                    fill=context-stroke → arrowhead inherits each arrow's own color. */}
                <marker id="arrowhead" markerWidth="5" markerHeight="5" refX="4.2" refY="2.5" orient="auto" markerUnits="strokeWidth">
                  <path d="M0,0 L5,2.5 L0,5 Z" fill="context-stroke" />
                </marker>
              </defs>
              {tabArrows.map(a => {
                const ends = resolveArrowEnds(a, cardsById)
                return (
                  <ArrowItem
                    key={a.id}
                    arrow={a}
                    ends={ends}
                    d={arrowGeometry(ends, a.curved).d}
                    selected={selectedArrowId === a.id}
                    interactive={tool === 'select'}
                    onSelect={() => { setSelectedArrowId(a.id); setSelectedIds([]) }}
                    onEndDown={handleArrowEndDown}
                    onEditLabel={() => { if (canvasLocked) return; setSelectedArrowId(a.id); setEditingArrowId(a.id) }}
                    onContextMenu={e => handleArrowContextMenu(e, a)}
                  />
                )
              })}
              {drawArrow && (
                <line
                  x1={drawArrow.x1} y1={drawArrow.y1} x2={drawArrow.x2} y2={drawArrow.y2}
                  stroke="#6366f1" strokeWidth={2} strokeDasharray="5 4" markerEnd="url(#arrowhead)"
                />
              )}
            </svg>

            {/* Arrow labels (at midpoints) */}
            {tabArrows.map(a => {
              const editing = editingArrowId === a.id
              if (!editing && !a.label) return null
              const g = arrowGeometry(resolveArrowEnds(a, cardsById), a.curved)
              return (
                <div key={a.id} className="absolute" style={{ left: g.lx, top: g.ly, transform: 'translate(-50%, -50%)' }} onMouseDown={ev => ev.stopPropagation()}>
                  {editing ? (
                    <input
                      autoFocus
                      type="text"
                      value={a.label ?? ''}
                      onChange={ev => dispatch({ type: 'UPDATE_CANVAS_ARROW', payload: { ...a, label: ev.target.value } })}
                      onBlur={() => setEditingArrowId(null)}
                      onKeyDown={ev => { if (ev.key === 'Enter' || ev.key === 'Escape') { ev.stopPropagation(); ev.currentTarget.blur() } }}
                      placeholder="ラベル"
                      className="text-[11px] text-center bg-white border border-indigo-400 rounded px-1 outline-none shadow-sm"
                      style={{ width: `${Math.max(4, (a.label?.length ?? 0) + 2)}ch` }}
                    />
                  ) : (
                    <span
                      onDoubleClick={ev => { ev.stopPropagation(); if (canvasLocked) return; setSelectedArrowId(a.id); setEditingArrowId(a.id) }}
                      className="inline-block text-[11px] text-slate-600 bg-white/90 border border-slate-200 rounded px-1 cursor-text whitespace-nowrap shadow-sm"
                    >
                      {a.label}
                    </span>
                  )}
                </div>
              )
            })}

            {tabCards.map(card => (
              <CanvasCardComponent
                key={card.id}
                card={card}
                viewLocked={canvasLocked}
                isSelected={selectedIds.includes(card.id)}
                onHeaderDown={handleCardHeaderDown}
                onResizeDown={handleResizeDown}
                onUpdate={updates => dispatch({ type: 'UPDATE_CANVAS_CARD', payload: { ...card, ...updates } })}
                onSelect={(additive: boolean) => selectCard(card.id, additive)}
                onContextMenu={e => handleCardContextMenu(e, card)}
                pickerOpen={pickerOpenCardId === card.id}
                detachOpen={detachOpenCardId === card.id}
                pickerTab={pickerTab}
                pickerSearch={pickerSearch}
                onOpenPicker={() => { setPickerOpenCardId(card.id); setDetachOpenCardId(null); setPickerTab('existing'); setPickerSearch('') }}
                onClosePicker={() => setPickerOpenCardId(null)}
                onOpenDetach={() => { setDetachOpenCardId(card.id); setPickerOpenCardId(null) }}
                onCloseDetach={() => setDetachOpenCardId(null)}
                onPickerTab={setPickerTab}
                onPickerSearch={setPickerSearch}
              />
            ))}

            {/* Pen strokes (top layer, over cards) */}
            <svg className="absolute top-0 left-0 overflow-visible" style={{ width: 1, height: 1, pointerEvents: 'none' }}>
              {(erasePreview ?? tabStrokes).map(s => (
                <polyline key={s.id} points={strokePointsStr(s.points)} fill="none" stroke={s.color} strokeWidth={s.width} strokeLinejoin="round" strokeLinecap="round" />
              ))}
              {strokePreview && strokePreview.length >= 2 && (
                <polyline points={strokePointsStr(strokePreview)} fill="none" stroke={penColor} strokeWidth={penWidth} strokeLinejoin="round" strokeLinecap="round" />
              )}
            </svg>

            {/* Labels (topmost) */}
            {tabLabels.map(label => (
              <LabelItem
                key={label.id}
                label={label}
                selected={selectedLabelIds.includes(label.id)}
                editing={editingLabelId === label.id}
                viewLocked={canvasLocked}
                onMouseDownMove={handleLabelDown}
                onStartEdit={() => { if (canvasLocked) return; setSelectedLabelIds([label.id]); setEditingLabelId(label.id) }}
                onUpdate={updates => dispatch({ type: 'UPDATE_CANVAS_LABEL', payload: { ...label, ...updates } })}
                onEndEdit={() => setEditingLabelId(null)}
                onContextMenu={e => handleLabelContextMenu(e, label)}
              />
            ))}

            {/* Rubber-band selection rectangle */}
            {selectRect && (selectRect.w > 0 || selectRect.h > 0) && (
              <div
                className="absolute border border-indigo-400 bg-indigo-500/10 pointer-events-none"
                style={{ left: selectRect.x, top: selectRect.y, width: selectRect.w, height: selectRect.h }}
              />
            )}
          </div>

          {/* Pen / eraser input overlay (captures drawing over everything) */}
          {!canvasLocked && (tool === 'pen' || tool === 'eraser') && (
            <div
              className="absolute inset-0 select-none"
              style={{ cursor: tool === 'eraser' ? 'none' : 'crosshair', zIndex: 5 }}
              onMouseDown={handleOverlayDown}
              onMouseMove={handleOverlayMove}
              onMouseUp={handleOverlayUp}
              onMouseLeave={handleOverlayLeave}
            />
          )}

          {/* Eraser brush preview */}
          {tool === 'eraser' && eraserCursor && (
            <div
              className="absolute rounded-full border-2 border-rose-400 bg-rose-400/15 pointer-events-none"
              style={{ left: eraserCursor.x - eraserSize, top: eraserCursor.y - eraserSize, width: eraserSize * 2, height: eraserSize * 2, zIndex: 6 }}
            />
          )}

          {tabCards.length === 0 && !dragFileOver && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <p className="text-slate-400 text-sm">ダブルクリックまたは「カード追加」でカードを配置</p>
            </div>
          )}

          {dragFileOver && (
            <div className="absolute inset-2 flex items-center justify-center pointer-events-none rounded-xl border-2 border-dashed border-teal-500/60 bg-teal-500/5">
              <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-white/90 text-teal-600 text-sm">
                <ImageIcon size={18} />
                ここにファイルをドロップ（画像 / PDF / 動画）
              </div>
            </div>
          )}

          {showMinimap && canvasSize.w > 0 && (
            // Bottom-right minimap is offset above the global floating AI/同期 buttons (App.tsx) so they don't overlap.
            <div className="absolute bottom-20 right-3 z-10" data-export-ignore="1">
              <Minimap cards={tabCards} groups={tabGroups} viewport={viewport} canvasW={canvasSize.w} canvasH={canvasSize.h} onNavigate={navigateTo} />
            </div>
          )}
        </div>
      ) : (
        /* List view */
        <div className="flex-1 overflow-y-auto p-4">
          <div className="max-w-3xl mx-auto space-y-3">
            {tabCards.length === 0 && (
              <p className="text-slate-400 text-sm text-center py-8">カードがありません</p>
            )}
            {tabCards.map(card => (
              <ListCardComponent
                key={card.id}
                card={card}
                onUpdate={updates => dispatch({ type: 'UPDATE_CANVAS_CARD', payload: { ...card, ...updates } })}
                onDelete={() => setConfirmDelete({ message: `「${card.title || cardTypes[card.type].label}」を削除します。元に戻すには Ctrl+Z。`, run: () => dispatch({ type: 'DELETE_CANVAS_CARD', payload: card.id }) })}
              />
            ))}
          </div>
        </div>
      )}

      {contextMenu && (() => {
        const selCards = tabCards.filter(c => selectedIds.includes(c.id))
        const anyUnlocked = selCards.some(c => !c.locked)
        const selArrow = tabArrows.find(a => a.id === selectedArrowId)
        return (
          <>
            <div className="fixed inset-0 z-40" onMouseDown={() => setContextMenu(null)} onContextMenu={e => { e.preventDefault(); setContextMenu(null) }} />
            <div
              className="fixed z-50 bg-white border border-slate-200 rounded-lg shadow-xl py-1 text-sm w-56"
              style={{ left: contextMenu.x, top: contextMenu.y }}
              onMouseDown={e => e.stopPropagation()}
            >
              {contextMenu.kind === 'canvas' ? (
                <>
                  <button onClick={() => { pasteCards(contextMenu.canvasX, contextMenu.canvasY); setContextMenu(null) }} disabled={clipboardRef.current.length === 0} className="w-full text-left px-3 py-1.5 hover:bg-slate-100 text-slate-700 disabled:text-slate-300 disabled:hover:bg-transparent flex items-center justify-between">
                    <span className="flex items-center gap-2"><ClipboardPaste size={14} /> ここに貼り付け</span><kbd className="text-[10px] text-slate-400">Ctrl+V</kbd>
                  </button>
                  <div className="h-px bg-slate-200 my-1" />
                  <div className="px-3 pb-1 pt-0.5 text-[11px] font-medium text-slate-400 flex items-center gap-1.5"><Plus size={12} /> カードを追加</div>
                  <div className="grid grid-cols-2 gap-0.5 px-1 pb-1">
                    {Object.entries(cardTypes).map(([key, cfg]) => {
                      const Icon = cfg.icon
                      return (
                        <button
                          key={key}
                          onClick={() => { addCard(key as CanvasCard['type'], { x: contextMenu.canvasX, y: contextMenu.canvasY }); setContextMenu(null) }}
                          className="flex items-center gap-1.5 px-2 py-1.5 rounded hover:bg-slate-100 text-slate-700 text-left"
                        >
                          <Icon size={14} className={`shrink-0 ${cfg.text}`} />
                          <span className="truncate text-[12px]">{cfg.label}</span>
                        </button>
                      )
                    })}
                  </div>
                </>
              ) : canvasLocked ? (
                <>
                  <button onClick={() => { copyCards(); setContextMenu(null) }} className="w-full text-left px-3 py-1.5 hover:bg-slate-100 text-slate-700 flex items-center justify-between">
                    <span className="flex items-center gap-2"><ClipboardPaste size={14} /> コピー</span><kbd className="text-[10px] text-slate-400">Ctrl+C</kbd>
                  </button>
                  <div className="px-3 py-1.5 text-[11px] text-slate-400 flex items-center gap-2"><Lock size={12} /> 編集はロック中です</div>
                </>
              ) : contextMenu.kind === 'label' ? (
                <>
                  <button onClick={() => { const id = selectedLabelIds[0]; if (id) { setSelectedLabelIds([id]); setEditingLabelId(id) } setContextMenu(null) }} className="w-full text-left px-3 py-1.5 hover:bg-slate-100 text-slate-700 flex items-center gap-2"><Type size={14} /> テキストを編集</button>
                  <div className="h-px bg-slate-200 my-1" />
                  <button onClick={() => { setContextMenu(null); requestDeleteSelection() }} className="w-full text-left px-3 py-1.5 hover:bg-red-50 text-red-600 flex items-center justify-between">
                    <span className="flex items-center gap-2"><Trash2 size={14} /> 削除</span><kbd className="text-[10px] text-red-300">Del</kbd>
                  </button>
                </>
              ) : contextMenu.kind === 'arrow' ? (
                <>
                  <button onClick={() => { if (selectedArrowId) setEditingArrowId(selectedArrowId); setContextMenu(null) }} className="w-full text-left px-3 py-1.5 hover:bg-slate-100 text-slate-700 flex items-center gap-2"><Type size={14} /> ラベルを編集</button>
                  {selArrow && (
                    <button onClick={() => { dispatch({ type: 'UPDATE_CANVAS_ARROW', payload: { ...selArrow, curved: !selArrow.curved } }); setContextMenu(null) }} className="w-full text-left px-3 py-1.5 hover:bg-slate-100 text-slate-700 flex items-center gap-2"><Spline size={14} /> {selArrow.curved ? '直線にする' : '曲線にする'}</button>
                  )}
                  <div className="h-px bg-slate-200 my-1" />
                  <button onClick={() => { setContextMenu(null); requestDeleteSelection() }} className="w-full text-left px-3 py-1.5 hover:bg-red-50 text-red-600 flex items-center justify-between">
                    <span className="flex items-center gap-2"><Trash2 size={14} /> 削除</span><kbd className="text-[10px] text-red-300">Del</kbd>
                  </button>
                </>
              ) : contextMenu.kind === 'group' ? (
                <>
                  <button onClick={() => { setContextMenu(null); requestDeleteSelection() }} className="w-full text-left px-3 py-1.5 hover:bg-red-50 text-red-600 flex items-center justify-between">
                    <span className="flex items-center gap-2"><Trash2 size={14} /> グループを削除</span><kbd className="text-[10px] text-red-300">Del</kbd>
                  </button>
                  <div className="px-3 pt-0.5 pb-1 text-[10px] text-slate-400">枠だけ削除され、中のカードは残ります</div>
                </>
              ) : (
                <>
                  {selCards.length === 1 && selCards[0].stationId && (
                    <>
                      <button onClick={() => { navigate('/mindtrain', { state: { focusStationId: selCards[0].stationId } }); setContextMenu(null) }} className="w-full text-left px-3 py-1.5 hover:bg-slate-100 text-rose-600 flex items-center gap-2"><TrainFront size={14} /> 路線図で開く</button>
                      <div className="h-px bg-slate-200 my-1" />
                    </>
                  )}
                  {selCards.length === 1 && selCards[0].refNoteId && state.notes.some(n => n.id === selCards[0].refNoteId) && (
                    <>
                      <button onClick={() => { navigate('/', { state: { focusNoteId: selCards[0].refNoteId } }); setContextMenu(null) }} className="w-full text-left px-3 py-1.5 hover:bg-slate-100 text-indigo-600 flex items-center gap-2"><FileText size={14} /> ノートで開く</button>
                      <div className="h-px bg-slate-200 my-1" />
                    </>
                  )}
                  {selCards.length === 1 && selCards[0].refTaskId && state.projects.some(p => p.tasks.some(t => t.id === selCards[0].refTaskId)) && (
                    <>
                      <button onClick={() => { navigate(`/projects?taskId=${selCards[0].refTaskId}`); setContextMenu(null) }} className="w-full text-left px-3 py-1.5 hover:bg-slate-100 text-emerald-600 flex items-center gap-2"><CheckSquare size={14} /> タスクで開く</button>
                      <div className="h-px bg-slate-200 my-1" />
                    </>
                  )}
                  <button onClick={() => { duplicateSelection(); setContextMenu(null) }} className="w-full text-left px-3 py-1.5 hover:bg-slate-100 text-slate-700 flex items-center justify-between">
                    <span className="flex items-center gap-2"><Copy size={14} /> 複製</span><kbd className="text-[10px] text-slate-400">Ctrl+D</kbd>
                  </button>
                  <button onClick={() => { copyCards(); setContextMenu(null) }} className="w-full text-left px-3 py-1.5 hover:bg-slate-100 text-slate-700 flex items-center justify-between">
                    <span className="flex items-center gap-2"><ClipboardPaste size={14} /> コピー</span><kbd className="text-[10px] text-slate-400">Ctrl+C</kbd>
                  </button>
                  {selectedIds.length + selectedLabelIds.length >= 2 && (
                    <button onClick={() => { groupSelection(); setContextMenu(null) }} className="w-full text-left px-3 py-1.5 hover:bg-slate-100 text-slate-700 flex items-center justify-between">
                      <span className="flex items-center gap-2"><Frame size={14} /> グループ化</span><kbd className="text-[10px] text-slate-400">Ctrl+G</kbd>
                    </button>
                  )}
                  <button onClick={() => { lockSelection(anyUnlocked); setContextMenu(null) }} className="w-full text-left px-3 py-1.5 hover:bg-slate-100 text-slate-700 flex items-center gap-2">{anyUnlocked ? <><Lock size={14} /> ロック</> : <><Unlock size={14} /> ロック解除</>}</button>
                  <div className="h-px bg-slate-200 my-1" />
                  <button onClick={() => { dispatch({ type: 'BRING_CARD_FRONT', payload: selectedIds }); setContextMenu(null) }} className="w-full text-left px-3 py-1.5 hover:bg-slate-100 text-slate-700 flex items-center gap-2"><BringToFront size={14} /> 最前面へ</button>
                  <button onClick={() => { dispatch({ type: 'SEND_CARD_BACK', payload: selectedIds }); setContextMenu(null) }} className="w-full text-left px-3 py-1.5 hover:bg-slate-100 text-slate-700 flex items-center gap-2"><SendToBack size={14} /> 最背面へ</button>
                  <div className="h-px bg-slate-200 my-1" />
                  <div className="px-3 py-1 flex items-start gap-1.5">
                    <button onClick={() => { setCardColor(undefined); setContextMenu(null) }} title="デフォルト" className="w-4 h-4 rounded-full border border-slate-300 flex items-center justify-center text-slate-400 shrink-0 mt-0.5"><Ban size={11} /></button>
                    <div className="grid grid-cols-8 gap-1">
                      {HUE_KEYS.map(h => (
                        <button key={h} onClick={() => { setCardColor(h); setContextMenu(null) }} title="淡い色" className="w-4 h-4 rounded-full hover:scale-110 transition-transform" style={{ backgroundColor: COLOR_THEMES[h].dot }} />
                      ))}
                      {HUE_KEYS.map(h => (
                        <button key={h + '2'} onClick={() => { setCardColor(h + '2'); setContextMenu(null) }} title="濃い色" className="w-4 h-4 rounded-full hover:scale-110 transition-transform" style={{ backgroundColor: COLOR_THEMES[h + '2'].dot }} />
                      ))}
                    </div>
                  </div>
                  <div className="h-px bg-slate-200 my-1" />
                  <button onClick={() => { setContextMenu(null); requestDeleteSelection() }} className="w-full text-left px-3 py-1.5 hover:bg-red-50 text-red-600 flex items-center justify-between">
                    <span className="flex items-center gap-2"><Trash2 size={14} /> 削除</span><kbd className="text-[10px] text-red-300">Del</kbd>
                  </button>
                </>
              )}
            </div>
          </>
        )
      })()}

      {confirmDelete && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/40"
          onMouseDown={() => setConfirmDelete(null)}
        >
          <div
            className="bg-white rounded-xl shadow-2xl border border-slate-200 p-5 w-[340px] max-w-[90vw]"
            onMouseDown={e => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 text-slate-800 font-semibold mb-2">
              <Trash2 size={16} className="text-red-500" /> 削除の確認
            </div>
            <p className="text-sm text-slate-600 mb-4">{confirmDelete.message}</p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirmDelete(null)}
                className="px-3 py-1.5 rounded-lg text-sm text-slate-600 hover:bg-slate-100 transition-colors"
              >キャンセル</button>
              <button
                autoFocus
                onClick={() => { confirmDelete.run(); setConfirmDelete(null) }}
                className="px-3 py-1.5 rounded-lg text-sm bg-red-500 text-white hover:bg-red-600 transition-colors"
              >削除</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ── File picking for media cards (PDF / image) ── */

async function applyImageFile(file: File | null | undefined, card: CanvasCard, onUpdate: (u: Partial<CanvasCard>) => void) {
  if (!file || !isImageFile(file)) return
  if (isMediaRef(card.url)) deleteMedia(card.url!).catch(() => {})
  const url = await putMedia(await normalizeImageBlob(file)) // TIFF/TGA → PNG
  onUpdate({ url, title: card.title || file.name, content: file.name })
}

function pickFileForCard(card: CanvasCard, onUpdate: (u: Partial<CanvasCard>) => void) {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = card.type === 'pdf' ? '.pdf' : card.type === 'video' ? 'video/*' : card.type === 'audio' ? 'audio/*' : IMAGE_ACCEPT
  input.onchange = async () => {
    const file = input.files?.[0]
    if (!file) return
    if (card.type === 'image') { applyImageFile(file, card, onUpdate); return }
    if (isMediaRef(card.url)) deleteMedia(card.url!).catch(() => {})
    const url = await putMedia(file)
    // Swapping in a different recording invalidates the old time-anchored bookmarks.
    onUpdate({ url, title: card.title || file.name, content: file.name, bookmarks: [] })
  }
  input.click()
}

// Player params that suppress the related-videos / end-screen / annotation clutter
// that YouTube/Vimeo overlay when paused or finished (keeps the card clean).
const YT_PARAMS = 'rel=0&iv_load_policy=3&modestbranding=1&playsinline=1'
const VIMEO_PARAMS = 'title=0&byline=0&portrait=0'

// Convert a YouTube/Vimeo URL to an embeddable URL (null = play as a direct video file)
function videoEmbedUrl(url: string, start?: number): string | null {
  const s = start && start > 0 ? Math.floor(start) : 0
  let m = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/)
  if (m) return `https://www.youtube.com/embed/${m[1]}?${YT_PARAMS}${s ? `&start=${s}` : ''}`
  m = url.match(/vimeo\.com\/(\d+)(?:\/(\w+))?/)
  if (m) return `https://player.vimeo.com/video/${m[1]}?${VIMEO_PARAMS}${m[2] ? `&h=${m[2]}` : ''}${s ? `#t=${s}s` : ''}`
  return null
}

// Extract the streaming-video provider + id from a URL (for the local wrapper).
function parseEmbedRef(url: string): { provider: 'yt' | 'vimeo'; id: string } | null {
  let m = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/)
  if (m) return { provider: 'yt', id: m[1] }
  m = url.match(/vimeo\.com\/(\d+)/)
  if (m) return { provider: 'vimeo', id: m[1] }
  return null
}

// The URL to load in the player. Both YouTube and Vimeo are served from a real http
// origin (Electron: the local 127.0.0.1 server; browser preview: the vite origin) so
// YouTube accepts the embed. YouTube uses our self-contained custom-controls player
// (ytplayer.html) — chrome-less (controls=0), so a captured frame has no UI.
function embedSrc(url: string, start?: number): string | null {
  const ref = parseEmbedRef(url)
  if (!ref) return videoEmbedUrl(url, start)
  const base = (window as unknown as { api?: { embedBase?: string } }).api?.embedBase
  const startQ = start && start > 0 ? `&start=${Math.floor(start)}` : ''
  if (ref.provider === 'yt') {
    // In the browser preview the app is already on an http origin, so a relative URL
    // (served by vite from public/) works; in Electron, point at the local server.
    const origin = IS_ELECTRON && base ? base : ''
    return `${origin}/ytplayer.html?id=${ref.id}${startQ}`
  }
  if (IS_ELECTRON && base) return `${base}/embed?p=vimeo&id=${ref.id}${startQ}`
  return videoEmbedUrl(url, start)
}

// Labels store only an anchor point + fontSize; approximate their rendered box
// (for rubber-band selection and group containment tests).
function labelBox(l: CanvasLabel): { x: number; y: number; w: number; h: number } {
  const w = Math.max(l.fontSize, (l.text.length || 4) * l.fontSize * 0.62) + 8
  const h = l.fontSize * 1.4
  return { x: l.x, y: l.y, w, h }
}

/* ── Arrow (SVG) ── */

const ArrowItem = memo(function ArrowItem({ arrow, ends, d, selected, interactive, onSelect, onEndDown, onEditLabel, onContextMenu }: {
  arrow: CanvasArrow
  ends: { x1: number; y1: number; x2: number; y2: number }
  d: string
  selected: boolean
  interactive: boolean
  onSelect: () => void
  onEndDown: (e: React.MouseEvent, arrow: CanvasArrow, which: 'p1' | 'p2') => void
  onEditLabel: () => void
  onContextMenu: (e: React.MouseEvent) => void
}) {
  const color = arrow.color || '#6366f1'
  const width = arrow.width || 2
  return (
    <g>
      <path
        d={d} fill="none"
        stroke={color} strokeWidth={selected ? width + 1 : width} markerEnd="url(#arrowhead)"
        style={{ pointerEvents: 'none' }}
      />
      {interactive && (
        <path
          d={d} fill="none"
          stroke="transparent" strokeWidth={14}
          style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
          onMouseDown={e => { e.stopPropagation(); onSelect() }}
          onDoubleClick={e => { e.stopPropagation(); onEditLabel() }}
          onContextMenu={e => { e.stopPropagation(); onSelect(); onContextMenu(e) }}
        />
      )}
      {selected && interactive && (
        <>
          <circle cx={ends.x1} cy={ends.y1} r={5} fill={arrow.fromCardId ? '#4f46e5' : '#fff'} stroke="#4f46e5" strokeWidth={2}
            style={{ pointerEvents: 'all', cursor: 'move' }} onMouseDown={e => onEndDown(e, arrow, 'p1')} />
          <circle cx={ends.x2} cy={ends.y2} r={5} fill={arrow.toCardId ? '#4f46e5' : '#fff'} stroke="#4f46e5" strokeWidth={2}
            style={{ pointerEvents: 'all', cursor: 'move' }} onMouseDown={e => onEndDown(e, arrow, 'p2')} />
        </>
      )}
    </g>
  )
})

/* ── Group area ── */

const GroupItem = memo(function GroupItem({ group, selected, viewLocked, depth = 0, onHeaderDown, onResizeDown, onUpdate, onDelete, onContextMenu }: {
  group: CanvasGroup
  selected: boolean
  viewLocked?: boolean
  depth?: number
  onHeaderDown: (e: React.MouseEvent, group: CanvasGroup) => void
  onResizeDown: (e: React.MouseEvent, group: CanvasGroup) => void
  onUpdate: (updates: Partial<CanvasGroup>) => void
  onDelete: () => void
  onContextMenu: (e: React.MouseEvent) => void
}) {
  const [editingTitle, setEditingTitle] = useState(false)
  // Stagger the title chip down by nesting depth so nested groups' headers don't overlap.
  const headerTop = -28 + depth * 26
  return (
    <div
      className={`absolute rounded-xl border-2 bg-slate-400/[0.04] ${selected ? 'border-indigo-400' : 'border-slate-300'}`}
      style={{ left: group.x, top: group.y, width: group.width, height: group.height, pointerEvents: 'none' }}
    >
      <div
        className={`absolute left-0 inline-flex items-center gap-1 px-2 h-6 rounded-md max-w-full select-none ${selected ? 'bg-indigo-500/15' : 'bg-slate-200/80'}`}
        style={{ top: headerTop, cursor: viewLocked ? 'default' : 'grab', pointerEvents: 'auto' }}
        onMouseDown={e => onHeaderDown(e, group)}
        onContextMenu={onContextMenu}
      >
        <Frame size={11} className={`shrink-0 ${selected ? 'text-indigo-600' : 'text-slate-500'}`} />
        {viewLocked && <Lock size={11} className="text-amber-500 shrink-0" />}
        {editingTitle && !viewLocked ? (
          <input
            autoFocus
            type="text"
            value={group.title}
            onChange={e => onUpdate({ title: e.target.value })}
            onMouseDown={e => e.stopPropagation()}
            onBlur={() => setEditingTitle(false)}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === 'Escape') { e.stopPropagation(); e.currentTarget.blur() } }}
            className={`min-w-0 w-28 text-[11px] font-semibold bg-transparent outline-none placeholder-slate-400 ${selected ? 'text-indigo-700' : 'text-slate-600'}`}
            placeholder="グループ名"
          />
        ) : (
          <span
            onDoubleClick={() => { if (!viewLocked) setEditingTitle(true) }}
            title={viewLocked ? undefined : 'ダブルクリックで名前を編集'}
            className={`min-w-0 max-w-[12rem] truncate text-[11px] font-semibold select-none ${group.title ? (selected ? 'text-indigo-700' : 'text-slate-600') : 'text-slate-400 font-normal'}`}
          >
            {group.title || 'グループ名'}
          </span>
        )}
        {selected && !viewLocked && (
          <button
            onMouseDown={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); onDelete() }}
            title="グループ解除 (Ctrl+Shift+G)"
            className="p-0.5 rounded text-slate-500 hover:text-rose-500 shrink-0"
          >
            <Trash2 size={11} />
          </button>
        )}
      </div>
      {selected && !viewLocked && (
        <div
          className="absolute bottom-0 right-0 w-4 h-4 cursor-nwse-resize"
          style={{ pointerEvents: 'auto' }}
          onMouseDown={e => onResizeDown(e, group)}
        >
          <svg className="absolute bottom-1 right-1 text-indigo-400" width="8" height="8" viewBox="0 0 8 8">
            <path d="M7 1L1 7M7 4L4 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </div>
      )}
    </div>
  )
})

/* ── Label (free text annotation) ── */

const LabelItem = memo(function LabelItem({ label, selected, editing, viewLocked, onMouseDownMove, onStartEdit, onUpdate, onEndEdit, onContextMenu }: {
  label: CanvasLabel
  selected: boolean
  editing: boolean
  viewLocked?: boolean
  onMouseDownMove: (e: React.MouseEvent, label: CanvasLabel) => void
  onStartEdit: () => void
  onUpdate: (updates: Partial<CanvasLabel>) => void
  onEndEdit: () => void
  onContextMenu: (e: React.MouseEvent) => void
}) {
  if (editing) {
    return (
      <input
        autoFocus
        type="text"
        value={label.text}
        onChange={e => onUpdate({ text: e.target.value })}
        onMouseDown={e => e.stopPropagation()}
        onBlur={onEndEdit}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === 'Escape') { e.stopPropagation(); e.currentTarget.blur() } }}
        className="absolute bg-white/90 rounded px-1 outline outline-1 outline-indigo-400 leading-snug"
        style={{ left: label.x, top: label.y, fontSize: label.fontSize, color: label.color, fontWeight: 600, width: `${Math.max(4, label.text.length + 2)}ch` }}
      />
    )
  }
  return (
    <div
      onMouseDown={e => onMouseDownMove(e, label)}
      onDoubleClick={e => { e.stopPropagation(); onStartEdit() }}
      onContextMenu={onContextMenu}
      className={`absolute whitespace-nowrap leading-snug px-1 rounded select-none ${viewLocked ? 'cursor-default' : 'cursor-move'} ${selected ? 'outline outline-2 outline-offset-2 outline-indigo-500 bg-indigo-500/10 shadow-sm' : ''}`}
      style={{ left: label.x, top: label.y, fontSize: label.fontSize, color: label.color, fontWeight: 600 }}
    >
      {label.text || <span className="text-slate-400 font-normal">ラベル</span>}
    </div>
  )
})

/* ── Web frame (iframe in browser, <webview> in Electron) ── */

// In Electron a <webview> loads pages in its own WebContents (like a browser tab),
// so sites that forbid <iframe> embedding via X-Frame-Options / CSP frame-ancestors
// (e.g. Google) still display. In the browser preview there is no <webview>, so we
// fall back to an <iframe> (best-effort; the real app is Electron).
const IS_ELECTRON = typeof window !== 'undefined' && !!(window as unknown as { api?: unknown }).api

// A real Chrome UA for the YouTube webview (the default Electron UA can trip
// YouTube's client checks).
const YT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

// Content-reference card types that have an openable source (a page or raw file).
const SOURCE_CARD_TYPES = ['web', 'pdf', 'image', 'video', 'audio'] as const
const EXT_BY_TYPE: Record<string, string> = { pdf: '.pdf', image: '.png', video: '.mp4', audio: '.mp3' }

// A shareable timecode-deep-link for a streaming-video card (YouTube/Vimeo), or null.
function mediaShareUrl(url: string, time: number): string | null {
  const s = Math.max(0, Math.floor(time))
  let m = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/)
  if (m) return `https://youtu.be/${m[1]}${s ? `?t=${s}` : ''}`
  m = url.match(/vimeo\.com\/(\d+)(?:\/(\w+))?/)
  if (m) return `https://vimeo.com/${m[1]}${m[2] ? `/${m[2]}` : ''}${s ? `#t=${s}s` : ''}`
  return null
}

// A sensible filename (with extension) for materializing a card's media on disk.
function cardFileName(card: CanvasCard): string {
  const base = card.content || card.title || 'file'
  return /\.\w{1,5}$/.test(base) ? base : base + (EXT_BY_TYPE[card.type] ?? '')
}

// Open a content card's source: an external page/file for http(s) URLs, or the
// raw stored media for local idb blobs (OS default app in Electron, new tab in browser).
async function openCardSource(card: CanvasCard): Promise<void> {
  const u = card.url
  if (!u) return
  if (isMediaRef(u)) {
    try {
      const api = (window as unknown as { api?: { openFile?: (b: Uint8Array, n: string, t: string) => Promise<void> } }).api
      const blob = await getMediaBlob(u)
      if (!blob) { console.warn('open source: media blob not found for', u); return }
      if (api?.openFile) {
        await api.openFile(new Uint8Array(await blob.arrayBuffer()), cardFileName(card), card.type)
      } else {
        const obj = await resolveMediaUrl(u)
        if (obj) window.open(obj, '_blank')
      }
    } catch (e) { console.warn('open source failed', e) }
  } else if (/^https?:\/\//i.test(u)) {
    // Only follow http(s) sources (the main process also enforces this).
    window.open(u, '_blank', 'noopener')
  } else {
    console.warn('open source: unsupported url scheme', u)
  }
}

export type WebFrameHandle = {
  goBack: () => void
  goForward: () => void
  reload: () => void
  stop: () => void
}
export type WebFrameLoadState = {
  canGoBack: boolean
  canGoForward: boolean
  isLoading: boolean
}

// Type for the subset of Electron <webview> methods we touch — keeps the file
// free of an electron import (renderer-side type is a custom element extension).
type WebviewEl = HTMLElement & {
  getURL?: () => string
  getTitle?: () => string
  canGoBack?: () => boolean
  canGoForward?: () => boolean
  goBack?: () => void
  goForward?: () => void
  reload?: () => void
  stop?: () => void
}

// Translate well-known sharing/edit URLs into embeddable equivalents so iframe
// /webview can render them. Returns the original URL if nothing matches.
// Only http:/https:/about:blank are allowed through — javascript:, data:, vbscript:
// (or anything else that could execute script inside the embedded browsing
// context) are rewritten to about:blank so a hostile paste cannot XSS the app.
export function toEmbedUrl(raw: string): string {
  if (!raw) return raw
  const trimmed = raw.trim()
  if (trimmed === 'about:blank') return trimmed
  if (!/^https?:\/\//i.test(trimmed)) return 'about:blank'
  try {
    const u = new URL(trimmed)
    // Google Workspace — Slides / Sheets / Docs / Forms.
    if (u.hostname === 'docs.google.com') {
      const parts = u.pathname.split('/').filter(Boolean) // ['presentation', 'd', '<ID>', 'edit']
      const kind = parts[0]
      const id = parts[1] === 'd' && parts[2] ? parts[2] : ''
      if (id) {
        if (kind === 'presentation') return `https://docs.google.com/presentation/d/${id}/embed`
        if (kind === 'spreadsheets') return `https://docs.google.com/spreadsheets/d/${id}/preview`
        if (kind === 'document') return `https://docs.google.com/document/d/${id}/preview`
        if (kind === 'forms') return `https://docs.google.com/forms/d/${id}/viewform?embedded=true`
      }
    }
    // YouTube — watch / shorts / youtu.be → /embed.
    if (u.hostname === 'www.youtube.com' || u.hostname === 'youtube.com') {
      const v = u.searchParams.get('v')
      if (v) return `https://www.youtube.com/embed/${v}`
      const m = u.pathname.match(/^\/shorts\/([\w-]{6,})/)
      if (m) return `https://www.youtube.com/embed/${m[1]}`
    }
    if (u.hostname === 'youtu.be') {
      const id = u.pathname.slice(1)
      if (id) return `https://www.youtube.com/embed/${id}`
    }
    // Vimeo — vimeo.com/<id> → player.vimeo.com/video/<id>.
    if (u.hostname === 'vimeo.com') {
      const id = u.pathname.match(/^\/(\d+)/)?.[1]
      if (id) return `https://player.vimeo.com/video/${id}`
    }
    // Spotify open.spotify.com/track/<id> → embed.
    if (u.hostname === 'open.spotify.com') {
      const m = u.pathname.match(/^\/(track|album|playlist|episode|show)\/(\w+)/)
      if (m) return `https://open.spotify.com/embed/${m[1]}/${m[2]}`
    }
    return raw
  } catch {
    return raw
  }
}

export const WebFrame = forwardRef<WebFrameHandle, {
  url: string
  title: string
  className?: string
  style?: React.CSSProperties
  onNavigate?: (url: string, title: string) => void
  onLoadState?: (s: WebFrameLoadState) => void
  /** When true, sharing/edit URLs for Google Docs/Slides/Sheets/YouTube/etc. are
   *  rewritten to embeddable equivalents. Use for Canvas web cards; keep false
   *  for the Research browser where the live editing view is desired. */
  embedMode?: boolean
}>(function WebFrame({ url, title, className, style, onNavigate, onLoadState, embedMode }, ref) {
  const effectiveUrl = embedMode ? toEmbedUrl(url) : url
  const hostRef = useRef<HTMLDivElement>(null)
  // Keep callbacks fresh without re-attaching listeners on every render.
  const onNavigateRef = useRef(onNavigate)
  const onLoadStateRef = useRef(onLoadState)
  onNavigateRef.current = onNavigate
  onLoadStateRef.current = onLoadState
  // iframe fallback (browser preview) — bump key to force a reload of an iframe.
  const [iframeReloadKey, setIframeReloadKey] = useState(0)

  useImperativeHandle(ref, () => {
    const getWv = () => hostRef.current?.querySelector('webview') as WebviewEl | null
    return {
      goBack: () => { getWv()?.goBack?.() },
      goForward: () => { getWv()?.goForward?.() },
      // Electron: native reload. iframe fallback: remount by key bump.
      reload: () => {
        const wv = getWv()
        if (wv?.reload) wv.reload()
        else setIframeReloadKey(k => k + 1)
      },
      stop: () => { getWv()?.stop?.() },
    }
  }, [])

  useEffect(() => {
    if (!IS_ELECTRON) return
    const wv = hostRef.current?.querySelector('webview') as WebviewEl | null
    if (!wv) return
    const fireNav = (u?: string) => {
      const liveUrl = u || wv.getURL?.() || ''
      const liveTitle = wv.getTitle?.() || ''
      if (liveUrl) onNavigateRef.current?.(liveUrl, liveTitle || liveUrl)
    }
    const fireLoadState = (loadingOverride?: boolean) => {
      onLoadStateRef.current?.({
        canGoBack: !!wv.canGoBack?.(),
        canGoForward: !!wv.canGoForward?.(),
        isLoading: loadingOverride ?? false,
      })
    }
    const onNav = (e: Event) => { fireNav((e as Event & { url?: string }).url); fireLoadState() }
    const onNavInPage = (e: Event) => {
      const ev = e as Event & { url?: string; isMainFrame?: boolean }
      if (ev.isMainFrame === false) return
      fireNav(ev.url)
      fireLoadState()
    }
    const onTitle = (e: Event) => {
      const ev = e as Event & { title?: string }
      const liveUrl = wv.getURL?.() || ''
      if (liveUrl) onNavigateRef.current?.(liveUrl, ev.title || liveUrl)
    }
    const onStart = () => fireLoadState(true)
    const onStop = () => fireLoadState(false)
    wv.addEventListener('did-navigate', onNav)
    wv.addEventListener('did-navigate-in-page', onNavInPage)
    wv.addEventListener('page-title-updated', onTitle)
    wv.addEventListener('did-start-loading', onStart)
    wv.addEventListener('did-stop-loading', onStop)
    wv.addEventListener('did-fail-load', onStop)
    return () => {
      wv.removeEventListener('did-navigate', onNav)
      wv.removeEventListener('did-navigate-in-page', onNavInPage)
      wv.removeEventListener('page-title-updated', onTitle)
      wv.removeEventListener('did-start-loading', onStart)
      wv.removeEventListener('did-stop-loading', onStop)
      wv.removeEventListener('did-fail-load', onStop)
    }
  }, [])
  if (IS_ELECTRON) {
    return (
      <div ref={hostRef} className={`relative overflow-hidden ${className ?? ''}`} style={style}>
        {createElement('webview', {
          src: effectiveUrl || 'about:blank',
          style: { position: 'absolute', inset: 0, width: '100%', height: '100%', border: 'none' },
        })}
      </div>
    )
  }
  return (
    <iframe
      key={iframeReloadKey}
      src={effectiveUrl || 'about:blank'}
      className={className}
      style={style}
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      title={title}
    />
  )
})

/* ── PDF card body ── */

const PdfCardBody = memo(function PdfCardBody({ card, onUpdate, fixedHeight, locked }: {
  card: CanvasCard
  onUpdate: (updates: Partial<CanvasCard>) => void
  fixedHeight?: number
  locked?: boolean
}) {
  const src = useMediaUrl(card.url)
  const { dispatch } = useApp()
  // Persist the PDF page/mode as view-only state (no undo step). Stable identity so
  // PdfViewer stays memoized.
  const onPdfState = useCallback(
    (s: { page: number; mode: 'scroll' | 'single' | 'spread' }) => dispatch({ type: 'SET_CANVAS_CARD_VIEW', payload: { id: card.id, pdf: s } }),
    [dispatch, card.id]
  )
  return (
    <div className="flex flex-col flex-1 min-h-0" onMouseDown={e => e.stopPropagation()}>
      {card.url ? (
        src ? (
          <PdfViewer url={src} fixedHeight={fixedHeight} initial={card.pdf} onStateChange={onPdfState} />
        ) : (
          <div className="flex-1 flex items-center justify-center text-slate-400 text-xs" style={fixedHeight ? { height: fixedHeight } : undefined}>読み込み中…</div>
        )
      ) : (
        <button
          onClick={() => { if (!locked) pickFileForCard(card, onUpdate) }}
          disabled={locked}
          className="flex-1 flex flex-col items-center justify-center gap-1.5 text-slate-400 hover:text-rose-600 disabled:hover:text-slate-400 disabled:cursor-default text-xs transition-colors"
          style={fixedHeight ? { height: fixedHeight } : undefined}
        >
          <FileDown size={22} className="opacity-50" />
          {locked ? 'PDF未設定' : 'PDFファイルを選択'}
        </button>
      )}
    </div>
  )
})

/* ── Image card body ── */

const ImageCardBody = memo(function ImageCardBody({ card, onUpdate, fixedHeight, locked }: {
  card: CanvasCard
  onUpdate: (updates: Partial<CanvasCard>) => void
  fixedHeight?: number
  locked?: boolean
}) {
  const [dragOver, setDragOver] = useState(false)
  const [cropping, setCropping] = useState(false)
  const src = useMediaUrl(card.url)

  const onPaste = (e: React.ClipboardEvent) => {
    if (locked) return
    const item = Array.from(e.clipboardData.items).find(i => i.type.startsWith('image/'))
    if (item) { e.preventDefault(); applyImageFile(item.getAsFile(), card, onUpdate) }
  }

  return (
    <div
      className={`group flex flex-1 min-h-0 relative items-center justify-center bg-slate-100 transition-shadow ${dragOver ? 'ring-2 ring-inset ring-teal-500/60' : ''} ${!card.url && !locked ? 'cursor-pointer' : ''}`}
      style={fixedHeight ? { height: fixedHeight } : undefined}
      onMouseDown={e => e.stopPropagation()}
      onPaste={onPaste}
      tabIndex={0}
      onClick={card.url || locked ? undefined : () => pickFileForCard(card, onUpdate)}
      onDragOver={e => { if (locked) return; e.preventDefault(); e.stopPropagation(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={e => { if (locked) return; e.preventDefault(); e.stopPropagation(); setDragOver(false); applyImageFile(e.dataTransfer.files?.[0], card, onUpdate) }}
    >
      {card.url ? (
        src ? (
          <ClippedImage src={src} crop={card.crop} alt={card.content || ''} />
        ) : (
          <div className="text-slate-400 text-[11px]">読み込み中…</div>
        )
      ) : (
        <div className="text-center text-slate-400 text-[11px] px-4 leading-relaxed pointer-events-none">
          <ImageIcon size={26} className="mx-auto mb-1.5 opacity-40" />
          {locked ? '画像未設定' : <>画像を選択<br />ドラッグ&ドロップ / 貼り付け</>}
        </div>
      )}
      {card.url && src && !locked && (
        <button
          onMouseDown={e => e.stopPropagation()}
          onClick={e => { e.stopPropagation(); setCropping(true) }}
          title="表示範囲を切り抜き"
          className="absolute top-1 right-1 flex items-center gap-1 px-2 py-1 rounded bg-white/85 text-slate-600 hover:text-teal-600 text-[11px] shadow opacity-0 group-hover:opacity-100 transition-opacity"
        >
          <Crop size={12} /> 切り抜き
        </button>
      )}
      {cropping && src && (
        <ImageCropper
          src={src}
          initialCrop={card.crop}
          onCancel={() => setCropping(false)}
          onApply={crop => { onUpdate({ crop }); setCropping(false) }}
          onReset={card.crop ? () => { onUpdate({ crop: undefined }); setCropping(false) } : undefined}
        />
      )}
    </div>
  )
})

/* ── Video card body ── */

const VideoCardBody = memo(function VideoCardBody({ card, onUpdate, fixedHeight, locked }: {
  card: CanvasCard
  onUpdate: (updates: Partial<CanvasCard>) => void
  fixedHeight?: number
  locked?: boolean
}) {
  const src = useMediaUrl(card.url)
  const { dispatch } = useApp()
  const videoRef = useRef<HTMLVideoElement>(null)
  const webviewRef = useRef<(HTMLElement & { capturePage?: () => Promise<{ toDataURL(): string }>; executeJavaScript?: (code: string) => Promise<unknown> }) | null>(null)
  const [capturing, setCapturing] = useState(false)
  // Embeds can't be queried/controlled directly, so we seek by remounting the
  // iframe with a start-time param (nonce forces remount even for the same time).
  const [seekStart, setSeekStart] = useState(0)
  const [seekNonce, setSeekNonce] = useState(0)
  const isEmbed = card.url ? videoEmbedUrl(card.url) != null : false
  // Embeds can't be queried/controlled directly, so we seek by reloading at a
  // `start` param (nonce forces a remount even when the time is unchanged).
  // In Electron this resolves to the local-server wrapper URL (real http origin).
  const embed = card.url ? embedSrc(card.url, seekStart) : null

  const seekLocal = (t: number) => { const v = videoRef.current; if (!v) return; v.currentTime = Math.min(t, v.duration || t) }
  const seekEmbed = (t: number) => { setSeekStart(t); setSeekNonce(n => n + 1) }
  const showBar = !locked || (card.bookmarks?.length ?? 0) > 0
  // Frame capture: local <video> via canvas (pristine, no controls); embeds via the
  // Electron webview's capturePage (works in the built app only — a cross-origin
  // iframe can't be read in the browser preview).
  const canGrabFrame = !locked && !!card.url && (!isEmbed || IS_ELECTRON)

  const addFrameCard = async (blob: Blob, w: number, h: number) => {
    const url = await putMedia(blob)
    const aspect = w > 0 && h > 0 ? w / h : 16 / 9
    dispatch({
      type: 'ADD_CANVAS_CARD',
      payload: {
        id: generateId(), tabId: card.tabId, type: 'image',
        title: (card.title || '動画') + ' のフレーム', content: 'frame.png', url,
        x: card.x + card.width + 24, y: card.y,
        width: 320, height: Math.max(120, Math.round(320 / aspect)),
        createdAt: new Date().toISOString(),
      },
    })
  }

  const captureFrame = async () => {
    if (capturing) return
    setCapturing(true)
    try {
      if (!isEmbed) {
        const v = videoRef.current
        if (!v || v.readyState < 2 || !v.videoWidth) return
        const cv = document.createElement('canvas')
        cv.width = v.videoWidth; cv.height = v.videoHeight
        const ctx = cv.getContext('2d'); if (!ctx) return
        ctx.drawImage(v, 0, 0)
        const blob = await new Promise<Blob | null>(res => cv.toBlob(res, 'image/png'))
        if (blob) await addFrameCard(blob, cv.width, cv.height)
      } else {
        const wv = webviewRef.current
        if (wv?.capturePage && wv.executeJavaScript) {
          // YouTube's controls (center button/title/branding) only auto-hide after a few
          // seconds of playback. __captureFrame seeks back + plays muted; we poll
          // __captureReady until the controls have hidden and the playhead is back at the
          // target frame, then capturePage a chrome-less frame and restore.
          try { await wv.executeJavaScript('window.__captureFrame && window.__captureFrame()') } catch { /* ignore */ }
          for (let i = 0; i < 35; i++) {
            await new Promise(res => setTimeout(res, 200))
            let ready = true
            try { ready = !!(await wv.executeJavaScript('window.__captureReady ? window.__captureReady() : true')) } catch { /* ignore */ }
            if (ready) break
          }
          const img = await wv.capturePage()
          wv.executeJavaScript('window.__endCapture && window.__endCapture()').catch(() => { /* ignore */ })
          const blob = await (await fetch(img.toDataURL())).blob()
          const r = wv.getBoundingClientRect()
          await addFrameCard(blob, r.width, r.height)
        }
      }
    } catch (e) { console.warn('frame capture failed', e) } finally { setCapturing(false) }
  }

  if (!card.url) {
    return (
      <div
        className="flex flex-col flex-1 min-h-0 items-center justify-center gap-2 p-3 bg-slate-100"
        style={fixedHeight ? { height: fixedHeight } : undefined}
        onMouseDown={e => e.stopPropagation()}
      >
        {locked ? (
          <div className="flex items-center gap-1.5 text-slate-400 text-xs">
            <Video size={13} />
            動画未設定
          </div>
        ) : (
          <>
            <button
              onClick={() => pickFileForCard(card, onUpdate)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-fuchsia-500/10 border border-fuchsia-500/30 text-fuchsia-600 hover:bg-fuchsia-500/20 transition-colors text-xs"
            >
              <Video size={13} />
              動画を選択
            </button>
            <span className="text-[10px] text-slate-400">または URL を貼り付け</span>
            <input
              type="text"
              placeholder="YouTube / 動画URL"
              onMouseDown={e => e.stopPropagation()}
              onKeyDown={e => { if (e.key === 'Enter' && e.currentTarget.value.trim()) onUpdate({ url: e.currentTarget.value.trim(), content: e.currentTarget.value.trim(), bookmarks: [] }) }}
              className="w-full max-w-[260px] bg-white rounded px-2 py-1 text-[11px] border border-slate-300 outline-none focus:border-fuchsia-400 placeholder-slate-400"
            />
          </>
        )}
      </div>
    )
  }

  return (
    <div
      className="flex flex-col flex-1 min-h-0 bg-white rounded-b-xl overflow-hidden"
      style={fixedHeight ? { height: fixedHeight } : undefined}
      onMouseDown={e => e.stopPropagation()}
    >
      <div className="group relative flex-1 min-h-0 bg-black">
        {embed ? (
          // In Electron, a <webview> loads the embed as a top-level page (like a
          // browser tab), so YouTube/Vimeo videos that reject iframe embedding from
          // the app's file:// origin still play. Browser preview falls back to <iframe>.
          IS_ELECTRON ? (
            // `embed` is the local-server wrapper URL (http origin), whose nested
            // YouTube iframe gets a valid Referer. partition keeps a persistent
            // consent/age session; a real Chrome UA avoids Electron-UA rejections.
            createElement('webview', {
              key: seekNonce,
              ref: webviewRef,
              src: embed,
              partition: 'persist:youtube',
              useragent: YT_UA,
              // Allow programmatic (muted) playback during frame capture without a gesture.
              webpreferences: 'autoplayPolicy=no-user-gesture-required',
              style: { position: 'absolute', inset: 0, width: '100%', height: '100%', border: 'none', background: '#000' },
            })
          ) : (
            <iframe
              key={seekNonce}
              src={embed}
              className="absolute inset-0 w-full h-full border-none"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
              title={card.title || 'video'}
            />
          )
        ) : (
          <video ref={videoRef} src={src} controls className="absolute inset-0 w-full h-full object-contain bg-black" />
        )}
        {!locked && (
          <button
            onClick={() => { if (isMediaRef(card.url)) deleteMedia(card.url!).catch(() => {}); onUpdate({ url: '', content: '', bookmarks: [] }) }}
            title="クリア"
            className="absolute top-1 right-1 p-1 rounded bg-black/50 text-white/80 hover:text-white opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <X size={12} />
          </button>
        )}
      </div>
      {showBar && (
        <div className="px-2 py-1.5 border-t border-slate-200 bg-white flex flex-col gap-1.5">
          {canGrabFrame && (
            <button
              onClick={captureFrame}
              disabled={capturing}
              title="今のフレームを画像カードに書き出します（YouTubeは再生中に押すとUIなしで撮れます）"
              className="self-start flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] border border-fuchsia-500/40 text-fuchsia-600 hover:bg-fuchsia-50 disabled:opacity-30 transition-colors"
            >
              <Camera size={11} /> {capturing ? 'キャプチャ中…' : 'このフレームを画像化'}
            </button>
          )}
          <BookmarkBar
            card={card}
            onUpdate={onUpdate}
            accent="#c026d3"
            getTime={() => { const v = videoRef.current; return (isEmbed || !v || v.readyState < 1) ? null : v.currentTime }}
            onSeek={isEmbed ? seekEmbed : seekLocal}
            canCapture={!isEmbed}
            locked={locked}
            shareUrl={isEmbed ? (t => mediaShareUrl(card.url!, t)) : undefined}
          />
        </div>
      )}
    </div>
  )
})

/* ── Bookmarks & timecode (audio/video) ── */

// seconds → "m:ss" (or "h:mm:ss" past an hour)
const fmtTimecode = (s: number) => {
  if (!isFinite(s) || s < 0) s = 0
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60)
  const mm = h > 0 ? m.toString().padStart(2, '0') : `${m}`
  return `${h > 0 ? `${h}:` : ''}${mm}:${sec.toString().padStart(2, '0')}`
}
// "ss" | "m:ss" | "h:mm:ss" → seconds (null if malformed)
const parseTimecode = (str: string): number | null => {
  const parts = str.trim().split(':').map(p => p.trim())
  if (!parts.length || parts.length > 3 || parts.some(p => !/^\d+$/.test(p))) return null
  const nums = parts.map(Number)
  // Only the leading unit may exceed 59 (e.g. "90" = 90s); "1:75" / "0:99" are invalid.
  if (nums.slice(1).some(n => n >= 60)) return null
  return nums.reduce((acc, n) => acc * 60 + n, 0)
}

// Reusable bookmark + jump-to-time strip for audio/video cards. `getTime` returns
// the live playback position (null when unavailable, e.g. embeds) and `onSeek`
// moves playback. Bookmarks are persisted on the card via onUpdate.
const BookmarkBar = memo(function BookmarkBar({ card, onUpdate, accent, getTime, onSeek, canCapture, locked, shareUrl }: {
  card: CanvasCard
  onUpdate: (updates: Partial<CanvasCard>) => void
  accent: string // hex accent color
  getTime: () => number | null
  onSeek: (t: number) => void
  canCapture: boolean
  locked?: boolean
  shareUrl?: (time: number) => string | null // timecode deep-link builder (streaming video)
}) {
  const bookmarks = card.bookmarks ?? []
  const sorted = [...bookmarks].sort((a, b) => a.time - b.time)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [jump, setJump] = useState('')

  const copyShare = (id: string, url: string) => {
    navigator.clipboard?.writeText(url).then(() => {
      setCopiedId(id)
      setTimeout(() => setCopiedId(c => (c === id ? null : c)), 1200)
    }).catch(() => { /* ignore */ })
  }

  // Nothing to show in a read-only card with no saved positions.
  if (locked && bookmarks.length === 0) return null

  const addAt = (t: number, edit: boolean) => {
    const bm: Bookmark = { id: generateId(), time: Math.max(0, t) }
    onUpdate({ bookmarks: [...bookmarks, bm] })
    if (edit) setEditingId(bm.id)
  }
  const addCurrent = () => { const t = getTime(); if (t != null) addAt(t, true) }
  const setLabel = (id: string, label: string) => onUpdate({ bookmarks: bookmarks.map(b => b.id === id ? { ...b, label } : b) })
  const remove = (id: string) => onUpdate({ bookmarks: bookmarks.filter(b => b.id !== id) })
  const doJump = () => { const t = parseTimecode(jump); if (t != null) onSeek(t) }
  const addJump = () => { const t = parseTimecode(jump); if (t != null) { addAt(t, false); setJump('') } }

  return (
    <div className="shrink-0 flex flex-col gap-1" onMouseDown={e => e.stopPropagation()}>
      {!locked && (
        <div className="flex items-center gap-1">
          {canCapture && (
            <button
              onClick={addCurrent}
              title="現在の再生位置をブックマーク"
              className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] border hover:bg-slate-50 transition-colors shrink-0"
              style={{ color: accent, borderColor: accent + '55' }}
            >
              <BookmarkPlus size={11} /> 現在位置
            </button>
          )}
          <div className="flex items-center gap-0.5 ml-auto shrink-0">
            <Clock size={11} className="text-slate-400" />
            <input
              value={jump}
              onChange={e => setJump(e.target.value)}
              onMouseDown={e => e.stopPropagation()}
              onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') (canCapture ? doJump() : addJump()) }}
              placeholder="0:00"
              className="w-12 bg-white border border-slate-300 rounded px-1 py-0.5 text-[10px] tabular-nums outline-none focus:border-indigo-400"
            />
            <button onClick={doJump} title="この時間へ移動" className="p-0.5 rounded text-slate-400 hover:text-indigo-600 transition-colors">
              <CornerDownLeft size={11} />
            </button>
            {!canCapture && (
              <button onClick={addJump} title="この時間をブックマーク" className="p-0.5 rounded text-slate-400 hover:text-indigo-600 transition-colors">
                <BookmarkPlus size={11} />
              </button>
            )}
          </div>
        </div>
      )}
      {sorted.length > 0 && (
        <div className="flex items-center gap-1 overflow-x-auto pb-0.5">
          {sorted.map(b => {
            const link = shareUrl ? shareUrl(b.time) : null
            return (
            <div
              key={b.id}
              onClick={() => onSeek(b.time)}
              title={`${fmtTimecode(b.time)}${b.label ? ' ' + b.label : ''} へ移動`}
              className="group/bm flex items-center gap-1 shrink-0 rounded px-1.5 py-0.5 bg-slate-100 hover:bg-slate-200 cursor-pointer text-[10px] transition-colors"
            >
              <span className="tabular-nums font-medium" style={{ color: accent }}>{fmtTimecode(b.time)}</span>
              {editingId === b.id && !locked ? (
                <input
                  autoFocus
                  value={b.label ?? ''}
                  placeholder="ラベル"
                  onChange={e => setLabel(b.id, e.target.value)}
                  onMouseDown={e => e.stopPropagation()}
                  onClick={e => e.stopPropagation()}
                  onBlur={() => setEditingId(null)}
                  onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') setEditingId(null) }}
                  className="w-16 bg-white border border-slate-300 rounded px-1 text-[10px] outline-none"
                />
              ) : b.label ? (
                <span
                  className="text-slate-600 max-w-[88px] truncate"
                  onDoubleClick={e => { if (locked) return; e.stopPropagation(); setEditingId(b.id) }}
                >{b.label}</span>
              ) : null}
              {link && (
                <button
                  onClick={e => { e.stopPropagation(); copyShare(b.id, link) }}
                  title="時間指定リンクをコピー"
                  aria-label="時間指定リンクをコピー"
                  className={`transition-opacity ${copiedId === b.id ? 'opacity-100 text-emerald-600' : 'opacity-0 group-hover/bm:opacity-100 text-slate-400 hover:text-indigo-600'}`}
                >{copiedId === b.id ? <Check size={10} /> : <Link2 size={10} />}</button>
              )}
              {!locked && (
                <button
                  onClick={e => { e.stopPropagation(); remove(b.id) }}
                  title="削除"
                  aria-label="ブックマークを削除"
                  className="opacity-0 group-hover/bm:opacity-100 text-slate-400 hover:text-rose-500 transition-opacity"
                ><X size={10} /></button>
              )}
            </div>
            )
          })}
        </div>
      )}
    </div>
  )
})

/* ── Audio card body (waveform + playback via wavesurfer) ── */

const fmtTime = fmtTimecode

const AudioCardBody = memo(function AudioCardBody({ card, onUpdate, fixedHeight, locked }: {
  card: CanvasCard
  onUpdate: (updates: Partial<CanvasCard>) => void
  fixedHeight?: number
  locked?: boolean
}) {
  const src = useMediaUrl(card.url)
  const containerRef = useRef<HTMLDivElement>(null)
  const wsRef = useRef<WaveSurfer | null>(null)
  const [playing, setPlaying] = useState(false)
  const [ready, setReady] = useState(false)
  const [dur, setDur] = useState(0)
  const [cur, setCur] = useState(0)
  const [volume, setVolume] = useState(1) // 0..1, session-local (not persisted)
  const [muted, setMuted] = useState(false)

  // Push volume/mute onto the WaveSurfer instance whenever they change or a new
  // clip becomes ready (a fresh WaveSurfer is created per src, defaulting to 1).
  useEffect(() => {
    if (ready) wsRef.current?.setVolume(muted ? 0 : volume)
  }, [volume, muted, ready])

  useEffect(() => {
    if (!src || !containerRef.current) return
    setReady(false); setPlaying(false); setCur(0); setDur(0)
    const ws = WaveSurfer.create({
      container: containerRef.current,
      url: src,
      height: 'auto',
      waveColor: '#fdba74',
      progressColor: '#ea580c',
      cursorColor: '#9a3412',
      barWidth: 2, barGap: 1, barRadius: 2,
    })
    wsRef.current = ws
    ws.on('ready', () => { setReady(true); setDur(ws.getDuration()) })
    ws.on('timeupdate', (t: number) => setCur(t))
    ws.on('play', () => setPlaying(true))
    ws.on('pause', () => setPlaying(false))
    ws.on('finish', () => setPlaying(false))
    return () => { try { ws.destroy() } catch { /* ignore */ }; wsRef.current = null }
  }, [src])

  if (!card.url) {
    return (
      <div
        className="flex flex-col flex-1 min-h-0 items-center justify-center gap-2 p-3 bg-slate-100"
        style={fixedHeight ? { height: fixedHeight } : undefined}
        onMouseDown={e => e.stopPropagation()}
      >
        {locked ? (
          <div className="flex items-center gap-1.5 text-slate-400 text-xs"><AudioLines size={13} /> 音声未設定</div>
        ) : (
          <button
            onClick={() => pickFileForCard(card, onUpdate)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-orange-500/10 border border-orange-500/30 text-orange-600 hover:bg-orange-500/20 transition-colors text-xs"
          >
            <AudioLines size={13} /> 音声を選択
          </button>
        )}
      </div>
    )
  }

  const seek = (t: number) => {
    const ws = wsRef.current
    if (!ws) return
    const d = ws.getDuration() || 0
    // Move the playhead only; don't force playback (keeps current play/pause state).
    ws.setTime(d ? Math.min(t, d) : t)
  }

  return (
    <div
      className="group flex flex-col flex-1 min-h-0 relative p-3 gap-2 bg-white rounded-b-xl"
      style={fixedHeight ? { height: fixedHeight } : undefined}
      onMouseDown={e => e.stopPropagation()}
    >
      <div className="relative flex-1 min-h-0">
        <div ref={containerRef} className="absolute inset-0" />
        {ready && dur > 0 && (card.bookmarks ?? []).map(b => (
          <div
            key={b.id}
            className="absolute top-0 bottom-0 w-0.5 -translate-x-1/2 pointer-events-none"
            style={{ left: `${Math.min(100, (b.time / dur) * 100)}%`, background: '#c2410ccc' }}
          />
        ))}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button
          onClick={() => wsRef.current?.playPause()}
          disabled={!ready}
          className="p-1.5 rounded-full bg-orange-500 text-white hover:bg-orange-600 disabled:opacity-30 transition-colors shrink-0"
        >
          {playing ? <Pause size={14} /> : <Play size={14} />}
        </button>
        <span className="text-[11px] text-slate-500 tabular-nums">{fmtTime(cur)} / {ready ? fmtTime(dur) : '--:--'}</span>
        {/* Volume — icon toggles mute, slider sets level (0–100%). */}
        <div className="ml-auto flex items-center gap-1 shrink-0">
          <button
            onClick={() => setMuted(m => !m)}
            disabled={!ready}
            title={muted || volume === 0 ? 'ミュート解除' : 'ミュート'}
            className="p-1 rounded text-slate-500 hover:text-orange-600 disabled:opacity-30 transition-colors"
          >
            {muted || volume === 0 ? <VolumeX size={14} /> : <Volume2 size={14} />}
          </button>
          <input
            type="range" min={0} max={1} step={0.01}
            value={muted ? 0 : volume}
            onChange={e => { const v = Number(e.target.value); setVolume(v); setMuted(v === 0) }}
            disabled={!ready}
            title={`音量 ${Math.round((muted ? 0 : volume) * 100)}%`}
            aria-label="音量"
            className="w-16 accent-orange-500 cursor-pointer disabled:opacity-30"
          />
        </div>
        {!locked && (
          <button
            onClick={() => { if (isMediaRef(card.url)) deleteMedia(card.url!).catch(() => {}); onUpdate({ url: '', content: '', bookmarks: [] }) }}
            title="クリア"
            className="p-1 rounded text-slate-400 hover:text-rose-500 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
          >
            <X size={12} />
          </button>
        )}
      </div>
      <BookmarkBar
        card={card}
        onUpdate={onUpdate}
        accent="#ea580c"
        getTime={() => (ready && wsRef.current ? wsRef.current.getCurrentTime() : null)}
        onSeek={seek}
        canCapture
        locked={locked}
      />
    </div>
  )
})

/* ── Sequence card body (multi-image flipbook + onion-skin) ── */

const SequenceCardBody = memo(function SequenceCardBody({ card, onUpdate, fixedHeight, locked }: {
  card: CanvasCard
  onUpdate: (updates: Partial<CanvasCard>) => void
  fixedHeight?: number
  locked?: boolean
}) {
  // Frames are stored as { url, name } objects; normalize defensively so any
  // legacy string[] data still renders before the DB migration kicks in.
  const frames = ((card.frames ?? []) as ({ url: string; name?: string } | string)[])
    .map(f => (typeof f === 'string' ? { url: f, name: '' } : { url: f.url, name: f.name || '' }))
  const framesKey = frames.map(f => f.url).join('|')
  const [urls, setUrls] = useState<string[]>([])
  const [idx, setIdx] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [fps, setFps] = useState(8)
  const [onion, setOnion] = useState(false)
  const [onionOp, setOnionOp] = useState(0.4) // onion-skin ghost strength (0–1)
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const dragIdxRef = useRef<number | null>(null)
  const [dropTarget, setDropTarget] = useState<number | null>(null)
  const n = frames.length
  // Live ref to the latest frames — addFiles awaits putMedia asynchronously, so
  // reading `frames` from the closure would drop concurrent additions (a paste
  // that lands mid-drop overwrites the drop's frames).
  const framesRef = useRef(frames)
  framesRef.current = frames

  // Resolve every frame ref to a usable URL (idb refs → cached object URLs).
  useEffect(() => {
    let alive = true
    Promise.all(frames.map(f => (isMediaRef(f.url) ? resolveMediaUrl(f.url) : Promise.resolve(f.url))))
      .then(us => { if (alive) setUrls(us.map(u => u ?? '')) })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [framesKey])

  useEffect(() => { if (idx >= n && n > 0) setIdx(n - 1) }, [n, idx])

  // Flipbook playback.
  useEffect(() => {
    if (!playing || n < 2) return
    const id = setInterval(() => setIdx(i => (i + 1) % n), Math.max(40, Math.round(1000 / fps)))
    return () => clearInterval(id)
  }, [playing, fps, n])

  const addFiles = async (files: FileList | File[] | null | undefined) => {
    const imgs = [...(files ?? [])].filter(isImageFile)
    if (!imgs.length) return
    // Append new frames at the end, keeping each file's name for the strip.
    const added = await Promise.all(imgs.map(async f => ({ url: await putMedia(await normalizeImageBlob(f)), name: f.name })))
    // Read latest frames from the ref — a concurrent addFiles call may have
    // already appended its own frames, so basing the update on the closure
    // would silently drop them.
    onUpdate({ frames: [...framesRef.current, ...added] })
  }
  const pick = () => inputRef.current?.click()
  const removeAt = (i: number) => { if (i < 0 || i >= n) return; onUpdate({ frames: frames.filter((_, j) => j !== i) }) }
  // Move a frame from one slot to another (drag-and-drop reorder in the strip).
  const reorder = (from: number, to: number) => {
    if (from === to || from < 0 || to < 0 || from >= n || to >= n) return
    const next = [...frames]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    onUpdate({ frames: next })
    setIdx(to)
  }
  const go = (i: number) => { if (n) setIdx((i + n) % n) }
  const onPaste = (e: React.ClipboardEvent) => {
    if (locked) return
    const item = Array.from(e.clipboardData.items).find(i => i.type.startsWith('image/'))
    const file = item?.getAsFile()
    if (file) { e.preventDefault(); addFiles([file]) }
  }

  if (n === 0) {
    return (
      <div
        className={`flex flex-col flex-1 min-h-0 items-center justify-center gap-2 p-3 bg-slate-100 ${dragOver ? 'ring-2 ring-inset ring-indigo-500/60' : ''}`}
        style={fixedHeight ? { height: fixedHeight } : undefined}
        onMouseDown={e => e.stopPropagation()}
        onPaste={onPaste}
        tabIndex={0}
        onDragOver={e => { if (locked) return; e.preventDefault(); e.stopPropagation(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => { if (locked) return; e.preventDefault(); e.stopPropagation(); setDragOver(false); addFiles(e.dataTransfer.files) }}
      >
        <input ref={inputRef} type="file" accept={IMAGE_ACCEPT} multiple className="hidden" onChange={e => { addFiles(e.target.files); e.currentTarget.value = '' }} />
        {locked ? (
          <div className="flex items-center gap-1.5 text-slate-400 text-xs"><Layers size={13} /> 画像未設定</div>
        ) : (
          <button onClick={pick} className="flex flex-col items-center gap-1.5 text-slate-400 hover:text-indigo-600 text-xs transition-colors">
            <Layers size={24} className="opacity-50" />
            画像を複数選択<br />ドラッグ&ドロップ / 貼り付け
          </button>
        )}
      </div>
    )
  }

  return (
    <div
      className={`flex flex-col flex-1 min-h-0 bg-white rounded-b-xl overflow-hidden ${dragOver ? 'ring-2 ring-inset ring-indigo-500/60' : ''}`}
      style={fixedHeight ? { height: fixedHeight } : undefined}
      onMouseDown={e => e.stopPropagation()}
      onPaste={onPaste}
      tabIndex={0}
      onDragOver={e => { if (locked) return; e.preventDefault(); e.stopPropagation(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={e => { if (locked) return; e.preventDefault(); e.stopPropagation(); setDragOver(false); addFiles(e.dataTransfer.files) }}
    >
      <input ref={inputRef} type="file" accept={IMAGE_ACCEPT} multiple className="hidden" onChange={e => { addFiles(e.target.files); e.currentTarget.value = '' }} />
      <div className="relative flex-1 min-h-0 bg-black/90 flex items-center justify-center overflow-hidden">
        {/* Onion-skin: faint ghosts of the previous frames sit behind the
            current one. The current frame stays on top and prominent — its
            opacity only dips a little (floor 0.72) as the onion strength rises,
            so it never washes out the way it used to. */}
        {onion && idx - 2 >= 0 && urls[idx - 2] && <img src={urls[idx - 2]} alt="" className="absolute inset-0 w-full h-full object-contain pointer-events-none" style={{ opacity: onionOp * 0.55 }} />}
        {onion && idx - 1 >= 0 && urls[idx - 1] && <img src={urls[idx - 1]} alt="" className="absolute inset-0 w-full h-full object-contain pointer-events-none" style={{ opacity: onionOp }} />}
        {urls[idx]
          ? <img src={urls[idx]} alt="" className="absolute inset-0 w-full h-full object-contain" style={{ opacity: onion ? Math.max(0.72, 1 - onionOp * 0.3) : 1 }} draggable={false} />
          : <span className="text-slate-500 text-[11px]">読み込み中…</span>}
      </div>
      <div className="shrink-0 border-t border-slate-200 bg-slate-50 px-2 py-1 flex flex-col gap-1">
        <div className="flex items-center gap-1.5">
          <button onClick={() => setPlaying(p => !p)} disabled={n < 2} className="p-1 rounded-full bg-indigo-500 text-white hover:bg-indigo-600 disabled:opacity-30 transition-colors shrink-0">
            {playing ? <Pause size={13} /> : <Play size={13} />}
          </button>
          <button onClick={() => go(idx - 1)} className="p-0.5 text-slate-500 hover:text-slate-800 shrink-0"><SkipBack size={13} /></button>
          <input type="range" min={0} max={n - 1} value={idx} onChange={e => setIdx(parseInt(e.target.value))} className="flex-1 h-1 accent-indigo-500 cursor-pointer" />
          <button onClick={() => go(idx + 1)} className="p-0.5 text-slate-500 hover:text-slate-800 shrink-0"><SkipForward size={13} /></button>
          <span className="text-[11px] text-slate-500 tabular-nums shrink-0">{idx + 1}/{n}</span>
          {frames[idx]?.name && <span className="text-[10px] text-slate-400 truncate max-w-[96px] shrink" title={frames[idx].name}>{frames[idx].name}</span>}
        </div>
        {!locked && (
          <div className="flex items-center gap-2 text-[10px] text-slate-500">
            <label className="flex items-center gap-1">
              <input type="number" min={1} max={30} value={fps} onChange={e => setFps(Math.max(1, Math.min(30, parseInt(e.target.value) || 1)))} onMouseDown={e => e.stopPropagation()} className="w-9 bg-white border border-slate-300 rounded px-1 py-px text-center tabular-nums outline-none focus:border-indigo-400" /> fps
            </label>
            <button onClick={() => setOnion(o => !o)} title="前のコマを薄く重ねる" className={`flex items-center gap-1 px-1.5 py-0.5 rounded border transition-colors ${onion ? 'bg-indigo-500/15 border-indigo-300 text-indigo-600' : 'border-slate-300 hover:bg-slate-100'}`}>
              <Layers size={11} /> オニオン
            </button>
            {onion && (
              <input
                type="range" min={0.1} max={0.9} step={0.05} value={onionOp}
                onChange={e => setOnionOp(parseFloat(e.target.value))}
                onMouseDown={e => e.stopPropagation()}
                title={`オニオンの濃さ ${Math.round(onionOp * 100)}%`}
                className="w-14 h-1 accent-indigo-500 cursor-pointer"
              />
            )}
            <button onClick={pick} className="ml-auto flex items-center gap-1 px-1.5 py-0.5 rounded border border-slate-300 hover:bg-slate-100"><Plus size={11} /> 追加</button>
          </div>
        )}
      </div>
      {/* Frame list: one readable row per frame (order + thumbnail + full name).
          Click a row to jump to it, drag to reorder, × to remove. */}
      {n >= 1 && (
        <div className="shrink-0 max-h-[50%] overflow-y-auto border-t border-slate-200 bg-slate-50">
          {frames.map((f, i) => (
            <div
              key={i}
              draggable={!locked}
              onClick={() => setIdx(i)}
              onDragStart={e => { if (locked) return; dragIdxRef.current = i; e.dataTransfer.effectAllowed = 'move' }}
              onDragOver={e => { if (locked || dragIdxRef.current === null) return; e.preventDefault(); e.stopPropagation(); setDropTarget(i) }}
              onDrop={e => { if (locked) return; e.preventDefault(); e.stopPropagation(); if (dragIdxRef.current !== null) reorder(dragIdxRef.current, i); dragIdxRef.current = null; setDropTarget(null) }}
              onDragEnd={() => { dragIdxRef.current = null; setDropTarget(null) }}
              title={f.name || `フレーム ${i + 1}`}
              className={`flex items-center gap-1.5 px-1.5 py-1 border-b border-slate-100 last:border-b-0 ${locked ? 'cursor-pointer' : 'cursor-grab active:cursor-grabbing'} ${i === idx ? 'bg-indigo-100 text-indigo-700' : 'text-slate-600 hover:bg-slate-100'} ${dropTarget === i ? 'ring-1 ring-inset ring-indigo-400' : ''}`}
            >
              {!locked && <GripVertical size={12} className="shrink-0 opacity-40" />}
              <span className="shrink-0 w-4 text-[11px] tabular-nums text-center opacity-70">{i + 1}</span>
              <div className="shrink-0 w-8 h-6 rounded bg-black overflow-hidden ring-1 ring-slate-300">
                {urls[i] && <img src={urls[i]} alt="" className="w-full h-full object-cover" draggable={false} />}
              </div>
              <span className="flex-1 min-w-0 truncate text-[11px] leading-tight">{f.name || `（名前なし）フレーム ${i + 1}`}</span>
              {!locked && (
                <button onClick={e => { e.stopPropagation(); removeAt(i) }} title="このコマを削除" className="shrink-0 p-0.5 rounded text-slate-400 hover:text-rose-500"><X size={12} /></button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
})

/* ── Minimap ── */

const Minimap = memo(function Minimap({ cards, groups, viewport, canvasW, canvasH, onNavigate }: {
  cards: CanvasCard[]
  groups: CanvasGroup[]
  viewport: { x: number; y: number; zoom: number }
  canvasW: number
  canvasH: number
  onNavigate: (wx: number, wy: number) => void
}) {
  const MM_W = 180, MM_H = 120, PAD = 60
  const vw = canvasW / viewport.zoom, vh = canvasH / viewport.zoom
  const vx = -viewport.x / viewport.zoom, vy = -viewport.y / viewport.zoom
  const minX = Math.min(vx, ...cards.map(c => c.x), ...groups.map(g => g.x)) - PAD
  const minY = Math.min(vy, ...cards.map(c => c.y), ...groups.map(g => g.y)) - PAD
  const maxX = Math.max(vx + vw, ...cards.map(c => c.x + c.width), ...groups.map(g => g.x + g.width)) + PAD
  const maxY = Math.max(vy + vh, ...cards.map(c => c.y + c.height), ...groups.map(g => g.y + g.height)) + PAD
  const worldW = Math.max(1, maxX - minX), worldH = Math.max(1, maxY - minY)
  const scale = Math.min(MM_W / worldW, MM_H / worldH)
  const offX = (MM_W - worldW * scale) / 2, offY = (MM_H - worldH * scale) / 2
  const mx = (wx: number) => offX + (wx - minX) * scale
  const my = (wy: number) => offY + (wy - minY) * scale
  const nav = (e: React.MouseEvent) => {
    const r = e.currentTarget.getBoundingClientRect()
    onNavigate((e.clientX - r.left - offX) / scale + minX, (e.clientY - r.top - offY) / scale + minY)
  }
  return (
    <div
      className="bg-white/90 backdrop-blur-sm border border-slate-200 rounded-lg shadow-md overflow-hidden cursor-pointer"
      style={{ width: MM_W, height: MM_H }}
      onMouseDown={e => { e.stopPropagation(); nav(e) }}
      onMouseMove={e => { if (e.buttons === 1) { e.stopPropagation(); nav(e) } }}
    >
      <svg width={MM_W} height={MM_H}>
        {groups.map(g => (
          <rect key={g.id} x={mx(g.x)} y={my(g.y)} width={g.width * scale} height={g.height * scale} fill="none" stroke="#cbd5e1" strokeWidth={1} rx={2} />
        ))}
        {cards.map(c => (
          <rect key={c.id} x={mx(c.x)} y={my(c.y)} width={Math.max(2, c.width * scale)} height={Math.max(2, c.height * scale)} rx={1.5}
            fill={c.color && COLOR_THEMES[c.color] ? COLOR_THEMES[c.color].dot : '#94a3b8'} fillOpacity={0.75} />
        ))}
        <rect x={mx(vx)} y={my(vy)} width={vw * scale} height={vh * scale} fill="#6366f1" fillOpacity={0.1} stroke="#6366f1" strokeWidth={1.5} />
      </svg>
    </div>
  )
})

/* ── Canvas card ── */

const CanvasCardComponent = memo(function CanvasCardComponent({ card, viewLocked, isSelected, onHeaderDown, onResizeDown, onUpdate, onSelect, onContextMenu, pickerOpen, detachOpen, pickerTab, pickerSearch, onOpenPicker, onClosePicker, onOpenDetach, onCloseDetach, onPickerTab, onPickerSearch }: {
  card: CanvasCard
  viewLocked?: boolean
  isSelected: boolean
  onHeaderDown: (e: React.MouseEvent, card: CanvasCard) => void
  onResizeDown: (e: React.MouseEvent, card: CanvasCard) => void
  onUpdate: (updates: Partial<CanvasCard>) => void
  onSelect: (additive: boolean) => void
  onContextMenu: (e: React.MouseEvent) => void
  pickerOpen: boolean
  detachOpen: boolean
  pickerTab: 'existing' | 'new'
  pickerSearch: string
  onOpenPicker: () => void
  onClosePicker: () => void
  onOpenDetach: () => void
  onCloseDetach: () => void
  onPickerTab: (t: 'existing' | 'new') => void
  onPickerSearch: (s: string) => void
}) {
  // Linked source data (Note/Task) is sourced from the live store so edits propagate.
  const { state, dispatch } = useApp()
  const linkedNote = card.refNoteId ? state.notes.find(n => n.id === card.refNoteId) : undefined
  const linkedTask = card.refTaskId ? (() => { for (const p of state.projects) { const t = p.tasks.find(x => x.id === card.refTaskId); if (t) return t } return undefined })() : undefined
  const isRefBroken = (!!card.refNoteId && !linkedNote) || (!!card.refTaskId && !linkedTask)
  const cfg = cardTypes[card.type]
  const theme = (card.color && COLOR_THEMES[card.color]) || cfg
  const Icon = cfg.icon
  const locked = !!(card.locked || viewLocked)
  const hasSource = !!card.url && (SOURCE_CARD_TYPES as readonly string[]).includes(card.type)
  const hasPages = card.type === 'text' && card.pages && card.pages.length > 0
  const [activePageId, setActivePageId] = useState(card.pages?.[0]?.id ?? '')
  const [editingPageId, setEditingPageId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState(false)

  const activePage = card.pages?.find(p => p.id === activePageId)

  function updatePage(pageId: string, updates: Partial<CardPage>) {
    const pages = card.pages!.map(p => p.id === pageId ? { ...p, ...updates } : p)
    onUpdate({ pages })
  }

  function addPage() {
    const page: CardPage = { id: generateId(), name: '新規', content: '' }
    onUpdate({ pages: [...(card.pages || []), page] })
    setActivePageId(page.id)
    setEditingPageId(page.id)
  }

  function deletePage(pageId: string) {
    const pages = card.pages!.filter(p => p.id !== pageId)
    onUpdate({ pages })
    if (activePageId === pageId) setActivePageId(pages[0]?.id ?? '')
  }

  return (
    <div
      className={`absolute rounded-xl border shadow-lg backdrop-blur-sm transition-shadow flex flex-col ${theme.bg} ${theme.border} ${isSelected ? 'ring-2 ring-indigo-500 shadow-indigo-500/20' : 'hover:shadow-xl'}`}
      style={{ left: card.x, top: card.y, width: card.width, height: card.height }}
      onMouseDown={e => { if (e.button === 0) { e.stopPropagation(); onSelect(e.shiftKey) } }}
      onContextMenu={onContextMenu}
    >
      <div
        className={`px-2.5 py-1.5 rounded-t-xl border-b ${theme.border} ${theme.header} flex items-center gap-1.5 select-none shrink-0`}
        style={{ cursor: 'grab' }}
        onMouseDown={e => onHeaderDown(e, card)}
      >
        {(card.type === 'pdf' || card.type === 'image' || card.type === 'video' || card.type === 'audio') && !locked ? (
          <button
            onMouseDown={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); pickFileForCard(card, onUpdate) }}
            title={card.type === 'pdf' ? 'PDFを選択' : card.type === 'video' ? '動画を選択' : card.type === 'audio' ? '音声を選択' : '画像を選択'}
            className={`shrink-0 -m-0.5 p-0.5 rounded hover:bg-slate-200 transition-colors ${theme.text}`}
          >
            <Icon size={13} />
          </button>
        ) : (
          <Icon size={13} className={`${theme.text} shrink-0`} />
        )}
        {locked && <Lock size={12} className="text-amber-500 shrink-0" />}
        {editingTitle && !locked ? (
          <input
            autoFocus
            type="text"
            value={card.title}
            onChange={e => onUpdate({ title: e.target.value })}
            onMouseDown={e => e.stopPropagation()}
            onBlur={() => setEditingTitle(false)}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === 'Escape') { e.stopPropagation(); e.currentTarget.blur() } }}
            className="flex-1 min-w-0 text-sm font-semibold bg-transparent border-none outline-none text-slate-800 placeholder-slate-400"
            placeholder={cfg.label}
          />
        ) : (
          <span
            onDoubleClick={() => { if (!locked) setEditingTitle(true) }}
            title={locked ? undefined : 'ダブルクリックで名前を編集'}
            className={`flex-1 min-w-0 truncate text-sm font-semibold select-none ${card.title ? 'text-slate-800' : 'text-slate-400 font-normal'}`}
          >
            {card.title || cfg.label}
          </span>
        )}
        {hasSource && (
          <button
            onMouseDown={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); openCardSource(card) }}
            title={isMediaRef(card.url) ? '元データを開く' : '元のページを開く'}
            aria-label={isMediaRef(card.url) ? '元データを開く' : '元のページを開く'}
            className="p-0.5 rounded hover:bg-slate-200 text-slate-400 hover:text-slate-700 transition-colors shrink-0"
          >
            <ExternalLink size={12} />
          </button>
        )}
      </div>

      <div className="flex-1 overflow-hidden flex flex-col min-h-0">
        {hasPages ? (
          <>
            {/* Page tabs inside card */}
            <div className="flex items-center gap-0 px-2 shrink-0 border-b border-slate-200 overflow-x-auto" onMouseDown={e => e.stopPropagation()}>
              {card.pages!.map(page => (
                <div
                  key={page.id}
                  className={`group flex items-center gap-0.5 px-2 py-1 text-[11px] cursor-pointer border-b transition-colors shrink-0 ${
                    activePageId === page.id
                      ? 'border-slate-400 text-slate-700'
                      : 'border-transparent text-slate-400 hover:text-slate-600'
                  }`}
                  onClick={() => setActivePageId(page.id)}
                >
                  {editingPageId === page.id ? (
                    <input
                      autoFocus
                      type="text"
                      value={page.name}
                      onChange={e => updatePage(page.id, { name: e.target.value })}
                      onBlur={() => setEditingPageId(null)}
                      onKeyDown={e => { if (e.key === 'Enter') setEditingPageId(null) }}
                      onClick={e => e.stopPropagation()}
                      className="bg-transparent border-none outline-none text-[11px] text-slate-700 w-12"
                    />
                  ) : (
                    <span onDoubleClick={e => { e.stopPropagation(); if (!locked) setEditingPageId(page.id) }}>{page.name}</span>
                  )}
                  {!locked && card.pages!.length > 1 && (
                    <button
                      onClick={e => { e.stopPropagation(); deletePage(page.id) }}
                      className="p-0.5 opacity-0 group-hover:opacity-100 text-slate-300 hover:text-rose-500"
                    >
                      <X size={9} />
                    </button>
                  )}
                </div>
              ))}
              {!locked && (
                <button onClick={addPage} className="p-1 text-slate-300 hover:text-slate-600 shrink-0">
                  <Plus size={11} />
                </button>
              )}
            </div>
            <MarkdownText
              key={activePageId}
              value={activePage?.content ?? ''}
              onChange={v => activePage && updatePage(activePage.id, { content: v })}
              readOnly={locked}
              extraClass="flex-1 min-h-0 px-3 py-2"
              placeholder="テキストを入力…（マークダウン対応）"
            />
          </>
        ) : card.type === 'web' ? (
          <div className="flex flex-col flex-1 min-h-0" onMouseDown={e => e.stopPropagation()}>
            <div className="flex items-center gap-1.5 px-2 py-1.5 shrink-0 border-b border-slate-200 bg-slate-50">
              <ExternalLink size={11} className="text-slate-400 shrink-0" />
              <input
                type="text"
                value={card.url ?? ''}
                onChange={e => onUpdate({ url: e.target.value })}
                onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
                readOnly={locked}
                className="bg-slate-100 rounded px-2 py-0.5 text-[11px] border border-slate-300 outline-none flex-1 min-w-0 text-cyan-600 placeholder-slate-400 focus:border-indigo-400"
                placeholder="https://... (Slides / Sheets / YouTube も埋め込み可)"
              />
              {(() => {
                const u = card.url || ''
                const label = u.includes('docs.google.com/presentation') ? 'Slides'
                  : u.includes('docs.google.com/spreadsheets') ? 'Sheets'
                  : u.includes('docs.google.com/document') ? 'Docs'
                  : u.includes('docs.google.com/forms') ? 'Forms'
                  : (u.includes('youtube.com') || u.includes('youtu.be')) ? 'YouTube'
                  : u.includes('vimeo.com') ? 'Vimeo'
                  : u.includes('open.spotify.com') ? 'Spotify'
                  : null
                return label ? (
                  <span className="shrink-0 text-[9px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 font-medium" title="共有URLを埋め込み用に自動変換します">
                    {label}
                  </span>
                ) : null
              })()}
            </div>
            <WebFrame
              url={card.url || ''}
              title={card.title || 'Web page'}
              embedMode
              className="flex-1 min-h-0 w-full border-none bg-white rounded-b-xl"
            />
          </div>
        ) : card.type === 'pdf' ? (
          <PdfCardBody card={card} onUpdate={onUpdate} locked={locked} />
        ) : card.type === 'image' ? (
          <ImageCardBody card={card} onUpdate={onUpdate} locked={locked} />
        ) : card.type === 'video' ? (
          <VideoCardBody card={card} onUpdate={onUpdate} locked={locked} />
        ) : card.type === 'audio' ? (
          <AudioCardBody card={card} onUpdate={onUpdate} locked={locked} />
        ) : card.type === 'sequence' ? (
          <SequenceCardBody card={card} onUpdate={onUpdate} locked={locked} />
        ) : card.type === 'taskDraft' ? (
          <TaskDraftCardBody card={card} onUpdate={onUpdate} onSelect={() => onSelect(false)} locked={locked} />
        ) : linkedNote ? (
          <div className="flex-1 min-h-0 flex flex-col">
            <div className="px-3 py-1 border-b border-slate-200/60 flex items-center gap-1 text-[10px] text-slate-500 shrink-0">
              <Link2 size={10} className="text-indigo-400 shrink-0" />
              <span className="truncate flex-1" title={linkedNote.title}>{linkedNote.title || '(無題)'}</span>
              {!locked && (
                <button
                  onMouseDown={e => e.stopPropagation()}
                  onClick={e => { e.stopPropagation(); onOpenDetach() }}
                  title="リンクを解除"
                  className="p-0.5 rounded hover:bg-slate-100 text-slate-400 hover:text-rose-500 shrink-0"
                >
                  <Unlink size={10} />
                </button>
              )}
            </div>
            <MarkdownText
              key={linkedNote.id}
              value={linkedNote.content}
              onChange={v => dispatch({ type: 'UPDATE_NOTE', payload: { ...linkedNote, content: v, updatedAt: new Date().toISOString() } })}
              readOnly={locked}
              textSize="text-xs"
              extraClass="flex-1 min-h-0 px-3 py-2"
              placeholder="（リンク先のノートはまだ空です）"
            />
          </div>
        ) : linkedTask ? (
          <div className="flex-1 min-h-0 flex flex-col">
            <div className="px-3 py-1 border-b border-slate-200/60 flex items-center gap-1 text-[10px] text-slate-500 shrink-0">
              <Link2 size={10} className="text-indigo-400 shrink-0" />
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${linkedTask.status === 'done' ? 'bg-emerald-500' : linkedTask.status === 'in-progress' ? 'bg-amber-500' : 'bg-slate-400'}`} />
              <span className="truncate flex-1" title={linkedTask.title}>{linkedTask.title || '(無題)'}</span>
              {!locked && (
                <button
                  onMouseDown={e => e.stopPropagation()}
                  onClick={e => { e.stopPropagation(); onOpenDetach() }}
                  title="リンクを解除"
                  className="p-0.5 rounded hover:bg-slate-100 text-slate-400 hover:text-rose-500 shrink-0"
                >
                  <Unlink size={10} />
                </button>
              )}
            </div>
            <div className="px-3 py-1.5 text-[10px] text-slate-500 flex items-center gap-2 border-b border-slate-100">
              <select
                value={linkedTask.status}
                onMouseDown={e => e.stopPropagation()}
                onChange={e => {
                  const board = state.projects.find(p => p.tasks.some(t => t.id === linkedTask.id))
                  if (!board) return
                  dispatch({ type: 'UPDATE_TASK', payload: { projectId: board.id, task: { ...linkedTask, status: e.target.value as Task['status'] } } })
                }}
                disabled={locked}
                className="bg-slate-50 border border-slate-200 rounded px-1 py-0.5 text-[10px]"
              >
                <option value="todo">未着手</option>
                <option value="in-progress">進行中</option>
                <option value="done">完了</option>
              </select>
              {(linkedTask.startDate || linkedTask.endDate) && (
                <span className="font-mono">{linkedTask.startDate ?? '…'} 〜 {linkedTask.endDate ?? '…'}</span>
              )}
            </div>
            <MarkdownText
              key={linkedTask.id}
              value={linkedTask.description}
              onChange={v => {
                const board = state.projects.find(p => p.tasks.some(t => t.id === linkedTask.id))
                if (!board) return
                dispatch({ type: 'UPDATE_TASK', payload: { projectId: board.id, task: { ...linkedTask, description: v } } })
              }}
              readOnly={locked}
              textSize="text-xs"
              extraClass="flex-1 min-h-0 px-3 py-2"
              placeholder="（タスクの説明はまだ空です）"
            />
          </div>
        ) : isRefBroken ? (
          <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-2 px-3 py-4 text-center">
            <span className="text-[11px] text-slate-500">リンク先が見つかりません</span>
            <button
              onClick={() => onUpdate({ refNoteId: undefined, refTaskId: undefined })}
              className="text-[10px] px-2 py-0.5 rounded border border-slate-300 text-slate-600 hover:bg-slate-100"
            >リンクを解除</button>
          </div>
        ) : (
          <div className="flex-1 min-h-0 flex flex-col">
            {(card.type === 'note' || card.type === 'todo') && !locked && (
              <div className="px-2 py-0.5 border-b border-slate-200/40 flex items-center justify-end shrink-0">
                <button
                  onMouseDown={e => e.stopPropagation()}
                  onClick={e => { e.stopPropagation(); onOpenPicker() }}
                  title={card.type === 'note' ? '既存ノートにリンク' : '既存タスクにリンク'}
                  className="p-0.5 rounded hover:bg-slate-100 text-slate-300 hover:text-indigo-500"
                >
                  <Link2 size={11} />
                </button>
              </div>
            )}
            <MarkdownText
              value={card.content}
              onChange={v => onUpdate({ content: v })}
              readOnly={locked}
              textSize={card.type === 'text' ? 'text-sm' : 'text-xs'}
              extraClass="flex-1 min-h-0 px-3 py-2"
              placeholder={card.type === 'text' ? 'テキストを入力…（マークダウン対応）' : '内容…'}
            />
          </div>
        )}
      </div>

      {pickerOpen && (
        <>
          <div className="fixed inset-0 z-40" onMouseDown={onClosePicker} />
          <div
            className="absolute right-2 top-9 z-50 w-[260px] bg-white border border-slate-200 rounded-lg shadow-xl p-2"
            onMouseDown={e => e.stopPropagation()}
            onClick={e => e.stopPropagation()}
          >
            <div className="flex gap-1 mb-2 text-[10px]">
              <button
                className={`px-2 py-0.5 rounded ${pickerTab === 'existing' ? 'bg-indigo-100 text-indigo-700' : 'text-slate-500 hover:bg-slate-50'}`}
                onClick={() => onPickerTab('existing')}
              >既存</button>
              <button
                className={`px-2 py-0.5 rounded ${pickerTab === 'new' ? 'bg-indigo-100 text-indigo-700' : 'text-slate-500 hover:bg-slate-50'}`}
                onClick={() => onPickerTab('new')}
              >新規作成</button>
            </div>
            {pickerTab === 'existing' ? (
              <>
                <input
                  value={pickerSearch}
                  onChange={e => onPickerSearch(e.target.value)}
                  placeholder={card.type === 'note' ? 'ノートを検索…' : 'タスクを検索…'}
                  autoFocus
                  className="w-full text-xs bg-slate-50 border border-slate-200 rounded px-2 py-1 outline-none focus:border-indigo-400 mb-1"
                />
                <div className="max-h-[220px] overflow-y-auto">
                  {card.type === 'note'
                    ? state.notes
                        .filter(n => n.masterProjectId === state.activeMasterProjectId)
                        .filter(n => !pickerSearch || (n.title || '').toLowerCase().includes(pickerSearch.toLowerCase()))
                        .map(n => (
                          <button
                            key={n.id}
                            className="w-full text-left px-1.5 py-1 hover:bg-slate-50 rounded text-xs text-slate-700 truncate"
                            onClick={() => { onUpdate({ refNoteId: n.id }); onClosePicker() }}
                          >{n.title || '(無題)'}</button>
                        ))
                    : state.projects
                        .filter(p => p.masterProjectId === state.activeMasterProjectId)
                        .flatMap(p => p.tasks.map(t => ({ t, p })))
                        .filter(({ t }) => !pickerSearch || (t.title || '').toLowerCase().includes(pickerSearch.toLowerCase()))
                        .map(({ t, p }) => (
                          <button
                            key={t.id}
                            className="w-full text-left px-1.5 py-1 hover:bg-slate-50 rounded text-xs text-slate-700 truncate flex items-center gap-1"
                            onClick={() => { onUpdate({ refTaskId: t.id }); onClosePicker() }}
                            title={`${p.name} / ${t.title || '(無題)'}`}
                          >
                            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${t.status === 'done' ? 'bg-emerald-500' : t.status === 'in-progress' ? 'bg-amber-500' : 'bg-slate-400'}`} />
                            <span className="truncate">{t.title || '(無題)'}</span>
                            <span className="ml-auto text-[9px] text-slate-400 shrink-0 truncate max-w-[80px]">{p.name}</span>
                          </button>
                        ))
                  }
                  {((card.type === 'note' && state.notes.filter(n => n.masterProjectId === state.activeMasterProjectId).length === 0) ||
                    (card.type === 'todo' && state.projects.filter(p => p.masterProjectId === state.activeMasterProjectId).every(p => p.tasks.length === 0))) && (
                    <div className="px-1.5 py-2 text-[10px] text-slate-400 text-center">候補がありません</div>
                  )}
                </div>
              </>
            ) : (
              <div className="flex flex-col gap-1">
                <input
                  value={pickerSearch}
                  onChange={e => onPickerSearch(e.target.value)}
                  placeholder={card.type === 'note' ? '新規ノートのタイトル' : '新規タスクのタイトル'}
                  autoFocus
                  className="w-full text-xs bg-slate-50 border border-slate-200 rounded px-2 py-1 outline-none focus:border-indigo-400"
                />
                <button
                  className="text-xs px-2 py-1 bg-indigo-500 text-white rounded hover:bg-indigo-600 disabled:opacity-30"
                  disabled={!pickerSearch.trim()}
                  onClick={() => {
                    const title = pickerSearch.trim()
                    if (!title) return
                    const newId = generateId()
                    const now = new Date().toISOString()
                    if (card.type === 'note') {
                      const newNote: Note = { id: newId, masterProjectId: state.activeMasterProjectId, title, content: '', tags: [], createdAt: now, updatedAt: now }
                      dispatch({ type: 'ADD_NOTE', payload: newNote })
                      onUpdate({ refNoteId: newId })
                    } else {
                      const targetBoard = state.projects.find(p => p.masterProjectId === state.activeMasterProjectId)
                      if (!targetBoard) return
                      const newTask: Task = { id: newId, title, description: '', status: 'todo', tags: [], createdAt: now }
                      dispatch({ type: 'ADD_TASK', payload: { projectId: targetBoard.id, task: newTask } })
                      onUpdate({ refTaskId: newId })
                    }
                    onClosePicker()
                  }}
                >作成してリンク</button>
                {card.type === 'todo' && !state.projects.some(p => p.masterProjectId === state.activeMasterProjectId) && (
                  <div className="text-[10px] text-rose-500">先にボードを作成してください</div>
                )}
              </div>
            )}
          </div>
        </>
      )}

      {detachOpen && (linkedNote || linkedTask) && (
        <>
          <div className="fixed inset-0 z-40" onMouseDown={onCloseDetach} />
          <div
            className="absolute right-2 top-9 z-50 w-[220px] bg-white border border-slate-200 rounded-lg shadow-xl p-2 flex flex-col gap-1"
            onMouseDown={e => e.stopPropagation()}
          >
            <div className="text-[10px] text-slate-500 px-1 pb-1">リンクを解除する方法を選択</div>
            <button
              className="text-xs text-left px-2 py-1.5 hover:bg-slate-50 rounded text-slate-700"
              onClick={() => {
                if (linkedNote) {
                  onUpdate({ title: linkedNote.title || card.title, content: linkedNote.content || '', refNoteId: undefined })
                } else if (linkedTask) {
                  onUpdate({ title: linkedTask.title || card.title, content: linkedTask.description || '', refTaskId: undefined })
                }
                onCloseDetach()
              }}
            >内容をカードにコピー</button>
            <button
              className="text-xs text-left px-2 py-1.5 hover:bg-rose-50 hover:text-rose-700 rounded text-slate-600"
              onClick={() => {
                onUpdate({ refNoteId: undefined, refTaskId: undefined })
                onCloseDetach()
              }}
            >カードを空にする</button>
          </div>
        </>
      )}

      {!locked && (
        <div
          className="absolute bottom-0 right-0 w-4 h-4 cursor-nwse-resize group"
          onMouseDown={e => onResizeDown(e, card)}
        >
          <svg className="absolute bottom-1 right-1 text-slate-400 group-hover:text-slate-600 transition-colors" width="8" height="8" viewBox="0 0 8 8">
            <path d="M7 1L1 7M7 4L4 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </div>
      )}
    </div>
  )
})

/* ── List card ── */

const ListCardComponent = memo(function ListCardComponent({ card, onUpdate, onDelete }: {
  card: CanvasCard
  onUpdate: (updates: Partial<CanvasCard>) => void
  onDelete: () => void
}) {
  const cfg = cardTypes[card.type]
  const theme = (card.color && COLOR_THEMES[card.color]) || cfg
  const Icon = cfg.icon
  const hasPages = card.type === 'text' && card.pages && card.pages.length > 0
  const [activePageId, setActivePageId] = useState(card.pages?.[0]?.id ?? '')
  const [editingPageId, setEditingPageId] = useState<string | null>(null)

  const activePage = card.pages?.find(p => p.id === activePageId)

  function updatePage(pageId: string, updates: Partial<CardPage>) {
    const pages = card.pages!.map(p => p.id === pageId ? { ...p, ...updates } : p)
    onUpdate({ pages })
  }

  function addPage() {
    const page: CardPage = { id: generateId(), name: '新規', content: '' }
    onUpdate({ pages: [...(card.pages || []), page] })
    setActivePageId(page.id)
    setEditingPageId(page.id)
  }

  function deletePage(pageId: string) {
    const pages = card.pages!.filter(p => p.id !== pageId)
    onUpdate({ pages })
    if (activePageId === pageId) setActivePageId(pages[0]?.id ?? '')
  }

  return (
    <div className={`rounded-xl border ${theme.bg} ${theme.border} overflow-hidden`}>
      <div className={`px-3 py-1.5 border-b ${theme.border} ${theme.header} flex items-center gap-2`}>
        {card.type === 'pdf' || card.type === 'image' || card.type === 'video' || card.type === 'audio' ? (
          <button
            onClick={() => pickFileForCard(card, onUpdate)}
            title={card.type === 'pdf' ? 'PDFを選択' : card.type === 'video' ? '動画を選択' : card.type === 'audio' ? '音声を選択' : '画像を選択'}
            className={`shrink-0 -m-0.5 p-0.5 rounded hover:bg-slate-200 transition-colors ${theme.text}`}
          >
            <Icon size={14} />
          </button>
        ) : (
          <Icon size={14} className={`${theme.text} shrink-0`} />
        )}
        <input
          type="text"
          value={card.title}
          onChange={e => onUpdate({ title: e.target.value })}
          className="flex-1 min-w-0 text-sm font-semibold bg-transparent border-none outline-none text-slate-800 placeholder-slate-400"
          placeholder={cfg.label}
        />
        <button onClick={onDelete} className="p-1 rounded hover:bg-slate-200 text-slate-400 hover:text-rose-500 transition-colors shrink-0">
          <Trash2 size={13} />
        </button>
      </div>
      <div className="p-4">
        {hasPages ? (
          <>
            <div className="flex items-center gap-0 mb-2 border-b border-slate-200 overflow-x-auto">
              {card.pages!.map(page => (
                <div
                  key={page.id}
                  className={`group flex items-center gap-1 px-3 py-1.5 text-xs cursor-pointer border-b-2 transition-colors shrink-0 ${
                    activePageId === page.id
                      ? 'border-slate-400 text-slate-700'
                      : 'border-transparent text-slate-400 hover:text-slate-600'
                  }`}
                  onClick={() => setActivePageId(page.id)}
                >
                  {editingPageId === page.id ? (
                    <input
                      autoFocus
                      type="text"
                      value={page.name}
                      onChange={e => updatePage(page.id, { name: e.target.value })}
                      onBlur={() => setEditingPageId(null)}
                      onKeyDown={e => { if (e.key === 'Enter') setEditingPageId(null) }}
                      onClick={e => e.stopPropagation()}
                      className="bg-transparent border-none outline-none text-xs text-slate-700 w-16"
                    />
                  ) : (
                    <span onDoubleClick={e => { e.stopPropagation(); setEditingPageId(page.id) }}>{page.name}</span>
                  )}
                  {card.pages!.length > 1 && (
                    <button
                      onClick={e => { e.stopPropagation(); deletePage(page.id) }}
                      className="p-0.5 opacity-0 group-hover:opacity-100 text-slate-300 hover:text-rose-500"
                    >
                      <X size={10} />
                    </button>
                  )}
                </div>
              ))}
              <button onClick={addPage} className="p-1 text-slate-300 hover:text-slate-600 shrink-0">
                <Plus size={12} />
              </button>
            </div>
            <MarkdownText
              key={activePageId}
              value={activePage?.content ?? ''}
              onChange={v => activePage && updatePage(activePage.id, { content: v })}
              extraClass="min-h-[120px]"
              placeholder="テキストを入力…（マークダウン対応）"
            />
          </>
        ) : card.type === 'web' ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <ExternalLink size={13} className="text-slate-400 shrink-0" />
              <input
                type="text"
                value={card.url ?? ''}
                onChange={e => onUpdate({ url: e.target.value })}
                onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
                className="bg-slate-100 rounded px-2.5 py-1.5 text-xs border border-slate-300 outline-none flex-1 min-w-0 text-cyan-600 placeholder-slate-400 focus:border-indigo-400"
                placeholder="https://..."
              />
            </div>
            <WebFrame
              url={card.url || ''}
              title={card.title || 'Web page'}
              className="w-full border border-slate-200 rounded-lg bg-white"
              style={{ height: 300 }}
            />
          </div>
        ) : card.type === 'pdf' ? (
          <PdfCardBody card={card} onUpdate={onUpdate} fixedHeight={400} />
        ) : card.type === 'image' ? (
          <ImageCardBody card={card} onUpdate={onUpdate} fixedHeight={300} />
        ) : card.type === 'video' ? (
          <VideoCardBody card={card} onUpdate={onUpdate} fixedHeight={300} />
        ) : card.type === 'audio' ? (
          <AudioCardBody card={card} onUpdate={onUpdate} fixedHeight={150} />
        ) : card.type === 'sequence' ? (
          <SequenceCardBody card={card} onUpdate={onUpdate} fixedHeight={320} />
        ) : (
          <MarkdownText
            value={card.content}
            onChange={v => onUpdate({ content: v })}
            textSize={card.type === 'text' ? 'text-sm' : 'text-xs'}
            extraClass={card.type === 'text' ? 'min-h-[120px]' : 'min-h-[60px]'}
            placeholder={card.type === 'text' ? 'テキストを入力…' : '内容…'}
          />
        )}
      </div>
    </div>
  )
})
