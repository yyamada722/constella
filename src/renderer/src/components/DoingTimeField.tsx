import { useEffect, useState } from 'react'
import { Timer, Pencil, Check, X } from 'lucide-react'
import { Task } from '../types'
import { doingTotalMs, fmtDoingDuration } from '../utils/doingTime'

// 進行中の累計時間 row for the task editors (kanban editor / Gantt popover).
// Shows the live cumulative total and lets the user overwrite it (手修正) via
// 時間+分 inputs. The patch it emits goes through UPDATE_TASK, whose reducer
// owns the clock — on manual save while the task is running we restart the
// current segment at "now" so the total becomes exactly the entered value.
export default function DoingTimeField({ task, onPatch }: {
  task: Task
  onPatch: (patch: Pick<Task, 'doingMs' | 'doingSince'>) => void
}) {
  const running = task.status === 'in-progress' && !!task.doingSince
  const [editing, setEditing] = useState(false)
  const [h, setH] = useState('0')
  const [m, setM] = useState('0')
  // Re-render every 30s while the clock is running so the total stays fresh.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!running || editing) return
    const id = window.setInterval(() => setTick(t => t + 1), 30_000)
    return () => window.clearInterval(id)
  }, [running, editing])

  const total = doingTotalMs(task)

  const beginEdit = () => {
    const totalMin = Math.floor(doingTotalMs(task) / 60_000)
    setH(String(Math.floor(totalMin / 60)))
    setM(String(totalMin % 60))
    setEditing(true)
  }
  const save = () => {
    const hn = Math.max(0, Number(h) || 0)
    const mn = Math.max(0, Number(m) || 0)
    onPatch({
      doingMs: Math.round(hn * 3_600_000 + mn * 60_000),
      // Running task: restart the live segment now so total === entered value.
      doingSince: task.status === 'in-progress' ? new Date().toISOString() : undefined,
    })
    setEditing(false)
  }

  return (
    <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
      <span className="shrink-0 inline-flex items-center gap-1"><Timer size={12} className={running ? 'text-amber-500' : 'text-slate-400'} />進行中 累計</span>
      {editing ? (
        <span className="flex items-center gap-1 flex-1 min-w-0">
          <input
            type="number" min={0} value={h} autoFocus
            onChange={e => setH(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false) }}
            className="w-14 bg-slate-50 border border-slate-200 rounded px-1.5 py-0.5 outline-none focus:border-amber-400 text-right tabular-nums"
          />
          <span className="shrink-0">時間</span>
          <input
            type="number" min={0} max={59} value={m}
            onChange={e => setM(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false) }}
            className="w-12 bg-slate-50 border border-slate-200 rounded px-1.5 py-0.5 outline-none focus:border-amber-400 text-right tabular-nums"
          />
          <span className="shrink-0">分</span>
          <button onClick={save} title="保存" className="p-0.5 rounded text-emerald-600 hover:bg-emerald-50"><Check size={13} /></button>
          <button onClick={() => setEditing(false)} title="キャンセル" className="p-0.5 rounded text-slate-400 hover:bg-slate-100"><X size={13} /></button>
        </span>
      ) : (
        <span className="flex items-center gap-1.5 flex-1 min-w-0">
          <span className={`tabular-nums ${running ? 'text-amber-600 font-semibold' : total > 0 ? 'text-slate-600' : 'text-slate-400'}`}>
            {fmtDoingDuration(total)}
          </span>
          {running && <span className="text-[9px] text-amber-500">計測中</span>}
          <button onClick={beginEdit} title="累計時間を手修正" className="p-0.5 rounded text-slate-400 hover:text-amber-600 hover:bg-amber-50 transition-colors"><Pencil size={11} /></button>
        </span>
      )}
    </div>
  )
}
