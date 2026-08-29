// ── 他マシンとの同期(同期フォルダ方式) — main 側のファイル入出力 ──
// OneDrive/Dropbox/NAS などユーザーが選んだ「同期フォルダ」を媒介に、
//   constella-sync.json … マニフェスト(世代番号 gen・押した端末・DBのSHA-256)
//   constella.db        … DB スナップショット(丸ごと)
//   media/<id>.<ext>    … メディア実体(追加専用 — 上書き・削除はしない)
// を運ぶ。行レベルのマージはしない(1台ずつ使う前提)。push/pull/競合の判定は
// レンダラー(persistence/folderSync.ts)が行い、ここはフォルダ内に閉じた
// ファイル操作と検証だけを担当する。
//
// クラウドドライブはファイルを任意の順序で転送するため、「マニフェストだけ先に
// 届いて DB がまだ古い」瞬間がある。マニフェストに DB の SHA-256 を焼き込み、
// pull 時に実ファイルと照合することで、不整合スナップショットを取り込まない。
import { app, ipcMain, dialog, BrowserWindow } from 'electron'
import { join, resolve } from 'path'
import { readFile, writeFile, mkdir, rename, readdir, stat, copyFile, unlink, realpath } from 'fs/promises'
import { createHash, randomBytes } from 'crypto'
import { hostname } from 'os'

export interface SyncManifest {
  app: 'constella'
  version: 1
  gen: number // Lamport 世代番号 — push のたびに +1
  deviceId: string
  deviceName: string
  pushedAt: string
  dbSize: number
  dbSha256: string
}

// このマシンの同期状態。userData/sync.json に永続化。
interface SyncSettings {
  folder: string | null
  enabled: boolean
  deviceId: string
  deviceName: string
  lastGen: number // このマシンが最後に push/pull した世代
  lastLocalEtag: string // その時点のローカル DB の etag(mtime-size)
  lastSha: string // その時点の DB の SHA-256 — 同時 push 事故(クラウドの競合コピー)の検知用
  lastSyncAt: string | null
  // 前回の同期以降に「実際の編集」があったか。レンダラーが編集時に立て、push 完了で
  // 下ろす(pull は main が下ろす)。etag ではなくこのフラグで dirty を判定する —
  // 起動のたびの再シリアライズで DB ファイルが書き換わっても、編集していなければ
  // クリーン扱いにするため(でないと A終了→B編集→A起動 の正常フローが毎回ニセ競合になる)。
  dirty: boolean
}

interface SyncDeps {
  dbPath: () => string
  backupsDir: () => string
  writeDbAtomic: (buf: Buffer, opts?: { fromRemote?: boolean }) => Promise<void>
  getMainWindow: () => BrowserWindow | null
}

const MANIFEST_NAME = 'constella-sync.json'
const DB_NAME = 'constella.db'
const MEDIA_DIR = 'media'
const MEDIA_NAME_RE = /^[A-Za-z0-9]+\.[a-z0-9]{1,8}$/
const MEDIA_READ_MAX = 512 * 1024 * 1024
const CONFLICT_BACKUP_KEEP = 5

// メディアはフォルダ内で人間が見ても分かるよう MIME 由来の拡張子を付ける。
// 未知の MIME は .bin(復元時は octet-stream 扱い — 表示側は DB 側の mime を使う)。
const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/avif': 'avif', 'image/bmp': 'bmp', 'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-matroska': 'mkv', 'video/ogg': 'ogv',
  'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/flac': 'flac', 'audio/aac': 'aac',
  'text/plain': 'txt', 'application/json': 'json', 'application/zip': 'zip',
}
const MIME_BY_EXT: Record<string, string> = Object.fromEntries(Object.entries(EXT_BY_MIME).map(([m, e]) => [e, m]))

// クラウドフォルダは NAS 同様に「応答しない」ことがあり、await が UI を道連れに
// するので全 I/O に締め切りを付ける(タイムアウトは reject — 呼び出し側で失敗扱い)。
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms)
    work.then(v => { clearTimeout(timer); resolve(v) }, e => { clearTimeout(timer); reject(e) })
  })
}

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex')
const etagOf = async (p: string): Promise<string> => {
  try { const s = await stat(p); return `${Math.floor(s.mtimeMs)}-${s.size}` } catch { return '' }
}

// tmp に書いて rename — クラウドクライアントに書きかけを拾われない & 中断で壊れない。
async function writeAtomic(target: string, data: Buffer | string): Promise<void> {
  const tmp = `${target}.tmp-${randomBytes(4).toString('hex')}`
  await writeFile(tmp, data)
  await rename(tmp, target)
}

export function initSync(deps: SyncDeps): void {
  const settingsPath = (): string => join(app.getPath('userData'), 'sync.json')
  // 最後に push/pull した世代の DB スナップショット。競合時の「項目単位マージ」の
  // 共通祖先(base)になる — これがあると 相手だけ/自分だけ/両方 の変更を分類できる。
  const basePath = (): string => join(app.getPath('userData'), 'sync-base.db')
  async function writeBase(buf: Buffer): Promise<void> {
    try { await writeAtomic(basePath(), buf) } catch { /* base は best-effort(無ければ全体択一にフォールバック) */ }
  }

  async function loadSettings(): Promise<SyncSettings> {
    let raw: Partial<SyncSettings> = {}
    try { raw = JSON.parse(await readFile(settingsPath(), 'utf8')) } catch { /* first run */ }
    return {
      folder: typeof raw.folder === 'string' ? raw.folder : null,
      enabled: !!raw.enabled,
      deviceId: typeof raw.deviceId === 'string' && raw.deviceId ? raw.deviceId : randomBytes(8).toString('hex'),
      deviceName: typeof raw.deviceName === 'string' && raw.deviceName ? raw.deviceName : hostname(),
      lastGen: typeof raw.lastGen === 'number' ? raw.lastGen : 0,
      lastLocalEtag: typeof raw.lastLocalEtag === 'string' ? raw.lastLocalEtag : '',
      lastSha: typeof raw.lastSha === 'string' ? raw.lastSha : '',
      lastSyncAt: typeof raw.lastSyncAt === 'string' ? raw.lastSyncAt : null,
      dirty: !!raw.dirty,
    }
  }
  async function saveSettings(s: SyncSettings): Promise<void> {
    // 失敗は投げる。握り潰すと sync:set-dirty が成功を装い、レンダラーの
    // dirtyMarked だけ立って永続側は dirty=false のまま — その状態でアプリを
    // 終えると、次回のリモート pull が未送信の編集を無警告で上書きする。
    // (レンダラーは setDirty の reject で dirtyMarked を戻し、次の編集で再試行する)
    await writeFile(settingsPath(), JSON.stringify(s, null, 2))
  }

  // sync.json への read-modify-write は必ずここを通す。ハンドラごとに
  // loadSettings → 長い await → saveSettings とやると、その間に走った別ハンドラの
  // 変更(dirty=true やフォルダ切替)を古いスナップショットで塗り潰してしまう。
  // 読み出しと書き込みをひと続きにして到着順に直列化する。
  let settingsLock: Promise<unknown> = Promise.resolve()
  function updateSettings(mutate: (s: SyncSettings) => SyncSettings): Promise<SyncSettings> {
    const run = settingsLock.then(async () => {
      const cur = await loadSettings()
      const next = mutate(cur)
      await saveSettings(next)
      return next
    })
    settingsLock = run.then(() => undefined, () => undefined)
    return run
  }

  // フォルダ設定の同一性判定。大文字小文字(Windows)・区切り・末尾スラッシュ等の
  // 表記ゆれで「変わった」と誤判定すると、push/pull の完了記録が不必要に破棄され、
  // 成功した push が記録されずニセ競合になる。正規化して比べる。
  const sameFolder = (a: string | null, b: string | null): boolean => {
    if (!a || !b) return a === b
    const na = resolve(a)
    const nb = resolve(b)
    return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb
  }

  const folderDbPath = (folder: string): string => join(folder, DB_NAME)
  const mediaDirPath = (folder: string): string => join(folder, MEDIA_DIR)

  async function readManifest(folder: string): Promise<{ manifest: SyncManifest | null; unreadable: boolean }> {
    let raw: string
    try {
      raw = await withDeadline(readFile(join(folder, MANIFEST_NAME), 'utf8'), 15_000)
    } catch (e) {
      // ENOENT = まだ一度も push されていないフォルダ(正常)。それ以外は読めない扱い。
      return { manifest: null, unreadable: (e as NodeJS.ErrnoException).code !== 'ENOENT' }
    }
    try {
      const m = JSON.parse(raw) as SyncManifest
      if (m && m.app === 'constella' && typeof m.gen === 'number' && m.gen > 0 && typeof m.dbSha256 === 'string') {
        return { manifest: m, unreadable: false }
      }
    } catch { /* 部分的に転送済みの JSON 等 */ }
    return { manifest: null, unreadable: true }
  }

  ipcMain.handle('sync:get', async () => await loadSettings())

  // 「前回同期以降に実編集があった」フラグ。レンダラーが編集時に true、
  // push 完了(かつ push 後に新たな編集が無いと確認)で false にする。
  ipcMain.handle('sync:set-dirty', async (_e, dirty: boolean) => {
    await updateSettings(s => (s.dirty === !!dirty ? s : { ...s, dirty: !!dirty }))
  })

  ipcMain.handle('sync:configure', async (_e, patch: { folder?: string | null; enabled?: boolean; deviceName?: string }) => {
    // フォルダは保存前に実パスへ正規化する。ドライブ割当(Z:\team)と UNC
    // (\\server\share\team)のような別表記は resolve では同一視できないため、
    // OS に実体を聞く。以後の比較(sameFolder)は正規化済み同士の字句比較で足りる。
    if (typeof patch.folder === 'string') {
      try { patch.folder = await realpath(patch.folder) } catch { /* 未作成パス等はそのまま */ }
    }
    let folderChanged = false
    const next = await updateSettings(cur => {
    const next: SyncSettings = { ...cur }
    if (patch.folder !== undefined && !sameFolder(patch.folder, cur.folder)) {
      // フォルダが変わったら世代の対応関係もリセットし、旧フォルダから
      // prepare 済みの pull バッファも破棄する。
      prepared = null
      lastPullUndo = null
      folderChanged = true
      next.folder = patch.folder
      next.lastGen = 0
      next.lastLocalEtag = ''
      next.lastSha = ''
      next.lastSyncAt = null
      next.dirty = false
    }
    if (patch.enabled !== undefined) next.enabled = !!patch.enabled
    if (patch.deviceName !== undefined && patch.deviceName.trim()) next.deviceName = patch.deviceName.trim().slice(0, 40)
    return next
    })
    if (folderChanged) {
      // 旧フォルダの共通祖先(sync-base)を残さない。lastSha を空にした状態では
      // read-base が SHA 照合をしないため、残すと新フォルダの競合で旧フォルダの
      // DB が3方向マージの祖先として使われてしまう。
      await unlink(basePath()).catch(() => { /* 無ければそれでよい */ })
    }
    return next
  })

  ipcMain.handle('sync:pick-folder', async (): Promise<string | null> => {
    const win = deps.getMainWindow()
    if (!win || win.isDestroyed()) return null
    const r = await dialog.showOpenDialog(win, {
      title: '同期フォルダを選択(OneDrive / Dropbox / NAS など)',
      properties: ['openDirectory', 'createDirectory'],
    })
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
  })

  // 判定に必要な材料をひとまとめに返す(判定そのものはレンダラー側)。
  ipcMain.handle('sync:inspect', async () => {
    const s = await loadSettings()
    const localEtag = await etagOf(deps.dbPath())
    const out = {
      configured: !!s.folder,
      enabled: s.enabled,
      folder: s.folder,
      deviceName: s.deviceName,
      lastGen: s.lastGen,
      lastSha: s.lastSha,
      lastSyncAt: s.lastSyncAt,
      localEtag,
      dirty: s.dirty,
      folderOk: false,
      manifest: null as SyncManifest | null,
      manifestUnreadable: false,
    }
    if (!s.folder) return out
    try { out.folderOk = await withDeadline(stat(s.folder).then(x => x.isDirectory()), 8_000) } catch { out.folderOk = false }
    if (!out.folderOk) return out
    const m = await readManifest(s.folder)
    out.manifest = m.manifest
    out.manifestUnreadable = m.unreadable
    return out
  })

  // ローカル DB スナップショットをフォルダへ書き、マニフェストを最後に書く
  // (マニフェストの rename がコミットポイント)。
  ipcMain.handle('sync:push', async (_e, gen: number, expectPrev: number): Promise<{ ok: boolean; error?: string; manifest?: SyncManifest }> => {
    const s = await loadSettings()
    if (!s.folder || typeof gen !== 'number' || gen <= 0) return { ok: false, error: 'not-configured' }
    try {
      // 判定時点からフォルダ側が進んでいたら押さない(他マシンの push を上書きしない)。
      const prev = await readManifest(s.folder)
      const prevGen = prev.manifest ? prev.manifest.gen : 0
      if (typeof expectPrev === 'number' && prevGen !== expectPrev) return { ok: false, error: 'changed' }
      // etag は読み出し前に取る: 読んだバイト列より新しい保存の etag を「同期済み」と
      // 記録すると、その保存分の push が漏れる(逆向きのズレは余分な push で済む)。
      const etag = await etagOf(deps.dbPath())
      const buf = await withDeadline(readFile(deps.dbPath()), 30_000)
      if (buf.length === 0) return { ok: false, error: 'empty-db' }
      const sha = sha256(buf)
      // フォルダ側と中身が同一なら世代を上げず記録だけ更新(起動のたびの
      // 再シリアライズで gen が空回りしないように)。
      if (prev.manifest && prev.manifest.dbSha256 === sha) {
        // 待っている間にフォルダが切り替えられていたら、旧フォルダの世代を
        // 新しい設定へ記録しない(configure がリセットした対応関係を汚すため)。
        const rec = await updateSettings(c => (sameFolder(c.folder, s.folder) ? { ...c, lastGen: prev.manifest!.gen, lastLocalEtag: etag, lastSha: sha, lastSyncAt: new Date().toISOString() } : c))
        if (!sameFolder(rec.folder, s.folder)) return { ok: false, error: 'changed' }
        // base も揃えておく。ここを飛ばすと lastSha と sync-base.db が食い違い、
        // 以後の競合で項目単位マージが使えなくなる(全体択一に劣化する)。
        await writeBase(buf)
        return { ok: true, manifest: prev.manifest }
      }
      await mkdir(s.folder, { recursive: true })
      await withDeadline(writeAtomic(folderDbPath(s.folder), buf), 120_000)
      const manifest: SyncManifest = {
        app: 'constella', version: 1, gen,
        deviceId: s.deviceId, deviceName: s.deviceName,
        pushedAt: new Date().toISOString(), dbSize: buf.length, dbSha256: sha,
      }
      await withDeadline(writeAtomic(join(s.folder, MANIFEST_NAME), JSON.stringify(manifest, null, 2)), 30_000)
      // 押している間にフォルダが切り替えられていたら記録しない(この push 自体は
      // 旧フォルダに残るだけで無害。新フォルダの設定に旧フォルダの世代/SHA を
      // 書き込むと、以後の判定と sync-base.db が全部ずれる)。
      const rec = await updateSettings(c => (sameFolder(c.folder, s.folder) ? { ...c, lastGen: gen, lastLocalEtag: etag, lastSha: sha, lastSyncAt: manifest.pushedAt } : c))
      if (!sameFolder(rec.folder, s.folder)) return { ok: false, error: 'changed' }
      await writeBase(buf)
      return { ok: true, manifest }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // フォルダのスナップショットをローカル DB に取り込む。SHA 照合で「クラウドが
  // まだ運びかけの DB」を拒否(error:'inconsistent' → レンダラーは後で再試行)。
  // pull は2段構え。フォルダからの読み出しはクラウド次第で数十秒かかりうるので、
  // その長い I/O(prepare)と、ローカルDBの差し替え(commit)を分ける。
  // レンダラーは prepare 完了後・commit 直前に「その間にユーザーが編集していないか」
  // を確認でき、編集があれば差し替えずに競合として扱える(黙って捨てない)。
  let prepared: { gen: number; buf: Buffer; manifest: SyncManifest; folder: string } | null = null
  // 直近の pull-commit を巻き戻すための控え。レンダラーが commit 完了直後に
  // 「commit の最中に編集が入っていた」と判明した場合にだけ使う(リロードすると
  // React メモリ上にしか無いその編集が消えるため、差し替え前へ戻して競合にする)。
  let lastPullUndo: { folder: string; before: Buffer | null; hadDb: boolean; prev: SyncSettings; prevBase: Buffer | null } | null = null

  ipcMain.handle('sync:pull-prepare', async (_e, expectedGen: number, deadlineMs?: number): Promise<{ ok: boolean; error?: string; manifest?: SyncManifest }> => {
    const s = await loadSettings()
    if (!s.folder) return { ok: false, error: 'not-configured' }
    try {
      const { manifest } = await readManifest(s.folder)
      if (!manifest || manifest.gen !== expectedGen) return { ok: false, error: 'changed' }
      // 起動時はレンダラーが待てる時間より短い締め切りを渡してくる。長い既定値のまま
      // だと「起動チェックを見捨てた後に裏で成功して DB を差し替える」窓ができる。
      const readDeadline = typeof deadlineMs === 'number' && deadlineMs > 0 ? Math.min(deadlineMs, 120_000) : 120_000
      const buf = await withDeadline(readFile(folderDbPath(s.folder)), readDeadline)
      if (buf.length !== manifest.dbSize || sha256(buf) !== manifest.dbSha256) return { ok: false, error: 'inconsistent' }
      if (!buf.subarray(0, 16).equals(Buffer.from('SQLite format 3\0'))) return { ok: false, error: 'inconsistent' }
      prepared = { gen: manifest.gen, buf, manifest, folder: s.folder }
      return { ok: true, manifest }
    } catch (e) {
      prepared = null
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('sync:pull-commit', async (_e, expectedGen: number): Promise<{ ok: boolean; error?: string; manifest?: SyncManifest }> => {
    // commit を試みた時点でバッファは消費する(どの経路で抜けても保持し続けない)。
    const p = prepared
    try {
      const s = await loadSettings()
      if (!s.folder || !s.enabled) return { ok: false, error: 'not-configured' }
      // prepare したフォルダと今のフォルダが違えば無効。さらに configure はフォルダ
      // 変更時に prepared を破棄するので、`prepared !== p` の検査で「この判定より
      // 後に設定が切り替わっていない」ことも保証できる — ここから writeDbAtomic の
      // 呼び出しまで await が無いため、シングルスレッドの main では configure が
      // 割り込む余地がない(割り込めるのは await 境界だけ)。
      if (!p || p.gen !== expectedGen || !sameFolder(p.folder, s.folder)) {
        return { ok: false, error: 'not-prepared' }
      }
      // 差し替え前のローカル DB を控える。差し替え後に完了記録を書けなかった場合
      // (sync.json の書き込み失敗・フォルダ切替)、レンダラーは旧 state のまま
      // なので、次の autosave が pull 結果を上書きして「半分だけ pull」の不整合に
      // なる — その場合は DB ごと元に戻して、なかったことにする。
      // ENOENT(初回起動で DB 未作成)は「無かった状態へ戻す=削除」で対応できる
      // が、読めるはずの DB が読めない場合は差し替え自体を始めない(戻せないため)。
      let before: Buffer | null = null
      let hadDb = true
      try {
        before = await readFile(deps.dbPath())
      } catch (err) {
        hadDb = false
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          return { ok: false, error: 'local-db-unreadable' }
        }
      }
      // ↑の readFile の await 中に configure が走った可能性があるため、書き込みの
      // 直前にもう一度検証する。configure はフォルダ変更で prepared を破棄するので
      // `prepared === p` の確認で足り、ここから writeDbAtomic 呼び出しまで await が
      // 無い(= main のイベントループ上で configure が割り込めない)ことが保証。
      const s2 = await updateSettings(c => c) // 識別 mutate = settingsLock に並んで読む
      if (prepared !== p || !sameFolder(p.folder, s2.folder) || !s2.enabled) {
        return { ok: false, error: 'not-prepared' }
      }
      // リモート由来なので日次バックアップ枠は消費しない(その日のローカル作業の
      // バックアップが作られなくなるのを避ける)。
      await deps.writeDbAtomic(p.buf, { fromRemote: true })
      try {
        const etag = await etagOf(deps.dbPath())
        // pull はローカルの内容を丸ごと置き換えるので、編集フラグも下ろす。
        const rec = await updateSettings(c => (sameFolder(c.folder, p.folder) ? { ...c, lastGen: p.manifest.gen, lastLocalEtag: etag, lastSha: p.manifest.dbSha256, lastSyncAt: new Date().toISOString(), dirty: false } : c))
        if (!sameFolder(rec.folder, p.folder)) throw new Error('changed')
        // undo 用に、上書き前の sync-base も控える(戻さないと lastSha と食い違い、
        // undo が作る競合で項目単位マージが使えなくなる)。
        const prevBase = await readFile(basePath()).catch(() => null)
        await writeBase(p.buf)
        // base の読み書きも await なので、その間のフォルダ切替を最後にもう一度
        // 確認してから成功を報告する。切り替わっていたら throw して DB を巻き戻す
        // (configure 側が新フォルダ用に設定をリセット済みなので、設定はそのまま)。
        // 素の loadSettings ではなく識別 mutate で読む — settingsLock に並ぶため、
        // 書き込み途中の configure を追い越して古いフォルダを読むことがない。
        const s3 = await updateSettings(c => c)
        if (!sameFolder(s3.folder, p.folder)) throw new Error('changed')
        lastPullUndo = { folder: p.folder, before, hadDb, prev: s2, prevBase }
        return { ok: true, manifest: p.manifest }
      } catch (e) {
        // 元に戻す: DB があったならそのバイト列へ、無かったなら削除して未作成状態へ。
        if (before) await deps.writeDbAtomic(before, { fromRemote: true }).catch(() => { /* 復旧チェーンに任せる */ })
        else if (!hadDb) await unlink(deps.dbPath()).catch(() => { /* 復旧チェーンに任せる */ })
        throw e
      }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    } finally {
      if (prepared === p) prepared = null
    }
  })

  ipcMain.handle('sync:pull-discard', async () => { prepared = null })

  // pull-commit の巻き戻し(直後にのみ有効)。DB・sync-base・sync.json を差し替え前へ
  // 戻す。dirty は true に立てる — 巻き戻す理由は「未保存の編集が居る」ことなので、
  // 復帰後の autosave と競合判定がその編集を確実に拾うようにする。
  ipcMain.handle('sync:pull-undo', async (): Promise<{ ok: boolean; dbRestored?: boolean; reason?: 'no-snapshot' }> => {
    const u = lastPullUndo
    // スナップショットが無い=commit と undo の間に configure が走った(または
    // 二重呼び出し)。「戻せない」ではなく「戻す対象がもう無効」なので、レンダラー
    // には理由を返し、凍結リロード(=編集の放棄)ではなくメモリ続行を選ばせる。
    if (!u) return { ok: false, reason: 'no-snapshot' }
    // 巻き戻しの間にフォルダが切り替えられていたら中止(旧フォルダの DB を新しい
    // 設定の下へ復元しない)。識別 mutate で読む= settingsLock に並ぶため、書き
    // 込み途中の configure を追い越さない。ここから writeDbAtomic まで await を
    // 挟まないため、この検査の後に configure が割り込む余地はない。
    const s = await updateSettings(c => c)
    if (!sameFolder(u.folder, s.folder)) { lastPullUndo = null; return { ok: false, reason: 'no-snapshot' } }
    let dbRestored = false
    try {
      if (u.before) await deps.writeDbAtomic(u.before, { fromRemote: true })
      else if (!u.hadDb) await unlink(deps.dbPath()).catch(() => { /* 元々無かった */ })
      dbRestored = true
      // base 復元の前にもフォルダを再確認する。DB 復元の await 中に切り替わって
      // いた場合、旧フォルダの base を共有の sync-base.db へ書くと、新フォルダの
      // 競合で旧フォルダの DB が共通祖先に化ける(configure 側の base 削除とも
      // 競合しない — 不一致ならここで書かない)。
      const sMid = await updateSettings(c => c)
      if (!sameFolder(sMid.folder, u.folder)) return { ok: false, dbRestored }
      try {
        if (u.prevBase) await writeAtomic(basePath(), u.prevBase)
        else await unlink(basePath()).catch(() => { /* 元々無かった */ })
      } catch { /* base は best-effort(無ければ全体択一へ劣化するだけ) */ }
      const restore = (c: SyncSettings): SyncSettings => (sameFolder(c.folder, u.folder)
        ? { ...c, lastGen: u.prev.lastGen, lastLocalEtag: u.prev.lastLocalEtag, lastSha: u.prev.lastSha, lastSyncAt: u.prev.lastSyncAt, dirty: true }
        : c)
      let rec: SyncSettings
      try {
        rec = await updateSettings(restore)
      } catch {
        // スナップショットは未破棄のまま一度だけ再試行(1回目が一過性の失敗の場合)。
        rec = await updateSettings(restore)
      }
      // DB 復元の await 中にフォルダが切り替えられていたら restore は素通りして
      // いる(mutate が設定を変えずに返す)。成功と報告すると、旧フォルダの状態を
      // 新フォルダの設定下で競合として扱ってしまう — dbRestored 扱いに落とす
      // (レンダラーはリロードせずメモリ状態のまま続行し、dirty を立て直す)。
      if (!sameFolder(rec.folder, u.folder)) return { ok: false, dbRestored }
      lastPullUndo = null
      return { ok: true }
    } catch {
      // 「DB だけ戻って設定は同期済みのまま」という中途半端が起きた場合、
      // ここでリロードさせてはいけない(旧DB+同期済みの記録で走り出すと、後の
      // 編集が旧内容を push しうる)。dbRestored を返し、レンダラー側はメモリ
      // 状態のまま続行してエラー表示する。スナップショットは保持(configure/
      // 次の commit が破棄する)。
      return { ok: false, dbRestored }
    }
  })

  // 項目単位マージ用: base スナップショットと、フォルダ側 DB の生バイト読み出し。
  ipcMain.handle('sync:read-base', async (): Promise<Buffer | null> => {
    const s = await loadSettings()
    try {
      const buf = await withDeadline(readFile(basePath()), 30_000)
      // base は「lastSha の世代」のはず — 食い違うなら信用しない(別フォルダ切替直後など)。
      if (s.lastSha && sha256(buf) !== s.lastSha) return null
      return buf
    } catch { return null }
  })

  ipcMain.handle('sync:read-folder-db', async (): Promise<{ ok: boolean; error?: string; gen?: number; bytes?: Buffer; deviceName?: string }> => {
    const s = await loadSettings()
    if (!s.folder) return { ok: false, error: 'not-configured' }
    try {
      const { manifest } = await readManifest(s.folder)
      if (!manifest) return { ok: false, error: 'no-manifest' }
      const buf = await withDeadline(readFile(folderDbPath(s.folder)), 120_000)
      if (buf.length !== manifest.dbSize || sha256(buf) !== manifest.dbSha256) return { ok: false, error: 'inconsistent' }
      return { ok: true, gen: manifest.gen, bytes: buf, deviceName: manifest.deviceName }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // 競合バックアップ(退避したDB)が参照している idb: の id 一覧。
  // 退避はDBファイルだけをコピーするのに対し、メディア実体はレンダラーの
  // IndexedDB にあるため、参照が生存集合から外れると sweep の7日猶予後に消える。
  // 「退避したから安全」と案内している以上、これらは掃除対象から守る必要がある。
  // SQLite を解釈せず、ファイル全体から idb:<id> を拾う(DELETE 済み領域を拾って
  // 余分に守ることはあっても、生きている参照を取りこぼすことはない)。
  ipcMain.handle('sync:backup-media-refs', async (): Promise<string[]> => {
    const out = new Set<string>()
    try {
      const dir = deps.backupsDir()
      const names = (await readdir(dir)).filter(n => /^constella-conflict-\d{8}-\d{6}(?:-[0-9a-f]{6})?\.db$/.test(n))
      for (const n of names) {
        try {
          const buf = await withDeadline(readFile(join(dir, n)), 30_000)
          for (const m of buf.toString('latin1').matchAll(/idb:([A-Za-z0-9]+)/g)) out.add(m[1])
        } catch { /* 読めない退避はスキップ */ }
      }
    } catch { /* db-backups が無い */ }
    return [...out]
  })

  ipcMain.handle('sync:list-remote-media', async (): Promise<string[]> => {
    const s = await loadSettings()
    if (!s.folder) return []
    try {
      const names = await withDeadline(readdir(mediaDirPath(s.folder)), 15_000)
      return names.filter(n => MEDIA_NAME_RE.test(n))
    } catch { return [] }
  })

  ipcMain.handle('sync:read-remote-media', async (_e, name: string): Promise<{ bytes: Buffer; mime: string } | null> => {
    const s = await loadSettings()
    if (!s.folder || typeof name !== 'string' || !MEDIA_NAME_RE.test(name)) return null
    const p = join(mediaDirPath(s.folder), name)
    try {
      const meta = await withDeadline(stat(p), 8_000)
      if (!meta.isFile() || meta.size > MEDIA_READ_MAX) return null
      const bytes = await withDeadline(readFile(p), 120_000)
      const ext = name.slice(name.lastIndexOf('.') + 1)
      return { bytes, mime: MIME_BY_EXT[ext] ?? 'application/octet-stream' }
    } catch { return null }
  })

  ipcMain.handle('sync:write-remote-media', async (_e, id: string, bytes: Uint8Array, mime: string): Promise<boolean> => {
    const s = await loadSettings()
    if (!s.folder || typeof id !== 'string' || !/^[A-Za-z0-9]+$/.test(id) || !bytes?.length) return false
    const ext = EXT_BY_MIME[String(mime)] ?? 'bin'
    try {
      const dir = mediaDirPath(s.folder)
      await mkdir(dir, { recursive: true })
      const target = join(dir, `${id}.${ext}`)
      // 追加専用: 既にあれば書かない(id は不変なので中身も同一のはず)。
      try { await stat(target); return true } catch { /* not yet */ }
      await withDeadline(writeAtomic(target, Buffer.from(bytes)), 120_000)
      return true
    } catch { return false }
  })

  // 競合解決で「負けた側」の DB を db-backups へ退避 — どちらを選んでもデータは残る。
  ipcMain.handle('sync:backup-conflict', async (_e, source: 'local' | 'remote'): Promise<string | null> => {
    const s = await loadSettings()
    const src = source === 'local' ? deps.dbPath() : s.folder ? folderDbPath(s.folder) : null
    if (!src) return null
    const d = new Date()
    const pad = (n: number): string => String(n).padStart(2, '0')
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
    const dir = deps.backupsDir()
    // 同じ秒に2回退避しても上書きしないよう、乱数サフィックスで一意化する
    // (先の退避が「選ばれなかった側」の唯一の控えであることがある)。
    const name = `constella-conflict-${stamp}-${randomBytes(3).toString('hex')}.db`
    try {
      await mkdir(dir, { recursive: true })
      if (source === 'remote') {
        // クラウドがマニフェストだけ先に運んだ瞬間は、フォルダの DB がまだ旧世代
        // または運びかけのことがある。未検証のまま退避を成立させると、「相手側は
        // 退避済み」という約束のもとで push がフォルダを上書きし、約束の実体が
        // 壊れたファイルになる — SHA 照合に通った検証済みバイトから書く。
        const { manifest } = await readManifest(s.folder!)
        const buf = await withDeadline(readFile(src), 60_000)
        if (!manifest || buf.length !== manifest.dbSize || sha256(buf) !== manifest.dbSha256) return null
        await writeFile(join(dir, name), buf)
      } else {
        await withDeadline(copyFile(src, join(dir, name)), 60_000)
      }
    } catch { return null }
    try {
      const names = (await readdir(dir)).filter(n => /^constella-conflict-\d{8}-\d{6}(?:-[0-9a-f]{6})?\.db$/.test(n)).sort()
      for (const n of names.slice(0, Math.max(0, names.length - CONFLICT_BACKUP_KEEP))) {
        try { await unlink(join(dir, n)) } catch { /* best-effort prune */ }
      }
    } catch { /* ignore */ }
    return name
  })
}
