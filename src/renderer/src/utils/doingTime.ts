// 進行中 (in-progress) cumulative time helpers. The clock itself is maintained
// by the UPDATE_TASK reducer (store.tsx) — these only read/format it.
import { Task } from '../types'

// Live cumulative total: settled segments + the running one (if any).
export function doingTotalMs(task: Pick<Task, 'doingMs' | 'doingSince'>, now: number = Date.now()): number {
  let total = task.doingMs ?? 0
  if (task.doingSince) {
    const seg = now - Date.parse(task.doingSince)
    if (Number.isFinite(seg) && seg > 0) total += seg
  }
  return total
}

// "45分" / "3時間20分" / "2日4時間" — coarse on purpose; this is wall-clock
// "how long has it sat in 進行中", not a stopwatch.
export function fmtDoingDuration(ms: number): string {
  const totalMin = Math.floor(ms / 60_000)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  if (h >= 48) {
    const d = Math.floor(h / 24)
    return `${d}日${h % 24 > 0 ? `${h % 24}時間` : ''}`
  }
  if (h >= 1) return `${h}時間${m > 0 ? `${m}分` : ''}`
  return `${m}分`
}
