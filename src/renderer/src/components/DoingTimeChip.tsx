import { useEffect, useState } from 'react'
import { Timer } from 'lucide-react'
import { Task } from '../types'
import { doingTotalMs, fmtDoingDuration } from '../utils/doingTime'

// Compact 進行中累計 chip for task cards (kanban card / canvas todo card).
// One place owns the display rule — visible once the task has measurable
// accumulated time OR is currently in-progress; amber + 計測中 only while the
// live segment is actually running (doingSince set). Ticks once a minute while
// running so a card left on screen doesn't show a frozen "計測中" value.
export default function DoingTimeChip({ task, className = '' }: { task: Task; className?: string }) {
  const running = task.status === 'in-progress' && !!task.doingSince
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!running) return
    const id = window.setInterval(() => setTick(t => t + 1), 60_000)
    return () => window.clearInterval(id)
  }, [running])

  const total = doingTotalMs(task)
  if (total < 60_000 && task.status !== 'in-progress') return null
  return (
    <span
      className={`inline-flex items-center gap-1 ${running ? 'text-amber-600' : 'text-slate-400'} ${className}`}
      title={`進行中だった時間の累計${running ? '（計測中）' : ''}`}
    >
      <Timer size={10} />{fmtDoingDuration(total)}{running && <span className="text-[8px]">計測中</span>}
    </span>
  )
}
