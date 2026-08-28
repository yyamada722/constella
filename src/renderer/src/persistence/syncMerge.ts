// ── 同期フォルダ競合の「項目単位マージ」 ──
// 全体の択一(このPC/フォルダ)では、操作ミス由来の些細な変更(タスクの状態を
// 一度動かして戻した等)まで巻き込んで片側を丸ごと捨てることになる。ここでは
// 最後に同期した世代の DB スナップショット(sync-base.db、main が push/pull の
// たびに控える)を共通祖先に、フォルダ側 DB と現在の状態を項目単位で3方向比較し、
//   ・相手だけが変えた項目 → 既定で取り込む(外すことも可)
//   ・自分だけが変えた項目 → 既定で維持(相手側=元に戻す、も選べる)
//   ・両方が変えた項目     → どちらかを選択
// をフィールドの変更プレビュー付きで取捨選択 → マージ結果を保存して新世代として
// push する。適用は APPLY_STATE_PATCH 1発なので Ctrl+Z で丸ごと戻せる。
//
// 対象は AppState の全コレクション。路線図(app_kv の単一ブロブ)は項目分解
// できないため対象外 — このPCの版が維持される。
import type { AppState } from '../store'
import type { Project } from '../types'
import { parseDbBytes, saveState, saveKv, loadKv } from './db'
import { syncApi, clearFolderSyncDirty, markFolderSyncEdit } from './folderSync'
import {
  stableStringify, compareKey, classifyStream, detectOrderChange, applyOrder, applyChanges,
  flattenTasks, stripTasks, rebuildProjects, streamLabel,
  MERGE_STREAMS, PROJECTS_STREAM, TASKS_STREAM,
  type FlatTask, type MergeStreamDef,
} from './merge'

// ── 差分行 ──

export interface SyncMergeField { label: string; mine: string; theirs: string }

export interface SyncMergeRow {
  key: string // `${stream}:${id}`
  stream: string
  typeLabel: string
  label: string
  side: 'theirs' | 'mine' | 'both'
  kindText: string
  fields: SyncMergeField[]
  resolution: 'theirs' | 'mine'
}

export type SyncMergePlan =
  | {
      ok: true
      folderGen: number
      deviceName: string
      rows: SyncMergeRow[]
      // resolution 適用のための素材(行 key → 各側の実体)
      mineByKey: Map<string, { id: string } | null>
      theirsByKey: Map<string, { id: string } | null>
      mineState: AppState
      // フォルダ側の app_kv(受け渡し台帳など)。マージ結果を push する際に
      // 取りこぼさないよう、こちらに無いキーだけ復元してから送る。
      theirsKv: Record<string, string>
      // 並び順だけが違うコレクションの、相手側の id 並び(採用時に使う)。
      theirsOrder: Record<string, string[]>
    }
  | { ok: false; reason: 'no-base' | 'inconsistent' | 'error'; message: string }

// ── フィールドの変更プレビュー ──

const FIELD_JA: Record<string, string> = {
  title: 'タイトル', name: '名前', text: 'テキスト', status: 'ステータス', content: '本文', description: '説明',
  startDate: '開始日', endDate: '期限', tags: 'タグ', priority: '優先度', completedAt: '完了',
  parentId: '親', folderId: 'フォルダ', boardId: 'ボード', tabId: 'タブ', color: '色', pinned: 'ピン留め',
  archivedAt: 'アーカイブ', x: 'X位置', y: 'Y位置', width: '幅', height: '高さ', url: 'URL / 参照',
  shared: '共有', sharedAlias: '共有名', doingMs: '作業時間', doingSince: '作業中開始',
  linkedNoteIds: '関連ノート', fileIds: '添付ファイル', attachments: '付随資料', linkedMasterIds: '参照プロジェクト',
  pages: 'ページ', strokes: 'ストローク', nodes: 'ノード', edges: 'つながり', groups: 'グループ',
  messages: 'メッセージ', points: '経路', stationIds: '駅の並び', bookmarks: 'ブックマーク', frames: 'フレーム',
  draftWhen: '下書き時期', locked: 'ロック', curved: 'カーブ', fontSize: '文字サイズ', ord: '並び順',
}
const VALUE_JA: Record<string, string> = { todo: '未着手', 'in-progress': '進行中', done: '完了' }

function fmtVal(v: unknown): string {
  if (v == null || v === '') return '(なし)'
  if (typeof v === 'boolean') return v ? 'オン' : 'オフ'
  if (typeof v === 'number') return String(Math.round(v * 10) / 10)
  if (typeof v === 'string') {
    const s = VALUE_JA[v] ?? v
    return s.length > 34 ? s.slice(0, 34) + '…' : s
  }
  if (Array.isArray(v)) return `${v.length}件`
  return '(詳細データ)'
}

function diffFields(mine: Record<string, unknown> | null, theirs: Record<string, unknown> | null): SyncMergeField[] {
  const a = mine
  const b = theirs
  if (!a || !b) return []
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  const out: SyncMergeField[] = []
  for (const k of keys) {
    if (k === 'id') continue
    if (stableStringify(a[k] ?? null) === stableStringify(b[k] ?? null)) continue
    out.push({ label: FIELD_JA[k] ?? k, mine: fmtVal(a[k]), theirs: fmtVal(b[k]) })
    if (out.length >= 6) { out.push({ label: '…', mine: '', theirs: '' }); break }
  }
  return out
}

// ── プラン作成 ──

type Row = Record<string, unknown> & { id: string }

const KIND_JA: Record<string, string> = {
  added: '追加', updated: '変更', deleted: '削除',
  'both-edited': '両方で変更',
  'they-edited-i-deleted': '相手が変更 / 自分は削除',
  'they-deleted-i-edited': '相手が削除 / 自分は変更',
}

// 共通コアの分類結果を、この画面が扱う行に変換する。
function rowsForStream(
  def: MergeStreamDef,
  baseArr: Row[], mineArr: Row[], theirsArr: Row[],
  out: { rows: SyncMergeRow[]; mineByKey: Map<string, { id: string } | null>; theirsByKey: Map<string, { id: string } | null>; theirsOrder: Record<string, string[]> },
): void {
  for (const e of classifyStream(def, baseArr, mineArr, theirsArr)) {
    const key = `${def.key}:${e.id}`
    out.rows.push({
      key, stream: def.key, typeLabel: def.typeLabel,
      label: streamLabel(def, e.theirs ?? e.mine ?? e.base),
      side: e.side,
      kindText: KIND_JA[e.kind] ?? e.kind,
      fields: diffFields(e.mine, e.theirs),
      // 既定: 相手だけの変更は取り込む / 自分だけの変更は維持 / 両方はこのPCを維持
      resolution: e.side === 'theirs' ? 'theirs' : 'mine',
    })
    out.mineByKey.set(key, e.mine)
    out.theirsByKey.set(key, e.theirs)
  }
  // 並び順(ord 列として保存される実データ)の変更も1行として拾う。
  const o = detectOrderChange(baseArr, mineArr, theirsArr)
  if (!o) return
  out.rows.push({
    key: `order:${def.key}`,
    stream: `order:${def.key}`,
    typeLabel: '並び順',
    label: def.typeLabel,
    side: o.side,
    kindText: o.side === 'both' ? '両方で並べ替え' : '並べ替え',
    fields: [{ label: '並び', mine: `${o.count}件の順序(このPC)`, theirs: `${o.count}件の順序(相手)` }],
    resolution: o.side === 'both' ? 'mine' : 'theirs',
  })
  out.theirsOrder[def.key] = o.theirsIds
}

/** 競合中に呼ぶ: base とフォルダ側 DB を読み、項目単位の差分プランを作る。 */
export async function prepareSyncMerge(state: AppState): Promise<SyncMergePlan> {
  const api = syncApi()
  if (!api) return { ok: false, reason: 'error', message: 'デスクトップ版でのみ利用できます' }
  try {
    const folder = await api.readFolderDb()
    if (!folder.ok || !folder.bytes || typeof folder.gen !== 'number') {
      return folder.error === 'inconsistent'
        ? { ok: false, reason: 'inconsistent', message: 'クラウドの転送が完了していません。しばらくしてからもう一度お試しください' }
        : { ok: false, reason: 'error', message: `同期フォルダを読めませんでした(${folder.error ?? ''})` }
    }
    const baseBytes = await api.readBase()
    if (!baseBytes) {
      return { ok: false, reason: 'no-base', message: 'この競合には比較の基準(前回同期時の記録)がありません。今回は「このPCを採用 / 同期フォルダを採用」からお選びください。次回の同期からは項目単位で選べるようになります' }
    }
    const [theirsParsed, baseParsed] = await Promise.all([
      parseDbBytes(new Uint8Array(folder.bytes)),
      parseDbBytes(new Uint8Array(baseBytes)),
    ])
    if (!theirsParsed || !baseParsed) return { ok: false, reason: 'error', message: '比較用データの読み取りに失敗しました' }
    const theirsState = theirsParsed.state
    const baseState = baseParsed.state

    const out = {
      rows: [] as SyncMergeRow[],
      mineByKey: new Map<string, { id: string } | null>(),
      theirsByKey: new Map<string, { id: string } | null>(),
      theirsOrder: {} as Record<string, string[]>,
    }
    const pick = (st: AppState, key: string): Row[] => (st[key as keyof AppState] ?? []) as unknown as Row[]
    for (const def of MERGE_STREAMS) {
      rowsForStream(def, pick(baseState, def.key), pick(state, def.key), pick(theirsState, def.key), out)
    }
    // タスクボード: メタとタスクを分けて粒度を確保
    rowsForStream(
      PROJECTS_STREAM,
      stripTasks(baseState.projects) as unknown as Row[],
      stripTasks(state.projects) as unknown as Row[],
      stripTasks(theirsState.projects) as unknown as Row[],
      out,
    )
    rowsForStream(
      TASKS_STREAM,
      flattenTasks(baseState.projects) as unknown as Row[],
      flattenTasks(state.projects) as unknown as Row[],
      flattenTasks(theirsState.projects) as unknown as Row[],
      out,
    )

    // 表示順: 要選択(both) → 相手の変更 → 自分の変更
    const order = { both: 0, theirs: 1, mine: 2 }
    out.rows.sort((a, b2) => order[a.side] - order[b2.side] || a.typeLabel.localeCompare(b2.typeLabel))
    return { ok: true, folderGen: folder.gen, deviceName: folder.deviceName || '相手のマシン', rows: out.rows, mineByKey: out.mineByKey, theirsByKey: out.theirsByKey, mineState: state, theirsKv: theirsParsed.kv, theirsOrder: out.theirsOrder }
  } catch (e) {
    return { ok: false, reason: 'error', message: e instanceof Error ? e.message : '差分の計算に失敗しました' }
  }
}

// ── 適用 ──

// このPCが持っている受け渡し台帳のキー(存在するものだけ)。フォルダ側の台帳を
// 復元する際に「こちらに無いものだけ」を判定するために使う。
async function loadHandoffKeys(): Promise<Record<string, string | undefined>> {
  const out: Record<string, string | undefined> = {}
  for (const k of ['handoff.index', 'handoff.recv.index']) {
    const v = await loadKv(k)
    if (v != null) out[k] = v
  }
  // base は id ごとに増えるので、index に載っている分だけ確認する。
  try {
    const idx = JSON.parse(out['handoff.index'] ?? '[]') as { id: string }[]
    for (const e of idx) {
      const key = `handoff.base.${e.id}`
      const v = await loadKv(key)
      if (v != null) out[key] = v
    }
  } catch { /* 台帳が壊れていても復元処理は続行 */ }
  return out
}

/**
 * 選択を反映したマージ結果を作り、保存してフォルダへ新世代として push する。
 * 戻り値の patch を APPLY_STATE_PATCH で dispatch すると画面にも反映される。
 *
 * `current` は**適用ボタンを押した時点**の状態を渡すこと。差分の計算はモーダルを
 * 開いた時点のスナップショット(plan.mineState)で凍結してよいが、適用の土台まで
 * 凍結すると、モーダル表示中に進んだ編集(グローバル Ctrl+Z、LAN の focus-sync に
 * よる再 hydrate 等)がディスクと push 先で巻き戻る。
 */
export async function applySyncMerge(
  plan: Extract<SyncMergePlan, { ok: true }>,
  rows: SyncMergeRow[],
  current: AppState,
): Promise<{ ok: true; patch: Partial<AppState> } | { ok: false; message: string; patch?: Partial<AppState> }> {
  const api = syncApi()
  if (!api) return { ok: false, message: 'デスクトップ版でのみ利用できます' }

  // resolution==='theirs' の行だけ、相手側の値で 上書き/追加/削除 する。
  const byStream = new Map<string, { id: string; item: { id: string } | null }[]>()
  const reorder = new Set<string>() // 相手の並び順を採用するコレクション
  for (const r of rows) {
    if (r.resolution !== 'theirs') continue
    if (r.stream.startsWith('order:')) { reorder.add(r.stream.slice('order:'.length)); continue }
    const list = byStream.get(r.stream) ?? []
    list.push({ id: r.key.slice(r.key.indexOf(':') + 1), item: plan.theirsByKey.get(r.key) ?? null })
    byStream.set(r.stream, list)
  }
  // 相手の並びに寄せる。相手に無い id(こちらだけの新規)は現在の相対順で末尾に残す。
  const ordered = (stream: string, arr: { id: string }[]): { id: string }[] =>
    reorder.has(stream) ? applyOrder(arr, plan.theirsOrder[stream] ?? []) : arr

  const patch: Partial<AppState> = {}
  const applyTo = applyChanges
  // 土台は「適用時点」の状態。相手側を採用した行だけを重ねるので、モーダル表示中に
  // 進んだ他の変更はそのまま生き残る。
  for (const [stream, changes] of byStream) {
    if (stream === 'projects' || stream === 'tasks') continue
    ;(patch as Record<string, unknown>)[stream] = ordered(stream, applyTo(current[stream as keyof AppState] as unknown as { id: string }[], changes))
  }
  // 並び順だけ採用するコレクション(項目の差分は無い)も反映する。
  for (const stream of reorder) {
    if (stream === 'projects' || stream === 'tasks') continue
    if ((patch as Record<string, unknown>)[stream]) continue
    ;(patch as Record<string, unknown>)[stream] = ordered(stream, [...(current[stream as keyof AppState] as unknown as { id: string }[])])
  }
  const projChanges = byStream.get('projects') ?? []
  const taskChanges = byStream.get('tasks') ?? []
  if (projChanges.length || taskChanges.length || reorder.has('projects') || reorder.has('tasks')) {
    const metas = ordered('projects', applyTo(stripTasks(current.projects) as unknown as { id: string }[], projChanges)) as unknown as Omit<Project, 'tasks'>[]
    const flat = ordered('tasks', applyTo(flattenTasks(current.projects) as unknown as { id: string }[], taskChanges)) as unknown as FlatTask[]
    // 相手の並びを採用した場合、flat は既にその順に並んでいるので再ソートさせない。
    patch.projects = rebuildProjects(metas, flat, current.projects, reorder.has('tasks'))
  }

  // アクティブなプロジェクトが相手側の削除で消えた場合、存在しない id が残ると
  // 画面が空に見える。生き残っているプロジェクトへ寄せる。
  if (patch.masterProjects) {
    const activeId = patch.activeMasterProjectId ?? current.activeMasterProjectId
    if (!patch.masterProjects.some(p => p.id === activeId)) {
      patch.activeMasterProjectId = patch.masterProjects[0]?.id ?? ''
    }
  }

  const merged: AppState = { ...current, ...patch }
  // 受け渡しの台帳(app_kv の handoff.*)は AppState の外にあるため、マージ結果を
  // そのまま push すると相手側の台帳が消える。こちらに無いキーだけ先に復元する
  // (貸出記録が消えると、その返却ファイルを取り込めなくなる)。
  try {
    const mine = await loadHandoffKeys()
    for (const [k, v] of Object.entries(plan.theirsKv)) {
      if (!k.startsWith('handoff.')) continue // mindtrain 等の単一ブロブはマージ不能なのでこのPCの版を維持
      if (mine[k] === undefined) await saveKv(k, v)
    }
  } catch { /* 台帳の復元は best-effort — 失敗してもマージ自体は成立する */ }
  // 先に保存してから push(push はディスク上の DB ファイルを読むため)。
  try {
    await saveState(merged)
  } catch (e) {
    return { ok: false, message: `マージ結果の保存に失敗しました: ${e instanceof Error ? e.message : e}` }
  }
  // 相手側スナップショットを退避してから上書きする。項目単位で「自分」を選んだ行の
  // 相手の値は、この push で唯一の保管場所だったフォルダ側DBから消えるため。
  await api.backupConflict('remote').catch(() => { /* 退避は best-effort */ })
  const r = await api.push(plan.folderGen + 1, plan.folderGen)
  if (!r.ok) {
    // フォルダ側がさらに進んだ等。ディスクにはマージ結果が入っているのにメモリ側は
    // 未マージなので、(a) 呼び出し側が patch を dispatch して両者を揃えられるよう
    // patch を返し、(b) 未 push であることを dirty として残す(落とすと次の pull で
    // マージ結果ごと無警告に上書きされる)。
    markFolderSyncEdit()
    return {
      ok: false,
      patch,
      message: r.error === 'changed'
        ? '同期フォルダ側が更新されました。マージ結果はこのPCに保存済みです — もう一度開き直して送信してください'
        : `送信に失敗しました: ${r.error ?? ''}(マージ結果はこのPCに保存済みです)`,
    }
  }
  // dirty は必ずこの入口で落とす(main の永続フラグとレンダラー側フラグを揃える)。
  await clearFolderSyncDirty()
  return { ok: true, patch }
}
