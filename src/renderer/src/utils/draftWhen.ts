// Shared "大体いつ" (rough timing) helpers — used by the Canvas タスク下書き
// cards and the フロー page nodes. A DraftWhen chip is resolved to a concrete
// inclusive endDate (plain YYYY-MM-DD, the app-wide task date format) at the
// moment of task conversion.
import { DraftWhen } from '../types'

// Time axis, split into 5 positions within a month.
export const DRAFT_WHEN_OPTIONS: { key: DraftWhen; label: string }[] = [
  { key: 'monthStart', label: '月頭' },
  { key: 'earlyMonth', label: '初旬' },
  { key: 'midMonth', label: '中旬' },
  { key: 'lateMonth', label: '下旬' },
  { key: 'monthEnd', label: '月末' },
]

export function fmtLocalDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// DraftWhen → inclusive endDate: a representative day of the month (月頭=1st,
// 初旬=5th, 中旬=15th, 下旬=25th, 月末=last day).
//
// `month` (1-12) picks an absolute calendar month. With an explicit `year` the
// date is that exact year+month (honoured as-is, no rolling). Without a year the
// month resolves to its NEXT occurrence that is today-or-later (this year, else
// next year). When `month` is omitted the timing is relative to the current month
// and rolls to next month if that day has already passed. (JS Date normalises
// month overflow, so index 12 rolls into next January.)
export function draftWhenToEndDate(when: DraftWhen | undefined, month?: number, year?: number): string | undefined {
  if (!when) return undefined
  const now = new Date()
  const today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const build = (y: number, monthIndex: number): Date => {
    if (when === 'monthEnd') return new Date(y, monthIndex + 1, 0) // day 0 of next month = last day of monthIndex
    const day = when === 'monthStart' ? 1 : when === 'earlyMonth' ? 5 : when === 'midMonth' ? 15 : 25 // lateMonth
    return new Date(y, monthIndex, day)
  }
  if (month != null) {
    const mi = month - 1 // 1-12 → 0-indexed
    if (year != null) return fmtLocalDate(build(year, mi)) // explicit year → exact
    let d = build(now.getFullYear(), mi)
    if (d.getTime() < today0.getTime()) d = build(now.getFullYear() + 1, mi) // that month already passed this year
    return fmtLocalDate(d)
  }
  let d = build(now.getFullYear(), now.getMonth())
  if (d.getTime() < today0.getTime()) d = build(now.getFullYear(), now.getMonth() + 1)
  return fmtLocalDate(d)
}
