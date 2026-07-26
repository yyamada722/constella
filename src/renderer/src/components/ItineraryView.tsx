// TripMD 互換の計画 markdown を日別タイムラインとして表示するビュー。
// リンクはクリックで展開: eチケット等の PDF ([label](idb:… / local:… / https:…))
// はインライン PdfViewer、画像/動画/音声はそのままプレビュー、Web ページは
// Electron の <webview>（ブラウザは iframe）で内容を表示する。
import { useState, useMemo, useEffect, createElement, ReactNode, memo } from 'react'
import {
  Plane, TrainFront, Bus, Car, Ship, Footprints, BedDouble, Utensils, Coffee,
  Landmark, Ticket, Camera, ScanLine, MapPin, Users, ShoppingBag, ClipboardList,
  ArrowRight, ExternalLink, X, FolderOpen, FileText, Globe, HardDrive, Paperclip,
  Info, Lightbulb, AlertTriangle, OctagonAlert, Megaphone, CalendarDays, Wallet,
  Map as MapGlyph,
  type LucideIcon,
} from 'lucide-react'
import { parseItinerary, formatPrice, formatDayLabel, type ItEvent, type ItBlock, type ItAlertLevel } from '../utils/itinerary'
import { useMediaUrl, getMediaBlob } from '../persistence/media'
import { isLocalRef, localRefPath, localFileName, localKind, localFileApi, type LocalKind } from '../utils/localFile'
import { PdfViewer } from './PdfViewer'

const IS_ELECTRON = typeof window !== 'undefined' && !!(window as unknown as { api?: unknown }).api

// タッチ主体の端末（スマホ/タブレット）ではチップ・ボタン類を一回り大きくして
// タップしやすくする。主ポインタで判定するのでマウスのPCは従来サイズのまま。
const IS_TOUCH = typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches

/* ── イベント種別 → アイコン + 色 ── */

export type Tone = 'sky' | 'indigo' | 'amber' | 'orange' | 'cyan' | 'violet' | 'rose' | 'emerald' | 'fuchsia' | 'blue' | 'teal' | 'slate'

const TONE_CLS: Record<Tone, { bubble: string; text: string }> = {
  sky: { bubble: 'bg-sky-100 text-sky-600 border-sky-200', text: 'text-sky-600' },
  indigo: { bubble: 'bg-indigo-100 text-indigo-600 border-indigo-200', text: 'text-indigo-600' },
  amber: { bubble: 'bg-amber-100 text-amber-600 border-amber-200', text: 'text-amber-600' },
  orange: { bubble: 'bg-orange-100 text-orange-600 border-orange-200', text: 'text-orange-600' },
  cyan: { bubble: 'bg-cyan-100 text-cyan-600 border-cyan-200', text: 'text-cyan-600' },
  violet: { bubble: 'bg-violet-100 text-violet-600 border-violet-200', text: 'text-violet-600' },
  rose: { bubble: 'bg-rose-100 text-rose-600 border-rose-200', text: 'text-rose-600' },
  emerald: { bubble: 'bg-emerald-100 text-emerald-600 border-emerald-200', text: 'text-emerald-600' },
  fuchsia: { bubble: 'bg-fuchsia-100 text-fuchsia-600 border-fuchsia-200', text: 'text-fuchsia-600' },
  blue: { bubble: 'bg-blue-100 text-blue-600 border-blue-200', text: 'text-blue-600' },
  teal: { bubble: 'bg-teal-100 text-teal-600 border-teal-200', text: 'text-teal-600' },
  slate: { bubble: 'bg-slate-100 text-slate-500 border-slate-200', text: 'text-slate-500' },
}

const TYPE_STYLE: Record<string, [LucideIcon, Tone]> = {
  flight: [Plane, 'sky'], plane: [Plane, 'sky'], fly: [Plane, 'sky'],
  train: [TrainFront, 'indigo'], rail: [TrainFront, 'indigo'], subway: [TrainFront, 'indigo'], metro: [TrainFront, 'indigo'],
  bus: [Bus, 'amber'],
  car: [Car, 'orange'], drive: [Car, 'orange'], taxi: [Car, 'orange'], rental: [Car, 'orange'],
  ferry: [Ship, 'cyan'], boat: [Ship, 'cyan'], ship: [Ship, 'cyan'],
  walk: [Footprints, 'slate'],
  hotel: [BedDouble, 'violet'], stay: [BedDouble, 'violet'], checkin: [BedDouble, 'violet'], checkout: [BedDouble, 'violet'],
  breakfast: [Utensils, 'rose'], lunch: [Utensils, 'rose'], dinner: [Utensils, 'rose'], meal: [Utensils, 'rose'], restaurant: [Utensils, 'rose'],
  cafe: [Coffee, 'rose'],
  museum: [Landmark, 'emerald'], sightseeing: [Landmark, 'emerald'], visit: [Landmark, 'emerald'], tour: [Landmark, 'emerald'], spot: [Landmark, 'emerald'],
  activity: [Ticket, 'emerald'], event: [Ticket, 'emerald'],
  shoot: [Camera, 'fuchsia'], photo: [Camera, 'fuchsia'], shooting: [Camera, 'fuchsia'],
  scan: [ScanLine, 'fuchsia'], capture: [ScanLine, 'fuchsia'],
  location: [MapPin, 'fuchsia'], loc: [MapPin, 'fuchsia'],
  meeting: [Users, 'blue'], mtg: [Users, 'blue'],
  shopping: [ShoppingBag, 'teal'], buy: [ShoppingBag, 'teal'],
  prep: [ClipboardList, 'slate'], plan: [ClipboardList, 'slate'],
}

// planPdf (PDF書き出し) も同じ種別→トーン対応を使う。
export function typeStyle(type: string): [LucideIcon, Tone] {
  return TYPE_STYLE[type] ?? [MapPin, 'slate']
}

/* ── アラート ── */

const ALERT_STYLE: Record<ItAlertLevel, { icon: LucideIcon; cls: string; label: string }> = {
  note: { icon: Info, cls: 'border-sky-300 bg-sky-50 text-sky-800', label: 'NOTE' },
  tip: { icon: Lightbulb, cls: 'border-emerald-300 bg-emerald-50 text-emerald-800', label: 'TIP' },
  important: { icon: Megaphone, cls: 'border-violet-300 bg-violet-50 text-violet-800', label: 'IMPORTANT' },
  warning: { icon: AlertTriangle, cls: 'border-amber-300 bg-amber-50 text-amber-800', label: 'WARNING' },
  caution: { icon: OctagonAlert, cls: 'border-rose-300 bg-rose-50 text-rose-800', label: 'CAUTION' },
}

/* ── 添付/リンクの展開プレビュー ── */

type Attachment = { href: string; label: string }

function kindFromMime(mime: string): LocalKind {
  if (mime.startsWith('image/')) return 'image'
  if (mime === 'application/pdf') return 'pdf'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  return 'other'
}

// ラベル/URL の拡張子からの初期推定（idb: は blob の MIME で後から確定）。
function guessKind(att: Attachment): LocalKind | 'web' {
  if (isLocalRef(att.href)) return localKind(att.href)
  if (/^https?:/i.test(att.href)) {
    const path = att.href.split(/[?#]/)[0]
    const k = localKind(path)
    return k === 'other' ? 'web' : k
  }
  const k = localKind(att.label)
  return k
}

// Electron の <webview>（ブラウザプレビューでは iframe）で Web ページを表示。
function WebPreview({ url }: { url: string }) {
  if (IS_ELECTRON) {
    return createElement('webview', {
      src: url,
      style: { width: '100%', height: '100%', border: 'none' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
  }
  return <iframe src={url} className="w-full h-full border-none" sandbox="allow-scripts allow-same-origin allow-popups" />
}

function AttachmentPreview({ att, onClose }: { att: Attachment; onClose: () => void }) {
  const [kind, setKind] = useState<LocalKind | 'web'>(() => guessKind(att))
  const isMedia = att.href.startsWith('idb:') || isLocalRef(att.href)
  const src = useMediaUrl(isMedia || kind !== 'web' ? att.href : undefined)
  const localApi = localFileApi()

  // idb: 添付は拡張子が無いことが多い → blob の MIME で種別を確定。既知の種別に
  // 解決できたときだけ上書きする — リモート(LAN)経由では octet-stream で届く
  // ことがあり、それで拡張子からの推定を潰すと「プレビュー非対応」に化ける。
  useEffect(() => {
    let alive = true
    if (att.href.startsWith('idb:')) {
      getMediaBlob(att.href).then(b => {
        if (!alive || !b || !b.type) return
        const k = kindFromMime(b.type)
        if (k !== 'other') setKind(k)
      }).catch(() => {})
    }
    return () => { alive = false }
  }, [att.href])

  const isHttp = /^https?:/i.test(att.href)
  const headBtnCls = `rounded hover:bg-slate-200 text-slate-400 hover:text-slate-600 ${IS_TOUCH ? 'p-2.5' : 'p-1'}`
  const headIcon = IS_TOUCH ? 18 : 12

  let body: ReactNode
  if (kind === 'web' && /^https?:/i.test(att.href)) {
    body = <div className="h-[420px]"><WebPreview url={att.href} /></div>
  } else if (!src) {
    body = (
      <div className="h-24 flex items-center justify-center text-xs text-slate-400">
        {isLocalRef(att.href) && !localApi ? 'この端末からはサーバー上のファイルを読めません' : '読み込み中…'}
      </div>
    )
  } else if (kind === 'pdf') {
    body = <PdfViewer url={src} fixedHeight={440} />
  } else if (kind === 'image') {
    body = <div className="flex justify-center bg-slate-100 max-h-[440px] overflow-auto"><img src={src} alt={att.label} className="max-w-full object-contain" /></div>
  } else if (kind === 'video') {
    body = <video src={src} controls className="w-full max-h-[440px] bg-black" />
  } else if (kind === 'audio') {
    body = <audio src={src} controls className="w-full px-3 py-4" />
  } else {
    body = <div className="h-20 flex items-center justify-center text-xs text-slate-400">プレビュー非対応の形式です（「開く」でOSのアプリを使用）</div>
  }

  return (
    <div className="mt-2 rounded-lg border border-slate-200 bg-white shadow-sm overflow-hidden">
      <div className={`flex items-center gap-1.5 px-2.5 border-b border-slate-100 bg-slate-50 ${IS_TOUCH ? 'py-1.5' : 'py-1.5'}`}>
        <Paperclip size={IS_TOUCH ? 15 : 12} className="text-slate-400 shrink-0" />
        <span className={`font-medium text-slate-600 truncate flex-1 ${IS_TOUCH ? 'text-sm' : 'text-[11px]'}`} title={isLocalRef(att.href) ? localRefPath(att.href) : att.href}>
          {att.label}
        </span>
        {isLocalRef(att.href) && localApi && (
          <button
            onClick={() => localApi.reveal(localRefPath(att.href)).catch(() => {})}
            title="フォルダで表示"
            className={headBtnCls}
          ><FolderOpen size={headIcon} /></button>
        )}
        {isLocalRef(att.href) ? (
          localApi && (
            <button onClick={() => localApi.open(localRefPath(att.href)).catch(() => {})} title="OSのアプリで開く" className={headBtnCls}>
              <ExternalLink size={headIcon} />
            </button>
          )
        ) : (isHttp || src) && (
          // 実アンカー — window.open だとスマホで「無題」の空タブが残ることがある。
          <a
            href={isHttp ? att.href : src}
            target="_blank"
            rel="noopener noreferrer"
            title={isHttp ? 'ブラウザで開く' : '別タブで開く'}
            className={headBtnCls}
          >
            <ExternalLink size={headIcon} />
          </a>
        )}
        <button onClick={onClose} title="閉じる" className={headBtnCls}>
          <X size={headIcon} />
        </button>
      </div>
      {body}
    </div>
  )
}

/* ── インラインテキスト描画（[label](href) リンク / word^ALIAS / **bold** / `code`） ── */

const LINK_RE = /\[([^\]\n]+)\]\(([^)\s]+)\)/g

function linkIcon(href: string): LucideIcon {
  if (isLocalRef(href)) return HardDrive
  if (href.startsWith('idb:')) return FileText
  return Globe
}

function renderPlain(text: string, keyBase: string): ReactNode[] {
  // word^ALIAS → word + 小バッジ、**bold**、`code`
  const out: ReactNode[] = []
  let rest = text
  let i = 0
  const TOKEN = /\*\*([^*]+)\*\*|`([^`]+)`|\^([A-Za-z0-9][\w-]*)/
  while (rest) {
    const m = TOKEN.exec(rest)
    if (!m) { out.push(rest); break }
    if (m.index > 0) out.push(rest.slice(0, m.index))
    if (m[1] != null) out.push(<strong key={`${keyBase}-b${i}`}>{m[1]}</strong>)
    else if (m[2] != null) out.push(<code key={`${keyBase}-c${i}`} className="px-1 py-0.5 rounded bg-slate-100 text-[0.85em] font-mono text-slate-600">{m[2]}</code>)
    else if (m[3] != null) out.push(
      <span key={`${keyBase}-a${i}`} className="ml-0.5 px-1 py-px rounded bg-slate-100 border border-slate-200 text-[9px] font-mono text-slate-500 align-middle">{m[3]}</span>
    )
    rest = rest.slice(m.index + m[0].length)
    i++
  }
  return out
}

const CHIP_CLS = `inline-flex items-center border border-indigo-200 bg-indigo-50 text-indigo-600 hover:bg-indigo-100 hover:border-indigo-300 font-medium align-middle transition-colors no-underline ${
  IS_TOUCH ? 'gap-2 px-3 py-2 mx-0.5 my-1 rounded-lg text-sm' : 'gap-1 px-1.5 py-px mx-0.5 rounded text-[0.9em]'
}`
const CHIP_ICON = IS_TOUCH ? 16 : 11

function renderRich(text: string, keyBase: string, onToggle: (att: Attachment) => void): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let i = 0
  LINK_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = LINK_RE.exec(text))) {
    if (m.index > last) out.push(...renderPlain(text.slice(last, m.index), `${keyBase}-p${i}`))
    const label = m[1]
    const href = m[2]
    const Icon = linkIcon(href)
    const isHttp = /^https?:/i.test(href)
    // ブラウザ（スマホ/LANリモート）の http リンクは実アンカーで新規タブに開く:
    //  - window.open だとポップアップ扱いで about:blank の「無題」タブが残ることがある
    //  - Google マップ等はインライン iframe 埋め込みを拒否するので展開しても白い枠になる
    // Electron では従来どおりクリックでインライン webview 展開（外部は右上ボタン）。
    if (isHttp && !IS_ELECTRON) {
      out.push(
        <a
          key={`${keyBase}-l${i}`}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          title={href}
          className={CHIP_CLS}
        >
          <Icon size={CHIP_ICON} className="shrink-0" />
          <span className="truncate max-w-[240px]">{label}</span>
        </a>
      )
    } else {
      out.push(
        <button
          key={`${keyBase}-l${i}`}
          onClick={() => onToggle({ href, label })}
          title={isHttp ? `${href}\nクリックで内容を表示` : isLocalRef(href) ? `${localRefPath(href)}\nクリックでプレビュー` : 'クリックでプレビュー'}
          className={CHIP_CLS}
        >
          <Icon size={CHIP_ICON} className="shrink-0" />
          <span className="truncate max-w-[240px]">{label}</span>
        </button>
      )
    }
    last = m.index + m[0].length
    i++
  }
  if (last < text.length) out.push(...renderPlain(text.slice(last), `${keyBase}-t`))
  return out
}

/* ── 展開状態を1ブロック分まとめて管理するフック ── */

function useAttachments() {
  const [expanded, setExpanded] = useState<Attachment[]>([])
  const toggle = (att: Attachment) => {
    setExpanded(prev => {
      const hit = prev.findIndex(a => a.href === att.href)
      if (hit >= 0) return prev.filter((_, idx) => idx !== hit)
      // http リンクは「表示」と同時に既定でインライン展開（eチケット/リンク内容の表示）
      return [...prev, att]
    })
  }
  const close = (href: string) => setExpanded(prev => prev.filter(a => a.href !== href))
  return { expanded, toggle, close }
}

function AttachmentPanels({ expanded, close }: { expanded: Attachment[]; close: (href: string) => void }) {
  if (expanded.length === 0) return null
  return (
    <div>
      {expanded.map(att => <AttachmentPreview key={att.href} att={att} onClose={() => close(att.href)} />)}
    </div>
  )
}

/* ── Google マップ連携 ── */

// リンク・^略号・装飾を落とした「地名として検索できる」テキストへ。
function plainPlace(s: string): string {
  return s
    .replace(LINK_RE, '$1')
    .replace(/\^[A-Za-z0-9][\w-]*/g, '')
    .replace(/\*\*|`/g, '')
    .trim()
}

// from→to があればルート検索、場所 (at / ::) だけなら地点検索の URL。
// どちらも公式の Maps URL API — スマホでは Google マップアプリがそのまま開く。
function mapsUrl(ev: ItEvent): string | null {
  const from = ev.from ? plainPlace(ev.from) : ''
  const to = ev.to ? plainPlace(ev.to) : ''
  if (from && to) {
    return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(from)}&destination=${encodeURIComponent(to)}`
  }
  const rawPlace = ev.at || ev.dest || ''
  if (/^https?:/i.test(rawPlace.trim())) return null // 場所欄が URL のみなら地図は出さない
  const place = plainPlace(rawPlace)
  if (!place) return null
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place)}`
}

function MapChip({ url }: { url: string }) {
  // 実アンカー: window.open('_blank','noopener') はスマホで「無題」の空タブが
  // 残ることがある。Electron でも target=_blank は setWindowOpenHandler 経由で
  // 既定ブラウザに渡る。
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={`Google マップで開く\n${url}`}
      className={`inline-flex items-center border border-emerald-200 bg-emerald-50 text-emerald-600 hover:bg-emerald-100 hover:border-emerald-300 font-medium transition-colors no-underline ${
        IS_TOUCH ? 'gap-2 px-3 py-2 rounded-lg text-sm' : 'gap-1 px-1.5 py-px rounded text-[10px]'
      }`}
    >
      <MapGlyph size={IS_TOUCH ? 16 : 10} /> 地図
    </a>
  )
}

/* ── イベント行 ── */

function timeLabel(t?: { time: string; dayOffset?: number }): string {
  if (!t) return ''
  const base = t.time === 'am' ? '午前' : t.time === 'pm' ? '午後' : t.time
  return base + (t.dayOffset ? `+${t.dayOffset}` : '')
}

const EventRow = memo(function EventRow({ event, isLast }: { event: ItEvent; isLast: boolean }) {
  const [Icon, tone] = typeStyle(event.type)
  const cls = TONE_CLS[tone]
  const { expanded, toggle, close } = useAttachments()
  const start = timeLabel(event.start)
  const end = timeLabel(event.end)

  const route = event.from || event.to ? (
    <span className="inline-flex items-center gap-1 text-slate-500">
      {event.from && <span>{renderRich(event.from, 'from', toggle)}</span>}
      <ArrowRight size={11} className="text-slate-400 shrink-0" />
      {event.to && <span>{renderRich(event.to, 'to', toggle)}</span>}
    </span>
  ) : event.at ? (
    <span className="inline-flex items-center gap-1 text-slate-500">
      <MapPin size={11} className="text-slate-400 shrink-0" />
      <span>{renderRich(event.at, 'at', toggle)}</span>
    </span>
  ) : null

  const metaShown = event.meta.filter(m => m.key !== 'price' && m.key !== 'cost')
  const mUrl = mapsUrl(event)

  return (
    <div className="flex gap-3">
      {/* 時刻列 */}
      <div className="w-[72px] shrink-0 text-right pt-1.5">
        <div className="text-xs font-semibold text-slate-700 tabular-nums">{start || '—'}</div>
        {end && <div className="text-[10px] text-slate-400 tabular-nums">{end}</div>}
        {event.start?.tz && <div className="text-[9px] text-slate-400 truncate" title={event.start.tz}>{event.start.tz.split('/').pop()}</div>}
      </div>
      {/* アイコン + 縦線 */}
      <div className="flex flex-col items-center shrink-0">
        <div className={`w-8 h-8 rounded-full border flex items-center justify-center ${cls.bubble}`}>
          <Icon size={15} />
        </div>
        {!isLast && <div className="w-px flex-1 bg-slate-200 my-1" />}
      </div>
      {/* 内容 */}
      <div className="flex-1 min-w-0 pb-4 pt-1">
        <div className="text-sm text-slate-800 leading-relaxed">
          <span className={`mr-1.5 text-[10px] font-mono uppercase tracking-wide ${cls.text}`}>{event.type || 'plan'}</span>
          {event.title && <span className="font-medium">{renderRich(event.title, 'title', toggle)}</span>}
          {event.dest && (
            <span className="text-slate-600">
              {event.title ? ' — ' : ''}
              {renderRich(event.dest, 'dest', toggle)}
            </span>
          )}
        </div>
        {(route || mUrl) && (
          <div className="text-xs mt-0.5 flex flex-wrap items-center gap-2">
            {route}
            {mUrl && <MapChip url={mUrl} />}
          </div>
        )}
        {(event.price || metaShown.length > 0) && (
          <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
            {event.price && (
              <span className="inline-flex items-center gap-1 px-1.5 py-px rounded bg-amber-50 border border-amber-200 text-amber-700 text-[10px] font-semibold">
                <Wallet size={10} /> {formatPrice(event.price)}
              </span>
            )}
            {metaShown.map((mt, idx) => (
              <span key={idx} className="inline-flex items-baseline gap-1 px-1.5 py-px rounded bg-slate-50 border border-slate-200 text-[10px] text-slate-600">
                <span className="text-slate-400">{mt.key}:</span>
                <span>{renderRich(mt.value, `m${idx}`, toggle)}</span>
              </span>
            ))}
          </div>
        )}
        {event.notes.length > 0 && (
          <div className="mt-1 text-xs text-slate-500 space-y-0.5">
            {event.notes.map((n, idx) => <div key={idx}>{renderRich(n, `n${idx}`, toggle)}</div>)}
          </div>
        )}
        <AttachmentPanels expanded={expanded} close={close} />
      </div>
    </div>
  )
})

/* ── アラート / 通常ブロック ── */

function AlertBlock({ level, title, lines }: { level: ItAlertLevel; title: string; lines: string[] }) {
  const s = ALERT_STYLE[level]
  const { expanded, toggle, close } = useAttachments()
  const Icon = s.icon
  return (
    <div className={`rounded-lg border px-3 py-2 my-2 ${s.cls}`}>
      <div className="flex items-center gap-1.5 text-xs font-semibold">
        <Icon size={13} className="shrink-0" />
        <span className="text-[9px] tracking-wider opacity-60 mr-0.5">{s.label}</span>
        <span>{renderRich(title, 'at', toggle)}</span>
      </div>
      {lines.length > 0 && (
        <div className="mt-1 text-xs opacity-90 space-y-0.5">
          {lines.map((l, i) => <div key={i}>{renderRich(l, `l${i}`, toggle)}</div>)}
        </div>
      )}
      <AttachmentPanels expanded={expanded} close={close} />
    </div>
  )
}

function ParaBlock({ text }: { text: string }) {
  const { expanded, toggle, close } = useAttachments()
  return (
    <div className="my-2 text-sm text-slate-600 leading-relaxed whitespace-pre-wrap">
      {text.split('\n').map((l, i) => <div key={i}>{renderRich(l, `p${i}`, toggle)}</div>)}
      <AttachmentPanels expanded={expanded} close={close} />
    </div>
  )
}

function ListBlock({ items }: { items: string[] }) {
  const { expanded, toggle, close } = useAttachments()
  return (
    <div className="my-2">
      <ul className="list-disc pl-5 text-sm text-slate-600 space-y-0.5">
        {items.map((it, i) => <li key={i}>{renderRich(it, `i${i}`, toggle)}</li>)}
      </ul>
      <AttachmentPanels expanded={expanded} close={close} />
    </div>
  )
}

/* ── 本体 ── */

export function ItineraryView({ content, fallbackTitle }: { content: string; fallbackTitle?: string }) {
  const it = useMemo(() => parseItinerary(content), [content])

  // 日付ごとにイベントを束ねる（縦線の終端判定のため、区間ごとに配列化する）
  const sections = useMemo(() => {
    type Section = { day?: { date: string; tz?: string }; items: ItBlock[] }
    const secs: Section[] = []
    let cur: Section = { items: [] }
    for (const b of it.blocks) {
      if (b.kind === 'day') {
        if (cur.day || cur.items.length) secs.push(cur)
        cur = { day: { date: b.date, tz: b.tz }, items: [] }
      } else {
        cur.items.push(b)
      }
    }
    if (cur.day || cur.items.length) secs.push(cur)
    return secs
  }, [it])

  const title = it.meta.title || fallbackTitle
  const hasBody = it.blocks.length > 0

  return (
    <div className="max-w-[760px] mx-auto px-5 py-5">
      {/* ヘッダ */}
      {(title || it.dayCount > 0) && (
        <div className="mb-5 pb-4 border-b border-slate-200">
          {title && <h1 className="text-lg font-bold text-slate-800">{title}</h1>}
          <div className="flex flex-wrap items-center gap-2 mt-2">
            {it.firstDate && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-indigo-50 border border-indigo-200 text-indigo-700 text-[11px] font-medium">
                <CalendarDays size={11} />
                {formatDayLabel(it.firstDate)}{it.lastDate && it.lastDate !== it.firstDate ? ` 〜 ${formatDayLabel(it.lastDate)}` : ''}
                {it.dayCount > 1 && <span className="opacity-70">・{it.dayCount}日間</span>}
              </span>
            )}
            {it.eventCount > 0 && (
              <span className="px-2 py-0.5 rounded-full bg-slate-100 border border-slate-200 text-slate-600 text-[11px]">{it.eventCount} 件の予定</span>
            )}
            {it.totals.map(t => (
              <span key={t.currency} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-50 border border-amber-200 text-amber-700 text-[11px] font-semibold">
                <Wallet size={11} /> 合計 {formatPrice(t)}
              </span>
            ))}
            {it.meta.timezone && <span className="text-[10px] text-slate-400">{it.meta.timezone}</span>}
          </div>
        </div>
      )}

      {!hasBody && (
        <div className="text-center text-sm text-slate-400 py-16">
          記法サンプルを挿入するか、`## 2026-08-01` の日付見出しと<br />`&gt; [09:00] shoot 撮影内容` のような予定行を書いてください
        </div>
      )}

      {sections.map((sec, si) => {
        const events = sec.items.filter(b => b.kind === 'event')
        let evIdx = 0
        return (
          <div key={si} className="mb-2">
            {sec.day && (
              // from/via-white は gen-dark-css の走査対象外 (bg-系のみ) — ダークは明示
              // dark: variant で下地色 (bg-white→neutral-800 と同じ) に合わせる
              <div className="sticky top-0 z-10 -mx-1 px-1 py-1.5 bg-gradient-to-b from-white via-white to-transparent dark:from-neutral-800 dark:via-neutral-800">
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-bold text-slate-800">{formatDayLabel(sec.day.date)}</span>
                  <span className="text-[10px] text-slate-400 font-mono">{sec.day.date}</span>
                  {sec.day.tz && <span className="px-1.5 py-px rounded bg-slate-100 border border-slate-200 text-[9px] text-slate-500 font-mono">@{sec.day.tz}</span>}
                </div>
              </div>
            )}
            <div className="mt-1">
              {sec.items.map((b, bi) => {
                if (b.kind === 'event') {
                  const isLast = ++evIdx === events.length
                  return <EventRow key={bi} event={b.event} isLast={isLast} />
                }
                if (b.kind === 'alert') return <AlertBlock key={bi} level={b.level} title={b.title} lines={b.lines} />
                if (b.kind === 'heading') {
                  const cls = b.depth <= 2 ? 'text-base font-bold' : 'text-sm font-semibold'
                  return <div key={bi} className={`${cls} text-slate-800 mt-4 mb-1`}>{b.text}</div>
                }
                if (b.kind === 'list') return <ListBlock key={bi} items={b.items} />
                if (b.kind === 'para') return <ParaBlock key={bi} text={b.text} />
                return null
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}
