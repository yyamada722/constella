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
import { parseDbBytes, saveKv, loadKv } from './db'
import { syncApi, clearFolderSyncDirtyIfUnchanged, settleLocalWrites, uploadMissingMedia } from './folderSync'
import { flushMindtrainPending } from '../mindtrain/persist'
import {
  stableStringify, compareKey, classifyStream, detectOrderChange, streamLabel,
  flattenTasks, stripTasks,
  MERGE_STREAMS, PROJECTS_STREAM, TASKS_STREAM,
  type MergeStreamDef, type ChangeOp, type OrderOp,
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
      // 並び順だけが違うコレクションの、相手側の id 並び(採用時に使う)と、
      // 判断時点のこのPC側の並び(コミット時の検証に使う)。
      theirsOrder: Record<string, string[]>
      mineOrder: Record<string, string[]>
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
  out: { rows: SyncMergeRow[]; mineByKey: Map<string, { id: string } | null>; theirsByKey: Map<string, { id: string } | null>; theirsOrder: Record<string, string[]>; mineOrder: Record<string, string[]> },
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
  out.mineOrder[def.key] = mineArr.map(x => x.id)
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
      mineOrder: {} as Record<string, string[]>,
    }
    const plan_theirsKv = theirsParsed.kv
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

    // 路線図(mindtrain)は app_kv の単一ブロブで項目分解できないが、黙って
    // このPCの版を残すと相手の路線図編集が消える。ブロブ全体を1行として出す。
    // 読む前にデバウンス待ちの保存を確定させる(500ms 窓の編集を読み飛ばさない)。
    flushMindtrainPending()
    const myMindtrain = await loadKv('mindtrain')
    const theirMindtrain = plan_theirsKv['mindtrain']
    if ((theirMindtrain ?? null) !== (myMindtrain ?? null)) {
      out.rows.push({
        key: 'kv:mindtrain',
        stream: 'kv:mindtrain',
        typeLabel: '路線図',
        label: '路線図データ全体',
        side: 'both',
        kindText: '内容が異なります(まとめて置き換え)',
        fields: [{ label: '内容', mine: myMindtrain ? 'このPCの版' : '(なし)', theirs: theirMindtrain ? '相手の版' : '(なし)' }],
        resolution: 'mine',
      })
    }

    // 表示順: 要選択(both) → 相手の変更 → 自分の変更
    const order = { both: 0, theirs: 1, mine: 2 }
    out.rows.sort((a, b2) => order[a.side] - order[b2.side] || a.typeLabel.localeCompare(b2.typeLabel))
    return { ok: true, folderGen: folder.gen, deviceName: folder.deviceName || '相手のマシン', rows: out.rows, mineByKey: out.mineByKey, theirsByKey: out.theirsByKey, mineState: state, theirsKv: theirsParsed.kv, theirsOrder: out.theirsOrder, mineOrder: out.mineOrder }
  } catch (e) {
    return { ok: false, reason: 'error', message: e instanceof Error ? e.message : '差分の計算に失敗しました' }
  }
}

// ── 適用 ──

// 台帳(配列)の統合。同じ id は「このPCの版」を優先し、相手にしかない記録を足す。
// 片方を丸ごと捨てると、相手が貸し出した記録が push で共有状態から消える。
function mergeLedger(mineRaw: string | undefined, theirsRaw: string, idKey: string): string {
  const parse = (raw: string | undefined): Record<string, unknown>[] => {
    try { const v = JSON.parse(raw ?? '[]'); return Array.isArray(v) ? v : [] } catch { return [] }
  }
  const merged = parse(mineRaw)
  const byId = new Map(merged.map(x => [String(x[idKey]), x]))
  for (const e of parse(theirsRaw)) {
    const id = String(e[idKey])
    const mine = byId.get(id)
    if (!mine) { merged.push(e); byId.set(id, e); continue }
    // 同じ記録でも、片方にしかないフィールド(返却済みの returnedAt など)がある。
    // 相手側だけが持つキーを補って、情報を落とさずに統合する。
    for (const [k, v] of Object.entries(e)) {
      if (mine[k] === undefined && v !== undefined) mine[k] = v
    }
  }
  return JSON.stringify(merged.slice(0, 60))
}

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
 * 【commit 前・純粋】行の選択を ChangeOp / OrderOp に変換する。
 * expectedBefore には判断の根拠になった「モーダルを開いた時点のこのPC側の値」を
 * 入れる — コミット時に現在値と食い違えば、その項目は表示後に編集されたので
 * 適用が自動で見送られる(buildPatchFromOps 側の唯一の検査に集約)。
 */
export function buildSyncCommit(
  plan: Extract<SyncMergePlan, { ok: true }>,
  rows: SyncMergeRow[],
): { ops: ChangeOp[]; orderOps: OrderOp[]; takeMindtrain: boolean } {
  const ops: ChangeOp[] = []
  const orderOps: OrderOp[] = []
  let takeMindtrain = false
  for (const r of rows) {
    if (r.resolution !== 'theirs') continue
    if (r.stream === 'kv:mindtrain') { takeMindtrain = true; continue }
    if (r.stream.startsWith('order:')) {
      const stream = r.stream.slice('order:'.length)
      orderOps.push({ stream, theirsIds: plan.theirsOrder[stream] ?? [], expectedIds: plan.mineOrder[stream] ?? [] })
      continue
    }
    const id = r.key.slice(r.key.indexOf(':') + 1)
    ops.push({
      stream: r.stream,
      id,
      item: plan.theirsByKey.get(r.key) ?? null,
      expectedBefore: compareKey(plan.mineByKey.get(r.key) ?? null),
    })
  }
  return { ops, orderOps, takeMindtrain }
}

/**
 * 【commit 後・非同期】コミット済みのマージを永続化してフォルダへ送る。
 * 順序: 路線図kv(採用時) → 相手側台帳の復元 → 未確定保存の確定 → メディア送信 →
 * 相手側スナップショットの退避 → push → dirty解除(コミット以降に編集が無い場合のみ)。
 * push より前の永続化はどれか一つでも失敗したら中止する — 握り潰して push すると
 * 「相手の路線図/台帳を含まない DB」でフォルダを上書きし、相手側にしか無い
 * データが消える。中止時は「マージはこのPCに残り dirty のまま」に落ち、
 * 競合バナーからやり直せる。
 */
export async function finalizeSyncMerge(
  plan: Extract<SyncMergePlan, { ok: true }>,
  editSeqAfterCommit: number,
  takeMindtrain: boolean,
): Promise<{ ok: true } | { ok: false; message: string; mindtrainApplied?: boolean }> {
  const api = syncApi()
  if (!api) return { ok: false, message: 'デスクトップ版でのみ利用できます' }

  // 中止時、路線図が既に SQLite へ書かれていればメモリ側のストアと食い違う。
  // 呼び出し側はこのフラグを見て読み込み直し、乖離を残さない。
  let mindtrainApplied = false
  if (takeMindtrain) {
    // 採用=このPCの版を捨てる選択。書き換え前に pending を確定させ、
    // 置き換え後に古い保存が着地して巻き戻るのを防ぐ。
    flushMindtrainPending()
    try {
      await saveKv('mindtrain', plan.theirsKv['mindtrain'] ?? null)
      mindtrainApplied = true
    } catch {
      return { ok: false, message: '相手側の路線図を書き込めなかったため送信を中止しました。マージ結果はこのPCに残っています — もう一度お試しください' }
    }
  }

  // 受け渡しの台帳(app_kv の handoff.*)は AppState の外にあるため、マージ結果を
  // そのまま push すると相手側の台帳が消える。統合できるまで送らない
  // (貸出記録が消えると、その返却ファイルを取り込めなくなる)。
  try {
    const mine = await loadHandoffKeys()
    for (const [k, v] of Object.entries(plan.theirsKv)) {
      if (!k.startsWith('handoff.')) continue
      if (k === 'handoff.index' || k === 'handoff.recv.index') {
        await saveKv(k, mergeLedger(mine[k], v, k === 'handoff.index' ? 'id' : 'handoffId'))
        continue
      }
      if (mine[k] === undefined) await saveKv(k, v)
    }
  } catch {
    return { ok: false, message: '受け渡し記録を統合できなかったため送信を中止しました。マージ結果はこのPCに残っています — もう一度お試しください', mindtrainApplied }
  }

  // push はディスク上の DB を読む。コミット済みの state を確定させてから送る。
  if (!(await settleLocalWrites())) {
    return { ok: false, message: '保存に失敗したため送信を見送りました。マージ結果はこのPCに残っています', mindtrainApplied }
  }
  // 「自分」を選んだ項目が新しいメディアを参照している場合、実体を先に
  // フォルダへ置く(通常 push と同じ不変条件)。部分失敗は続行してよい —
  // 受信側は不足 blob を pending として再試行で取り寄せる。
  await uploadMissingMedia()
  // 相手側スナップショットを退避してから上書きする。項目単位で「自分」を選んだ行の
  // 相手の値は、この push で唯一の保管場所だったフォルダ側DBから消えるため、
  // 退避に失敗したら押さない(押すと復元不能に消える)。
  const backedUp = await api.backupConflict('remote').catch(() => null)
  if (!backedUp) {
    return { ok: false, message: 'バックアップを作れなかったため送信を中止しました(ディスクの空き容量をご確認ください)。マージ結果はこのPCに保存済みです', mindtrainApplied }
  }
  const r = await api.push(plan.folderGen + 1, plan.folderGen)
  if (!r.ok) {
    return {
      ok: false,
      message: r.error === 'changed'
        ? '同期フォルダ側が更新されました。マージ結果はこのPCに保存済みです — もう一度開き直して送信してください'
        : `送信に失敗しました: ${r.error ?? ''}(マージ結果はこのPCに保存済みです)`,
      mindtrainApplied,
    }
  }
  // コミットの dispatch ぶんは editSeqAfterCommit に織り込み済み。それ以降に
  // 編集があれば dirty は残り、次の同期 push が拾う。
  await clearFolderSyncDirtyIfUnchanged(editSeqAfterCommit)
  return { ok: true }
}
