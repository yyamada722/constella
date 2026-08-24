// フロー — dedicated task-flow planning surface.
//
// Axes: HORIZONTAL = time (siblings fan out to the right), VERTICAL(down) =
// decomposition (children hang below their parent). Edges run parent-bottom →
// child-top. Scatter nodes (title + 大体いつ), wire parent→child, then タスク化
// converts the diagram into real tasks in a board. Converted nodes stay
// live-linked (status dot + click-to-cycle, title writes through).
//
// Operating model mirrors the Canvas: rubber-band + Shift multi-select, group
// frames (Ctrl+G), copy/paste/duplicate, arrow-nudge, Space/middle-drag pan,
// and the same keyboard shortcuts.
//
// Fast entry: double-click = node, Tab = child (below), Enter = sibling (right).
import { useState, useRef, useMemo, useEffect, useCallback } from 'react'
import { Plus, Trash2, ZoomIn, ZoomOut, Maximize, ListChecks, GitBranch, X, Frame, Image as ImageIcon, StickyNote, CornerDownRight, ArrowRight, CalendarDays, ChevronLeft, ChevronRight, Undo2, Redo2 } from 'lucide-react'
import { useApp } from '../store'
import { Flow, FlowNode, FlowEdge, FlowGroup, Task, Project } from '../types'
import { generateId } from '../utils'
import { DRAFT_WHEN_OPTIONS, draftWhenToEndDate } from '../utils/draftWhen'
import { IMAGE_ACCEPT, isImageFile, normalizeImageBlob } from '../utils/image'
import { usePopoverDismiss } from '../components/usePopoverDismiss'
import { wheelZoomFactor } from '../utils/zoom'
import ZoomSpeedControl from '../components/ZoomSpeedControl'

const NODE_W = 200
const NODE_H = 104 // taller row leaves space for the month picker + timing chips
const IMG_W = 200
const IMG_H = 140
const MEMO_W = 200
const MEMO_H = 120
const MIN_W = 80
const MIN_H = 60
const CHILD_GAP_Y = 64   // vertical gap parent → child (decomposition axis)
const SIBLING_GAP_X = 40 // horizontal gap between siblings (time axis)
const GROUP_PAD = 28
const MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]

// A node's on-screen size — task nodes use the fixed row layout, image/memo
// nodes are user-resizable and fall back to a per-kind default.
function nodeSize(n: FlowNode): { w: number; h: number } {
  const kind = n.kind ?? 'task'
  if (kind === 'task') return { w: NODE_W, h: NODE_H }
  const defW = kind === 'image' ? IMG_W : MEMO_W
  const defH = kind === 'image' ? IMG_H : MEMO_H
  return { w: n.width ?? defW, h: n.height ?? defH }
}

// Only 'task' nodes participate in edges / タスク化. Legacy nodes with no kind
// are treated as 'task' — see FlowNodeKind in types.ts.
function isTask(n: FlowNode): boolean { return (n.kind ?? 'task') === 'task' }

type Viewport = { x: number; y: number; zoom: number }
type XY = { id: string; x: number; y: number }
// Right-click menu — its items depend on what was clicked: empty surface (add),
// a task node (add child/sibling, delete), or an image/memo card (delete).
type CtxMenu =
  | { kind: 'bg'; x: number; y: number; cx: number; cy: number }
  | { kind: 'task'; x: number; y: number; nodeId: string }
  | { kind: 'card'; x: number; y: number; nodeId: string }
type DragRef =
  | { kind: 'pan'; startX: number; startY: number; vx: number; vy: number }
  | { kind: 'nodes'; items: XY[]; startX: number; startY: number; moved: boolean }
  | { kind: 'group'; groupId: string; gx: number; gy: number; items: XY[]; groups: XY[]; startX: number; startY: number; moved: boolean }
  | { kind: 'group-resize'; groupId: string; startX: number; startY: number; startW: number; startH: number }
  | { kind: 'node-resize'; nodeId: string; startX: number; startY: number; startW: number; startH: number }
  | null

function toContent(vp: Viewport, rect: DOMRect, clientX: number, clientY: number) {
  return { x: (clientX - rect.left - vp.x) / vp.zoom, y: (clientY - rect.top - vp.y) / vp.zoom }
}

// First x on row `y` (starting at startX) that doesn't overlap an existing node.
// Uses each node's real size (image/memo cards can be larger/taller than a task
// node) so a spawned task doesn't land on top of a big media card.
function freeX(nodes: FlowNode[], startX: number, y: number): number {
  let x = startX
  const overlaps = (xx: number) => nodes.some(n => {
    const s = nodeSize(n)
    return xx < n.x + s.w + 8 && xx + NODE_W + 8 > n.x && y < n.y + s.h && y + NODE_H > n.y
  })
  let guard = 0
  while (overlaps(x) && guard++ < 200) x += NODE_W + SIBLING_GAP_X
  return x
}

export default function FlowPage() {
  const { state, dispatch, undo, redo, canUndo, canRedo } = useApp()
  const active = state.activeMasterProjectId
  const flows = useMemo(() => state.flows.filter(f => f.masterProjectId === active), [state.flows, active])
  const [selectedId, setSelectedId] = useState<string | null>(flows[0]?.id ?? null)
  const flow = flows.find(f => f.id === selectedId) ?? null

  useEffect(() => {
    if (selectedId && !flows.find(f => f.id === selectedId)) setSelectedId(flows[0]?.id ?? null)
    if (!selectedId && flows.length > 0) setSelectedId(flows[0].id)
  }, [flows, selectedId])

  const [viewport, setViewport] = useState<Viewport>({ x: 80, y: 60, zoom: 1 })
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([])
  const [selEdgeId, setSelEdgeId] = useState<string | null>(null)
  const [selGroupId, setSelGroupId] = useState<string | null>(null)
  const [selectRect, setSelectRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [edgeDraft, setEdgeDraft] = useState<{ fromId: string; x: number; y: number } | null>(null)
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null)
  const [convertOpen, setConvertOpen] = useState(false)
  // Outside-click / Escape closes the タスク化 popover. Ref goes on the relative
  // wrapper that also holds the trigger button, so trigger clicks don't insta-close.
  const convertWrapRef = usePopoverDismiss<HTMLDivElement>(convertOpen, () => setConvertOpen(false))
  const [convertBoardId, setConvertBoardId] = useState('__new__')
  const [convertNewBoardName, setConvertNewBoardName] = useState('')
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null)
  // Month picker popover — rendered in screen space (fixed) so its text stays
  // readable regardless of canvas zoom; anchored under the node's calendar button.
  const [monthPicker, setMonthPicker] = useState<{ nodeId: string; x: number; y: number; year: number } | null>(null)

  const surfaceRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef(viewport); viewportRef.current = viewport
  const flowRef = useRef(flow); flowRef.current = flow
  const freshNodeRef = useRef<string | null>(null)
  const dragRef = useRef<DragRef>(null)
  const selectRectRef = useRef<{ x0: number; y0: number } | null>(null)
  const spaceRef = useRef(false)
  const selNodesRef = useRef<string[]>([]); selNodesRef.current = selectedNodeIds
  const clipboardRef = useRef<{ nodes: FlowNode[]; edges: FlowEdge[] } | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // Where a context-menu "画像を追加" should drop the picked image (content coords);
  // null → the toolbar button was used, drop at the viewport centre instead.
  const pendingImagePosRef = useRef<{ x: number; y: number } | null>(null)

  const boards = useMemo(() => state.projects.filter(p => p.masterProjectId === active), [state.projects, active])
  const taskById = useMemo(() => {
    const m = new Map<string, { task: Task; boardId: string }>()
    for (const p of boards) for (const t of p.tasks) m.set(t.id, { task: t, boardId: p.id })
    return m
  }, [boards])

  const groups = flow?.groups ?? []

  const update = useCallback((updates: Partial<Flow>) => {
    const f = flowRef.current
    if (!f) return
    dispatch({ type: 'UPDATE_FLOW', payload: { ...f, ...updates, updatedAt: new Date().toISOString() } })
  }, [dispatch])

  function createFlow() {
    const f: Flow = {
      id: generateId(), masterProjectId: active, name: `フロー ${flows.length + 1}`,
      nodes: [], edges: [], groups: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }
    dispatch({ type: 'ADD_FLOW', payload: f })
    setSelectedId(f.id)
    setViewport({ x: 80, y: 60, zoom: 1 })
  }

  function deleteFlow(id: string) {
    dispatch({ type: 'DELETE_FLOW', payload: id })
    if (selectedId === id) setSelectedId(null)
  }

  const clearSelection = () => { setSelectedNodeIds([]); setSelEdgeId(null); setSelGroupId(null) }

  // ── node / edge ops (all single-UPDATE_FLOW writes off flowRef) ──

  const addNode = useCallback((x: number, y: number, parentId?: string): FlowNode => {
    const f = flowRef.current!
    const node: FlowNode = { id: generateId(), title: '', x, y, kind: 'task' }
    const edges = parentId ? [...f.edges, { id: generateId(), fromId: parentId, toId: node.id }] : f.edges
    dispatch({ type: 'SET_FLOW', payload: { ...f, nodes: [...f.nodes, node], edges, updatedAt: new Date().toISOString() } })
    freshNodeRef.current = node.id
    setSelectedNodeIds([node.id]); setSelEdgeId(null); setSelGroupId(null)
    return node
  }, [dispatch])

  // Image node — dropped centred at (x, y). The picture is decoded FIRST so the
  // card is inserted at its final aspect-fit height in a single atomic step; this
  // avoids a post-insert reflow that would (a) clobber a concurrent drag/resize,
  // (b) land on the wrong flow if the user switched, or (c) fold into an unrelated
  // undo step. Awaited by callers, so a multi-file loop stays sequential.
  const addImageNode = useCallback(async (imageUrl: string, x: number, y: number) => {
    const targetId = flowRef.current?.id
    if (!targetId) return
    const height = await new Promise<number>(resolve => {
      const img = new Image()
      img.onload = () => resolve(Math.max(MIN_H, Math.round(IMG_W * (img.naturalHeight / Math.max(1, img.naturalWidth)))))
      img.onerror = () => resolve(IMG_H) // undecodable → keep the default frame
      img.src = imageUrl
    })
    const f = flowRef.current
    if (!f || f.id !== targetId) return // user navigated to another flow mid-decode — abandon the drop
    const node: FlowNode = { id: generateId(), title: '', x: x - IMG_W / 2, y: y - height / 2, kind: 'image', imageUrl, width: IMG_W, height }
    dispatch({ type: 'SET_FLOW', payload: { ...f, nodes: [...f.nodes, node], updatedAt: new Date().toISOString() } })
    setSelectedNodeIds([node.id]); setSelEdgeId(null); setSelGroupId(null)
  }, [dispatch])

  const addMemoNode = useCallback((x: number, y: number) => {
    const f = flowRef.current
    if (!f) return
    const node: FlowNode = { id: generateId(), title: '', x: x - MEMO_W / 2, y: y - MEMO_H / 2, kind: 'memo', body: '', width: MEMO_W, height: MEMO_H }
    dispatch({ type: 'SET_FLOW', payload: { ...f, nodes: [...f.nodes, node], updatedAt: new Date().toISOString() } })
    freshNodeRef.current = node.id
    setSelectedNodeIds([node.id]); setSelEdgeId(null); setSelGroupId(null)
  }, [dispatch])

  // Read a File/Blob as data URL — used for both file-input picker and drag-drop
  // (after TIFF/TGA normalization the input may be a converted PNG Blob).
  const readFileAsDataUrl = (file: Blob): Promise<string> => new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })

  const patchNode = useCallback((id: string, patch: Partial<FlowNode>) => {
    const f = flowRef.current
    if (!f) return
    dispatch({ type: 'UPDATE_FLOW', payload: { ...f, nodes: f.nodes.map(n => n.id === id ? { ...n, ...patch } : n), updatedAt: new Date().toISOString() } })
  }, [dispatch])

  const removeNodes = useCallback((ids: string[]) => {
    const f = flowRef.current
    if (!f || ids.length === 0) return
    const set = new Set(ids)
    dispatch({
      type: 'SET_FLOW',
      payload: { ...f, nodes: f.nodes.filter(n => !set.has(n.id)), edges: f.edges.filter(e => !set.has(e.fromId) && !set.has(e.toId)), updatedAt: new Date().toISOString() },
    })
    setSelectedNodeIds([])
  }, [dispatch])

  const addEdge = useCallback((fromId: string, toId: string) => {
    const f = flowRef.current
    if (!f || fromId === toId) return
    if (f.edges.some(e => e.fromId === fromId && e.toId === toId)) return
    dispatch({ type: 'SET_FLOW', payload: { ...f, edges: [...f.edges, { id: generateId(), fromId, toId }], updatedAt: new Date().toISOString() } })
  }, [dispatch])

  const removeEdge = useCallback((id: string) => {
    const f = flowRef.current
    if (!f) return
    dispatch({ type: 'SET_FLOW', payload: { ...f, edges: f.edges.filter(e => e.id !== id), updatedAt: new Date().toISOString() } })
    setSelEdgeId(s => s === id ? null : s)
  }, [dispatch])

  // Tab: child BELOW parent (first free x on the row under it). Only task nodes
  // branch — image/memo cards have no children (would create a stray edge).
  const spawnChild = useCallback((srcId: string) => {
    const f = flowRef.current
    const src = f?.nodes.find(n => n.id === srcId)
    if (!f || !src || !isTask(src)) return
    const y = src.y + NODE_H + CHILD_GAP_Y
    addNode(freeX(f.nodes, src.x, y), y, srcId)
  }, [addNode])

  // Enter: sibling to the RIGHT on the same row (time axis), same parent.
  const spawnSibling = useCallback((srcId: string) => {
    const f = flowRef.current
    const src = f?.nodes.find(n => n.id === srcId)
    if (!f || !src || !isTask(src)) return
    const parent = f.edges.find(e => e.toId === srcId)?.fromId
    addNode(freeX(f.nodes, src.x + NODE_W + SIBLING_GAP_X, src.y), src.y, parent)
  }, [addNode])

  // ── selection ──

  const selectNode = useCallback((id: string, additive: boolean) => {
    setSelEdgeId(null); setSelGroupId(null)
    if (additive) setSelectedNodeIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
    else setSelectedNodeIds(prev => (prev.length > 1 && prev.includes(id)) ? prev : [id])
  }, [])

  // ── group ops ──

  const groupSelection = useCallback(() => {
    const f = flowRef.current
    if (!f) return
    const sel = f.nodes.filter(n => selNodesRef.current.includes(n.id))
    if (sel.length < 2) return
    const minX = Math.min(...sel.map(n => n.x)) - GROUP_PAD
    const minY = Math.min(...sel.map(n => n.y)) - GROUP_PAD
    const maxX = Math.max(...sel.map(n => n.x + nodeSize(n).w)) + GROUP_PAD
    const maxY = Math.max(...sel.map(n => n.y + nodeSize(n).h)) + GROUP_PAD
    const group: FlowGroup = { id: generateId(), title: 'グループ', x: minX, y: minY, width: maxX - minX, height: maxY - minY, createdAt: new Date().toISOString() }
    dispatch({ type: 'SET_FLOW', payload: { ...f, groups: [...(f.groups ?? []), group], updatedAt: new Date().toISOString() } })
    clearSelection(); setSelGroupId(group.id)
  }, [dispatch])

  const removeGroup = useCallback((id: string) => {
    const f = flowRef.current
    if (!f) return
    dispatch({ type: 'SET_FLOW', payload: { ...f, groups: (f.groups ?? []).filter(g => g.id !== id), updatedAt: new Date().toISOString() } })
    setSelGroupId(s => s === id ? null : s)
  }, [dispatch])

  const patchGroup = useCallback((id: string, patch: Partial<FlowGroup>) => {
    const f = flowRef.current
    if (!f) return
    dispatch({ type: 'UPDATE_FLOW', payload: { ...f, groups: (f.groups ?? []).map(g => g.id === id ? { ...g, ...patch } : g), updatedAt: new Date().toISOString() } })
  }, [dispatch])

  // ── clipboard ──

  const copySelection = useCallback(() => {
    const f = flowRef.current
    if (!f) return
    const set = new Set(selNodesRef.current)
    const nodes = f.nodes.filter(n => set.has(n.id))
    if (nodes.length === 0) return
    const edges = f.edges.filter(e => set.has(e.fromId) && set.has(e.toId))
    clipboardRef.current = { nodes: nodes.map(n => ({ ...n })), edges: edges.map(e => ({ ...e })) }
  }, [])

  const pasteClipboard = useCallback((atX?: number, atY?: number) => {
    const f = flowRef.current
    const clip = clipboardRef.current
    if (!f || !clip || clip.nodes.length === 0) return
    let ox = 28, oy = 28
    if (atX != null && atY != null) {
      ox = atX - Math.min(...clip.nodes.map(n => n.x))
      oy = atY - Math.min(...clip.nodes.map(n => n.y))
    }
    const idMap = new Map(clip.nodes.map(n => [n.id, generateId()]))
    // Pasted nodes are fresh drafts (drop the live-task link).
    const newNodes: FlowNode[] = clip.nodes.map(n => ({ ...n, id: idMap.get(n.id)!, x: n.x + ox, y: n.y + oy, taskId: undefined, boardId: undefined }))
    const newEdges: FlowEdge[] = clip.edges.map(e => ({ id: generateId(), fromId: idMap.get(e.fromId)!, toId: idMap.get(e.toId)! }))
    dispatch({ type: 'SET_FLOW', payload: { ...f, nodes: [...f.nodes, ...newNodes], edges: [...f.edges, ...newEdges], updatedAt: new Date().toISOString() } })
    setSelectedNodeIds(newNodes.map(n => n.id)); setSelEdgeId(null); setSelGroupId(null)
  }, [dispatch])

  const duplicateSelection = useCallback(() => {
    copySelection()
    // paste with the default +28/+28 offset
    setTimeout(() => pasteClipboard(), 0)
  }, [copySelection, pasteClipboard])

  // Center of the visible surface in content coords — used as the drop point for
  // image files pasted via Ctrl+V / file picker (drag-drop uses the cursor).
  const viewportCentre = useCallback(() => {
    const rect = surfaceRef.current?.getBoundingClientRect()
    const vp = viewportRef.current
    if (!rect) return { x: 200, y: 200 }
    return toContent(vp, rect, rect.left + rect.width / 2, rect.top + rect.height / 2)
  }, [])

  // Ctrl+V. The in-app node clipboard (populated by Ctrl+C on nodes) takes
  // PRECEDENCE: the two clipboards are decoupled (copySelection never writes the
  // OS clipboard), so probing the OS clipboard first would let an unrelated image
  // sitting there — a screenshot, a copied web image — hijack "select → Ctrl+C →
  // Ctrl+V" node duplication. Only when nothing was copied in-app do we probe the
  // OS clipboard for an image to drop as a card. (Images can always also be added
  // via the toolbar button or drag-drop.)
  const handlePaste = useCallback(async () => {
    if ((clipboardRef.current?.nodes.length ?? 0) > 0) { pasteClipboard(); return }
    let imageUrl: string | null = null
    try {
      const anyNav = navigator as unknown as { clipboard?: { read?: () => Promise<Array<{ types: string[]; getType: (t: string) => Promise<Blob> }>> } }
      const items = await anyNav.clipboard?.read?.()
      for (const it of items ?? []) {
        const type = it.types.find(t => t.startsWith('image/'))
        if (!type) continue
        const blob = await it.getType(type)
        imageUrl = await readFileAsDataUrl(new File([blob], 'clip', { type }))
        break
      }
    } catch {
      // clipboard.read/getType may throw (permission denied, non-secure context,
      // blob read failure) — nothing to paste in that case.
    }
    if (imageUrl) { const c = viewportCentre(); await addImageNode(imageUrl, c.x, c.y) }
  }, [pasteClipboard, addImageNode, viewportCentre])

  // ── surface interactions ──

  const onSurfaceMouseDown = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement
    if (!target.dataset.flowBg) return // only the empty background
    // Clicking empty space also drops focus from any node title input — otherwise
    // preventDefault below keeps the input focused and the INPUT keyboard guard
    // would swallow the next shortcut (Ctrl+G, Delete, …).
    const ae = document.activeElement as HTMLElement | null
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) ae.blur()
    const vp = viewportRef.current
    // Space-held or middle button → pan; otherwise rubber-band select.
    if (e.button === 1 || (e.button === 0 && spaceRef.current)) {
      dragRef.current = { kind: 'pan', startX: e.clientX, startY: e.clientY, vx: vp.x, vy: vp.y }
      e.preventDefault()
      return
    }
    if (e.button !== 0) return
    const rect = surfaceRef.current?.getBoundingClientRect()
    if (!rect) return
    const p = toContent(vp, rect, e.clientX, e.clientY)
    selectRectRef.current = { x0: p.x, y0: p.y }
    setSelectRect({ x: p.x, y: p.y, w: 0, h: 0 })
    clearSelection(); setConvertOpen(false)
    e.preventDefault()
  }

  const onSurfaceMouseMove = (e: React.MouseEvent) => {
    const rect = surfaceRef.current?.getBoundingClientRect()
    if (!rect) return
    const vp = viewportRef.current
    if (edgeDraft) {
      if (e.buttons === 0) { onSurfaceMouseUp(e); return }
      const p = toContent(vp, rect, e.clientX, e.clientY)
      setEdgeDraft(prev => prev ? { ...prev, x: p.x, y: p.y } : prev)
      return
    }
    if (selectRectRef.current) {
      if (e.buttons === 0) { onSurfaceMouseUp(e); return }
      const p = toContent(vp, rect, e.clientX, e.clientY)
      const r = selectRectRef.current
      const x = Math.min(r.x0, p.x), y = Math.min(r.y0, p.y)
      const w = Math.abs(p.x - r.x0), h = Math.abs(p.y - r.y0)
      setSelectRect({ x, y, w, h })
      const f = flowRef.current
      if (f) setSelectedNodeIds(f.nodes.filter(n => { const s = nodeSize(n); return n.x < x + w && n.x + s.w > x && n.y < y + h && n.y + s.h > y }).map(n => n.id))
      return
    }
    const d = dragRef.current
    if (!d) return
    if (e.buttons === 0) { onSurfaceMouseUp(e); return }
    if (d.kind === 'pan') {
      setViewport(v => ({ ...v, x: d.vx + (e.clientX - d.startX), y: d.vy + (e.clientY - d.startY) }))
      return
    }
    const dx = (e.clientX - d.startX) / vp.zoom
    const dy = (e.clientY - d.startY) / vp.zoom
    if ((d.kind === 'nodes' || d.kind === 'group') && !d.moved) {
      if (Math.abs(e.clientX - d.startX) < 3 && Math.abs(e.clientY - d.startY) < 3) return
      d.moved = true
    }
    const f = flowRef.current
    if (!f) return
    if (d.kind === 'nodes') {
      const origin = new Map(d.items.map(i => [i.id, i]))
      update({ nodes: f.nodes.map(n => { const o = origin.get(n.id); return o ? { ...n, x: o.x + dx, y: o.y + dy } : n }) })
    } else if (d.kind === 'group') {
      const nodeOrigin = new Map(d.items.map(i => [i.id, i]))
      const grpOrigin = new Map(d.groups.map(i => [i.id, i]))
      update({
        nodes: f.nodes.map(n => { const o = nodeOrigin.get(n.id); return o ? { ...n, x: o.x + dx, y: o.y + dy } : n }),
        groups: (f.groups ?? []).map(g => {
          if (g.id === d.groupId) return { ...g, x: d.gx + dx, y: d.gy + dy }
          const o = grpOrigin.get(g.id); return o ? { ...g, x: o.x + dx, y: o.y + dy } : g
        }),
      })
    } else if (d.kind === 'group-resize') {
      update({ groups: (f.groups ?? []).map(g => g.id === d.groupId ? { ...g, width: Math.max(120, d.startW + dx), height: Math.max(80, d.startH + dy) } : g) })
    } else if (d.kind === 'node-resize') {
      update({ nodes: f.nodes.map(n => n.id === d.nodeId ? { ...n, width: Math.max(MIN_W, d.startW + dx), height: Math.max(MIN_H, d.startH + dy) } : n) })
    }
  }

  const finishDrag = (e: React.MouseEvent, cancel = false) => {
    if (edgeDraft) {
      const rect = surfaceRef.current?.getBoundingClientRect()
      const f = flowRef.current
      if (!cancel && rect && f) {
        const p = toContent(viewportRef.current, rect, e.clientX, e.clientY)
        // Only task-kind nodes participate in edges. Dropping onto an image/memo
        // card falls through to the "empty area → new child" branch.
        const target = f.nodes.find(n => { if (!isTask(n)) return false; const s = nodeSize(n); return p.x >= n.x && p.x <= n.x + s.w && p.y >= n.y && p.y <= n.y + s.h })
        if (target && target.id !== edgeDraft.fromId) addEdge(edgeDraft.fromId, target.id)
        else if (!target) addNode(p.x - NODE_W / 2, p.y, edgeDraft.fromId)
      }
      setEdgeDraft(null)
    }
    if (selectRectRef.current) { selectRectRef.current = null; setSelectRect(null) }
    dragRef.current = null
  }
  const onSurfaceMouseUp = (e: React.MouseEvent) => finishDrag(e, false)
  const onSurfaceMouseLeave = (e: React.MouseEvent) => { if (e.buttons === 0) finishDrag(e, true) }

  // Drag-drop image files onto the surface — pluck out image/* files and drop
  // each at the cursor. Non-image drags fall through untouched.
  const onSurfaceDragOver = (e: React.DragEvent) => {
    // File names aren't exposed during dragover, so allow image/* and unknown-type
    // (empty) file drags — a .tga usually reports no MIME. onSurfaceDrop re-filters
    // by name where it's available.
    if (Array.from(e.dataTransfer.items).some(it => it.kind === 'file' && (it.type.startsWith('image/') || it.type === ''))) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  }
  const onSurfaceDrop = async (e: React.DragEvent) => {
    const files = Array.from(e.dataTransfer.files).filter(isImageFile)
    if (files.length === 0) return
    e.preventDefault()
    const rect = surfaceRef.current?.getBoundingClientRect()
    if (!rect) return
    const p = toContent(viewportRef.current, rect, e.clientX, e.clientY)
    for (let i = 0; i < files.length; i++) {
      const url = await readFileAsDataUrl(await normalizeImageBlob(files[i])) // TIFF/TGA → PNG
      await addImageNode(url, p.x + i * 20, p.y + i * 20)
    }
  }
  const onFilePicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []).filter(isImageFile)
    e.target.value = '' // reset so the same file can be picked again
    if (files.length === 0) { pendingImagePosRef.current = null; return }
    const c = pendingImagePosRef.current ?? viewportCentre()
    pendingImagePosRef.current = null
    for (let i = 0; i < files.length; i++) {
      const url = await readFileAsDataUrl(await normalizeImageBlob(files[i]))
      await addImageNode(url, c.x + i * 20, c.y + i * 20)
    }
  }

  const onSurfaceDoubleClick = (e: React.MouseEvent) => {
    if (!flow) return
    const target = e.target as HTMLElement
    if (target.closest('[data-flow-node]') || target.closest('[data-flow-group-head]')) return
    const rect = surfaceRef.current?.getBoundingClientRect()
    if (!rect) return
    const p = toContent(viewportRef.current, rect, e.clientX, e.clientY)
    addNode(p.x - NODE_W / 2, p.y - 20)
  }

  // Right-click menu — target-aware. Node vs card is decided by isTask(); an empty
  // background offers the add actions anchored at the clicked content point.
  const closeCtx = () => setCtxMenu(null)
  const onSurfaceContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    const rect = surfaceRef.current?.getBoundingClientRect()
    if (!rect) return
    const el = e.target as HTMLElement
    if (el.closest('[data-flow-group-head]')) { setCtxMenu(null); return } // group header has its own controls
    const nodeEl = el.closest('[data-node-id]') as HTMLElement | null
    if (nodeEl) {
      const id = nodeEl.dataset.nodeId!
      const node = flowRef.current?.nodes.find(n => n.id === id)
      if (!node) { setCtxMenu(null); return }
      setSelectedNodeIds([id]); setSelEdgeId(null); setSelGroupId(null)
      setCtxMenu({ kind: isTask(node) ? 'task' : 'card', x: e.clientX, y: e.clientY, nodeId: id })
    } else {
      const p = toContent(viewportRef.current, rect, e.clientX, e.clientY)
      setCtxMenu({ kind: 'bg', x: e.clientX, y: e.clientY, cx: p.x, cy: p.y })
    }
  }

  // Close the context menu / month picker on any outside click, scroll/zoom, or blur.
  useEffect(() => {
    if (!ctxMenu && !monthPicker) return
    const close = () => { setCtxMenu(null); setMonthPicker(null) }
    window.addEventListener('click', close)
    window.addEventListener('wheel', close, { passive: true })
    window.addEventListener('blur', close)
    return () => { window.removeEventListener('click', close); window.removeEventListener('wheel', close); window.removeEventListener('blur', close) }
  }, [ctxMenu, monthPicker])

  // Pinch (trackpad, arrives as ctrlKey wheel) and Cmd/Ctrl+wheel zoom anchored at
  // the cursor; a plain wheel — including a two-finger trackpad swipe — pans the
  // surface, so the MacBook trackpad can move the flow instead of only zooming.
  // Attached as a NON-passive native listener so preventDefault stops the page
  // from scrolling (React's onWheel is passive and can't preventDefault).
  useEffect(() => {
    const el = surfaceRef.current
    if (!el) return
    const handler = (e: WheelEvent) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      if (e.ctrlKey || e.metaKey) {
        const factor = wheelZoomFactor(e)
        setViewport(v => {
          const zoom = Math.max(0.2, Math.min(3, v.zoom * factor))
          const mx = e.clientX - rect.left, my = e.clientY - rect.top
          return { zoom, x: mx - ((mx - v.x) / v.zoom) * zoom, y: my - ((my - v.y) / v.zoom) * zoom }
        })
      } else {
        setViewport(v => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }))
      }
    }
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [selectedId])

  function fitToContent() {
    const f = flowRef.current
    const rect = surfaceRef.current?.getBoundingClientRect()
    if (!f || !rect || f.nodes.length === 0) { setViewport({ x: 80, y: 60, zoom: 1 }); return }
    const minX = Math.min(...f.nodes.map(n => n.x)) - 60
    const minY = Math.min(...f.nodes.map(n => n.y)) - 60
    const maxX = Math.max(...f.nodes.map(n => n.x + nodeSize(n).w)) + 60
    const maxY = Math.max(...f.nodes.map(n => n.y + nodeSize(n).h)) + 60
    const zoom = Math.max(0.2, Math.min(1.5, Math.min(rect.width / (maxX - minX), rect.height / (maxY - minY))))
    setViewport({ zoom, x: (rect.width - (maxX - minX) * zoom) / 2 - minX * zoom, y: (rect.height - (maxY - minY) * zoom) / 2 - minY * zoom })
  }

  // Arm a node drag — moving a member of a multi-selection moves the whole set.
  const startNodeDrag = (e: React.MouseEvent, node: FlowNode) => {
    if (e.button !== 0) return
    e.stopPropagation()
    // Shift-click always toggles this node's membership (add OR remove), never
    // drags — so a node can be shift-deselected out of a multi-selection too.
    if (e.shiftKey) { selectNode(node.id, true); return }
    const inMulti = selNodesRef.current.includes(node.id) && selNodesRef.current.length > 1
    if (!inMulti) selectNode(node.id, false)
    const f = flowRef.current!
    const movingIds = inMulti ? selNodesRef.current : [node.id]
    const items = f.nodes.filter(n => movingIds.includes(n.id)).map(n => ({ id: n.id, x: n.x, y: n.y }))
    dragRef.current = { kind: 'nodes', items, startX: e.clientX, startY: e.clientY, moved: false }
  }

  const startGroupDrag = (e: React.MouseEvent, group: FlowGroup) => {
    if (e.button !== 0) return
    e.stopPropagation()
    setSelGroupId(group.id); setSelectedNodeIds([]); setSelEdgeId(null)
    if (spaceRef.current) return
    const f = flowRef.current!
    // Membership by rectangle overlap (not just centre) so a resized/large card
    // that visually intersects the frame still moves with it — a centre test
    // strands cards once they grow past, or the frame shrinks below, their middle.
    const inside = (n: FlowNode) => { const s = nodeSize(n); return n.x < group.x + group.width && n.x + s.w > group.x && n.y < group.y + group.height && n.y + s.h > group.y }
    const items = f.nodes.filter(inside).map(n => ({ id: n.id, x: n.x, y: n.y }))
    const nested = (f.groups ?? []).filter(g => g.id !== group.id && g.x >= group.x && g.y >= group.y && g.x + g.width <= group.x + group.width && g.y + g.height <= group.y + group.height).map(g => ({ id: g.id, x: g.x, y: g.y }))
    dragRef.current = { kind: 'group', groupId: group.id, gx: group.x, gy: group.y, items, groups: nested, startX: e.clientX, startY: e.clientY, moved: false }
  }

  // ── keyboard (mirrors Canvas) ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ae = document.activeElement as HTMLElement | null
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT' || ae.tagName === 'BUTTON' || ae.isContentEditable)) {
        if (e.key === 'Escape') ae.blur()
        // Ctrl+Z while the (still-empty) Tab/Enter-spawned node title has focus:
        // the user means "undo the spawn", not in-field text undo. Left to the
        // browser, Chromium's document-global native undo would instead revert
        // the text typed in the PREVIOUS node's input — the spawn looks skipped.
        else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && ae.dataset.flowTitle && (ae as HTMLInputElement).value === '') {
          e.preventDefault(); ae.blur()
          if (e.shiftKey) redo(); else undo()
        }
        return
      }
      if (e.code === 'Space') { spaceRef.current = true; return }
      if (convertOpen) { if (e.key === 'Escape') setConvertOpen(false); return }
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return }
      if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return }
      if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelection(); return }
      if (mod && e.key.toLowerCase() === 'g') {
        e.preventDefault()
        if (e.shiftKey) { if (selGroupId) removeGroup(selGroupId) } else groupSelection()
        return
      }
      if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); const f = flowRef.current; if (f) { setSelectedNodeIds(f.nodes.map(n => n.id)); setSelEdgeId(null); setSelGroupId(null) } return }
      if (mod && e.key.toLowerCase() === 'c') { e.preventDefault(); copySelection(); return }
      if (mod && e.key.toLowerCase() === 'v') { e.preventDefault(); handlePaste(); return }
      if (selectedNodeIds.length > 0 && e.key.startsWith('Arrow')) {
        e.preventDefault()
        const step = e.shiftKey ? 100 : 10
        const nx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
        const ny = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0
        const f = flowRef.current
        if (f) { const set = new Set(selectedNodeIds); update({ nodes: f.nodes.map(n => set.has(n.id) ? { ...n, x: n.x + nx, y: n.y + ny } : n) }) }
        return
      }
      if (e.key === 'Escape') { clearSelection(); setConvertOpen(false); setEditingGroupId(null); setCtxMenu(null); setMonthPicker(null); return }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedNodeIds.length > 0) { e.preventDefault(); removeNodes(selectedNodeIds) }
        else if (selEdgeId) { e.preventDefault(); removeEdge(selEdgeId) }
        else if (selGroupId) { e.preventDefault(); removeGroup(selGroupId) }
        return
      }
      if (e.key === 'Tab' && selectedNodeIds.length === 1) { e.preventDefault(); spawnChild(selectedNodeIds[0]); return }
      if (e.key === 'Enter' && selectedNodeIds.length === 1) { e.preventDefault(); spawnSibling(selectedNodeIds[0]); return }
    }
    const onKeyUp = (e: KeyboardEvent) => { if (e.code === 'Space') spaceRef.current = false }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onKeyUp) }
  }, [selectedNodeIds, selEdgeId, selGroupId, convertOpen, removeNodes, removeEdge, removeGroup, groupSelection, spawnChild, spawnSibling, copySelection, handlePaste, duplicateSelection, update, undo, redo])

  // ── タスク化 (conversion) ──
  // Only 'task' kind nodes convert into real tasks; image/memo cards are
  // annotation-only and skipped by both the badge count and the conversion pass.
  const unlinkedNodes = useMemo(() => (flow?.nodes ?? []).filter(n => isTask(n) && (!n.taskId || !taskById.has(n.taskId))), [flow, taskById])

  function performConversion() {
    const f = flowRef.current
    if (!f) return
    const targets = f.nodes.filter(n => isTask(n) && (!n.taskId || !taskById.has(n.taskId)))
    if (targets.length === 0) return
    let boardId = convertBoardId
    const existing = boards.find(b => b.id === boardId)
    if (!existing) boardId = generateId()
    const targetIds = new Set(targets.map(n => n.id))
    const nodeById = new Map(f.nodes.map(n => [n.id, n]))
    const parentOf = new Map<string, { node?: string; existing?: string }>()
    for (const e of f.edges) {
      if (!targetIds.has(e.toId) || parentOf.has(e.toId) || e.fromId === e.toId) continue
      if (targetIds.has(e.fromId)) { parentOf.set(e.toId, { node: e.fromId }); continue }
      const from = nodeById.get(e.fromId)
      const linked = from?.taskId ? taskById.get(from.taskId) : undefined
      if (linked && linked.boardId === boardId) parentOf.set(e.toId, { existing: from!.taskId })
    }
    for (const id of [...parentOf.keys()]) {
      const seen = new Set([id])
      let cur = parentOf.get(id)?.node
      while (cur) { if (seen.has(cur)) { parentOf.delete(cur); break } seen.add(cur); cur = parentOf.get(cur)?.node }
    }
    const depthOf = (id: string): number => {
      let d = 0; const seen = new Set<string>(); let cur = parentOf.get(id)?.node
      while (cur && !seen.has(cur)) { seen.add(cur); d++; cur = parentOf.get(cur)?.node }
      return d
    }
    const ordered = [...targets].sort((a, b) => depthOf(a.id) - depthOf(b.id))
    const idMap = new Map(targets.map(n => [n.id, generateId()]))
    // Resolve dates in depth order so an inheriting child can read its parent's
    // already-resolved endDate (parent is a converting node or an existing task).
    const endByNode = new Map<string, string | undefined>()
    const newTasks: Task[] = ordered.map(n => {
      const p = parentOf.get(n.id)
      const endDate = n.whenInherit
        ? (p?.node ? endByNode.get(p.node) : p?.existing ? taskById.get(p.existing)?.task.endDate : undefined)
        : draftWhenToEndDate(n.when, n.whenMonth, n.whenYear)
      endByNode.set(n.id, endDate)
      const parentId = p?.node ? idMap.get(p.node) : p?.existing
      return {
        id: idMap.get(n.id)!, title: (n.title || '').trim() || '無題タスク', description: '',
        status: 'todo' as const, tags: [], createdAt: new Date().toISOString(),
        ...(endDate ? { endDate } : {}), ...(parentId ? { parentId } : {}),
      }
    })
    if (!existing) {
      dispatch({ type: 'ADD_PROJECT', payload: { id: boardId, masterProjectId: active, name: convertNewBoardName.trim() || f.name, description: '', tasks: newTasks, createdAt: new Date().toISOString() } })
    } else {
      dispatch({ type: 'SET_PROJECT_TASKS', payload: { projectId: boardId, tasks: [...existing.tasks, ...newTasks] } })
    }
    dispatch({
      type: 'UPDATE_FLOW',
      payload: { ...f, nodes: f.nodes.map(n => targetIds.has(n.id) ? { ...n, title: (n.title || '').trim() || '無題タスク', taskId: idMap.get(n.id)!, boardId, when: undefined, whenMonth: undefined, whenYear: undefined, whenInherit: undefined } : n), updatedAt: new Date().toISOString() },
    })
    setConvertOpen(false); setConvertNewBoardName('')
  }

  const cycleStatus = (t: Task, boardId: string) => {
    const next: Task['status'] = t.status === 'todo' ? 'in-progress' : t.status === 'in-progress' ? 'done' : 'todo'
    dispatch({ type: 'UPDATE_TASK', payload: { projectId: boardId, task: { ...t, status: next } } })
  }

  // Edge parent-bottom → child-top vertical bezier.
  const edgePath = (from: FlowNode, to: FlowNode) => {
    const x1 = from.x + NODE_W / 2, y1 = from.y + NODE_H
    const x2 = to.x + NODE_W / 2, y2 = to.y
    const dy = Math.max(30, Math.abs(y2 - y1) / 2)
    return `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`
  }

  return (
    <div className="flex h-full">
      {/* Flow list */}
      <div className="w-60 border-r border-slate-200 flex flex-col">
        <div className="h-14 flex items-center justify-between px-4 border-b border-slate-200">
          <h2 className="text-sm font-semibold text-slate-700">フロー</h2>
          <button onClick={createFlow} className="p-1.5 rounded hover:bg-slate-100 text-slate-500 hover:text-teal-600 transition-colors">
            <Plus size={16} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto py-2 px-2 space-y-1">
          {flows.map(f => (
            <button
              key={f.id}
              onClick={() => { setSelectedId(f.id); clearSelection() }}
              className={`w-full text-left px-3 py-2.5 rounded-lg text-sm transition-all flex items-center justify-between group ${
                selectedId === f.id ? 'bg-slate-100 text-slate-900 border border-slate-300' : 'text-slate-500 hover:text-slate-800 hover:bg-slate-100 border border-transparent'
              }`}
            >
              <span className="truncate flex items-center gap-1.5"><GitBranch size={13} className="text-teal-500 shrink-0" />{f.name}</span>
              <span className="text-[10px] text-slate-400 shrink-0 ml-2">{f.nodes.length}</span>
            </button>
          ))}
          {flows.length === 0 && <p className="text-xs text-slate-400 px-3 py-4 text-center">「＋」で新しいフローを作成</p>}
        </div>
      </div>

      {/* Flow surface */}
      <div className="flex-1 flex flex-col min-w-0">
        {flow ? (
          <>
            <div className="min-h-[3.5rem] flex flex-wrap items-center gap-2 px-4 py-2 border-b border-slate-200 shrink-0">
              <input
                type="text"
                value={flow.name}
                onChange={e => update({ name: e.target.value })}
                onKeyDown={e => { if (e.key !== 'Enter') return; if (e.nativeEvent.isComposing || (e as unknown as { keyCode: number }).keyCode === 229) return; (e.currentTarget as HTMLInputElement).blur() }}
                className="text-base font-semibold bg-transparent border-none outline-none text-slate-900 flex-1 min-w-[110px] max-w-[220px]"
                placeholder="フロー名"
              />
              <span className="text-[10px] text-slate-400 hidden lg:block">
                W-クリック=ノード / Tab=子(下) / Enter=兄弟(右) / ●下ドラッグ=接続 / Ctrl+G=グループ
              </span>
              <div className="ml-auto flex items-center gap-1">
                <button onClick={() => fileInputRef.current?.click()} title="画像カードを追加（ファイル選択 / Ctrl+V / D&D）" className="p-1.5 rounded text-slate-500 hover:text-teal-600 hover:bg-slate-100"><ImageIcon size={15} /></button>
                <button onClick={() => { const c = viewportCentre(); addMemoNode(c.x, c.y) }} title="メモカードを追加" className="p-1.5 rounded text-slate-500 hover:text-teal-600 hover:bg-slate-100"><StickyNote size={15} /></button>
                <input ref={fileInputRef} type="file" accept={IMAGE_ACCEPT} multiple onChange={onFilePicked} className="hidden" />
                {selectedNodeIds.length >= 2 && (
                  <button onClick={groupSelection} title="グループ化 (Ctrl+G)" className="p-1.5 rounded text-slate-500 hover:text-teal-600 hover:bg-slate-100"><Frame size={15} /></button>
                )}
                {unlinkedNodes.length > 0 && (
                  <div ref={convertWrapRef} className="relative">
                    <button
                      onClick={() => { setConvertOpen(v => !v); setConvertBoardId(prev => (prev !== '__new__' && boards.some(b => b.id === prev)) ? prev : (boards[0]?.id ?? '__new__')) }}
                      title="未変換ノードをまとめて実タスクに変換（エッジ = 親→子）"
                      className="px-2 py-1 rounded-md bg-teal-500/15 hover:bg-teal-500/30 text-teal-700 text-[11px] font-semibold flex items-center gap-1 transition-colors"
                    >
                      <ListChecks size={15} /> タスク化 {unlinkedNodes.length}
                    </button>
                    {convertOpen && (
                      <div className="absolute right-0 top-full mt-1.5 z-40 w-64 bg-white border border-slate-200 rounded-lg shadow-xl p-3 space-y-2" onMouseDown={e => e.stopPropagation()}>
                        <p className="text-[11px] font-semibold text-slate-700">ノード {unlinkedNodes.length}件 をタスクに変換</p>
                        <div className="space-y-1">
                          <label className="text-[10px] text-slate-500">追加先ボード</label>
                          <select value={convertBoardId} onChange={e => setConvertBoardId(e.target.value)} className="w-full text-[11px] border border-slate-200 rounded-md px-2 py-1 bg-slate-50 outline-none focus:border-teal-400">
                            {boards.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                            <option value="__new__">＋ 新しいボードを作成</option>
                          </select>
                          {convertBoardId === '__new__' && (
                            <input type="text" value={convertNewBoardName} onChange={e => setConvertNewBoardName(e.target.value)} placeholder={flow.name} className="w-full text-[11px] border border-slate-200 rounded-md px-2 py-1 outline-none focus:border-teal-400" />
                          )}
                        </div>
                        <p className="text-[10px] text-slate-400 leading-relaxed">エッジは親→子として登録。変換済みノードから繋いだ場合はそのタスクの子になります（同じボードのみ）。</p>
                        <div className="flex justify-end gap-1.5 pt-0.5">
                          <button onClick={() => setConvertOpen(false)} className="px-2 py-1 text-[11px] rounded-md text-slate-500 hover:bg-slate-100">キャンセル</button>
                          <button onClick={performConversion} className="px-2.5 py-1 text-[11px] rounded-md bg-teal-500 hover:bg-teal-600 text-white font-semibold">変換する</button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
                <button onClick={() => setViewport(v => ({ ...v, zoom: Math.max(0.2, v.zoom / 1.25) }))} title="縮小" className="p-1.5 rounded hover:bg-slate-100 text-slate-600"><ZoomOut size={16} /></button>
                <ZoomSpeedControl zoom={viewport.zoom} className="text-[10px] text-slate-500 w-10 text-center rounded hover:bg-slate-100 py-0.5" />
                <button onClick={() => setViewport(v => ({ ...v, zoom: Math.min(3, v.zoom * 1.25) }))} title="拡大" className="p-1.5 rounded hover:bg-slate-100 text-slate-600"><ZoomIn size={16} /></button>
                <button onClick={fitToContent} title="全体表示" className="p-1.5 rounded hover:bg-slate-100 text-slate-600"><Maximize size={16} /></button>
                <div className="w-px h-5 bg-slate-200 mx-1" />
                <button onClick={undo} disabled={!canUndo} title="元に戻す (Ctrl+Z)" className="p-1.5 rounded hover:bg-slate-100 text-slate-600 disabled:opacity-30"><Undo2 size={16} /></button>
                <button onClick={redo} disabled={!canRedo} title="やり直す (Ctrl+Shift+Z)" className="p-1.5 rounded hover:bg-slate-100 text-slate-600 disabled:opacity-30"><Redo2 size={16} /></button>
                <button onClick={() => deleteFlow(flow.id)} title="このフローを削除" className="p-1.5 rounded hover:bg-slate-100 text-slate-500 hover:text-rose-500"><Trash2 size={16} /></button>
              </div>
            </div>
            <div
              ref={surfaceRef}
              data-flow-bg="1"
              className="flex-1 min-h-0 relative overflow-hidden bg-slate-50 select-none"
              style={{
                cursor: dragRef.current?.kind === 'pan' ? 'grabbing' : (spaceRef.current ? 'grab' : 'default'),
                ...(20 * viewport.zoom >= 7 ? { backgroundImage: 'radial-gradient(circle, rgba(100,116,139,0.3) 1px, transparent 1.5px)', backgroundSize: `${20 * viewport.zoom}px ${20 * viewport.zoom}px`, backgroundPosition: `${viewport.x}px ${viewport.y}px` } : {}),
              }}
              onMouseDown={onSurfaceMouseDown}
              onMouseMove={onSurfaceMouseMove}
              onMouseUp={onSurfaceMouseUp}
              onMouseLeave={onSurfaceMouseLeave}
              onDoubleClick={onSurfaceDoubleClick}
              onContextMenu={onSurfaceContextMenu}
              onDragOver={onSurfaceDragOver}
              onDrop={onSurfaceDrop}
            >
              <div data-flow-bg="1" style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`, transformOrigin: '0 0', position: 'absolute', top: 0, left: 0 }}>
                {/* Groups (backmost frames) */}
                {groups.map(g => {
                  const sel = selGroupId === g.id
                  return (
                    <div key={g.id} className={`absolute rounded-xl border-2 ${sel ? 'border-teal-400 bg-teal-400/[0.05]' : 'border-slate-300 border-dashed bg-slate-400/[0.03]'}`} style={{ left: g.x, top: g.y, width: g.width, height: g.height, pointerEvents: 'none' }}>
                      <div
                        data-flow-group-head="1"
                        onMouseDown={e => startGroupDrag(e, g)}
                        onDoubleClick={e => { e.stopPropagation(); setEditingGroupId(g.id) }}
                        style={{ pointerEvents: 'auto', cursor: 'grab' }}
                        className="absolute -top-6 left-0 flex items-center gap-1 px-2 py-0.5 rounded-t-md bg-slate-100 border border-slate-300 text-[10px] text-slate-600 max-w-full"
                      >
                        <Frame size={10} className="shrink-0 text-teal-500" />
                        {editingGroupId === g.id ? (
                          <input
                            autoFocus value={g.title}
                            onChange={e => patchGroup(g.id, { title: e.target.value })}
                            onMouseDown={e => e.stopPropagation()}
                            onBlur={() => setEditingGroupId(null)}
                            onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) (e.currentTarget as HTMLInputElement).blur() }}
                            className="bg-transparent outline-none border-b border-teal-400 text-[10px] w-24"
                          />
                        ) : <span className="truncate">{g.title}</span>}
                        <button onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); removeGroup(g.id) }} title="グループ枠を削除（中のノードは残る）" className="ml-0.5 text-slate-400 hover:text-rose-500"><X size={10} /></button>
                      </div>
                      {sel && (
                        <div onMouseDown={e => { e.stopPropagation(); dragRef.current = { kind: 'group-resize', groupId: g.id, startX: e.clientX, startY: e.clientY, startW: g.width, startH: g.height } }} style={{ pointerEvents: 'auto', cursor: 'nwse-resize' }} className="absolute -bottom-1.5 -right-1.5 w-3.5 h-3.5 rounded-sm bg-teal-500 border-2 border-white" />
                      )}
                    </div>
                  )
                })}

                {/* Edges */}
                <svg className="absolute top-0 left-0 overflow-visible" style={{ width: 1, height: 1, pointerEvents: 'none' }}>
                  <defs>
                    <marker id="flow-arrowhead" markerWidth="5" markerHeight="5" refX="4.2" refY="2.5" orient="auto" markerUnits="strokeWidth">
                      <path d="M0,0 L5,2.5 L0,5 Z" fill="context-stroke" />
                    </marker>
                  </defs>
                  {flow.edges.map(e => {
                    const from = flow.nodes.find(n => n.id === e.fromId)
                    const to = flow.nodes.find(n => n.id === e.toId)
                    if (!from || !to) return null
                    const sel = selEdgeId === e.id
                    return (
                      <g key={e.id}>
                        <path d={edgePath(from, to)} fill="none" stroke="transparent" strokeWidth={14} style={{ pointerEvents: 'stroke', cursor: 'pointer' }} onMouseDown={ev => { ev.stopPropagation(); setSelEdgeId(e.id); clearSelection(); setSelEdgeId(e.id) }} />
                        <path d={edgePath(from, to)} fill="none" stroke={sel ? '#0d9488' : '#94a3b8'} strokeWidth={sel ? 3 : 2} markerEnd="url(#flow-arrowhead)" style={{ pointerEvents: 'none' }} />
                      </g>
                    )
                  })}
                  {edgeDraft && (() => {
                    const from = flow.nodes.find(n => n.id === edgeDraft.fromId)
                    if (!from) return null
                    return <path d={`M ${from.x + NODE_W / 2} ${from.y + NODE_H} L ${edgeDraft.x} ${edgeDraft.y}`} fill="none" stroke="#0d9488" strokeWidth={2} strokeDasharray="6 4" />
                  })()}
                </svg>

                {/* Nodes */}
                {flow.nodes.map(node => {
                  const kind = node.kind ?? 'task'
                  const size = nodeSize(node)
                  const selected = selectedNodeIds.includes(node.id)

                  if (kind === 'image' || kind === 'memo') {
                    const isImage = kind === 'image'
                    const shell = isImage ? 'bg-slate-100 border-slate-300' : 'bg-amber-50 border-amber-300'
                    return (
                      <div
                        key={node.id}
                        data-flow-node="1"
                        data-node-id={node.id}
                        className={`absolute ${selected ? 'ring-2 ring-teal-400/70 rounded-lg shadow-md' : ''}`}
                        style={{ left: node.x, top: node.y, width: size.w, height: size.h, cursor: 'grab' }}
                        onMouseDown={e => startNodeDrag(e, node)}
                      >
                        {/* Inner clip layer so overflow-hidden doesn't crop the resize handle. */}
                        <div className={`absolute inset-0 rounded-lg border-2 shadow-sm overflow-hidden ${shell}`}>
                          {isImage ? (
                            node.imageUrl
                              ? <img src={node.imageUrl} alt="" draggable={false} className="w-full h-full object-contain pointer-events-none select-none" />
                              : <div className="w-full h-full flex items-center justify-center text-slate-400 text-[10px]">画像がありません</div>
                          ) : (
                            <textarea
                              value={node.body ?? ''}
                              onChange={e => patchNode(node.id, { body: e.target.value })}
                              onMouseDown={e => e.stopPropagation()}
                              onFocus={() => { setSelectedNodeIds([node.id]); setSelEdgeId(null); setSelGroupId(null); if (freshNodeRef.current === node.id) freshNodeRef.current = null }}
                              onKeyDown={e => { if (e.key === 'Escape') (e.currentTarget as HTMLTextAreaElement).blur() }}
                              placeholder="メモ…"
                              autoFocus={freshNodeRef.current === node.id && !node.body}
                              className="w-full h-full resize-none bg-transparent outline-none text-[12px] text-amber-900 placeholder-amber-400/70 px-2 py-1.5 leading-snug"
                              style={{ cursor: 'text' }}
                            />
                          )}
                        </div>
                        {selected && (
                          <div
                            onMouseDown={e => { e.stopPropagation(); dragRef.current = { kind: 'node-resize', nodeId: node.id, startX: e.clientX, startY: e.clientY, startW: size.w, startH: size.h } }}
                            style={{ cursor: 'nwse-resize' }}
                            className="absolute -bottom-1.5 -right-1.5 w-3.5 h-3.5 rounded-sm bg-teal-500 border-2 border-white"
                          />
                        )}
                      </div>
                    )
                  }

                  const linked = node.taskId ? taskById.get(node.taskId) : undefined
                  const broken = !!node.taskId && !linked
                  const status = linked?.task.status
                  const hasParent = flow.edges.some(e => e.toId === node.id)
                  return (
                    <div
                      key={node.id}
                      data-flow-node="1"
                      data-node-id={node.id}
                      className={`absolute rounded-lg border-2 shadow-sm flex flex-col gap-1 px-2.5 py-2 ${
                        linked ? (status === 'done' ? 'bg-emerald-50 border-emerald-300' : status === 'in-progress' ? 'bg-amber-50 border-amber-300' : 'bg-white border-slate-300')
                          : broken ? 'bg-rose-50 border-rose-300' : 'bg-teal-50/70 border-teal-300 border-dashed'
                      } ${selected ? 'ring-2 ring-teal-400/70 shadow-md' : ''}`}
                      style={{ left: node.x, top: node.y, width: size.w, height: size.h, cursor: 'grab' }}
                      onMouseDown={e => startNodeDrag(e, node)}
                    >
                      <div className="flex items-center gap-1.5">
                        {linked ? (
                          <button title={`状態: ${status === 'done' ? '完了' : status === 'in-progress' ? '進行中' : '未着手'}（クリックで切替）`} onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); cycleStatus(linked.task, linked.boardId) }} className={`w-3 h-3 rounded-full shrink-0 border-2 ${status === 'done' ? 'bg-emerald-500 border-emerald-500' : status === 'in-progress' ? 'bg-amber-400 border-amber-400' : 'bg-white border-slate-400'}`} />
                        ) : broken ? <span title="リンク先タスクが見つかりません" className="w-3 h-3 rounded-full shrink-0 bg-rose-400" />
                          : <span className="w-3 h-3 rounded-full shrink-0 border-2 border-dashed border-teal-400" />}
                        <input
                          type="text"
                          value={linked ? linked.task.title : node.title}
                          data-flow-title="1"
                          onChange={e => { if (linked) dispatch({ type: 'UPDATE_TASK', payload: { projectId: linked.boardId, task: { ...linked.task, title: e.target.value } } }); else patchNode(node.id, { title: e.target.value }) }}
                          onMouseDown={e => e.stopPropagation()}
                          onFocus={() => { setSelectedNodeIds([node.id]); setSelEdgeId(null); setSelGroupId(null); if (freshNodeRef.current === node.id) freshNodeRef.current = null }}
                          onKeyDown={e => {
                            if (e.nativeEvent.isComposing || (e as unknown as { keyCode: number }).keyCode === 229) return
                            // stopPropagation: blur() empties activeElement BEFORE the window
                            // keydown handler runs, so without it the same Tab/Enter passes the
                            // window handler's input guard and spawns a SECOND node — built from
                            // a stale flowRef, silently replacing this one (undo then needs an
                            // extra, visually no-op step).
                            if (e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); (e.currentTarget as HTMLInputElement).blur(); spawnChild(node.id) }
                            else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); (e.currentTarget as HTMLInputElement).blur(); spawnSibling(node.id) }
                            else if (e.key === 'Escape') (e.currentTarget as HTMLInputElement).blur()
                          }}
                          placeholder="やること…"
                          autoFocus={freshNodeRef.current === node.id && !node.title}
                          className={`flex-1 min-w-0 bg-transparent text-[12px] font-medium outline-none border-b border-transparent focus:border-teal-400 placeholder-slate-400 ${status === 'done' ? 'line-through text-slate-400' : 'text-slate-800'}`}
                        />
                        {broken && <button title="リンクを解除して下書きに戻す" onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); patchNode(node.id, { taskId: undefined, boardId: undefined }) }} className="p-0.5 rounded hover:bg-rose-100 text-rose-400"><X size={11} /></button>}
                      </div>
                      {linked ? (
                        <div className="text-[9px] text-slate-400 mt-auto truncate">{boards.find(b => b.id === linked.boardId)?.name ?? ''}{linked.task.endDate ? ` ・〜${linked.task.endDate}` : ''}</div>
                      ) : node.whenInherit ? (
                        <div className="flex flex-wrap items-center gap-0.5 mt-auto">
                          <button onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); patchNode(node.id, { whenInherit: false }) }} title="親タスクの時期を継承中（クリックで解除）" className="px-1.5 py-0.5 rounded-full text-[8px] border bg-indigo-400/25 border-indigo-500 text-indigo-800 font-semibold">親継承</button>
                        </div>
                      ) : (
                        <div className="flex flex-col gap-1 mt-auto">
                          {/* Top: calendar button showing the chosen month (opens the picker). */}
                          <button
                            onMouseDown={e => e.stopPropagation()}
                            onClick={e => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); setCtxMenu(null); setMonthPicker(mp => mp?.nodeId === node.id ? null : { nodeId: node.id, x: r.left, y: r.bottom + 4, year: node.whenYear ?? new Date().getFullYear() }) }}
                            title="対象の月を選ぶ（今月＝自動で当月/翌月）"
                            className={`self-start flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[10px] transition-colors ${node.whenMonth ? 'border-teal-400 text-teal-700 bg-teal-50' : 'border-slate-200 text-slate-500 hover:border-teal-400 hover:text-teal-700'}`}
                          >
                            <CalendarDays size={11} />{node.whenMonth ? (node.whenYear ? `${node.whenYear}/${node.whenMonth}` : `${node.whenMonth}月`) : '今月'}
                          </button>
                          {/* Bottom: within-month position chips + 親継承. */}
                          <div className="flex flex-wrap items-center gap-0.5">
                            {DRAFT_WHEN_OPTIONS.map(o => (
                              <button key={o.key} onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); patchNode(node.id, { when: node.when === o.key ? undefined : o.key }) }} title={`目安: ${draftWhenToEndDate(o.key, node.whenMonth, node.whenYear)}`} className={`px-1 py-0.5 rounded-full text-[8px] border transition-colors ${node.when === o.key ? 'bg-teal-400/25 border-teal-500 text-teal-800 font-semibold' : 'border-slate-200 text-slate-400 hover:border-teal-400 hover:text-teal-700'}`}>{o.label}</button>
                            ))}
                            {hasParent && (
                              <button onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); patchNode(node.id, { whenInherit: true, when: undefined, whenMonth: undefined, whenYear: undefined }) }} title="親タスクの時期を継承する" className="px-1.5 py-0.5 rounded-full text-[8px] border border-indigo-200 text-indigo-400 hover:border-indigo-400 hover:text-indigo-700 transition-colors">親継承</button>
                            )}
                          </div>
                        </div>
                      )}
                      {/* Edge handle ● — bottom-center (child axis). Drag onto a task node = connect; empty = new child. */}
                      <button
                        title="下にドラッグして接続（親→子）/ 空きで子ノード作成"
                        onMouseDown={e => { if (e.button !== 0) return; e.stopPropagation(); const rect = surfaceRef.current?.getBoundingClientRect(); if (!rect) return; const p = toContent(viewportRef.current, rect, e.clientX, e.clientY); setEdgeDraft({ fromId: node.id, x: p.x, y: p.y }) }}
                        className="absolute left-1/2 -bottom-2 -translate-x-1/2 w-4 h-4 rounded-full bg-teal-500 border-2 border-white shadow hover:scale-125 transition-transform"
                        style={{ cursor: 'crosshair' }}
                      />
                    </div>
                  )
                })}

                {/* Rubber-band selection rect */}
                {selectRect && (selectRect.w > 0 || selectRect.h > 0) && (
                  <div className="absolute border border-teal-400 bg-teal-400/10 pointer-events-none" style={{ left: selectRect.x, top: selectRect.y, width: selectRect.w, height: selectRect.h }} />
                )}
              </div>

              {flow.nodes.length === 0 && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <div className="text-center text-slate-400 text-sm space-y-1">
                    <p>ダブルクリックでノードを追加</p>
                    <p className="text-xs">Tab=子ノード(下) / Enter=兄弟(右) / ●を下にドラッグで接続 → 「タスク化」で一括登録 / 右クリックでメニュー</p>
                  </div>
                </div>
              )}
            </div>

            {ctxMenu && (
              <div
                className="fixed z-50 min-w-[168px] bg-white border border-slate-200 rounded-lg shadow-xl py-1 text-[12px] text-slate-700"
                style={{ left: ctxMenu.x, top: ctxMenu.y }}
                onMouseDown={e => e.stopPropagation()}
                onContextMenu={e => e.preventDefault()}
              >
                {ctxMenu.kind === 'bg' && (
                  <>
                    <button onClick={() => { addNode(ctxMenu.cx - NODE_W / 2, ctxMenu.cy - 20); closeCtx() }} className="w-full text-left px-3 py-1.5 hover:bg-slate-100 flex items-center gap-2"><Plus size={13} className="text-teal-500" />タスクを追加</button>
                    <button onClick={() => { addMemoNode(ctxMenu.cx, ctxMenu.cy); closeCtx() }} className="w-full text-left px-3 py-1.5 hover:bg-slate-100 flex items-center gap-2"><StickyNote size={13} className="text-amber-500" />メモを追加</button>
                    <button onClick={() => { pendingImagePosRef.current = { x: ctxMenu.cx, y: ctxMenu.cy }; fileInputRef.current?.click(); closeCtx() }} className="w-full text-left px-3 py-1.5 hover:bg-slate-100 flex items-center gap-2"><ImageIcon size={13} className="text-slate-500" />画像を追加</button>
                  </>
                )}
                {ctxMenu.kind === 'task' && (
                  <>
                    <button onClick={() => { spawnChild(ctxMenu.nodeId); closeCtx() }} className="w-full text-left px-3 py-1.5 hover:bg-slate-100 flex items-center gap-2"><CornerDownRight size={13} className="text-teal-500" />子タスクを追加</button>
                    <button onClick={() => { spawnSibling(ctxMenu.nodeId); closeCtx() }} className="w-full text-left px-3 py-1.5 hover:bg-slate-100 flex items-center gap-2"><ArrowRight size={13} className="text-teal-500" />兄弟を追加</button>
                    <div className="h-px bg-slate-100 my-1" />
                    <button onClick={() => { removeNodes([ctxMenu.nodeId]); closeCtx() }} className="w-full text-left px-3 py-1.5 hover:bg-rose-50 text-rose-600 flex items-center gap-2"><Trash2 size={13} />削除</button>
                  </>
                )}
                {ctxMenu.kind === 'card' && (
                  <button onClick={() => { removeNodes([ctxMenu.nodeId]); closeCtx() }} className="w-full text-left px-3 py-1.5 hover:bg-rose-50 text-rose-600 flex items-center gap-2"><Trash2 size={13} />削除</button>
                )}
              </div>
            )}

            {monthPicker && (() => {
              const pm = flow.nodes.find(n => n.id === monthPicker.nodeId)
              const yr = monthPicker.year
              return (
                <div className="fixed z-50 bg-white border border-slate-200 rounded-lg shadow-xl p-2 w-[176px]" style={{ left: monthPicker.x, top: monthPicker.y }} onMouseDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()} onContextMenu={e => e.preventDefault()}>
                  <button onClick={() => { patchNode(monthPicker.nodeId, { whenMonth: undefined, whenYear: undefined }); setMonthPicker(null) }} className={`w-full mb-1 px-2 py-1 rounded text-[11px] text-left ${pm?.whenMonth == null ? 'bg-teal-500/15 text-teal-700 font-semibold' : 'hover:bg-slate-100 text-slate-600'}`}>今月（自動）</button>
                  {/* Year selector */}
                  <div className="flex items-center justify-between mb-1 px-0.5">
                    <button onClick={() => setMonthPicker(mp => mp ? { ...mp, year: mp.year - 1 } : mp)} title="前の年" className="p-0.5 rounded hover:bg-slate-100 text-slate-500"><ChevronLeft size={14} /></button>
                    <span className="text-[12px] font-semibold text-slate-700 tabular-nums">{yr}年</span>
                    <button onClick={() => setMonthPicker(mp => mp ? { ...mp, year: mp.year + 1 } : mp)} title="次の年" className="p-0.5 rounded hover:bg-slate-100 text-slate-500"><ChevronRight size={14} /></button>
                  </div>
                  <div className="grid grid-cols-4 gap-1">
                    {MONTHS.map(m => (
                      <button key={m} onClick={() => { patchNode(monthPicker.nodeId, { whenMonth: m, whenYear: yr }); setMonthPicker(null) }} className={`px-1 py-1.5 rounded text-[11px] text-center transition-colors ${pm?.whenMonth === m && pm?.whenYear === yr ? 'bg-teal-500 text-white font-semibold' : 'hover:bg-teal-50 text-slate-600 hover:text-teal-700'}`}>{m}月</button>
                    ))}
                  </div>
                </div>
              )
            })()}
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-slate-400">
            <button onClick={createFlow} className="px-4 py-2 rounded-lg bg-teal-500/10 text-teal-600 text-sm hover:bg-teal-500/20">フローを作成</button>
          </div>
        )}
      </div>
    </div>
  )
}
