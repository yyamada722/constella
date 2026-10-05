// CLI アクセスライン — `constella` コマンドからの RPC をレンダラーで処理する。
//
// データの正はこのレンダラーのメモリ上の state (sql.js は autosave で全置換保存)
// なので、外部から DB ファイルを書くと次の保存で消える。CLI は main の localhost
// サーバー → IPC → ここ、の経路で「最新 state を読む → 検証 → reducer へ dispatch」
// する。書き込みは UI と同じアクションなので completedAt / 進行中時計 / 状態タグの
// 正規化 / 同期 dirty / undo がそのまま効き、1 リクエスト = BATCH 1 undo。
//
// この関数は純粋 (state と reducer を受け取り、結果と dispatch すべきアクションを返す)。
// 呼び出し側は「読む→dispatch」の間に await を挟まないこと (commitSync と同じ不変条件)。
import type { AppState, Action } from '../store'
import type { Task, Note, Project, MasterProject, CustomStatus } from '../types'
import { generateId } from '../utils'
import { parseStatusWord, parseTaskScript, evaluateTaskScript, ruleMatches, resolveDate, STATUS_LABEL } from '../utils/taskScript'
import { applyStep, customStatusOf, plainTags } from '../utils/customStatus'
import { descendantIds, wouldCycle } from '../utils/taskTree'

export interface CliRequest { method: string; params?: Record<string, unknown> }
export type CliResponse = { ok: true; result: unknown; actions?: Action[] } | { ok: false; error: string }

class CliError extends Error {}
const fail = (msg: string): never => { throw new CliError(msg) }

type P = Record<string, unknown>
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined)
const has = (o: P, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)

// ── 解決 (id / 名前) ──

function resolveMaster(s: AppState, ref: unknown): MasterProject {
  const r = str(ref)
  if (!r) return fail('マスタープロジェクトの指定が空です')
  const byId = s.masterProjects.find(m => m.id === r)
  if (byId) return byId
  const hits = s.masterProjects.filter(m => m.name.toLowerCase() === r.toLowerCase())
  if (hits.length === 1) return hits[0]
  if (hits.length > 1) return fail(`マスタープロジェクト「${r}」が複数あります。id で指定してください: ${hits.map(m => m.id).join(', ')}`)
  const part = s.masterProjects.filter(m => m.name.toLowerCase().includes(r.toLowerCase()))
  if (part.length === 1) return part[0]
  return fail(part.length ? `マスタープロジェクト「${r}」が曖昧です: ${part.map(m => m.name).join(', ')}` : `マスタープロジェクト「${r}」が見つかりません`)
}

function resolveBoard(s: AppState, ref: unknown, masterRef?: unknown): Project {
  const r = str(ref)
  if (!r) return fail('ボードの指定が空です (--board)')
  const byId = s.projects.find(p => p.id === r)
  if (byId) return byId
  const pool = masterRef != null ? s.projects.filter(p => p.masterProjectId === resolveMaster(s, masterRef).id) : s.projects
  const exact = pool.filter(p => p.name.toLowerCase() === r.toLowerCase())
  const hits = exact.length ? exact : pool.filter(p => p.name.toLowerCase().includes(r.toLowerCase()))
  if (hits.length === 1) return hits[0]
  if (hits.length > 1) return fail(`ボード「${r}」が複数あります。--master か id で絞ってください: ${hits.map(p => `${p.name} (${p.id}, ${masterName(s, p.masterProjectId)})`).join(', ')}`)
  return fail(`ボード「${r}」が見つかりません`)
}

const masterName = (s: AppState, id: string): string => s.masterProjects.find(m => m.id === id)?.name ?? id

function findTask(s: AppState, id: string): { board: Project; task: Task } {
  for (const board of s.projects) {
    const task = board.tasks.find(t => t.id === id)
    if (task) return { board, task }
  }
  return fail(`タスク ${id} が見つかりません`)
}

function findNote(s: AppState, id: string): Note {
  return s.notes.find(n => n.id === id) ?? fail(`ノート ${id} が見つかりません`)
}

function resolveNoteFolder(s: AppState, masterId: string, ref: unknown): string | undefined {
  const r = str(ref)
  if (r == null || r === '') return undefined
  const pool = s.noteFolders.filter(f => f.masterProjectId === masterId)
  const hit = pool.find(f => f.id === r) ?? pool.filter(f => f.name === r)[0]
  if (!hit) return fail(`フォルダ「${r}」がこのマスタープロジェクトにありません`)
  if (pool.filter(f => f.name === r).length > 1 && hit.id !== r) return fail(`フォルダ「${r}」が複数あります。id で指定してください`)
  return hit.id
}

// ── 値の変換 ──

function parseDateArg(v: unknown, label: string): string | undefined {
  if (v === null || v === '' || v === 'none' || v === 'なし') return undefined
  const s = str(v) ?? fail(`${label} の値が不正です`)
  return resolveDate(s) ?? fail(`${label}「${s}」を日付として読めません (YYYY-MM-DD / 今日 / 今日+3)`)
}

function parsePriority(v: unknown): Task['priority'] {
  if (v === null || v === '' || v === 'none' || v === 'なし') return undefined
  const m = /^p?([1-4])$/i.exec(String(v).trim())
  return m ? (Number(m[1]) as Task['priority']) : fail(`優先度「${String(v)}」が不正です (1〜4 / P1〜P4)`)
}

function toTags(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(x => String(x).replace(/^#/, '').trim()).filter(Boolean)
  const s = str(v)
  return s ? s.split(/[,\s]+/).map(x => x.replace(/^#/, '').trim()).filter(Boolean) : []
}

// 状態: 基本状態の語 (todo / 進行中 / 完了 …) か、ボードのカスタムステータス名。
function applyStatusArg(task: Task, defs: CustomStatus[] | undefined, v: unknown): { task: Task; explicit: boolean } {
  const s = str(v) ?? fail('状態の値が不正です')
  const custom = defs?.find(d => d.name === s.trim())
  if (custom) return { task: applyStep(task, defs, { status: custom.base, customId: custom.id }), explicit: true }
  const base = parseStatusWord(s) ?? fail(`状態「${s}」が不正です (todo / 進行中 / 完了${defs?.length ? ' / ' + defs.map(d => d.name).join(' / ') : ''})`)
  return { task: applyStep(task, defs, { status: base, customId: null }), explicit: false }
}

// ── 出力形 ──

function taskOut(s: AppState, board: Project, t: Task, full = false): Record<string, unknown> {
  const custom = customStatusOf(t, board.customStatuses)
  const o: Record<string, unknown> = {
    id: t.id,
    title: t.title,
    status: t.status,
    statusLabel: custom?.name ?? STATUS_LABEL[t.status],
    board: board.name,
    boardId: board.id,
    master: masterName(s, board.masterProjectId),
    tags: plainTags(t, board.customStatuses),
  }
  if (t.parentId) o.parentId = t.parentId
  if (t.startDate) o.start = t.startDate
  if (t.endDate) o.end = t.endDate
  if (t.priority) o.priority = t.priority
  if (full) {
    o.description = t.description
    o.createdAt = t.createdAt
    if (t.completedAt) o.completedAt = t.completedAt
    if (t.linkedNoteIds?.length) o.linkedNoteIds = t.linkedNoteIds
    if (t.doingMs || t.doingSince) o.doingMs = (t.doingMs ?? 0) + (t.doingSince ? Date.now() - Date.parse(t.doingSince) : 0)
  }
  return o
}

function noteOut(s: AppState, n: Note, full = false): Record<string, unknown> {
  const o: Record<string, unknown> = {
    id: n.id,
    title: n.title,
    master: masterName(s, n.masterProjectId),
    masterId: n.masterProjectId,
    tags: n.tags,
    updatedAt: n.updatedAt,
  }
  if (n.folderId) o.folder = s.noteFolders.find(f => f.id === n.folderId)?.name ?? n.folderId
  if (n.pinned) o.pinned = true
  if (n.archivedAt) o.archivedAt = n.archivedAt
  if (full) { o.content = n.content; o.createdAt = n.createdAt }
  else o.chars = n.content.length
  return o
}

// ── 読み取り ──

function scopeBoards(s: AppState, p: P): Project[] {
  if (p.board != null) return [resolveBoard(s, p.board, p.master)]
  if (p.master != null) { const m = resolveMaster(s, p.master); return s.projects.filter(b => b.masterProjectId === m.id) }
  return s.projects
}

// --where はタスク一括編集スクリプトのセレクタ文法をそのまま使う (#tag @状態 期限<今日 …)。
function whereMatcher(where: unknown): ((t: Task) => boolean) | null {
  const w = str(where)?.trim()
  if (!w) return null
  const parsed = parseTaskScript(`${w} -> todo`)
  if (!parsed.ok) return fail(`--where を解釈できません: ${parsed.error}`)
  const rule = parsed.rules[0]
  return t => ruleMatches(rule, t)
}

function listTasks(s: AppState, p: P): unknown {
  const boards = scopeBoards(s, p)
  const match = whereMatcher(p.where)
  const status = p.status != null ? str(p.status) : undefined
  const tag = p.tag != null ? toTags(p.tag) : []
  const q = str(p.q)?.toLowerCase()
  const out: unknown[] = []
  for (const b of boards) {
    for (const t of b.tasks) {
      if (status) {
        const custom = b.customStatuses?.find(d => d.name === status)
        if (custom ? customStatusOf(t, b.customStatuses)?.id !== custom.id : t.status !== (parseStatusWord(status) ?? fail(`状態「${status}」が不正です`))) continue
      } else if (!p.all && t.status === 'done') continue
      if (tag.length && !tag.every(x => t.tags.includes(x))) continue
      if (q && !t.title.toLowerCase().includes(q) && !t.description.toLowerCase().includes(q)) continue
      if (match && !match(t)) continue
      out.push(taskOut(s, b, t, !!p.full))
    }
  }
  return out
}

function listNotes(s: AppState, p: P): unknown {
  const master = p.master != null ? resolveMaster(s, p.master) : null
  const folderId = master && p.folder != null ? resolveNoteFolder(s, master.id, p.folder) : undefined
  if (!master && p.folder != null) fail('--folder を使うときは --master も指定してください')
  const tag = p.tag != null ? toTags(p.tag) : []
  const q = str(p.q)?.toLowerCase()
  return s.notes
    .filter(n => {
      if (master && n.masterProjectId !== master.id && !n.refByMasterIds?.includes(master.id)) return false
      if (folderId && n.folderId !== folderId) return false
      if (!p.archived && n.archivedAt) return false
      if (tag.length && !tag.every(x => n.tags.includes(x))) return false
      if (q && !n.title.toLowerCase().includes(q) && !n.content.toLowerCase().includes(q)) return false
      return true
    })
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
    .map(n => noteOut(s, n, !!p.full))
}

// ── 書き込み: op → アクション列 ──

interface Ctx { s: AppState; refs: Map<string, string>; actions: Action[]; changes: unknown[]; reducer: (s: AppState, a: Action) => AppState }

const emit = (c: Ctx, a: Action): void => { c.actions.push(a); c.s = c.reducer(c.s, a) }

// "$name" は同じ apply 内で `as: "name"` を付けて作ったタスク/ノートの id。
function idOf(c: Ctx, v: unknown, label = 'id'): string {
  const s = str(v) ?? fail(`${label} がありません`)
  if (s.startsWith('$')) return c.refs.get(s.slice(1)) ?? fail(`参照 ${s} は未定義です (先に as: "${s.slice(1)}" で作成)`)
  return s
}

const TASK_DIFF_KEYS = ['title', 'status', 'tags', 'startDate', 'endDate', 'priority', 'parentId', 'description'] as const
function diff(before: object, after: object, keys: readonly string[]): Record<string, [unknown, unknown]> {
  const out: Record<string, [unknown, unknown]> = {}
  const b = before as Record<string, unknown>, a = after as Record<string, unknown>
  for (const k of keys) if (JSON.stringify(b[k]) !== JSON.stringify(a[k])) out[k] = [b[k], a[k]]
  return out
}

function checkParent(c: Ctx, board: Project, taskId: string | null, v: unknown): string | undefined {
  if (v === null || v === '' || v === 'none' || v === 'なし') return undefined
  const pid = idOf(c, v, 'parent')
  const cur = c.s.projects.find(p => p.id === board.id)!
  if (!cur.tasks.some(t => t.id === pid)) fail(`親タスク ${pid} は同じボード「${board.name}」にありません`)
  if (taskId && (pid === taskId || wouldCycle(cur.tasks, taskId, pid))) fail(`親子関係が循環します (${taskId} → ${pid})`)
  return pid
}

function opTaskAdd(c: Ctx, o: P): void {
  const board = resolveBoard(c.s, o.board, o.master)
  const title = str(o.title)?.trim() || fail('task.add: title が必要です')
  let task: Task = {
    id: generateId(),
    title,
    description: str(o.description) ?? '',
    status: 'todo',
    tags: toTags(o.tags),
    createdAt: new Date().toISOString(),
  }
  if (o.start != null) task.startDate = parseDateArg(o.start, 'start')
  if (o.end != null) task.endDate = parseDateArg(o.end, 'end')
  if (o.priority != null) task.priority = parsePriority(o.priority)
  if (o.parent != null) task.parentId = checkParent(c, board, null, o.parent)
  if (o.status != null) task = applyStatusArg(task, board.customStatuses, o.status).task
  emit(c, { type: 'ADD_TASK', payload: { projectId: board.id, task } })
  if (o.as) c.refs.set(String(o.as), task.id)
  c.changes.push({ op: 'task.add', id: task.id, board: board.name, title })
}

function opTaskUpdate(c: Ctx, o: P): void {
  const id = idOf(c, o.id)
  const { board, task } = findTask(c.s, id)
  const set = (o.set && typeof o.set === 'object' ? o.set : o) as P
  if (o.expect && typeof o.expect === 'object') {
    for (const [k, v] of Object.entries(o.expect as P)) {
      const cur = k === 'status' ? task.status : (task as unknown as P)[k === 'start' ? 'startDate' : k === 'end' ? 'endDate' : k]
      if (JSON.stringify(cur ?? null) !== JSON.stringify(v ?? null)) fail(`競合: タスク「${task.title}」の ${k} が想定 (${JSON.stringify(v)}) と違います (現在 ${JSON.stringify(cur ?? null)})`)
    }
  }
  let next: Task = { ...task }
  let explicit = false
  if (has(set, 'title')) next.title = str(set.title)?.trim() || fail('title を空にはできません')
  if (has(set, 'description')) next.description = str(set.description) ?? ''
  if (has(set, 'tags')) {
    // 状態タグはタグ指定で消さない (状態は status で変える)
    const statusNames = new Set((board.customStatuses ?? []).map(d => d.name))
    next.tags = [...next.tags.filter(t => statusNames.has(t) && customStatusOf(next, board.customStatuses)?.name === t), ...toTags(set.tags)]
  }
  if (has(set, 'addTags')) next.tags = [...next.tags, ...toTags(set.addTags).filter(t => !next.tags.includes(t))]
  if (has(set, 'removeTags')) { const rm = new Set(toTags(set.removeTags)); next.tags = next.tags.filter(t => !rm.has(t)) }
  if (has(set, 'start')) next.startDate = parseDateArg(set.start, 'start')
  if (has(set, 'end')) next.endDate = parseDateArg(set.end, 'end')
  if (has(set, 'priority')) next.priority = parsePriority(set.priority)
  if (has(set, 'parent')) next.parentId = checkParent(c, board, task.id, set.parent)
  if (has(set, 'status')) { const r = applyStatusArg(next, board.customStatuses, set.status); next = r.task; explicit = r.explicit }
  for (const k of ['startDate', 'endDate', 'priority', 'parentId'] as const) if (next[k] === undefined) delete next[k]
  const d = diff(task, next, TASK_DIFF_KEYS)
  if (!Object.keys(d).length) return
  emit(c, { type: 'UPDATE_TASK', payload: { projectId: board.id, task: next, explicitStatus: explicit } })
  c.changes.push({ op: 'task.update', id, board: board.name, title: task.title, diff: d })
}

function opTaskDelete(c: Ctx, o: P): void {
  const id = idOf(c, o.id)
  const { board, task } = findTask(c.s, id)
  // UI と同じく子孫ごと削除 (孤児サブタスクを残さない)
  const ids = [...descendantIds(board.tasks, id), id]
  for (const tid of ids) emit(c, { type: 'DELETE_TASK', payload: { projectId: board.id, taskId: tid } })
  c.changes.push({ op: 'task.delete', id, board: board.name, title: task.title, withDescendants: ids.length - 1 })
}

function opTaskScript(c: Ctx, o: P): void {
  const parsed = parseTaskScript(str(o.script) ?? fail('task.script: script が必要です'))
  if (!parsed.ok) fail(`スクリプトの解釈に失敗${parsed.line ? ` (${parsed.line}行目)` : ''}: ${parsed.error}`)
  const boards = scopeBoards(c.s, o)
  const res = evaluateTaskScript((parsed as { rules: Parameters<typeof evaluateTaskScript>[0] }).rules, boards)
  for (const ch of res.changes) opTaskUpdate(c, { id: ch.task.id, set: { status: ch.to } })
  const none = [...res.matched].filter(([, n]) => n === 0).map(([line]) => line)
  if (none.length) c.changes.push({ op: 'task.script', warning: `該当なしの行: ${none.join(', ')}` })
}

function opNoteAdd(c: Ctx, o: P): void {
  const master = o.master != null ? resolveMaster(c.s, o.master) : (c.s.masterProjects.find(m => m.id === c.s.activeMasterProjectId) ?? fail('マスタープロジェクトを --master で指定してください'))
  const now = new Date().toISOString()
  const note: Note = {
    id: generateId(),
    masterProjectId: master.id,
    title: str(o.title)?.trim() || '無題',
    content: str(o.content) ?? '',
    tags: toTags(o.tags),
    createdAt: now,
    updatedAt: now,
  }
  const folderId = resolveNoteFolder(c.s, master.id, o.folder)
  if (folderId) note.folderId = folderId
  emit(c, { type: 'ADD_NOTE', payload: note })
  if (o.as) c.refs.set(String(o.as), note.id)
  c.changes.push({ op: 'note.add', id: note.id, master: master.name, title: note.title, chars: note.content.length })
}

function opNoteUpdate(c: Ctx, o: P): void {
  const id = idOf(c, o.id)
  const note = findNote(c.s, id)
  if (o.expectUpdatedAt != null && o.expectUpdatedAt !== note.updatedAt) fail(`競合: ノート「${note.title}」は取得後に更新されています (updatedAt ${note.updatedAt})`)
  const next: Note = { ...note }
  if (has(o, 'title')) next.title = str(o.title)?.trim() || '無題'
  if (has(o, 'content')) next.content = str(o.content) ?? ''
  if (has(o, 'append')) next.content = next.content + (next.content && !next.content.endsWith('\n') ? '\n' : '') + (str(o.append) ?? '')
  if (has(o, 'prepend')) next.content = (str(o.prepend) ?? '') + (next.content ? '\n' : '') + next.content
  if (has(o, 'tags')) next.tags = toTags(o.tags)
  if (has(o, 'addTags')) next.tags = [...next.tags, ...toTags(o.addTags).filter(t => !next.tags.includes(t))]
  if (has(o, 'removeTags')) { const rm = new Set(toTags(o.removeTags)); next.tags = next.tags.filter(t => !rm.has(t)) }
  if (has(o, 'folder')) { const f = resolveNoteFolder(c.s, note.masterProjectId, o.folder); if (f) next.folderId = f; else delete next.folderId }
  if (has(o, 'pinned')) { if (o.pinned) next.pinned = true; else delete next.pinned }
  if (has(o, 'archived')) { if (o.archived) next.archivedAt = note.archivedAt ?? new Date().toISOString(); else delete next.archivedAt }
  const d = diff(note, next, ['title', 'tags', 'folderId', 'pinned', 'archivedAt'])
  const contentChanged = next.content !== note.content
  if (!Object.keys(d).length && !contentChanged) return
  next.updatedAt = new Date().toISOString()
  emit(c, { type: 'UPDATE_NOTE', payload: next })
  c.changes.push({ op: 'note.update', id, title: note.title, diff: d, ...(contentChanged ? { content: { before: note.content.length, after: next.content.length } } : {}) })
}

function opNoteDelete(c: Ctx, o: P): void {
  const id = idOf(c, o.id)
  const note = findNote(c.s, id)
  emit(c, { type: 'DELETE_NOTE', payload: id })
  c.changes.push({ op: 'note.delete', id, title: note.title })
}

const OPS: Record<string, (c: Ctx, o: P) => void> = {
  'task.add': opTaskAdd,
  'task.update': opTaskUpdate,
  'task.delete': opTaskDelete,
  'task.script': opTaskScript,
  'note.add': opNoteAdd,
  'note.update': opNoteUpdate,
  'note.delete': opNoteDelete,
}

function runOps(state: AppState, reducer: Ctx['reducer'], ops: unknown, dryRun: boolean): CliResponse {
  if (!Array.isArray(ops)) fail('ops は配列で渡してください')
  const c: Ctx = { s: state, refs: new Map(), actions: [], changes: [], reducer }
  ;(ops as unknown[]).forEach((raw, i) => {
    if (!raw || typeof raw !== 'object') fail(`ops[${i}] がオブジェクトではありません`)
    const o = raw as P
    const fn = OPS[String(o.op)] ?? fail(`ops[${i}]: 不明な op「${String(o.op)}」(${Object.keys(OPS).join(' / ')})`)
    try { fn(c, o) } catch (e) { if (e instanceof CliError) fail(`ops[${i}] (${String(o.op)}): ${e.message}`); throw e }
  })
  const result = { dryRun, applied: !dryRun && c.actions.length > 0, changes: c.changes, refs: Object.fromEntries(c.refs) }
  return { ok: true, result, actions: dryRun ? undefined : c.actions }
}

// ── エントリポイント ──

export function handleCliRequest(req: CliRequest, state: AppState, reducer: Ctx['reducer']): CliResponse {
  const p = (req.params ?? {}) as P
  try {
    switch (req.method) {
      case 'ping':
        return { ok: true, result: { ready: true } }
      case 'masters':
        return { ok: true, result: state.masterProjects.filter(m => p.all || !m.archivedAt).map(m => ({ id: m.id, name: m.name, active: m.id === state.activeMasterProjectId, ...(m.archivedAt ? { archivedAt: m.archivedAt } : {}), boards: state.projects.filter(b => b.masterProjectId === m.id).length, notes: state.notes.filter(n => n.masterProjectId === m.id).length })) }
      case 'boards':
        return { ok: true, result: (p.master != null ? scopeBoards(state, { master: p.master }) : state.projects).map(b => ({ id: b.id, name: b.name, master: masterName(state, b.masterProjectId), tasks: b.tasks.length, open: b.tasks.filter(t => t.status !== 'done').length, ...(b.customStatuses?.length ? { customStatuses: b.customStatuses.map(d => ({ name: d.name, base: d.base })) } : {}) })) }
      case 'tasks.list':
        return { ok: true, result: listTasks(state, p) }
      case 'tasks.get': {
        const { board, task } = findTask(state, str(p.id) ?? fail('id が必要です'))
        return { ok: true, result: taskOut(state, board, task, true) }
      }
      case 'notes.list':
        return { ok: true, result: listNotes(state, p) }
      case 'notes.get':
        return { ok: true, result: noteOut(state, findNote(state, str(p.id) ?? fail('id が必要です')), true) }
      case 'folders': {
        const m = p.master != null ? resolveMaster(state, p.master) : null
        return { ok: true, result: state.noteFolders.filter(f => !m || f.masterProjectId === m.id).map(f => ({ id: f.id, name: f.name, master: masterName(state, f.masterProjectId), ...(f.parentId ? { parentId: f.parentId } : {}) })) }
      }
      case 'apply':
        return runOps(state, reducer, p.ops, !!p.dryRun)
      default:
        return { ok: false, error: `不明なメソッド: ${req.method}` }
    }
  } catch (e) {
    if (e instanceof CliError) return { ok: false, error: e.message }
    return { ok: false, error: `内部エラー: ${e instanceof Error ? e.message : String(e)}` }
  }
}
