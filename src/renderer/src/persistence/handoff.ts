// ── 作業ファイル(受け渡し) ──
// DCC ツールのシーンファイルのように、選択した作業単位(ノートフォルダ/タスク
// ボード/キャンバスボード/フロー/計画…)を自己完結の単一 JSON に書き出して他人に
// 渡し、相手の Constella で作業を続けてもらい、返却ファイルを取り込む。
//
// 並行編集を成立させる仕掛け: 書き出した時点のスナップショット(base)を
// 自分側の app_kv に控えておき、返却時に base / 自分の今 / 相手の版 の
// **3方向マージ**を ID 単位で行う。DB 側に updatedAt や tombstone が無くても、
// base が共通祖先になるので「相手が変えた/自分が変えた/両方変えた(競合)」を
// 機械的に判定できる。競合だけユーザーに選ばせる(既定は相手の版)。
//
//   自分:  書き出し ──ファイル──▶ 相手: 取り込み(専用プロジェクトとして追加)
//   自分:  そのまま編集を継続        相手: 作業して「返却ファイルを書き出し」
//   自分:  返却を取り込み → 3方向マージ(1 undo ステップ) ◀──ファイル──
import type { AppState } from '../store'
import { collectMediaRefs } from '../store'
import type {
  Note, NoteFolder, FileItem, FileFolder, Project, Task, ResearchItem, ResearchFolder,
  MasterProject, Sketch, Flow, Plan, PlanFolder,
  CanvasBoard, CanvasTab, CanvasCard, CanvasArrow, CanvasGroup, CanvasStroke, CanvasLabel, CanvasRail, CanvasStation,
} from '../types'
import { loadKv, saveKv } from './db'
import { settleLocalWrites } from './folderSync'
import {
  stableStringify, compareKey, classifyStream, streamLabel,
  flattenTasks, stripTasks, rebuildProjects,
  MERGE_STREAMS, PROJECTS_STREAM, TASKS_STREAM,
  type FlatTask, type MergeStreamDef, type ChangeOp,
} from './merge'
import { getMediaBlob, importMedia, MEDIA_PREFIX } from './media'
import { markFolderSyncEdit } from './folderSync'
import { generateId } from '../utils'

// ── フォーマット ──

export interface PackItems {
  notes: Note[]
  noteFolders: NoteFolder[]
  files: FileItem[]
  fileFolders: FileFolder[]
  projects: Project[]
  research: ResearchItem[]
  researchFolders: ResearchFolder[]
  sketches: Sketch[]
  flows: Flow[]
  plans: Plan[]
  planFolders: PlanFolder[]
  canvasBoards: CanvasBoard[]
  canvasTabs: CanvasTab[]
  canvasCards: CanvasCard[]
  canvasArrows: CanvasArrow[]
  canvasGroups: CanvasGroup[]
  canvasStrokes: CanvasStroke[]
  canvasLabels: CanvasLabel[]
  canvasRails: CanvasRail[]
  canvasStations: CanvasStation[]
}

export const EMPTY_ITEMS: PackItems = {
  notes: [], noteFolders: [], files: [], fileFolders: [], projects: [], research: [], researchFolders: [],
  sketches: [], flows: [], plans: [], planFolders: [],
  canvasBoards: [], canvasTabs: [], canvasCards: [], canvasArrows: [], canvasGroups: [],
  canvasStrokes: [], canvasLabels: [], canvasRails: [], canvasStations: [],
}

export interface HandoffPack {
  app: 'constella-pack'
  version: 1
  kind: 'handoff' | 'return'
  handoffId: string
  name: string
  exportedAt: string
  sourceMasterId: string // 書き出し元(自分)のマスタープロジェクト id — 返却時の帰属先
  items: PackItems
  media: Record<string, string> // idb id -> dataURL
  mediaOmitted?: string[] // 動画除外などで同梱しなかった id(相手側では欠落表示)
}

// ── app_kv の台帳 ──
// handoff.index         … 自分が貸し出した一覧 [{id,name,exportedAt,returnedAt?}]
// handoff.base.<id>     … 貸出時スナップショット {sourceMasterId, items}
// handoff.recv.index    … 受け取った一覧 [{handoffId,masterId,name,sourceMasterId,receivedAt}]

export interface HandoffIndexEntry { id: string; name: string; exportedAt: string; returnedAt?: string }
export interface RecvIndexEntry {
  handoffId: string
  masterId: string
  name: string
  sourceMasterId: string
  receivedAt: string
  /**
   * 取り込み時に ID 衝突で振り直した対応(新 id → 元 id)。返却時にこれで元へ戻す。
   * 戻さないと、貸出側のマージが「元 id は削除・新 id は追加」と解釈し、
   * パック外からその項目を参照していた箇所が壊れる。
   */
  idMap?: Record<string, string>
  /**
   * 仮受領記録の印。コミット前に書かれ、本記録(idMap 確定済み)への差し替えで
   * 消える。これが残っている受け取りは idMap が失われている可能性があるため、
   * 返却の書き出しを拒否する(貸出側のマージを壊さないため)。
   */
  provisional?: boolean
}

// 台帳の読み取り: DB エラー(読み取り自体の失敗)は投げる — 「空の台帳」と
// 解釈すると、その後の保存が台帳ごと上書きして過去の記録を全て消してしまう。
// 空扱いにしてよいのは、値が壊れた JSON だった場合だけ。
export async function loadHandoffIndex(): Promise<HandoffIndexEntry[]> {
  const raw = await loadKv('handoff.index')
  try { return JSON.parse(raw || '[]') } catch { return [] }
}
export async function loadRecvIndex(): Promise<RecvIndexEntry[]> {
  const raw = await loadKv('handoff.recv.index')
  try { return JSON.parse(raw || '[]') } catch { return [] }
}

// ── 選択 → サブセット抽出 ──

export interface HandoffSelection {
  noteFolderIds: Set<string>
  noteIds: Set<string>
  projectIds: Set<string> // タスクボード
  canvasBoardIds: Set<string>
  canvasTabIds: Set<string> // ボードなしのタブ
  flowIds: Set<string>
  planIds: Set<string>
  researchFolderIds: Set<string>
  researchIds: Set<string>
  sketchIds: Set<string>
}

export function emptySelection(): HandoffSelection {
  return {
    noteFolderIds: new Set(), noteIds: new Set(), projectIds: new Set(),
    canvasBoardIds: new Set(), canvasTabIds: new Set(), flowIds: new Set(),
    planIds: new Set(), researchFolderIds: new Set(), researchIds: new Set(), sketchIds: new Set(),
  }
}

// フォルダ選択は配下(子孫フォルダ+中身)を丸ごと含む。
function descendantFolderIds(all: { id: string; parentId?: string }[], rootIds: Set<string>): Set<string> {
  const out = new Set(rootIds)
  let grew = true
  while (grew) {
    grew = false
    for (const f of all) {
      if (f.parentId && out.has(f.parentId) && !out.has(f.id)) { out.add(f.id); grew = true }
    }
  }
  return out
}

// 選択された項目がリンクしている実体(ノート/スケッチ/計画)を選択に足す。
// 参照が増えても新たな参照は生まないので、1周で安定する。
function expandLinkedSelection(state: AppState, sel: HandoffSelection): HandoffSelection {
  const next: HandoffSelection = {
    ...sel,
    noteIds: new Set(sel.noteIds),
    sketchIds: new Set(sel.sketchIds),
    planIds: new Set(sel.planIds),
  }
  const noteFolderIds = descendantFolderIds(state.noteFolders, sel.noteFolderIds)
  const inPack = (n: { id: string; folderId?: string }): boolean =>
    next.noteIds.has(n.id) || !!(n.folderId && noteFolderIds.has(n.folderId))

  // タスクの「関連ノート」
  for (const p of state.projects) {
    if (!sel.projectIds.has(p.id)) continue
    for (const t of p.tasks) for (const id of t.linkedNoteIds ?? []) next.noteIds.add(id)
  }
  // 同梱されるキャンバスタブ上のカードが指す実体
  const boardIds = new Set(state.canvasBoards.filter(b => sel.canvasBoardIds.has(b.id)).map(b => b.id))
  const tabIds = new Set(state.canvasTabs.filter(t => (t.boardId && boardIds.has(t.boardId)) || sel.canvasTabIds.has(t.id)).map(t => t.id))
  for (const c of state.canvasCards) {
    if (!tabIds.has(c.tabId)) continue
    if (c.refNoteId) next.noteIds.add(c.refNoteId)
    if (c.refSketchId) next.sketchIds.add(c.refSketchId)
    if (c.refPlanId) next.planIds.add(c.refPlanId)
  }
  // 引き込んだノートがさらに参照するもの(添付ファイルは buildPackItems 側が拾う)
  for (const n of state.notes) if (inPack(n)) next.noteIds.add(n.id)
  // 実在しない id は落とす(削除済みへのリンクが残っているケース)
  const drop = <T,>(s: Set<string>, all: { id: string }[]): Set<string> => {
    const ids = new Set(all.map(x => x.id))
    return new Set([...s].filter(x => ids.has(x))) as Set<string> & T
  }
  next.noteIds = drop(next.noteIds, state.notes)
  next.sketchIds = drop(next.sketchIds, state.sketches)
  next.planIds = drop(next.planIds, state.plans)
  return next
}

// 選択アイテムの親フォルダ鎖(先祖)も同梱 — 相手側でフォルダ参照が宙に浮かないように。
function ancestorFolders<T extends { id: string; parentId?: string }>(all: T[], fromIds: Iterable<string | undefined>): Set<string> {
  const byId = new Map(all.map(f => [f.id, f]))
  const out = new Set<string>()
  for (let id of fromIds) {
    while (id && byId.has(id) && !out.has(id)) { out.add(id); id = byId.get(id)!.parentId }
  }
  return out
}

/**
 * 選択から自己完結のサブセットを作る(参照ファイル・親フォルダは自動同梱)。
 *
 * タスクの linkedNoteIds やカードの refNoteId/refSketchId/refPlanId が指す実体も
 * 引き込む — これらを落とすと相手側でリンクが宙に浮き、「自己完結」ではなくなる。
 * refTabId(別キャンバスへのジャンプ)と refTaskId は、辿ると別ボードを丸ごと
 * 引き込みかねないので対象外(相手側では参照先なしとして表示される)。
 */
export function buildPackItems(state: AppState, sel: HandoffSelection): PackItems {
  sel = expandLinkedSelection(state, sel)
  const noteFolderIds = descendantFolderIds(state.noteFolders, sel.noteFolderIds)
  const notes = state.notes.filter(n => sel.noteIds.has(n.id) || (n.folderId && noteFolderIds.has(n.folderId)))
  for (const id of ancestorFolders(state.noteFolders, notes.map(n => n.folderId))) noteFolderIds.add(id)

  const researchFolderIds = descendantFolderIds(state.researchFolders, sel.researchFolderIds)
  const research = state.research.filter(r => sel.researchIds.has(r.id) || (r.folderId && researchFolderIds.has(r.folderId)))
  for (const id of ancestorFolders(state.researchFolders, research.map(r => r.folderId))) researchFolderIds.add(id)

  const projects = state.projects.filter(p => sel.projectIds.has(p.id))
  const flows = state.flows.filter(f => sel.flowIds.has(f.id))
  const plans = state.plans.filter(p => sel.planIds.has(p.id))
  const planFolderIds = ancestorFolders(state.planFolders, plans.map(p => p.folderId))
  const sketches = state.sketches.filter(s => sel.sketchIds.has(s.id))

  const canvasBoards = state.canvasBoards.filter(b => sel.canvasBoardIds.has(b.id))
  const boardIds = new Set(canvasBoards.map(b => b.id))
  const canvasTabs = state.canvasTabs.filter(t => (t.boardId && boardIds.has(t.boardId)) || sel.canvasTabIds.has(t.id))
  const tabIds = new Set(canvasTabs.map(t => t.id))
  const inTab = <T extends { tabId: string }>(arr: T[]): T[] => arr.filter(x => tabIds.has(x.tabId))

  // 参照しているファイルライブラリ項目を自動同梱(ノート添付・タスク添付・
  // キャンバスのファイル参照カード)。
  const fileIds = new Set<string>()
  notes.forEach(n => n.attachments?.forEach(a => { if (a.fileId) fileIds.add(a.fileId) }))
  projects.forEach(p => p.tasks.forEach(t => t.fileIds?.forEach(id => fileIds.add(id))))
  const canvasCards = inTab(state.canvasCards)
  canvasCards.forEach(c => { if (c.refFileId) fileIds.add(c.refFileId) })
  const files = state.files.filter(f => fileIds.has(f.id))
  const fileFolderIds = ancestorFolders(state.fileFolders, files.map(f => f.folderId))

  return {
    notes,
    noteFolders: state.noteFolders.filter(f => noteFolderIds.has(f.id)),
    files,
    fileFolders: state.fileFolders.filter(f => fileFolderIds.has(f.id)),
    projects,
    research,
    researchFolders: state.researchFolders.filter(f => researchFolderIds.has(f.id)),
    sketches, flows, plans,
    planFolders: state.planFolders.filter(f => planFolderIds.has(f.id)),
    canvasBoards, canvasTabs, canvasCards,
    canvasArrows: inTab(state.canvasArrows),
    canvasGroups: inTab(state.canvasGroups),
    canvasStrokes: inTab(state.canvasStrokes),
    canvasLabels: inTab(state.canvasLabels),
    canvasRails: inTab(state.canvasRails),
    canvasStations: inTab(state.canvasStations),
  }
}

export function packItemCount(items: PackItems): number {
  return (Object.values(items) as unknown[][]).reduce((n, arr) => n + arr.length, 0)
}

// ── メディア同梱 ──

function blobToDataUrl(blob: Blob): Promise<string | null> {
  return new Promise(resolve => {
    const fr = new FileReader()
    fr.onloadend = () => resolve(typeof fr.result === 'string' ? fr.result : null)
    fr.onerror = () => resolve(null)
    fr.readAsDataURL(blob)
  })
}

async function collectPackMedia(items: PackItems, excludeVideos: boolean): Promise<{ media: Record<string, string>; omitted: string[] }> {
  // collectMediaRefs は AppState 全体を見る規則なので、サブセットを空の状態に
  // 重ねた擬似 state に対して同じ規則を適用する(取りこぼし・重複ロジックを防ぐ)。
  const pseudo = { masterProjects: [], activeMasterProjectId: '', timelineBands: [], aiConversations: [], ...EMPTY_ITEMS, ...items } as unknown as AppState
  const ids = new Set<string>()
  for (const r of collectMediaRefs(pseudo)) if (r && r.startsWith(MEDIA_PREFIX)) ids.add(r.slice(MEDIA_PREFIX.length))
  const media: Record<string, string> = {}
  const omitted: string[] = []
  for (const id of ids) {
    try {
      const blob = await getMediaBlob(MEDIA_PREFIX + id)
      if (!blob) { omitted.push(id); continue }
      if (excludeVideos && blob.type.startsWith('video/')) { omitted.push(id); continue }
      const url = await blobToDataUrl(blob)
      if (url) media[id] = url
      else omitted.push(id)
    } catch { omitted.push(id) }
  }
  return { media, omitted }
}

function downloadJson(obj: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(obj)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

const fileStamp = (): string => new Date().toISOString().slice(0, 10)
const safeName = (s: string): string => (s || '作業ファイル').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40)

// ── 書き出し(貸出) ──

/** 選択を単一ファイルに書き出し、base スナップショットを控える。 */
export async function exportHandoff(state: AppState, sel: HandoffSelection, name: string, excludeVideos: boolean): Promise<HandoffPack> {
  const items = buildPackItems(state, sel)
  if (packItemCount(items) === 0) throw new Error('書き出す項目が選択されていません')
  const { media, omitted } = await collectPackMedia(items, excludeVideos)
  const handoffId = generateId()
  const pack: HandoffPack = {
    app: 'constella-pack', version: 1, kind: 'handoff',
    handoffId, name, exportedAt: new Date().toISOString(),
    sourceMasterId: state.activeMasterProjectId,
    items, media, ...(omitted.length ? { mediaOmitted: omitted } : {}),
  }
  // base(共通祖先)はメディア抜きで控える — 返却マージの比較にはデータだけで足りる。
  await saveKv(`handoff.base.${handoffId}`, JSON.stringify({ sourceMasterId: pack.sourceMasterId, items }))
  const index = await loadHandoffIndex()
  index.unshift({ id: handoffId, name, exportedAt: pack.exportedAt })
  await saveKv('handoff.index', JSON.stringify(index.slice(0, 30)))
  // base は他マシン同期にも乗せる(貸出記録は編集と同じ扱いで push させる)。
  markFolderSyncEdit()
  downloadJson(pack, `constella-pack-${safeName(name)}-${fileStamp()}.json`)
  return pack
}

// ── 取り込み(受領側) ──

export function parsePack(text: string): HandoffPack {
  let raw: Partial<HandoffPack>
  try { raw = JSON.parse(text) } catch { throw new Error('作業ファイルとして読み取れません') }
  if (raw.app !== 'constella-pack' || !raw.items || !raw.handoffId) throw new Error('Constella の作業ファイルではありません')
  if ((raw.version ?? 0) > 1) throw new Error('このファイルは新しいバージョンの Constella で作成されています。アプリを更新してください')
  return { ...raw, items: { ...EMPTY_ITEMS, ...raw.items }, media: raw.media ?? {} } as HandoffPack
}

// あるマスター配下として items を帰属し直す(受領時: 自分側の新プロジェクトへ /
// 返却書き出し時: 元のマスターへ)。
function reparentItems(items: PackItems, masterId: string): PackItems {
  const re = <T extends { masterProjectId: string }>(arr: T[]): T[] => arr.map(x => ({ ...x, masterProjectId: masterId }))
  // 他プロジェクトへの共有参照は**送り手のマスターID**で記録されている。
  // DEFAULT_MASTER_ID('master-default')は全インストールで同一なので、そのまま
  // 渡すと受領側の無関係なプロジェクトに他人のノートが実体参照として現れ、
  // そこでの編集が単一ソースへ書き戻ってしまう。受け渡し先では共有を解いて持つ。
  const unshare = <T extends { shared?: boolean; refByMasterIds?: string[] }>(arr: T[]): T[] =>
    arr.map(({ shared: _shared, refByMasterIds: _refs, ...rest }) => rest as unknown as T)
  const unlink = <T extends { linkedMasterIds?: string[] }>(arr: T[]): T[] =>
    arr.map(({ linkedMasterIds: _linked, ...rest }) => rest as unknown as T)
  return {
    ...items,
    notes: unshare(re(items.notes)),
    noteFolders: re(items.noteFolders),
    files: unlink(re(items.files)),
    fileFolders: re(items.fileFolders),
    projects: re(items.projects),
    research: re(items.research),
    researchFolders: re(items.researchFolders),
    sketches: re(items.sketches),
    flows: re(items.flows),
    plans: re(items.plans),
    planFolders: re(items.planFolders),
    canvasBoards: items.canvasBoards.map(b => ({ ...b, projectId: masterId })),
    canvasTabs: items.canvasTabs.map(t => ({ ...t, projectId: masterId })),
  }
}

// 受領側の既存データと id が衝突する項目を、参照ごと新しい id に振り直す。
// 実運用の id はランダム生成なのでまず衝突しないが、初期サンプルデータの固定 id
// ('1' など)を双方が持っているケースが現実に起こり得る。振り直した項目は返却時に
// 元の id と一致しなくなる(貸出側では「削除+追加」として現れる)が、データは失わない。
function remapCollidingIds(state: AppState, items: PackItems): { items: PackItems; map: Map<string, string> } {
  const existing = new Set<string>()
  const collect = (arr: { id: string }[]): void => arr.forEach(x => existing.add(x.id))
  for (const key of Object.keys(EMPTY_ITEMS) as (keyof PackItems)[]) collect(state[key] as { id: string }[])
  state.projects.forEach(p => p.tasks.forEach(t => existing.add(t.id)))

  const map = new Map<string, string>()
  const claim = (id: string): void => { if (existing.has(id) && !map.has(id)) map.set(id, generateId()) }
  for (const key of Object.keys(EMPTY_ITEMS) as (keyof PackItems)[]) (items[key] as { id: string }[]).forEach(x => claim(x.id))
  items.projects.forEach(p => p.tasks.forEach(t => claim(t.id)))
  if (map.size === 0) return { items, map }
  return { items: applyIdMap(items, map), map }
}

/** 与えられた対応表(旧 id → 新 id)で、参照フィールドまで含めて id を置き換える。 */
function applyIdMap(items: PackItems, map: Map<string, string>): PackItems {
  const r = (id: string | undefined): string | undefined => (id ? map.get(id) ?? id : id)
  const rq = (id: string): string => map.get(id) ?? id
  const rArr = (ids: string[] | undefined): string[] | undefined => ids?.map(rq)
  return {
    notes: items.notes.map(n => ({ ...n, id: rq(n.id), folderId: r(n.folderId), attachments: n.attachments?.map(a => ({ ...a, fileId: rq(a.fileId) })) })),
    noteFolders: items.noteFolders.map(f => ({ ...f, id: rq(f.id), parentId: r(f.parentId) })),
    files: items.files.map(f => ({ ...f, id: rq(f.id), folderId: r(f.folderId) })),
    fileFolders: items.fileFolders.map(f => ({ ...f, id: rq(f.id), parentId: r(f.parentId) })),
    projects: items.projects.map(p => ({
      ...p, id: rq(p.id),
      tasks: p.tasks.map(t => ({ ...t, id: rq(t.id), parentId: r(t.parentId), linkedNoteIds: rArr(t.linkedNoteIds), fileIds: rArr(t.fileIds) })),
    })),
    research: items.research.map(x => ({ ...x, id: rq(x.id), folderId: r(x.folderId) })),
    researchFolders: items.researchFolders.map(f => ({ ...f, id: rq(f.id), parentId: r(f.parentId) })),
    sketches: items.sketches.map(s => ({ ...s, id: rq(s.id) })),
    flows: items.flows.map(f => ({ ...f, id: rq(f.id), nodes: (f.nodes ?? []).map(n => ({ ...n, taskId: r(n.taskId), boardId: r(n.boardId) })) })),
    plans: items.plans.map(p => ({ ...p, id: rq(p.id), folderId: r(p.folderId) })),
    planFolders: items.planFolders.map(f => ({ ...f, id: rq(f.id), parentId: r(f.parentId) })),
    canvasBoards: items.canvasBoards.map(b => ({ ...b, id: rq(b.id) })),
    canvasTabs: items.canvasTabs.map(t => ({ ...t, id: rq(t.id), boardId: r(t.boardId) })),
    canvasCards: items.canvasCards.map(c => ({
      ...c, id: rq(c.id), tabId: rq(c.tabId), stationId: r(c.stationId),
      refNoteId: r(c.refNoteId), refTaskId: r(c.refTaskId), refSketchId: r(c.refSketchId),
      refTabId: r(c.refTabId), refPlanId: r(c.refPlanId), refFileId: r(c.refFileId),
    })),
    canvasArrows: items.canvasArrows.map(a => ({ ...a, id: rq(a.id), tabId: rq(a.tabId), fromCardId: r(a.fromCardId), toCardId: r(a.toCardId) })),
    canvasGroups: items.canvasGroups.map(g => ({ ...g, id: rq(g.id), tabId: rq(g.tabId) })),
    canvasStrokes: items.canvasStrokes.map(s => ({ ...s, id: rq(s.id), tabId: rq(s.tabId) })),
    canvasLabels: items.canvasLabels.map(l => ({ ...l, id: rq(l.id), tabId: rq(l.tabId) })),
    canvasRails: items.canvasRails.map(x => ({ ...x, id: rq(x.id), tabId: rq(x.tabId), stationIds: rArr(x.stationIds) ?? [] })),
    canvasStations: items.canvasStations.map(s => ({ ...s, id: rq(s.id), tabId: rq(s.tabId) })),
  }
}

/**
 * 【prepare・非同期】受領の下ごしらえ: 台帳を読み、メディアを先に取り込む。
 * メディアは追加専用なので state に先行して入れても安全(コミットが中止されても
 * 未参照 blob は sweep の7日猶予で回収される)。
 */
export async function prepareReceive(pack: HandoffPack): Promise<{ recv: RecvIndexEntry[] }> {
  const recv = await loadRecvIndex()
  await importMedia(pack.media)
  return { recv }
}

/**
 * 【prepare②・非同期】コミットの前に「仮の受領記録」を書く。台帳を書けない状態
 * (DBエラー等)なら取り込み自体を始めない — コミット後に台帳だけ失敗すると、
 * 記録の無いプロジェクトが残って返却を書き出せず、再取り込みで重複もする。
 * 仮記録は idMap を持たないだけの有効な記録なので、後段(finalize)が失敗しても
 * プロジェクトと記録の対応は保たれる。コミット前に中断した場合は「プロジェクトの
 * 無い記録」となり、既存の stale 判定が次回の取り込みで自動的に掃除する。
 */
/** 仮受領記録を取り消す(コミットが中止されたとき用)。 */
export async function rollbackProvisionalReceipt(recv: RecvIndexEntry[]): Promise<void> {
  await saveKv('handoff.recv.index', JSON.stringify(recv))
}

export async function writeProvisionalReceipt(
  pack: HandoffPack,
  masterId: string,
  recv: RecvIndexEntry[],
): Promise<void> {
  // ここでは件数を切り詰めない(一時的に 31 件になってよい)。仮記録の書き込みで
  // 最古の正規の記録を追い出すと、コミット中止+ロールバック失敗の場合に
  // 無関係な記録だけが失われる。切り詰めは本記録(finalizeReceive)側で行う。
  const ledger = [
    { handoffId: pack.handoffId, masterId, name: pack.name, sourceMasterId: pack.sourceMasterId, receivedAt: new Date().toISOString(), provisional: true },
    ...recv,
  ]
  await saveKv('handoff.recv.index', JSON.stringify(ledger))
}

/**
 * 【commit・同期】受領を「今」の状態に対して組み立てる。commitSync の同期ブロック
 * 内から呼ぶこと — 重複チェックも ID 衝突のリマップも now に対して行うので、
 * prepare の await 中に入った編集(Ctrl+Z による復活を含む)と矛盾しない。
 * 重複取り込みは throw する(commitSync は dispatch せずそのまま伝播させる)。
 */
export function buildReceiveCommit(
  now: AppState,
  pack: HandoffPack,
  recv: RecvIndexEntry[],
  masterId: string,
): { patch: Partial<AppState>; result: { master: MasterProject; ledger: RecvIndexEntry[] } } {
  // 取り込みは undo できるが台帳は履歴の外にあるため、「台帳にはあるがプロジェクトが
  // 無い」= 取り込みを取り消した/削除した状態になりうる。その場合は再取り込みを許す
  // (でないと undo した瞬間に、そのファイルを二度と開けなくなる)。
  const stale = recv.filter(r => r.handoffId === pack.handoffId && !now.masterProjects.some(m => m.id === r.masterId))
  const live = recv.filter(r => r.handoffId === pack.handoffId && now.masterProjects.some(m => m.id === r.masterId))
  if (live.length > 0) {
    // 仮記録のまま残っている場合は前回の取り込みが記録を確定できなかったケース。
    // 再起動後は Ctrl+Z で戻せないので、プロジェクトの削除→再取り込みの
    // 回復手順を具体的に案内する(削除すれば stale 判定が記録を掃除して通る)。
    throw new Error(live.some(r => r.provisional)
      ? `この作業ファイル(${pack.name})は前回の取り込みで記録を確定できていません。取り込まれたプロジェクト(📦 ${pack.name})を削除してから、もう一度取り込んでください`
      : `この作業ファイル(${pack.name})は既に取り込み済みです。返却を受け取る側の場合は、元のマシンで取り込んでください`)
  }
  const kept = stale.length > 0 ? recv.filter(r => !stale.includes(r)) : recv
  const master: MasterProject = { id: masterId, name: `📦 ${pack.name}`, createdAt: new Date().toISOString() }
  const remap = remapCollidingIds(now, pack.items)
  const items = reparentItems(remap.items, master.id)
  const patch: Partial<AppState> = {
    masterProjects: [...now.masterProjects, master],
    activeMasterProjectId: master.id,
  }
  for (const key of Object.keys(EMPTY_ITEMS) as (keyof PackItems)[]) {
    // 既存配列の後ろに連結。id は元のまま維持する(返却マージの前提)。
    ;(patch as Record<string, unknown[]>)[key] = [...(now[key] as unknown[]), ...(items[key] as unknown[])]
  }
  // 逆引き(新 id → 元 id)を控える。返却時にこれで元の id へ戻さないと、貸出側の
  // マージが「元 id は削除・新 id は追加」と解釈してパック外の参照を壊す。
  const idMap: Record<string, string> = {}
  for (const [orig, next] of remap.map) idMap[next] = orig
  const ledger = [
    {
      handoffId: pack.handoffId, masterId: master.id, name: pack.name,
      sourceMasterId: pack.sourceMasterId, receivedAt: new Date().toISOString(),
      ...(Object.keys(idMap).length ? { idMap } : {}),
    },
    ...kept,
  ].slice(0, 30)
  return { patch, result: { master, ledger } }
}

/** 【finalize・非同期】受領台帳を書く(コミット済みの結果を永続化するだけ)。 */
export async function finalizeReceive(ledger: RecvIndexEntry[]): Promise<void> {
  // 本記録を書く前に、コミット済みの state(取り込んだプロジェクト)をディスクへ
  // 確定させる。逆順だと、ここでクラッシュした場合に「本記録あり・プロジェクト
  // なし」になる(stale 掃除で直るが、常に安全な順にしておく)。確定できなければ
  // 本記録も見送る — 仮記録が生きているので取り込み自体は成立している。
  if (!(await settleLocalWrites())) throw new Error('保存に失敗しました')
  await saveKv('handoff.recv.index', JSON.stringify(ledger))
}

/** 受領側: 受け取ったプロジェクトを丸ごと「返却ファイル」として書き出す。 */
export async function exportReturn(state: AppState, entry: RecvIndexEntry, excludeVideos: boolean): Promise<void> {
  if (entry.provisional) {
    // 本記録(idMap)を書けないまま終わった受け取り。ID を振り直していた場合、
    // このまま返すと貸出側のマージが「元は削除・別物を追加」と解釈して壊れる。
    throw new Error('この受け取りは取り込み記録を確定できていません。Ctrl+Z で取り込みを取り消してから、作業ファイルをもう一度取り込んでください(再起動後などで Ctrl+Z が使えない場合は、このプロジェクトを削除してから取り込み直してください)')
  }
  // 受け取ったプロジェクト配下の全ユニットを選択したのと同じ扱いで抽出する。
  const sel = emptySelection()
  state.noteFolders.forEach(f => { if (f.masterProjectId === entry.masterId && !f.parentId) sel.noteFolderIds.add(f.id) })
  state.notes.forEach(n => { if (n.masterProjectId === entry.masterId) sel.noteIds.add(n.id) })
  state.projects.forEach(p => { if (p.masterProjectId === entry.masterId) sel.projectIds.add(p.id) })
  state.canvasBoards.forEach(b => { if (b.projectId === entry.masterId) sel.canvasBoardIds.add(b.id) })
  state.canvasTabs.forEach(t => { if (t.projectId === entry.masterId && !t.boardId) sel.canvasTabIds.add(t.id) })
  state.flows.forEach(f => { if (f.masterProjectId === entry.masterId) sel.flowIds.add(f.id) })
  state.plans.forEach(p => { if (p.masterProjectId === entry.masterId) sel.planIds.add(p.id) })
  state.researchFolders.forEach(f => { if (f.masterProjectId === entry.masterId && !f.parentId) sel.researchFolderIds.add(f.id) })
  state.research.forEach(r => { if (r.masterProjectId === entry.masterId) sel.researchIds.add(r.id) })
  state.sketches.forEach(s => { if (s.masterProjectId === entry.masterId) sel.sketchIds.add(s.id) })
  // ID衝突で振り直していた場合は元の id へ戻してから返す(貸出側のマージが
  // 「元 id は削除・新 id は追加」と解釈してパック外の参照を壊さないように)。
  const inverse = new Map(Object.entries(entry.idMap ?? {}))
  const packed = buildPackItems(state, sel)
  const items = reparentItems(inverse.size ? applyIdMap(packed, inverse) : packed, entry.sourceMasterId)
  const { media, omitted } = await collectPackMedia(items, excludeVideos)
  const pack: HandoffPack = {
    app: 'constella-pack', version: 1, kind: 'return',
    handoffId: entry.handoffId, name: entry.name, exportedAt: new Date().toISOString(),
    sourceMasterId: entry.sourceMasterId,
    items, media, ...(omitted.length ? { mediaOmitted: omitted } : {}),
  }
  downloadJson(pack, `constella-return-${safeName(entry.name)}-${fileStamp()}.json`)
}

// ── 返却の 3方向マージ(貸出側) ──

export interface MergeConflict {
  key: string // "<stream>:<id>"
  typeLabel: string
  label: string
  kind: 'both-edited' | 'they-edited-i-deleted' | 'they-deleted-i-edited'
  resolution: 'theirs' | 'mine'
}

const KIND_MAP: Record<string, MergeConflict['kind']> = {
  'both-edited': 'both-edited',
  'they-edited-i-deleted': 'they-edited-i-deleted',
  'they-deleted-i-edited': 'they-deleted-i-edited',
}

// パックに載るコレクションだけを共通レジストリから引く(順序も揃う)。
const STREAMS: { [K in keyof PackItems]?: MergeStreamDef } = Object.fromEntries(
  MERGE_STREAMS.filter(d => d.key in EMPTY_ITEMS).map(d => [d.key, d]),
) as { [K in keyof PackItems]?: MergeStreamDef }

export interface PendingMerge {
  pack: HandoffPack
  /** 相手だけが変えた項目(自動適用)。expectedBefore 付きなので、計算後にこの
   *  PC で編集された項目はコミット時に自動で見送られる。 */
  autoOps: ChangeOp[]
  /** 両方が変えた項目(ユーザーが選ぶ)。 */
  conflicts: MergeConflict[]
  // 競合の解決を ChangeOp 化するための素材(行 key → 相手の値 / 判断根拠)
  theirsByKey: Map<string, { id: string } | null>
  expectedByKey: Map<string, string>
  /** prepare 時点で決めた帰属先マスター(コミット時に再検証する)。 */
  targetMaster: string
}

/**
 * 【prepare・非同期】返却ファイルと控えておいた base から 3方向分類を行い、
 * 変更オペと競合リストを作る。メディアもここで取り込む(追加専用なので安全)。
 * 適用はしない — commitSync(同期ブロック)で buildPatchFromOps に渡す。
 */
export async function computeReturnMerge(state: AppState, pack: HandoffPack): Promise<PendingMerge> {
  const rawBase = await loadKv(`handoff.base.${pack.handoffId}`)
  if (!rawBase) throw new Error('この作業ファイルの貸出記録が見つかりません(別のマシンで書き出したファイルの可能性があります)')
  const base: PackItems = { ...EMPTY_ITEMS, ...(JSON.parse(rawBase) as { items: PackItems }).items }
  const srcMaster = (JSON.parse(rawBase) as { sourceMasterId: string }).sourceMasterId
  // 帰属先マスターが消えている場合に備えて現在のアクティブへフォールバック。
  const targetMaster = state.masterProjects.some(m => m.id === srcMaster) ? srcMaster : state.activeMasterProjectId
  const theirs = reparentItems({ ...EMPTY_ITEMS, ...pack.items }, targetMaster)
  const baseR = reparentItems(base, targetMaster)

  await importMedia(pack.media)

  const autoOps: ChangeOp[] = []
  const conflicts: MergeConflict[] = []
  const theirsByKey = new Map<string, { id: string } | null>()
  const expectedByKey = new Map<string, string>()

  const collect = (def: MergeStreamDef, baseArr: { id: string }[], mineArr: { id: string }[], theirsArr: { id: string }[]): void => {
    for (const e of classifyStream(def, baseArr, mineArr, theirsArr, { partialPack: true })) {
      if (e.side === 'mine') continue // 相手は触っていない → 自分の状態を維持
      if (e.side === 'theirs') {
        autoOps.push({ stream: def.key, id: e.id, item: e.theirs, expectedBefore: compareKey(e.mine) })
        continue
      }
      // 両方が変えた → 競合として記録(既定は相手の版)
      const key = `${def.key}:${e.id}`
      conflicts.push({
        key,
        typeLabel: def.typeLabel,
        label: streamLabel(def, (e.theirs ?? e.mine) as Record<string, unknown>),
        kind: KIND_MAP[e.kind] ?? 'both-edited',
        resolution: 'theirs',
      })
      theirsByKey.set(key, e.theirs)
      expectedByKey.set(key, compareKey(e.mine))
    }
  }

  for (const key of Object.keys(STREAMS) as (keyof PackItems)[]) {
    if (key === 'projects') continue // メタ/タスクに分けて下で処理
    collect(STREAMS[key]!, baseR[key] as { id: string }[], state[key] as { id: string }[], theirs[key] as { id: string }[])
  }
  collect(
    PROJECTS_STREAM,
    stripTasks(baseR.projects) as { id: string }[],
    stripTasks(state.projects) as { id: string }[],
    stripTasks(theirs.projects) as { id: string }[],
  )
  collect(
    TASKS_STREAM,
    flattenTasks(baseR.projects) as { id: string }[],
    flattenTasks(state.projects) as { id: string }[],
    flattenTasks(theirs.projects) as { id: string }[],
  )

  return { pack, autoOps, conflicts, theirsByKey, expectedByKey, targetMaster }
}

/**
 * 【commit 内・純粋】帰属先マスターをコミット時点で再検証する。prepare の await 中に
 * 元のマスターが削除されていた場合、決めておいた帰属先のまま適用すると、相手が
 * 追加した項目(expectedBefore が「無し」なのでそのまま通る)が存在しないマスターに
 * ぶら下がる「孤児」になる — 現在のアクティブマスターへ付け替える。
 * commitSync の同期ブロック内で ops に対して呼ぶこと。
 */
export function retargetReturnOps(pending: PendingMerge, ops: ChangeOp[], now: AppState): ChangeOp[] {
  const old = pending.targetMaster
  if (now.masterProjects.some(m => m.id === old)) return ops
  const next = now.activeMasterProjectId
  return ops.map(op => {
    if (!op.item) return op
    const it = op.item as Record<string, unknown>
    if (it.masterProjectId !== old && it.projectId !== old) return op
    const copy: Record<string, unknown> = { ...it }
    if (copy.masterProjectId === old) copy.masterProjectId = next
    if (copy.projectId === old) copy.projectId = next
    return { ...op, item: copy as { id: string } }
  })
}

/**
 * 【commit 前・純粋】自動適用ぶんと競合の選択を1つのオペ集合にまとめる。
 * commitSync 内で retargetReturnOps に通してから buildPatchFromOps(now, ops) に渡す。
 */
export function buildReturnOps(pending: PendingMerge, resolutions: MergeConflict[]): ChangeOp[] {
  const ops = [...pending.autoOps]
  for (const c of resolutions) {
    if (c.resolution !== 'theirs') continue
    const stream = c.key.slice(0, c.key.indexOf(':'))
    const id = c.key.slice(c.key.indexOf(':') + 1)
    ops.push({
      stream,
      id,
      item: pending.theirsByKey.get(c.key) ?? null,
      expectedBefore: pending.expectedByKey.get(c.key) ?? compareKey(null),
    })
  }
  return ops
}

/**
 * 【finalize・非同期】コミット済みのマージを台帳へ反映する。
 * base を「マージ後の状態」へ進める — 据え置くと、同じ handoffId の2通目の返却
 * (途中経過→最終版)で1回目に取り込んだ全項目が競合として並び、既定(相手)の
 * まま適用するとマージ済みの作業が旧版へ巻き戻る。
 */
export async function finalizeReturnMerge(
  pending: PendingMerge,
  skipped: string[],
  ops: ChangeOp[],
): Promise<{ baseAdvanced: boolean }> {
  // base を進める前に、コミット済みのマージ結果をディスクへ確定させる。メモリ
  // だけの状態で base を先に進めると、ここでクラッシュした場合に「旧項目+
  // 新 base」で再起動し、同じ返却の再取り込みが誤分類される(自分の項目が
  // 「削除した」扱いになる等)。確定できなければ base も返却済み印も見送る —
  // 再取り込みでやり直せる。
  if (!(await settleLocalWrites())) return { baseAdvanced: false }
  let baseAdvanced = false
  try {
    const rawBase = await loadKv(`handoff.base.${pending.pack.handoffId}`)
    const prev = rawBase ? (JSON.parse(rawBase) as { sourceMasterId: string; items: PackItems }) : null
    const sourceMasterId = prev?.sourceMasterId ?? pending.pack.sourceMasterId
    // 次の共通祖先 = 相手が返してきた内容そのもの。手元のマージ後の値を混ぜては
    // いけない — 相手が知らない「自分だけの変更」まで祖先扱いになり、次の返却で
    // 相手の(変わっていない)旧値が「相手の変更」と誤分類されて、自分の変更が
    // 無競合のまま旧値へ巻き戻る。
    const nextBase = reparentItems({ ...EMPTY_ITEMS, ...pending.pack.items }, sourceMasterId)
    // 見送ったオペの項目は「合意に達していない」— base を前回の値のまま据え置く。
    //  ・見送った更新: base=前回値なら、次回は「両方で変更」の競合として再提示される
    //  ・見送った削除: base=前回値なら、次回は「相手が削除/自分は変更」として再提示される
    //    (手元の編集後の値を base に入れると base==自分 となり、次回は削除が無競合で
    //     自動適用され、見送りで守ったはずの編集ごと消える)
    const prevItems: PackItems = { ...EMPTY_ITEMS, ...(prev?.items ?? {}) }
    const skippedIds = new Set(skipped)
    for (const op of ops) {
      if (skippedIds.has(`${op.stream}:${op.id}`)) restoreBaseItem(nextBase, prevItems, op.stream, op.id)
    }
    await saveKv(`handoff.base.${pending.pack.handoffId}`, JSON.stringify({ sourceMasterId, items: nextBase }))
    baseAdvanced = true
  } catch { /* 下で「返却済み」も付けずに中断 — 同じファイルの再取り込みでやり直せる */ }
  if (baseAdvanced) {
    // base を進められなかった場合は returnedAt も付けない。付けてしまうと UI 上は
    // 完了に見えるのに base は旧いままで、2通目の返却が競合の山になる。
    const index = await loadHandoffIndex()
    const e = index.find(x => x.id === pending.pack.handoffId)
    if (e) { e.returnedAt = new Date().toISOString(); await saveKv('handoff.index', JSON.stringify(index)) }
  }
  return { baseAdvanced }
}

// 見送った項目の base 値を前回の base の値へ戻す(前回にも無ければ取り除く)。
function restoreBaseItem(nextBase: PackItems, prev: PackItems, stream: string, id: string): void {
  if (stream === 'projects') {
    const p = prev.projects.find(x => x.id === id)
    const i = nextBase.projects.findIndex(x => x.id === id)
    // メタの据え置きでタスクまで巻き戻さない(タスクは tasks ストリームが別管理)。
    if (p) { if (i >= 0) nextBase.projects[i] = { ...p, tasks: nextBase.projects[i].tasks }; else nextBase.projects.push(p) }
    else if (i >= 0) nextBase.projects.splice(i, 1)
    return
  }
  if (stream === 'tasks') {
    for (const proj of nextBase.projects) {
      const i = proj.tasks.findIndex(x => x.id === id)
      if (i >= 0) proj.tasks.splice(i, 1)
    }
    const t = flattenTasks(prev.projects).find(x => x.id === id)
    if (t) {
      const host = nextBase.projects.find(x => x.id === t.__projectId)
      if (host) { const { __projectId: _pid, ...task } = t; host.tasks.push(task) }
    }
    return
  }
  if (!(stream in EMPTY_ITEMS)) return
  const key = stream as keyof PackItems
  const prevItem = (prev[key] as { id: string }[]).find(x => x.id === id)
  const arr = nextBase[key] as { id: string }[]
  const i = arr.findIndex(x => x.id === id)
  if (prevItem) { if (i >= 0) arr[i] = prevItem as never; else arr.push(prevItem as never) }
  else if (i >= 0) arr.splice(i, 1)
}
