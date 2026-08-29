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
import { join } from 'path'
import { readFile, writeFile, mkdir, rename, readdir, stat, copyFile, unlink } from 'fs/promises'
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
    return await updateSettings(cur => {
    const next: SyncSettings = { ...cur }
    if (patch.folder !== undefined && patch.folder !== cur.folder) {
      // フォルダが変わったら世代の対応関係もリセットし、旧フォルダから
      // prepare 済みの pull バッファも破棄する。
      prepared = null
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
        const rec = await updateSettings(c => (c.folder === s.folder ? { ...c, lastGen: prev.manifest!.gen, lastLocalEtag: etag, lastSha: sha, lastSyncAt: new Date().toISOString() } : c))
        if (rec.folder !== s.folder) return { ok: false, error: 'changed' }
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
      const rec = await updateSettings(c => (c.folder === s.folder ? { ...c, lastGen: gen, lastLocalEtag: etag, lastSha: sha, lastSyncAt: manifest.pushedAt } : c))
      if (rec.folder !== s.folder) return { ok: false, error: 'changed' }
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
      if (!p || p.gen !== expectedGen || p.folder !== s.folder || prepared !== p) {
        return { ok: false, error: 'not-prepared' }
      }
      // リモート由来なので日次バックアップ枠は消費しない(その日のローカル作業の
      // バックアップが作られなくなるのを避ける)。
      await deps.writeDbAtomic(p.buf, { fromRemote: true })
      const etag = await etagOf(deps.dbPath())
      // pull はローカルの内容を丸ごと置き換えるので、編集フラグも下ろす。
      // writeDbAtomic の間にフォルダが切り替えられていたら記録しない(新しい設定に
      // 旧フォルダの世代を書かない)。この場合ローカル DB は旧フォルダの内容に
      // なっているが、configure が対応関係をリセット済みなので、次の同期チェックが
      // 新フォルダから引き直して自己回復する。
      const rec = await updateSettings(c => (c.folder === p.folder ? { ...c, lastGen: p.manifest.gen, lastLocalEtag: etag, lastSha: p.manifest.dbSha256, lastSyncAt: new Date().toISOString(), dirty: false } : c))
      if (rec.folder !== p.folder) return { ok: false, error: 'changed' }
      await writeBase(p.buf)
      return { ok: true, manifest: p.manifest }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    } finally {
      if (prepared === p) prepared = null
    }
  })

  ipcMain.handle('sync:pull-discard', async () => { prepared = null })

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
      const names = (await readdir(dir)).filter(n => /^constella-conflict-\d{8}-\d{6}\.db$/.test(n))
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
    const name = `constella-conflict-${stamp}.db`
    try {
      await mkdir(dir, { recursive: true })
      await withDeadline(copyFile(src, join(dir, name)), 60_000)
    } catch { return null }
    try {
      const names = (await readdir(dir)).filter(n => /^constella-conflict-\d{8}-\d{6}\.db$/.test(n)).sort()
      for (const n of names.slice(0, Math.max(0, names.length - CONFLICT_BACKUP_KEEP))) {
        try { await unlink(join(dir, n)) } catch { /* best-effort prune */ }
      }
    } catch { /* ignore */ }
    return name
  })
}
