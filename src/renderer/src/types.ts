// Global master project — the single top-level scope. Switching the active master
// project re-scopes every tool (canvas, notes, research, tasks, 路線図).
export interface MasterProject {
  id: string
  name: string
  createdAt: string
}

export interface Note {
  id: string
  masterProjectId: string // owning master project
  title: string
  content: string
  tags: string[]
  createdAt: string
  updatedAt: string
  folderId?: string // optional grouping — items without folderId render under "未分類"
  pinned?: boolean  // pinned notes sort to the top regardless of other order
  archivedAt?: string // ISO timestamp — when set, hidden from default list (soft delete)
  // Cross-project note sharing: `shared` marks this note as a referenceable master —
  // common content (URLs, contacts…) maintained in one place. Every other master
  // project listed in `refByMasterIds` shows it as a live instance; edits made from
  // any project write back to this single source note.
  shared?: boolean
  refByMasterIds?: string[] // master project ids (other than the owner) that reference this note
}

// Grouping container for Note. Folders can nest via parentId (a tree).
// Root folders have parentId === undefined.
export interface NoteFolder {
  id: string
  masterProjectId: string
  name: string
  createdAt: string
  parentId?: string
  color?: BoardColor // optional accent color — applied as a left stripe + icon tint
}

export interface Task {
  id: string
  title: string
  description: string
  status: 'todo' | 'in-progress' | 'done'
  tags: string[]
  createdAt: string
  startDate?: string // YYYY-MM-DD (optional). Tasks with dates appear on the Gantt/Calendar.
  endDate?: string   // YYYY-MM-DD (optional, inclusive). If only one of start/end is set, the task is a 1-day item on that date.
  parentId?: string  // task hierarchy: when set, this task is a subtask of `parentId` (within the same board).
  linkedNoteIds?: string[] // ids of Notes that hold richer detail for this task (contact info, references, etc.)
  priority?: 1 | 2 | 3 | 4 // 1 = highest (P1 / urgent), 4 = lowest. undefined = unset.
  completedAt?: string // ISO timestamp when status flipped to 'done'. Surfaces in "hide done" filtering and history.
  // Cross-project schedule sharing: when true, this task's date span also shows on
  // EVERY other project's Gantt — but under `sharedAlias` (so the real title stays
  // private). Its own project shows it normally.
  shared?: boolean
  sharedAlias?: string // display name used on other projects' Gantt (falls back to '予定' when empty)
}

export type BoardColor = 'slate' | 'emerald' | 'indigo' | 'rose' | 'amber' | 'sky' | 'violet' | 'fuchsia'
export interface Project {
  id: string
  masterProjectId: string // owning master project
  name: string
  description: string
  tasks: Task[]
  createdAt: string
  color?: BoardColor // optional board accent colour — falls back to a palette-rotated default by index
}

// キャンバスボード — 大カテゴリー。タブ (CanvasTab) を小カテゴリーとして束ねる。
// Same idiom as note folders: tabs with no boardId sit in a virtual 未分類 group.
export interface CanvasBoard {
  id: string
  projectId: string // owning master project id
  name: string
  color?: BoardColor
  createdAt: string
}

export interface CanvasTab {
  id: string
  projectId: string // owning master project id (a category lives directly under a master project)
  boardId?: string // owning canvas board (大カテゴリー); undefined = 未分類
  name: string
  createdAt: string
}

export interface CardPage {
  id: string
  name: string
  content: string
}

// A saved playback position on an audio/video card.
export interface Bookmark {
  id: string
  time: number // seconds
  label?: string
}

// One of the 8 connection ports on a card's outline (compass directions).
export type PortDir = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw'

export interface CanvasArrow {
  id: string
  tabId: string
  x1: number
  y1: number
  x2: number
  y2: number
  fromCardId?: string
  toCardId?: string
  fromPort?: PortDir // when set (with fromCardId), the end docks to that fixed port instead of the auto border point
  toPort?: PortDir
  points?: { x: number; y: number }[] // bend waypoints between the two ends (canvas coords, in order)
  label?: string
  curved?: boolean
  color?: string // arrow stroke/arrowhead color (default indigo #6366f1)
  width?: number // arrow line thickness (default 2)
  createdAt: string
}

export interface CanvasGroup {
  id: string
  tabId: string
  title: string
  x: number
  y: number
  width: number
  height: number
  createdAt: string
}

export interface CanvasStroke {
  id: string
  tabId: string
  points: number[] // flattened [x0, y0, x1, y1, ...] in canvas coordinates
  color: string
  width: number
  createdAt: string
}

export interface CanvasLabel {
  id: string
  tabId: string
  text: string
  x: number
  y: number
  fontSize: number
  color: string
  createdAt: string
}

/* ── キャンバス線路 (canvas-native 路線図) ──
   Metro-style route maps drawn DIRECTLY on a canvas tab: rails thread through
   station nodes in order. Independent of the 路線図 (mindtrain) page — this is
   canvas-local data, cascaded with the tab like strokes/labels. A station that
   appears in 2+ rails renders as a transfer (乗換駅). */

export interface CanvasRail {
  id: string
  tabId: string
  name: string
  color: string
  stationIds: string[] // ordered — the line is drawn through these stations
  createdAt: string
}

export interface CanvasStation {
  id: string
  tabId: string
  name: string
  x: number
  y: number
  status: 'todo' | 'doing' | 'done' // 計画中 / 建設中 / 開業 — same grammar as the 路線図 page
  createdAt: string
}

// Rough-timing choice on a taskDraft card / flow node ("大体いつやりたいか") — a
// 5-way position within the month (month head / early / mid / late / month end).
// Mapped to a concrete endDate (YYYY-MM-DD) in the current month (rolling to next
// month if that day has already passed) at task-conversion time.
export type DraftWhen = 'monthStart' | 'earlyMonth' | 'midMonth' | 'lateMonth' | 'monthEnd'

/* ── フロー (Flow) — dedicated task-flow planning documents ── */

// The three flavours of node in a Flow surface. 'task' nodes convert into
// real tasks; 'image' / 'memo' are pure annotation cards (no edges, no タスク化).
// `kind` is optional so pre-existing saved flows (no kind field) render as 'task'.
export type FlowNodeKind = 'task' | 'image' | 'memo'

// A node in a flow diagram. Before conversion it is a free-floating draft
// (title + rough timing); after タスク化 it carries taskId and mirrors the
// live task (status shown/edited through the node).
export interface FlowNode {
  id: string
  title: string
  x: number
  y: number
  kind?: FlowNodeKind // undefined = 'task' (back-compat for older flows)
  width?: number      // image/memo cards are user-resizable; falls back to a per-kind default
  height?: number
  imageUrl?: string   // 'image' kind — data-URL of the picture
  body?: string       // 'memo' kind — multi-line plain text
  when?: DraftWhen // rough within-month position → endDate at conversion
  whenMonth?: number // 1-12 absolute month for `when` (undefined = current month, rolling). Flow-only.
  whenYear?: number // explicit calendar year for whenMonth (undefined = auto: this year, else next). Flow-only.
  whenInherit?: boolean // child inherits its parent's resolved date at conversion (overrides when/whenMonth). Flow-only.
  taskId?: string // set after conversion — node is live-linked to this task
  boardId?: string // owning board of taskId (lookup shortcut; revalidated on read)
}

// Directed edge: from = parent, to = child. Drives parentId at conversion.
export interface FlowEdge {
  id: string
  fromId: string
  toId: string
}

// A spatial grouping frame (mirrors CanvasGroup) — membership is geometric, not
// stored; nodes whose center is inside move with the group.
export interface FlowGroup {
  id: string
  title: string
  x: number
  y: number
  width: number
  height: number
  createdAt?: string
}

export interface Flow {
  id: string
  masterProjectId: string // owning master project
  name: string
  nodes: FlowNode[]
  edges: FlowEdge[]
  groups?: FlowGroup[]
  createdAt: string
  updatedAt: string
}

/* ── 計画 (Plan) — TripMD-style itinerary documents for asset-shooting trips ── */

// A markdown itinerary document (TripMD-compatible subset). `content` holds the
// raw markdown: `## YYYY-MM-DD` day headings + `> [HH:MM] type title` event lines,
// with e-ticket attachments referenced as [label](idb:…) / [label](local:…) links.
export interface Plan {
  id: string
  masterProjectId: string // owning master project
  name: string
  content: string
  folderId?: string // owning PlanFolder (undefined = 未分類)
  createdAt: string
  updatedAt: string
}

// Sidebar folder for plans — same shape/UX as NoteFolder (nesting + color + D&D).
export interface PlanFolder {
  id: string
  masterProjectId: string
  name: string
  createdAt: string
  parentId?: string
  color?: BoardColor
}

// A cross-project period annotation ("この期間は出張" 等). Master-scoped: shared
// by every board/task in the master and rendered as a band + tinted region in
// the Gantt so scheduling can account for it.
export interface TimelineBand {
  id: string
  masterProjectId: string
  title: string
  startDate: string // YYYY-MM-DD inclusive
  endDate: string   // YYYY-MM-DD inclusive
  color?: BoardColor
  createdAt: string
}

// Diagram shapes for 'shape' cards — plain outlined figures (構成図・フローチャート用).
export type ShapeKind = 'rect' | 'roundRect' | 'ellipse' | 'diamond' | 'triangle' | 'parallelogram' | 'hexagon' | 'cylinder' | 'cloud'
  | 'file' | 'folder' | 'person' | 'pc' | 'server' // pictogram shapes (IT構成図の定番)

export interface CanvasCard {
  id: string
  tabId: string
  type: 'text' | 'note' | 'todo' | 'research' | 'idea' | 'web' | 'pdf' | 'image' | 'video' | 'audio' | 'sequence' | 'taskDraft' | 'shape' | 'sketch' | 'canvasLink' | 'mindtrain'
  title: string
  content: string
  url?: string
  color?: string
  locked?: boolean
  pages?: CardPage[]
  crop?: { x: number; y: number; w: number; h: number } // normalized (0-1) display clip for image cards
  bookmarks?: Bookmark[] // saved playback positions for audio/video cards
  pdf?: { page?: number; mode?: 'scroll' | 'single' | 'spread' } // persisted PDF view state
  frames?: { url: string; name?: string }[] // ordered image frames for a 'sequence' card
  stationId?: string // linked 路線図 (mindtrain) station — back-reference for card↔station jump
  refNoteId?: string // when set on a 'note' card, the card mirrors this Note (live read/write)
  refTaskId?: string // when set on a 'todo' card, the card mirrors this Task (live read/write)
  refSketchId?: string // when set on a 'sketch' card, the card live-mirrors this Sketch (read-only on canvas)
  refTabId?: string // when set on a 'canvasLink' card, the card is a shortcut to that canvas tab
  refPlanId?: string // when set on a 'mindtrain' card, the card live-mirrors that 路線図 plan (read-only on canvas)
  draftWhen?: DraftWhen // 'taskDraft' cards: rough target timing, converted to endDate on タスク化
  shape?: ShapeKind // 'shape' cards: which figure to draw (default 'rect')

  x: number
  y: number
  width: number
  height: number
  createdAt: string
}

export interface ResearchItem {
  id: string
  masterProjectId: string // owning master project
  title: string
  url: string
  description: string
  tags: string[]
  category: string
  createdAt: string
  folderId?: string // optional grouping — items without folderId render under "未分類"
  archivedAt?: string // ISO timestamp — soft-deleted (recoverable from "アーカイブ" view)
}

// Grouping container for ResearchItem. Folders can nest via parentId (a tree).
// Root folders have parentId === undefined.
export interface ResearchFolder {
  id: string
  masterProjectId: string
  name: string
  createdAt: string
  parentId?: string
  color?: BoardColor // optional accent color — applied as a left stripe + icon tint
}

// A single turn in an AI assistant conversation.
export interface AIMessage {
  role: 'user' | 'assistant'
  content: string
  createdAt: string
}

// A persisted AI assistant conversation, scoped under a master project. Lets the
// user reopen prior conversations and reuse individual messages later.
export interface AIConversation {
  id: string
  masterProjectId: string
  title: string
  messages: AIMessage[]
  createdAt: string
  updatedAt: string
}

// A freehand stroke on a sketch sheet (flattened [x0,y0,x1,y1,...] in sketch coords).
export interface SketchStroke {
  points: number[]
  color: string
  width: number
}

// A standalone sketch sheet, scoped under a master project (separate from the canvas).
export interface Sketch {
  id: string
  masterProjectId: string
  name: string
  strokes: SketchStroke[]
  createdAt: string
  updatedAt: string
}
