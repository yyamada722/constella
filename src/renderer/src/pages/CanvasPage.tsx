import { useState, useRef, useCallback, useEffect, memo, useMemo, createElement, forwardRef, useImperativeHandle } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Plus, ZoomIn, ZoomOut, Maximize, FileText, StickyNote, CheckSquare, Globe, Lightbulb, Trash2, List, LayoutGrid, X, ExternalLink, FileDown, Image as ImageIcon, MousePointer2, ArrowUpRight, Frame, Pencil, Eraser, Type, Video, Undo2, Redo2, Grid3x3, Copy, AlignStartVertical, AlignCenterVertical, AlignEndVertical, AlignStartHorizontal, AlignCenterHorizontal, AlignEndHorizontal, AlignHorizontalSpaceBetween, AlignVerticalSpaceBetween, BringToFront, SendToBack, Ban, Lock, Unlock, ClipboardPaste, Spline, Map as MapIcon, Crop, AudioLines, Play, Pause, ImageDown, FolderKanban, ChevronDown, Check, BookmarkPlus, Clock, CornerDownLeft, Link2, Camera, Layers, SkipBack, SkipForward, GripVertical, TrainFront, Unlink, Search, ListTodo, ListChecks, Volume2, VolumeX, Shapes, Brush, Share2, ChevronRight, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, SlidersHorizontal, FolderPlus, Files as FilesGlyph } from 'lucide-react'
import { useApp, type Action } from '../store'
import { CanvasCard, CanvasTab, CanvasBoard, CardPage, CanvasArrow, CanvasGroup, CanvasStroke, CanvasLabel, CanvasRail, CanvasStation, Bookmark, Task, Note, Project, ShapeKind, PortDir, Sketch } from '../types'
import { FolderColorSwatch } from '../components/FolderColorSwatch'
import { BOARD_COLOR_CLASSES } from '../utils/boardColor'
import { generateId } from '../utils'
import { DRAFT_WHEN_OPTIONS, draftWhenToEndDate } from '../utils/draftWhen'
import { fileKind } from '../utils/fileKind'
import { PdfViewer } from '../components/PdfViewer'
import { MarkdownText } from '../components/MarkdownText'
import { ImageCropper } from '../components/ImageCropper'
import { ClippedImage } from '../components/ClippedImage'
import { putMedia, deleteMedia, isMediaRef, useMediaUrl, useMediaState, getMediaBlob, resolveMediaUrl } from '../persistence/media'
import { MediaFallback } from '../components/MediaFallback'
import { isLocalRef, localRefPath, localFileApi, localFileName, localKind, toLocalRef, getLocalBlob, type LocalKind } from '../utils/localFile'
import { freezeVideosForExport, buildShareHtml, guessMediaMime, hideExportOnlyUi, transcodeVideoBlob, type ShareOverlay } from '../utils/canvasExport'
import { alertDialog } from '../components/ConfirmDialog'
import { IMAGE_ACCEPT, isImageFile, normalizeImageBlob } from '../utils/image'
import { usePopoverDismiss } from '../components/usePopoverDismiss'
import { wheelZoomFactor } from '../utils/zoom'
import ZoomSpeedControl from '../components/ZoomSpeedControl'
import WaveSurfer from 'wavesurfer.js'
import { useStore as useMindtrainStore, PALETTE as RAIL_PALETTE, pickNextColor } from '../mindtrain/store/useStore'
import { metroPath, findInsertionIndex } from '../mindtrain/utils/path'
import { getLabelLayout } from '../mindtrain/utils/labels'
import { computeDoneRuns, autoTrainDuration } from '../mindtrain/utils/trains'
import { renderStationShape } from '../mindtrain/components/Canvas/shapes'
import { TrainSprite } from '../mindtrain/components/Canvas/TrainSprite'

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
  // スケッチカード — live-mirrors a Sketch (from the スケッチ page), rendered read-only.
  sketch: { label: 'スケッチ', icon: Brush, bg: 'bg-fuchsia-50', border: 'border-fuchsia-200', text: 'text-fuchsia-600', header: 'bg-fuchsia-100/50', defaultWidth: 320, defaultHeight: 260 },
  // 路線図カード — live-mirrors a 路線図 (mindtrain) plan, rendered read-only.
  mindtrain: { label: '路線図', icon: TrainFront, bg: 'bg-rose-50', border: 'border-rose-200', text: 'text-rose-600', header: 'bg-rose-100/50', defaultWidth: 360, defaultHeight: 260 },
  // タスク下書き — a lightweight planning sticky. Scatter these, wire parent→child
  // with arrows, then タスク化 converts the whole flow into real tasks.
  taskDraft: { label: 'タスク下書き', icon: ListTodo, bg: 'bg-yellow-50', border: 'border-yellow-400 border-dashed', text: 'text-yellow-700', header: 'bg-yellow-100/60', defaultWidth: 210, defaultHeight: 112 },
  // キャンバスリンク — 別キャンバス(タブ)へのショートカット。クリックでジャンプ。
  canvasLink: { label: 'キャンバスリンク', icon: LayoutGrid, bg: 'bg-indigo-50', border: 'border-indigo-300', text: 'text-indigo-600', header: 'bg-indigo-100/60', defaultWidth: 240, defaultHeight: 190 },
  // 構成図シェイプ — headerless outlined figure; which figure is card.shape.
  // Excluded from the generic add menus (they get a dedicated shape grid instead).
  shape: { label: 'シェイプ', icon: Shapes, bg: 'bg-white', border: 'border-slate-300', text: 'text-slate-500', header: 'bg-slate-50', defaultWidth: 200, defaultHeight: 120 },
} as const

// Stable empty array so cards WITHOUT the picker open don't re-render (memo)
// every time the checked set changes in the one card that has it open.
const EMPTY_IDS: string[] = []

/* ── 構成図シェイプ ── */

const SHAPE_KINDS: { key: ShapeKind; label: string }[] = [
  { key: 'rect', label: '四角形' },
  { key: 'roundRect', label: '角丸四角' },
  { key: 'ellipse', label: '円 / 楕円' },
  { key: 'diamond', label: 'ひし形' },
  { key: 'triangle', label: '三角形' },
  { key: 'parallelogram', label: '平行四辺形' },
  { key: 'hexagon', label: '六角形' },
  { key: 'cylinder', label: '円柱 (DB)' },
  { key: 'cloud', label: 'クラウド' },
  { key: 'file', label: 'ファイル' },
  { key: 'folder', label: 'フォルダー' },
  { key: 'person', label: '人' },
  { key: 'pc', label: 'PC' },
  { key: 'server', label: 'サーバー' },
]

const SHAPE_DEFAULT_SIZE: Record<ShapeKind, { w: number; h: number }> = {
  rect: { w: 200, h: 120 },
  roundRect: { w: 200, h: 120 },
  ellipse: { w: 180, h: 120 },
  diamond: { w: 200, h: 140 },
  triangle: { w: 200, h: 150 },
  parallelogram: { w: 220, h: 120 },
  hexagon: { w: 210, h: 120 },
  cylinder: { w: 160, h: 160 },
  cloud: { w: 240, h: 150 },
  file: { w: 130, h: 160 },
  folder: { w: 190, h: 140 },
  person: { w: 120, h: 150 },
  pc: { w: 170, h: 150 },
  server: { w: 140, h: 180 },
}

// SVG path(s) for a shape drawn at (w × h) px. `outline` is the closed figure
// (filled + stroked); `extras` are stroke-only decorations (e.g. cylinder rim).
function shapePaths(kind: ShapeKind, w: number, h: number): { outline: string; extras: string[] } {
  const p = 1.5 // inset so a 2px stroke isn't clipped at the svg edge
  const cx = w / 2, cy = h / 2
  const R = w - p, B = h - p
  switch (kind) {
    case 'roundRect': {
      const r = Math.max(2, Math.min(14, (w - 2 * p) / 4, (h - 2 * p) / 4))
      return { outline: `M ${p + r} ${p} H ${R - r} A ${r} ${r} 0 0 1 ${R} ${p + r} V ${B - r} A ${r} ${r} 0 0 1 ${R - r} ${B} H ${p + r} A ${r} ${r} 0 0 1 ${p} ${B - r} V ${p + r} A ${r} ${r} 0 0 1 ${p + r} ${p} Z`, extras: [] }
    }
    case 'ellipse': {
      const rx = cx - p, ry = cy - p
      return { outline: `M ${p} ${cy} A ${rx} ${ry} 0 1 0 ${R} ${cy} A ${rx} ${ry} 0 1 0 ${p} ${cy} Z`, extras: [] }
    }
    case 'diamond':
      return { outline: `M ${cx} ${p} L ${R} ${cy} L ${cx} ${B} L ${p} ${cy} Z`, extras: [] }
    case 'triangle':
      return { outline: `M ${cx} ${p} L ${R} ${B} L ${p} ${B} Z`, extras: [] }
    case 'parallelogram': {
      const o = Math.min((w - 2 * p) * 0.22, 48)
      return { outline: `M ${p + o} ${p} L ${R} ${p} L ${R - o} ${B} L ${p} ${B} Z`, extras: [] }
    }
    case 'hexagon': {
      const o = Math.min((w - 2 * p) * 0.25, (h - 2 * p) * 0.6)
      return { outline: `M ${p + o} ${p} L ${R - o} ${p} L ${R} ${cy} L ${R - o} ${B} L ${p + o} ${B} L ${p} ${cy} Z`, extras: [] }
    }
    case 'cylinder': {
      const ry = Math.max(3, Math.min((h - 2 * p) * 0.18, 26))
      const rx = cx - p
      return {
        outline: `M ${p} ${p + ry} A ${rx} ${ry} 0 0 1 ${R} ${p + ry} L ${R} ${B - ry} A ${rx} ${ry} 0 0 1 ${p} ${B - ry} Z`,
        extras: [`M ${p} ${p + ry} A ${rx} ${ry} 0 0 0 ${R} ${p + ry}`],
      }
    }
    case 'cloud': {
      const W = w - 2 * p, H = h - 2 * p
      const X = (f: number) => p + W * f, Y = (f: number) => p + H * f
      return {
        outline: `M ${X(0.22)} ${Y(0.82)} A ${W * 0.16} ${H * 0.24} 0 0 1 ${X(0.30)} ${Y(0.38)} A ${W * 0.17} ${H * 0.22} 0 0 1 ${X(0.56)} ${Y(0.26)} A ${W * 0.16} ${H * 0.20} 0 0 1 ${X(0.79)} ${Y(0.42)} A ${W * 0.13} ${H * 0.19} 0 0 1 ${X(0.80)} ${Y(0.82)} Z`,
        extras: [],
      }
    }
    case 'file': { // document with a folded top-right corner
      const f = Math.min((w - 2 * p) * 0.3, (h - 2 * p) * 0.3, 26)
      return {
        outline: `M ${p} ${p} L ${R - f} ${p} L ${R} ${p + f} L ${R} ${B} L ${p} ${B} Z`,
        extras: [`M ${R - f} ${p} L ${R - f} ${p + f} L ${R} ${p + f}`],
      }
    }
    case 'folder': {
      const th = Math.min((h - 2 * p) * 0.18, 20) // tab height
      const tw = Math.min((w - 2 * p) * 0.4, 90)  // tab width
      return {
        outline: `M ${p} ${B} L ${p} ${p + th} L ${p + 3} ${p} L ${p + tw} ${p} L ${p + tw + 6} ${p + th} L ${R} ${p + th} L ${R} ${B} Z`,
        extras: [],
      }
    }
    case 'person': { // head circle + shoulder dome
      const hr = Math.min(w * 0.18, h * 0.16)
      const bw = Math.min(w * 0.3, (w - 2 * p) / 2)
      const bodyTop = p + 2 * hr + Math.max(2, h * 0.04)
      return {
        outline: `M ${cx} ${p} A ${hr} ${hr} 0 1 0 ${cx} ${p + 2 * hr} A ${hr} ${hr} 0 1 0 ${cx} ${p} Z ` +
          `M ${cx - bw} ${B} A ${bw} ${B - bodyTop} 0 0 1 ${cx + bw} ${B} Z`,
        extras: [],
      }
    }
    case 'pc': { // monitor + stand + base
      const sh = (h - 2 * p) * 0.62 // screen height
      return {
        outline: `M ${p} ${p} H ${R} V ${p + sh} H ${p} Z`,
        extras: [
          `M ${cx} ${p + sh} L ${cx} ${B - 4}`,
          `M ${cx - w * 0.18} ${B - 3} L ${cx + w * 0.18} ${B - 3}`,
        ],
      }
    }
    case 'server': { // rack with 3 bays + LED ticks
      const H = h - 2 * p
      const r = 4
      const y1 = p + H / 3, y2 = p + (2 * H) / 3
      return {
        outline: `M ${p + r} ${p} H ${R - r} A ${r} ${r} 0 0 1 ${R} ${p + r} V ${B - r} A ${r} ${r} 0 0 1 ${R - r} ${B} H ${p + r} A ${r} ${r} 0 0 1 ${p} ${B - r} V ${p + r} A ${r} ${r} 0 0 1 ${p + r} ${p} Z`,
        extras: [
          `M ${p} ${y1} L ${R} ${y1}`,
          `M ${p} ${y2} L ${R} ${y2}`,
          `M ${p + 8} ${p + H / 6} L ${p + 18} ${p + H / 6}`,
          `M ${p + 8} ${p + H / 2} L ${p + 18} ${p + H / 2}`,
          `M ${p + 8} ${p + (5 * H) / 6} L ${p + 18} ${p + (5 * H) / 6}`,
        ],
      }
    }
    case 'rect':
    default:
      return { outline: `M ${p} ${p} H ${R} V ${B} H ${p} Z`, extras: [] }
  }
}

// Tiny outline preview used in the add-menu / context-menu shape grids.
function ShapeGlyph({ kind }: { kind: ShapeKind }) {
  const { outline, extras } = shapePaths(kind, 22, 15)
  return (
    <svg width={22} height={15} viewBox="0 0 22 15" className="shrink-0">
      <path d={outline} fill="none" stroke="currentColor" strokeWidth={1.2} strokeLinejoin="round" />
      {extras.map((d, i) => <path key={i} d={d} fill="none" stroke="currentColor" strokeWidth={1.2} />)}
    </svg>
  )
}

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
        {card.draftWhen ? `期日目安 ${draftWhenToEndDate(card.draftWhen)}` : 'Tab=子 / Enter=兄弟 / 下端子で親子付け'}
      </div>
    </div>
  )
})

/* ── スケッチカード body ── */
// Read-only mirror of a Sketch. All editing stays on the スケッチ page; here we
// just render its strokes as an auto-fitted <svg>.
const SketchCardBody = memo(function SketchCardBody({ sketch, onUnlink, locked }: {
  sketch: Sketch
  onUnlink: () => void
  locked: boolean
}) {
  // Fit every stroke into the card: bbox over all points + a small padding.
  // Memoized on the stroke array so canvas pan/zoom re-renders stay cheap.
  const fit = useMemo(() => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const s of sketch.strokes) {
      for (let i = 0; i < s.points.length; i += 2) {
        const x = s.points[i], y = s.points[i + 1]
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
    }
    if (!isFinite(minX)) return null
    const pad = 8
    minX -= pad; minY -= pad; maxX += pad; maxY += pad
    return { viewBox: `${minX} ${minY} ${maxX - minX} ${maxY - minY}` }
  }, [sketch.strokes])

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="px-3 py-1 border-b border-slate-200/60 flex items-center gap-1 text-[10px] text-slate-500 shrink-0">
        <Link2 size={10} className="text-fuchsia-400 shrink-0" />
        <span className="truncate flex-1" title={sketch.name}>{sketch.name || '(無題)'}</span>
        {!locked && (
          <button
            onMouseDown={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); onUnlink() }}
            title="リンクを解除"
            className="p-0.5 rounded hover:bg-slate-100 text-slate-400 hover:text-rose-500 shrink-0"
          >
            <Unlink size={10} />
          </button>
        )}
      </div>
      {fit ? (
        <svg
          viewBox={fit.viewBox}
          preserveAspectRatio="xMidYMid meet"
          className="w-full h-full flex-1 min-h-0"
          style={{ pointerEvents: 'none' }}
        >
          {sketch.strokes.map((s, i) => {
            let pts = ''
            for (let j = 0; j < s.points.length; j += 2) pts += `${s.points[j]},${s.points[j + 1]} `
            return (
              <polyline
                key={i}
                points={pts.trim()}
                fill="none"
                stroke={s.color}
                strokeWidth={s.width}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )
          })}
        </svg>
      ) : (
        <div className="flex-1 min-h-0 flex items-center justify-center text-[11px] text-slate-400">（空のスケッチ）</div>
      )}
    </div>
  )
})

/* ── 路線図カード body ── */
// Read-only mirror of a 路線図 (mindtrain) plan. Editing stays on the 路線図 page;
// here we redraw its lines/stations/annotations as an auto-fitted <svg>, sourced
// live from the mindtrain store so edits propagate. The active plan lives in the
// store's flat fields (its `workspaces` snapshot is only synced on plan switch),
// so we read flat state when mirroring the active plan.
const MT_STATION_SIZE = 16
const MT_TRANSFER_SIZE = 20

// 駅の状態3ピル — コンテキストメニューとプロパティパネルで共有（語彙と
// 見た目を1箇所に）。hoverCls だけ設置面の背景に合わせて差し替え可。
const STATION_STATUS_OPTIONS = [['todo', '計画中'], ['doing', '建設中'], ['done', '開業']] as const
const StationStatusPills = memo(function StationStatusPills({ status, disabled, hoverCls = 'hover:bg-slate-50', onChange }: {
  status: CanvasStation['status']
  disabled?: boolean
  hoverCls?: string
  onChange: (s: CanvasStation['status']) => void
}) {
  return (
    <div className="flex gap-1">
      {STATION_STATUS_OPTIONS.map(([k, lbl]) => (
        <button
          key={k}
          disabled={disabled}
          onClick={() => onChange(k)}
          className={`px-2 py-0.5 rounded-full text-[10px] border transition-colors ${status === k ? 'bg-rose-500/15 border-rose-400 text-rose-600 font-semibold' : `border-slate-200 text-slate-500 ${hoverCls}`}`}
        >{lbl}</button>
      ))}
    </div>
  )
})

const MindtrainCardBody = memo(function MindtrainCardBody({ planId, onUnlink, locked }: {
  planId: string
  onUnlink: () => void
  locked: boolean
}) {
  // 貼り付け/複製で別マスタープロジェクトのプランを指すことがある。ジャンプ側と
  // 同様に所属一致をガードし、他プロジェクトの路線図は描画しない（内容リーク防止）。
  const { state: appState } = useApp()
  const meta = useMindtrainStore(s => s.workspaceMeta[planId])
  // Active plan → flat fields; any other plan → its stored snapshot.
  const stations = useMindtrainStore(s => (s.activeWorkspaceId === planId ? s.stations : s.workspaces[planId]?.stations))
  const lines = useMindtrainStore(s => (s.activeWorkspaceId === planId ? s.lines : s.workspaces[planId]?.lines))
  const lineOrder = useMindtrainStore(s => (s.activeWorkspaceId === planId ? s.lineOrder : s.workspaces[planId]?.lineOrder))
  const annotations = useMindtrainStore(s => (s.activeWorkspaceId === planId ? s.annotations : s.workspaces[planId]?.annotations))
  const annotationOrder = useMindtrainStore(s => (s.activeWorkspaceId === planId ? s.annotationOrder : s.workspaces[planId]?.annotationOrder))

  if (!meta || !stations || !lines) {
    return (
      <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-2 px-3 py-4 text-center">
        <span className="text-[11px] text-slate-500">リンク先が見つかりません</span>
        {!locked && (
          <button
            onMouseDown={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); onUnlink() }}
            className="text-[10px] px-2 py-0.5 rounded border border-slate-300 text-slate-600 hover:bg-slate-100"
          >リンクを解除</button>
        )}
      </div>
    )
  }

  if (meta.projectId !== appState.activeMasterProjectId) {
    return (
      <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-2 px-3 py-4 text-center">
        <span className="text-[11px] text-slate-500">別プロジェクトの路線図です（内容は表示されません）</span>
        {!locked && (
          <button
            onMouseDown={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); onUnlink() }}
            className="text-[10px] px-2 py-0.5 rounded border border-slate-300 text-slate-600 hover:bg-slate-100"
          >リンクを解除</button>
        )}
      </div>
    )
  }

  const stationList = Object.values(stations)
  const annList = (annotationOrder ?? []).map(id => annotations?.[id]).filter((a): a is NonNullable<typeof a> => !!a)
  // Fit everything into the card: bbox over stations (+ label headroom) and annotations.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const st of stationList) {
    if (st.x < minX) minX = st.x; if (st.y < minY) minY = st.y
    if (st.x > maxX) maxX = st.x; if (st.y > maxY) maxY = st.y
  }
  for (const a of annList) {
    const w = a.kind === 'label' ? 0 : a.width
    const h = a.kind === 'label' ? 0 : a.height
    if (a.x < minX) minX = a.x; if (a.y < minY) minY = a.y
    if (a.x + w > maxX) maxX = a.x + w; if (a.y + h > maxY) maxY = a.y + h
  }
  const empty = !isFinite(minX)
  const pad = 44 // room for station labels around the edge
  const viewBox = empty ? '' : `${minX - pad} ${minY - pad} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}`

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="px-3 py-1 border-b border-slate-200/60 flex items-center gap-1 text-[10px] text-slate-500 shrink-0">
        <Link2 size={10} className="text-rose-400 shrink-0" />
        <span className="truncate flex-1" title={meta.name}>{meta.name || '(無題)'}</span>
        {!locked && (
          <button
            onMouseDown={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); onUnlink() }}
            title="リンクを解除"
            className="p-0.5 rounded hover:bg-slate-100 text-slate-400 hover:text-rose-500 shrink-0"
          >
            <Unlink size={10} />
          </button>
        )}
      </div>
      {empty ? (
        <div className="flex-1 min-h-0 flex items-center justify-center text-[11px] text-slate-400">（空の路線図）</div>
      ) : (
        <svg
          viewBox={viewBox}
          preserveAspectRatio="xMidYMid meet"
          className="w-full h-full flex-1 min-h-0"
          style={{ pointerEvents: 'none' }}
        >
          {/* Annotations underneath (same stacking as the 路線図 page) */}
          {annList.map(a => a.kind === 'area' ? (
            <g key={a.id}>
              <rect x={a.x} y={a.y} width={a.width} height={a.height} rx={10} fill={a.color} fillOpacity={0.12} stroke={a.color} strokeOpacity={0.5} strokeWidth={1.5} />
              {a.text && <text x={a.x + 8} y={a.y + 16} fontSize={12} fontWeight={600} fill={a.color}>{a.text}</text>}
            </g>
          ) : a.kind === 'image' ? (
            <rect key={a.id} x={a.x} y={a.y} width={a.width} height={a.height} rx={4} fill="#e2e8f0" fillOpacity={0.6} stroke="#cbd5e1" />
          ) : null)}
          {/* Line paths through their stations */}
          {(lineOrder ?? []).map(lid => {
            const line = lines[lid]
            if (!line || line.stationIds.length < 2) return null
            const pts = line.stationIds.map(sid => stations[sid]).filter(Boolean).map(s => ({ x: s.x, y: s.y }))
            if (pts.length < 2) return null
            return <path key={lid} d={metroPath(pts)} fill="none" stroke={line.color} strokeWidth={9} strokeLinecap="round" strokeLinejoin="round" />
          })}
          {/* Stations + name labels */}
          {stationList.map(st => {
            const isTransfer = st.lineIds.length >= 2
            const strokeColor = st.color ?? (isTransfer ? '#1a1d22' : lines[st.lineIds[0]]?.color ?? '#888')
            const size = isTransfer ? MT_TRANSFER_SIZE : MT_STATION_SIZE
            const planned = st.status === 'todo'
            const layout = getLabelLayout(st.labelDir ?? 'n', size / 2, 4)
            return (
              <g key={st.id} opacity={planned ? 0.55 : 1}>
                <g strokeDasharray={planned ? '4 3' : undefined}>
                  {renderStationShape({ shape: st.shape ?? 'rounded-square', cx: st.x, cy: st.y, size, fill: '#ffffff', stroke: strokeColor, strokeWidth: 4 })}
                </g>
                <text
                  x={st.x + layout.dx} y={st.y + layout.dy}
                  textAnchor={layout.anchor} dominantBaseline={layout.baseline}
                  fontSize={12.5} fontWeight={planned ? 500 : 700} fill="#1f2937"
                  style={{ paintOrder: 'stroke', stroke: '#ffffff', strokeWidth: 3, strokeLinejoin: 'round' }}
                >{st.name}</text>
              </g>
            )
          })}
          {/* Free-standing text labels on top */}
          {annList.map(a => a.kind === 'label' ? (
            <text key={a.id} x={a.x} y={a.y} fontSize={a.fontSize ?? 14} fontWeight={a.fontWeight ?? 600} fill={a.color ?? '#334155'}>{a.text}</text>
          ) : null)}
        </svg>
      )}
    </div>
  )
})

// Picker list for 'mindtrain' cards — the current master project's 路線図 plans.
// Own component so only an open picker subscribes to the mindtrain store.
const MindtrainPlanPickerList = memo(function MindtrainPlanPickerList({ projectId, search, onPick }: {
  projectId: string
  search: string
  onPick: (planId: string, name: string) => void
}) {
  const workspaceOrder = useMindtrainStore(s => s.workspaceOrder)
  const workspaceMeta = useMindtrainStore(s => s.workspaceMeta)
  const workspaces = useMindtrainStore(s => s.workspaces)
  const activeWorkspaceId = useMindtrainStore(s => s.activeWorkspaceId)
  const activeStations = useMindtrainStore(s => s.stations)
  const plans = workspaceOrder
    .filter(id => workspaceMeta[id]?.projectId === projectId)
    .filter(id => !search || (workspaceMeta[id].name || '').toLowerCase().includes(search.toLowerCase()))
  if (plans.length === 0) {
    return <div className="px-1.5 py-2 text-[10px] text-slate-400 text-center">候補がありません</div>
  }
  return (
    <>
      {plans.map(id => {
        const meta = workspaceMeta[id]
        const stationCount = Object.keys(id === activeWorkspaceId ? activeStations : workspaces[id]?.stations ?? {}).length
        return (
          <button
            key={id}
            className="w-full text-left px-1.5 py-1 hover:bg-slate-50 rounded text-xs text-slate-700 truncate flex items-center gap-1"
            onClick={() => onPick(id, meta.name)}
            title={meta.name}
          >
            <TrainFront size={11} className="text-rose-400 shrink-0" />
            <span className="truncate">{meta.name || '(無題)'}</span>
            <span className="ml-auto text-[9px] text-slate-400 shrink-0">{stationCount}駅</span>
          </button>
        )
      })}
    </>
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
// タスク親子付けライン — drawn from a task terminal; visually distinct from
// ordinary arrows (emerald, thicker) so structure edges read differently.
const TASK_LINK_COLOR = '#10b981'
const TASK_LINK_WIDTH = 3
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

// Point on a card's border along the line from its center toward (tx, ty).
// Shape cards get figure-aware intersection for ellipse / diamond so arrows
// touch the drawn outline, not the invisible bounding box; other figures use
// the rect approximation.
function cardBorderPoint(card: CanvasCard, tx: number, ty: number) {
  const cx = card.x + card.width / 2, cy = card.y + card.height / 2
  const dx = tx - cx, dy = ty - cy
  if (dx === 0 && dy === 0) return { x: cx, y: cy }
  const a = card.width / 2, b = card.height / 2
  let s: number
  if (card.type === 'shape' && card.shape === 'ellipse') {
    s = 1 / Math.hypot(dx / a, dy / b)
  } else if (card.type === 'shape' && card.shape === 'diamond') {
    s = 1 / (Math.abs(dx) / a + Math.abs(dy) / b)
  } else {
    s = 1 / Math.max(Math.abs(dx) / a, Math.abs(dy) / b)
  }
  return { x: cx + dx * s, y: cy + dy * s }
}

/* ── 接続ポート（8方位） ── */

const PORT_DIRS: PortDir[] = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']
const PORT_SNAP_SCREEN = 18 // snap radius in SCREEN px (divide by zoom for canvas units)

// The 8 connection-port anchors on a card's outline. Plain cards use the
// bounding box; shape cards place ports on the figure's silhouette (matching
// shapePaths geometry, ignoring its 1.5px stroke inset) so arrows dock onto
// the drawn outline, not the invisible bbox.
function portPoint(card: CanvasCard, dir: PortDir): { x: number; y: number } {
  const { x, y, width: w, height: h } = card
  const cx = x + w / 2, cy = y + h / 2
  const kind = card.type === 'shape' ? (card.shape ?? 'rect') : 'rect'
  let t: Record<PortDir, [number, number]>
  switch (kind) {
    case 'ellipse':
    case 'cloud': { // cloud ≈ inscribed ellipse — close enough for its fuzzy outline
      const a = w / 2, b = h / 2, k = Math.SQRT1_2
      t = { n: [cx, y], ne: [cx + a * k, cy - b * k], e: [x + w, cy], se: [cx + a * k, cy + b * k], s: [cx, y + h], sw: [cx - a * k, cy + b * k], w: [x, cy], nw: [cx - a * k, cy - b * k] }
      break
    }
    case 'diamond': // vertices + edge midpoints
      t = { n: [cx, y], ne: [cx + w / 4, y + h / 4], e: [x + w, cy], se: [cx + w / 4, y + h * 0.75], s: [cx, y + h], sw: [cx - w / 4, y + h * 0.75], w: [x, cy], nw: [cx - w / 4, y + h / 4] }
      break
    case 'triangle': { // apex + base corners + thirds of the slanted edges
      const rp = (f: number): [number, number] => [cx + (w / 2) * f, y + h * f]
      const lp = (f: number): [number, number] => [cx - (w / 2) * f, y + h * f]
      t = { n: [cx, y], ne: rp(1 / 3), e: rp(2 / 3), se: [x + w, y + h], s: [cx, y + h], sw: [x, y + h], w: lp(2 / 3), nw: lp(1 / 3) }
      break
    }
    case 'parallelogram': {
      const o = Math.min((w - 3) * 0.22, 48)
      t = { n: [x + (w + o) / 2, y], ne: [x + w, y], e: [x + w - o / 2, cy], se: [x + w - o, y + h], s: [x + (w - o) / 2, y + h], sw: [x, y + h], w: [x + o / 2, cy], nw: [x + o, y] }
      break
    }
    case 'hexagon': {
      const o = Math.min((w - 3) * 0.25, (h - 3) * 0.6)
      t = { n: [cx, y], ne: [x + w - o, y], e: [x + w, cy], se: [x + w - o, y + h], s: [cx, y + h], sw: [x + o, y + h], w: [x, cy], nw: [x + o, y] }
      break
    }
    case 'cylinder': {
      const ry = Math.max(3, Math.min((h - 3) * 0.18, 26))
      t = { n: [cx, y], ne: [x + w, y + ry], e: [x + w, cy], se: [x + w, y + h - ry], s: [cx, y + h], sw: [x, y + h - ry], w: [x, cy], nw: [x, y + ry] }
      break
    }
    case 'roundRect': { // corners pulled onto the rounded arc
      const r = Math.max(2, Math.min(14, (w - 3) / 4, (h - 3) / 4))
      const c = r * (1 - Math.SQRT1_2)
      t = { n: [cx, y], ne: [x + w - c, y + c], e: [x + w, cy], se: [x + w - c, y + h - c], s: [cx, y + h], sw: [x + c, y + h - c], w: [x, cy], nw: [x + c, y + c] }
      break
    }
    default: // rect + every non-shape card: bounding box
      t = { n: [cx, y], ne: [x + w, y], e: [x + w, cy], se: [x + w, y + h], s: [cx, y + h], sw: [x, y + h], w: [x, cy], nw: [x, y] }
  }
  const [px, py] = t[dir]
  return { x: px, y: py }
}

// Resolve an arrow's visual endpoints: a port-anchored end sits at that fixed
// port; a portless attached end follows its card (clipped to border toward the
// other end); a free end keeps its stored coordinates.
function resolveArrowEnds(arrow: CanvasArrow, byId: Map<string, CanvasCard>) {
  const fc = arrow.fromCardId ? byId.get(arrow.fromCardId) : undefined
  const tc = arrow.toCardId ? byId.get(arrow.toCardId) : undefined
  let p1 = fc
    ? (arrow.fromPort ? portPoint(fc, arrow.fromPort) : { x: fc.x + fc.width / 2, y: fc.y + fc.height / 2 })
    : { x: arrow.x1, y: arrow.y1 }
  let p2 = tc
    ? (arrow.toPort ? portPoint(tc, arrow.toPort) : { x: tc.x + tc.width / 2, y: tc.y + tc.height / 2 })
    : { x: arrow.x2, y: arrow.y2 }
  // A portless attached end aims at the NEAREST waypoint (not the far end) so
  // the border exit follows the bent path's first segment.
  const wps = arrow.points ?? []
  const t1 = wps[0] ?? p2
  const t2 = wps[wps.length - 1] ?? p1
  if (fc && !arrow.fromPort) p1 = cardBorderPoint(fc, t1.x, t1.y)
  if (tc && !arrow.toPort) p2 = cardBorderPoint(tc, wps.length ? t2.x : p1.x, wps.length ? t2.y : p1.y)
  return { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y }
}

// Arrow path + label point. With waypoints → polyline (curved is ignored);
// otherwise straight L or curved quadratic Q. Label sits at the half-length
// point of the path.
function arrowGeometry(e: { x1: number; y1: number; x2: number; y2: number }, curved?: boolean, points?: { x: number; y: number }[]) {
  if (points && points.length) {
    const pts = [{ x: e.x1, y: e.y1 }, ...points, { x: e.x2, y: e.y2 }]
    let total = 0
    for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
    let half = total / 2
    let lx = pts[0].x, ly = pts[0].y
    for (let i = 1; i < pts.length; i++) {
      const seg = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
      if (seg >= half) {
        const t = seg === 0 ? 0 : half / seg
        lx = pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t
        ly = pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t
        break
      }
      half -= seg
    }
    return { d: 'M ' + pts.map(pt => `${pt.x} ${pt.y}`).join(' L '), lx, ly }
  }
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
  kind: 'pan' | 'card' | 'resize' | 'arrow-p1' | 'arrow-p2' | 'arrow-way' | 'group-move' | 'group-resize' | 'label-move' | 'select-rect'
  cardId?: string
  cards?: { id: string; x: number; y: number }[]
  arrow?: CanvasArrow
  wayIndex?: number // 'arrow-way': which entry of arrow.points is being dragged
  // 'card': arrows moved alongside (free ends + waypoints); filled lazily on first move.
  arrows?: CanvasArrow[]
  group?: CanvasGroup
  groupCards?: { id: string; x: number; y: number }[]
  groupGroups?: CanvasGroup[]
  // Labels moved alongside the drag: the selected labels (kind 'card') or the
  // labels contained in a dragged group (kind 'group-move').
  labels?: CanvasLabel[]
  // 駅 moved alongside the drag (kind 'card'): mixed marquee selections move as one.
  stations?: CanvasStation[]
  // グループ枠 moved alongside the drag (kind 'card'): 全選択/範囲選択に含まれた
  // 枠は「枠だけ」動く — 中身は自身が選択されていれば cards/labels/stations 側で動く。
  groups?: CanvasGroup[]
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
  // 変換レイヤー（translate+scale の掛かった div）。共有HTML書き出しで全域スナップショットを撮るのに使う。
  const layerRef = useRef<HTMLDivElement>(null)
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
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; kind: 'card' | 'canvas' | 'label' | 'arrow' | 'group' | 'station'; canvasX: number; canvasY: number } | null>(null)
  // Note/Task link picker + detach popovers (canvas-level so only one is open at a time).
  const [pickerOpenCardId, setPickerOpenCardId] = useState<string | null>(null)
  const [detachOpenCardId, setDetachOpenCardId] = useState<string | null>(null)
  const [pickerTab, setPickerTab] = useState<'existing' | 'new'>('existing')
  const [pickerSearch, setPickerSearch] = useState('')
  // Multi-select in the task picker — checked ids place as a batch (first one
  // links into the open card, the rest fan out below it as new todo cards).
  const [pickerChecked, setPickerChecked] = useState<string[]>([])
  const handlePickerCheck = useCallback((ids: string[], checked: boolean) => {
    setPickerChecked(prev => checked
      ? [...prev, ...ids.filter(id => !prev.includes(id))]
      : prev.filter(id => !ids.includes(id)))
  }, [])
  // Deletion is gated behind a confirmation modal (no more accidental one-click deletes).
  const [confirmDelete, setConfirmDelete] = useState<{ message: string; run: () => void } | null>(null)
  // Transient bottom-center notice (arrow→parent-child feedback etc.).
  const [notice, setNotice] = useState<string | null>(null)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const showNotice = useCallback((msg: string) => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
    setNotice(msg)
    noticeTimer.current = setTimeout(() => setNotice(null), 3600)
  }, [])
  const clipboardRef = useRef<CanvasCard[]>([])
  // 駅+路線スレッドのクリップボード（カードと並走）。threads は選択駅だけを
  // 順序を保って辿ったサブスレッド（コピー時点の駅IDのまま; ペースト時に再採番）。
  const railClipboardRef = useRef<{ stations: CanvasStation[]; threads: { name: string; color: string; stationIds: string[] }[] }>({ stations: [], threads: [] })
  // ラベル・グループ枠のクリップボード（全選択→コピーで一緒に運ぶ）。
  const labelClipboardRef = useRef<CanvasLabel[]>([])
  const groupClipboardRef = useRef<CanvasGroup[]>([])
  // 矢印: コピー時点の全矢印＋選択矢印ID。貼り付け時にコピー元カードID→新IDで付け替える。
  const arrowClipboardRef = useRef<{ arrows: CanvasArrow[]; selectedIds: string[] }>({ arrows: [], selectedIds: [] })
  // 自由端だけの選択矢印はカード無しでも単独で貼り付けられる（貼り付け可否判定と共有）。
  const clipboardFreeArrows = () => arrowClipboardRef.current.arrows.filter(a => arrowClipboardRef.current.selectedIds.includes(a.id) && !a.fromCardId && !a.toCardId)
  const clipboardHasContent = () =>
    clipboardRef.current.length > 0 || railClipboardRef.current.stations.length > 0 || labelClipboardRef.current.length > 0 || groupClipboardRef.current.length > 0 || clipboardFreeArrows().length > 0
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
  // 路線図プランのメタ（mindtrain store）— 参照カードの「路線図で開く」判定に使う。
  const mtWorkspaceMeta = useMindtrainStore(s => s.workspaceMeta)
  const [activeTabId, setActiveTabId] = useState<string>(state.canvasTabs[0]?.id ?? '')
  const [editingTabId, setEditingTabId] = useState<string | null>(null)
  // Where the tab-name edit input lives — sidebar row or the title bar. Both
  // render the same tab; without this, TWO autoFocus inputs mount at once and
  // the loser's blur instantly cancels the edit.
  const [editingTabInTitle, setEditingTabInTitle] = useState(false)
  const [tool, setTool] = useState<'select' | 'arrow' | 'group' | 'pen' | 'eraser' | 'label' | 'taskdraft' | 'rail'>('select')
  const toolRef = useRef(tool)
  toolRef.current = tool
  // 矢印も複数選択に参加する（範囲選択・Shift+クリック・全選択）。単一選択時だけ
  // プロパティパネル/ツールバーの対象になるよう selectedArrowId は派生値。
  const [selectedArrowIds, setSelectedArrowIds] = useState<string[]>([])
  const selectedArrowId = selectedArrowIds.length === 1 ? selectedArrowIds[0] : null
  const setSelectedArrowId = useCallback((id: string | null) => setSelectedArrowIds(id ? [id] : []), [])
  const selectedArrowIdsRef = useRef(selectedArrowIds); selectedArrowIdsRef.current = selectedArrowIds
  const [editingArrowId, setEditingArrowId] = useState<string | null>(null)
  // グループ枠は複数選択可（全選択・範囲選択・混在ドラッグに参加させるため配列）。
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([])
  const [selectedLabelIds, setSelectedLabelIds] = useState<string[]>([])
  const [editingLabelId, setEditingLabelId] = useState<string | null>(null)
  const [drawArrow, setDrawArrow] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null)
  const drawArrowRef = useRef<{ x1: number; y1: number; x2: number; y2: number } | null>(null)
  // Port the dragged arrow end is currently snapped to (highlight), and the
  // port the in-progress arrow STARTED from (committed on mouseup).
  const [snapPort, setSnapPort] = useState<{ cardId: string; dir: PortDir } | null>(null)
  const drawArrowFromRef = useRef<{ cardId: string; dir: PortDir } | null>(null)
  // Shape card the pointer is hovering (select tool) — its ports show as
  // draggable connection sources. Cleared with a short delay so moving from
  // the card body onto a port dot (half outside the bbox) doesn't hide them.
  const [hoverPortCardId, setHoverPortCardId] = useState<string | null>(null)
  const hoverPortTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const setPortHover = useCallback((id: string | null) => {
    if (hoverPortTimer.current) { clearTimeout(hoverPortTimer.current); hoverPortTimer.current = null }
    if (id) setHoverPortCardId(id)
    else hoverPortTimer.current = setTimeout(() => setHoverPortCardId(null), 140)
  }, [])
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

  // Nearest connection port within radius r (canvas units) of a point, across
  // every card on the tab. Used to snap arrow ends while dragging.
  const nearestPort = useCallback((x: number, y: number, r: number) => {
    let best: { card: CanvasCard; dir: PortDir; x: number; y: number } | null = null
    let bd = r
    for (const c of tabCardsRef.current) {
      if (x < c.x - r || x > c.x + c.width + r || y < c.y - r || y > c.y + c.height + r) continue
      for (const dir of PORT_DIRS) {
        const p = portPoint(c, dir)
        const d = Math.hypot(p.x - x, p.y - y)
        if (d < bd) { bd = d; best = { card: c, dir, x: p.x, y: p.y } }
      }
    }
    return best
  }, [])

  const tabGroups = useMemo(
    () => state.canvasGroups.filter(g => g.tabId === activeTabId),
    [state.canvasGroups, activeTabId]
  )
  const tabGroupsRef = useRef(tabGroups)
  tabGroupsRef.current = tabGroups

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

  // ── 線路 (canvas-native 路線図) ──
  const tabRails = useMemo(
    () => state.canvasRails.filter(r => r.tabId === activeTabId),
    [state.canvasRails, activeTabId]
  )
  const tabRailsRef = useRef(tabRails)
  tabRailsRef.current = tabRails
  const tabStations = useMemo(
    () => state.canvasStations.filter(s => s.tabId === activeTabId),
    [state.canvasStations, activeTabId]
  )
  const tabStationsRef = useRef(tabStations)
  tabStationsRef.current = tabStations
  const stationById = useMemo(() => new Map(tabStations.map(s => [s.id, s] as const)), [tabStations])
  // station id → rails threading through it (2+ = 乗換駅, rendered bigger + dark)
  const railsByStation = useMemo(() => {
    const m = new Map<string, CanvasRail[]>()
    for (const r of tabRails) for (const id of r.stationIds) { const a = m.get(id); if (a) a.push(r); else m.set(id, [r]) }
    return m
  }, [tabRails])
  // 線路レイヤーのジオメトリ（経路文字列＋自動電車の開業run）は駅/路線が変わった時
  // だけ再計算 — マーキーやパン等の毎フレーム再レンダーで metroPath を組み直さず、
  // TrainSprite の pathD を安定させてアニメーションの張り直し（先頭リセット）を防ぐ。
  const railGeometry = useMemo(() => tabRails.map(rail => {
    const pts = rail.stationIds.map(id => stationById.get(id)).filter((s): s is CanvasStation => !!s)
    const pathD = pts.length >= 2 ? metroPath(pts.map(s => ({ x: s.x, y: s.y }))) : null
    // 連続して「開業」している区間（2駅以上）— run 検出は路線図ページと共通。
    const runs = computeDoneRuns(pts).map(run => {
      const seg = pts.slice(run.from, run.to + 1)
      return {
        key: `${rail.id}-${run.from}-${run.to}`,
        d: metroPath(seg.map(s => ({ x: s.x, y: s.y }))),
        duration: autoTrainDuration(seg.length),
      }
    })
    return { rail, pathD, runs }
  }), [tabRails, stationById])
  const [activeRailId, setActiveRailId] = useState<string | null>(null)
  const [selectedStationIds, setSelectedStationIds] = useState<string[]>([])
  const selectedStationIdsRef = useRef(selectedStationIds)
  selectedStationIdsRef.current = selectedStationIds
  const [editingStationId, setEditingStationId] = useState<string | null>(null)
  const activeRailIdRef = useRef(activeRailId)
  activeRailIdRef.current = activeRailId
  // タブ切替時に線路まわりの一時状態をリセットする。実際に activeTabId が
  // 変わった時だけ動く（前回値と比較）— マウント時や StrictMode の二重実行で
  // 検索フォーカスが直前に入れた駅選択を消してしまわないように。
  // フォーカス遷移がタブを切り替えた場合は skipStationResetRef で選択を守る。
  const skipStationResetRef = useRef(false)
  const prevTabForResetRef = useRef(activeTabId)
  useEffect(() => {
    if (prevTabForResetRef.current === activeTabId) return
    prevTabForResetRef.current = activeTabId
    setActiveRailId(null); setEditingStationId(null)
    if (skipStationResetRef.current) { skipStationResetRef.current = false; return }
    setSelectedStationIds([])
  }, [activeTabId])
  // 線路ツール中はグリッドスナップを自動で有効化（路線図ページのグリッド感）。
  // 入る前の設定を覚えておき、別のツールへ戻ったら元に戻す。
  const snapBeforeRailRef = useRef<boolean | null>(null)
  useEffect(() => {
    if (tool === 'rail') {
      snapBeforeRailRef.current = snapRef.current
      setSnapToGrid(true)
    } else if (snapBeforeRailRef.current !== null) {
      setSnapToGrid(snapBeforeRailRef.current)
      snapBeforeRailRef.current = null
    }
  }, [tool])
  // The single-label toolbar (size/color) only applies when exactly one label is selected.
  const selectedLabel = selectedLabelIds.length === 1 ? (tabLabels.find(l => l.id === selectedLabelIds[0]) ?? null) : null
  // 矢印のスタイル操作（ツールバー/プロパティ）は「矢印だけを1本選んでいる」時のみ。
  const arrowSolo = selectedArrowIds.length === 1 && selectedIds.length === 0 && selectedLabelIds.length === 0 && selectedGroupIds.length === 0 && selectedStationIds.length === 0
  const selectedArrow = arrowSolo ? (tabArrows.find(a => a.id === selectedArrowId) ?? null) : null

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

  // ── ボード側パネル — 大カテゴリー(ボード) > 小カテゴリー(タブ) の2段管理 ──
  const projectBoards = useMemo(
    () => state.canvasBoards.filter(b => b.projectId === activeProjectId),
    [state.canvasBoards, activeProjectId]
  )
  // 右側プロパティパネル — 選択中の要素（駅/路線/カード/ラベル/矢印）の詳細を編集。
  // 今後の編集UIはここに集約していく。
  const [propsCollapsed, setPropsCollapsed] = useState(() => {
    try { return localStorage.getItem('constella.canvasProps.collapsed') === '1' } catch { return false }
  })
  useEffect(() => {
    try { localStorage.setItem('constella.canvasProps.collapsed', propsCollapsed ? '1' : '0') } catch { /* ignore */ }
  }, [propsCollapsed])
  const [panelCollapsed, setPanelCollapsed] = useState(() => {
    try { return localStorage.getItem('constella.canvasBoards.collapsed') === '1' } catch { return false }
  })
  useEffect(() => {
    try { localStorage.setItem('constella.canvasBoards.collapsed', panelCollapsed ? '1' : '0') } catch { /* ignore */ }
  }, [panelCollapsed])
  const [editingBoardId, setEditingBoardId] = useState<string | null>(null)
  const [closedBoards, setClosedBoards] = useState<Set<string>>(new Set())
  // Native DnD: dragging a tab row over a board header re-parents it on drop.
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null)
  const [tabDragOverBoard, setTabDragOverBoard] = useState<string | null>(null) // board id, or '__none__' = 未分類
  // Cards per tab — count badge in the sidebar rows.
  const cardCountByTab = useMemo(() => {
    const m = new Map<string, number>()
    for (const c of state.canvasCards) m.set(c.tabId, (m.get(c.tabId) ?? 0) + 1)
    return m
  }, [state.canvasCards])

  // Live task-id index — the terminal layer checks every card per render, so
  // an O(projects×tasks) scan per card would eat the frame budget on pan/zoom.
  const liveTaskIds = useMemo(
    () => new Set(state.projects.flatMap(p => p.tasks.map(t => t.id))),
    [state.projects]
  )

  function addBoard() {
    if (!activeProjectId) return
    const board: CanvasBoard = { id: generateId(), projectId: activeProjectId, name: '新しいボード', createdAt: new Date().toISOString() }
    dispatch({ type: 'ADD_CANVAS_BOARD', payload: board })
    setEditingBoardId(board.id)
  }

  function deleteBoard(board: CanvasBoard) {
    const n = projectTabs.filter(t => t.boardId === board.id).length
    setConfirmDelete({
      message: `ボード「${board.name}」を削除します。${n ? `中のカテゴリー${n}個は未分類へ移動します。` : ''}元に戻すには Ctrl+Z。`,
      run: () => dispatch({ type: 'DELETE_CANVAS_BOARD', payload: board.id }),
    })
  }

  function dropTabOnBoard(e: React.DragEvent, boardId: string | undefined) {
    const id = e.dataTransfer.getData('text/constella-canvas-tab')
    setTabDragOverBoard(null)
    setDraggingTabId(null)
    if (!id) return
    e.preventDefault()
    const tab = state.canvasTabs.find(t => t.id === id)
    if (tab && tab.boardId !== boardId) dispatch({ type: 'UPDATE_CANVAS_TAB', payload: { ...tab, boardId } })
  }

  // ── キャンバスリンクのジャンプ履歴 ──
  // リンクカード経由の移動だけ元キャンバスを積む（A→B→C と辿ってもチェーンで
  // 戻れる）。サイドバーからの手動切替は「移動し直した」扱いで履歴を捨てる。
  const [jumpStack, setJumpStack] = useState<string[]>([])
  useEffect(() => { setJumpStack([]) }, [activeProjectId])

  function activateTab(tabId: string) {
    setActiveTabId(tabId)
    setViewport({ x: 0, y: 0, zoom: 1 })
    // 選択IDはタブローカルではないので、残すと前タブの不可視要素を Delete で消せてしまう。
    setSelectedIds([]); setSelectedLabelIds([]); setSelectedStationIds([]); setSelectedGroupIds([]); setSelectedArrowId(null)
  }

  function selectTab(tabId: string) {
    if (tabId === activeTabId) return
    setJumpStack([])
    activateTab(tabId)
  }

  function jumpToTab(tabId: string) {
    if (tabId === activeTabId) return
    // Pasted/duplicated link cards can carry a refTabId from another master
    // project — refuse instead of bouncing through the tab-guard effect.
    if (!projectTabs.some(t => t.id === tabId)) { showNotice('リンク先は別プロジェクトのキャンバスです'); return }
    const from = activeTabId
    setJumpStack(prev => [...prev, from])
    activateTab(tabId)
  }

  function jumpBack() {
    const next = [...jumpStack]
    let target: string | undefined
    while (next.length) {
      const id = next.pop()!
      if (projectTabs.some(t => t.id === id)) { target = id; break }
    }
    setJumpStack(next)
    if (target) activateTab(target)
  }

  // Deepest surviving return target — drives the 戻る chip in the title bar.
  const jumpBackTab = (() => {
    for (let i = jumpStack.length - 1; i >= 0; i--) {
      const t = projectTabs.find(x => x.id === jumpStack[i])
      if (t) return t
    }
    return undefined
  })()

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
        const factor = wheelZoomFactor(e)
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
    const st = location.state as { focusCardId?: string; focusLabelId?: string; focusStationId?: string } | null
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
      setSelectedArrowId(null); setSelectedGroupIds([]); setSelectedLabelIds([]); setSelectedIds([card.id])
      waitAndCenter(card.x + card.width / 2, card.y + card.height / 2)
    } else if (st.focusLabelId) {
      const label = state.canvasLabels.find(l => l.id === st.focusLabelId)
      if (!label) return
      handledFocusRef.current = location.key
      focusTab(label.tabId)
      setSelectedIds([]); setSelectedArrowId(null); setSelectedGroupIds([]); setSelectedLabelIds([label.id])
      waitAndCenter(label.x, label.y)
    } else if (st.focusStationId) {
      const station = state.canvasStations.find(s => s.id === st.focusStationId)
      if (!station) return
      handledFocusRef.current = location.key
      if (station.tabId !== activeTabId) skipStationResetRef.current = true
      focusTab(station.tabId)
      setSelectedIds([]); setSelectedArrowId(null); setSelectedGroupIds([]); setSelectedLabelIds([]); setSelectedStationIds([station.id])
      waitAndCenter(station.x, station.y)
    }
  }, [location, state.canvasCards, state.canvasLabels, state.canvasStations, state.canvasTabs, activeProjectId, activeTabId, dispatch, navigateTo, canvasSize])

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
    // Clicking the empty canvas while a card's text / title input is being edited
    // commits that edit. Every branch below ends in preventDefault(), which
    // suppresses the browser's default focus transfer — so blur explicitly here.
    const ae = document.activeElement as HTMLElement | null
    if (ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT' || ae.isContentEditable)) ae.blur()
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
    setSelectedGroupIds([])
    setSelectedLabelIds([])
    setEditingLabelId(null)
    setSelectedStationIds([])
    setEditingStationId(null)
    setShowAddMenu(false)
    setConvertOpen(false)
    if (!canvasLocked && tool === 'rail') {
      // Scatter mode like taskdraft: each click drops a 駅 onto the active rail and
      // the tool stays armed. Station nodes catch their own mousedown (select /
      // drag / thread — see handleStationDown), so this only fires on empty空白.
      // Near-miss fallback: a click just outside a node still threads it.
      // アクティブ路線が消えていたら（タブ切替/最終路線の削除）先頭路線へフォールバック
      // — なければその場で新しい路線を作る。クリックが黙って死ぬのが最悪なので。
      let rail = tabRailsRef.current.find(r => r.id === activeRailIdRef.current)
      if (!rail) {
        rail = tabRailsRef.current[0]
        if (rail) setActiveRailId(rail.id)
      }
      if (!rail) {
        const rails = tabRailsRef.current
        rail = {
          id: generateId(), tabId: activeTabId,
          name: `路線${rails.length + 1}`,
          color: pickNextColor(rails.map(r => r.color)),
          stationIds: [], createdAt: new Date().toISOString(),
        }
        dispatch({ type: 'ADD_CANVAS_RAIL', payload: rail })
        setActiveRailId(rail.id)
      }
      const raw = toCanvas(e.clientX, e.clientY)
      // 配置座標はスナップ、既存駅のヒット判定は生のクリック位置で行う。
      const p = snapRef.current ? { x: Math.round(raw.x / 20) * 20, y: Math.round(raw.y / 20) * 20 } : raw
      const hit = tabStationsRef.current.find(s => Math.hypot(s.x - raw.x, s.y - raw.y) <= 18)
      if (hit) {
        dispatch({ type: 'APPEND_STATION_TO_RAIL', payload: { railId: rail.id, stationId: hit.id } })
        setSelectedStationIds([hit.id])
      } else {
        // クリックがアクティブ路線の線分上なら駅を「間に挿入」（路線図ページと同じ）。
        // 判定は実際に置かれるスナップ後の座標で行い（生クリックで判定すると
        // スナップ先が区間の外に出て路線が折り返す）、挿入位置は路線の
        // 生 stationIds 配列上のアンカー駅から求める（欠損IDでズレないように）。
        const lineStations = rail.stationIds
          .map(id => tabStationsRef.current.find(s => s.id === id))
          .filter((s): s is CanvasStation => !!s)
        const insertIdx = lineStations.length >= 2
          ? findInsertionIndex(lineStations.map(s => ({ x: s.x, y: s.y })), p, 12)
          : null
        const anchorId = insertIdx !== null ? lineStations[insertIdx]?.id : undefined
        const index = anchorId ? rail.stationIds.indexOf(anchorId) : undefined
        const station: CanvasStation = {
          id: generateId(), tabId: activeTabId, name: `駅${tabStationsRef.current.length + 1}`,
          x: p.x, y: p.y, status: 'todo', createdAt: new Date().toISOString(),
        }
        dispatch({ type: 'ADD_CANVAS_STATION', payload: { station, railId: rail.id, ...(index !== undefined && index >= 0 ? { index } : {}) } })
        setSelectedStationIds([station.id])
      }
      e.preventDefault()
      return
    }
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
      // Start on (or near) a port → the arrow's tail docks to that fixed port.
      const snap = nearestPort(p.x, p.y, PORT_SNAP_SCREEN / viewportRef.current.zoom)
      drawArrowFromRef.current = snap ? { cardId: snap.card.id, dir: snap.dir } : null
      const sx = snap ? snap.x : p.x, sy = snap ? snap.y : p.y
      const a = { x1: sx, y1: sy, x2: sx, y2: sy }
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
    setSelectedArrowIds([])
    setIsDragging(true)
    e.preventDefault()
  }, [tool, toCanvas, dispatch, activeTabId, canvasLocked, nearestPort])

  // ── 線路 helpers ──
  function addRail(): string {
    const id = generateId()
    const rail: CanvasRail = {
      id, tabId: activeTabId,
      name: `路線${tabRails.length + 1}`,
      color: pickNextColor(tabRails.map(r => r.color)),
      stationIds: [], createdAt: new Date().toISOString(),
    }
    dispatch({ type: 'ADD_CANVAS_RAIL', payload: rail })
    setActiveRailId(id)
    return id
  }

  function enterRailTool() {
    // The tool always draws onto the ACTIVE rail — make sure one exists. Other
    // selections clear so the property panel shows the rail being drawn. Rail
    // controls live ONLY in the property panel, so make sure it is visible.
    if (tabRails.length === 0) addRail()
    else if (!activeRailId || !tabRails.some(r => r.id === activeRailId)) setActiveRailId(tabRails[0].id)
    setSelectedIds([]); setSelectedArrowId(null); setSelectedGroupIds([]); setSelectedLabelIds([]); setSelectedStationIds([])
    setPropsCollapsed(false)
    setTool('rail')
  }

  function requestDeleteRail(rail: CanvasRail) {
    setConfirmDelete({
      message: `路線「${rail.name}」を削除します（他の路線が通らない駅も消えます）。元に戻すには Ctrl+Z。`,
      run: () => {
        dispatch({ type: 'DELETE_CANVAS_RAIL', payload: rail.id })
        setActiveRailId(prev => prev === rail.id ? (tabRailsRef.current.find(r => r.id !== rail.id)?.id ?? null) : prev)
      },
    })
  }

  // 路線図ページと同じ操作系: どのモードでも 駅mousedown=選択+ドラッグ開始。
  // Shift+クリック=選択トグル。複数選択のメンバーを掴んだときは選択全体
  // （カード/ラベル/駅）をまとめて動かす — カードと同じ dragRef 機構に委譲。
  // railツール中に「動かさずクリック」したときだけアクティブ路線へ接続（延伸/乗換）。
  const handleStationDown = useCallback((e: React.MouseEvent, st: CanvasStation) => {
    if (e.button !== 0) return
    e.stopPropagation()
    if (e.shiftKey) {
      setSelectedStationIds(prev => prev.includes(st.id) ? prev.filter(x => x !== st.id) : [...prev, st.id])
      return
    }
    const selStations = selectedStationIdsRef.current
    const inMulti = selStations.includes(st.id) && (selStations.length + selectedIds.length + selectedLabelIds.length + selectedGroupIds.length + selectedArrowIdsRef.current.length > 1)
    if (!inMulti) {
      setSelectedIds([]); setSelectedArrowId(null); setSelectedGroupIds([]); setSelectedLabelIds([]); setEditingLabelId(null)
      setSelectedStationIds([st.id])
    }
    if (canvasLockedRef.current) return
    if (inMulti) {
      // Group move via the shared drag machinery (same as grabbing a selected card).
      const cards = tabCards.filter(c => selectedIds.includes(c.id) && !c.locked).map(c => ({ id: c.id, x: c.x, y: c.y }))
      const labels = tabLabels.filter(l => selectedLabelIds.includes(l.id))
      const stations = tabStations.filter(s => selStations.includes(s.id))
      const groups = tabGroups.filter(g => selectedGroupIds.includes(g.id))
      dragRef.current = { kind: 'card', cards, labels, stations, groups, startMouseX: e.clientX, startMouseY: e.clientY, startX: 0, startY: 0, moved: false }
      e.preventDefault()
      return
    }
    const railMode = toolRef.current === 'rail'
    // Self-contained drag (window listeners) — dispatches coalesce into one undo step.
    const start = { mx: e.clientX, my: e.clientY, x: st.x, y: st.y }
    let moved = false
    const onMove = (ev: MouseEvent) => {
      const dxs = ev.clientX - start.mx, dys = ev.clientY - start.my
      if (!moved && Math.hypot(dxs, dys) <= 4) return // click vs drag threshold (screen px)
      if (!moved) {
        moved = true
        // カードドラッグと同じ全画面オーバーレイを立てて <webview> 埋め込みに
        // マウスイベントを食われないようにする（食われると駅が固まり、
        // mouseup を取り逃してゴーストドラッグ化する）。
        setIsDragging(true)
      }
      const z = viewportRef.current.zoom
      let nx = start.x + dxs / z
      let ny = start.y + dys / z
      if (snapRef.current) { nx = Math.round(nx / 20) * 20; ny = Math.round(ny / 20) * 20 }
      dispatch({ type: 'UPDATE_CANVAS_STATION', payload: { ...st, x: nx, y: ny } })
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      if (moved) setIsDragging(false)
      if (!moved && railMode) {
        const rail = tabRailsRef.current.find(r => r.id === activeRailIdRef.current)
        if (rail && !rail.stationIds.includes(st.id)) {
          dispatch({ type: 'APPEND_STATION_TO_RAIL', payload: { railId: rail.id, stationId: st.id } })
        }
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    e.preventDefault()
  }, [dispatch, selectedIds, selectedLabelIds, selectedGroupIds, tabCards, tabLabels, tabStations, tabGroups])

  // ロック中も開ける — メニュー側の canvasLocked 分岐が読み取り専用表示を出す。
  const handleStationContextMenu = useCallback((e: React.MouseEvent, st: CanvasStation) => {
    e.preventDefault(); e.stopPropagation()
    setSelectedStationIds([st.id]); setSelectedIds([]); setSelectedArrowId(null); setSelectedGroupIds([]); setSelectedLabelIds([])
    setContextMenu({ x: Math.min(e.clientX, window.innerWidth - 230), y: Math.min(e.clientY, window.innerHeight - 220), kind: 'station', canvasX: 0, canvasY: 0 })
  }, [])

  const selectCard = useCallback((id: string, additive: boolean) => {
    if (!additive) { setSelectedArrowIds([]); setSelectedLabelIds([]); setSelectedStationIds([]); setSelectedGroupIds([]) } // keep labels/駅/グループ枠/矢印 when shift-extending a mixed selection
    if (additive) setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
    else setSelectedIds(prev => (prev.length > 1 && prev.includes(id)) ? prev : [id])
  }, [])

  const handleCardHeaderDown = useCallback((e: React.MouseEvent, card: CanvasCard) => {
    if (e.button !== 0) return
    e.stopPropagation()
    // Keep the multi-selection (cards + labels + 駅 + グループ枠 + 矢印) when grabbing one of its members.
    const inMulti = selectedIds.includes(card.id) && (selectedIds.length > 1 || selectedLabelIds.length > 0 || selectedStationIds.length > 0 || selectedGroupIds.length > 0 || selectedArrowIds.length > 0)
    const movingCards = inMulti ? selectedIds : [card.id]
    const movingLabels = inMulti ? selectedLabelIds : []
    const movingStations = inMulti ? selectedStationIds : []
    const movingGroups = inMulti ? selectedGroupIds : []
    if (!inMulti) { setSelectedIds([card.id]); setSelectedLabelIds([]); setSelectedStationIds([]); setSelectedGroupIds([]); setSelectedArrowIds([]) }
    const cards = canvasLockedRef.current ? [] : tabCards.filter(c => movingCards.includes(c.id) && !c.locked).map(c => ({ id: c.id, x: c.x, y: c.y }))
    const labels = canvasLockedRef.current ? [] : tabLabels.filter(l => movingLabels.includes(l.id))
    const stations = canvasLockedRef.current ? [] : tabStations.filter(s => movingStations.includes(s.id))
    const groups = canvasLockedRef.current ? [] : tabGroups.filter(g => movingGroups.includes(g.id))
    dragRef.current = { kind: 'card', cards, labels, stations, groups, startMouseX: e.clientX, startMouseY: e.clientY, startX: 0, startY: 0, moved: false }
    // Don't enter "dragging" (which mounts the full-screen overlay) until the pointer
    // actually moves — otherwise the overlay intercepts the mouseup between a header
    // double-click's two clicks and title editing never opens (handled in handleMouseMove).
  }, [selectedIds, selectedLabelIds, selectedStationIds, selectedGroupIds, selectedArrowIds, tabCards, tabLabels, tabStations, tabGroups])

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
      // Snap the live head to a nearby port (highlighted via snapPort).
      const snap = nearestPort(p.x, p.y, PORT_SNAP_SCREEN / viewportRef.current.zoom)
      const a = { ...drawArrowRef.current, x2: snap ? snap.x : p.x, y2: snap ? snap.y : p.y }
      drawArrowRef.current = a
      setDrawArrow(a)
      setSnapPort(snap ? { cardId: snap.card.id, dir: snap.dir } : null)
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
      const cardIds = tabCards.filter(c => c.x < x + w && c.x + c.width > x && c.y < y + h && c.y + c.height > y).map(c => c.id)
      setSelectedIds(cardIds)
      // 矢印は「両端が選択に入る」ものを選ぶ: カードに付いた端はそのカードが選択済み、
      // 自由な端は矩形内にあること。
      const cardSet = new Set(cardIds)
      const inRect = (px: number, py: number) => px >= x && px <= x + w && py >= y && py <= y + h
      setSelectedArrowIds(tabArrows.filter(a =>
        (a.fromCardId ? cardSet.has(a.fromCardId) : inRect(a.x1, a.y1)) &&
        (a.toCardId ? cardSet.has(a.toCardId) : inRect(a.x2, a.y2))
      ).map(a => a.id))
      setSelectedLabelIds(tabLabels.filter(l => { const b = labelBox(l); return b.x < x + w && b.x + b.w > x && b.y < y + h && b.y + b.h > y }).map(l => l.id))
      setSelectedStationIds(tabStations.filter(s => s.x >= x && s.x <= x + w && s.y >= y && s.y <= y + h).map(s => s.id))
      // グループ枠は「全体が矩形に収まったもの」だけ選択に入れる — 交差判定だと
      // 枠内で範囲選択するたび巨大な枠まで巻き込まれてしまう。
      setSelectedGroupIds(tabGroups.filter(g => g.x >= x && g.y >= y && g.x + g.width <= x + w && g.y + g.height <= y + h).map(g => g.id))
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
      // Arrows ride along when BOTH ends travel with the drag: an end docked to a
      // moving card, or a free end of a selected arrow. Snapshot their original
      // geometry on the first moved frame (before any dispatch) so the offsets
      // stay absolute like the cards'.
      if (!d.arrows) {
        const moving = new Set((d.cards ?? []).map(c => c.id))
        const selArrows = new Set(selectedArrowIdsRef.current)
        d.arrows = tabArrowsRef.current.filter(a => {
          const fromIn = a.fromCardId ? moving.has(a.fromCardId) : selArrows.has(a.id)
          const toIn = a.toCardId ? moving.has(a.toCardId) : selArrows.has(a.id)
          return fromIn && toIn && (!a.fromCardId || !a.toCardId || (a.points?.length ?? 0) > 0)
        })
      }
      d.cards?.forEach(c => dispatch({ type: 'MOVE_CANVAS_CARD', payload: { id: c.id, x: snap(c.x + dx / zoom), y: snap(c.y + dy / zoom) } }))
      d.arrows.forEach(a => dispatch({ type: 'UPDATE_CANVAS_ARROW', payload: {
        ...a,
        ...(a.fromCardId ? {} : { x1: snap(a.x1 + dx / zoom), y1: snap(a.y1 + dy / zoom) }),
        ...(a.toCardId ? {} : { x2: snap(a.x2 + dx / zoom), y2: snap(a.y2 + dy / zoom) }),
        points: a.points?.map(p => ({ x: snap(p.x + dx / zoom), y: snap(p.y + dy / zoom) })),
      } }))
      d.labels?.forEach(l => dispatch({ type: 'UPDATE_CANVAS_LABEL', payload: { ...l, x: snap(l.x + dx / zoom), y: snap(l.y + dy / zoom) } }))
      d.stations?.forEach(s => dispatch({ type: 'UPDATE_CANVAS_STATION', payload: { ...s, x: snap(s.x + dx / zoom), y: snap(s.y + dy / zoom) } }))
      d.groups?.forEach(g => dispatch({ type: 'UPDATE_CANVAS_GROUP', payload: { ...g, x: snap(g.x + dx / zoom), y: snap(g.y + dy / zoom) } }))
    } else if (d.kind === 'resize' && d.cardId) {
      // Shapes may shrink far below the normal card minimum (small circles, dots).
      const isShape = tabCardsRef.current.find(c => c.id === d.cardId)?.type === 'shape'
      const w = Math.max(isShape ? 40 : 160, snap((d.startW ?? 220) + dx / zoom))
      const h = Math.max(isShape ? 40 : 80, snap((d.startH ?? 140) + dy / zoom))
      dispatch({ type: 'RESIZE_CANVAS_CARD', payload: { id: d.cardId, width: w, height: h } })
    } else if ((d.kind === 'arrow-p1' || d.kind === 'arrow-p2') && d.arrow) {
      const p = toCanvas(e.clientX, e.clientY)
      const snap = nearestPort(p.x, p.y, PORT_SNAP_SCREEN / zoom)
      const px = snap ? snap.x : p.x, py = snap ? snap.y : p.y
      setSnapPort(snap ? { cardId: snap.card.id, dir: snap.dir } : null)
      const upd = d.kind === 'arrow-p1'
        ? { x1: px, y1: py, fromCardId: undefined, fromPort: undefined }
        : { x2: px, y2: py, toCardId: undefined, toPort: undefined }
      dispatch({ type: 'UPDATE_CANVAS_ARROW', payload: { ...d.arrow, ...upd } })
    } else if (d.kind === 'arrow-way' && d.arrow && d.wayIndex != null) {
      const p = toCanvas(e.clientX, e.clientY)
      const pts = [...(d.arrow.points ?? [])]
      pts[d.wayIndex] = { x: snap(p.x), y: snap(p.y) }
      dispatch({ type: 'UPDATE_CANVAS_ARROW', payload: { ...d.arrow, points: pts } })
    } else if (d.kind === 'group-move' && d.group) {
      const gx = snap(d.startX + dx / zoom), gy = snap(d.startY + dy / zoom)
      dispatch({ type: 'UPDATE_CANVAS_GROUP', payload: { ...d.group, x: gx, y: gy } })
      d.groupCards?.forEach(c => dispatch({ type: 'MOVE_CANVAS_CARD', payload: { id: c.id, x: snap(c.x + dx / zoom), y: snap(c.y + dy / zoom) } }))
      d.groupGroups?.forEach(g => dispatch({ type: 'UPDATE_CANVAS_GROUP', payload: { ...g, x: snap(g.x + dx / zoom), y: snap(g.y + dy / zoom) } }))
      d.labels?.forEach(l => dispatch({ type: 'UPDATE_CANVAS_LABEL', payload: { ...l, x: snap(l.x + dx / zoom), y: snap(l.y + dy / zoom) } }))
      d.stations?.forEach(s => dispatch({ type: 'UPDATE_CANVAS_STATION', payload: { ...s, x: snap(s.x + dx / zoom), y: snap(s.y + dy / zoom) } }))
    } else if (d.kind === 'group-resize' && d.group) {
      const w = Math.max(120, snap((d.startW ?? 200) + dx / zoom))
      const h = Math.max(80, snap((d.startH ?? 120) + dy / zoom))
      dispatch({ type: 'UPDATE_CANVAS_GROUP', payload: { ...d.group, width: w, height: h } })
    } else if (d.kind === 'label-move' && d.label) {
      dispatch({ type: 'UPDATE_CANVAS_LABEL', payload: { ...d.label, x: snap(d.startX + dx / zoom), y: snap(d.startY + dy / zoom) } })
    }
  }, [dispatch, toCanvas, tabCards, tabLabels, tabStations, tabGroups, tabArrows, applyBrush, nearestPort])

  // タスク端子 → 実タスク親子化: dragging the 端子 between two LIVE task-ref
  // cards writes the real parent-child relation (from = 親, to = 子). Invoked
  // ONLY by the terminal gesture — plain arrow-tool arrows and endpoint
  // re-drags are pure drawings and never touch task data. Same board only;
  // cycles and self-links are refused. Deleting the arrow deliberately does
  // NOT unparent: cleaning up the canvas must never rewrite task structure.
  const projectsRef = useRef(state.projects)
  projectsRef.current = state.projects
  // Returns true when the relation holds after the call (newly set, or already
  // in place) — the タスク端子 gesture uses this to decide whether its line
  // deserves to exist at all.
  const parentLinkByArrow = useCallback((fromCardId?: string, toCardId?: string): boolean => {
    if (!fromCardId || !toCardId || fromCardId === toCardId) return false
    const cards = tabCardsRef.current
    const fromTaskId = cards.find(c => c.id === fromCardId)?.refTaskId
    const toTaskId = cards.find(c => c.id === toCardId)?.refTaskId
    if (!fromTaskId || !toTaskId || fromTaskId === toTaskId) return false
    const projects = projectsRef.current
    const fromBoard = projects.find(p => p.tasks.some(t => t.id === fromTaskId))
    const toBoard = projects.find(p => p.tasks.some(t => t.id === toTaskId))
    if (!fromBoard || !toBoard) return false
    if (fromBoard.id !== toBoard.id) { showNotice('別ボードのタスクなので親子化できません'); return false }
    const byId = new Map(toBoard.tasks.map(t => [t.id, t]))
    const child = byId.get(toTaskId)!
    if (child.parentId === fromTaskId) return true
    // Cycle guard: the new parent must not be a descendant of the child.
    const seen = new Set<string>()
    for (let p = byId.get(fromTaskId); p?.parentId && !seen.has(p.id); p = byId.get(p.parentId)) {
      seen.add(p.id)
      if (p.parentId === toTaskId) { showNotice('循環になるため親子化できません'); return false }
    }
    dispatch({ type: 'UPDATE_TASK', payload: { projectId: toBoard.id, task: { ...child, parentId: fromTaskId } } })
    showNotice(`「${child.title || '無題'}」を「${byId.get(fromTaskId)?.title || '無題'}」の子タスクにしました（Ctrl+Zで取消）`)
    return true
  }, [dispatch, showNotice])

  const handleMouseUp = useCallback(() => {
    setSnapPort(null)
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
      const fromSnap = drawArrowFromRef.current
      const isTaskLink = taskLinkDragRef.current
      drawArrowRef.current = null
      drawArrowFromRef.current = null
      taskLinkDragRef.current = false
      setTaskLinkDrag(false)
      setDrawArrow(null)
      setIsDragging(false)
      const len = Math.hypot(a.x2 - a.x1, a.y2 - a.y1)
      if (len >= 8) {
        // Port-snapped ends dock to their port; otherwise fall back to the
        // card under the endpoint (auto border clipping).
        const toSnap = nearestPort(a.x2, a.y2, PORT_SNAP_SCREEN / viewportRef.current.zoom)
        const fromCard = fromSnap ? tabCardsRef.current.find(c => c.id === fromSnap.cardId) : cardAtPoint(a.x1, a.y1)
        const toCard = toSnap ? toSnap.card : cardAtPoint(a.x2, a.y2)
        // タスク親子付けライン is not a free drawing: it exists only when the
        // relation holds. live→live writes parentId immediately; 下書き lines
        // (下書き/既存タスク → 下書き) stay as arrows and are realized at
        // タスク化 (performDraftConversion reads arrow endpoints). Anything
        // else — empty canvas, non-task cards, reversed draft direction,
        // cross-board, cycles — evaporates with a notice.
        if (isTaskLink) {
          if (!fromCard || !toCard || fromCard.id === toCard.id) return
          const fromDraft = fromCard.type === 'taskDraft'
          const toDraft = toCard.type === 'taskDraft'
          if (toDraft && (fromDraft || fromCard.refTaskId)) {
            showNotice('「タスク化」すると 親 → 子 として登録されます')
          } else if (!fromDraft && !toDraft) {
            if (!parentLinkByArrow(fromCard.id, toCard.id)) return
          } else {
            showNotice('下書きの親子は「下書き / 既存タスク → 下書き」の向きだけ結べます')
            return
          }
        }
        const arrow: CanvasArrow = {
          id: generateId(), tabId: activeTabId, x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2,
          fromCardId: fromCard?.id, toCardId: toCard?.id,
          fromPort: fromSnap && fromCard ? fromSnap.dir : undefined,
          toPort: toSnap && toCard ? toSnap.dir : undefined,
          ...(isTaskLink ? { color: TASK_LINK_COLOR, width: TASK_LINK_WIDTH } : {}),
          createdAt: new Date().toISOString(),
        }
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
        setSelectedGroupIds([group.id])
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
        // Dropped on a port → dock there; inside a card → auto border attach.
        const snap = nearestPort(ex, ey, PORT_SNAP_SCREEN / viewportRef.current.zoom)
        const card = snap ? snap.card : cardAtPoint(ex, ey)
        const upd = d.kind === 'arrow-p1'
          ? { fromCardId: card?.id, fromPort: snap && card ? snap.dir : undefined }
          : { toCardId: card?.id, toPort: snap && card ? snap.dir : undefined }
        // Endpoint re-docking is geometry only — parent-child relations are
        // written EXCLUSIVELY by the タスク端子 gesture, so tidying up old
        // decorative arrows can never silently rewrite the task tree.
        dispatch({ type: 'UPDATE_CANVAS_ARROW', payload: { ...arrow, ...upd } })
      }
    }
    dragRef.current = null
    setIsDragging(false)
  }, [dispatch, activeTabId, cardAtPoint, penColor, penWidth, nearestPort, parentLinkByArrow, showNotice])
  handleMouseUpRef.current = handleMouseUp

  const handleArrowEndDown = useCallback((e: React.MouseEvent, arrow: CanvasArrow, which: 'p1' | 'p2') => {
    if (e.button !== 0) return
    e.stopPropagation()
    if (canvasLockedRef.current) return
    dragRef.current = { kind: which === 'p1' ? 'arrow-p1' : 'arrow-p2', arrow, startMouseX: e.clientX, startMouseY: e.clientY, startX: 0, startY: 0, moved: false }
    setIsDragging(true)
  }, [])

  // Start drawing an arrow FROM a hover port (select tool) — same flow as the
  // arrow tool: handleMouseMove tracks the head, handleMouseUp commits.
  // `taskLink` marks the gesture as a タスク親子付けライン (started from a task
  // terminal): it commits ONLY onto another task card and styles differently.
  const taskLinkDragRef = useRef(false)
  const [taskLinkDrag, setTaskLinkDrag] = useState(false)
  const handlePortDown = useCallback((e: React.MouseEvent, card: CanvasCard, dir: PortDir, taskLink = false) => {
    if (e.button !== 0 || canvasLockedRef.current) return
    e.stopPropagation()
    e.preventDefault()
    const p = portPoint(card, dir)
    drawArrowFromRef.current = { cardId: card.id, dir }
    taskLinkDragRef.current = taskLink
    setTaskLinkDrag(taskLink)
    const a = { x1: p.x, y1: p.y, x2: p.x, y2: p.y }
    drawArrowRef.current = a
    setDrawArrow(a)
    setIsDragging(true)
  }, [])

  // Drag an existing bend waypoint.
  const handleWayDown = useCallback((e: React.MouseEvent, arrow: CanvasArrow, idx: number) => {
    if (e.button !== 0) return
    e.stopPropagation()
    if (canvasLockedRef.current) return
    dragRef.current = { kind: 'arrow-way', arrow, wayIndex: idx, startMouseX: e.clientX, startMouseY: e.clientY, startX: 0, startY: 0, moved: false }
    setIsDragging(true)
  }, [])

  // Drag a virtual segment-midpoint handle → insert a new waypoint there and
  // keep dragging it in one gesture.
  const handleWayInsert = useCallback((e: React.MouseEvent, arrow: CanvasArrow, idx: number, x: number, y: number) => {
    if (e.button !== 0) return
    e.stopPropagation()
    if (canvasLockedRef.current) return
    const pts = [...(arrow.points ?? [])]
    pts.splice(idx, 0, { x, y })
    const updated = { ...arrow, points: pts }
    dispatch({ type: 'UPDATE_CANVAS_ARROW', payload: updated })
    dragRef.current = { kind: 'arrow-way', arrow: updated, wayIndex: idx, startMouseX: e.clientX, startMouseY: e.clientY, startX: 0, startY: 0, moved: false }
    setIsDragging(true)
  }, [dispatch])

  // Double-click a waypoint → remove it.
  const handleWayRemove = useCallback((arrow: CanvasArrow, idx: number) => {
    if (canvasLockedRef.current) return
    const pts = (arrow.points ?? []).filter((_, i) => i !== idx)
    dispatch({ type: 'UPDATE_CANVAS_ARROW', payload: { ...arrow, points: pts.length ? pts : undefined } })
  }, [dispatch])

  const handleGroupHeaderDown = useCallback((e: React.MouseEvent, group: CanvasGroup) => {
    if (e.button !== 0) return
    e.stopPropagation()
    if (e.shiftKey) {
      // toggle this group in/out of the multi-selection (no drag)
      setSelectedGroupIds(prev => prev.includes(group.id) ? prev.filter(x => x !== group.id) : [...prev, group.id])
      return
    }
    // 複数選択（全選択・範囲選択）のメンバーを掴んだときは選択全体をまとめて動かす。
    // このとき枠は「枠だけ」動く — 中身の追従は選択されたカード側が担う。
    const inMulti = selectedGroupIds.includes(group.id) && (selectedGroupIds.length + selectedIds.length + selectedLabelIds.length + selectedStationIds.length + selectedArrowIdsRef.current.length > 1)
    if (inMulti) {
      if (canvasLockedRef.current) return
      const cards = tabCards.filter(c => selectedIds.includes(c.id) && !c.locked).map(c => ({ id: c.id, x: c.x, y: c.y }))
      const labels = tabLabels.filter(l => selectedLabelIds.includes(l.id))
      const stations = tabStations.filter(s => selectedStationIds.includes(s.id))
      const groups = tabGroups.filter(g => selectedGroupIds.includes(g.id))
      dragRef.current = { kind: 'card', cards, labels, stations, groups, startMouseX: e.clientX, startMouseY: e.clientY, startX: 0, startY: 0, moved: false }
      return
    }
    setSelectedGroupIds([group.id])
    setSelectedIds([])
    setSelectedArrowId(null)
    setSelectedLabelIds([])
    setSelectedStationIds([])
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
    // 駅 inside the frame move with it — otherwise dragging a group tears the
    // rails away from the grouped content.
    const containedStations = tabStations.filter(s =>
      s.x >= group.x && s.x <= group.x + group.width && s.y >= group.y && s.y <= group.y + group.height
    )
    dragRef.current = { kind: 'group-move', group, groupCards: contained, groupGroups: containedGroups, labels: containedLabels, stations: containedStations, startMouseX: e.clientX, startMouseY: e.clientY, startX: group.x, startY: group.y, moved: false }
    // Defer the drag overlay until real movement so a double-click on the group title
    // (to rename) isn't swallowed by the overlay (handled in handleMouseMove).
  }, [tabCards, tabGroups, tabLabels, tabStations, selectedIds, selectedLabelIds, selectedStationIds, selectedGroupIds])

  const handleGroupResizeDown = useCallback((e: React.MouseEvent, group: CanvasGroup) => {
    if (e.button !== 0) return
    e.stopPropagation()
    if (canvasLockedRef.current) return
    setSelectedGroupIds([group.id])
    dragRef.current = { kind: 'group-resize', group, startMouseX: e.clientX, startMouseY: e.clientY, startX: 0, startY: 0, startW: group.width, startH: group.height, moved: false }
    setIsDragging(true)
  }, [])

  const handleLabelDown = useCallback((e: React.MouseEvent, label: CanvasLabel) => {
    if (e.button !== 0) return
    e.stopPropagation()
    if (e.shiftKey) {
      // toggle this label in/out of the multi-selection (no drag)
      setSelectedLabelIds(prev => prev.includes(label.id) ? prev.filter(x => x !== label.id) : [...prev, label.id])
      return
    }
    // Clicking a member of an existing multi-selection keeps it and drags the whole
    // set — cards, labels, 駅 AND グループ枠 (same as grabbing a card or a station).
    const inMulti = selectedLabelIds.includes(label.id) && (selectedLabelIds.length + selectedIds.length + selectedStationIds.length + selectedGroupIds.length + selectedArrowIdsRef.current.length > 1)
    const labelSel = inMulti ? selectedLabelIds : [label.id]
    const cardSel = inMulti ? selectedIds : []
    const stationSel = inMulti ? selectedStationIds : []
    const groupSel = inMulti ? selectedGroupIds : []
    if (!inMulti) { setSelectedLabelIds([label.id]); setSelectedIds([]); setSelectedStationIds([]); setSelectedGroupIds([]); setSelectedArrowIds([]) }
    if (canvasLockedRef.current) return
    const labels = tabLabels.filter(l => labelSel.includes(l.id))
    const cards = tabCards.filter(c => cardSel.includes(c.id) && !c.locked).map(c => ({ id: c.id, x: c.x, y: c.y }))
    const stations = tabStations.filter(s => stationSel.includes(s.id))
    const groups = tabGroups.filter(g => groupSel.includes(g.id))
    dragRef.current = { kind: 'card', cards, labels, stations, groups, startMouseX: e.clientX, startMouseY: e.clientY, startX: 0, startY: 0, moved: false }
    setIsDragging(true)
  }, [selectedLabelIds, selectedIds, selectedStationIds, selectedGroupIds, tabLabels, tabCards, tabStations, tabGroups])

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

  // 複製/貼り付けに同行する矢印: 両端が「複製されるカード」か「選択中の矢印の自由端」
  // のもの。カード端は idMap で新カードへ付け替え、自由端と経由点はオフセット。
  function cloneArrows(
    arrows: CanvasArrow[], selArrowIds: string[], idMap: Map<string, string>,
    targetTabId: string, ox: number, oy: number,
  ): { actions: Action[]; ids: string[] } {
    const sel = new Set(selArrowIds)
    const actions: Action[] = []
    const ids: string[] = []
    const now = new Date().toISOString()
    for (const a of arrows) {
      const fromIn = a.fromCardId ? idMap.has(a.fromCardId) : sel.has(a.id)
      const toIn = a.toCardId ? idMap.has(a.toCardId) : sel.has(a.id)
      if (!fromIn || !toIn) continue
      const copy: CanvasArrow = {
        ...a, id: generateId(), tabId: targetTabId, createdAt: now,
        fromCardId: a.fromCardId ? idMap.get(a.fromCardId) : undefined,
        toCardId: a.toCardId ? idMap.get(a.toCardId) : undefined,
        x1: a.x1 + ox, y1: a.y1 + oy, x2: a.x2 + ox, y2: a.y2 + oy,
        points: a.points?.map(p => ({ x: p.x + ox, y: p.y + oy })),
      }
      actions.push({ type: 'ADD_CANVAS_ARROW', payload: copy })
      ids.push(copy.id)
    }
    return { actions, ids }
  }

  // Duplicate the selected cards (offset by a grid step)
  const duplicateSelection = useCallback(() => {
    if (canvasLockedRef.current || (selectedIds.length === 0 && selectedStationIds.length === 0 && selectedLabelIds.length === 0 && selectedGroupIds.length === 0 && selectedArrowIds.length === 0)) return
    const actions: Action[] = []
    const newIds: string[] = []
    const cardIdMap = new Map<string, string>()
    tabCards.filter(c => selectedIds.includes(c.id)).forEach(c => {
      const copy: CanvasCard = {
        ...c,
        id: generateId(),
        x: c.x + 24, y: c.y + 24,
        pages: c.pages ? c.pages.map(p => ({ ...p, id: generateId() })) : undefined,
        createdAt: new Date().toISOString(),
      }
      actions.push({ type: 'ADD_CANVAS_CARD', payload: copy })
      newIds.push(copy.id)
      cardIdMap.set(c.id, copy.id)
    })
    const arrowClone = cloneArrows(tabArrows, selectedArrowIds, cardIdMap, activeTabId, 24, 24)
    actions.push(...arrowClone.actions)
    // 選択中の駅も複製 — 選択駅を2つ以上通る路線は、そのサブスレッドごと
    // 新しい路線として複製する（路線図を丸ごと選んで Ctrl+D した時の期待動作）。
    const selStations = tabStations.filter(s => selectedStationIds.includes(s.id))
    const clone = cloneStationsWithThreads(
      selStations,
      tabRails.map(r => ({ name: r.name, color: r.color, stationIds: r.stationIds })),
      activeTabId, 24, 24,
    )
    actions.push(...clone.actions)
    // 全選択で参加するようになったラベル・グループ枠も一緒に複製する。
    const newLabelIds: string[] = []
    tabLabels.filter(l => selectedLabelIds.includes(l.id)).forEach(l => {
      const copy: CanvasLabel = { ...l, id: generateId(), x: l.x + 24, y: l.y + 24, createdAt: new Date().toISOString() }
      actions.push({ type: 'ADD_CANVAS_LABEL', payload: copy })
      newLabelIds.push(copy.id)
    })
    const newGroupIds: string[] = []
    tabGroups.filter(g => selectedGroupIds.includes(g.id)).forEach(g => {
      const copy: CanvasGroup = { ...g, id: generateId(), x: g.x + 24, y: g.y + 24, createdAt: new Date().toISOString() }
      actions.push({ type: 'ADD_CANVAS_GROUP', payload: copy })
      newGroupIds.push(copy.id)
    })
    if (actions.length > 0) dispatch({ type: 'BATCH', payload: actions }) // 1 undoステップ
    setSelectedIds(newIds)
    setSelectedStationIds(clone.stationIds)
    setSelectedArrowIds(arrowClone.ids); setSelectedGroupIds(newGroupIds); setSelectedLabelIds(newLabelIds)
  }, [selectedIds, selectedStationIds, selectedLabelIds, selectedGroupIds, selectedArrowIds, tabCards, tabArrows, tabStations, tabRails, tabLabels, tabGroups, activeTabId, dispatch])

  // stations を新IDで複製し、threads（選択駅のみを順序維持で辿ったもの）のうち
  // 2駅以上残るものを新しい路線にするアクション配列を組み立てて返す（dispatch は
  // 呼び出し側が BATCH でまとめる）。stationIds は新しい駅IDの配列。
  function cloneStationsWithThreads(
    stations: CanvasStation[],
    threads: { name: string; color: string; stationIds: string[] }[],
    targetTabId: string, ox: number, oy: number,
  ): { actions: Action[]; stationIds: string[] } {
    if (stations.length === 0) return { actions: [], stationIds: [] }
    const now = new Date().toISOString()
    const actions: Action[] = []
    const idMap = new Map<string, string>()
    for (const s of stations) {
      const id = generateId()
      idMap.set(s.id, id)
      actions.push({ type: 'ADD_CANVAS_STATION', payload: { station: { ...s, id, tabId: targetTabId, x: s.x + ox, y: s.y + oy, createdAt: now } } })
    }
    for (const t of threads) {
      const thread = t.stationIds.filter(id => idMap.has(id)).map(id => idMap.get(id)!)
      if (thread.length >= 2) {
        actions.push({ type: 'ADD_CANVAS_RAIL', payload: { id: generateId(), tabId: targetTabId, name: t.name, color: t.color, stationIds: thread, createdAt: now } })
      }
    }
    return { actions, stationIds: [...idMap.values()] }
  }

  const copyCards = useCallback(() => {
    const sel = tabCards.filter(c => selectedIds.includes(c.id))
    const selStations = tabStations.filter(s => selectedStationIds.includes(s.id))
    const selLabels = tabLabels.filter(l => selectedLabelIds.includes(l.id))
    const selGroups = tabGroups.filter(g => selectedGroupIds.includes(g.id))
    if (sel.length > 0 || selStations.length > 0 || selLabels.length > 0 || selGroups.length > 0 || selectedArrowIds.length > 0) {
      clipboardRef.current = sel.map(c => ({ ...c, pages: c.pages?.map(p => ({ ...p })) }))
      arrowClipboardRef.current = { arrows: tabArrows.map(a => ({ ...a, points: a.points?.map(p => ({ ...p })) })), selectedIds: [...selectedArrowIds] }
      railClipboardRef.current = {
        stations: selStations.map(s => ({ ...s })),
        threads: tabRails.map(r => ({ name: r.name, color: r.color, stationIds: [...r.stationIds] })),
      }
      labelClipboardRef.current = selLabels.map(l => ({ ...l }))
      groupClipboardRef.current = selGroups.map(g => ({ ...g }))
      internalCopyFreshRef.current = true
    }
  }, [tabCards, selectedIds, tabStations, selectedStationIds, tabRails, tabLabels, selectedLabelIds, tabGroups, selectedGroupIds, tabArrows, selectedArrowIds])

  const pasteCards = useCallback((atX?: number, atY?: number) => {
    if (canvasLockedRef.current) return
    const clip = clipboardRef.current
    const railClip = railClipboardRef.current
    const labelClip = labelClipboardRef.current
    const groupClip = groupClipboardRef.current
    const arrowClip = arrowClipboardRef.current
    const freeArrows = clipboardFreeArrows()
    if (!clipboardHasContent()) return
    let ox = 24, oy = 24
    if (atX != null && atY != null) {
      const minX = Math.min(...clip.map(c => c.x), ...railClip.stations.map(s => s.x), ...labelClip.map(l => l.x), ...groupClip.map(g => g.x), ...freeArrows.flatMap(a => [a.x1, a.x2, ...(a.points ?? []).map(p => p.x)]))
      const minY = Math.min(...clip.map(c => c.y), ...railClip.stations.map(s => s.y), ...labelClip.map(l => l.y), ...groupClip.map(g => g.y), ...freeArrows.flatMap(a => [a.y1, a.y2, ...(a.points ?? []).map(p => p.y)]))
      ox = atX - minX
      oy = atY - minY
    }
    const actions: Action[] = []
    const newIds: string[] = []
    const cardIdMap = new Map<string, string>()
    clip.forEach(c => {
      let copy: CanvasCard = {
        ...c, id: generateId(), tabId: activeTabId, locked: false,
        x: c.x + ox, y: c.y + oy,
        pages: c.pages?.map(p => ({ ...p, id: generateId() })),
        createdAt: new Date().toISOString(),
      }
      // ライブラリ参照カードの越境ガード: クリップボードはプロジェクト切替後も残る
      // ため、貼り付け先プロジェクトから参照できないファイル（非所有かつ未リンク、
      // または消滅済み）のカードは url ごと落とす（fail-closed — ピッカーの
      // プロジェクトフィルターを貼り付けで迂回させない）。
      if (copy.refFileId) {
        const f = state.files.find(x => x.id === copy.refFileId)
        const accessible = !!f && (f.masterProjectId === activeProjectId || (f.linkedMasterIds ?? []).includes(activeProjectId))
        if (!accessible) copy = { ...copy, url: '', content: '', refFileId: undefined, bookmarks: undefined, pdf: undefined, crop: undefined }
      }
      actions.push({ type: 'ADD_CANVAS_CARD', payload: copy })
      newIds.push(copy.id)
      cardIdMap.set(c.id, copy.id)
    })
    const arrowClone = cloneArrows(arrowClip.arrows, arrowClip.selectedIds, cardIdMap, activeTabId, ox, oy)
    actions.push(...arrowClone.actions)
    const clone = cloneStationsWithThreads(railClip.stations, railClip.threads, activeTabId, ox, oy)
    actions.push(...clone.actions)
    const newLabelIds: string[] = []
    labelClip.forEach(l => {
      const copy: CanvasLabel = { ...l, id: generateId(), tabId: activeTabId, x: l.x + ox, y: l.y + oy, createdAt: new Date().toISOString() }
      actions.push({ type: 'ADD_CANVAS_LABEL', payload: copy })
      newLabelIds.push(copy.id)
    })
    const newGroupIds: string[] = []
    groupClip.forEach(g => {
      const copy: CanvasGroup = { ...g, id: generateId(), tabId: activeTabId, x: g.x + ox, y: g.y + oy, createdAt: new Date().toISOString() }
      actions.push({ type: 'ADD_CANVAS_GROUP', payload: copy })
      newGroupIds.push(copy.id)
    })
    if (actions.length > 0) dispatch({ type: 'BATCH', payload: actions }) // 1 undoステップ
    setSelectedIds(newIds)
    setSelectedStationIds(clone.stationIds)
    setSelectedArrowIds(arrowClone.ids); setSelectedGroupIds(newGroupIds); setSelectedLabelIds(newLabelIds)
  }, [activeTabId, dispatch, state.files, activeProjectId])

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
    setSelectedGroupIds([group.id])
  }, [tabCards, tabLabels, selectedIds, selectedLabelIds, activeTabId, dispatch])

  const handleCardContextMenu = useCallback((e: React.MouseEvent, card: CanvasCard) => {
    e.preventDefault()
    e.stopPropagation()
    if (!selectedIds.includes(card.id)) {
      setSelectedIds([card.id])
      setSelectedArrowId(null); setSelectedGroupIds([]); setSelectedLabelIds([])
    }
    setContextMenu({ x: Math.min(e.clientX, window.innerWidth - 230), y: Math.min(e.clientY, window.innerHeight - 300), kind: 'card', canvasX: 0, canvasY: 0 })
  }, [selectedIds])

  // Right-click menus for the other element types, so every element shares the same
  // delete flow (right-click → 削除 → confirm modal). Skipped while view-locked.
  const handleLabelContextMenu = useCallback((e: React.MouseEvent, label: CanvasLabel) => {
    if (canvasLockedRef.current) return
    e.preventDefault(); e.stopPropagation()
    setSelectedLabelIds([label.id]); setSelectedIds([]); setSelectedArrowId(null); setSelectedGroupIds([])
    setContextMenu({ x: Math.min(e.clientX, window.innerWidth - 230), y: Math.min(e.clientY, window.innerHeight - 160), kind: 'label', canvasX: 0, canvasY: 0 })
  }, [])

  const handleArrowContextMenu = useCallback((e: React.MouseEvent, arrow: CanvasArrow) => {
    if (canvasLockedRef.current) return
    e.preventDefault(); e.stopPropagation()
    // 複数選択のメンバーを右クリックしたときは選択を保つ（削除はまとめて効く）。
    if (!selectedArrowIdsRef.current.includes(arrow.id)) {
      setSelectedArrowId(arrow.id); setSelectedIds([]); setSelectedLabelIds([]); setSelectedGroupIds([]); setSelectedStationIds([])
    }
    setContextMenu({ x: Math.min(e.clientX, window.innerWidth - 230), y: Math.min(e.clientY, window.innerHeight - 160), kind: 'arrow', canvasX: 0, canvasY: 0 })
  }, [])

  const handleGroupContextMenu = useCallback((e: React.MouseEvent, group: CanvasGroup) => {
    if (canvasLockedRef.current) return
    e.preventDefault(); e.stopPropagation()
    setSelectedGroupIds([group.id]); setSelectedIds([]); setSelectedLabelIds([]); setSelectedArrowId(null)
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
    const nCards = selectedIds.length, nLabels = selectedLabelIds.length, nStations = selectedStationIds.length, nGroups = selectedGroupIds.length
    // 複数選択に含まれる矢印のうち、カード削除で一緒に消えないもの（両端が残る矢印）だけ数える。
    const cardSet = new Set(selectedIds)
    const aids = selectedArrowIds.filter(id => {
      const a = tabArrowsRef.current.find(x => x.id === id)
      return a && !(a.fromCardId && cardSet.has(a.fromCardId)) && !(a.toCardId && cardSet.has(a.toCardId))
    })
    const nArrows = aids.length
    if (nCards + nLabels + nStations + nGroups > 0 || selectedArrowIds.length > 1) {
      const parts: string[] = []
      if (nCards) parts.push(`カード${nCards}枚`)
      if (nLabels) parts.push(`ラベル${nLabels}個`)
      if (nStations) parts.push(`駅${nStations}個`)
      if (nGroups) parts.push(`グループ枠${nGroups}個`)
      if (nArrows) parts.push(`矢印${nArrows}本`)
      const ids = [...selectedIds], lids = [...selectedLabelIds], sids = [...selectedStationIds], gids = [...selectedGroupIds]
      // グループ枠は枠だけ消える（中のカードは、それ自体が選択されていない限り残る）。
      const groupNote = nGroups && !nCards ? 'グループ枠は枠のみ消え、中のカードは残ります。' : ''
      setConfirmDelete({
        message: `${parts.join('・')}を削除します。${nStations ? '駅は通っている路線からも外れます。' : ''}${groupNote}元に戻すには Ctrl+Z。`,
        run: () => {
          dispatch({ type: 'BATCH', payload: [ // まとめて1 undoステップ
            ...ids.map(id => ({ type: 'DELETE_CANVAS_CARD' as const, payload: id })),
            ...lids.map(id => ({ type: 'DELETE_CANVAS_LABEL' as const, payload: id })),
            ...sids.map(id => ({ type: 'DELETE_CANVAS_STATION' as const, payload: id })),
            ...gids.map(id => ({ type: 'DELETE_CANVAS_GROUP' as const, payload: id })),
            ...aids.map(id => ({ type: 'DELETE_CANVAS_ARROW' as const, payload: id })),
          ] })
          setSelectedIds([]); setSelectedLabelIds([]); setSelectedStationIds([]); setSelectedGroupIds([]); setSelectedArrowIds([])
        },
      })
    } else if (selectedArrowId) {
      const id = selectedArrowId
      setConfirmDelete({ message: '矢印を削除します。元に戻すには Ctrl+Z。', run: () => { dispatch({ type: 'DELETE_CANVAS_ARROW', payload: id }); setSelectedArrowId(null) } })
    }
  }, [selectedIds, selectedLabelIds, selectedArrowId, selectedArrowIds, selectedGroupIds, selectedStationIds, dispatch])

  // Keyboard: Delete removes the selection, Ctrl+D duplicates, Escape exits the active tool
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // While the delete-confirmation modal is open, only Enter/Space (confirm) / Escape (cancel) apply.
      if (confirmDelete) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          // ConfirmHost と同じ規約: フォーカス中のモーダル内ボタンを押す。
          // Shift+Tab でキャンセルへ移った後の Enter/Space が削除を実行しないように。
          const focused = document.activeElement as HTMLElement | null
          if (focused && focused.tagName === 'BUTTON' && focused.closest('[data-canvas-confirm]')) focused.click()
          else { confirmDelete.run(); setConfirmDelete(null) }
        }
        else if (e.key === 'Escape') { e.preventDefault(); setConfirmDelete(null) }
        return
      }
      const ae = document.activeElement as HTMLElement | null
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) {
        // Escape blurs whatever input is focused so the NEXT Escape reaches the
        // canvas-level handler (exit tool / clear selection).
        if (e.key === 'Escape') { ae.blur(); return }
        // Tab / Enter inside a タスク下書き title commits the title (blur) and
        // falls THROUGH to the extend branches below (Tab=子 / Enter=兄弟) —
        // Flow-page style keyboard chaining without mouse round-trips. The
        // keyCode 229 check mirrors the input's own IME guard (line ~221).
        const composing = e.isComposing || e.keyCode === 229
        if ((e.key === 'Tab' || (e.key === 'Enter' && !composing)) && ae.dataset.draftTitle) ae.blur()
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
          if (e.shiftKey) {
            if (selectedGroupIds.length > 0) {
              dispatch({ type: 'BATCH', payload: selectedGroupIds.map(id => ({ type: 'DELETE_CANVAS_GROUP' as const, payload: id })) }) // まとめて1 undoステップ
              setSelectedGroupIds([])
            }
          }
          else groupSelection()
        }
        return
      }
      // 全選択はカード・駅だけでなくラベル・グループ枠も対象にする（移動/削除に参加させる）。
      if (mod && (e.key === 'a' || e.key === 'A')) { e.preventDefault(); setSelectedIds(tabCardsRef.current.map(c => c.id)); setSelectedStationIds(tabStationsRef.current.map(s => s.id)); setSelectedLabelIds(tabLabelsRef.current.map(l => l.id)); setSelectedGroupIds(tabGroupsRef.current.map(g => g.id)); setSelectedArrowIds(tabArrowsRef.current.map(a => a.id)); return }
      if (mod && (e.key === 'c' || e.key === 'C')) {
        // 本文テキストを範囲選択中はネイティブのテキストコピーを優先する
        // （ここで preventDefault するとカード内テキストが一切コピーできない）。
        const sel = window.getSelection()
        if (sel && !sel.isCollapsed && sel.toString().trim()) return
        e.preventDefault(); copyCards(); return
      }
      // Ctrl+V is handled by the native 'paste' event listener (so clipboard image
      // data is available); preventing it here would suppress that event.
      if (!locked && (selectedIds.length > 0 || selectedLabelIds.length > 0 || selectedStationIds.length > 0 || selectedGroupIds.length > 0 || selectedArrowIds.length > 0) && e.key.startsWith('Arrow')) {
        e.preventDefault()
        const base = snapRef.current ? 20 : 1
        const step = e.shiftKey ? base * 10 : base
        const nx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
        const ny = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0
        const sel = new Set(selectedIds)
        tabCardsRef.current.forEach(c => { if (sel.has(c.id) && !c.locked) dispatch({ type: 'MOVE_CANVAS_CARD', payload: { id: c.id, x: c.x + nx, y: c.y + ny } }) })
        // 矢印はドラッグ移動と同じ規則: 両端が一緒に動く場合だけ自由端・経由点を動かす
        // （ロック済みカードは上で動いていないので端点集合からも外す）。
        const moving = new Set(tabCardsRef.current.filter(c => sel.has(c.id) && !c.locked).map(c => c.id))
        const asel = new Set(selectedArrowIds)
        tabArrowsRef.current.forEach(a => {
          const fromIn = a.fromCardId ? moving.has(a.fromCardId) : asel.has(a.id)
          const toIn = a.toCardId ? moving.has(a.toCardId) : asel.has(a.id)
          if (!fromIn || !toIn || (a.fromCardId && a.toCardId && !(a.points?.length))) return
          dispatch({ type: 'UPDATE_CANVAS_ARROW', payload: {
            ...a,
            ...(a.fromCardId ? {} : { x1: a.x1 + nx, y1: a.y1 + ny }),
            ...(a.toCardId ? {} : { x2: a.x2 + nx, y2: a.y2 + ny }),
            points: a.points?.map(p => ({ x: p.x + nx, y: p.y + ny })),
          } })
        })
        const lsel = new Set(selectedLabelIds)
        tabLabelsRef.current.forEach(l => { if (lsel.has(l.id)) dispatch({ type: 'UPDATE_CANVAS_LABEL', payload: { ...l, x: l.x + nx, y: l.y + ny } }) })
        const ssel = new Set(selectedStationIds)
        tabStationsRef.current.forEach(s => { if (ssel.has(s.id)) dispatch({ type: 'UPDATE_CANVAS_STATION', payload: { ...s, x: s.x + nx, y: s.y + ny } }) })
        // 選択中のグループは枠だけ動かす — 中身は自身が選択されていれば上で動いている。
        const gsel = new Set(selectedGroupIds)
        tabGroupsRef.current.forEach(g => { if (gsel.has(g.id)) dispatch({ type: 'UPDATE_CANVAS_GROUP', payload: { ...g, x: g.x + nx, y: g.y + ny } }) })
        return
      }
      if (e.key === 'Escape') { setTool('select'); setSelectedIds([]); setSelectedArrowId(null); setEditingArrowId(null); setSelectedGroupIds([]); setSelectedLabelIds([]); setEditingLabelId(null); setSelectedStationIds([]); setEditingStationId(null); setShowAddMenu(false); setContextMenu(null); setConvertOpen(false); setPickerOpenCardId(null); setDetachOpenCardId(null); setPickerChecked([]) }
      if (!locked && (e.key === 'Delete' || e.key === 'Backspace')) {
        if (selectedIds.length > 0 || selectedLabelIds.length > 0 || selectedArrowIds.length > 0 || selectedGroupIds.length > 0 || selectedStationIds.length > 0) {
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
          // Draft chains are task-parent lines — same emerald as the 端子 gesture.
          ...(extendDraft ? { color: TASK_LINK_COLOR, width: TASK_LINK_WIDTH } : {}),
          createdAt: new Date().toISOString(),
        }
        dispatch({ type: 'ADD_CANVAS_CARD', payload: newCard })
        dispatch({ type: 'ADD_CANVAS_ARROW', payload: arrow })
        setSelectedIds([newCard.id]); setSelectedArrowId(null); setSelectedGroupIds([]); setSelectedLabelIds([])
        return
      }
      // Enter-to-extend (Flow parity): from a selected 下書き, Enter spawns a
      // SIBLING right below it. If the source has a parent (a draft/task card
      // with an arrow into it), the sibling hangs off the same parent with the
      // same emerald task line.
      if (!locked && e.key === 'Enter' && !e.isComposing && e.keyCode !== 229 && selectedIds.length === 1 && !editingLabelId && !editingArrowId) {
        const src = tabCardsRef.current.find(c => c.id === selectedIds[0])
        if (!src || src.type !== 'taskDraft') return
        e.preventDefault()
        const GAP = 24
        const newCard: CanvasCard = {
          id: generateId(), tabId: activeTabId, type: 'taskDraft', title: '', content: '',
          x: src.x, y: src.y + src.height + GAP,
          width: src.width, height: src.height, createdAt: new Date().toISOString(),
        }
        dispatch({ type: 'ADD_CANVAS_CARD', payload: newCard })
        const pArrow = tabArrowsRef.current.find(a => a.toCardId === src.id && a.fromCardId)
        const parent = pArrow ? tabCardsRef.current.find(c => c.id === pArrow.fromCardId) : undefined
        if (parent && (parent.type === 'taskDraft' || parent.refTaskId)) {
          const arrow: CanvasArrow = {
            id: generateId(), tabId: activeTabId,
            x1: parent.x + parent.width, y1: parent.y + parent.height / 2,
            x2: newCard.x, y2: newCard.y + newCard.height / 2,
            fromCardId: parent.id, toCardId: newCard.id,
            color: TASK_LINK_COLOR, width: TASK_LINK_WIDTH,
            createdAt: new Date().toISOString(),
          }
          dispatch({ type: 'ADD_CANVAS_ARROW', payload: arrow })
        }
        setSelectedIds([newCard.id]); setSelectedArrowId(null); setSelectedGroupIds([]); setSelectedLabelIds([])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedIds, selectedLabelIds, selectedArrowId, selectedArrowIds, selectedGroupIds, selectedStationIds, dispatch, undo, redo, duplicateSelection, copyCards, pasteCards, groupSelection, confirmDelete, requestDeleteSelection])

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
      const hasCards = clipboardHasContent()
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

  // 一括配置 — the first checked task links into the picker's own card; every
  // additional task becomes a new todo card, fanned out in a grid below it
  // (3 per row) so a burst of 10 doesn't stack into an invisible pile.
  function bulkPlaceTaskCards(card: CanvasCard, taskIds: string[]) {
    if (taskIds.length === 0) return
    // Card titles mirror the linked task's name — a wall of cards all headed
    // "TODO" is unreadable on the minimap and in canvas search.
    const taskTitleById = new Map(state.projects.flatMap(p => p.tasks.map(t => [t.id, t.title] as const)))
    const cfg = cardTypes.todo
    // An UNLINKED picker card absorbs the first task; a card that already
    // mirrors a task keeps its link — every checked task becomes a new card.
    let rest = taskIds
    if (!card.refTaskId) {
      dispatch({ type: 'UPDATE_CANVAS_CARD', payload: { ...card, refTaskId: taskIds[0], title: taskTitleById.get(taskIds[0]) || card.title } })
      rest = taskIds.slice(1)
    }
    const gap = 16
    const perRow = 3
    const newIds: string[] = []
    rest.forEach((taskId, i) => {
      const col = i % perRow
      const row = Math.floor(i / perRow)
      const nc: CanvasCard = {
        id: generateId(), tabId: activeTabId, type: 'todo', title: taskTitleById.get(taskId) || cfg.label, content: '',
        refTaskId: taskId,
        x: card.x + col * (cfg.defaultWidth + gap),
        y: card.y + card.height + gap + row * (cfg.defaultHeight + gap),
        width: cfg.defaultWidth, height: cfg.defaultHeight, createdAt: new Date().toISOString(),
      }
      dispatch({ type: 'ADD_CANVAS_CARD', payload: nc })
      newIds.push(nc.id)
    })
    setSelectedIds([card.id, ...newIds])
    setPickerOpenCardId(null)
    setPickerChecked([])
  }

  // Shape cards skip addCard: they start with an EMPTY title (the label is
  // opt-in via double-click) and take their default size from the figure.
  function addShapeCard(kind: ShapeKind, at?: { x: number; y: number }) {
    if (canvasLockedRef.current) return
    const vp = viewportRef.current
    const rect = canvasRef.current?.getBoundingClientRect()
    const scx = rect ? rect.width / 2 : 400
    const scy = rect ? rect.height / 2 : 300
    const size = SHAPE_DEFAULT_SIZE[kind]
    const x = at ? at.x - size.w / 2 : (scx - vp.x) / vp.zoom - size.w / 2
    const y = at ? at.y : (scy - vp.y) / vp.zoom - size.h / 2
    const card: CanvasCard = {
      id: generateId(), tabId: activeTabId, type: 'shape', shape: kind, title: '', content: '',
      x, y, width: size.w, height: size.h, createdAt: new Date().toISOString(),
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

  function addTab(boardId?: string) {
    if (!activeProjectId) return
    const tab: CanvasTab = { id: generateId(), projectId: activeProjectId, boardId, name: '新しいカテゴリー', createdAt: new Date().toISOString() }
    dispatch({ type: 'ADD_CANVAS_TAB', payload: tab })
    setActiveTabId(tab.id)
    setEditingTabId(tab.id)
    // Sidebar collapsed → its edit input can't mount; host the rename in the
    // title bar instead (the new tab just became active, so it's rendered).
    setEditingTabInTitle(panelCollapsed)
    setViewport({ x: 0, y: 0, zoom: 1 })
    if (boardId) setClosedBoards(prev => { if (!prev.has(boardId)) return prev; const next = new Set(prev); next.delete(boardId); return next })
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
    if (!cards.length && !tabStations.length) { setViewport({ x: 0, y: 0, zoom: 1 }); return }
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return
    const pad = 60
    // 駅ノードも収める（カードの無い路線図専用タブでも全体表示が効くように）
    const minX = Math.min(...cards.map(c => c.x), ...tabStations.map(s => s.x - 30)) - pad
    const minY = Math.min(...cards.map(c => c.y), ...tabStations.map(s => s.y - 30)) - pad
    const maxX = Math.max(...cards.map(c => c.x + c.width), ...tabStations.map(s => s.x + 30)) + pad
    const maxY = Math.max(...cards.map(c => c.y + c.height), ...tabStations.map(s => s.y + 30)) + pad
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
    // html-to-image は <video> を要素ボックスへ引き伸ばして描く（object-fit 無視）ので、
    // 正しいアスペクトで合成した canvas を重ねてから撮る。
    const unfreeze = freezeVideosForExport(el)
    const unhide = hideExportOnlyUi()
    try {
      const dataUrl = await toPng(el, {
        pixelRatio: 2,
        backgroundColor: document.documentElement.classList.contains('dark') ? '#171717' : '#ffffff',
        filter: node => !(node instanceof HTMLElement && node.dataset.exportIgnore === '1'),
      })
      const a = document.createElement('a')
      const tabName = state.canvasTabs.find(t => t.id === activeTabId)?.name || 'canvas'
      a.href = dataUrl
      a.download = `constella-${tabName}.png`
      a.click()
    } catch { /* ignore */ } finally { unfreeze(); unhide() }
  }, [state.canvasTabs, activeTabId])

  // 共有用HTML書き出し — Constella を持たない相手にも、単一の .html ファイルだけで
  // キャンバス全域をパン/ズーム付きでそのまま見せられる。動画/音声は埋め込み再生可。
  const [exportingShare, setExportingShare] = useState(false)
  const [shareMenuOpen, setShareMenuOpen] = useState(false)
  // 動画・音声の埋め込み上限（MB）。-1=無制限、0=埋め込まない（静止画のみ）。
  const [shareEmbedLimitMB, setShareEmbedLimitMB] = useState<number>(() => {
    const v = Number(localStorage.getItem('constella.shareEmbedLimitMB'))
    return Number.isFinite(v) && (v === -1 || v >= 0) ? v : 150
  })
  const shareMenuRef = usePopoverDismiss<HTMLDivElement>(shareMenuOpen, () => setShareMenuOpen(false))
  const setShareLimit = (v: number) => {
    setShareEmbedLimitMB(v)
    localStorage.setItem('constella.shareEmbedLimitMB', String(v))
  }
  // 上限超の動画を 720p/WebM に再エンコードして埋め込むか（実時間かかる）
  const [shareTranscode, setShareTranscode] = useState(() => localStorage.getItem('constella.shareTranscode') === '1')
  const toggleShareTranscode = () => {
    setShareTranscode(v => { localStorage.setItem('constella.shareTranscode', v ? '0' : '1'); return !v })
  }
  // 書き出し進捗（再エンコードは長いのでトーストで見せる）
  const [shareProgress, setShareProgress] = useState<string | null>(null)
  // 容量シミュレーション: メニューを開いたら現在タブの動画/音声サイズを集計
  const [shareSizes, setShareSizes] = useState<Array<{ id: string; title: string; size: number }> | null>(null)
  useEffect(() => {
    if (!shareMenuOpen) { setShareSizes(null); return }
    let alive = true
    ;(async () => {
      const items: Array<{ id: string; title: string; size: number }> = []
      for (const c of tabCards) {
        if ((c.type !== 'video' && c.type !== 'audio') || !c.url) continue
        if (c.type === 'video' && videoEmbedUrl(c.url)) continue // YouTube等はリンク化なのでゼロ
        let size = 0
        try {
          if (isMediaRef(c.url)) size = (await getMediaBlob(c.url))?.size ?? 0
          else if (isLocalRef(c.url)) size = (await localFileApi()?.stat(localRefPath(c.url)))?.size ?? 0
        } catch { /* ignore */ }
        if (size > 0) items.push({ id: c.id, title: c.title || c.content || '(無題)', size })
      }
      if (alive) setShareSizes(items)
    })()
    return () => { alive = false }
  }, [shareMenuOpen, tabCards])
  const exportShareHtml = useCallback(async () => {
    const layer = layerRef.current
    if (!layer || !activeTabId || exportingShare) return
    // 全コンテンツ（カード/グループ/ラベル/ペン線）のバウンディングボックス
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    const acc = (x: number, y: number, w = 0, h = 0) => {
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x + w > maxX) maxX = x + w
      if (y + h > maxY) maxY = y + h
    }
    tabCards.forEach(c => acc(c.x, c.y, c.width, c.height))
    tabGroups.forEach(g => acc(g.x, g.y, g.width, g.height))
    tabLabels.forEach(l => { const b = labelBox(l); acc(b.x, b.y, b.w, b.h) })
    tabStrokes.forEach(s => { for (let i = 0; i + 1 < s.points.length; i += 2) acc(s.points[i], s.points[i + 1]) })
    tabStations.forEach(s => acc(s.x - 30, s.y - 30, 60, 60))
    tabArrows.forEach(a => {
      const ends = resolveArrowEnds(a, cardsById)
      acc(ends.x1, ends.y1)
      acc(ends.x2, ends.y2)
      a.points?.forEach(p => acc(p.x, p.y))
    })
    if (!isFinite(minX)) return
    const pad = 60
    minX = Math.floor(minX - pad); minY = Math.floor(minY - pad)
    const w = Math.ceil(maxX + pad - minX)
    const h = Math.ceil(maxY + pad - minY)
    // メディア枠の位置は「非同期処理が始まる前」に同期的に測ってキャンバス座標へ
    // 正規化しておく。toSvg は数秒かかることがあり、その間にユーザーがズーム/パン
    // すると、後から古い zoom 値で換算した座標が距離に比例して大きくズレるため。
    // スケールも state ではなく実 DOM の transform 行列（ground truth）から取る。
    const layerRect = layer.getBoundingClientRect()
    const mtx = new DOMMatrixReadOnly(getComputedStyle(layer).transform)
    const layerScale = mtx.a || 1
    const toCanvasRect = (r: DOMRect) => ({
      x: (r.left - layerRect.left) / layerScale - minX,
      y: (r.top - layerRect.top) / layerScale - minY,
      w: r.width / layerScale,
      h: r.height / layerScale,
    })
    type MediaBoxEntry = {
      card: CanvasCard; url: string; el: HTMLElement
      x: number; y: number; w: number; h: number
      // ブックマーク行（カード下部のチップ列）の位置。共有HTMLではこの位置に
      // クリックでシークできるチップを重ねる。
      marksBox?: { x: number; y: number; w: number; h: number }
    }
    const mediaBoxes: MediaBoxEntry[] = []
    for (const el of Array.from(layer.querySelectorAll<HTMLElement>('[data-media-box]'))) {
      const card = tabCards.find(c => c.id === el.dataset.mediaBox)
      if (!card?.url) continue
      const r = el.getBoundingClientRect()
      let marksBox: MediaBoxEntry['marksBox']
      if ((card.type === 'video' || card.type === 'audio') && (card.bookmarks?.length ?? 0) > 0) {
        const marksEl = layer.querySelector<HTMLElement>(`[data-share-marks="${CSS.escape(card.id)}"]`)
        if (marksEl) marksBox = toCanvasRect(marksEl.getBoundingClientRect())
      }
      mediaBoxes.push({ card, url: card.url, el, ...toCanvasRect(r), marksBox })
    }
    setExportingShare(true)
    setShareProgress('スナップショットを生成中…')
    const unfreeze = freezeVideosForExport(layer)
    const unhide = hideExportOnlyUi()
    try {
      const { toSvg } = await import('html-to-image')
      // レイヤーを translate(-minX,-minY) zoom1 に差し替えたクローンで全域を撮る。
      // 背景は透過のまま（ビューア側でドットグリッドを敷く）。フォントは埋め込まず
      // 閲覧側のシステムフォントにフォールバック（日本語フォント同梱は数十MBになるため）。
      const snapshot = await toSvg(layer, {
        width: w,
        height: h,
        style: { transform: `translate(${-minX}px, ${-minY}px) scale(1)`, transformOrigin: '0 0', width: `${w}px`, height: `${h}px` },
        skipFonts: true,
        filter: node => !(node instanceof HTMLElement && node.dataset.exportIgnore === '1'),
      })
      // 動画/音声カードの位置に実プレイヤーを、YouTube/Vimeo/Web カードの位置に
      // 外部リンクカードを重ねるためのオーバーレイを収集（位置は事前測定済み）
      const overlays: ShareOverlay[] = []
      let skipped = 0
      for (const { card, url, el, marksBox, ...box } of mediaBoxes) {
        // YouTube/Vimeo/Web カード: file:// で開かれた共有 HTML では iframe 埋め込みが
        // 拒否される（YouTube の origin 制約 / 一般サイトの X-Frame-Options）ため、
        // サムネイル＋新しいタブで開くリンクカードにする。Electron なら webview の
        // 実画面キャプチャをサムネイルに使い、失敗時は YouTube 公式サムネへ。
        const isEmbedCard = card.type === 'video' && videoEmbedUrl(url) != null
        if (isEmbedCard || card.type === 'web') {
          let thumb: string | undefined
          let href = url
          let label = card.title || card.content || url
          const wv = el.querySelector('webview') as WebviewEl | null
          if (wv?.capturePage) {
            try { thumb = (await wv.capturePage()).toDataURL() } catch { /* ignore */ }
          }
          if (!isEmbedCard && wv) {
            // Web カードは webview 内で別ページへ遷移していても card.url が初期 URL の
            // ままなので、リンク先は現在表示中のページにする。埋め込み動画カードは
            // webview の URL がローカルラッパー(127.0.0.1)なので card.url のまま。
            try {
              const live = wv.getURL?.() || ''
              if (/^https?:\/\//.test(live) && !/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(live)) {
                href = live
                label = wv.getTitle?.() || card.title || live
              }
            } catch { /* ignore */ }
          }
          if (!thumb && isEmbedCard) {
            const ref = parseEmbedRef(url)
            if (ref?.provider === 'yt') thumb = `https://i.ytimg.com/vi/${ref.id}/hqdefault.jpg`
          }
          overlays.push({ kind: 'link', ...box, href, label, thumb })
          continue
        }
        if (shareEmbedLimitMB === 0) continue // 埋め込まない設定（静止画のまま）
        let blob = isMediaRef(url) ? await getMediaBlob(url) : isLocalRef(url) ? await getLocalBlob(url) : null
        if (!blob) continue
        let mime = blob.type || guessMediaMime(card.content || url, card.type === 'audio' ? 'audio' : 'video')
        const limitBytes = shareEmbedLimitMB * 1024 * 1024
        if (shareEmbedLimitMB !== -1 && blob.size > limitBytes) {
          // 上限超え: オプションが有効な動画は 720p/WebM に再エンコードして収める
          const title = card.title || card.content || '動画'
          if (!shareTranscode || card.type !== 'video') { skipped++; continue }
          setShareProgress(`動画を再エンコード中… ${title}`)
          const out = await transcodeVideoBlob(blob, {
            targetBytes: limitBytes,
            onProgress: r => setShareProgress(`動画を再エンコード中 ${Math.round(r * 100)}% — ${title}`),
          })
          if (!out || out.size > limitBytes) { skipped++; continue }
          blob = out
          mime = 'video/webm'
        }
        setShareProgress('メディアを埋め込み中…')
        const dataUrl = await new Promise<string>((res, rej) => {
          const fr = new FileReader()
          fr.onload = () => res(fr.result as string)
          fr.onerror = () => rej(fr.error)
          fr.readAsDataURL(blob)
        })
        const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
        overlays.push({ kind: card.type === 'audio' ? 'audio' : 'video', ...box, base64, mime, cardId: card.id })
        // ブックマークは、スナップショットに写っているカード下部のチップ行と同じ
        // 位置にクリック可能なチップを重ねる（動画上に浮かせると視覚的にズレて見える）
        if (marksBox && (card.bookmarks?.length ?? 0) > 0) {
          overlays.push({
            kind: 'marks',
            ...marksBox,
            cardId: card.id,
            accent: card.type === 'audio' ? '#ea580c' : '#c026d3',
            marks: (card.bookmarks ?? []).slice().sort((a, b) => a.time - b.time)
              .map(b => ({ t: Number(b.time), time: fmtTimecode(Number(b.time) || 0), label: b.label ?? '' })),
          })
        }
      }
      const mod = (n: number) => ((n % 20) + 20) % 20
      const tabName = state.canvasTabs.find(t => t.id === activeTabId)?.name || 'canvas'
      // toSvg の data URL から生 SVG を取り出してインライン埋め込み（テキスト選択可能に）
      const rawSvg = decodeURIComponent(snapshot.slice(snapshot.indexOf(',') + 1))
      const html = buildShareHtml({
        title: tabName,
        width: w,
        height: h,
        snapshotSvg: rawSvg,
        dark: document.documentElement.classList.contains('dark'),
        gridOffsetX: mod(-minX - 10),
        gridOffsetY: mod(-minY - 10),
        overlays,
      })
      const blob = new Blob([html], { type: 'text/html' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `constella-${tabName.replace(/[\\/:*?"<>|]/g, '_')}-share.html`
      document.body.appendChild(a); a.click(); a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      if (skipped) await alertDialog(`${skipped}件のメディアが埋め込み上限（${shareEmbedLimitMB}MB）を超えるためスキップしました（静止画のまま書き出されています）。上限は共有ボタンのメニューで変更できます。`)
    } catch (e) {
      console.warn('share html export failed', e)
      await alertDialog('共有用HTMLの書き出しに失敗しました。')
    } finally {
      unfreeze()
      unhide()
      setExportingShare(false)
      setShareProgress(null)
    }
  }, [activeTabId, exportingShare, tabCards, tabGroups, tabLabels, tabStrokes, tabStations, tabArrows, cardsById, state.canvasTabs, shareEmbedLimitMB, shareTranscode])

  // Sidebar row for one canvas tab (小カテゴリー). Draggable onto board headers.
  const renderTabRow = (tab: CanvasTab) => (
    <div
      key={tab.id}
      draggable={editingTabId !== tab.id}
      onDragStart={e => { e.dataTransfer.setData('text/constella-canvas-tab', tab.id); e.dataTransfer.effectAllowed = 'move'; setDraggingTabId(tab.id) }}
      onDragEnd={() => { setDraggingTabId(null); setTabDragOverBoard(null) }}
      className={`group flex items-center gap-1.5 pl-7 pr-2 py-1 cursor-pointer text-xs ${
        activeTabId === tab.id ? 'bg-indigo-100/70 text-indigo-700 font-medium' : 'text-slate-600 hover:bg-slate-100'
      }`}
      onClick={() => selectTab(tab.id)}
    >
      <LayoutGrid size={11} className={activeTabId === tab.id ? 'text-indigo-500 shrink-0' : 'text-slate-400 shrink-0'} />
      {editingTabId === tab.id && !editingTabInTitle ? (
        <input
          autoFocus
          type="text"
          value={tab.name}
          onChange={e => dispatch({ type: 'UPDATE_CANVAS_TAB', payload: { ...tab, name: e.target.value } })}
          onBlur={() => setEditingTabId(null)}
          onKeyDown={e => { if (e.nativeEvent.isComposing || e.keyCode === 229) return; if (e.key === 'Enter' || e.key === 'Escape') { e.stopPropagation(); setEditingTabId(null) } }}
          onClick={e => e.stopPropagation()}
          className="flex-1 min-w-0 bg-transparent border-none outline-none text-xs text-slate-800"
        />
      ) : (
        <span className="flex-1 min-w-0 truncate" onDoubleClick={e => { e.stopPropagation(); setEditingTabId(tab.id); setEditingTabInTitle(false) }} title="ダブルクリックで名前を編集">{tab.name}</span>
      )}
      <span className="text-[10px] text-slate-400 shrink-0">{cardCountByTab.get(tab.id) ?? 0}</span>
      {projectTabs.length > 1 && (
        <button
          onClick={e => { e.stopPropagation(); deleteTab(tab.id) }}
          className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-slate-200 text-slate-400 hover:text-rose-500 transition-all shrink-0"
        >
          <X size={11} />
        </button>
      )}
    </div>
  )

  const unassignedTabs = projectTabs.filter(t => !t.boardId || !projectBoards.some(b => b.id === t.boardId))

  return (
    <div className="flex h-full">
      {/* ボードパネル — 大カテゴリー(ボード) > 小カテゴリー(タブ)。ノートのフォルダー欄と同じ文法 */}
      <div className={`${panelCollapsed ? 'w-10' : 'w-56'} shrink-0 border-r border-slate-200 bg-slate-50 flex flex-col transition-[width] duration-150`}>
        {panelCollapsed ? (
          <button
            onClick={() => setPanelCollapsed(false)}
            className="p-2.5 text-slate-400 hover:text-slate-700 transition-colors"
            title="ボードパネルを開く"
          ><PanelLeftOpen size={16} /></button>
        ) : (
          <>
            <div className="flex items-center gap-0.5 px-2 py-2 border-b border-slate-200 shrink-0">
              <span className="text-xs font-semibold text-slate-600 flex-1 select-none">ボード</span>
              <button onClick={addBoard} className="p-1 rounded text-slate-400 hover:text-slate-700 hover:bg-slate-100" title="ボードを追加"><FolderPlus size={14} /></button>
              <button onClick={() => addTab()} className="p-1 rounded text-slate-400 hover:text-slate-700 hover:bg-slate-100" title="カテゴリーを追加（未分類）"><Plus size={14} /></button>
              <button onClick={() => setPanelCollapsed(true)} className="p-1 rounded text-slate-400 hover:text-slate-700 hover:bg-slate-100" title="パネルを畳む"><PanelLeftClose size={14} /></button>
            </div>
            <div className="flex-1 overflow-y-auto py-1">
              {projectBoards.map(board => {
                const tabs = projectTabs.filter(t => t.boardId === board.id)
                const closed = closedBoards.has(board.id)
                return (
                  <div key={board.id}>
                    <div
                      className={`group flex items-center gap-1 px-2 py-1.5 cursor-pointer hover:bg-slate-100 ${
                        tabDragOverBoard === board.id ? 'bg-indigo-50 ring-1 ring-inset ring-indigo-300' : ''
                      }`}
                      onClick={() => setClosedBoards(prev => { const next = new Set(prev); if (next.has(board.id)) next.delete(board.id); else next.add(board.id); return next })}
                      onDragOver={e => { if (draggingTabId) { e.preventDefault(); setTabDragOverBoard(board.id) } }}
                      onDragLeave={() => setTabDragOverBoard(cur => (cur === board.id ? null : cur))}
                      onDrop={e => dropTabOnBoard(e, board.id)}
                    >
                      <ChevronRight size={12} className={`text-slate-400 shrink-0 transition-transform ${closed ? '' : 'rotate-90'}`} />
                      <FolderColorSwatch value={board.color} onChange={c => dispatch({ type: 'UPDATE_CANVAS_BOARD', payload: { ...board, color: c } })} className="shrink-0" />
                      {editingBoardId === board.id ? (
                        <input
                          autoFocus
                          type="text"
                          value={board.name}
                          onChange={e => dispatch({ type: 'UPDATE_CANVAS_BOARD', payload: { ...board, name: e.target.value } })}
                          onBlur={() => setEditingBoardId(null)}
                          onKeyDown={e => { if (e.nativeEvent.isComposing || e.keyCode === 229) return; if (e.key === 'Enter' || e.key === 'Escape') { e.stopPropagation(); setEditingBoardId(null) } }}
                          onClick={e => e.stopPropagation()}
                          className="flex-1 min-w-0 bg-transparent border-none outline-none text-xs font-medium text-slate-800"
                        />
                      ) : (
                        <span
                          className="flex-1 min-w-0 truncate text-xs font-medium text-slate-700 select-none"
                          onDoubleClick={e => { e.stopPropagation(); setEditingBoardId(board.id) }}
                          title="ダブルクリックで名前を編集"
                        >{board.name}</span>
                      )}
                      <span className="text-[10px] text-slate-400 shrink-0">{tabs.length}</span>
                      <button
                        onClick={e => { e.stopPropagation(); addTab(board.id) }}
                        className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-slate-200 text-slate-400 hover:text-indigo-600 transition-all shrink-0"
                        title="このボードにカテゴリーを追加"
                      ><Plus size={12} /></button>
                      <button
                        onClick={e => { e.stopPropagation(); deleteBoard(board) }}
                        className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-slate-200 text-slate-400 hover:text-rose-500 transition-all shrink-0"
                        title="ボードを削除（中のカテゴリーは未分類へ）"
                      ><X size={12} /></button>
                    </div>
                    {!closed && tabs.map(renderTabRow)}
                    {!closed && tabs.length === 0 && (
                      <div className="pl-9 pr-2 py-1 text-[10px] text-slate-400 select-none">カテゴリーなし — ＋で追加</div>
                    )}
                  </div>
                )
              })}
              {(unassignedTabs.length > 0 || projectBoards.length > 0) && (
                <div
                  className={`flex items-center gap-1 px-2 py-1.5 mt-1 ${tabDragOverBoard === '__none__' ? 'bg-indigo-50 ring-1 ring-inset ring-indigo-300' : ''}`}
                  onDragOver={e => { if (draggingTabId) { e.preventDefault(); setTabDragOverBoard('__none__') } }}
                  onDragLeave={() => setTabDragOverBoard(cur => (cur === '__none__' ? null : cur))}
                  onDrop={e => dropTabOnBoard(e, undefined)}
                >
                  <span className="text-[10px] text-slate-400 font-medium flex-1 select-none">未分類</span>
                  <span className="text-[10px] text-slate-400">{unassignedTabs.length}</span>
                </div>
              )}
              {unassignedTabs.map(renderTabRow)}
            </div>
          </>
        )}
      </div>

      <div className="flex flex-col flex-1 min-w-0">
      {/* キャンバスタイトル — ボード名 > タブ名。タブバー廃止後の現在地表示 */}
      {activeTabId && (() => {
        const tab = projectTabs.find(t => t.id === activeTabId)
        if (!tab) return null
        const board = tab.boardId ? projectBoards.find(b => b.id === tab.boardId) : undefined
        return (
          <div className="flex items-center gap-1.5 px-4 py-1.5 border-b border-slate-200 bg-white shrink-0">
            {board ? (
              <>
                {board.color && BOARD_COLOR_CLASSES[board.color] && <span className={`w-2 h-2 rounded-full shrink-0 ${BOARD_COLOR_CLASSES[board.color].dot}`} />}
                <span className="text-xs text-slate-400 truncate max-w-[160px]">{board.name}</span>
                <ChevronRight size={12} className="text-slate-300 shrink-0" />
              </>
            ) : (
              <>
                <span className="text-xs text-slate-400">未分類</span>
                <ChevronRight size={12} className="text-slate-300 shrink-0" />
              </>
            )}
            {editingTabId === tab.id && editingTabInTitle ? (
              <input
                autoFocus
                type="text"
                value={tab.name}
                onChange={e => dispatch({ type: 'UPDATE_CANVAS_TAB', payload: { ...tab, name: e.target.value } })}
                onBlur={() => setEditingTabId(null)}
                onKeyDown={e => { if (e.nativeEvent.isComposing || e.keyCode === 229) return; if (e.key === 'Enter' || e.key === 'Escape') { e.stopPropagation(); setEditingTabId(null) } }}
                className="text-sm font-semibold bg-transparent border-b border-indigo-300 outline-none text-slate-800 min-w-0"
              />
            ) : (
              <span
                className="text-sm font-semibold text-slate-800 truncate cursor-text select-none"
                onDoubleClick={() => { setEditingTabId(tab.id); setEditingTabInTitle(true) }}
                title="ダブルクリックで名前を編集"
              >{tab.name}</span>
            )}
            {jumpBackTab && (
              <button
                onClick={jumpBack}
                className="ml-2 flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200 hover:bg-indigo-100 hover:text-indigo-700 hover:border-indigo-200 transition-colors shrink-0 max-w-[220px]"
                title={`「${jumpBackTab.name}」に戻る`}
              >
                <CornerDownLeft size={11} className="shrink-0" />
                <span className="truncate">{jumpBackTab.name}に戻る</span>
              </button>
            )}
          </div>
        )
      })()}
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
                <div className="absolute left-0 top-10 z-20 bg-slate-100 border border-slate-300 rounded-lg shadow-xl py-1 min-w-[200px]">
                  {(Object.keys(cardTypes) as CanvasCard['type'][]).filter(k => k !== 'shape').map(key => {
                    const c = cardTypes[key]
                    const Icon = c.icon
                    return (
                      <button key={key} onClick={() => addCard(key)} className="w-full text-left px-3 py-2 text-sm text-slate-700 hover:bg-slate-200 flex items-center gap-2">
                        <Icon size={14} className={c.text} /> {c.label}
                      </button>
                    )
                  })}
                  <div className="h-px bg-slate-300/60 my-1" />
                  <div className="px-3 pb-1 pt-0.5 text-[11px] font-medium text-slate-400 flex items-center gap-1.5"><Shapes size={12} /> シェイプ（構成図）</div>
                  <div className="grid grid-cols-3 gap-0.5 px-1.5 pb-1">
                    {SHAPE_KINDS.map(s => (
                      <button
                        key={s.key}
                        onClick={() => addShapeCard(s.key)}
                        title={s.label}
                        className="flex flex-col items-center gap-1 px-1 py-1.5 rounded hover:bg-slate-200 text-slate-600"
                      >
                        <ShapeGlyph kind={s.key} />
                        <span className="text-[9px] leading-none whitespace-nowrap">{s.label}</span>
                      </button>
                    ))}
                  </div>
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
                title="タスク下書きをばらまく（クリックで連続配置 / Escで終了）— Tab=子・Enter=兄弟・下端子ドラッグで親子付け、「タスク化」で一括登録"
                className={`p-1.5 rounded transition-colors ${tool === 'taskdraft' ? 'bg-yellow-500/20 text-yellow-700' : 'text-slate-500 hover:text-slate-800 hover:bg-slate-100'}`}
              >
                <ListTodo size={16} />
              </button>
              <button
                onClick={() => { if (tool === 'rail') setTool('select'); else enterRailTool() }}
                title="線路（路線図を描く）— クリックで駅を連続配置 / 既存の駅クリックで延伸・乗換 / Escで終了"
                className={`p-1.5 rounded transition-colors ${tool === 'rail' ? 'bg-rose-500/15 text-rose-600' : 'text-slate-500 hover:text-slate-800 hover:bg-slate-100'}`}
              >
                <TrainFront size={16} />
              </button>
            </div>
          )}
          {/* 路線の切替・色・駅リストなどの操作は右のプロパティパネルに集約
              （railツール中はパネルが路線エディタを表示する）。 */}
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
              <ZoomSpeedControl zoom={viewport.zoom} />
              <button onClick={() => setViewport(v => ({ ...v, zoom: Math.min(v.zoom * 1.25, 5) }))} className="p-1.5 rounded hover:bg-slate-100 text-slate-600"><ZoomIn size={16} /></button>
              <button onClick={fitToScreen} className="p-1.5 rounded hover:bg-slate-100 text-slate-600 ml-1" title="全体表示"><Maximize size={16} /></button>
              <button onClick={exportImage} className="p-1.5 rounded hover:bg-slate-100 text-slate-600" title="表示中のキャンバスをPNG書き出し"><ImageDown size={16} /></button>
              <div className="relative" ref={shareMenuRef}>
                <button
                  onClick={() => setShareMenuOpen(v => !v)}
                  disabled={exportingShare}
                  className={`p-1.5 rounded transition-colors ${exportingShare ? 'text-indigo-400 animate-pulse' : shareMenuOpen ? 'bg-indigo-500/15 text-indigo-600' : 'hover:bg-slate-100 text-slate-600'}`}
                  title="共有用HTMLを書き出し（Constellaがない人もブラウザでそのまま閲覧・動画再生できます）"
                >
                  <Share2 size={16} />
                </button>
                {shareMenuOpen && (
                  <div className="absolute right-0 top-full mt-1 z-40 w-64 p-3 rounded-lg border border-slate-200 bg-white shadow-lg">
                    <div className="text-[11px] font-medium text-slate-500 mb-1.5">動画・音声の埋め込み上限</div>
                    <div className="flex flex-wrap gap-1 mb-2">
                      {[
                        { v: 50, label: '50MB' },
                        { v: 150, label: '150MB' },
                        { v: 300, label: '300MB' },
                        { v: 500, label: '500MB' },
                        { v: -1, label: '無制限' },
                        { v: 0, label: '埋め込まない' },
                      ].map(o => (
                        <button
                          key={o.v}
                          onClick={() => setShareLimit(o.v)}
                          className={`px-2 py-1 rounded text-[11px] border transition-colors ${
                            shareEmbedLimitMB === o.v
                              ? 'border-indigo-400 bg-indigo-500/10 text-indigo-600'
                              : 'border-slate-200 text-slate-500 hover:border-slate-300 hover:text-slate-700'
                          }`}
                        >
                          {o.label}
                        </button>
                      ))}
                    </div>
                    {/* 容量シミュレーション */}
                    {(() => {
                      const fmtMB = (n: number) => n >= 1024 * 1024 * 1024 ? `${(n / (1024 * 1024 * 1024)).toFixed(2)}GB` : `${(n / (1024 * 1024)).toFixed(1)}MB`
                      if (shareSizes === null) return <p className="text-[10px] text-slate-400 mb-2">容量を計算中…</p>
                      const limit = shareEmbedLimitMB * 1024 * 1024
                      const over = shareEmbedLimitMB > 0 ? shareSizes.filter(s => s.size > limit) : []
                      const embedded = shareEmbedLimitMB === 0 ? [] : shareSizes.filter(s => shareEmbedLimitMB === -1 || s.size <= limit)
                      const total = embedded.reduce((a, s) => a + s.size, 0)
                      // base64 で約 1.33 倍 + スナップショット分
                      const est = Math.round(total * 1.34)
                      return (
                        <div className="text-[10px] text-slate-500 leading-relaxed mb-2 space-y-0.5">
                          <div>
                            メディア {shareSizes.length}件 / 埋め込み {embedded.length}件（{fmtMB(total)}）
                            → 書き出し後 約<span className="font-semibold text-slate-700">{fmtMB(est)}</span>+α
                          </div>
                          {over.length > 0 && (
                            <div className="text-amber-600">
                              上限超 {over.length}件: {over.map(o => `${o.title}（${fmtMB(o.size)}）`).join('、')}
                              {!shareTranscode && ' → 静止画になります'}
                            </div>
                          )}
                        </div>
                      )
                    })()}
                    <label className={`flex items-start gap-1.5 mb-2 cursor-pointer ${shareEmbedLimitMB === 0 || shareEmbedLimitMB === -1 ? 'opacity-40 pointer-events-none' : ''}`}>
                      <input type="checkbox" checked={shareTranscode} onChange={toggleShareTranscode} className="mt-0.5 accent-indigo-500" />
                      <span className="text-[10px] text-slate-500 leading-relaxed">
                        上限を超えた動画を縮小して埋め込む（720p/WebM再エンコード。動画の長さぶん時間がかかります）
                      </span>
                    </label>
                    <p className="text-[10px] text-slate-400 leading-relaxed mb-2">
                      YouTube/Webカードはサムネイル付きリンクになります。
                    </p>
                    <button
                      onClick={() => { setShareMenuOpen(false); exportShareHtml() }}
                      className="w-full px-3 py-1.5 rounded bg-indigo-500 text-white text-xs hover:bg-indigo-600 transition-colors"
                    >
                      共有用HTMLを書き出し
                    </button>
                  </div>
                )}
              </div>
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
                  rails: tabRails,
                  stations: tabStations,
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
                          const stationHits = tabStations.filter(s => s.name.toLowerCase().includes(q)).slice(0, 10)
                          if (cardHits.length + labelHits.length + stationHits.length === 0) return <p className="text-[10px] text-slate-400 px-1 py-1">一致なし</p>
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
                              {stationHits.map(s => (
                                <button
                                  key={'s:' + s.id}
                                  onClick={() => {
                                    navigateTo(s.x, s.y)
                                    setSelectedIds([]); setSelectedLabelIds([])
                                    setSelectedStationIds([s.id])
                                    setCanvasSearchOpen(false)
                                  }}
                                  className="w-full text-left px-2 py-1 rounded hover:bg-slate-50 text-[11px] text-slate-700 flex items-center gap-1.5 truncate"
                                >
                                  <TrainFront size={11} className="text-rose-500 shrink-0" />
                                  <span className="truncate">{s.name || '(無名の駅)'}</span>
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
          <button onClick={() => addTab()} className="px-4 py-2 rounded-lg bg-indigo-500/10 text-indigo-600 text-sm hover:bg-indigo-500/20">カテゴリーを作成</button>
        </div>
      ) : viewMode === 'canvas' ? (
        /* Canvas view */
        <div
          ref={canvasRef}
          data-canvas-bg="1"
          className="flex-1 overflow-hidden relative"
          style={{
            cursor: spacePan ? (isDragging ? 'grabbing' : 'grab') : tool === 'label' ? 'text' : (tool === 'arrow' || tool === 'group' || tool === 'pen' || tool === 'eraser' || tool === 'rail') ? 'crosshair' : 'default',
            // Dot grid aligned to the 20px snap grid; dots sit exactly on snap intersections.
            // Hidden when zoomed out enough that cells get too dense to read.
            ...(20 * viewport.zoom >= 8 ? {
              backgroundImage: 'radial-gradient(circle, rgba(100,116,139,0.35) 1px, transparent 1.6px)',
              backgroundSize: `${20 * viewport.zoom}px ${20 * viewport.zoom}px`,
              backgroundPosition: `${viewport.x - 10 * viewport.zoom}px ${viewport.y - 10 * viewport.zoom}px`,
            } : {}),
          }}
          // Native drag of a text selection / image / link hijacks the mouse
          // (no more mousemove events) and leaves pan/drag "dead". Kill those,
          // but let explicit draggable elements (the sequence card's frame
          // reorder rows) keep their native DnD.
          onDragStartCapture={e => {
            const t = e.target as HTMLElement
            if (t.closest?.('[draggable="true"]')) return
            e.preventDefault()
          }}
          // A stray cross-card text selection (started inside some card body)
          // also blocks gestures; clear it on the next press anywhere outside
          // an editable field so one click always restores a workable canvas.
          onMouseDownCapture={e => {
            const t = e.target as HTMLElement
            if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return
            const sel = window.getSelection()
            if (sel && !sel.isCollapsed) sel.removeAllRanges()
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
            ref={layerRef}
            data-canvas-bg="1"
            // While the pen/eraser/arrow tool is active, mark the whole card layer
            // click-through (see index.css .canvas-drawing) so the gesture — not a
            // card or its <webview> — receives the mouse. For 'arrow' this is what
            // lets the user drag card→card directly: the mousedown lands on the
            // canvas bg INSIDE the card's bbox, so cardAtPoint attaches both ends.
            className={`canvas-ink${!canvasLocked && (tool === 'pen' || tool === 'eraser' || tool === 'arrow' || tool === 'rail') ? ' canvas-drawing' : ''}`}
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
                selected={selectedGroupIds.includes(group.id)}
                viewLocked={canvasLocked}
                onHeaderDown={handleGroupHeaderDown}
                onResizeDown={handleGroupResizeDown}
                onUpdate={updates => dispatch({ type: 'UPDATE_CANVAS_GROUP', payload: { ...group, ...updates } })}
                onDelete={() => { dispatch({ type: 'DELETE_CANVAS_GROUP', payload: group.id }); setSelectedGroupIds(prev => prev.filter(x => x !== group.id)) }}
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

            {/* 線路レイヤー — canvas-native route map (behind cards, like arrows).
                Lines thread through stations via the same metro elbow path as the
                路線図 page; stations are draggable nodes (select tool). */}
            {(tabRails.length > 0 || tabStations.length > 0) && (
              <svg className="absolute top-0 left-0 overflow-visible" style={{ width: 1, height: 1, pointerEvents: 'none' }}>
                {railGeometry.map(({ rail, pathD }) => {
                  if (!pathD) return null
                  // While drawing, the non-active rails dim so the target line reads.
                  const dim = tool === 'rail' && rail.id !== activeRailId
                  return <path key={rail.id} d={pathD} fill="none" stroke={rail.color} strokeWidth={9} strokeLinecap="round" strokeLinejoin="round" opacity={dim ? 0.3 : 1} />
                })}
                {tabStations.map(st => {
                  const rails = railsByStation.get(st.id) ?? []
                  const isTransfer = rails.length >= 2
                  const strokeColor = isTransfer ? '#1a1d22' : rails[0]?.color ?? '#94a3b8'
                  const size = isTransfer ? 20 : 16
                  const planned = st.status === 'todo'
                  const selected = selectedStationIds.includes(st.id)
                  return (
                    <g
                      key={st.id}
                      // railツール中はカード層が canvas-drawing でクリックスルーになるが、
                      // 駅だけは .rail-interactive の CSS 例外で掴める（選択/ドラッグ/接続）。
                      className={tool === 'rail' ? 'rail-interactive' : undefined}
                      // ロック中も選択（＝読み取り専用パネルでの閲覧）はできる。
                      // 移動やリネームは handleStationDown / dblclick 側でガード。
                      style={{ pointerEvents: tool === 'select' ? 'auto' : 'none', cursor: canvasLocked ? 'default' : 'grab' }}
                      onMouseDown={e => handleStationDown(e, st)}
                      onDoubleClick={e => { e.stopPropagation(); if (!canvasLockedRef.current) setEditingStationId(st.id) }}
                      onContextMenu={e => handleStationContextMenu(e, st)}
                    >
                      {/* generous invisible hit area so small nodes are easy to grab */}
                      <rect x={st.x - 16} y={st.y - 16} width={32} height={32} fill="transparent" />
                      {selected && (
                        <g strokeDasharray="3 3" opacity={0.85}>
                          {renderStationShape({ shape: 'rounded-square', cx: st.x, cy: st.y, size: size + 12, fill: 'none', stroke: '#6366f1', strokeWidth: 1.5 })}
                        </g>
                      )}
                      <g opacity={planned ? 0.55 : 1} strokeDasharray={planned ? '4 3' : undefined}>
                        {renderStationShape({ shape: 'rounded-square', cx: st.x, cy: st.y, size, fill: 'var(--shape-fill)', stroke: strokeColor, strokeWidth: 4 })}
                      </g>
                      <text
                        x={st.x} y={st.y - size / 2 - 8}
                        textAnchor="middle"
                        fontSize={12.5} fontWeight={planned ? 500 : 700} fill="#1e293b"
                        opacity={planned ? 0.65 : 1}
                        style={{ paintOrder: 'stroke', stroke: '#ffffff', strokeWidth: 3, strokeLinejoin: 'round', userSelect: 'none' }}
                      >{st.name}</text>
                    </g>
                  )
                })}
                {/* 自動電車 — 路線図ページと同じ: 連続して「開業」している区間に
                    名前なしの電車を走らせる。開業マークを付けるだけで走り出す。
                    run/経路は railGeometry で駅・路線が変わった時だけ再計算。 */}
                {railGeometry.map(({ rail, runs }) => {
                  if (runs.length === 0) return null
                  const dim = tool === 'rail' && rail.id !== activeRailId
                  return (
                    <g key={`trains-${rail.id}`} opacity={dim ? 0.3 : 1} pointerEvents="none">
                      {runs.map(run => (
                        <TrainSprite key={run.key} pathD={run.d} color={rail.color} durationMs={run.duration * 1000} />
                      ))}
                    </g>
                  )
                })}
              </svg>
            )}

            {/* 駅名の編集（ダブルクリック） */}
            {editingStationId && (() => {
              const st = tabStations.find(s => s.id === editingStationId)
              if (!st) return null
              return (
                <input
                  autoFocus
                  value={st.name}
                  onChange={e => dispatch({ type: 'UPDATE_CANVAS_STATION', payload: { ...st, name: e.target.value } })}
                  onBlur={() => setEditingStationId(null)}
                  onKeyDown={e => { if ((e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) || e.key === 'Escape') { e.stopPropagation(); e.currentTarget.blur() } }}
                  onMouseDown={e => e.stopPropagation()}
                  // rail-interactive: railツール中の canvas-drawing クリックスルーから
                  // この入力欄を除外（外すとクリックが背景へ抜けて新駅が湧く）。
                  className="rail-interactive absolute text-[12px] font-bold text-center bg-white border border-indigo-400 rounded px-1 outline-none shadow-sm"
                  style={{ left: st.x, top: st.y - 36, transform: 'translateX(-50%)', width: `${Math.max(4, st.name.length + 2)}ch` }}
                />
              )
            })()}

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
                    d={arrowGeometry(ends, a.curved, a.points).d}
                    selected={selectedArrowIds.includes(a.id)}
                    solo={arrowSolo && selectedArrowId === a.id}
                    interactive={tool === 'select'}
                    onSelect={additive => {
                      if (additive) { setSelectedArrowIds(prev => prev.includes(a.id) ? prev.filter(x => x !== a.id) : [...prev, a.id]); return }
                      setSelectedArrowId(a.id); setSelectedIds([]); setSelectedLabelIds([]); setSelectedGroupIds([]); setSelectedStationIds([])
                    }}
                    onEndDown={handleArrowEndDown}
                    onWayDown={handleWayDown}
                    onWayInsert={handleWayInsert}
                    onWayRemove={handleWayRemove}
                    onEditLabel={() => { if (canvasLocked) return; setSelectedArrowId(a.id); setEditingArrowId(a.id) }}
                    onContextMenu={e => handleArrowContextMenu(e, a)}
                  />
                )
              })}
              {drawArrow && (
                <line
                  x1={drawArrow.x1} y1={drawArrow.y1} x2={drawArrow.x2} y2={drawArrow.y2}
                  stroke={taskLinkDrag ? TASK_LINK_COLOR : '#6366f1'}
                  strokeWidth={taskLinkDrag ? TASK_LINK_WIDTH : 2}
                  strokeDasharray="5 4" markerEnd="url(#arrowhead)"
                />
              )}
            </svg>

            {/* Arrow labels (at midpoints) */}
            {tabArrows.map(a => {
              const editing = editingArrowId === a.id
              if (!editing && !a.label) return null
              const g = arrowGeometry(resolveArrowEnds(a, cardsById), a.curved, a.points)
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
                onPortHover={card.type === 'shape' ? (h: boolean) => setPortHover(h ? card.id : null) : undefined}
                pickerOpen={pickerOpenCardId === card.id}
                detachOpen={detachOpenCardId === card.id}
                pickerTab={pickerTab}
                pickerSearch={pickerSearch}
                onOpenPicker={() => { setPickerOpenCardId(card.id); setDetachOpenCardId(null); setPickerTab('existing'); setPickerSearch(''); setPickerChecked([]) }}
                onClosePicker={() => { setPickerOpenCardId(null); setPickerChecked([]) }}
                onOpenDetach={() => { setDetachOpenCardId(card.id); setPickerOpenCardId(null) }}
                onCloseDetach={() => setDetachOpenCardId(null)}
                onPickerTab={setPickerTab}
                onPickerSearch={setPickerSearch}
                pickerChecked={pickerOpenCardId === card.id ? pickerChecked : EMPTY_IDS}
                onPickerCheck={handlePickerCheck}
                onBulkLink={taskIds => bulkPlaceTaskCards(card, taskIds)}
                onJumpTab={jumpToTab}
              />
            ))}

            {/* Connection ports — hidden normally. Shown on EVERY card while an
                arrow is being drawn / an endpoint re-attached (snap targets), or
                on the HOVERED shape card (select tool) as draggable sources.
                Sizes are divided by zoom for a constant screen size. */}
            {!canvasLocked && (() => {
              const endpointDrag = isDragging && (dragRef.current?.kind === 'arrow-p1' || dragRef.current?.kind === 'arrow-p2')
              const showAll = tool === 'arrow' || !!drawArrow || endpointDrag
              const hoverCard = !showAll && tool === 'select' && hoverPortCardId ? cardsById.get(hoverPortCardId) : undefined
              if (!showAll && !hoverCard) return null
              const portCards = showAll ? tabCards : [hoverCard!]
              const interactive = !showAll
              return (
                <svg className="absolute top-0 left-0 overflow-visible" style={{ width: 1, height: 1, pointerEvents: 'none' }}>
                  {portCards.map(c => PORT_DIRS.map(dir => {
                    const p = portPoint(c, dir)
                    const hot = snapPort?.cardId === c.id && snapPort.dir === dir
                    return (
                      <circle
                        key={`${c.id}-${dir}`}
                        cx={p.x} cy={p.y}
                        r={(hot ? 6 : interactive ? 4.4 : 3.2) / viewport.zoom}
                        stroke="#6366f1"
                        strokeWidth={(hot ? 2 : 1.4) / viewport.zoom}
                        opacity={hot ? 1 : 0.8}
                        style={{
                          fill: hot ? '#6366f1' : 'var(--handle-fill)',
                          ...(interactive ? { pointerEvents: 'auto' as const, cursor: 'crosshair' } : {}),
                        }}
                        onMouseDown={interactive ? e => handlePortDown(e, c, dir) : undefined}
                        onMouseEnter={interactive ? () => setPortHover(c.id) : undefined}
                      />
                    )
                  }))}
                </svg>
              )
            })()}

            {/* タスク親子付け端子 — live task-ref cards AND 下書き (taskDraft)
                cards carry a persistent bottom-center terminal. Dragging it
                starts a normal arrow whose drop target becomes このタスクの子
                (live: parentLinkByArrow now / draft: realized at タスク化).
                Hidden mid-drag: the generic snap-port layer takes over then. */}
            {!canvasLocked && tool === 'select' && !isDragging && (
              <svg className="absolute top-0 left-0 overflow-visible" style={{ width: 1, height: 1, pointerEvents: 'none' }}>
                {tabCards.filter(c => c.type === 'taskDraft' || (c.refTaskId && liveTaskIds.has(c.refTaskId))).map(c => {
                  const p = portPoint(c, 's')
                  return (
                    <g
                      key={`task-port-${c.id}`}
                      style={{ pointerEvents: 'auto', cursor: 'crosshair' }}
                      onMouseDown={e => handlePortDown(e, c, 's', true)}
                    >
                      <title>ドラッグして別のタスクカードへ — このタスクの子として親子付け</title>
                      {/* generous invisible hit area so the small dot is easy to grab */}
                      <circle cx={p.x} cy={p.y} r={11 / viewport.zoom} fill="transparent" />
                      <circle
                        cx={p.x} cy={p.y} r={5 / viewport.zoom}
                        fill="#10b981" stroke="var(--handle-fill)" strokeWidth={1.6 / viewport.zoom}
                      />
                      <line
                        x1={p.x} y1={p.y - 2.1 / viewport.zoom} x2={p.x} y2={p.y + 2.1 / viewport.zoom}
                        stroke="var(--handle-fill)" strokeWidth={1.2 / viewport.zoom} strokeLinecap="round"
                      />
                      <line
                        x1={p.x - 2.1 / viewport.zoom} y1={p.y} x2={p.x + 2.1 / viewport.zoom} y2={p.y}
                        stroke="var(--handle-fill)" strokeWidth={1.2 / viewport.zoom} strokeLinecap="round"
                      />
                    </g>
                  )
                })}
              </svg>
            )}

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

          {shareProgress && (
            <div data-export-ignore="1" className="absolute bottom-4 left-1/2 -translate-x-1/2 z-40 px-3.5 py-1.5 rounded-full bg-slate-800/90 text-white text-xs shadow-lg pointer-events-none whitespace-nowrap">
              {shareProgress}
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
                onJumpTab={jumpToTab}
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
                  <button onClick={() => { pasteCards(contextMenu.canvasX, contextMenu.canvasY); setContextMenu(null) }} disabled={!clipboardHasContent()} className="w-full text-left px-3 py-1.5 hover:bg-slate-100 text-slate-700 disabled:text-slate-300 disabled:hover:bg-transparent flex items-center justify-between">
                    <span className="flex items-center gap-2"><ClipboardPaste size={14} /> ここに貼り付け</span><kbd className="text-[10px] text-slate-400">Ctrl+V</kbd>
                  </button>
                  <div className="h-px bg-slate-200 my-1" />
                  <div className="px-3 pb-1 pt-0.5 text-[11px] font-medium text-slate-400 flex items-center gap-1.5"><Plus size={12} /> カードを追加</div>
                  <div className="grid grid-cols-2 gap-0.5 px-1 pb-1">
                    {Object.entries(cardTypes).filter(([key]) => key !== 'shape').map(([key, cfg]) => {
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
                  <div className="h-px bg-slate-200 my-1" />
                  <div className="px-3 pb-1 pt-0.5 text-[11px] font-medium text-slate-400 flex items-center gap-1.5"><Shapes size={12} /> シェイプを追加</div>
                  <div className="grid grid-cols-3 gap-0.5 px-1.5 pb-1">
                    {SHAPE_KINDS.map(s => (
                      <button
                        key={s.key}
                        onClick={() => { addShapeCard(s.key, { x: contextMenu.canvasX, y: contextMenu.canvasY }); setContextMenu(null) }}
                        title={s.label}
                        className="flex flex-col items-center gap-1 px-1 py-1.5 rounded hover:bg-slate-100 text-slate-600"
                      >
                        <ShapeGlyph kind={s.key} />
                        <span className="text-[9px] leading-none whitespace-nowrap">{s.label}</span>
                      </button>
                    ))}
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
                  {selectedArrowId && (
                    <button onClick={() => { setEditingArrowId(selectedArrowId); setContextMenu(null) }} className="w-full text-left px-3 py-1.5 hover:bg-slate-100 text-slate-700 flex items-center gap-2"><Type size={14} /> ラベルを編集</button>
                  )}
                  {!selectedArrowId && selectedArrowIds.length > 1 && (
                    <div className="px-3 py-1 text-[11px] text-slate-400">矢印{selectedArrowIds.length}本を選択中</div>
                  )}
                  {selArrow && (
                    <button onClick={() => { dispatch({ type: 'UPDATE_CANVAS_ARROW', payload: { ...selArrow, curved: !selArrow.curved } }); setContextMenu(null) }} className="w-full text-left px-3 py-1.5 hover:bg-slate-100 text-slate-700 flex items-center gap-2"><Spline size={14} /> {selArrow.curved ? '直線にする' : '曲線にする'}</button>
                  )}
                  {selArrow && (selArrow.points?.length ?? 0) > 0 && (
                    <button onClick={() => { dispatch({ type: 'UPDATE_CANVAS_ARROW', payload: { ...selArrow, points: undefined } }); setContextMenu(null) }} className="w-full text-left px-3 py-1.5 hover:bg-slate-100 text-slate-700 flex items-center gap-2"><Spline size={14} /> 折れ点をすべて削除</button>
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
              ) : contextMenu.kind === 'station' ? (() => {
                const st = tabStations.find(s => s.id === selectedStationIds[0])
                if (!st) return null
                return (
                  <>
                    <div className="px-3 pt-1 pb-0.5 text-[10px] text-slate-400 truncate">{st.name}</div>
                    <div className="px-3 py-1">
                      <StationStatusPills status={st.status} onChange={s => { dispatch({ type: 'UPDATE_CANVAS_STATION', payload: { ...st, status: s } }); setContextMenu(null) }} />
                    </div>
                    <button onClick={() => { setEditingStationId(st.id); setContextMenu(null) }} className="w-full text-left px-3 py-1.5 hover:bg-slate-100 text-slate-700 flex items-center gap-2"><Type size={14} /> 名前を変更</button>
                    <div className="h-px bg-slate-200 my-1" />
                    <button onClick={() => { setContextMenu(null); requestDeleteSelection() }} className="w-full text-left px-3 py-1.5 hover:bg-red-50 text-red-600 flex items-center justify-between">
                      <span className="flex items-center gap-2"><Trash2 size={14} /> 駅を削除</span><kbd className="text-[10px] text-red-300">Del</kbd>
                    </button>
                  </>
                )
              })() : (
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
                  {selCards.length === 1 && selCards[0].refFileId && state.files.some(f => f.id === selCards[0].refFileId) && (
                    <div>
                      <button onClick={() => { navigate('/files', { state: { focusFileId: selCards[0].refFileId } }); setContextMenu(null) }} className="w-full text-left px-3 py-1.5 hover:bg-slate-100 text-orange-600 flex items-center gap-2"><FilesGlyph size={14} /> ライブラリで開く</button>
                    </div>
                  )}
                  {selCards.length === 1 && selCards[0].refSketchId && state.sketches.some(s => s.id === selCards[0].refSketchId) && (
                    <>
                      <button onClick={() => { navigate('/sketch', { state: { focusSketchId: selCards[0].refSketchId } }); setContextMenu(null) }} className="w-full text-left px-3 py-1.5 hover:bg-slate-100 text-fuchsia-600 flex items-center gap-2"><Brush size={14} /> スケッチで開く</button>
                      <div className="h-px bg-slate-200 my-1" />
                    </>
                  )}
                  {/* 複製/貼り付けで別プロジェクトのプランを指すことがあるので所属一致も確認 */}
                  {selCards.length === 1 && selCards[0].refPlanId && mtWorkspaceMeta[selCards[0].refPlanId]?.projectId === activeProjectId && (
                    <>
                      <button onClick={() => { navigate('/mindtrain', { state: { focusPlanId: selCards[0].refPlanId } }); setContextMenu(null) }} className="w-full text-left px-3 py-1.5 hover:bg-slate-100 text-rose-600 flex items-center gap-2"><TrainFront size={14} /> 路線図で開く</button>
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

      {notice && (
        <div className="absolute bottom-14 left-1/2 -translate-x-1/2 z-[55] bg-slate-800 text-white text-xs rounded-full px-4 py-2 shadow-lg pointer-events-none max-w-[80%] truncate">
          {notice}
        </div>
      )}

      {confirmDelete && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/40"
          onMouseDown={() => setConfirmDelete(null)}
        >
          <div
            data-canvas-confirm
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

      {/* プロパティパネル（右）— 選択中の要素の詳細編集。選択なしのときはキャンバス概要。
          編集系UIは今後ここへ集約していく。 */}
      {viewMode === 'canvas' && (
        <div className={`${propsCollapsed ? 'w-10' : 'w-64'} shrink-0 border-l border-slate-200 bg-slate-50 flex flex-col transition-[width] duration-150`}>
          {propsCollapsed ? (
            <button
              onClick={() => setPropsCollapsed(false)}
              className="p-2.5 text-slate-400 hover:text-slate-700 transition-colors"
              title="プロパティパネルを開く"
            ><PanelRightOpen size={16} /></button>
          ) : (
            <>
              <div className="flex items-center gap-1 px-2 py-2 border-b border-slate-200 shrink-0">
                <SlidersHorizontal size={13} className="text-slate-400 shrink-0" />
                <span className="text-xs font-semibold text-slate-600 flex-1 select-none">プロパティ</span>
                <button onClick={() => setPropsCollapsed(true)} className="p-1 rounded text-slate-400 hover:text-slate-700 hover:bg-slate-100" title="パネルを畳む"><PanelRightClose size={14} /></button>
              </div>
              <div className="flex-1 overflow-y-auto p-3 text-xs">
                {(() => {
                  const ro = canvasLocked
                  const secTitle = 'text-[10px] font-semibold text-slate-400 mb-1 select-none'
                  const inputCls = 'w-full text-xs bg-white border border-slate-200 rounded px-2 py-1 outline-none focus:border-indigo-400 disabled:bg-slate-100 disabled:text-slate-400'
                  const selStation = selectedStationIds.length === 1 ? tabStations.find(s => s.id === selectedStationIds[0]) : undefined
                  // railツール中は路線セクションを常時表示し、駅を選択していれば駅セクションも
                  // 下に並べる — 路線図ページの「路線パネル + 駅の詳細」と同じ構成。
                  const activeRail = tool === 'rail' ? tabRails.find(r => r.id === activeRailId) : undefined
                  const propCard = !selStation && !activeRail && selectedIds.length === 1 ? tabCards.find(c => c.id === selectedIds[0]) : undefined

                  /* ── 駅セクション ── */
                  const stationSection = (st: CanvasStation) => {
                    const stRails = railsByStation.get(st.id) ?? []
                    return (
                      <div className="space-y-4">
                        <div className="flex items-center gap-1.5 text-slate-700 font-semibold"><TrainFront size={13} className="text-rose-500" /> 駅{stRails.length >= 2 ? '（乗換駅）' : ''}</div>
                        <div>
                          <div className={secTitle}>駅名</div>
                          <input value={st.name} disabled={ro} onChange={e => dispatch({ type: 'UPDATE_CANVAS_STATION', payload: { ...st, name: e.target.value } })} className={inputCls} />
                        </div>
                        <div>
                          <div className={secTitle}>状態</div>
                          <StationStatusPills status={st.status} disabled={ro} hoverCls="hover:bg-white" onChange={s => dispatch({ type: 'UPDATE_CANVAS_STATION', payload: { ...st, status: s } })} />
                        </div>
                        <div>
                          <div className={secTitle}>所属路線</div>
                          {stRails.length === 0 && <div className="text-[10px] text-slate-400">（どの路線も通っていません）</div>}
                          <div className="flex flex-wrap gap-1">
                            {stRails.map(r => (
                              <span key={r.id} className="flex items-center gap-1 pl-1.5 pr-1 py-0.5 rounded-full border border-slate-200 bg-white text-[10px] text-slate-600">
                                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: r.color }} />
                                {r.name}
                                {!ro && (
                                  <button onClick={() => dispatch({ type: 'DETACH_STATION_FROM_RAIL', payload: { railId: r.id, stationId: st.id } })} title="この路線から外す" className="p-0.5 rounded hover:bg-slate-100 text-slate-300 hover:text-rose-500"><X size={9} /></button>
                                )}
                              </span>
                            ))}
                          </div>
                        </div>
                        {!ro && (
                          <button onClick={requestDeleteSelection} className="w-full text-left px-2 py-1.5 rounded border border-red-200 text-red-600 hover:bg-red-50 flex items-center gap-1.5"><Trash2 size={12} /> 駅を削除</button>
                        )}
                      </div>
                    )
                  }
                  if (selStation && !activeRail) return stationSection(selStation)

                  /* ── 駅の複数選択（矩形選択など） ── */
                  if (!activeRail && selectedStationIds.length > 1) {
                    return (
                      <div className="space-y-4">
                        <div className="flex items-center gap-1.5 text-slate-700 font-semibold"><TrainFront size={13} className="text-rose-500" /> 駅 {selectedStationIds.length}個を選択中</div>
                        <div className="text-[10px] text-slate-400 leading-relaxed">ドラッグでまとめて移動、矢印キーで微調整、Del で削除できます。</div>
                        {!ro && (
                          <button onClick={requestDeleteSelection} className="w-full text-left px-2 py-1.5 rounded border border-red-200 text-red-600 hover:bg-red-50 flex items-center gap-1.5"><Trash2 size={12} /> 選択した駅を削除</button>
                        )}
                      </div>
                    )
                  }

                  /* ── カード ── */
                  if (propCard) {
                    const cfg = cardTypes[propCard.type]
                    const CIcon = cfg.icon
                    return (
                      <div className="space-y-4">
                        <div className="flex items-center gap-1.5 text-slate-700 font-semibold"><CIcon size={13} className={cfg.text} /> {cfg.label}カード</div>
                        <div>
                          <div className={secTitle}>タイトル</div>
                          <input value={propCard.title} disabled={ro || !!propCard.locked} onChange={e => dispatch({ type: 'UPDATE_CANVAS_CARD', payload: { ...propCard, title: e.target.value } })} className={inputCls} />
                        </div>
                        <div>
                          <div className={secTitle}>色</div>
                          <div className="flex items-start gap-1.5">
                            <button disabled={ro} onClick={() => setCardColor(undefined)} title="デフォルト" className="w-4 h-4 rounded-full border border-slate-300 flex items-center justify-center text-slate-400 shrink-0 mt-0.5"><Ban size={11} /></button>
                            <div className="grid grid-cols-8 gap-1">
                              {HUE_KEYS.map(h => (
                                <button key={h} disabled={ro} onClick={() => setCardColor(h)} className={`w-4 h-4 rounded-full hover:scale-110 transition-transform ${propCard.color === h ? 'ring-2 ring-offset-1 ring-slate-400' : ''}`} style={{ backgroundColor: COLOR_THEMES[h].dot }} />
                              ))}
                              {HUE_KEYS.map(h => (
                                <button key={h + '2'} disabled={ro} onClick={() => setCardColor(h + '2')} className={`w-4 h-4 rounded-full hover:scale-110 transition-transform ${propCard.color === h + '2' ? 'ring-2 ring-offset-1 ring-slate-400' : ''}`} style={{ backgroundColor: COLOR_THEMES[h + '2'].dot }} />
                              ))}
                            </div>
                          </div>
                        </div>
                        <div className="text-[10px] text-slate-400 font-mono">x{Math.round(propCard.x)} y{Math.round(propCard.y)} ・ {Math.round(propCard.width)}×{Math.round(propCard.height)}</div>
                        {!ro && (
                          <div className="space-y-1.5">
                            <button onClick={() => dispatch({ type: 'UPDATE_CANVAS_CARD', payload: { ...propCard, locked: !propCard.locked } })} className="w-full text-left px-2 py-1.5 rounded border border-slate-200 text-slate-600 hover:bg-white flex items-center gap-1.5">
                              {propCard.locked ? <><Unlock size={12} /> ロック解除</> : <><Lock size={12} /> ロック</>}
                            </button>
                            <button onClick={requestDeleteSelection} className="w-full text-left px-2 py-1.5 rounded border border-red-200 text-red-600 hover:bg-red-50 flex items-center gap-1.5"><Trash2 size={12} /> カードを削除</button>
                          </div>
                        )}
                      </div>
                    )
                  }

                  /* ── ラベル ── */
                  if (selectedLabel) {
                    return (
                      <div className="space-y-4">
                        <div className="flex items-center gap-1.5 text-slate-700 font-semibold"><Type size={13} className="text-slate-500" /> ラベル</div>
                        <div>
                          <div className={secTitle}>テキスト</div>
                          <input value={selectedLabel.text} disabled={ro} onChange={e => dispatch({ type: 'UPDATE_CANVAS_LABEL', payload: { ...selectedLabel, text: e.target.value } })} className={inputCls} />
                        </div>
                        <div>
                          <div className={secTitle}>サイズ</div>
                          <div className="flex gap-1">
                            {LABEL_SIZES.map((sz, i) => (
                              <button key={sz} disabled={ro} onClick={() => dispatch({ type: 'UPDATE_CANVAS_LABEL', payload: { ...selectedLabel, fontSize: sz } })}
                                className={`px-2 rounded font-semibold transition-colors ${selectedLabel.fontSize === sz ? 'bg-indigo-500/15 text-indigo-600' : 'text-slate-500 hover:bg-white'}`} style={{ fontSize: 11 + i * 3 }}>A</button>
                            ))}
                          </div>
                        </div>
                        <div>
                          <div className={secTitle}>色</div>
                          <div className="flex gap-1.5">
                            {PEN_COLORS.map(c => (
                              <button key={c} disabled={ro} onClick={() => dispatch({ type: 'UPDATE_CANVAS_LABEL', payload: { ...selectedLabel, color: c } })}
                                className={`w-4 h-4 rounded-full transition-transform ${selectedLabel.color === c ? 'ring-2 ring-offset-1 ring-slate-400 scale-110' : ''}`} style={{ backgroundColor: c }} />
                            ))}
                          </div>
                        </div>
                        {!ro && (
                          <button onClick={requestDeleteSelection} className="w-full text-left px-2 py-1.5 rounded border border-red-200 text-red-600 hover:bg-red-50 flex items-center gap-1.5"><Trash2 size={12} /> ラベルを削除</button>
                        )}
                      </div>
                    )
                  }

                  /* ── 矢印 ── */
                  if (selectedArrow) {
                    return (
                      <div className="space-y-4">
                        <div className="flex items-center gap-1.5 text-slate-700 font-semibold"><ArrowUpRight size={13} className="text-indigo-500" /> 矢印</div>
                        <div>
                          <div className={secTitle}>ラベル</div>
                          <input value={selectedArrow.label ?? ''} disabled={ro} placeholder="（なし）" onChange={e => dispatch({ type: 'UPDATE_CANVAS_ARROW', payload: { ...selectedArrow, label: e.target.value } })} className={inputCls} />
                        </div>
                        <div>
                          <div className={secTitle}>形状</div>
                          <button disabled={ro} onClick={() => dispatch({ type: 'UPDATE_CANVAS_ARROW', payload: { ...selectedArrow, curved: !selectedArrow.curved } })} className="px-2 py-1 rounded border border-slate-200 text-slate-600 hover:bg-white flex items-center gap-1.5">
                            <Spline size={12} /> {selectedArrow.curved ? '直線にする' : '曲線にする'}
                          </button>
                        </div>
                        <div>
                          <div className={secTitle}>色</div>
                          <div className="flex gap-1.5 items-center">
                            <button disabled={ro} onClick={() => dispatch({ type: 'UPDATE_CANVAS_ARROW', payload: { ...selectedArrow, color: undefined } })} title="デフォルト" className={`w-4 h-4 rounded-full border border-slate-300 flex items-center justify-center text-slate-400 ${!selectedArrow.color ? 'ring-2 ring-offset-1 ring-slate-400' : ''}`}><Ban size={11} /></button>
                            {PEN_COLORS.map(c => (
                              <button key={c} disabled={ro} onClick={() => dispatch({ type: 'UPDATE_CANVAS_ARROW', payload: { ...selectedArrow, color: c } })}
                                className={`w-4 h-4 rounded-full transition-transform ${selectedArrow.color === c ? 'ring-2 ring-offset-1 ring-slate-400 scale-110' : ''}`} style={{ backgroundColor: c }} />
                            ))}
                          </div>
                        </div>
                        <div>
                          <div className={secTitle}>太さ</div>
                          <div className="flex gap-1">
                            {[2, 3, 5].map(w => (
                              <button key={w} disabled={ro} onClick={() => dispatch({ type: 'UPDATE_CANVAS_ARROW', payload: { ...selectedArrow, width: w === 2 ? undefined : w } })}
                                className={`w-7 h-6 flex items-center justify-center rounded transition-colors ${(selectedArrow.width ?? 2) === w ? 'bg-indigo-500/15' : 'hover:bg-white'}`}>
                                <span className="rounded-full bg-slate-700" style={{ width: w + 2, height: w + 2 }} />
                              </button>
                            ))}
                          </div>
                        </div>
                        {!ro && (
                          <button onClick={requestDeleteSelection} className="w-full text-left px-2 py-1.5 rounded border border-red-200 text-red-600 hover:bg-red-50 flex items-center gap-1.5"><Trash2 size={12} /> 矢印を削除</button>
                        )}
                      </div>
                    )
                  }

                  /* ── 路線（railツール中）。駅を選択していれば駅セクションも下に並ぶ ── */
                  if (activeRail) {
                    return (
                      <div className="space-y-4">
                        <div className="flex items-center gap-1.5 text-slate-700 font-semibold"><TrainFront size={13} className="text-rose-500" /> 路線</div>
                        <div className="flex flex-wrap gap-1">
                          {tabRails.map(r => (
                            <button key={r.id} onClick={() => setActiveRailId(r.id)}
                              title={`${r.name}（${r.stationIds.length}駅）に駅を追加`}
                              className={`flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] border transition-colors ${r.id === activeRail.id ? 'border-slate-400 bg-white text-slate-800 font-semibold' : 'border-slate-200 text-slate-500 hover:bg-white'}`}>
                              <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: r.color }} />{r.name}
                            </button>
                          ))}
                          {!ro && (
                            <button onClick={addRail} title="新しい路線を追加" className="px-1.5 py-0.5 rounded-full text-[10px] border border-dashed border-slate-300 text-slate-500 hover:bg-white">＋路線</button>
                          )}
                        </div>
                        <div>
                          <div className={secTitle}>路線名</div>
                          <input value={activeRail.name} disabled={ro} onChange={e => dispatch({ type: 'UPDATE_CANVAS_RAIL', payload: { ...activeRail, name: e.target.value } })} className={inputCls} />
                        </div>
                        <div>
                          <div className={secTitle}>色</div>
                          <div className="grid grid-cols-10 gap-1">
                            {RAIL_PALETTE.map(c => (
                              <button key={c} disabled={ro} onClick={() => dispatch({ type: 'UPDATE_CANVAS_RAIL', payload: { ...activeRail, color: c } })}
                                className={`w-4 h-4 rounded-full hover:scale-110 transition-transform ${activeRail.color === c ? 'ring-2 ring-offset-1 ring-slate-400' : ''}`} style={{ backgroundColor: c }} />
                            ))}
                          </div>
                        </div>
                        <div>
                          <div className={secTitle}>駅（{activeRail.stationIds.length}）</div>
                          <div className="space-y-0.5">
                            {activeRail.stationIds.map((sid, i) => {
                              const st = stationById.get(sid)
                              if (!st) return null
                              return (
                                <div key={sid} className="group flex items-center gap-1.5 px-1.5 py-1 rounded hover:bg-white">
                                  <span className="text-[9px] text-slate-400 w-4 text-right shrink-0">{i + 1}</span>
                                  <button onClick={() => setSelectedStationIds([st.id])} className="flex-1 min-w-0 text-left text-slate-700 truncate">{st.name}</button>
                                  {!ro && (
                                    <button onClick={() => dispatch({ type: 'DETACH_STATION_FROM_RAIL', payload: { railId: activeRail.id, stationId: sid } })} title="この路線から外す" className="p-0.5 rounded opacity-0 group-hover:opacity-100 text-slate-300 hover:text-rose-500"><X size={10} /></button>
                                  )}
                                </div>
                              )
                            })}
                            {activeRail.stationIds.length === 0 && <div className="text-[10px] text-slate-400 px-1.5">キャンバスをクリックして駅を配置</div>}
                          </div>
                        </div>
                        {!ro && (
                          <button onClick={() => requestDeleteRail(activeRail)} className="w-full text-left px-2 py-1.5 rounded border border-red-200 text-red-600 hover:bg-red-50 flex items-center gap-1.5"><Trash2 size={12} /> 路線を削除</button>
                        )}
                        {selStation && (
                          <>
                            <div className="h-px bg-slate-200" />
                            {stationSection(selStation)}
                          </>
                        )}
                      </div>
                    )
                  }

                  /* ── 選択なし: キャンバス概要 ── */
                  const tabInfo = state.canvasTabs.find(t => t.id === activeTabId)
                  return (
                    <div className="space-y-4">
                      <div>
                        <div className={secTitle}>このキャンバス</div>
                        <div className="text-slate-700 font-semibold truncate">{tabInfo?.name ?? '—'}</div>
                        <div className="text-[10px] text-slate-400 mt-0.5">カード {tabCards.length} ・ 路線 {tabRails.length} ・ 駅 {tabStations.length}</div>
                      </div>
                      {tabRails.length > 0 && (
                        <div>
                          <div className={secTitle}>路線一覧</div>
                          <div className="space-y-0.5">
                            {tabRails.map(r => (
                              <button key={r.id} onClick={() => { setActiveRailId(r.id); if (!canvasLocked) setTool('rail') }}
                                className="w-full flex items-center gap-1.5 px-1.5 py-1 rounded hover:bg-white text-left">
                                <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: r.color }} />
                                <span className="flex-1 min-w-0 text-slate-700 truncate">{r.name}</span>
                                <span className="text-[9px] text-slate-400 shrink-0">{r.stationIds.length}駅</span>
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                      <div className="text-[10px] text-slate-400 leading-relaxed">カード・駅・ラベル・矢印を選択すると、ここに詳細が表示されます。</div>
                    </div>
                  )
                })()}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/* ── File picking for media cards (PDF / image) ── */

async function applyImageFile(file: File | null | undefined, card: CanvasCard, onUpdate: (u: Partial<CanvasCard>) => void) {
  if (!file || !isImageFile(file)) return
  // ライブラリ参照カード (refFileId) の url はライブラリ実体と共有 — 消すとライブラリ側も壊れる
  if (isMediaRef(card.url) && !card.refFileId) deleteMedia(card.url!).catch(() => {})
  const url = await putMedia(await normalizeImageBlob(file)) // TIFF/TGA → PNG
  onUpdate({ url, title: card.title || file.name, content: file.name, refFileId: undefined })
}

// サーバー(NAS)やローカルディスク上のファイルを「取り込まず」パス参照でカードに
// リンクする（url = local:<絶対パス>）。バイトは表示時に都度読むので、サーバー側で
// 差し替えれば再起動後に反映される。Electron のみ（ブラウザ/リモートは非対応）。
// Media cards render one fixed viewer, so linking (say) an audio file into a PDF
// card leaves a card that can never display anything. The picker is filtered by
// card type and the result re-checked — every OS dialog also offers "all files".
const CARD_LOCAL_KIND: Partial<Record<CanvasCard['type'], LocalKind>> = {
  pdf: 'pdf', image: 'image', video: 'video', audio: 'audio',
}
const LOCAL_KIND_LABEL: Record<LocalKind, string> = {
  pdf: 'PDF', image: '画像', video: '動画', audio: '音声', other: 'ファイル',
}

async function linkLocalFileForCard(card: CanvasCard, onUpdate: (u: Partial<CanvasCard>) => void) {
  const api = localFileApi()
  if (!api) return
  const want = CARD_LOCAL_KIND[card.type]
  const paths = await api.pick(want).catch(() => null)
  const p = paths?.[0]
  if (!p) return
  if (want && localKind(p) !== want) {
    await alertDialog(`このカードには${LOCAL_KIND_LABEL[want]}ファイルのみリンクできます。\n選択されたファイル: ${localFileName(p)}`)
    return
  }
  // ライブラリ参照カード (refFileId) の url はライブラリ実体と共有 — 消すとライブラリ側も壊れる
  if (isMediaRef(card.url) && !card.refFileId) deleteMedia(card.url!).catch(() => {})
  const name = localFileName(p)
  const extra = card.type === 'video' || card.type === 'audio' ? { bookmarks: [] as Bookmark[] } : {}
  onUpdate({ url: toLocalRef(p), title: card.title || name, content: name, refFileId: undefined, ...extra })
}

function pickFileForCard(card: CanvasCard, onUpdate: (u: Partial<CanvasCard>) => void) {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = card.type === 'pdf' ? '.pdf' : card.type === 'video' ? 'video/*' : card.type === 'audio' ? 'audio/*' : IMAGE_ACCEPT
  input.onchange = async () => {
    const file = input.files?.[0]
    if (!file) return
    if (card.type === 'image') { applyImageFile(file, card, onUpdate); return }
    // ライブラリ参照カードの url は共有実体なので消さない（自前アップロード分のみ削除）
    if (isMediaRef(card.url) && !card.refFileId) deleteMedia(card.url!).catch(() => {})
    const url = await putMedia(file)
    // Swapping in a different recording invalidates the old time-anchored bookmarks.
    onUpdate({ url, title: card.title || file.name, content: file.name, refFileId: undefined, bookmarks: [] })
  }
  input.click()
}

// ファイルライブラリから選んでメディアカードに設定するボタン+ピッカー。カードは
// ライブラリの idb: URL をそのまま使い、refFileId で「ライブラリで開く」へ辿れる
// （実体は共有 — ライブラリ側で削除されてもカードの参照が blob を生かし続ける）。
function LibraryPickButtonForCard({ card, onUpdate }: { card: CanvasCard; onUpdate: (u: Partial<CanvasCard>) => void }) {
  const { state } = useApp()
  const active = state.activeMasterProjectId
  const want = CARD_LOCAL_KIND[card.type]
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const files = useMemo(() => {
    const qq = q.trim().toLowerCase()
    return state.files
      .filter(f => f.masterProjectId === active || (f.linkedMasterIds ?? []).includes(active))
      .filter(f => !want || fileKind(f.mime, f.name) === want)
      .filter(f => !qq || f.name.toLowerCase().includes(qq) || f.tags.some(t => t.toLowerCase().includes(qq)) || (f.comment || '').toLowerCase().includes(qq))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }, [state.files, active, want, q])
  if (!open) {
    return (
      <button
        onClick={e => { e.stopPropagation(); setOpen(true) }}
        title="ファイルライブラリから選択"
        className="flex items-center gap-1 px-2 py-1 rounded border border-slate-200 text-[10px] text-slate-400 hover:text-orange-600 hover:border-orange-300 transition-colors"
      >
        <FilesGlyph size={11} /> ライブラリ
      </button>
    )
  }
  return (
    <>
      <div className="fixed inset-0 z-40" onMouseDown={e => { e.stopPropagation(); setOpen(false) }} />
      <div className="absolute z-50 left-1/2 -translate-x-1/2 top-8 w-[260px] bg-white border border-slate-200 rounded-lg shadow-xl p-2" onMouseDown={e => e.stopPropagation()}>
        <input
          autoFocus
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder={`ライブラリの${want ? LOCAL_KIND_LABEL[want] : 'ファイル'}を検索…`}
          className="w-full text-xs bg-slate-50 border border-slate-200 rounded px-2 py-1 outline-none focus:border-orange-400 mb-1"
        />
        <div className="max-h-[200px] overflow-y-auto">
          {files.length === 0 && <div className="text-[10px] text-slate-400 px-1 py-2 text-center">該当するファイルがありません<br />（「ファイル」ページで登録できます）</div>}
          {files.map(f => (
            <button
              key={f.id}
              onClick={() => {
                if (isMediaRef(card.url) && !card.refFileId) deleteMedia(card.url!).catch(() => {})
                const extra = card.type === 'video' || card.type === 'audio' ? { bookmarks: [] as Bookmark[] } : {}
                onUpdate({ url: f.url, refFileId: f.id, title: card.title || f.name, content: f.name, ...extra })
                setOpen(false)
              }}
              className="w-full text-left px-1.5 py-1 hover:bg-orange-50 rounded text-xs text-slate-700 flex items-center gap-1.5"
              title={f.comment || undefined}
            >
              <span className="truncate flex-1">{f.name || '(無名)'}</span>
              {f.masterProjectId !== active && <Share2 size={9} className="shrink-0 text-indigo-400" />}
            </button>
          ))}
        </div>
      </div>
    </>
  )
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

const ArrowItem = memo(function ArrowItem({ arrow, ends, d, selected, solo, interactive, onSelect, onEndDown, onWayDown, onWayInsert, onWayRemove, onEditLabel, onContextMenu }: {
  arrow: CanvasArrow
  ends: { x1: number; y1: number; x2: number; y2: number }
  d: string
  /** Part of the current selection (halo). */
  selected: boolean
  /** The ONLY selected element — shows the end/waypoint handles. */
  solo: boolean
  interactive: boolean
  onSelect: (additive: boolean) => void
  onEndDown: (e: React.MouseEvent, arrow: CanvasArrow, which: 'p1' | 'p2') => void
  onWayDown: (e: React.MouseEvent, arrow: CanvasArrow, idx: number) => void
  onWayInsert: (e: React.MouseEvent, arrow: CanvasArrow, idx: number, x: number, y: number) => void
  onWayRemove: (arrow: CanvasArrow, idx: number) => void
  onEditLabel: () => void
  onContextMenu: (e: React.MouseEvent) => void
}) {
  const color = arrow.color || '#6366f1'
  const width = arrow.width || 2
  const wps = arrow.points ?? []
  // Full vertex chain (ends + waypoints) — segment midpoints host the
  // "drag to bend here" ghost handles.
  const chain = [{ x: ends.x1, y: ends.y1 }, ...wps, { x: ends.x2, y: ends.y2 }]
  return (
    <g>
      {selected && (
        // Selection halo — same cue for a solo pick and for membership in a marquee.
        <path d={d} fill="none" stroke="#6366f1" strokeOpacity={0.25} strokeWidth={width + 8} strokeLinecap="round" style={{ pointerEvents: 'none' }} />
      )}
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
          onMouseDown={e => { if (e.button !== 0) return; e.stopPropagation(); onSelect(e.shiftKey) }}
          onDoubleClick={e => { e.stopPropagation(); onEditLabel() }}
          onContextMenu={e => { e.stopPropagation(); if (!selected) onSelect(false); onContextMenu(e) }}
        />
      )}
      {solo && interactive && (
        <>
          <circle cx={ends.x1} cy={ends.y1} r={5} stroke="#4f46e5" strokeWidth={2}
            style={{ fill: arrow.fromCardId ? '#4f46e5' : 'var(--handle-fill)', pointerEvents: 'all', cursor: 'move' }} onMouseDown={e => onEndDown(e, arrow, 'p1')} />
          <circle cx={ends.x2} cy={ends.y2} r={5} stroke="#4f46e5" strokeWidth={2}
            style={{ fill: arrow.toCardId ? '#4f46e5' : 'var(--handle-fill)', pointerEvents: 'all', cursor: 'move' }} onMouseDown={e => onEndDown(e, arrow, 'p2')} />
          {/* Bend waypoints: square handles, drag to move, double-click to remove */}
          {wps.map((pt, i) => (
            <rect key={`w${i}`} x={pt.x - 4.5} y={pt.y - 4.5} width={9} height={9} rx={2}
              stroke="#4f46e5" strokeWidth={2}
              style={{ fill: 'var(--handle-fill)', pointerEvents: 'all', cursor: 'move' }}
              onMouseDown={e => onWayDown(e, arrow, i)}
              onDoubleClick={e => { e.stopPropagation(); onWayRemove(arrow, i) }}
            />
          ))}
          {/* Ghost midpoint handles: drag to insert a bend at that segment */}
          {chain.slice(0, -1).map((pt, i) => {
            const nx = (pt.x + chain[i + 1].x) / 2, ny = (pt.y + chain[i + 1].y) / 2
            return (
              <circle key={`m${i}`} cx={nx} cy={ny} r={4}
                fill="#c7d2fe" stroke="#6366f1" strokeWidth={1.2} opacity={0.8}
                style={{ pointerEvents: 'all', cursor: 'copy' }}
                onMouseDown={e => onWayInsert(e, arrow, i, nx, ny)}
              />
            )
          })}
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
        style={{ left: label.x, top: label.y, fontSize: label.fontSize, color: label.color === '#1e293b' ? 'var(--ink-dark)' : label.color, fontWeight: 600, width: `${Math.max(4, label.text.length + 2)}ch` }}
      />
    )
  }
  return (
    <div
      onMouseDown={e => onMouseDownMove(e, label)}
      onDoubleClick={e => { e.stopPropagation(); onStartEdit() }}
      onContextMenu={onContextMenu}
      className={`absolute whitespace-nowrap leading-snug px-1 rounded select-none ${viewLocked ? 'cursor-default' : 'cursor-move'} ${selected ? 'outline outline-2 outline-offset-2 outline-indigo-500 bg-indigo-500/10 shadow-sm' : ''}`}
      style={{ left: label.x, top: label.y, fontSize: label.fontSize, color: label.color === '#1e293b' ? 'var(--ink-dark)' : label.color, fontWeight: 600 }}
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
  if (isLocalRef(u)) {
    // パス参照 → 元ファイルそのものを OS 既定アプリで開く（テンポラリ複製なし）。
    const api = localFileApi()
    if (api) { api.open(localRefPath(u)).catch(() => {}) }
    return
  }
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
  capturePage?: () => Promise<{ toDataURL(): string }>
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
  // Electron: src 属性は初回マウント時のみ使い、以降の url prop 変更は現在ページと
  // 異なる時だけ loadURL する。src 属性を毎レンダー再バインドすると、webview 内の
  // 遷移を onNavigate で card.url に書き戻した瞬間に同じページを再ロードしてしまう。
  const initialSrcRef = useRef(effectiveUrl || 'about:blank')
  // dom-ready 前に effectiveUrl が変わった場合、下の effect は throw ガードで
  // 早期 return したまま再実行されない。dom-ready 時に最新値でもう一度同期する。
  const effectiveUrlRef = useRef(effectiveUrl)
  useEffect(() => { effectiveUrlRef.current = effectiveUrl }, [effectiveUrl])
  // 直近に src / loadURL で「要求した」URL。同期判定は必ずこれと行う。
  // getURL()（リダイレクト・末尾スラッシュ正規化後の実URL）と prop を比較すると、
  // 例えば google.com → google.com/ の恒常的な差分で dom-ready のたびに再ロード
  // する無限ループになり、Google のボット判定を踏む（リサーチページの実害）。
  // ついでに webview 内をユーザーが自由に遷移しても、prop が変わらない限り
  // 元 URL へ引き戻さなくなる。
  const lastRequestedRef = useRef(initialSrcRef.current)
  useEffect(() => {
    if (!IS_ELECTRON) return
    const wv = hostRef.current?.querySelector('webview') as (WebviewEl & { loadURL?: (u: string) => Promise<void> }) | null
    if (!wv) return
    const syncUrl = () => {
      const want = effectiveUrlRef.current || 'about:blank'
      if (want === lastRequestedRef.current) return
      let cur = ''
      try { cur = wv.getURL?.() || '' } catch { return }
      if (cur === want) { lastRequestedRef.current = want; return }
      lastRequestedRef.current = want
      try { wv.loadURL?.(want)?.catch(() => { /* ignore */ }) } catch { /* ignore */ }
    }
    wv.addEventListener('dom-ready', syncUrl)
    return () => wv.removeEventListener('dom-ready', syncUrl)
  }, [])
  useEffect(() => {
    if (!IS_ELECTRON) return
    const wv = hostRef.current?.querySelector('webview') as (WebviewEl & { loadURL?: (u: string) => Promise<void> }) | null
    if (!wv) return
    const want = effectiveUrl || 'about:blank'
    if (want === lastRequestedRef.current) return
    // dom-ready 前の webview はメソッド呼び出しで throw する（初回マウント直後は
    // 必ずこの状態）。その間の初回ロードは src 属性が担うので黙って抜ける。
    let cur = ''
    try { cur = wv.getURL?.() || '' } catch { return }
    if (!cur) return
    if (cur === want) { lastRequestedRef.current = want; return }
    lastRequestedRef.current = want
    try { wv.loadURL?.(want)?.catch(() => { /* ignore */ }) } catch { /* ignore */ }
  }, [effectiveUrl])
  if (IS_ELECTRON) {
    return (
      <div ref={hostRef} className={`relative overflow-hidden ${className ?? ''}`} style={style}>
        {createElement('webview', {
          src: initialSrcRef.current,
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
  const { url: src, status } = useMediaState(card.url)
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
          <div className="flex-1 flex items-center justify-center" style={fixedHeight ? { height: fixedHeight } : undefined}>
            <MediaFallback status={status} refUrl={card.url} />
          </div>
        )
      ) : (
        <div
          className="flex-1 flex flex-col items-center justify-center gap-1.5 text-xs"
          style={fixedHeight ? { height: fixedHeight } : undefined}
        >
          <button
            onClick={() => { if (!locked) pickFileForCard(card, onUpdate) }}
            disabled={locked}
            className="flex flex-col items-center gap-1.5 text-slate-400 hover:text-rose-600 disabled:hover:text-slate-400 disabled:cursor-default transition-colors"
          >
            <FileDown size={22} className="opacity-50" />
            {locked ? 'PDF未設定' : 'PDFファイルを選択'}
          </button>
          {!locked && (
            <div className="relative flex items-center gap-1.5">
              {localFileApi() && (
                <button
                  onClick={() => linkLocalFileForCard(card, onUpdate)}
                  title="サーバー / ローカルのファイルを取り込まずパス参照でリンク"
                  className="flex items-center gap-1 px-2 py-1 rounded border border-slate-200 text-[10px] text-slate-400 hover:text-cyan-600 hover:border-cyan-300 transition-colors"
                >
                  <Link2 size={11} /> サーバー参照
                </button>
              )}
              <LibraryPickButtonForCard card={card} onUpdate={onUpdate} />
            </div>
          )}
        </div>
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
  const { url: src, status } = useMediaState(card.url)

  const onPaste = (e: React.ClipboardEvent) => {
    if (locked) return
    // Only an EMPTY card consumes the paste (the placeholder invites it). A filled
    // card lets the event bubble to the window handler, which creates a new card —
    // otherwise Ctrl+V while this card is focused would silently replace its image
    // (and delete the old blob). stopPropagation keeps the window handler from
    // ALSO creating a duplicate card for the same paste.
    if (card.url) return
    const item = Array.from(e.clipboardData.items).find(i => i.type.startsWith('image/'))
    if (item) { e.preventDefault(); e.stopPropagation(); applyImageFile(item.getAsFile(), card, onUpdate) }
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
          <MediaFallback status={status} refUrl={card.url} compact />
        )
      ) : (
        <div className="text-center text-slate-400 text-[11px] px-4 leading-relaxed">
          <div className="pointer-events-none">
            <ImageIcon size={26} className="mx-auto mb-1.5 opacity-40" />
            {locked ? '画像未設定' : <>画像を選択<br />ドラッグ&ドロップ / 貼り付け</>}
          </div>
          {!locked && (
            <div className="relative mt-2 inline-flex items-center gap-1.5" onClick={e => e.stopPropagation()}>
              {localFileApi() && (
                <button
                  onClick={() => linkLocalFileForCard(card, onUpdate)}
                  title="サーバー / ローカルの画像を取り込まずパス参照でリンク"
                  className="inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-200 bg-white/70 text-[10px] text-slate-400 hover:text-cyan-600 hover:border-cyan-300 transition-colors"
                >
                  <Link2 size={11} /> サーバー参照
                </button>
              )}
              <LibraryPickButtonForCard card={card} onUpdate={onUpdate} />
            </div>
          )}
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
  const { url: src, status } = useMediaState(card.url)
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
            <div className="relative flex items-center gap-1.5">
              <button
                onClick={() => pickFileForCard(card, onUpdate)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-fuchsia-500/10 border border-fuchsia-500/30 text-fuchsia-600 hover:bg-fuchsia-500/20 transition-colors text-xs"
              >
                <Video size={13} />
                動画を選択
              </button>
              {localFileApi() && (
                <button
                  onClick={() => linkLocalFileForCard(card, onUpdate)}
                  title="サーバー / ローカルの動画を取り込まずパス参照でリンク"
                  className="flex items-center gap-1 px-2 py-1.5 rounded border border-slate-200 text-[10px] text-slate-400 hover:text-cyan-600 hover:border-cyan-300 transition-colors"
                >
                  <Link2 size={11} /> サーバー参照
                </button>
              )}
              <LibraryPickButtonForCard card={card} onUpdate={onUpdate} />
            </div>
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
      <div className="group relative flex-1 min-h-0 bg-black" data-media-box={card.id}>
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
        ) : src ? (
          <video ref={videoRef} src={src} controls className="absolute inset-0 w-full h-full object-contain bg-black" />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <MediaFallback status={status} refUrl={card.url} />
          </div>
        )}
        {!locked && (
          <button
            onClick={() => { if (isMediaRef(card.url) && !card.refFileId) deleteMedia(card.url!).catch(() => {}); onUpdate({ url: '', content: '', bookmarks: [], refFileId: undefined }) }}
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
              data-export-hide="1"
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
        <div className="flex items-center gap-1" data-export-hide="1">
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
        <div className="flex items-center gap-1 overflow-x-auto pb-0.5" data-share-marks={card.id}>
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
  const { url: src, status } = useMediaState(card.url)
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
          <div className="relative flex items-center gap-1.5">
            <button
              onClick={() => pickFileForCard(card, onUpdate)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-orange-500/10 border border-orange-500/30 text-orange-600 hover:bg-orange-500/20 transition-colors text-xs"
            >
              <AudioLines size={13} /> 音声を選択
            </button>
            {localFileApi() && (
              <button
                onClick={() => linkLocalFileForCard(card, onUpdate)}
                title="サーバー / ローカルの音声を取り込まずパス参照でリンク"
                className="flex items-center gap-1 px-2 py-1.5 rounded border border-slate-200 text-[10px] text-slate-400 hover:text-cyan-600 hover:border-cyan-300 transition-colors"
              >
                <Link2 size={11} /> サーバー参照
              </button>
            )}
            <LibraryPickButtonForCard card={card} onUpdate={onUpdate} />
          </div>
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
        {!src && (
          <div className="absolute inset-0 flex items-center justify-center">
            <MediaFallback status={status} refUrl={card.url} compact />
          </div>
        )}
        {ready && dur > 0 && (card.bookmarks ?? []).map(b => (
          <div
            key={b.id}
            className="absolute top-0 bottom-0 w-0.5 -translate-x-1/2 pointer-events-none"
            style={{ left: `${Math.min(100, (b.time / dur) * 100)}%`, background: '#c2410ccc' }}
          />
        ))}
      </div>
      <div className="flex items-center gap-2 shrink-0" data-media-box={card.id}>
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
            onClick={() => { if (isMediaRef(card.url) && !card.refFileId) deleteMedia(card.url!).catch(() => {}); onUpdate({ url: '', content: '', bookmarks: [], refFileId: undefined }) }}
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
    // stopPropagation: without it the window paste handler also fires and drops a
    // stray new image card next to the frame that was just added.
    if (file) { e.preventDefault(); e.stopPropagation(); addFiles([file]) }
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

/* ── キャンバスリンクのミニマッププレビュー ──
   Read-only bird's-eye of the TARGET tab's cards/groups, scaled to whatever
   box the card body gives it (viewBox does the math). Same visual grammar as
   the corner minimap so it reads as "a canvas", not just a labeled card. */

const CanvasLinkPreview = memo(function CanvasLinkPreview({ cards, groups }: {
  cards: CanvasCard[]
  groups: CanvasGroup[]
}) {
  if (cards.length === 0 && groups.length === 0) {
    return <div className="w-full h-full flex items-center justify-center text-[10px] text-slate-400">（空のキャンバス）</div>
  }
  const PAD = 60
  const minX = Math.min(...cards.map(c => c.x), ...groups.map(g => g.x)) - PAD
  const minY = Math.min(...cards.map(c => c.y), ...groups.map(g => g.y)) - PAD
  const maxX = Math.max(...cards.map(c => c.x + c.width), ...groups.map(g => g.x + g.width)) + PAD
  const maxY = Math.max(...cards.map(c => c.y + c.height), ...groups.map(g => g.y + g.height)) + PAD
  return (
    <svg className="w-full h-full block" viewBox={`${minX} ${minY} ${Math.max(1, maxX - minX)} ${Math.max(1, maxY - minY)}`} preserveAspectRatio="xMidYMid meet">
      {groups.map(g => (
        <rect key={g.id} x={g.x} y={g.y} width={g.width} height={g.height} fill="none" stroke="#cbd5e1" strokeWidth={1.2} vectorEffect="non-scaling-stroke" rx={8} />
      ))}
      {cards.map(c => (
        <rect key={c.id} x={c.x} y={c.y} width={c.width} height={c.height} rx={6}
          fill={c.color && COLOR_THEMES[c.color] ? COLOR_THEMES[c.color].dot : '#94a3b8'} fillOpacity={0.7} />
      ))}
    </svg>
  )
})

/* ── Canvas card ── */

const CanvasCardComponent = memo(function CanvasCardComponent({ card, viewLocked, isSelected, onHeaderDown, onResizeDown, onUpdate, onSelect, onContextMenu, onPortHover, pickerOpen, detachOpen, pickerTab, pickerSearch, onOpenPicker, onClosePicker, onOpenDetach, onCloseDetach, onPickerTab, onPickerSearch, pickerChecked, onPickerCheck, onBulkLink, onJumpTab }: {
  card: CanvasCard
  viewLocked?: boolean
  isSelected: boolean
  onHeaderDown: (e: React.MouseEvent, card: CanvasCard) => void
  onResizeDown: (e: React.MouseEvent, card: CanvasCard) => void
  onUpdate: (updates: Partial<CanvasCard>) => void
  onSelect: (additive: boolean) => void
  onContextMenu: (e: React.MouseEvent) => void
  onPortHover?: (hovering: boolean) => void // shape cards: show/hide the hover connection ports
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
  pickerChecked: string[]
  onPickerCheck: (ids: string[], checked: boolean) => void
  onBulkLink: (taskIds: string[]) => void
  onJumpTab?: (tabId: string) => void
}) {
  // Linked source data (Note/Task) is sourced from the live store so edits propagate.
  const { state, dispatch } = useApp()
  const linkedNote = card.refNoteId ? state.notes.find(n => n.id === card.refNoteId) : undefined
  const linkedTask = card.refTaskId ? (() => { for (const p of state.projects) { const t = p.tasks.find(x => x.id === card.refTaskId); if (t) return t } return undefined })() : undefined
  const linkedSketch = card.refSketchId ? state.sketches.find(s => s.id === card.refSketchId) : undefined
  const isRefBroken = (!!card.refNoteId && !linkedNote) || (!!card.refTaskId && !linkedTask) || (!!card.refSketchId && !linkedSketch)
  const cfg = cardTypes[card.type]
  // Live task cards: a neutral white card with a 5px status stripe down the
  // left edge — same grammar as the board-color stripes in the Gantt. Canvas
  // status palette (user-picked): 未着手=emerald, 進行中=amber, 完了=blue.
  // An explicit user-picked card color keeps its themed frame; the stripe
  // still shows so status always reads.
  const taskStatus = linkedTask?.status
  const statusTheme = linkedTask && !card.color
    ? { bg: 'bg-white', border: 'border-slate-200', text: 'text-slate-500', header: 'bg-slate-50' }
    : undefined
  const statusStripe = linkedTask
    ? (taskStatus === 'done' ? '#3b82f6' : taskStatus === 'in-progress' ? '#f59e0b' : '#10b981')
    : undefined
  const theme = statusTheme ?? ((card.color && COLOR_THEMES[card.color]) || cfg)
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

  // Shape cards are headerless figures: the whole body is the drag handle,
  // double-click edits the centered label, color reuses the card palette (dot hex).
  if (card.type === 'shape') {
    const kind = card.shape ?? 'rect'
    const { outline, extras } = shapePaths(kind, card.width, card.height)
    const dot = card.color ? COLOR_THEMES[card.color]?.dot : undefined
    const stroke = dot ?? '#64748b'
    return (
      <div
        className={`absolute select-none ${isSelected ? 'ring-2 ring-indigo-400/70 rounded-md' : ''}`}
        style={{ left: card.x, top: card.y, width: card.width, height: card.height, cursor: locked ? 'default' : 'grab' }}
        onMouseDown={e => {
          if (e.button !== 0) return
          if (e.shiftKey) { e.stopPropagation(); onSelect(true); return }
          onHeaderDown(e, card)
        }}
        onContextMenu={onContextMenu}
        onDoubleClick={() => { if (!locked) setEditingTitle(true) }}
        onMouseEnter={() => onPortHover?.(true)}
        onMouseLeave={() => onPortHover?.(false)}
        title={locked ? undefined : 'ダブルクリックでラベルを編集'}
      >
        <svg width={card.width} height={card.height} className="block">
          <path d={outline} style={{ fill: 'var(--shape-fill)' }} fillOpacity={0.85} />
          {dot && <path d={outline} fill={dot} fillOpacity={0.16} />}
          <path d={outline} fill="none" stroke={stroke} strokeWidth={2} strokeLinejoin="round" />
          {extras.map((d, i) => <path key={i} d={d} fill="none" stroke={stroke} strokeWidth={2} />)}
        </svg>
        {locked && <Lock size={12} className="absolute top-1 right-1 text-amber-500" />}
        {editingTitle && !locked ? (
          <div className="absolute inset-0 flex items-center justify-center px-3">
            <input
              autoFocus
              type="text"
              value={card.title}
              onChange={e => onUpdate({ title: e.target.value })}
              onMouseDown={e => e.stopPropagation()}
              onBlur={() => setEditingTitle(false)}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === 'Escape') { e.stopPropagation(); e.currentTarget.blur() } }}
              className="w-full max-w-[85%] text-center text-sm font-medium bg-white/85 border border-indigo-300 rounded px-1.5 py-0.5 outline-none text-slate-800 placeholder-slate-400"
              placeholder="ラベル…"
            />
          </div>
        ) : card.title ? (
          // Triangles have no room at the vertical center-top; pictograms
          // (person / pc) sit the label at the bottom over a white pill so it
          // stays readable across the glyph lines.
          <div className={`absolute inset-0 flex justify-center px-3 pointer-events-none ${kind === 'triangle' ? 'items-end pb-[12%]' : (kind === 'person' || kind === 'pc') ? 'items-end pb-0.5' : 'items-center'}`}>
            <span className={`max-w-[88%] text-sm font-medium text-center break-words leading-snug text-slate-700 ${(kind === 'person' || kind === 'pc' || kind === 'server' || kind === 'file' || kind === 'folder') ? 'bg-white/75 rounded px-1' : ''}`}>{card.title}</span>
          </div>
        ) : null}
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
  }

  return (
    <div
      // shadow-lg + backdrop-blur-sm だと重なった隣のカードに影とブラーが大きく
      // かかって「にじみ」に見えるため、影は小さめ・ブラーなしに抑える。
      className={`absolute rounded-xl border shadow-md transition-shadow flex flex-col ${theme.bg} ${theme.border} ${isSelected ? 'ring-2 ring-indigo-500 shadow-indigo-500/20' : 'hover:shadow-lg'}`}
      style={{ left: card.x, top: card.y, width: card.width, height: card.height }}
      onMouseDown={e => { if (e.button === 0) { e.stopPropagation(); onSelect(e.shiftKey) } }}
      onContextMenu={onContextMenu}
    >
      {statusStripe && (
        <div
          className="absolute left-0 top-0 bottom-0 w-[5px] rounded-l-xl pointer-events-none"
          style={{ background: statusStripe }}
        />
      )}
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
        {taskStatus === 'in-progress' && (
          <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse shrink-0" title="進行中" />
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
            <div className="flex-1 min-h-0 relative" data-media-box={card.id}>
              <WebFrame
                url={card.url || ''}
                title={card.title || 'Web page'}
                embedMode
                className="absolute inset-0 w-full h-full border-none bg-white rounded-b-xl"
                onNavigate={(u, t) => {
                  // webview 内の遷移をカードへ書き戻して永続化する（undo履歴なし）。
                  // これがないと再起動時に card.url の初期URL（例: Google検索）へ戻ってしまう。
                  if (locked) return
                  if (!u || !/^https?:\/\//.test(u)) return
                  // 初期ロード（embed用に変換されたURL）は書き戻さない — 元の共有URLを保つ
                  if (u === card.url || u === toEmbedUrl(card.url || '')) return
                  // ローカルの埋め込みラッパー(127.0.0.1)は共有不能なURLなので保存しない
                  if (/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(u)) return
                  dispatch({
                    type: 'SET_CANVAS_CARD_VIEW',
                    payload: { id: card.id, url: u, ...(card.title || !t ? {} : { title: t }) },
                  })
                }}
              />
            </div>
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
        ) : card.type === 'canvasLink' ? (
          (() => {
            const tab = card.refTabId ? state.canvasTabs.find(t => t.id === card.refTabId) : undefined
            if (!card.refTabId) return (
              <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-2 px-3 py-3 text-center">
                <span className="text-[11px] text-slate-400">リンク先のキャンバスが未選択です</span>
                {!locked && (
                  <button
                    onMouseDown={e => e.stopPropagation()}
                    onClick={e => { e.stopPropagation(); onOpenPicker() }}
                    className="text-[10px] px-2 py-0.5 rounded border border-indigo-300 text-indigo-600 hover:bg-indigo-50"
                  >キャンバスを選択</button>
                )}
              </div>
            )
            if (!tab) return (
              <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-2 px-3 py-3 text-center">
                <span className="text-[11px] text-slate-500">リンク先が見つかりません</span>
                <button
                  onClick={() => onUpdate({ refTabId: undefined })}
                  className="text-[10px] px-2 py-0.5 rounded border border-slate-300 text-slate-600 hover:bg-slate-100"
                >リンクを解除</button>
              </div>
            )
            const board = tab.boardId ? state.canvasBoards.find(b => b.id === tab.boardId) : undefined
            const targetCards = state.canvasCards.filter(c => c.tabId === tab.id)
            const targetGroups = state.canvasGroups.filter(g => g.tabId === tab.id)
            return (
              <div className="flex-1 min-h-0 flex flex-col">
                <div
                  className="flex-1 min-h-0 bg-slate-50/70 cursor-pointer relative hover:bg-indigo-50/40 transition-colors"
                  onMouseDown={e => e.stopPropagation()}
                  onClick={e => { e.stopPropagation(); onJumpTab?.(tab.id) }}
                  title={`クリックで「${tab.name}」を開く`}
                >
                  <CanvasLinkPreview cards={targetCards} groups={targetGroups} />
                  {targetCards.length > 0 && (
                    <span className="absolute bottom-1 right-1.5 text-[9px] text-slate-400 bg-white/85 rounded px-1 pointer-events-none">{targetCards.length}枚</span>
                  )}
                </div>
                <div className="px-2 py-1 border-t border-slate-200/60 flex items-center gap-1 text-[10px] text-slate-500 shrink-0">
                  <LayoutGrid size={10} className="text-indigo-500 shrink-0" />
                  <span className="truncate flex-1" title={`${board ? `${board.name} › ` : ''}${tab.name}`}>{board ? `${board.name} › ` : ''}{tab.name}</span>
                  {!locked && (
                    <button
                      onMouseDown={e => e.stopPropagation()}
                      onClick={e => { e.stopPropagation(); onOpenPicker() }}
                      className="p-0.5 rounded text-slate-400 hover:text-indigo-600 hover:bg-slate-100 shrink-0"
                      title="リンク先を変更"
                    ><Link2 size={10} /></button>
                  )}
                  <button
                    onMouseDown={e => e.stopPropagation()}
                    onClick={e => { e.stopPropagation(); onJumpTab?.(tab.id) }}
                    className="p-0.5 rounded text-indigo-500 hover:text-indigo-700 hover:bg-indigo-50 shrink-0"
                    title="開く"
                  ><ArrowUpRight size={11} /></button>
                </div>
              </div>
            )
          })()
        ) : linkedTask ? (
          <div className="flex-1 min-h-0 flex flex-col">
            <div className="px-3 py-1 border-b border-slate-200/60 flex items-center gap-1 text-[10px] text-slate-500 shrink-0">
              <Link2 size={10} className="text-indigo-400 shrink-0" />
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${linkedTask.status === 'done' ? 'bg-blue-500' : linkedTask.status === 'in-progress' ? 'bg-amber-500' : 'bg-emerald-500'}`} />
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
                className={`rounded-full px-2 py-0.5 text-[10px] border cursor-pointer font-medium ${
                  linkedTask.status === 'done'
                    ? 'bg-blue-500 text-white border-blue-600'
                    : linkedTask.status === 'in-progress'
                      ? 'bg-amber-400 text-white border-amber-500'
                      : 'bg-emerald-500 text-white border-emerald-600'
                }`}
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
              onClick={() => onUpdate({ refNoteId: undefined, refTaskId: undefined, refSketchId: undefined })}
              className="text-[10px] px-2 py-0.5 rounded border border-slate-300 text-slate-600 hover:bg-slate-100"
            >リンクを解除</button>
          </div>
        ) : card.type === 'sketch' ? (
          linkedSketch ? (
            <SketchCardBody sketch={linkedSketch} onUnlink={() => onUpdate({ refSketchId: undefined })} locked={locked} />
          ) : (
            <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-2 px-3 py-4 text-center">
              <span className="text-[11px] text-slate-400">スケッチが未選択です</span>
              {!locked && (
                <button
                  onMouseDown={e => e.stopPropagation()}
                  onClick={e => { e.stopPropagation(); onOpenPicker() }}
                  className="text-[10px] px-2 py-0.5 rounded border border-fuchsia-300 text-fuchsia-600 hover:bg-fuchsia-50"
                >スケッチを選択</button>
              )}
            </div>
          )
        ) : card.type === 'mindtrain' ? (
          card.refPlanId ? (
            <MindtrainCardBody planId={card.refPlanId} onUnlink={() => onUpdate({ refPlanId: undefined })} locked={locked} />
          ) : (
            <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-2 px-3 py-4 text-center">
              <span className="text-[11px] text-slate-400">路線図が未選択です</span>
              {!locked && (
                <button
                  onMouseDown={e => e.stopPropagation()}
                  onClick={e => { e.stopPropagation(); onOpenPicker() }}
                  className="text-[10px] px-2 py-0.5 rounded border border-rose-300 text-rose-600 hover:bg-rose-50"
                >路線図を選択</button>
              )}
            </div>
          )
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
              {card.type !== 'sketch' && card.type !== 'canvasLink' && card.type !== 'mindtrain' && (
                <button
                  className={`px-2 py-0.5 rounded ${pickerTab === 'new' ? 'bg-indigo-100 text-indigo-700' : 'text-slate-500 hover:bg-slate-50'}`}
                  onClick={() => onPickerTab('new')}
                >新規作成</button>
              )}
              <button
                className="ml-auto p-0.5 rounded text-slate-400 hover:text-slate-700 hover:bg-slate-100"
                onClick={onClosePicker}
                title="閉じる (Esc)"
              ><X size={12} /></button>
            </div>
            {(pickerTab === 'existing' || card.type === 'sketch' || card.type === 'canvasLink' || card.type === 'mindtrain') ? (
              <>
                <input
                  value={pickerSearch}
                  onChange={e => onPickerSearch(e.target.value)}
                  placeholder={card.type === 'note' ? 'ノートを検索…' : card.type === 'sketch' ? 'スケッチを検索…' : card.type === 'canvasLink' ? 'キャンバスを検索…' : card.type === 'mindtrain' ? '路線図を検索…' : 'タスクを検索…'}
                  autoFocus
                  className="w-full text-xs bg-slate-50 border border-slate-200 rounded px-2 py-1 outline-none focus:border-indigo-400 mb-1"
                />
                <div className="max-h-[220px] overflow-y-auto">
                  {card.type === 'sketch'
                    ? state.sketches
                        .filter(s => s.masterProjectId === state.activeMasterProjectId)
                        .filter(s => !pickerSearch || (s.name || '').toLowerCase().includes(pickerSearch.toLowerCase()))
                        .map(s => (
                          <button
                            key={s.id}
                            className="w-full text-left px-1.5 py-1 hover:bg-slate-50 rounded text-xs text-slate-700 truncate flex items-center gap-1"
                            onClick={() => { onUpdate({ refSketchId: s.id }); onClosePicker() }}
                            title={s.name}
                          >
                            <span className="truncate">{s.name || '(無題)'}</span>
                            <span className="ml-auto text-[9px] text-slate-400 shrink-0">{s.strokes.length}本</span>
                          </button>
                        ))
                    : card.type === 'mindtrain'
                    ? <MindtrainPlanPickerList
                        projectId={state.activeMasterProjectId}
                        search={pickerSearch}
                        onPick={(planId, name) => { onUpdate({ refPlanId: planId, title: name || card.title }); onClosePicker() }}
                      />
                    : card.type === 'canvasLink'
                    ? state.canvasTabs
                        .filter(t => t.projectId === state.activeMasterProjectId && t.id !== card.tabId)
                        .filter(t => !pickerSearch || (t.name || '').toLowerCase().includes(pickerSearch.toLowerCase()))
                        .map(t => {
                          const b = t.boardId ? state.canvasBoards.find(x => x.id === t.boardId) : undefined
                          return (
                            <button
                              key={t.id}
                              className="w-full text-left px-1.5 py-1 hover:bg-slate-50 rounded text-xs text-slate-700 truncate flex items-center gap-1"
                              onClick={() => { onUpdate({ refTabId: t.id, title: t.name }); onClosePicker() }}
                              title={b ? `${b.name} / ${t.name}` : t.name}
                            >
                              <LayoutGrid size={11} className="text-indigo-400 shrink-0" />
                              <span className="truncate">{t.name}</span>
                              {b && <span className="ml-auto text-[9px] text-slate-400 shrink-0 truncate max-w-[80px]">{b.name}</span>}
                            </button>
                          )
                        })
                    : card.type === 'note'
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
                    : (() => {
                        const items = state.projects
                          .filter(p => p.masterProjectId === state.activeMasterProjectId)
                          .flatMap(p => p.tasks.map(t => ({ t, p })))
                          .filter(({ t }) => !pickerSearch || (t.title || '').toLowerCase().includes(pickerSearch.toLowerCase()))
                        const allChecked = items.length > 0 && items.every(({ t }) => pickerChecked.includes(t.id))
                        return (
                          <>
                            {items.length > 1 && (
                              <button
                                className="w-full text-left px-1.5 py-0.5 text-[10px] text-slate-400 hover:text-indigo-600 hover:bg-slate-50 rounded"
                                onClick={() => onPickerCheck(items.map(({ t }) => t.id), !allChecked)}
                              >{allChecked ? 'すべて解除' : 'すべて選択'}</button>
                            )}
                            {items.map(({ t, p }) => (
                              <div key={t.id} className="flex items-center gap-1 px-1.5 py-1 hover:bg-slate-50 rounded">
                                <input
                                  type="checkbox"
                                  checked={pickerChecked.includes(t.id)}
                                  onChange={e => onPickerCheck([t.id], e.target.checked)}
                                  className="shrink-0 accent-emerald-500 cursor-pointer"
                                  title="チェックして一括配置"
                                />
                                <button
                                  className="flex-1 min-w-0 text-left text-xs text-slate-700 truncate flex items-center gap-1"
                                  onClick={() => {
                                    // With checks active, row click just toggles too — a stray
                                    // click shouldn't silently discard the batch selection.
                                    if (pickerChecked.length > 0) { onPickerCheck([t.id], !pickerChecked.includes(t.id)); return }
                                    onUpdate({ refTaskId: t.id, title: t.title || card.title }); onClosePicker()
                                  }}
                                  title={`${p.name} / ${t.title || '(無題)'}`}
                                >
                                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${t.status === 'done' ? 'bg-blue-500' : t.status === 'in-progress' ? 'bg-amber-500' : 'bg-emerald-500'}`} />
                                  <span className="truncate">{t.title || '(無題)'}</span>
                                  <span className="ml-auto text-[9px] text-slate-400 shrink-0 truncate max-w-[80px]">{p.name}</span>
                                </button>
                              </div>
                            ))}
                          </>
                        )
                      })()
                  }
                  {((card.type === 'note' && state.notes.filter(n => n.masterProjectId === state.activeMasterProjectId).length === 0) ||
                    (card.type === 'sketch' && state.sketches.filter(s => s.masterProjectId === state.activeMasterProjectId).length === 0) ||
                    (card.type === 'canvasLink' && state.canvasTabs.filter(t => t.projectId === state.activeMasterProjectId && t.id !== card.tabId).length === 0) ||
                    (card.type === 'todo' && state.projects.filter(p => p.masterProjectId === state.activeMasterProjectId).every(p => p.tasks.length === 0))) && (
                    <div className="px-1.5 py-2 text-[10px] text-slate-400 text-center">候補がありません</div>
                  )}
                </div>
                {card.type === 'todo' && pickerChecked.length > 0 && (
                  <button
                    className="mt-1.5 w-full text-xs px-2 py-1.5 bg-emerald-500 text-white rounded hover:bg-emerald-600"
                    onClick={() => onBulkLink(pickerChecked)}
                  >選択した {pickerChecked.length} 件を一括配置</button>
                )}
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
                      onUpdate({ refTaskId: newId, title })
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
                onUpdate({ refNoteId: undefined, refTaskId: undefined, refSketchId: undefined })
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

const ListCardComponent = memo(function ListCardComponent({ card, onUpdate, onDelete, onJumpTab }: {
  card: CanvasCard
  onUpdate: (updates: Partial<CanvasCard>) => void
  onDelete: () => void
  onJumpTab?: (tabId: string) => void
}) {
  const { state: listState } = useApp()
  const linkedTabForList = card.type === 'canvasLink' && card.refTabId ? listState.canvasTabs.find(t => t.id === card.refTabId) : undefined
  const planMetaForList = useMindtrainStore(s => (card.type === 'mindtrain' && card.refPlanId ? s.workspaceMeta[card.refPlanId] : undefined))
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
        ) : card.type === 'shape' ? (
          (() => {
            const { outline, extras } = shapePaths(card.shape ?? 'rect', 160, 90)
            const dot = card.color ? COLOR_THEMES[card.color]?.dot : undefined
            const stroke = dot ?? '#64748b'
            return (
              <div className="flex items-center justify-center py-2">
                <svg width={160} height={90}>
                  <path d={outline} style={{ fill: dot ?? 'var(--shape-fill)' }} fillOpacity={dot ? 0.16 : 0.9} />
                  <path d={outline} fill="none" stroke={stroke} strokeWidth={2} strokeLinejoin="round" />
                  {extras.map((d, i) => <path key={i} d={d} fill="none" stroke={stroke} strokeWidth={2} />)}
                </svg>
              </div>
            )
          })()
        ) : card.type === 'canvasLink' ? (
          <div className="flex items-center gap-2 text-xs text-slate-600">
            <LayoutGrid size={13} className="text-indigo-500 shrink-0" />
            {linkedTabForList ? (
              <>
                <span className="truncate">{linkedTabForList.name}</span>
                {onJumpTab && (
                  <button
                    onClick={() => onJumpTab(linkedTabForList.id)}
                    className="ml-auto text-[10px] px-2 py-0.5 rounded bg-indigo-500 text-white hover:bg-indigo-600 flex items-center gap-1 shrink-0"
                  ><ArrowUpRight size={10} /> 開く</button>
                )}
              </>
            ) : (
              <span className="text-slate-400">{card.refTabId ? 'リンク先が見つかりません' : 'リンク先未選択（キャンバス表示で設定）'}</span>
            )}
          </div>
        ) : card.type === 'mindtrain' ? (
          <div className="flex items-center gap-2 text-xs text-slate-600">
            <TrainFront size={13} className="text-rose-500 shrink-0" />
            {planMetaForList ? (
              <span className="truncate">{planMetaForList.name || '(無題)'}</span>
            ) : (
              <span className="text-slate-400">{card.refPlanId ? 'リンク先が見つかりません' : 'リンク先未選択（キャンバス表示で設定）'}</span>
            )}
          </div>
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
