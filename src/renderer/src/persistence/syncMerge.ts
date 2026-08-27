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
import { parseDbBytes, saveState } from './db'
import { syncApi, clearFolderSyncDirty, markFolderSyncEdit } from './folderSync'
import { stableStringify, flattenTasks, stripTasks, rebuildProjects, type FlatTask } from './handoff'

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
    }
  | { ok: false; reason: 'no-base' | 'inconsistent' | 'error'; message: string }

// ── ストリーム定義(AppState の全 id コレクション + フラット化タスク) ──

interface StreamDef {
  key: string
  typeLabel: string
  label: (x: Record<string, unknown>) => string
}

const label = (...fields: string[]) => (x: Record<string, unknown>): string => {
  for (const f of fields) { const v = x[f]; if (typeof v === 'string' && v.trim()) return v.slice(0, 40) }
  return '(無題)'
}

const STREAMS: { key: keyof AppState; def: StreamDef }[] = [
  { key: 'masterProjects', def: { key: 'masterProjects', typeLabel: 'プロジェクト', label: label('name') } },
  { key: 'notes', def: { key: 'notes', typeLabel: 'ノート', label: label('title') } },
  { key: 'noteFolders', def: { key: 'noteFolders', typeLabel: 'ノートフォルダ', label: label('name') } },
  { key: 'files', def: { key: 'files', typeLabel: 'ファイル', label: label('name') } },
  { key: 'fileFolders', def: { key: 'fileFolders', typeLabel: 'ファイルフォルダ', label: label('name') } },
  { key: 'research', def: { key: 'research', typeLabel: 'リサーチ', label: label('title') } },
  { key: 'researchFolders', def: { key: 'researchFolders', typeLabel: 'リサーチフォルダ', label: label('name') } },
  { key: 'sketches', def: { key: 'sketches', typeLabel: 'スケッチ', label: label('name') } },
  { key: 'flows', def: { key: 'flows', typeLabel: 'フロー', label: label('name') } },
  { key: 'plans', def: { key: 'plans', typeLabel: '計画', label: label('name') } },
  { key: 'planFolders', def: { key: 'planFolders', typeLabel: '計画フォルダ', label: label('name') } },
  { key: 'timelineBands', def: { key: 'timelineBands', typeLabel: '期間帯', label: label('title') } },
  { key: 'aiConversations', def: { key: 'aiConversations', typeLabel: 'AI会話', label: label('title') } },
  { key: 'canvasBoards', def: { key: 'canvasBoards', typeLabel: 'キャンバスボード', label: label('name') } },
  { key: 'canvasTabs', def: { key: 'canvasTabs', typeLabel: 'キャンバスタブ', label: label('name') } },
  { key: 'canvasCards', def: { key: 'canvasCards', typeLabel: 'カード', label: label('title', 'content') } },
  { key: 'canvasArrows', def: { key: 'canvasArrows', typeLabel: '矢印', label: label('label') } },
  { key: 'canvasGroups', def: { key: 'canvasGroups', typeLabel: 'グループ', label: label('title') } },
  { key: 'canvasStrokes', def: { key: 'canvasStrokes', typeLabel: '描き込み', label: () => '(描き込み)' } },
  { key: 'canvasLabels', def: { key: 'canvasLabels', typeLabel: 'ラベル', label: label('text') } },
  { key: 'canvasRails', def: { key: 'canvasRails', typeLabel: '路線', label: label('name') } },
  { key: 'canvasStations', def: { key: 'canvasStations', typeLabel: '駅', label: label('name') } },
]

// 変更判定・表示から除く揮発フィールド: updatedAt(内容が同じなら同じ扱い)、
// canvasCards.pdf(PDF の表示ページ等の閲覧状態)。
const VOLATILE = new Set(['updatedAt', 'pdf'])
function normalized(x: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!x) return null
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(x)) if (!VOLATILE.has(k) && x[k] !== undefined) out[k] = x[k]
  return out
}
const S = (x: Record<string, unknown> | null): string => (x == null ? '∅' : stableStringify(normalized(x)))

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
  const a = normalized(mine)
  const b = normalized(theirs)
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

function diffStream(
  def: StreamDef,
  baseArr: Row[], mineArr: Row[], theirsArr: Row[],
  out: { rows: SyncMergeRow[]; mineByKey: Map<string, { id: string } | null>; theirsByKey: Map<string, { id: string } | null> },
): void {
  const base = new Map(baseArr.map(x => [x.id, x]))
  const mine = new Map(mineArr.map(x => [x.id, x]))
  const theirs = new Map(theirsArr.map(x => [x.id, x]))
  const ids = new Set<string>([...base.keys(), ...mine.keys(), ...theirs.keys()])
  for (const id of ids) {
    const b = base.get(id) ?? null
    const m = mine.get(id) ?? null
    const t = theirs.get(id) ?? null
    const theyChanged = S(t) !== S(b)
    const iChanged = S(m) !== S(b)
    if (!theyChanged && !iChanged) continue
    if (S(m) === S(t)) continue // 双方の結果が同一 → 差分なし
    const side: SyncMergeRow['side'] = theyChanged && iChanged ? 'both' : theyChanged ? 'theirs' : 'mine'
    const kindText =
      side === 'both'
        ? !m ? '相手が変更 / 自分は削除' : !t ? '相手が削除 / 自分は変更' : '両方で変更'
        : side === 'theirs'
          ? !b ? '追加' : !t ? '削除' : '変更'
          : !b ? '追加' : !m ? '削除' : '変更'
    const key = `${def.key}:${id}`
    out.rows.push({
      key, stream: def.key, typeLabel: def.typeLabel,
      label: def.label((t ?? m ?? b) as Record<string, unknown>),
      side, kindText,
      fields: diffFields(m, t),
      // 既定: 相手だけの変更は取り込む / 自分だけの変更は維持 / 両方はこのPCを維持
      resolution: side === 'theirs' ? 'theirs' : 'mine',
    })
    out.mineByKey.set(key, m)
    out.theirsByKey.set(key, t)
  }
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
    const [theirsState, baseState] = await Promise.all([
      parseDbBytes(new Uint8Array(folder.bytes)),
      parseDbBytes(new Uint8Array(baseBytes)),
    ])
    if (!theirsState || !baseState) return { ok: false, reason: 'error', message: '比較用データの読み取りに失敗しました' }

    const out = { rows: [] as SyncMergeRow[], mineByKey: new Map<string, { id: string } | null>(), theirsByKey: new Map<string, { id: string } | null>() }
    for (const { key, def } of STREAMS) {
      diffStream(def, (baseState[key] ?? []) as unknown as Row[], (state[key] ?? []) as unknown as Row[], (theirsState[key] ?? []) as unknown as Row[], out)
    }
    // タスクボード: メタとタスクを分けて粒度を確保
    diffStream(
      { key: 'projects', typeLabel: 'タスクボード', label: label('name') },
      stripTasks(baseState.projects) as unknown as Row[],
      stripTasks(state.projects) as unknown as Row[],
      stripTasks(theirsState.projects) as unknown as Row[],
      out,
    )
    diffStream(
      { key: 'tasks', typeLabel: 'タスク', label: label('title') },
      flattenTasks(baseState.projects) as unknown as Row[],
      flattenTasks(state.projects) as unknown as Row[],
      flattenTasks(theirsState.projects) as unknown as Row[],
      out,
    )

    // 表示順: 要選択(both) → 相手の変更 → 自分の変更
    const order = { both: 0, theirs: 1, mine: 2 }
    out.rows.sort((a, b2) => order[a.side] - order[b2.side] || a.typeLabel.localeCompare(b2.typeLabel))
    return { ok: true, folderGen: folder.gen, deviceName: folder.deviceName || '相手のマシン', rows: out.rows, mineByKey: out.mineByKey, theirsByKey: out.theirsByKey, mineState: state }
  } catch (e) {
    return { ok: false, reason: 'error', message: e instanceof Error ? e.message : '差分の計算に失敗しました' }
  }
}

// ── 適用 ──

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
  for (const r of rows) {
    if (r.resolution !== 'theirs') continue
    const list = byStream.get(r.stream) ?? []
    list.push({ id: r.key.slice(r.key.indexOf(':') + 1), item: plan.theirsByKey.get(r.key) ?? null })
    byStream.set(r.stream, list)
  }

  const patch: Partial<AppState> = {}
  const applyTo = (arr: { id: string }[], changes: { id: string; item: { id: string } | null }[]): { id: string }[] => {
    const next = [...arr]
    for (const { id, item } of changes) {
      const i = next.findIndex(x => x.id === id)
      if (item) { if (i >= 0) next[i] = item; else next.push(item) }
      else if (i >= 0) next.splice(i, 1)
    }
    return next
  }
  // 土台は「適用時点」の状態。相手側を採用した行だけを重ねるので、モーダル表示中に
  // 進んだ他の変更はそのまま生き残る。
  for (const [stream, changes] of byStream) {
    if (stream === 'projects' || stream === 'tasks') continue
    ;(patch as Record<string, unknown>)[stream] = applyTo(current[stream as keyof AppState] as unknown as { id: string }[], changes)
  }
  const projChanges = byStream.get('projects') ?? []
  const taskChanges = byStream.get('tasks') ?? []
  if (projChanges.length || taskChanges.length) {
    const metas = applyTo(stripTasks(current.projects) as unknown as { id: string }[], projChanges) as unknown as Omit<Project, 'tasks'>[]
    const flat = applyTo(flattenTasks(current.projects) as unknown as { id: string }[], taskChanges) as unknown as FlatTask[]
    patch.projects = rebuildProjects(metas, flat, current.projects)
  }

  const merged: AppState = { ...current, ...patch }
  // 先に保存してから push(push はディスク上の DB ファイルを読むため)。
  try {
    await saveState(merged)
  } catch (e) {
    return { ok: false, message: `マージ結果の保存に失敗しました: ${e instanceof Error ? e.message : e}` }
  }
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
