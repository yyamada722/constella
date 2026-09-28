// タスク一括編集スクリプト — 行ベースの小さな DSL（または JSON 配列）で、
// 条件に合うタスクの状態をまとめて書き換える。
//
//   完了: 設計レビュー, "API 実装"        ← ステータス: セレクタ, セレクタ …
//   #backend @未着手 -> 進行中            ← セレクタ -> ステータス（矢印形式）
//   期限<今日 @未着手 -> 進行中           ← 期限切れの未着手を進行中に
//   /^テスト/ +子 -> 完了                  ← 正規表現、+子 で子孫も対象
//
// セレクタ内の空白区切りは AND、カンマ区切りは OR。評価は「実行前の状態」に
// 対して行い、複数の行に当たったタスクは後の行が勝つ（連鎖はしない）。
import type { Task, Project } from '../types'
import { descendantIds } from './taskTree'
import { isoToday } from './date'

export type TaskStatus = Task['status']

type Term =
  | { kind: 'all' }
  | { kind: 'id'; id: string }
  | { kind: 'tag'; tag: string }
  | { kind: 'exact'; title: string }
  | { kind: 'regex'; re: RegExp }
  | { kind: 'text'; re: RegExp; raw: string }
  | { kind: 'status'; status: TaskStatus }
  | { kind: 'priority'; p: number }
  | { kind: 'date'; field: 'endDate' | 'startDate'; op: '<' | '<=' | '>' | '>=' | '='; iso: string }

export interface ScriptRule {
  line: number
  raw: string
  status: TaskStatus
  selectors: Term[][] // OR of AND-groups
  descendants: boolean
}

export type ParseResult =
  | { ok: true; rules: ScriptRule[]; source: 'script' | 'JSON' }
  | { ok: false; error: string; line?: number }

export interface ScriptChange {
  projectId: string
  boardName: string
  task: Task
  from: TaskStatus
  to: TaskStatus
  line: number
}

export interface ScriptResult {
  changes: ScriptChange[]
  // per rule line: number of tasks matched (before de-dup / no-op removal)
  matched: Map<number, number>
}

export const STATUS_LABEL: Record<TaskStatus, string> = { todo: '未着手', 'in-progress': '進行中', done: '完了' }

export function parseStatusWord(v: string): TaskStatus | null {
  const s = v.trim().toLowerCase()
  if (['todo', '未着手', '未', 'open', 'pending'].includes(s)) return 'todo'
  if (['in-progress', 'inprogress', 'in_progress', 'doing', 'wip', 'progress', '進行中', '作業中', '進行'].includes(s)) return 'in-progress'
  if (['done', 'completed', 'complete', 'finished', 'closed', '完了', '済', '終了'].includes(s)) return 'done'
  return null
}

function globToRegex(raw: string): RegExp {
  const esc = raw.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(esc, 'i')
}

function resolveDate(v: string): string | null {
  const s = v.trim()
  if (s === '今日' || s.toLowerCase() === 'today') return isoToday()
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(s)
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
  // 今日+3 / today-7
  const rel = /^(今日|today)([+-]\d+)$/i.exec(s)
  if (rel) {
    const d = new Date(); d.setDate(d.getDate() + Number(rel[2]))
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  return null
}

// Split a selector string into tokens; quotes and /regex/ keep their spaces.
// Returns groups split on commas (OR), each a list of raw terms (AND).
function tokenize(sel: string): string[][] {
  const groups: string[][] = [[]]
  let i = 0
  const s = sel
  const push = (t: string) => { if (t) groups[groups.length - 1].push(t) }
  while (i < s.length) {
    const c = s[i]
    if (c === ' ' || c === '\t' || c === '　') { i++; continue }
    // OR separator: ASCII / full-width comma only. '、' stays part of a title
    // ("設計、実装" is a common Japanese title), so it is NOT a separator.
    if (c === ',' || c === '，') { groups.push([]); i++; continue }
    if (c === '"' || c === "'" || c === '「') {
      const close = c === '「' ? '」' : c
      const j = s.indexOf(close, i + 1)
      if (j < 0) throw new Error('引用符が閉じていません')
      push(c + s.slice(i + 1, j) + c)
      i = j + 1
      continue
    }
    if (c === '/') {
      let j = i + 1
      while (j < s.length && !(s[j] === '/' && s[j - 1] !== '\\')) j++
      if (j >= s.length) throw new Error('正規表現が閉じていません')
      let k = j + 1
      while (k < s.length && /[a-z]/i.test(s[k])) k++
      push(s.slice(i, k))
      i = k
      continue
    }
    let j = i
    while (j < s.length && !/[\s,，]/.test(s[j])) j++
    push(s.slice(i, j))
    i = j
  }
  return groups.filter(g => g.length > 0)
}

function parseTerm(tok: string): Term | 'descendants' {
  if (tok === '*' || tok === 'すべて' || tok === '全て' || tok === 'all') return { kind: 'all' }
  if (tok === '+子' || tok === '+children' || tok === '+desc' || tok === '+子孫') return 'descendants'
  if (tok.startsWith('id:')) return { kind: 'id', id: tok.slice(3) }
  if (tok.startsWith('#')) return { kind: 'tag', tag: tok.slice(1).toLowerCase() }
  if (tok.startsWith('@')) {
    const st = parseStatusWord(tok.slice(1))
    if (!st) throw new Error(`状態が不明です: ${tok}`)
    return { kind: 'status', status: st }
  }
  const pm = /^(?:p|P|優先度)([1-4])$/.exec(tok)
  if (pm) return { kind: 'priority', p: Number(pm[1]) }
  const dm = /^(due|期限|終了|end|start|開始)(<=|>=|<|>|=)(.+)$/i.exec(tok)
  if (dm) {
    const field = /^(start|開始)$/i.test(dm[1]) ? 'startDate' : 'endDate'
    const iso = resolveDate(dm[3])
    if (!iso) throw new Error(`日付が不明です: ${dm[3]}（YYYY-MM-DD / 今日 / 今日+3）`)
    return { kind: 'date', field, op: dm[2] as '<' | '<=' | '>' | '>=' | '=', iso }
  }
  if ((tok.startsWith('"') && tok.endsWith('"')) || (tok.startsWith("'") && tok.endsWith("'")) || (tok.startsWith('「') && tok.endsWith('「'))) {
    return { kind: 'exact', title: tok.slice(1, -1) }
  }
  if (tok.startsWith('/') && tok.length > 2) {
    const j = tok.lastIndexOf('/')
    if (j > 0) {
      try { return { kind: 'regex', re: new RegExp(tok.slice(1, j), tok.slice(j + 1) || 'i') } }
      catch { throw new Error(`正規表現が不正です: ${tok}`) }
    }
  }
  return { kind: 'text', re: globToRegex(tok), raw: tok }
}

function parseRuleLine(line: string, lineNo: number): ScriptRule {
  let statusPart: string | null = null
  let selPart: string | null = null
  const arrow = /^(.*?)\s*(->|=>|→|⇒)\s*([^\s]+)\s*$/.exec(line)
  if (arrow) { selPart = arrow[1]; statusPart = arrow[3] }
  else {
    const colon = /^([^:：]+)[:：]\s*(.*)$/.exec(line)
    if (colon && parseStatusWord(colon[1])) { statusPart = colon[1]; selPart = colon[2] }
  }
  if (statusPart == null || selPart == null) throw new Error('「状態: セレクタ」または「セレクタ -> 状態」の形で書いてください')
  const status = parseStatusWord(statusPart)
  if (!status) throw new Error(`状態が不明です: ${statusPart}（未着手 / 進行中 / 完了）`)
  if (!selPart.trim()) throw new Error('対象（セレクタ）がありません。すべて対象にするなら * を書いてください')
  let descendants = false
  const selectors: Term[][] = []
  for (const group of tokenize(selPart)) {
    const terms: Term[] = []
    for (const tok of group) {
      const t = parseTerm(tok)
      if (t === 'descendants') descendants = true
      else terms.push(t)
    }
    if (terms.length > 0) selectors.push(terms)
  }
  if (selectors.length === 0) throw new Error('対象（セレクタ）がありません')
  return { line: lineNo, raw: line, status, selectors, descendants }
}

export function parseTaskScript(raw: string): ParseResult {
  const text = raw.trim()
  if (!text) return { ok: false, error: '' }
  // JSON: [{ "title" | "id" | "match" | "tag": …, "status": … }]
  if (text.startsWith('[')) {
    try {
      const data = JSON.parse(text)
      if (!Array.isArray(data)) throw new Error('配列')
      const rules: ScriptRule[] = []
      data.forEach((n, i) => {
        if (!n || typeof n !== 'object') return
        const o = n as Record<string, unknown>
        const status = typeof o.status === 'string' ? parseStatusWord(o.status) : null
        if (!status) throw new Error(`${i + 1}件目: status が不明です`)
        const terms: Term[] = []
        if (typeof o.id === 'string' && o.id) terms.push({ kind: 'id', id: o.id })
        else if (typeof o.title === 'string' && o.title) terms.push({ kind: 'exact', title: o.title })
        else if (typeof o.match === 'string' && o.match) terms.push({ kind: 'text', re: globToRegex(o.match), raw: o.match })
        if (typeof o.tag === 'string' && o.tag) terms.push({ kind: 'tag', tag: o.tag.toLowerCase() })
        if (terms.length === 0) throw new Error(`${i + 1}件目: id / title / match / tag のいずれかが必要です`)
        rules.push({ line: i + 1, raw: JSON.stringify(n), status, selectors: [terms], descendants: o.children === true || o.descendants === true })
      })
      if (rules.length === 0) return { ok: false, error: 'JSON は有効ですがルールがありません' }
      return { ok: true, rules, source: 'JSON' }
    } catch (e) {
      return { ok: false, error: 'JSON を解釈できません: ' + (e instanceof Error ? e.message : String(e)) }
    }
  }
  const rules: ScriptRule[] = []
  const lines = raw.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line || line.startsWith('//') || /^#\s/.test(line) || line === '#') continue
    try { rules.push(parseRuleLine(line, i + 1)) }
    catch (e) { return { ok: false, error: `${i + 1}行目: ${e instanceof Error ? e.message : String(e)}`, line: i + 1 } }
  }
  if (rules.length === 0) return { ok: false, error: 'ルールがありません' }
  return { ok: true, rules, source: 'script' }
}

function termMatches(t: Term, task: Task): boolean {
  switch (t.kind) {
    case 'all': return true
    case 'id': return task.id === t.id
    case 'tag': return task.tags.some(x => x.toLowerCase() === t.tag)
    case 'exact': return task.title.trim() === t.title.trim()
    case 'regex': return t.re.test(task.title)
    case 'text': return t.re.test(task.title)
    case 'status': return task.status === t.status
    case 'priority': return task.priority === t.p
    case 'date': {
      const v = task[t.field]
      if (!v) return false
      switch (t.op) {
        case '<': return v < t.iso
        case '<=': return v <= t.iso
        case '>': return v > t.iso
        case '>=': return v >= t.iso
        default: return v === t.iso
      }
    }
  }
}

export function ruleMatches(rule: ScriptRule, task: Task): boolean {
  return rule.selectors.some(group => group.every(t => termMatches(t, task)))
}

// Evaluate every rule against the current tasks of `boards`. Later rules win
// when several hit the same task; unchanged statuses are dropped.
export function evaluateTaskScript(rules: ScriptRule[], boards: Project[]): ScriptResult {
  const matched = new Map<number, number>()
  const target = new Map<string, { projectId: string; boardName: string; task: Task; to: TaskStatus; line: number }>()
  for (const rule of rules) {
    let count = 0
    for (const board of boards) {
      const hit = new Set<string>()
      for (const task of board.tasks) {
        if (!ruleMatches(rule, task)) continue
        hit.add(task.id)
        if (rule.descendants) descendantIds(board.tasks, task.id).forEach(id => hit.add(id))
      }
      for (const task of board.tasks) {
        if (!hit.has(task.id)) continue
        count++
        target.set(task.id, { projectId: board.id, boardName: board.name, task, to: rule.status, line: rule.line })
      }
    }
    matched.set(rule.line, (matched.get(rule.line) ?? 0) + count)
  }
  const changes: ScriptChange[] = []
  for (const v of target.values()) {
    if (v.task.status === v.to) continue
    changes.push({ projectId: v.projectId, boardName: v.boardName, task: v.task, from: v.task.status, to: v.to, line: v.line })
  }
  return { changes, matched }
}

// AI prompt: the task inventory + the script grammar, so an assistant can write
// the script for the user ("設計系を全部完了に" etc.).
export function buildScriptPrompt(boards: Project[]): string {
  const lines: string[] = []
  for (const b of boards) {
    lines.push(`## ボード: ${b.name}`)
    for (const t of b.tasks) {
      const bits = [`[${STATUS_LABEL[t.status]}]`, t.title]
      if (t.tags.length) bits.push(t.tags.map(x => '#' + x).join(' '))
      if (t.endDate) bits.push(`期限 ${t.endDate}`)
      if (t.parentId) bits.push('(子)')
      bits.push(`id:${t.id}`)
      lines.push('- ' + bits.join(' '))
    }
  }
  return `以下はタスクの一覧です。私の指示に従って、状態をまとめて変更する「スクリプト」を出力してください。

${lines.join('\n')}

スクリプトの書き方（1行1ルール。応答はスクリプトのみ、コードフェンスや解説は不要）:
  状態: 対象, 対象, …        （例: 完了: 設計レビュー, "API 実装"）
  対象 -> 状態               （例: #backend @未着手 -> 進行中）
状態は 未着手 / 進行中 / 完了 の3つ。
対象の書き方:
  タイトルの一部（* でワイルドカード） / "タイトル完全一致" / /正規表現/ / id:ID
  #タグ / @未着手 @進行中 @完了（現在の状態） / 期限<今日 期限<=2026-10-01 開始>今日（日付） / P1〜P4（優先度）
  空白区切りは AND、カンマ区切りは OR。+子 を付けるとその子孫タスクも対象。* はすべてのタスク。
同じタスクに複数行が当たった場合は後の行が優先。id: は最も確実な指定方法です。

指示:
[ここに変更したい内容を書く]
`
}
