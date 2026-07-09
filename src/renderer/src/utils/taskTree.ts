// Task hierarchy helpers. Tasks form a tree per board via the optional parentId.
// Parents auto-aggregate their span and status from descendants (only leaf tasks
// hold the "real" data; non-leaves display computed values).
import { Task } from '../types'
import { isValidIso, maxIso, minIso } from './date'

export interface Aggregate {
  startDate?: string                          // EFFECTIVE start: parent's own startDate if explicit, else child-aggregated. For leaves = own.
  endDate?: string                            // EFFECTIVE end: parent's own endDate if explicit, else child-aggregated. For leaves = own.
  childStartDate?: string                     // Raw min from descendant leaves — what parents aggregated to BEFORE explicit dates.
  childEndDate?: string                       // Raw max from descendant leaves.
  hasExplicitDates: boolean                   // True iff this task authored at least one of startDate/endDate (only meaningful when hasChildren).
  childOverflowsStart: boolean                // hasChildren + explicit start + child min < own start.
  childOverflowsEnd: boolean                  // hasChildren + explicit end + child max > own end.
  status: Task['status']                      // computed: see rules below
  totalLeaves: number                         // number of leaf descendants (==1 when self has no children)
  doneLeaves: number                          // leaf descendants whose status==='done'
  doingLeaves: number                         // leaf descendants whose status==='in-progress' (used to visualise the mixed state)
  progress: number                            // doneLeaves/totalLeaves in [0,1]; 0 when no leaves
  hasChildren: boolean
}

// Group a board's tasks by parentId so we can walk the tree cheaply.
export function childrenMap(tasks: Task[]): Map<string | undefined, Task[]> {
  const m = new Map<string | undefined, Task[]>()
  const known = new Set(tasks.map(t => t.id))
  for (const t of tasks) {
    // An orphaned parentId (parent deleted) is treated as a root.
    const key = t.parentId && known.has(t.parentId) ? t.parentId : undefined
    const arr = m.get(key) ?? []
    arr.push(t); m.set(key, arr)
  }
  return m
}

export function rootsOf(tasks: Task[]): Task[] {
  const known = new Set(tasks.map(t => t.id))
  return tasks.filter(t => !t.parentId || !known.has(t.parentId))
}

// All ancestor ids of `id`, for cycle prevention. Walks parentId upwards.
export function ancestorIds(tasks: Task[], id: string): Set<string> {
  const byId = new Map(tasks.map(t => [t.id, t]))
  const out = new Set<string>()
  let cur = byId.get(id)?.parentId
  let safety = 0
  while (cur && !out.has(cur) && safety < 500) { out.add(cur); cur = byId.get(cur)?.parentId; safety++ }
  return out
}

// All descendant ids of `id` (excluding self).
export function descendantIds(tasks: Task[], id: string): Set<string> {
  const ch = childrenMap(tasks)
  const out = new Set<string>()
  const walk = (i: string) => {
    for (const c of ch.get(i) ?? []) {
      if (out.has(c.id)) continue
      out.add(c.id); walk(c.id)
    }
  }
  walk(id)
  return out
}

// Would assigning `parentId = newParent` to `id` create a cycle?
export function wouldCycle(tasks: Task[], id: string, newParent: string | undefined): boolean {
  if (!newParent || newParent === id) return newParent === id
  if (newParent === id) return true
  // Disallow making a descendant the new parent.
  const desc = descendantIds(tasks, id)
  return desc.has(newParent)
}

// Compute the aggregate for `task`. Pure: pass the board's tasks; result is cached
// per call. Walks descendants; safe against (defensively trimmed) cycles via a visited set.
export function aggregateFor(tasks: Task[], task: Task): Aggregate {
  const ch = childrenMap(tasks)
  const visited = new Set<string>()
  function walk(t: Task): Aggregate {
    if (visited.has(t.id)) return { status: t.status, totalLeaves: 0, doneLeaves: 0, doingLeaves: 0, progress: 0, hasChildren: false, hasExplicitDates: false, childOverflowsStart: false, childOverflowsEnd: false }
    visited.add(t.id)
    const kids = ch.get(t.id) ?? []
    if (kids.length === 0) {
      // Leaf: own dates ARE both effective and child-aggregate (degenerate).
      const own = isValidIso(t.startDate) ? t.startDate : undefined
      const ownEnd = isValidIso(t.endDate) ? t.endDate : undefined
      return {
        startDate: own,
        endDate: ownEnd,
        childStartDate: own,
        childEndDate: ownEnd,
        hasExplicitDates: false,
        childOverflowsStart: false,
        childOverflowsEnd: false,
        status: t.status,
        totalLeaves: 1,
        doneLeaves: t.status === 'done' ? 1 : 0,
        doingLeaves: t.status === 'in-progress' ? 1 : 0,
        progress: t.status === 'done' ? 1 : 0,
        hasChildren: false,
      }
    }
    // For parents we aggregate child spans but DEFER to parent's own dates when set —
    // each end is independent (explicit start with auto end works, and vice versa).
    let s: string | undefined, e: string | undefined
    let total = 0, done = 0, doing = 0
    let anyDoing = false, anyTodo = false, anyDoneOrDoing = false
    for (const k of kids) {
      const a = walk(k)
      // Use the child's EFFECTIVE span (its own explicit if set, else its own children's aggregate)
      // — explicit parent dates cascade down naturally because each level reads .startDate/.endDate.
      s = minIso(s, a.startDate)
      e = maxIso(e, a.endDate)
      total += a.totalLeaves
      done += a.doneLeaves
      doing += a.doingLeaves
      if (a.status === 'in-progress') anyDoing = true
      else if (a.status === 'todo') anyTodo = true
      if (a.status !== 'todo') anyDoneOrDoing = true
    }
    // Status rules: all done → done; any in-progress (or mixed done/todo) → in-progress; else todo.
    let status: Task['status']
    if (total > 0 && done === total) status = 'done'
    else if (anyDoing || (anyDoneOrDoing && anyTodo)) status = 'in-progress'
    else status = 'todo'
    const ownStart = isValidIso(t.startDate) ? t.startDate : undefined
    const ownEnd = isValidIso(t.endDate) ? t.endDate : undefined
    const effectiveStart = ownStart ?? s
    const effectiveEnd = ownEnd ?? e
    return {
      startDate: effectiveStart,
      endDate: effectiveEnd,
      childStartDate: s,
      childEndDate: e,
      hasExplicitDates: !!(ownStart || ownEnd),
      childOverflowsStart: !!(ownStart && s && s < ownStart),
      childOverflowsEnd: !!(ownEnd && e && e > ownEnd),
      status,
      totalLeaves: total,
      doneLeaves: done,
      doingLeaves: doing,
      progress: total ? done / total : 0,
      hasChildren: true,
    }
  }
  return walk(task)
}
