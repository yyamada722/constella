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
  pull: (expectedGen: number) => Promise<{ ok: boolean; error?: string; manifest?: SyncManifest }>
  listRemoteMedia: () => Promise<string[]>
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

export function initFolderSync(opts: { getLiveRefs: () => Promise<string[]> }): void {
  getLiveRefs = opts.getLiveRefs
}

// ── 実編集の記録 ──
// dirty は etag ではなく「実際の編集があったか」で判定する(起動のたびの
// 再シリアライズでニセ競合を出さないため)。編集のたびに editSeq を進め、
// push 完了時に「push 開始以降に新たな編集が無い」場合だけフラグを下ろす。
let editSeq = 0
let dirtyMarked = false

/** 状態への実編集(ユーザー操作)が起きたときに呼ぶ。 */
export function markFolderSyncEdit(): void {
  editSeq++
  if (dirtyMarked) return
  dirtyMarked = true
  syncApi()?.setDirty(true).catch(() => { dirtyMarked = false })
}

async function clearDirtyIfNoNewEdits(api: SyncApi, seqAtPush: number): Promise<void> {
  if (editSeq !== seqAtPush) return // push 中に編集された → dirty のまま(次で再送)
  dirtyMarked = false
  await api.setDirty(false).catch(() => { /* 次の push で再確定される */ })
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
      return await doPull(api, m, trigger)
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
  const seqAtPush = editSeq
  await drainSaves()
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

async function doPull(api: SyncApi, m: SyncManifest, trigger: FolderSyncTrigger): Promise<'pulled' | FolderSyncPhase> {
  setStatus({ phase: 'pulling' })
  // これ以降の書き込みが取り込んだ DB を上書きしないよう凍結し、差し替えに
  // 成功したらページごとリロードして全ストアを新データで立ち上げ直す。
  // 起動時(startup)も同じ道を通る: mindtrain ストアがバンドル評価の時点で
  // 旧 DB を sql.js に読み込んでいるため、ファイル差し替えだけでは旧データが
  // メモリに残り、次の自動保存で取り込んだ内容を巻き戻してしまう。
  freezeWrites()
  const r = await api.pull(m.gen)
  if (r.ok) {
    window.location.reload()
    return 'pulled'
  }
  thawWrites()
  setStatus({
    phase: 'waiting',
    message: trigger === 'startup'
      ? 'クラウドの転送完了を待っています(それまでこのPCの内容で表示します)'
      : 'クラウドの転送完了を待っています',
  })
  scheduleRetry(30_000)
  return 'waiting'
}

/** 起動時チェック(hydrate 前)。クラウドが応答しなくても起動を止めない。 */
export async function startupFolderSync(): Promise<void> {
  const api = syncApi()
  if (!api) return
  await Promise.race([
    checkFolderSync('startup'),
    new Promise<void>(resolve => setTimeout(resolve, 25_000)),
  ]).catch(() => { /* 同期の失敗で起動を壊さない */ })
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
      const seqAtPush = editSeq
      await api.backupConflict('remote') // 負けるフォルダ側の DB を退避
      await drainSaves()
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
      await api.backupConflict('local') // 負けるこのPCの DB を退避
      freezeWrites()
      const r = await api.pull(c.remoteGen)
      if (r.ok) {
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
