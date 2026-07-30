// TripMD (itinerary-md) 互換サブセットのパーサ。計画ページ (/plan) の markdown を
// 構造化して、日別タイムライン表示に渡す。
//
// 対応記法:
//   frontmatter    ---\n title: …\n timezone: Asia/Tokyo\n currency: JPY\n ---
//   日付見出し      ## 2026-01-23        / ## 2026-01-24 @Europe/Paris
//   イベント行      > [08:50] flight NH123 from 羽田空港^HND to 新千歳空港^CTS
//                  > [10:30] - [13:00] museum :: [ルーヴル](https://…)
//                  > [19:30@Europe/Paris] hotel チェックイン :: ホテル名
//                  > [pm] shopping 資料書籍   /   > [] prep 機材整理
//   メタデータ行    > - price: JPY {28000*2}   > - note: eチケットは下のリンク
//   アラート       > [!NOTE] タイトル（続く > 行が本文）
//   その他の行     素の markdown として段落/見出し/リストで表示

export interface TimePoint {
  time: string // 'HH:MM' | 'am' | 'pm' | '' (時刻未定)
  tz?: string
  dayOffset?: number // [09:00+1] → 1 (翌日着)
}

export interface ItMeta { key: string; value: string }

export interface ItPrice { currency: string; amount: number; raw: string }

export interface ItEvent {
  type: string // flight / hotel / shoot / …（小文字化済み）
  title: string // インラインmarkdown可（リンク・^エイリアス含む生テキスト）
  start?: TimePoint
  end?: TimePoint
  from?: string
  to?: string
  at?: string
  dest?: string // `::` の右側
  meta: ItMeta[]
  notes: string[] // イベント直後の素の引用行
  price?: ItPrice
}

export type ItAlertLevel = 'note' | 'tip' | 'important' | 'warning' | 'caution'

export type ItBlock =
  | { kind: 'day'; date: string; tz?: string }
  | { kind: 'event'; event: ItEvent }
  | { kind: 'alert'; level: ItAlertLevel; title: string; lines: string[] }
  | { kind: 'heading'; depth: number; text: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'para'; text: string }

export interface Itinerary {
  meta: Record<string, string>
  blocks: ItBlock[]
  dayCount: number
  eventCount: number
  /** 通貨別の price 合計（メタデータ price/cost 行から） */
  totals: ItPrice[]
  firstDate?: string
  lastDate?: string
}

const DAY_RE = /^#{1,3}\s+(\d{4}-\d{2}-\d{2})(?:\s+@([A-Za-z0-9_+\-/]+))?\s*$/
const ALERT_RE = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i
const META_RE = /^[-*]\s+([\w-]+)\s*:\s*(.*)$/
// [08:50] / [08:50@Asia/Tokyo] / [am] / [pm] / [09:00+1] / []
const TIME_INNER_RE = /^(\d{1,2}:\d{2}|am|pm)?(?:\+(\d+))?(?:@([A-Za-z0-9_+\-/]+))?$/

function parseTimePoint(bracketed: string): TimePoint | null {
  const inner = bracketed.replace(/^\[|\]$/g, '').trim()
  const m = TIME_INNER_RE.exec(inner)
  if (!m) return null
  return {
    time: m[1] ?? '',
    dayOffset: m[2] ? Number(m[2]) : undefined,
    tz: m[3],
  }
}

// `{80*2}` のような四則演算式を安全に評価（数字と演算子のみ許可）。
function evalBrace(expr: string): number | null {
  if (!/^[\d+\-*/().\s]+$/.test(expr) || !/\d/.test(expr)) return null
  try {
    const v = Function(`"use strict"; return (${expr})`)() as unknown
    return typeof v === 'number' && Number.isFinite(v) ? v : null
  } catch { return null }
}

const CURRENCY_SYMBOL: Record<string, string> = { '¥': 'JPY', '$': 'USD', '€': 'EUR', '£': 'GBP', '₩': 'KRW' }

/** `EUR {80*2}` / `¥1200` / `JPY 4500` / `{300}` → 通貨+金額 */
export function parsePrice(raw: string, defaultCurrency = 'JPY'): ItPrice | null {
  let s = raw.trim()
  if (!s) return null
  let currency = defaultCurrency
  const code = /^([A-Z]{3})\s*/.exec(s)
  if (code) { currency = code[1]; s = s.slice(code[0].length) }
  else if (CURRENCY_SYMBOL[s[0]]) { currency = CURRENCY_SYMBOL[s[0]]; s = s.slice(1).trim() }
  let amount: number | null = null
  const brace = /^\{([^}]*)\}$/.exec(s)
  if (brace) amount = evalBrace(brace[1])
  else {
    const n = Number(s.replace(/[,\s]/g, ''))
    amount = Number.isFinite(n) ? n : null
  }
  if (amount == null) return null
  return { currency, amount, raw }
}

// イベント行の時刻より後ろ: `type 残り` を分解し route を抽出。
function parseEventBody(body: string): Omit<ItEvent, 'start' | 'end' | 'meta' | 'notes'> {
  let rest = body.trim()
  let type = ''
  const tm = /^([A-Za-z][\w-]*)\b\s*/.exec(rest)
  if (tm) { type = tm[1].toLowerCase(); rest = rest.slice(tm[0].length) }

  let title = rest
  let dest: string | undefined
  let from: string | undefined
  let to: string | undefined
  let at: string | undefined

  const dd = title.split(/\s+::\s+|^::\s+/)
  if (dd.length > 1) {
    dest = dd.slice(1).join(' :: ').trim() || undefined
    title = dd[0].trim()
  }
  // `from X to Y` — リンク [t](u) 内の 'to' を巻き込まないよう、まず from を探す
  const fm = /\bfrom\s+(.+?)\s+to\s+(.+)$/.exec(title)
  if (fm) {
    from = fm[1].trim()
    to = fm[2].trim()
    title = title.slice(0, fm.index).trim()
  } else {
    const am = /\bat\s+(.+)$/.exec(title)
    if (am && !/\]\([^)]*$/.test(title.slice(0, am.index))) {
      at = am[1].trim()
      title = title.slice(0, am.index).trim()
    }
  }
  return { type, title, dest, from, to, at }
}

export function parseItinerary(src: string): Itinerary {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const meta: Record<string, string> = {}
  const blocks: ItBlock[] = []
  let i = 0

  // ── frontmatter ──
  if (lines[0]?.trim() === '---') {
    let j = 1
    const fm: Record<string, string> = {}
    while (j < lines.length && lines[j].trim() !== '---') {
      const m = /^([\w-]+)\s*:\s*(.*)$/.exec(lines[j].trim())
      if (m) fm[m[1].toLowerCase()] = m[2].trim()
      j++
    }
    if (j < lines.length) { Object.assign(meta, fm); i = j + 1 }
  }

  const defaultCurrency = meta.currency || 'JPY'
  let lastEvent: ItEvent | null = null
  let lastAlert: { kind: 'alert'; level: ItAlertLevel; title: string; lines: string[] } | null = null

  const dates: string[] = []
  let eventCount = 0

  // 引用ブロック外に出たらイベント/アラートの継続を打ち切る
  const closeQuote = () => { lastEvent = null; lastAlert = null }

  while (i < lines.length) {
    const rawLine = lines[i]
    const line = rawLine.trim()
    i++

    if (!line) { closeQuote(); continue }

    // ── 日付見出し ──
    const day = DAY_RE.exec(line)
    if (day) {
      closeQuote()
      blocks.push({ kind: 'day', date: day[1], tz: day[2] })
      dates.push(day[1])
      continue
    }

    // ── 引用行（イベント / メタ / アラート） ──
    if (line.startsWith('>')) {
      const q = line.replace(/^>\s?/, '').trim()
      if (!q) { closeQuote(); continue }

      const alert = ALERT_RE.exec(q)
      if (alert) {
        lastEvent = null
        lastAlert = { kind: 'alert', level: alert[1].toLowerCase() as ItAlertLevel, title: alert[2].trim(), lines: [] }
        blocks.push(lastAlert)
        continue
      }

      if (q.startsWith('[')) {
        // 時刻トークン 1〜2 個 + 本文
        const tm = /^(\[[^\]]*\])(?:\s*-\s*(\[[^\]]*\]))?\s*(.*)$/.exec(q)
        if (tm) {
          const start = parseTimePoint(tm[1])
          const end = tm[2] ? parseTimePoint(tm[2]) : null
          if (start) {
            const ev: ItEvent = {
              ...parseEventBody(tm[3] ?? ''),
              start,
              end: end ?? undefined,
              meta: [],
              notes: [],
            }
            blocks.push({ kind: 'event', event: ev })
            lastEvent = ev
            lastAlert = null
            eventCount++
            continue
          }
        }
      }

      const metaLine = META_RE.exec(q)
      if (metaLine && lastEvent) {
        const key = metaLine[1].toLowerCase()
        const value = metaLine[2].trim()
        lastEvent.meta.push({ key, value })
        if ((key === 'price' || key === 'cost') && !lastEvent.price) {
          lastEvent.price = parsePrice(value, defaultCurrency) ?? undefined
        }
        continue
      }

      // 引用内の素のテキスト → 直前のアラート本文 or イベント注記
      if (lastAlert) { lastAlert.lines.push(q); continue }
      if (lastEvent) { lastEvent.notes.push(q); continue }
      blocks.push({ kind: 'para', text: q })
      continue
    }

    closeQuote()

    // ── 通常の markdown（簡易） ──
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      blocks.push({ kind: 'heading', depth: heading[1].length, text: heading[2].trim() })
      continue
    }
    const li = /^[-*]\s+(.*)$/.exec(line)
    if (li) {
      const last = blocks[blocks.length - 1]
      if (last?.kind === 'list') last.items.push(li[1])
      else blocks.push({ kind: 'list', items: [li[1]] })
      continue
    }
    {
      const last = blocks[blocks.length - 1]
      if (last?.kind === 'para') last.text += '\n' + line
      else blocks.push({ kind: 'para', text: line })
    }
  }

  // ── 通貨別合計 ──
  const totalMap = new Map<string, number>()
  for (const b of blocks) {
    if (b.kind === 'event' && b.event.price) {
      totalMap.set(b.event.price.currency, (totalMap.get(b.event.price.currency) ?? 0) + b.event.price.amount)
    }
  }
  const totals: ItPrice[] = [...totalMap.entries()].map(([currency, amount]) => ({ currency, amount, raw: '' }))

  dates.sort()
  return {
    meta,
    blocks,
    dayCount: new Set(dates).size,
    eventCount,
    totals,
    firstDate: dates[0],
    lastDate: dates[dates.length - 1],
  }
}

/** 金額の表示用フォーマット（JPY は ¥1,234、他は CODE 1,234.50） */
export function formatPrice(p: ItPrice): string {
  const n = p.currency === 'JPY' ? Math.round(p.amount).toLocaleString('ja-JP') : p.amount.toLocaleString('en-US')
  if (p.currency === 'JPY') return `¥${n}`
  return `${p.currency} ${n}`
}

const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土']

/** '2026-08-01' → '8/1 (土)'。不正な日付は素通し。 */
export function formatDayLabel(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) return date
  const [y, mo, day] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const d = new Date(y, mo - 1, day)
  // new Date() rolls out-of-range parts over instead of producing NaN, so a typo
  // like 2026-13-45 would quietly render as a real (wrong) date. Compare the parts
  // back to catch both that and impossible days such as 2026-02-30.
  if (d.getFullYear() !== y || d.getMonth() !== mo - 1 || d.getDate() !== day) return date
  return `${d.getMonth() + 1}/${d.getDate()} (${WEEKDAY_JA[d.getDay()]})`
}
