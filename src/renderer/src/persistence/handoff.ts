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
}

export async function loadHandoffIndex(): Promise<HandoffIndexEntry[]> {
  try { return JSON.parse((await loadKv('handoff.index')) || '[]') } catch { return [] }
}
export async function loadRecvIndex(): Promise<RecvIndexEntry[]> {
  try { return JSON.parse((await loadKv('handoff.recv.index')) || '[]') } catch { return [] }
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
  return {
    ...items,
    notes: re(items.notes),
    noteFolders: re(items.noteFolders),
    files: re(items.files),
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
 * 受け取った作業ファイルを「専用の新プロジェクト」として追加する。
 * 既存データには一切触れない。戻り値の patch を APPLY_STATE_PATCH で適用する。
 */
export async function receiveHandoff(state: AppState, pack: HandoffPack): Promise<{ patch: Partial<AppState>; master: MasterProject }> {
  const recv = await loadRecvIndex()
  // 取り込みは undo できるが台帳は履歴の外にあるため、「台帳にはあるがプロジェクトが
  // 無い」= 取り込みを取り消した/削除した状態になりうる。その場合は再取り込みを許す
  // (でないと undo した瞬間に、そのファイルを二度と開けなくなる)。
  const stale = recv.filter(r => r.handoffId === pack.handoffId && !state.masterProjects.some(m => m.id === r.masterId))
  const live = recv.filter(r => r.handoffId === pack.handoffId && state.masterProjects.some(m => m.id === r.masterId))
  if (live.length > 0) {
    throw new Error(`この作業ファイル(${pack.name})は既に取り込み済みです。返却を受け取る側の場合は、元のマシンで取り込んでください`)
  }
  const kept = stale.length > 0 ? recv.filter(r => !stale.includes(r)) : recv
  const master: MasterProject = { id: generateId(), name: `📦 ${pack.name}`, createdAt: new Date().toISOString() }
  const remap = remapCollidingIds(state, pack.items)
  const items = reparentItems(remap.items, master.id)
  await importMedia(pack.media)
  const patch: Partial<AppState> = {
    masterProjects: [...state.masterProjects, master],
    activeMasterProjectId: master.id,
  }
  for (const key of Object.keys(EMPTY_ITEMS) as (keyof PackItems)[]) {
    // 既存配列の後ろに連結。id は元のまま維持する(返却マージの前提)。
    ;(patch as Record<string, unknown[]>)[key] = [...(state[key] as unknown[]), ...(items[key] as unknown[])]
  }
  // 逆引き(新 id → 元 id)を控える。返却時にこれで元の id へ戻さないと、貸出側の
  // マージが「元 id は削除・新 id は追加」と解釈してパック外の参照を壊す。
  const idMap: Record<string, string> = {}
  for (const [orig, next] of remap.map) idMap[next] = orig
  kept.unshift({
    handoffId: pack.handoffId, masterId: master.id, name: pack.name,
    sourceMasterId: pack.sourceMasterId, receivedAt: new Date().toISOString(),
    ...(Object.keys(idMap).length ? { idMap } : {}),
  })
  await saveKv('handoff.recv.index', JSON.stringify(kept.slice(0, 30)))
  return { patch, master }
}

/** 受領側: 受け取ったプロジェクトを丸ごと「返却ファイル」として書き出す。 */
export async function exportReturn(state: AppState, entry: RecvIndexEntry, excludeVideos: boolean): Promise<void> {
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

// 比較用の安定シリアライズ(キー順を正規化、undefined は無視)。同期の項目単位マージでも使う。
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']'
  const o = v as Record<string, unknown>
  const keys = Object.keys(o).filter(k => o[k] !== undefined).sort()
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(o[k])).join(',') + '}'
}

export interface MergeConflict {
  key: string // "<stream>:<id>"
  typeLabel: string
  label: string
  kind: 'both-edited' | 'they-edited-i-deleted' | 'they-deleted-i-edited'
  resolution: 'theirs' | 'mine'
}

export interface MergeResult {
  patch: Partial<AppState>
  applied: { updated: number; added: number; deleted: number }
  conflicts: MergeConflict[]
}

interface StreamDef<T> {
  key: string
  typeLabel: string
  label: (x: T) => string
  // 比較から除外する揮発フィールド(PDF の表示位置など、作業内容でないもの)。
  normalize?: (x: T) => unknown
  /**
   * パックへの同梱が「参照されているか」で決まるコレクション(ファイル本体と、
   * その親フォルダ)。相手側に無い = 削除ではなく「参照が外れただけ」なので、
   * 削除としては適用しない。これを守らないと、借り手がノートから添付を外した
   * だけで、貸出側の**全プロジェクトの**ライブラリからそのファイルが消える。
   */
  derivedByReference?: boolean
}

// 1コレクション分の 3方向マージ。conflicts の resolution を変えて再適用できるよう、
// 決定(conflict)は適用せず記録し、適用は applyResolutions で行う。
function mergeStream<T extends { id: string }>(
  def: StreamDef<T>,
  baseArr: T[], mineArr: T[], theirsArr: T[],
  out: { conflicts: MergeConflict[]; theirsByKey: Map<string, T | null>; applied: MergeResult['applied'] },
): T[] {
  const base = new Map(baseArr.map(x => [x.id, x]))
  const mine = new Map(mineArr.map(x => [x.id, x]))
  const theirs = new Map(theirsArr.map(x => [x.id, x]))
  const S = (x: T | undefined | null): string => (x == null ? '∅' : stableStringify(def.normalize ? def.normalize(x) : x))

  const result = new Map(mine) // 自分の並び・自分だけの新規はそのまま生かす
  const ids = new Set<string>([...base.keys(), ...theirs.keys()])
  for (const id of ids) {
    const b = base.get(id) ?? null
    const t = theirs.get(id) ?? null
    const m = mine.get(id) ?? null
    const theyChanged = S(t) !== S(b)
    const iChanged = S(m) !== S(b)
    if (!theyChanged) continue // 相手は触っていない → 自分の状態(編集/削除含む)を維持
    if (S(m) === S(t)) continue // 双方の結果が同一(同じ返却の再取り込み等) → 競合ではない
    // 参照で同梱されるコレクションの「消失」は削除の意思表示ではない(参照が
    // 外れただけでもパックから落ちる)。更新・追加だけを受け入れる。
    if (!t && def.derivedByReference) continue
    if (!iChanged) {
      // 相手だけが変えた → そのまま採用(追加/更新/削除)
      if (t) { result.set(id, t); out.applied[b ? 'updated' : 'added']++ }
      else { result.delete(id); out.applied.deleted++ }
      continue
    }
    // 両方が変えた → 競合として記録(既定は相手の版)
    const kind: MergeConflict['kind'] = !m ? 'they-edited-i-deleted' : !t ? 'they-deleted-i-edited' : 'both-edited'
    const key = `${def.key}:${id}`
    out.conflicts.push({ key, typeLabel: def.typeLabel, label: def.label((t ?? m) as T), kind, resolution: 'theirs' })
    out.theirsByKey.set(key, t)
  }
  return [...result.values()]
}

// タスクは projects[].tasks に入れ子だが、粒度を保つためフラット化してマージする。
export interface FlatTask extends Task { __projectId: string }
export const flattenTasks = (projects: Project[]): FlatTask[] =>
  projects.flatMap(p => p.tasks.map(t => ({ ...t, __projectId: p.id })))
export const stripTasks = (projects: Project[]): (Omit<Project, 'tasks'> & { id: string })[] =>
  projects.map(({ tasks: _tasks, ...meta }) => meta)

const STREAMS: { [K in keyof PackItems]?: StreamDef<{ id: string }> } = {
  notes: { key: 'notes', typeLabel: 'ノート', label: x => (x as Note).title || '(無題)' },
  noteFolders: { key: 'noteFolders', typeLabel: 'ノートフォルダ', label: x => (x as NoteFolder).name, derivedByReference: true },
  files: { key: 'files', typeLabel: 'ファイル', label: x => (x as FileItem).name, derivedByReference: true },
  fileFolders: { key: 'fileFolders', typeLabel: 'ファイルフォルダ', label: x => (x as FileFolder).name, derivedByReference: true },
  research: { key: 'research', typeLabel: 'リサーチ', label: x => (x as ResearchItem).title },
  researchFolders: { key: 'researchFolders', typeLabel: 'リサーチフォルダ', label: x => (x as ResearchFolder).name, derivedByReference: true },
  sketches: { key: 'sketches', typeLabel: 'スケッチ', label: x => (x as Sketch).name },
  flows: { key: 'flows', typeLabel: 'フロー', label: x => (x as Flow).name },
  plans: { key: 'plans', typeLabel: '計画', label: x => (x as Plan).name },
  planFolders: { key: 'planFolders', typeLabel: '計画フォルダ', label: x => (x as PlanFolder).name, derivedByReference: true },
  canvasBoards: { key: 'canvasBoards', typeLabel: 'キャンバスボード', label: x => (x as CanvasBoard).name },
  canvasTabs: { key: 'canvasTabs', typeLabel: 'キャンバスタブ', label: x => (x as CanvasTab).name },
  canvasCards: {
    key: 'canvasCards', typeLabel: 'カード',
    label: x => (x as CanvasCard).title || (x as CanvasCard).content?.slice(0, 24) || '(カード)',
    // PDF の表示ページなどの閲覧状態は作業内容ではない — 競合ノイズにしない。
    normalize: x => { const { pdf: _pdf, ...rest } = x as CanvasCard; return rest },
  },
  canvasArrows: { key: 'canvasArrows', typeLabel: '矢印', label: x => (x as CanvasArrow).label || '(矢印)' },
  canvasGroups: { key: 'canvasGroups', typeLabel: 'グループ', label: x => (x as CanvasGroup).title || '(グループ)' },
  canvasStrokes: { key: 'canvasStrokes', typeLabel: '描き込み', label: () => '(描き込み)' },
  canvasLabels: { key: 'canvasLabels', typeLabel: 'ラベル', label: x => (x as CanvasLabel).text || '(ラベル)' },
  canvasRails: { key: 'canvasRails', typeLabel: '路線', label: x => (x as CanvasRail).name },
  canvasStations: { key: 'canvasStations', typeLabel: '駅', label: x => (x as CanvasStation).name },
}

export interface PendingMerge {
  pack: HandoffPack
  result: MergeResult
  // 競合の解決を反映して最終 patch を得るための素材
  theirsByKey: Map<string, { id: string } | null>
  mineState: AppState
}

/** 返却ファイルと控えておいた base から 3方向マージを計算する(まだ適用しない)。 */
export async function computeReturnMerge(state: AppState, pack: HandoffPack): Promise<PendingMerge> {
  const rawBase = await loadKv(`handoff.base.${pack.handoffId}`)
  if (!rawBase) throw new Error('この作業ファイルの貸出記録が見つかりません(別のマシンで書き出したファイルの可能性があります)')
  const base: PackItems = { ...EMPTY_ITEMS, ...(JSON.parse(rawBase) as { items: PackItems }).items }
  const srcMaster = (JSON.parse(rawBase) as { sourceMasterId: string }).sourceMasterId
  // 帰属先マスターが消えている場合に備えて現在のアクティブへフォールバック。
  const targetMaster = state.masterProjects.some(m => m.id === srcMaster) ? srcMaster : state.activeMasterProjectId
  const theirs = reparentItems({ ...EMPTY_ITEMS, ...pack.items }, targetMaster)
  const baseR = reparentItems(base, targetMaster)

  const applied: MergeResult['applied'] = { updated: 0, added: 0, deleted: 0 }
  const conflicts: MergeConflict[] = []
  const theirsByKey = new Map<string, { id: string } | null>()
  const out = { conflicts, theirsByKey, applied }
  const patch: Partial<AppState> = {}

  for (const key of Object.keys(STREAMS) as (keyof PackItems)[]) {
    const def = STREAMS[key]!
    ;(patch as Record<string, unknown>)[key] = mergeStream(
      def,
      baseR[key] as { id: string }[],
      state[key] as { id: string }[],
      theirs[key] as { id: string }[],
      out,
    )
  }

  // タスク: プロジェクトのメタとタスクを別ストリームでマージしてから組み立て直す。
  const projMeta = mergeStream(
    { key: 'projects', typeLabel: 'タスクボード', label: x => (x as Project).name },
    stripTasks(baseR.projects) as { id: string }[],
    stripTasks(state.projects) as { id: string }[],
    stripTasks(theirs.projects) as { id: string }[],
    out,
  ) as (Omit<Project, 'tasks'>)[]
  const taskDef: StreamDef<{ id: string }> = { key: 'tasks', typeLabel: 'タスク', label: x => (x as FlatTask).title }
  const mergedTasks = mergeStream(
    taskDef,
    flattenTasks(baseR.projects) as { id: string }[],
    flattenTasks(state.projects) as { id: string }[],
    flattenTasks(theirs.projects) as { id: string }[],
    out,
  ) as FlatTask[]
  patch.projects = rebuildProjects(projMeta, mergedTasks, state.projects)

  return { pack, result: { patch, applied, conflicts }, theirsByKey, mineState: state }
}

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
  // 自分側のタスク並び順を優先し、新規は末尾に付く(Map の挿入順で保たれる)。
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

/**
 * 凍結時点で計算した patch を「今」の状態に載せ替える。
 *
 * mergeStream は `new Map(mine)` から始めて相手の変更を重ねた**全置換配列**を返すので、
 * そのまま適用すると凍結時点以降の編集が消える。ここでは patch と凍結スナップショットを
 * 突き合わせて「マージが実際に加えた変更(追加/更新/削除)」だけを取り出し、
 * それを現在の配列へ適用し直す。
 */
function rebasePatch(pending: PendingMerge, current: AppState): Partial<AppState> {
  const out: Partial<AppState> = {}
  const rebaseOne = (frozen: { id: string }[], merged: { id: string }[], now: { id: string }[]): { id: string }[] => {
    const frozenById = new Map(frozen.map(x => [x.id, x]))
    const mergedById = new Map(merged.map(x => [x.id, x]))
    const next = [...now]
    // マージが変えた/足したもの
    for (const item of merged) {
      const before = frozenById.get(item.id)
      if (before && stableStringify(before) === stableStringify(item)) continue
      const i = next.findIndex(x => x.id === item.id)
      if (i >= 0) next[i] = item
      else next.push(item)
    }
    // マージが消したもの
    for (const item of frozen) {
      if (mergedById.has(item.id)) continue
      const i = next.findIndex(x => x.id === item.id)
      if (i >= 0) next.splice(i, 1)
    }
    return next
  }
  for (const key of Object.keys(pending.result.patch) as (keyof AppState)[]) {
    if (key === 'projects') continue // タスク入れ子は呼び出し側が組み立て直す
    const merged = pending.result.patch[key] as unknown as { id: string }[] | undefined
    if (!merged) continue
    ;(out as Record<string, unknown>)[key] = rebaseOne(
      pending.mineState[key] as unknown as { id: string }[],
      merged,
      current[key] as unknown as { id: string }[],
    )
  }
  if (pending.result.patch.projects) {
    const metas = rebaseOne(
      stripTasks(pending.mineState.projects) as unknown as { id: string }[],
      stripTasks(pending.result.patch.projects) as unknown as { id: string }[],
      stripTasks(current.projects) as unknown as { id: string }[],
    ) as unknown as Omit<Project, 'tasks'>[]
    const flat = rebaseOne(
      flattenTasks(pending.mineState.projects) as unknown as { id: string }[],
      flattenTasks(pending.result.patch.projects) as unknown as { id: string }[],
      flattenTasks(current.projects) as unknown as { id: string }[],
    ) as unknown as FlatTask[]
    out.projects = rebuildProjects(metas, flat, current.projects)
  }
  return out
}

/** 競合の解決(theirs/mine)を patch に反映した最終形を返し、メディアも取り込む。 */
export async function applyReturnMerge(pending: PendingMerge, resolutions: MergeConflict[], current: AppState): Promise<Partial<AppState>> {
  // 差分の計算は取り込み時点で凍結してよいが、適用の土台は「今」の状態にする。
  // 競合の選択に時間をかけている間の編集(グローバル Ctrl+Z など)を巻き戻さない。
  const patch = rebasePatch(pending, current)
  // key = "<stream>:<id>"。resolution が theirs の競合だけ、相手の版で上書き/削除する。
  const byStream = new Map<string, { id: string; item: { id: string } | null }[]>()
  for (const c of resolutions) {
    if (c.resolution !== 'theirs') continue
    const [stream, id] = [c.key.slice(0, c.key.indexOf(':')), c.key.slice(c.key.indexOf(':') + 1)]
    const list = byStream.get(stream) ?? []
    list.push({ id, item: pending.theirsByKey.get(c.key) ?? null })
    byStream.set(stream, list)
  }
  for (const [stream, changes] of byStream) {
    if (stream === 'projects' || stream === 'tasks') continue // 下でまとめて処理
    const arr = [...((patch as Record<string, { id: string }[]>)[stream] ?? [])]
    for (const { id, item } of changes) {
      const i = arr.findIndex(x => x.id === id)
      if (item) { if (i >= 0) arr[i] = item; else arr.push(item) }
      else if (i >= 0) arr.splice(i, 1)
    }
    ;(patch as Record<string, unknown>)[stream] = arr
  }
  // projects/tasks の競合解決: プロジェクトメタとフラットタスクへ反映して組み立て直す。
  const projChanges = byStream.get('projects') ?? []
  const taskChanges = byStream.get('tasks') ?? []
  if (projChanges.length || taskChanges.length) {
    const cur = (patch.projects ?? current.projects) as Project[]
    let metas = stripTasks(cur)
    let flat = flattenTasks(cur)
    for (const { id, item } of projChanges) {
      const i = metas.findIndex(x => x.id === id)
      if (item) { if (i >= 0) metas[i] = item as Omit<Project, 'tasks'>; else metas.push(item as Omit<Project, 'tasks'>) }
      else metas = metas.filter(x => x.id !== id)
    }
    for (const { id, item } of taskChanges) {
      const i = flat.findIndex(x => x.id === id)
      if (item) { if (i >= 0) flat[i] = item as FlatTask; else flat.push(item as FlatTask) }
      else flat = flat.filter(x => x.id !== id)
    }
    patch.projects = rebuildProjects(metas, flat, current.projects)
  }
  await importMedia(pending.pack.media)
  // 台帳に返却済みを記録し、base は次の貸出まで残す(再取り込みにも耐える)。
  const index = await loadHandoffIndex()
  const e = index.find(x => x.id === pending.pack.handoffId)
  if (e) { e.returnedAt = new Date().toISOString(); await saveKv('handoff.index', JSON.stringify(index)) }
  return patch
}
