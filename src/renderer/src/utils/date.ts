// Date helpers for the Gantt / Calendar views. All "dates" are plain calendar dates
// stored as 'YYYY-MM-DD' strings — no time-of-day, no timezone surprises (math is
// done with the local-midnight Date built by isoToDate).

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/

export function pad2(n: number): string { return n < 10 ? '0' + n : String(n) }

export function isoToday(): string {
  const d = new Date()
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

export function isoToDate(iso: string): Date {
  // Construct at local midnight to avoid UTC drift across timezones.
  const m = ISO_RE.exec(iso)
  if (!m) return new Date(iso)
  const [y, mo, da] = iso.split('-').map(Number)
  return new Date(y, mo - 1, da)
}

export function dateToIso(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

export function isValidIso(s: string | undefined | null): s is string {
  return !!s && ISO_RE.test(s)
}

// Inclusive day difference: same date = 0, one day later = 1. Both args are YYYY-MM-DD.
export function daysBetween(a: string, b: string): number {
  const da = isoToDate(a).getTime(), db = isoToDate(b).getTime()
  return Math.round((db - da) / 86400000)
}

export function addDaysIso(iso: string, n: number): string {
  const d = isoToDate(iso)
  d.setDate(d.getDate() + n)
  return dateToIso(d)
}

// First (Monday=0) weekday of a YYYY-MM month, plus how many days the month has.
export function monthMeta(year: number, month0: number): { firstDay: number; days: number } {
  const first = new Date(year, month0, 1)
  const days = new Date(year, month0 + 1, 0).getDate()
  // JS getDay: Sun=0..Sat=6 — convert so Sun=0 stays Sun=0 (standard calendar).
  return { firstDay: first.getDay(), days }
}

// The 42-cell (6 weeks) grid of dates for a month, including padding days from the
// previous & next months so each row is a full week. Sunday-start.
export function monthGrid(year: number, month0: number): Date[] {
  const { firstDay } = monthMeta(year, month0)
  const out: Date[] = []
  const start = new Date(year, month0, 1 - firstDay)
  for (let i = 0; i < 42; i++) {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    out.push(d)
  }
  return out
}

// Earliest of `a` and `b` (YYYY-MM-DD); '' values are treated as missing.
export function minIso(a: string | undefined, b: string | undefined): string | undefined {
  if (!isValidIso(a)) return isValidIso(b) ? b : undefined
  if (!isValidIso(b)) return a
  return a < b ? a : b
}
export function maxIso(a: string | undefined, b: string | undefined): string | undefined {
  if (!isValidIso(a)) return isValidIso(b) ? b : undefined
  if (!isValidIso(b)) return a
  return a > b ? a : b
}

// Best-effort task span: returns [start, end] if either field is set, end>=start.
// Returns null if neither is set.
export function taskSpan(start: string | undefined, end: string | undefined): { start: string; end: string } | null {
  const s = isValidIso(start) ? start : undefined
  const e = isValidIso(end) ? end : undefined
  if (!s && !e) return null
  const a = s ?? e!
  const b = e ?? s!
  return a <= b ? { start: a, end: b } : { start: b, end: a }
}
