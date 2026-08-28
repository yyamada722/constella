// ── 3方向マージの共通コア ──
// 「作業ファイルの返却」(handoff.ts)と「同期フォルダの競合」(syncMerge.ts)は、
// どちらも base(共通祖先)/ mine(このPCの今)/ theirs(相手の版)を ID 単位で
// 突き合わせる同じ処理をしている。以前これが二重実装されていたため、片方だけに
// updatedAt の除外が入って「相手がノートを開いただけ」でニセ競合が出る、という
// 実害が発生した。分類ルール・揮発フィールド・並び順の扱いをここに一本化する。
//
// このモジュールは判定だけを行い、UI 向けの行の作り方や適用の段取りは
// 呼び出し側に委ねる(受け渡しと同期では見せ方も適用先も違うため)。
import type { AppState } from '../store'
import type { Project, Task } from '../types'

// ── 比較 ──

/** 比較用の安定シリアライズ(キー順を正規化、undefined は無視)。 */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']'
  const o = v as Record<string, unknown>
  const keys = Object.keys(o).filter(k => o[k] !== undefined).sort()
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(o[k])).join(',') + '}'
}

/**
 * 変更判定から外すフィールド。
 * - updatedAt: 内容が同じなら「変更なし」。開いて閉じただけで競合を出さない。
 * - pdf: カードの表示ページなど、作業内容ではない閲覧状態。
 */
export const VOLATILE_FIELDS = new Set(['updatedAt', 'pdf'])

function normalizeForCompare(x: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!x) return null
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(x)) if (!VOLATILE_FIELDS.has(k) && x[k] !== undefined) out[k] = x[k]
  return out
}

/** 比較キー。null/undefined は「存在しない」を表す固定値になる。 */
export function compareKey(x: unknown): string {
  const n = normalizeForCompare(x as Record<string, unknown> | null)
  return n == null ? '∅' : stableStringify(n)
}

// ── ストリーム定義 ──

export interface MergeStreamDef {
  /** AppState のキー。tasks だけは projects[].tasks をフラット化した擬似ストリーム。 */
  key: string
  typeLabel: string
  /** 表示名に使うフィールドを優先順に。 */
  labelFields: string[]
  /**
   * パックへの同梱が「参照されているか」で決まるコレクション。相手側に無い =
   * 削除の意思表示ではない(参照が外れただけでも落ちる)ので、削除は適用しない。
   *
   * **受け渡し(部分パック)専用のフラグ**。同期はDB丸ごとの比較なので、
   * ここで削除を無視すると相手が本当に消したフォルダ/ファイルが復活してしまう。
   * classifyStream の opts.partialPack が真のときだけ効く。
   */
  derivedByReference?: boolean
}

/** AppState の全 id コレクション。新しいコレクションを足したらここに1行足す。 */
export const MERGE_STREAMS: MergeStreamDef[] = [
  { key: 'masterProjects', typeLabel: 'プロジェクト', labelFields: ['name'] },
  { key: 'notes', typeLabel: 'ノート', labelFields: ['title'] },
  { key: 'noteFolders', typeLabel: 'ノートフォルダ', labelFields: ['name'], derivedByReference: true },
  { key: 'files', typeLabel: 'ファイル', labelFields: ['name'], derivedByReference: true },
  { key: 'fileFolders', typeLabel: 'ファイルフォルダ', labelFields: ['name'], derivedByReference: true },
  { key: 'research', typeLabel: 'リサーチ', labelFields: ['title'] },
  { key: 'researchFolders', typeLabel: 'リサーチフォルダ', labelFields: ['name'], derivedByReference: true },
  { key: 'sketches', typeLabel: 'スケッチ', labelFields: ['name'] },
  { key: 'flows', typeLabel: 'フロー', labelFields: ['name'] },
  { key: 'plans', typeLabel: '計画', labelFields: ['name'] },
  { key: 'planFolders', typeLabel: '計画フォルダ', labelFields: ['name'], derivedByReference: true },
  { key: 'timelineBands', typeLabel: '期間帯', labelFields: ['title'] },
  { key: 'aiConversations', typeLabel: 'AI会話', labelFields: ['title'] },
  { key: 'canvasBoards', typeLabel: 'キャンバスボード', labelFields: ['name'] },
  { key: 'canvasTabs', typeLabel: 'キャンバスタブ', labelFields: ['name'] },
  { key: 'canvasCards', typeLabel: 'カード', labelFields: ['title', 'content'] },
  { key: 'canvasArrows', typeLabel: '矢印', labelFields: ['label'] },
  { key: 'canvasGroups', typeLabel: 'グループ', labelFields: ['title'] },
  { key: 'canvasStrokes', typeLabel: '描き込み', labelFields: [] },
  { key: 'canvasLabels', typeLabel: 'ラベル', labelFields: ['text'] },
  { key: 'canvasRails', typeLabel: '路線', labelFields: ['name'] },
  { key: 'canvasStations', typeLabel: '駅', labelFields: ['name'] },
]

/** タスクボードのメタ(projects からタスクを外したもの)の擬似ストリーム。 */
export const PROJECTS_STREAM: MergeStreamDef = { key: 'projects', typeLabel: 'タスクボード', labelFields: ['name'] }
/** タスクをフラット化した擬似ストリーム。 */
export const TASKS_STREAM: MergeStreamDef = { key: 'tasks', typeLabel: 'タスク', labelFields: ['title'] }

export function streamLabel(def: MergeStreamDef, x: Record<string, unknown> | null | undefined): string {
  if (!x) return '(不明)'
  for (const f of def.labelFields) {
    const v = x[f]
    if (typeof v === 'string' && v.trim()) return v.slice(0, 40)
  }
  return def.labelFields.length ? '(無題)' : `(${def.typeLabel})`
}

// ── 分類 ──

export type MergeSide = 'theirs' | 'mine' | 'both'
export type MergeKind = 'added' | 'updated' | 'deleted' | 'both-edited' | 'they-edited-i-deleted' | 'they-deleted-i-edited'

export interface MergeEntry<T = Record<string, unknown>> {
  id: string
  /** どちら側の変更か。'both' は要選択。 */
  side: MergeSide
  kind: MergeKind
  base: T | null
  mine: T | null
  theirs: T | null
}

/**
 * 1コレクション分の3方向分類。判定のみで、適用も競合の解決もしない。
 *
 * - 相手も自分も base から変わっていない → 何も返さない
 * - 双方の結果が同一(同じ返却の再取り込み等) → 何も返さない
 * - 参照同梱コレクションで相手側だけが消えている → 削除ではないので何も返さない
 */
export function classifyStream<T extends { id: string }>(
  def: MergeStreamDef,
  baseArr: T[], mineArr: T[], theirsArr: T[],
  // partialPack: 相手の版が「選ばれた一部だけ」の場合(=受け渡しの返却)。
  // このときだけ derivedByReference の削除無視が働く。同期(DB丸ごと)では
  // 効かせてはいけない — 相手が本当に消したものが復活する。
  opts?: { partialPack?: boolean },
): MergeEntry<T>[] {
  const base = new Map(baseArr.map(x => [x.id, x]))
  const mine = new Map(mineArr.map(x => [x.id, x]))
  const theirs = new Map(theirsArr.map(x => [x.id, x]))
  const out: MergeEntry<T>[] = []
  for (const id of new Set<string>([...base.keys(), ...mine.keys(), ...theirs.keys()])) {
    const b = base.get(id) ?? null
    const m = mine.get(id) ?? null
    const t = theirs.get(id) ?? null
    const sb = compareKey(b), sm = compareKey(m), st = compareKey(t)
    const theyChanged = st !== sb
    const iChanged = sm !== sb
    if (!theyChanged && !iChanged) continue
    if (sm === st) continue
    if (!t && def.derivedByReference && opts?.partialPack) continue
    const side: MergeSide = theyChanged && iChanged ? 'both' : theyChanged ? 'theirs' : 'mine'
    const kind: MergeKind = side === 'both'
      ? (!m ? 'they-edited-i-deleted' : !t ? 'they-deleted-i-edited' : 'both-edited')
      : side === 'theirs'
        ? (!b ? 'added' : !t ? 'deleted' : 'updated')
        : (!b ? 'added' : !m ? 'deleted' : 'updated')
    out.push({ id, side, kind, base: b, mine: m, theirs: t })
  }
  return out
}

// ── 並び順 ──
// 配列順は各テーブルの ord 列として保存される実データ(タスクの並べ替え等)。
// id をキーにした比較では全項目が「同じ」に見えるので、別途拾う必要がある。

export interface OrderChange {
  /** 相手だけが並べ替えたか、両方が並べ替えたか。 */
  side: 'theirs' | 'both'
  /** 採用時に使う、相手側の id 並び。 */
  theirsIds: string[]
  count: number
}

export function detectOrderChange<T extends { id: string }>(
  baseArr: T[], mineArr: T[], theirsArr: T[],
): OrderChange | null {
  const inAll = (arr: T[], a: Set<string>, b: Set<string>): string[] =>
    arr.map(x => x.id).filter(id => a.has(id) && b.has(id))
  const baseIds = new Set(baseArr.map(x => x.id))
  const mineIds = new Set(mineArr.map(x => x.id))
  const theirsIds = new Set(theirsArr.map(x => x.id))
  // 3者すべてに存在する id だけで比較する(追加・削除による位置ずれを順序変更と
  // 誤検出しないため)。
  const common = (arr: T[]): string[] => inAll(arr, mineIds, theirsIds).filter(id => baseIds.has(id))
  const b = common(baseArr).join(','), m = common(mineArr).join(','), t = common(theirsArr).join(',')
  if (!b || t === m || t === b) return null
  return { side: m === b ? 'theirs' : 'both', theirsIds: theirsArr.map(x => x.id), count: common(theirsArr).length }
}

/** 相手の並びへ寄せる。相手に無い id(こちらだけの新規)は現在の相対順で末尾に残す。 */
export function applyOrder<T extends { id: string }>(arr: T[], theirsIds: string[]): T[] {
  const rank = new Map(theirsIds.map((id, i) => [id, i]))
  return [...arr].sort((x, y) => (rank.get(x.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(y.id) ?? Number.MAX_SAFE_INTEGER))
}

// ── 適用 ──

export interface IdChange<T = { id: string }> { id: string; item: T | null }

/** 配列に upsert / delete をまとめて適用する(既存の並びは保つ)。 */
export function applyChanges<T extends { id: string }>(arr: T[], changes: IdChange<T>[]): T[] {
  const next = [...arr]
  for (const { id, item } of changes) {
    const i = next.findIndex(x => x.id === id)
    if (item) { if (i >= 0) next[i] = item; else next.push(item) }
    else if (i >= 0) next.splice(i, 1)
  }
  return next
}

// ── タスクの入れ子 ↔ フラット ──
// tasks は projects[].tasks に入れ子だが、粒度を保つためフラット化してマージする。

export interface FlatTask extends Task { __projectId: string }

export const flattenTasks = (projects: Project[]): FlatTask[] =>
  projects.flatMap(p => p.tasks.map(t => ({ ...t, __projectId: p.id })))

export const stripTasks = (projects: Project[]): (Omit<Project, 'tasks'> & { id: string })[] =>
  projects.map(({ tasks: _tasks, ...meta }) => meta)

export function rebuildProjects(
  metas: Omit<Project, 'tasks'>[],
  flat: FlatTask[],
  mineProjects: Project[],
  // flat が既に望みの順で並んでいる場合(相手の並び順を採用したとき)に true。
  // 既定では「自分側の並び」に寄せ直すので、それだと採用した並びが打ち消される。
  flatIsOrdered = false,
): Project[] {
  const byProject = new Map<string, Task[]>()
  const metaIds = new Set(metas.map(m => m.id))
  const order = new Map<string, number>()
  mineProjects.forEach(p => p.tasks.forEach((t, i) => order.set(t.id, i)))
  const sorted = flatIsOrdered ? flat : [...flat].sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9))
  for (const ft of sorted) {
    if (!metaIds.has(ft.__projectId)) continue // 親ボードごと消えた → タスクも消える
    const { __projectId, ...task } = ft
    const list = byProject.get(__projectId) ?? []
    list.push(task)
    byProject.set(__projectId, list)
  }
  return metas.map(m => ({ ...m, tasks: byProject.get(m.id) ?? [] })) as Project[]
}

/** AppState のうち、この共通コアが扱う id コレクションのキー一覧。 */
export const MERGE_STREAM_KEYS: (keyof AppState)[] = MERGE_STREAMS.map(s => s.key as keyof AppState)
