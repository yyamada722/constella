// 日本の祝日計算。法律(国民の祝日に関する法律)に基づき、固定日 + ハッピーマンデー +
// 春分/秋分(天文計算の近似式) + 振替休日 + 国民の休日 を生成する。
// 対象年: 2000-2099 (春分・秋分の近似式が有効な範囲)。

const pad2 = (n: number) => n.toString().padStart(2, '0')
function iso(y: number, m: number, d: number): string {
  return `${y}-${pad2(m)}-${pad2(d)}`
}
// year-month の "第N week" の dow (0=日,1=月...) を返す
function nthWeekday(year: number, month: number, n: number, dow: number): number {
  const first = new Date(year, month - 1, 1).getDay()
  return 1 + ((dow - first + 7) % 7) + (n - 1) * 7
}
// 春分の日
function vernal(year: number): number {
  if (year < 1980) return 21
  if (year < 2100) return Math.floor(20.8431 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4))
  return Math.floor(21.8510 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4))
}
// 秋分の日
function autumnal(year: number): number {
  if (year < 1980) return 23
  if (year < 2100) return Math.floor(23.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4))
  return Math.floor(24.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4))
}

// 振替休日: 祝日が日曜なら次の平日(他の祝日でもない日)を振替に
function substituteHolidays(base: Map<string, string>): Map<string, string> {
  const out = new Map(base)
  for (const [date, name] of base) {
    const d = new Date(date + 'T00:00:00')
    if (d.getDay() !== 0) continue
    let next = new Date(d.getTime() + 86400000)
    while (out.has(iso(next.getFullYear(), next.getMonth() + 1, next.getDate()))) {
      next = new Date(next.getTime() + 86400000)
    }
    out.set(iso(next.getFullYear(), next.getMonth() + 1, next.getDate()), `${name}（振替休日）`)
  }
  return out
}

// 国民の休日: 平日が祝日に挟まれていれば休日(典型例: 5/4 — 2007年以前)
function nationalHolidays(base: Map<string, string>): Map<string, string> {
  const out = new Map(base)
  const dates = [...base.keys()].sort()
  for (let i = 0; i < dates.length - 1; i++) {
    const a = new Date(dates[i] + 'T00:00:00')
    const c = new Date(dates[i + 1] + 'T00:00:00')
    const diff = (c.getTime() - a.getTime()) / 86400000
    if (diff !== 2) continue
    const b = new Date(a.getTime() + 86400000)
    const bIso = iso(b.getFullYear(), b.getMonth() + 1, b.getDate())
    if (b.getDay() === 0 || out.has(bIso)) continue
    out.set(bIso, '国民の休日')
  }
  return out
}

const cache = new Map<number, Map<string, string>>()
export function jpHolidaysForYear(year: number): Map<string, string> {
  const cached = cache.get(year)
  if (cached) return cached
  const m = new Map<string, string>()
  m.set(iso(year, 1, 1), '元日')
  m.set(iso(year, 1, nthWeekday(year, 1, 2, 1)), '成人の日')
  m.set(iso(year, 2, 11), '建国記念の日')
  if (year >= 2020) m.set(iso(year, 2, 23), '天皇誕生日')
  m.set(iso(year, 3, vernal(year)), '春分の日')
  m.set(iso(year, 4, 29), year >= 2007 ? '昭和の日' : 'みどりの日')
  m.set(iso(year, 5, 3), '憲法記念日')
  m.set(iso(year, 5, 4), year >= 2007 ? 'みどりの日' : '国民の休日')
  m.set(iso(year, 5, 5), 'こどもの日')
  // 海の日 — 2020/2021 はオリンピック特例で7/23,22。一般化は割愛(MVP)
  if (year === 2020) m.set(iso(year, 7, 23), '海の日')
  else if (year === 2021) m.set(iso(year, 7, 22), '海の日')
  else m.set(iso(year, 7, nthWeekday(year, 7, 3, 1)), '海の日')
  if (year >= 2016) {
    if (year === 2020) m.set(iso(year, 8, 10), '山の日')
    else if (year === 2021) m.set(iso(year, 8, 8), '山の日')
    else m.set(iso(year, 8, 11), '山の日')
  }
  m.set(iso(year, 9, nthWeekday(year, 9, 3, 1)), '敬老の日')
  m.set(iso(year, 9, autumnal(year)), '秋分の日')
  // スポーツの日(旧体育の日)
  if (year === 2020) m.set(iso(year, 7, 24), 'スポーツの日')
  else if (year === 2021) m.set(iso(year, 7, 23), 'スポーツの日')
  else m.set(iso(year, 10, nthWeekday(year, 10, 2, 1)), year >= 2020 ? 'スポーツの日' : '体育の日')
  m.set(iso(year, 11, 3), '文化の日')
  m.set(iso(year, 11, 23), '勤労感謝の日')
  if (year < 2020) m.set(iso(year, 12, 23), '天皇誕生日')

  const withSub = substituteHolidays(m)
  const final = nationalHolidays(withSub)
  cache.set(year, final)
  return final
}

export function holidayNameFor(isoDate: string): string | null {
  const y = parseInt(isoDate.slice(0, 4), 10)
  if (isNaN(y)) return null
  return jpHolidaysForYear(y).get(isoDate) ?? null
}
