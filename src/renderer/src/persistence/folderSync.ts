// ── 他マシンとの同期(同期フォルダ方式) — レンダラー側オーケストレーション ──
// OneDrive/Dropbox/NAS などの「同期フォルダ」を媒介に DB スナップショット丸ごと +
// 追加専用のメディア実体を運ぶ。行レベルのマージはしない(1台ずつ使う前提)。
//
// マニフェストの世代番号(Lamport)で判定する:
//   フォルダの gen == 自分の lastGen           → dirty なら push(gen+1)、でなければ最新
//   フォルダの gen >  自分の lastGen           → dirty でなければ pull、dirty なら競合
//   フォルダの gen <  自分の lastGen           → フォルダが巻き戻された → 競合
//   gen は同じだが DB の SHA が記録と違う       → 同時 push 事故(クラウドの競合コピー) → 競合
// 競合はバナーで「どちらを採用するか」をユーザーに聞き、負けた側は必ず
// db-backups/constella-conflict-*.db に退避されるのでデータは消えない。
//
// メディア(idb:<id>)は不変・追加専用なので衝突しない:
//   ローカルにあってフォルダに無い id → アップロード(全件)
//   現在の状態が参照していてローカルに無い id → ダウンロード(参照分のみ —
//   全件を取り込むと sweep 済みの不要 blob が永遠に往復してしまう)
import { useSyncExternalStore } from 'react'
import { drainSaves, freezeWrites, thawWrites } from './db'
import { listAllMediaIds, putMediaWithId, getMediaBlob, MEDIA_PREFIX } from './media'
import { isRemote } from './runtime'

export interface SyncManifest {
  app: 'constella'
  version: 1
  gen: number
  deviceId: string
  deviceName: string
  pushedAt: string
  dbSize: number
  dbSha256: string
}

interface InspectResult {
  configured: boolean
  enabled: boolean
  folder: string | null
  deviceName: string
  lastGen: number
  lastSha: string
  lastSyncAt: string | null
  localEtag: string
  dirty: boolean
  folderOk: boolean
  manifest: SyncManifest | null
  manifestUnreadable: boolean
}

export interface SyncApi {
  get: () => Promise<{ folder: string | null; enabled: boolean; deviceId: string; deviceName: string; lastGen: number; lastSyncAt: string | null }>
  configure: (patch: { folder?: string | null; enabled?: boolean; deviceName?: string }) => Promise<{ folder: string | null; enabled: boolean; deviceName: string }>
  pickFolder: () => Promise<string | null>
  setDirty: (dirty: boolean) => Promise<void>
  inspect: () => Promise<InspectResult>
  push: (gen: number, expectPrev: number) => Promise<{ ok: boolean; error?: string; manifest?: SyncManifest }>
  pullPrepare: (expectedGen: number, deadlineMs?: number) => Promise<{ ok: boolean; error?: string; manifest?: SyncManifest }>
  pullCommit: (expectedGen: number) => Promise<{ ok: boolean; error?: string; manifest?: SyncManifest }>
  pullDiscard: () => Promise<void>
  pullUndo: () => Promise<{ ok: boolean }>
  readBase: () => Promise<Uint8Array | null>
  readFolderDb: () => Promise<{ ok: boolean; error?: string; gen?: number; bytes?: Uint8Array; deviceName?: string }>
  listRemoteMedia: () => Promise<string[]>
  backupMediaRefs: () => Promise<string[]>
  readRemoteMedia: (name: string) => Promise<{ bytes: Uint8Array; mime: string } | null>
  writeRemoteMedia: (id: string, bytes: Uint8Array, mime: string) => Promise<boolean>
  backupConflict: (source: 'local' | 'remote') => Promise<string | null>
}

export function syncApi(): SyncApi | null {
  if (isRemote) return null
  return (window as unknown as { api?: { sync?: SyncApi } }).api?.sync ?? null
}

// ── ステータス(UI 購読用) ──

export type FolderSyncPhase = 'off' | 'checking' | 'idle' | 'pushing' | 'pulling' | 'conflict' | 'waiting' | 'error'

export interface FolderSyncStatus {
  phase: FolderSyncPhase
  enabled: boolean
  folder: string | null
  lastSyncAt: string | null
  message?: string
  conflict?: {
    remoteGen: number
    remoteDeviceName: string
    pushedAt: string
    // このマシンをフォルダに初めてつないだ時の「どちらから始めるか」選択
    // (競合というより初期セットアップ — バナーの文言を変える)。
    initial: boolean
  }
}

let status: FolderSyncStatus = { phase: 'off', enabled: false, folder: null, lastSyncAt: null }
const listeners = new Set<() => void>()
function setStatus(patch: Partial<FolderSyncStatus>): void {
  status = { ...status, ...patch }
  // conflict は明示的に渡された時だけ維持/更新する(phase が変わったら消す)。
  if (patch.phase && patch.phase !== 'conflict' && patch.conflict === undefined) delete status.conflict
  if (patch.phase && patch.message === undefined) delete status.message
  listeners.forEach(l => l())
}

export function useFolderSyncStatus(): FolderSyncStatus {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => { listeners.delete(cb) } },
    () => status,
  )
}

// ── 内部状態 ──

let busy = false
let retryTimer: ReturnType<typeof setTimeout> | null = null
let pushTimer: ReturnType<typeof setTimeout> | null = null
let lastReconcileAt = 0

// 現在の状態が参照している idb: の id 一覧(store.tsx が初期化時に注入)。
let getLiveRefs: (() => Promise<string[]>) | null = null
// 未確定の編集(store の 400ms デバウンス待ち)を即座にディスクへ書き出す。
// push は DB ファイルを読むので、これを先に流さないと「編集を含まないバイトを
// 送ったうえで dirty を落とす」= その編集が恒久的に未同期になる。
let flushPendingSaves: (() => Promise<void>) | null = null

export function initFolderSync(opts: {
  getLiveRefs: () => Promise<string[]>
  flushPendingSaves: () => Promise<void>
}): void {
  getLiveRefs = opts.getLiveRefs
  flushPendingSaves = opts.flushPendingSaves
}

/**
 * push 直前に呼ぶ: デバウンス待ちの編集を確定させ、飛行中の保存も待ち切る。
 * 確定に失敗したら false — その場合 push してはいけない。ディスク上の DB には
 * まだ最新の編集が入っておらず、押したうえで dirty を落とすと「未保存の編集を
 * 同期済みと記録する」ことになり、次の pull で消える。
 */
export async function settleLocalWrites(): Promise<boolean> {
  try {
    await flushPendingSaves?.()
  } catch {
    return false
  }
  await drainSaves()
  return true
}

// ── 実編集の記録 ──
// dirty は etag ではなく「実際の編集があったか」で判定する(起動のたびの
// 再シリアライズでニセ競合を出さないため)。編集のたびに editSeq を進め、
// push 完了時に「push 開始以降に新たな編集が無い」場合だけフラグを下ろす。
let editSeq = 0
let dirtyMarked = false

/**
 * 競合バックアップ(退避したDB)が参照しているメディアの idb: 参照。
 * sweep の生存集合に足して、「退避したのに実体だけ7日後に消える」のを防ぐ。
 */
export async function backupMediaRefs(): Promise<string[]> {
  const api = syncApi()
  if (!api?.backupMediaRefs) return []
  try { return (await api.backupMediaRefs()).map(id => MEDIA_PREFIX + id) } catch { return [] }
}

/** 状態への実編集(ユーザー操作)が起きたときに呼ぶ。 */
export function markFolderSyncEdit(): void {
  editSeq++
  if (dirtyMarked) return
  dirtyMarked = true
  syncApi()?.setDirty(true).catch(() => { dirtyMarked = false })
}

async function clearDirtyIfNoNewEdits(api: SyncApi, seqAtPush: number): Promise<void> {
  if (editSeq !== seqAtPush) return // push 中に編集された → dirty のまま(次で再送)
  await clearFolderSyncDirty()
}

/** 指定時点から編集が無ければ dirty を下ろす(あれば残す)。UI 側の適用後処理用。 */
export async function clearFolderSyncDirtyIfUnchanged(seq: number): Promise<void> {
  if (editSeq !== seq) return
  await clearFolderSyncDirty()
}

/** 現在の編集シーケンス。適用処理の前後で挟んで「その間の編集」を検出する。 */
export function currentEditSeq(): number { return editSeq }

/**
 * dirty を下ろす唯一の入口。main の永続フラグとレンダラー側の dirtyMarked を
 * 必ず同時に落とす — 片方だけ落とすと markFolderSyncEdit が
 * `if (dirtyMarked) return` で以後永久に握り潰され、その後の編集が push も
 * されず、相手が世代を進めた時に無警告 pull で消える。
 */
export async function clearFolderSyncDirty(): Promise<void> {
  const api = syncApi()
  dirtyMarked = false
  if (api) await api.setDirty(false).catch(() => { /* 次の push で再確定される */ })
}

function scheduleRetry(ms: number): void {
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = setTimeout(() => { retryTimer = null; void checkFolderSync('retry') }, ms)
}

/** 保存完了のたびに呼ばれ、少し待ってから push チェックを走らせる(連打をまとめる)。 */
export function scheduleFolderPush(): void {
  if (status.phase === 'off' || status.phase === 'conflict') return
  if (pushTimer) clearTimeout(pushTimer)
  pushTimer = setTimeout(() => { pushTimer = null; void checkFolderSync('auto') }, 15_000)
}

// ── メディア転送 ──

async function remoteMediaMap(api: SyncApi): Promise<Map<string, string>> {
  const names = await api.listRemoteMedia()
  const map = new Map<string, string>()
  for (const n of names) map.set(n.slice(0, n.indexOf('.')), n)
  return map
}

/** ローカルにあってフォルダに無い blob をアップロード。失敗数を返す。 */
async function pushMissingMedia(api: SyncApi, remote?: Map<string, string>): Promise<number> {
  const map = remote ?? await remoteMediaMap(api)
  const localIds = await listAllMediaIds()
  let failed = 0
  for (const id of localIds) {
    if (map.has(id)) continue
    try {
      const blob = await getMediaBlob(MEDIA_PREFIX + id)
      if (!blob) continue
      const bytes = new Uint8Array(await blob.arrayBuffer())
      if (!(await api.writeRemoteMedia(id, bytes, blob.type || ''))) failed++
    } catch { failed++ }
  }
  return failed
}

/** 現在の状態が参照していてローカルに無い blob をフォルダから取り込む。 */
async function pullReferencedMedia(api: SyncApi, remote?: Map<string, string>): Promise<{ pulled: number; pending: number }> {
  if (!getLiveRefs) return { pulled: 0, pending: 0 }
  const map = remote ?? await remoteMediaMap(api)
  const local = new Set(await listAllMediaIds())
  const refs = await getLiveRefs()
  const wanted = new Set<string>()
  for (const r of refs) if (r && r.startsWith(MEDIA_PREFIX)) wanted.add(r.slice(MEDIA_PREFIX.length))
  let pulled = 0
  let pending = 0
  for (const id of wanted) {
    if (local.has(id)) continue
    const name = map.get(id)
    if (!name) { pending++; continue } // フォルダ側にまだ届いていない(クラウド転送待ち)
    try {
      const r = await api.readRemoteMedia(name)
      if (!r) { pending++; continue }
      await putMediaWithId(id, new Blob([r.bytes as BlobPart], { type: r.mime || '' }))
      pulled++
    } catch { pending++ }
  }
  return { pulled, pending }
}

/**
 * ローカルにあってフォルダに無い blob をアップロードする(公開ラッパー)。
 * 項目単位マージの push 前に呼ぶ — 「マニフェストが参照する実体が先に揃う」という
 * 通常 push と同じ不変条件を守るため。失敗数を返す(呼び出し側は通常 push と同様、
 * 部分失敗でも続行してよい — 受信側の pending 再試行が自己回復する)。
 */
export async function uploadMissingMedia(): Promise<number> {
  const api = syncApi()
  if (!api) return 0
  try { return await pushMissingMedia(api) } catch { return 1 }
}

async function reconcileMedia(api: SyncApi, trigger: FolderSyncTrigger): Promise<void> {
  lastReconcileAt = Date.now()
  const map = await remoteMediaMap(api)
  const failedPush = await pushMissingMedia(api, map)
  const { pulled, pending } = await pullReferencedMedia(api, map)
  if (failedPush > 0 || pending > 0) {
    setStatus({ message: 'メディアの一部を転送待ちです(クラウドの同期完了後に再試行します)' })
    scheduleRetry(60_000)
  }
  // 起動直後(post-hydrate)にメディアを取り込んだ場合、既に描画されたカードは
  // 「読み込みに失敗」のまま残るので一度だけリロードする。取り込みが無ければ
  // リロードしないため、ループにはならない。セッション中(focus等)の取り込みは
  // 作業を中断しないようリロードしない(該当カードは次の表示時に読み込まれる)。
  if (trigger === 'post-hydrate' && pulled > 0) {
    window.location.reload()
  }
}

// ── 本体 ──

export type FolderSyncTrigger = 'startup' | 'post-hydrate' | 'focus' | 'blur' | 'auto' | 'manual' | 'retry'

/** 判定 → push / pull / 競合検出。戻り値は起動時フロー用('pulled' = DB を差し替えた)。 */
export async function checkFolderSync(trigger: FolderSyncTrigger): Promise<'pulled' | FolderSyncPhase> {
  const api = syncApi()
  if (!api) return 'off'
  if (busy) return status.phase
  // 競合はユーザーの選択待ち — 自動チェックで状態を塗り替えない(手動は再判定を許す)。
  if (status.phase === 'conflict' && trigger !== 'manual') return 'conflict'
  busy = true
  // 判定に使う dirty は inspect 時点のスナップショット。ここから pull を確定するまでの
  // 間に入った編集は「まだ dirty に反映されていない編集」なので、editSeq で見張って
  // 取り込み前に競合へ振り替える(黙って捨てない)。
  const seqAtCheck = editSeq
  try {
    const ins = await api.inspect()
    const base = { enabled: ins.configured && ins.enabled, folder: ins.folder, lastSyncAt: ins.lastSyncAt }
    if (!ins.configured || !ins.enabled) { setStatus({ phase: 'off', ...base }); return 'off' }
    setStatus({ phase: 'checking', ...base })
    if (!ins.folderOk) {
      setStatus({ phase: 'error', message: '同期フォルダにアクセスできません' })
      scheduleRetry(120_000)
      return 'error'
    }
    if (ins.manifestUnreadable) {
      setStatus({ phase: 'waiting', message: '同期情報の転送待ちです' })
      scheduleRetry(30_000)
      return 'waiting'
    }
    const m = ins.manifest

    if (!m) {
      // まっさらなフォルダ: ローカルの DB を最初の世代として押す。
      if (ins.localEtag) return await doPush(api, 1, 0, trigger)
      setStatus({ phase: 'idle' })
      return 'idle'
    }

    if (m.gen === ins.lastGen) {
      if (ins.lastSha && m.dbSha256 !== ins.lastSha) {
        // 同じ世代なのに中身が違う = 両方のマシンが同じ世代を押した(クラウドが
        // 片方を競合コピーに逃した)。安全のためユーザーに選ばせる。
        setConflict(m, false)
        return 'conflict'
      }
      if (ins.dirty) return await doPush(api, m.gen + 1, m.gen, trigger)
      setStatus({ phase: 'idle' })
      if (trigger !== 'startup' && (trigger === 'manual' || trigger === 'post-hydrate' || Date.now() - lastReconcileAt > 30_000)) {
        await reconcileMedia(api, trigger)
      }
      return 'idle'
    }

    if (m.gen > ins.lastGen) {
      if (ins.lastGen === 0 || ins.dirty) {
        setConflict(m, ins.lastGen === 0)
        return 'conflict'
      }
      return await doPull(api, m, trigger, seqAtCheck)
    }

    // フォルダ側が自分の記録より古い = フォルダが差し替え/巻き戻しされた。
    setConflict(m, false)
    return 'conflict'
  } catch (e) {
    setStatus({ phase: 'error', message: e instanceof Error ? e.message : '同期に失敗しました' })
    scheduleRetry(120_000)
    return 'error'
  } finally {
    busy = false
  }
}

function setConflict(m: SyncManifest, initial: boolean): void {
  setStatus({
    phase: 'conflict',
    conflict: { remoteGen: m.gen, remoteDeviceName: m.deviceName || '別のマシン', pushedAt: m.pushedAt, initial },
  })
}

async function doPush(api: SyncApi, gen: number, expectPrev: number, trigger: FolderSyncTrigger): Promise<FolderSyncPhase> {
  setStatus({ phase: 'pushing' })
  // デバウンス待ちの編集を確定させてから seq を取る(確定処理自体は編集ではない)。
  if (!(await settleLocalWrites())) {
    setStatus({ phase: 'error', message: '保存に失敗したため送信を見送りました' })
    scheduleRetry(30_000)
    return 'error'
  }
  const seqAtPush = editSeq
  // メディアを先に上げる: マニフェスト(コミットポイント)が参照する実体が
  // フォルダに揃ってから DB+マニフェストを書く。
  const failed = await pushMissingMedia(api)
  const r = await api.push(gen, expectPrev)
  if (!r.ok) {
    if (r.error === 'changed') {
      // 判定中にフォルダ側が進んだ — すぐ再判定(次は pull か競合になる)。
      setStatus({ phase: 'checking' })
      scheduleRetry(2_000)
      return 'checking'
    }
    setStatus({ phase: 'error', message: `送信に失敗しました: ${r.error ?? ''}` })
    scheduleRetry(60_000)
    return 'error'
  }
  await clearDirtyIfNoNewEdits(api, seqAtPush)
  setStatus({ phase: 'idle', lastSyncAt: r.manifest?.pushedAt ?? new Date().toISOString() })
  if (failed > 0) {
    setStatus({ message: 'メディアの一部を転送待ちです(後で再試行します)' })
    scheduleRetry(60_000)
  }
  if (trigger !== 'startup') lastReconcileAt = Date.now()
  return 'idle'
}

// 起動時チェックを待ち切れず先に起動した(= 以降ユーザーが編集しうる)ことを示す。
// これが立った後の起動時 pull は DB を差し替えてはならない — 差し替えても
// 凍結中に積まれた編集ごとリロードで消えるだけになる。
let startupAbandoned = false
// 起動時 pull の締め切り。startupFolderSync の待ち時間より短くして、
// 「見捨てた後に裏で成功して DB を差し替える」窓自体を作らない。
const STARTUP_PULL_DEADLINE_MS = 18_000
const STARTUP_WAIT_MS = 25_000

async function doPull(api: SyncApi, m: SyncManifest, trigger: FolderSyncTrigger, seqAtCheck: number): Promise<'pulled' | FolderSyncPhase> {
  setStatus({ phase: 'pulling' })
  // 起動時チェックを既に見捨てていたら、DB を差し替えずに次の focus 判定へ回す
  // (この時点でユーザーは編集を始めている可能性があり、凍結+リロードは消失を生む)。
  if (trigger === 'startup' && startupAbandoned) {
    setStatus({ phase: 'waiting', message: 'クラウドの転送完了を待っています' })
    scheduleRetry(15_000)
    return 'waiting'
  }
  // 第1段: フォルダからの読み出し(クラウド次第で数十秒)。ここではまだローカルDBを
  // 触らないので凍結もしない — ユーザーは普通に編集でき、その編集は保存される。
  let prep: { ok: boolean; error?: string }
  try {
    prep = await api.pullPrepare(m.gen, trigger === 'startup' ? STARTUP_PULL_DEADLINE_MS : undefined)
  } catch (e) {
    setStatus({ phase: 'error', message: e instanceof Error ? e.message : '取り込みに失敗しました' })
    scheduleRetry(60_000)
    return 'error'
  }
  if (!prep.ok) {
    setStatus({
      phase: 'waiting',
      message: trigger === 'startup'
        ? 'クラウドの転送完了を待っています(それまでこのPCの内容で表示します)'
        : 'クラウドの転送完了を待っています',
    })
    scheduleRetry(30_000)
    return 'waiting'
  }
  // 判定(inspect)から取り込み確定までの間にユーザーが編集していたら、それを黙って
  // 捨てない。両方に変更がある状態=競合なので、ユーザーに選ばせる(項目単位マージも使える)。
  //
  // 起動時(startup)は hydrate 前でユーザーが編集しようがなく、この時点の editSeq の
  // 動きは各ストアの初期化(路線図ストアの再バインド等)なので対象外。起動後まで
  // ずれ込んだケースは startupAbandoned が受け持つ。
  const editedDuringPull = trigger !== 'startup' && editSeq !== seqAtCheck
  if (editedDuringPull || (trigger === 'startup' && startupAbandoned)) {
    await api.pullDiscard().catch(() => { /* 次の prepare で上書きされる */ })
    if (editedDuringPull) { setConflict(m, false); return 'conflict' }
    setStatus({ phase: 'waiting', message: 'クラウドの転送完了を待っています' })
    scheduleRetry(15_000)
    return 'waiting'
  }
  // 第2段: ローカルDBの差し替え(ローカルI/Oのみ=短い)。ここだけ凍結する。
  // 取り込んだ DB を後から着地した保存が上書きしないよう、飛行中の保存も待ち切る
  // (freezeWrites は saveState の入口フラグにすぎず、既に飛んでいる db:save は止まらない)。
  // 起動時も凍結+リロードの道を通る: mindtrain ストアがバンドル評価の時点で旧 DB を
  // sql.js に読み込んでいるため、ファイル差し替えだけでは旧データがメモリに残り、
  // 次の自動保存で取り込んだ内容を巻き戻してしまう。
  freezeWrites()
  const seqAtCommit = editSeq
  let r: { ok: boolean; error?: string }
  try {
    await drainSaves()
    r = await api.pullCommit(m.gen)
  } catch (e) {
    // IPC 自体の失敗など。凍結したままにすると以後の保存が無言で捨てられるので必ず解除。
    thawWrites()
    setStatus({ phase: 'error', message: e instanceof Error ? e.message : '取り込みに失敗しました' })
    scheduleRetry(60_000)
    return 'error'
  }
  if (r.ok) {
    // 凍結は saveState を止めるだけで UI の dispatch は止まらない。commit の短い
    // await の間に入った編集は React メモリ上にしか無く、このままリロードすると
    // 消える — main に控えさせた差し替え前の状態へ戻し、競合として選び直して
    // もらう(編集はメモリに生きているので、解凍後の autosave が拾う)。
    if (trigger !== 'startup' && editSeq !== seqAtCommit) {
      const undone = await api.pullUndo().catch(() => ({ ok: false }))
      if (undone.ok) {
        thawWrites()
        setConflict(m, false)
        return 'conflict'
      }
      // 戻せなかった場合は従来どおりリロード(取り込んだ内容を優先)。
    }
    window.location.reload()
    return 'pulled'
  }
  thawWrites()
  setStatus({ phase: 'waiting', message: 'クラウドの転送完了を待っています' })
  scheduleRetry(30_000)
  return 'waiting'
}

/** 起動時チェック(hydrate 前)。クラウドが応答しなくても起動を止めない。 */
export async function startupFolderSync(): Promise<void> {
  const api = syncApi()
  if (!api) return
  startupAbandoned = false
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    checkFolderSync('startup'),
    new Promise<void>(resolve => {
      timer = setTimeout(() => { startupAbandoned = true; resolve() }, STARTUP_WAIT_MS)
    }),
  ]).catch(() => { /* 同期の失敗で起動を壊さない */ })
  if (timer) clearTimeout(timer)
}

/** 設定画面の「今すぐ同期」/ フローティング同期ボタン用。 */
export async function manualFolderSync(): Promise<void> {
  if (pushTimer) { clearTimeout(pushTimer); pushTimer = null }
  await checkFolderSync('manual')
}

/** 競合バナーの選択: 'local' = このPCを採用して push、'remote' = フォルダ側を取り込む。 */
export async function resolveFolderSyncConflict(choice: 'local' | 'remote'): Promise<void> {
  const api = syncApi()
  const c = status.conflict
  if (!api || !c || busy) return
  busy = true
  try {
    if (choice === 'local') {
      setStatus({ phase: 'pushing' })
      // 退避に失敗したら押さない。押すと相手側スナップショットが復元不能に消える。
      if (!(await api.backupConflict('remote'))) {
        setStatus({ phase: 'conflict', conflict: c, message: 'バックアップを作れなかったため中止しました(ディスクの空き容量をご確認ください)' })
        return
      }
      if (!(await settleLocalWrites())) {
        setStatus({ phase: 'conflict', conflict: c, message: '保存に失敗したため中止しました' })
        return
      }
      const seqAtPush = editSeq
      const failed = await pushMissingMedia(api)
      const r = await api.push(c.remoteGen + 1, c.remoteGen)
      if (!r.ok) {
        // フォルダ側がさらに進んでいた等 — 競合表示に戻して選び直してもらう。
        setStatus({ phase: 'conflict', conflict: c, message: '送信できませんでした。もう一度お試しください' })
        return
      }
      await clearDirtyIfNoNewEdits(api, seqAtPush)
      setStatus({ phase: 'idle', lastSyncAt: r.manifest?.pushedAt ?? new Date().toISOString() })
      if (failed > 0) scheduleRetry(60_000)
    } else {
      setStatus({ phase: 'pulling' })
      // ここはユーザーが明示的に「フォルダ側を採用」と選んだ経路なので、読み出し中の
      // 編集は競合に戻さず退避で守る(backupConflict('local') が直前に走っている)。
      const prep = await api.pullPrepare(c.remoteGen).catch(() => ({ ok: false as const }))
      if (!prep.ok) {
        setStatus({ phase: 'conflict', conflict: c, message: 'クラウドの転送待ちのため取り込めませんでした。しばらくして再度お試しください' })
        return
      }
      // 退避する前に未確定の編集を確定させる。prepare は数十秒かかりうるので、
      // その間の編集やデバウンス待ちの編集がディスクに無いまま退避すると、
      // 「退避したはずなのに直前の作業が入っていない」バックアップになる。
      if (!(await settleLocalWrites())) {
        await api.pullDiscard().catch(() => { /* 次の prepare で上書きされる */ })
        setStatus({ phase: 'conflict', conflict: c, message: '保存に失敗したため中止しました' })
        return
      }
      // 凍結 → ドレイン → 退避 → 取り込み の順にする。退避してから凍結すると、
      // その隙間に入った編集が「退避したDBにも、取り込み後のDBにも無い」状態になり
      // 両方から失われる。凍結後は新たな保存が入らないので退避内容が確定する。
      freezeWrites()
      const seqAtCommit = editSeq
      let r: { ok: boolean; error?: string }
      try {
        await drainSaves() // 飛行中の保存が退避/取り込みを跨がないよう待ち切る
        // 退避に失敗したら取り込まない。取り込むとこのPCの内容が復元不能に消える。
        if (!(await api.backupConflict('local'))) {
          thawWrites()
          await api.pullDiscard().catch(() => { /* 次の prepare で上書きされる */ })
          setStatus({ phase: 'conflict', conflict: c, message: 'バックアップを作れなかったため中止しました(ディスクの空き容量をご確認ください)' })
          return
        }
        r = await api.pullCommit(c.remoteGen)
      } catch (e) {
        thawWrites() // 凍結したままだと以後の保存が無言で捨てられる
        setStatus({ phase: 'conflict', conflict: c, message: e instanceof Error ? e.message : '取り込みに失敗しました' })
        return
      }
      if (r.ok) {
        // doPull と同じ理由: commit の間に入った編集をリロードで消さない。
        if (editSeq !== seqAtCommit) {
          const undone = await api.pullUndo().catch(() => ({ ok: false }))
          if (undone.ok) {
            thawWrites()
            setStatus({ phase: 'conflict', conflict: c, message: '取り込みの最中に編集が入ったため中止しました。もう一度お選びください' })
            return
          }
        }
        window.location.reload()
        return
      }
      thawWrites()
      setStatus({ phase: 'conflict', conflict: c, message: 'クラウドの転送待ちのため取り込めませんでした。しばらくして再度お試しください' })
    }
  } finally {
    busy = false
  }
}
