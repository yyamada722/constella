// Production persistence backed by a real SQLite database (sql.js / WASM).
//
// The serialized database is stored:
//   - in Electron: as a real .db file on disk, via the main process (window.api.db)
//   - in the browser preview (no Electron): in IndexedDB
//
// sql.js runs in the renderer in both cases, so the whole load/save cycle is
// identical and verifiable in the preview. Large binaries (images/PDF/video) are
// NOT kept here — they live in the IndexedDB media store and are referenced by
// `idb:` URLs (see ./media.ts) so the DB stays small and cheap to re-serialize.
import initSqlJs, { Database } from 'sql.js'
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url'
import { isRemote } from './runtime'
import type { AppState } from '../store'
import type {
  Note, NoteAttachment, NoteFolder, FileItem, FileVersion, FileFolder, Project, Task, ResearchItem, ResearchFolder, MasterProject, Sketch, SketchStroke, AIConversation, AIMessage,
  CanvasTab, CanvasBoard, CanvasCard, CanvasArrow, CanvasGroup, CanvasStroke, CanvasLabel, CanvasRail, CanvasStation, CardPage, Bookmark, Flow, FlowNode, FlowEdge, FlowGroup, Plan, PlanFolder, TimelineBand,
} from '../types'
import { generateId } from '../utils'

const SCHEMA_VERSION = 1

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS master_projects (ord INTEGER, id TEXT PRIMARY KEY, name TEXT, createdAt TEXT, archivedAt TEXT, folder TEXT);
CREATE TABLE IF NOT EXISTS notes (ord INTEGER, id TEXT PRIMARY KEY, masterProjectId TEXT, title TEXT, content TEXT, tags TEXT, createdAt TEXT, updatedAt TEXT, folderId TEXT, pinned INTEGER, archivedAt TEXT, shared INTEGER, refByMasterIds TEXT, attachments TEXT);
CREATE TABLE IF NOT EXISTS note_folders (ord INTEGER, id TEXT PRIMARY KEY, masterProjectId TEXT, name TEXT, createdAt TEXT, parentId TEXT, color TEXT);
CREATE TABLE IF NOT EXISTS files (ord INTEGER, id TEXT PRIMARY KEY, masterProjectId TEXT, linkedMasterIds TEXT, name TEXT, url TEXT, mime TEXT, size REAL, tags TEXT, folderId TEXT, comment TEXT, versions TEXT, createdAt TEXT);
CREATE TABLE IF NOT EXISTS file_folders (ord INTEGER, id TEXT PRIMARY KEY, masterProjectId TEXT, name TEXT, createdAt TEXT, parentId TEXT, color TEXT);
CREATE TABLE IF NOT EXISTS projects (ord INTEGER, id TEXT PRIMARY KEY, masterProjectId TEXT, name TEXT, description TEXT, createdAt TEXT, color TEXT);
CREATE TABLE IF NOT EXISTS tasks (ord INTEGER, id TEXT PRIMARY KEY, projectId TEXT, title TEXT, description TEXT, status TEXT, tags TEXT, createdAt TEXT, startDate TEXT, endDate TEXT, parentId TEXT, linkedNoteIds TEXT, priority INTEGER, completedAt TEXT, shared INTEGER, sharedAlias TEXT, fileIds TEXT);
CREATE TABLE IF NOT EXISTS research (ord INTEGER, id TEXT PRIMARY KEY, masterProjectId TEXT, title TEXT, url TEXT, description TEXT, tags TEXT, category TEXT, createdAt TEXT, folderId TEXT, archivedAt TEXT);
CREATE TABLE IF NOT EXISTS research_folders (ord INTEGER, id TEXT PRIMARY KEY, masterProjectId TEXT, name TEXT, createdAt TEXT, parentId TEXT, color TEXT);
CREATE TABLE IF NOT EXISTS sketches (ord INTEGER, id TEXT PRIMARY KEY, masterProjectId TEXT, name TEXT, strokes TEXT, createdAt TEXT, updatedAt TEXT);
CREATE TABLE IF NOT EXISTS flows (ord INTEGER, id TEXT PRIMARY KEY, masterProjectId TEXT, name TEXT, nodes TEXT, edges TEXT, groups TEXT, createdAt TEXT, updatedAt TEXT);
CREATE TABLE IF NOT EXISTS plans (ord INTEGER, id TEXT PRIMARY KEY, masterProjectId TEXT, name TEXT, content TEXT, folder TEXT, folderId TEXT, createdAt TEXT, updatedAt TEXT);
CREATE TABLE IF NOT EXISTS plan_folders (ord INTEGER, id TEXT PRIMARY KEY, masterProjectId TEXT, name TEXT, createdAt TEXT, parentId TEXT, color TEXT);
CREATE TABLE IF NOT EXISTS timeline_bands (ord INTEGER, id TEXT PRIMARY KEY, masterProjectId TEXT, title TEXT, startDate TEXT, endDate TEXT, color TEXT, createdAt TEXT);
CREATE TABLE IF NOT EXISTS ai_conversations (ord INTEGER, id TEXT PRIMARY KEY, masterProjectId TEXT, title TEXT, messages TEXT, createdAt TEXT, updatedAt TEXT);
CREATE TABLE IF NOT EXISTS canvas_boards (ord INTEGER, id TEXT PRIMARY KEY, projectId TEXT, name TEXT, color TEXT, createdAt TEXT);
CREATE TABLE IF NOT EXISTS canvas_tabs (ord INTEGER, id TEXT PRIMARY KEY, projectId TEXT, boardId TEXT, name TEXT, createdAt TEXT);
CREATE TABLE IF NOT EXISTS canvas_cards (ord INTEGER, id TEXT PRIMARY KEY, tabId TEXT, type TEXT, title TEXT, content TEXT, url TEXT, color TEXT, locked INTEGER, pages TEXT, crop TEXT, bookmarks TEXT, pdf TEXT, frames TEXT, stationId TEXT, refNoteId TEXT, refTaskId TEXT, refSketchId TEXT, refTabId TEXT, refPlanId TEXT, draftWhen TEXT, shape TEXT, x REAL, y REAL, width REAL, height REAL, createdAt TEXT);
CREATE TABLE IF NOT EXISTS canvas_arrows (ord INTEGER, id TEXT PRIMARY KEY, tabId TEXT, x1 REAL, y1 REAL, x2 REAL, y2 REAL, fromCardId TEXT, toCardId TEXT, label TEXT, curved INTEGER, color TEXT, width REAL, fromPort TEXT, toPort TEXT, points TEXT, createdAt TEXT);
CREATE TABLE IF NOT EXISTS canvas_groups (ord INTEGER, id TEXT PRIMARY KEY, tabId TEXT, title TEXT, x REAL, y REAL, width REAL, height REAL, createdAt TEXT);
CREATE TABLE IF NOT EXISTS canvas_strokes (ord INTEGER, id TEXT PRIMARY KEY, tabId TEXT, points TEXT, color TEXT, width REAL, createdAt TEXT);
CREATE TABLE IF NOT EXISTS canvas_labels (ord INTEGER, id TEXT PRIMARY KEY, tabId TEXT, text TEXT, x REAL, y REAL, fontSize REAL, color TEXT, createdAt TEXT);
CREATE TABLE IF NOT EXISTS canvas_rails (ord INTEGER, id TEXT PRIMARY KEY, tabId TEXT, name TEXT, color TEXT, stationIds TEXT, createdAt TEXT);
CREATE TABLE IF NOT EXISTS canvas_stations (ord INTEGER, id TEXT PRIMARY KEY, tabId TEXT, name TEXT, x REAL, y REAL, status TEXT, createdAt TEXT);
CREATE TABLE IF NOT EXISTS app_kv (key TEXT PRIMARY KEY, value TEXT);
`

// ── sql.js byte persistence (Electron disk file, else IndexedDB) ──

const IDB_NAME = 'constella_sqlite'
const OLD_IDB_NAME = 'maind_set_sqlite' // pre-rename browser store (Electron uses the disk file, not this)
const IDB_STORE = 'db'
const IDB_KEY = 'main'
const IDB_BAK_KEY = 'main.bak' // previous-good copy, rotated on every save (browser build)

interface DbApi {
  load: () => Promise<ArrayBuffer | Uint8Array | null>
  save: (bytes: Uint8Array) => Promise<void>
  reset?: () => Promise<void>
  recoveryList?: () => Promise<{ name: string; size: number; mtime: number }[]>
  loadRecovery?: (name: string) => Promise<ArrayBuffer | Uint8Array | null>
}
function electronDb(): DbApi | null {
  const api = (window as unknown as { api?: { db?: DbApi } }).api
  return api?.db ?? null
}

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function loadBytes(): Promise<Uint8Array | null> {
  if (isRemote) {
    const res = await fetch('/api/db', { cache: 'no-store' })
    if (res.status === 204) return null
    if (!res.ok) throw new Error('remote db load failed')
    return new Uint8Array(await res.arrayBuffer())
  }
  const ed = electronDb()
  if (ed) {
    const data = await ed.load()
    return data ? new Uint8Array(data) : null
  }
  const db = await openIdb()
  const fromNew = await new Promise<Uint8Array | null>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly')
    const req = tx.objectStore(IDB_STORE).get(IDB_KEY)
    req.onsuccess = () => resolve((req.result as Uint8Array) ?? null)
    req.onerror = () => reject(req.error)
  })
  if (fromNew) return fromNew
  // One-time fallback to the pre-rename browser store (read-only, non-destructive).
  return readOldIdbBytes()
}

// Read the serialized DB from the former `maind_set_sqlite` store, if present.
async function readOldIdbBytes(): Promise<Uint8Array | null> {
  try {
    const dbs = await indexedDB.databases?.()
    if (dbs && dbs.length && !dbs.some(d => d.name === OLD_IDB_NAME)) return null
  } catch { /* databases() unsupported → just try opening */ }
  return new Promise((resolve) => {
    const req = indexedDB.open(OLD_IDB_NAME)
    req.onsuccess = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(IDB_STORE)) { db.close(); resolve(null); return }
      const tx = db.transaction(IDB_STORE, 'readonly')
      const r = tx.objectStore(IDB_STORE).get(IDB_KEY)
      r.onsuccess = () => { resolve((r.result as Uint8Array) ?? null); db.close() }
      r.onerror = () => { resolve(null); db.close() }
    }
    req.onerror = () => resolve(null)
  })
}

async function saveBytes(bytes: Uint8Array): Promise<void> {
  if (isRemote) {
    await fetch('/api/db', { method: 'PUT', body: bytes as unknown as BodyInit, headers: { 'Content-Type': 'application/octet-stream' } })
    return
  }
  const ed = electronDb()
  if (ed) { await ed.save(bytes); return }
  const db = await openIdb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite')
    const store = tx.objectStore(IDB_STORE)
    // Rotate the current copy to .bak in the same transaction, mirroring the
    // Electron file rotation — a corrupted write leaves a previous-good fallback.
    const cur = store.get(IDB_KEY)
    cur.onsuccess = () => {
      if (cur.result) store.put(cur.result, IDB_BAK_KEY)
      store.put(bytes, IDB_KEY)
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

// Read the browser-build previous-good copy (recovery candidate).
async function readIdbBakBytes(): Promise<Uint8Array | null> {
  const db = await openIdb()
  return new Promise((resolve) => {
    const tx = db.transaction(IDB_STORE, 'readonly')
    const req = tx.objectStore(IDB_STORE).get(IDB_BAK_KEY)
    req.onsuccess = () => resolve((req.result as Uint8Array) ?? null)
    req.onerror = () => resolve(null)
  })
}

// ── DB lifecycle ──

let dbInstance: Database | null = null
let initPromise: Promise<Database> | null = null
// The initialized sql.js module — kept so saveState can verify exports without
// re-initializing the WASM runtime.
let sqlModule: Awaited<ReturnType<typeof initSqlJs>> | null = null

// One-shot notice set when the DB was auto-restored from a backup; the store
// surfaces it to the user once after hydration.
let dbRecoveryNotice: string | null = null
export function consumeDbRecoveryNotice(): string | null {
  const n = dbRecoveryNotice
  dbRecoveryNotice = null
  return n
}

// Open bytes as a database and verify basic integrity up front. quick_check
// surfaces page-level corruption immediately (instead of at some random later
// query), which is what lets the recovery chain kick in at load time.
function openVerified(SQL: NonNullable<typeof sqlModule>, bytes: Uint8Array | null): Database {
  const db = bytes ? new SQL.Database(bytes) : new SQL.Database()
  if (bytes) {
    try {
      db.exec('PRAGMA quick_check')
    } catch (e) {
      try { db.close() } catch { /* ignore */ }
      throw e
    }
  }
  return db
}

async function getDb(): Promise<Database> {
  if (dbInstance) return dbInstance
  if (initPromise) return initPromise
  initPromise = (async () => {
    const SQL = await initSqlJs({ locateFile: () => wasmUrl })
    sqlModule = SQL
    const bytes = await loadBytes()
    let db: Database | null = null
    let healedFrom: string | null = null
    try {
      db = openVerified(SQL, bytes)
    } catch (mainErr) {
      // Main DB is corrupted. Walk the recovery candidates, newest first:
      // Electron: constella.db.bak → rolling daily backups. Browser: main.bak.
      const ed = electronDb()
      if (ed?.recoveryList && ed.loadRecovery) {
        let candidates: { name: string }[] = []
        try { candidates = await ed.recoveryList() } catch { /* none */ }
        for (const c of candidates) {
          try {
            const b = await ed.loadRecovery(c.name)
            if (!b) continue
            db = openVerified(SQL, new Uint8Array(b))
            healedFrom = c.name
            break
          } catch { /* corrupted too — try the next one */ }
        }
      } else if (!isRemote) {
        try {
          const b = await readIdbBakBytes()
          if (b) { db = openVerified(SQL, b); healedFrom = '前回保存分' }
        } catch { /* no usable bak */ }
      }
      if (!db) throw mainErr // nothing recoverable — store falls back to loadFailed (read-only sample)
    }
    db.run(SCHEMA)
    // Migrations for DBs created before a column existed (ALTER throws if it already exists).
    try { db.run('ALTER TABLE canvas_cards ADD COLUMN crop TEXT') } catch { /* column already present */ }
    try { db.run('ALTER TABLE canvas_cards ADD COLUMN bookmarks TEXT') } catch { /* column already present */ }
    try { db.run('ALTER TABLE canvas_cards ADD COLUMN pdf TEXT') } catch { /* column already present */ }
    try { db.run('ALTER TABLE canvas_cards ADD COLUMN frames TEXT') } catch { /* column already present */ }
    try { db.run('ALTER TABLE canvas_tabs ADD COLUMN projectId TEXT') } catch { /* column already present */ }
    try { db.run('ALTER TABLE canvas_tabs ADD COLUMN boardId TEXT') } catch { /* column already present */ }
    try { db.run('ALTER TABLE canvas_cards ADD COLUMN refTabId TEXT') } catch { /* column already present */ }
    try { db.run('ALTER TABLE canvas_cards ADD COLUMN refPlanId TEXT') } catch { /* column already present */ }
    try { db.run('ALTER TABLE canvas_arrows ADD COLUMN color TEXT') } catch { /* column already present */ }
    try { db.run('ALTER TABLE canvas_arrows ADD COLUMN width REAL') } catch { /* column already present */ }
    try { db.run('ALTER TABLE canvas_cards ADD COLUMN stationId TEXT') } catch { /* column already present */ }
    // Global master-project layer: add the scoping FK columns to existing DBs.
    try { db.run('ALTER TABLE notes ADD COLUMN masterProjectId TEXT') } catch { /* column already present */ }
    try { db.run('ALTER TABLE projects ADD COLUMN masterProjectId TEXT') } catch { /* column already present */ }
    try { db.run('ALTER TABLE research ADD COLUMN masterProjectId TEXT') } catch { /* column already present */ }
    try { db.run('ALTER TABLE tasks ADD COLUMN startDate TEXT') } catch { /* column already present */ }
    try { db.run('ALTER TABLE tasks ADD COLUMN endDate TEXT') } catch { /* column already present */ }
    try { db.run('ALTER TABLE tasks ADD COLUMN parentId TEXT') } catch { /* column already present */ }
    try { db.run('ALTER TABLE projects ADD COLUMN color TEXT') } catch { /* column already present */ }
    try { db.run('ALTER TABLE tasks ADD COLUMN linkedNoteIds TEXT') } catch { /* column already present */ }
    try { db.run('ALTER TABLE canvas_cards ADD COLUMN refNoteId TEXT') } catch { /* column already present */ }
    try { db.run('ALTER TABLE canvas_cards ADD COLUMN refTaskId TEXT') } catch { /* column already present */ }
    try { db.run('ALTER TABLE canvas_cards ADD COLUMN refSketchId TEXT') } catch { /* column already present */ }
    try { db.run('ALTER TABLE canvas_cards ADD COLUMN draftWhen TEXT') } catch { /* column already present */ }
    try { db.run('ALTER TABLE flows ADD COLUMN groups TEXT') } catch { /* column already present */ }
    try { db.run('ALTER TABLE research ADD COLUMN folderId TEXT') } catch { /* column already present */ }
    try { db.run('ALTER TABLE research_folders ADD COLUMN parentId TEXT') } catch { /* column already present */ }
    try { db.run('ALTER TABLE notes ADD COLUMN folderId TEXT') } catch { /* column already present */ }
    try { db.run('ALTER TABLE note_folders ADD COLUMN color TEXT') } catch { /* column already present */ }
    try { db.run('ALTER TABLE research_folders ADD COLUMN color TEXT') } catch { /* column already present */ }
    try { db.run('ALTER TABLE notes ADD COLUMN pinned INTEGER') } catch { /* column already present */ }
    try { db.run('ALTER TABLE notes ADD COLUMN archivedAt TEXT') } catch { /* column already present */ }
    try { db.run('ALTER TABLE notes ADD COLUMN shared INTEGER') } catch { /* column already present */ }
    try { db.run('ALTER TABLE notes ADD COLUMN refByMasterIds TEXT') } catch { /* column already present */ }
    try { db.run('ALTER TABLE notes ADD COLUMN attachments TEXT') } catch { /* column already present */ }
    try { db.run('ALTER TABLE files ADD COLUMN comment TEXT') } catch { /* column already present */ }
    try { db.run('ALTER TABLE tasks ADD COLUMN fileIds TEXT') } catch { /* column already present */ }
    try { db.run('ALTER TABLE files ADD COLUMN versions TEXT') } catch { /* column already present */ }
    try { db.run('ALTER TABLE canvas_cards ADD COLUMN refFileId TEXT') } catch { /* column already present */ }
    try { db.run('ALTER TABLE tasks ADD COLUMN priority INTEGER') } catch { /* column already present */ }
    try { db.run('ALTER TABLE tasks ADD COLUMN completedAt TEXT') } catch { /* column already present */ }
    try { db.run('ALTER TABLE tasks ADD COLUMN shared INTEGER') } catch { /* column already present */ }
    try { db.run('ALTER TABLE tasks ADD COLUMN sharedAlias TEXT') } catch { /* column already present */ }
    try { db.run('ALTER TABLE research ADD COLUMN archivedAt TEXT') } catch { /* column already present */ }
    try { db.run('ALTER TABLE canvas_cards ADD COLUMN shape TEXT') } catch { /* column already present */ }
    try { db.run('ALTER TABLE canvas_arrows ADD COLUMN fromPort TEXT') } catch { /* column already present */ }
    try { db.run('ALTER TABLE canvas_arrows ADD COLUMN toPort TEXT') } catch { /* column already present */ }
    try { db.run('ALTER TABLE canvas_arrows ADD COLUMN points TEXT') } catch { /* column already present */ }
    try { db.run('ALTER TABLE plans ADD COLUMN folder TEXT') } catch { /* column already present */ }
    try { db.run('ALTER TABLE plans ADD COLUMN folderId TEXT') } catch { /* column already present */ }
    try { db.run('ALTER TABLE master_projects ADD COLUMN archivedAt TEXT') } catch { /* column already present */ }
    try { db.run('ALTER TABLE master_projects ADD COLUMN folder TEXT') } catch { /* column already present */ }
    // One-time migration: collapse all pre-existing data under a single default
    // master project ('メイン'). Runs once (meta-gated); the in-memory
    // normalizeMasterProjects in store.tsx is the comprehensive safety net for any
    // other path (legacy localStorage, backup import). Canvas categories (tabs)
    // previously pointed at per-canvas project ids — re-parent them all to the
    // default master so no category/card is orphaned out of view.
    const migratedMaster = rows(db, "SELECT value FROM meta WHERE key='migrated_master_project'")[0]
    if (!migratedMaster) {
      const isoNow = new Date().toISOString()
      db.run("INSERT OR IGNORE INTO master_projects (ord,id,name,createdAt) VALUES (0,'master-default','メイン',?)", [isoNow])
      db.run("UPDATE notes SET masterProjectId='master-default' WHERE masterProjectId IS NULL OR masterProjectId=''")
      db.run("UPDATE projects SET masterProjectId='master-default' WHERE masterProjectId IS NULL OR masterProjectId=''")
      db.run("UPDATE research SET masterProjectId='master-default' WHERE masterProjectId IS NULL OR masterProjectId=''")
      db.run("UPDATE canvas_tabs SET projectId='master-default'")
      // The per-canvas project layer was collapsed into master projects — retire its table.
      db.run('DROP TABLE IF EXISTS canvas_projects')
      db.run("INSERT OR REPLACE INTO meta (key,value) VALUES ('migrated_master_project','1')")
    }
    dbInstance = db
    if (healedFrom) {
      // Heal the main store immediately so the next boot doesn't repeat recovery,
      // and tell the user which snapshot their data came from.
      dbRecoveryNotice = `データベースの破損を検出したため、バックアップ「${healedFrom}」から自動復元しました。最近の変更が一部失われている可能性があります。`
      try { await saveBytes(db.export()) } catch { /* heal is best-effort */ }
    }
    return db
  })()
  return initPromise
}

// ── helpers ──

type Row = Record<string, unknown>
function rows(db: Database, sql: string): Row[] {
  const res = db.exec(sql)
  if (!res.length) return []
  const { columns, values } = res[0]
  return values.map(v => Object.fromEntries(columns.map((c, i) => [c, v[i]])))
}
const str = (v: unknown): string => (v == null ? '' : String(v))
const optStr = (v: unknown): string | undefined => (v == null ? undefined : String(v))
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0)
const bool = (v: unknown): boolean => !!v && v !== 0
const parseArr = <T,>(v: unknown): T[] => { try { return v ? (JSON.parse(String(v)) as T[]) : [] } catch { return [] } }
const parseJson = <T,>(v: unknown): T | undefined => { try { return v ? (JSON.parse(String(v)) as T) : undefined } catch { return undefined } }
// Bind helper: undefined → null, boolean → 0/1
const B = (v: unknown): string | number | null => (v == null ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v as string | number)

// ── public API ──

/** Returns the persisted AppState, or null if the database has never been initialized. */
export async function loadState(): Promise<AppState | null> {
  const db = await getDb()
  const initialized = rows(db, "SELECT value FROM meta WHERE key='initialized'")[0]
  if (!initialized) return null

  const masterProjects: MasterProject[] = rows(db, 'SELECT * FROM master_projects ORDER BY ord').map(r => ({
    id: str(r.id), name: str(r.name), createdAt: str(r.createdAt),
    archivedAt: optStr(r.archivedAt),
    folder: optStr(r.folder),
  }))
  const activeMasterProjectId = str(rows(db, "SELECT value FROM meta WHERE key='activeMasterProject'")[0]?.value)

  const notes: Note[] = rows(db, 'SELECT * FROM notes ORDER BY ord').map(r => {
    const refBy = parseArr<string>(r.refByMasterIds)
    const attachments = parseArr<NoteAttachment>(r.attachments)
    return {
      id: str(r.id), masterProjectId: str(r.masterProjectId), title: str(r.title), content: str(r.content),
      tags: parseArr<string>(r.tags), createdAt: str(r.createdAt), updatedAt: str(r.updatedAt),
      folderId: optStr(r.folderId),
      pinned: bool(r.pinned) || undefined,
      archivedAt: optStr(r.archivedAt),
      shared: bool(r.shared) || undefined,
      refByMasterIds: refBy.length > 0 ? refBy : undefined,
      attachments: attachments.length > 0 ? attachments : undefined,
    }
  })

  const noteFolders: NoteFolder[] = rows(db, 'SELECT * FROM note_folders ORDER BY ord').map(r => ({
    id: str(r.id), masterProjectId: str(r.masterProjectId), name: str(r.name), createdAt: str(r.createdAt),
    parentId: optStr(r.parentId),
    color: optStr(r.color) as NoteFolder['color'],
  }))

  const files: FileItem[] = rows(db, 'SELECT * FROM files ORDER BY ord').map(r => {
    const linked = parseArr<string>(r.linkedMasterIds)
    const versions = parseArr<FileVersion>(r.versions)
    return {
      id: str(r.id), masterProjectId: str(r.masterProjectId),
      linkedMasterIds: linked.length > 0 ? linked : undefined,
      name: str(r.name), url: str(r.url), mime: str(r.mime), size: num(r.size),
      tags: parseArr<string>(r.tags), folderId: optStr(r.folderId),
      comment: optStr(r.comment),
      versions: versions.length > 0 ? versions : undefined,
      createdAt: str(r.createdAt),
    }
  })

  const fileFolders: FileFolder[] = rows(db, 'SELECT * FROM file_folders ORDER BY ord').map(r => ({
    id: str(r.id), masterProjectId: str(r.masterProjectId), name: str(r.name), createdAt: str(r.createdAt),
    parentId: optStr(r.parentId),
    color: optStr(r.color) as FileFolder['color'],
  }))

  const tasksByProject = new Map<string, Task[]>()
  for (const r of rows(db, 'SELECT * FROM tasks ORDER BY ord')) {
    const linkedNoteIds = parseArr<string>(r.linkedNoteIds)
    const fileIds = parseArr<string>(r.fileIds)
    const priRaw = r.priority == null ? undefined : Number(r.priority)
    const task: Task = {
      id: str(r.id), title: str(r.title), description: str(r.description),
      status: str(r.status) as Task['status'], tags: parseArr<string>(r.tags), createdAt: str(r.createdAt),
      startDate: optStr(r.startDate), endDate: optStr(r.endDate),
      parentId: optStr(r.parentId),
      linkedNoteIds: linkedNoteIds.length > 0 ? linkedNoteIds : undefined,
      fileIds: fileIds.length > 0 ? fileIds : undefined,
      priority: (priRaw === 1 || priRaw === 2 || priRaw === 3 || priRaw === 4) ? priRaw as Task['priority'] : undefined,
      completedAt: optStr(r.completedAt),
      shared: bool(r.shared) ? true : undefined,
      sharedAlias: optStr(r.sharedAlias),
    }
    const pid = str(r.projectId)
    const list = tasksByProject.get(pid) ?? []
    list.push(task)
    tasksByProject.set(pid, list)
  }
  const projects: Project[] = rows(db, 'SELECT * FROM projects ORDER BY ord').map(r => ({
    id: str(r.id), masterProjectId: str(r.masterProjectId), name: str(r.name), description: str(r.description), createdAt: str(r.createdAt),
    color: optStr(r.color) as Project['color'],
    tasks: tasksByProject.get(str(r.id)) ?? [],
  }))

  const research: ResearchItem[] = rows(db, 'SELECT * FROM research ORDER BY ord').map(r => ({
    id: str(r.id), masterProjectId: str(r.masterProjectId), title: str(r.title), url: str(r.url), description: str(r.description),
    tags: parseArr<string>(r.tags), category: str(r.category), createdAt: str(r.createdAt),
    folderId: optStr(r.folderId),
    archivedAt: optStr(r.archivedAt),
  }))

  const researchFolders: ResearchFolder[] = rows(db, 'SELECT * FROM research_folders ORDER BY ord').map(r => ({
    id: str(r.id), masterProjectId: str(r.masterProjectId), name: str(r.name), createdAt: str(r.createdAt),
    parentId: optStr(r.parentId),
    color: optStr(r.color) as ResearchFolder['color'],
  }))

  const sketches: Sketch[] = rows(db, 'SELECT * FROM sketches ORDER BY ord').map(r => ({
    id: str(r.id), masterProjectId: str(r.masterProjectId), name: str(r.name),
    strokes: parseArr<SketchStroke>(r.strokes), createdAt: str(r.createdAt), updatedAt: str(r.updatedAt),
  }))

  const flows: Flow[] = rows(db, 'SELECT * FROM flows ORDER BY ord').map(r => ({
    id: str(r.id), masterProjectId: str(r.masterProjectId), name: str(r.name),
    nodes: parseArr<FlowNode>(r.nodes), edges: parseArr<FlowEdge>(r.edges), groups: parseArr<FlowGroup>(r.groups),
    createdAt: str(r.createdAt), updatedAt: str(r.updatedAt),
  }))

  const planFolders: PlanFolder[] = rows(db, 'SELECT * FROM plan_folders ORDER BY ord').map(r => ({
    id: str(r.id), masterProjectId: str(r.masterProjectId), name: str(r.name), createdAt: str(r.createdAt),
    parentId: optStr(r.parentId),
    color: optStr(r.color) as PlanFolder['color'],
  }))

  const plans: Plan[] = rows(db, 'SELECT * FROM plans ORDER BY ord').map(r => {
    const p: Plan = {
      id: str(r.id), masterProjectId: str(r.masterProjectId), name: str(r.name), content: str(r.content),
      folderId: optStr(r.folderId),
      createdAt: str(r.createdAt), updatedAt: str(r.updatedAt),
    }
    // Legacy migration: v0.5.1 stored the folder as a plain name string in
    // plans.folder. Convert to a PlanFolder entity (reused per master+name) —
    // persisted on the next save, after which the legacy column stays NULL.
    const legacy = optStr(r.folder)?.trim()
    if (legacy && !p.folderId) {
      let f = planFolders.find(x => x.masterProjectId === p.masterProjectId && x.name === legacy)
      if (!f) {
        f = { id: generateId(), masterProjectId: p.masterProjectId, name: legacy, createdAt: p.updatedAt }
        planFolders.push(f)
      }
      p.folderId = f.id
    }
    return p
  })

  const timelineBands: TimelineBand[] = rows(db, 'SELECT * FROM timeline_bands ORDER BY ord').map(r => ({
    id: str(r.id), masterProjectId: str(r.masterProjectId), title: str(r.title),
    startDate: str(r.startDate), endDate: str(r.endDate),
    color: optStr(r.color) as TimelineBand['color'], createdAt: str(r.createdAt),
  }))

  const aiConversations: AIConversation[] = rows(db, 'SELECT * FROM ai_conversations ORDER BY ord').map(r => ({
    id: str(r.id), masterProjectId: str(r.masterProjectId), title: str(r.title),
    messages: parseArr<AIMessage>(r.messages), createdAt: str(r.createdAt), updatedAt: str(r.updatedAt),
  }))

  const canvasBoards: CanvasBoard[] = rows(db, 'SELECT * FROM canvas_boards ORDER BY ord').map(r => ({
    id: str(r.id), projectId: str(r.projectId), name: str(r.name),
    color: optStr(r.color) as CanvasBoard['color'], createdAt: str(r.createdAt),
  }))

  const canvasTabs: CanvasTab[] = rows(db, 'SELECT * FROM canvas_tabs ORDER BY ord').map(r => ({
    id: str(r.id), projectId: str(r.projectId), boardId: optStr(r.boardId), name: str(r.name), createdAt: str(r.createdAt),
  }))

  const canvasCards: CanvasCard[] = rows(db, 'SELECT * FROM canvas_cards ORDER BY ord').map(r => ({
    id: str(r.id), tabId: str(r.tabId), type: str(r.type) as CanvasCard['type'],
    title: str(r.title), content: str(r.content),
    url: r.url == null ? undefined : String(r.url),
    color: optStr(r.color),
    locked: bool(r.locked),
    pages: parseJson<CardPage[]>(r.pages),
    crop: parseJson<{ x: number; y: number; w: number; h: number }>(r.crop),
    bookmarks: parseJson<Bookmark[]>(r.bookmarks),
    pdf: parseJson<{ page?: number; mode?: 'scroll' | 'single' | 'spread' }>(r.pdf),
    frames: parseJson<({ url: string; name?: string } | string)[]>(r.frames)?.map(f => (typeof f === 'string' ? { url: f } : f)),
    stationId: optStr(r.stationId),
    refNoteId: optStr(r.refNoteId),
    refTaskId: optStr(r.refTaskId),
    refSketchId: optStr(r.refSketchId),
    refTabId: optStr(r.refTabId),
    refPlanId: optStr(r.refPlanId),
    refFileId: optStr(r.refFileId),
    draftWhen: optStr(r.draftWhen) as CanvasCard['draftWhen'],
    shape: optStr(r.shape) as CanvasCard['shape'],
    x: num(r.x), y: num(r.y), width: num(r.width), height: num(r.height), createdAt: str(r.createdAt),
  }))

  const canvasArrows: CanvasArrow[] = rows(db, 'SELECT * FROM canvas_arrows ORDER BY ord').map(r => ({
    id: str(r.id), tabId: str(r.tabId),
    x1: num(r.x1), y1: num(r.y1), x2: num(r.x2), y2: num(r.y2),
    fromCardId: optStr(r.fromCardId), toCardId: optStr(r.toCardId),
    label: optStr(r.label), curved: bool(r.curved),
    color: optStr(r.color), width: r.width == null ? undefined : num(r.width),
    fromPort: optStr(r.fromPort) as CanvasArrow['fromPort'],
    toPort: optStr(r.toPort) as CanvasArrow['toPort'],
    points: parseJson<{ x: number; y: number }[]>(r.points),
    createdAt: str(r.createdAt),
  }))

  const canvasGroups: CanvasGroup[] = rows(db, 'SELECT * FROM canvas_groups ORDER BY ord').map(r => ({
    id: str(r.id), tabId: str(r.tabId), title: str(r.title),
    x: num(r.x), y: num(r.y), width: num(r.width), height: num(r.height), createdAt: str(r.createdAt),
  }))

  const canvasStrokes: CanvasStroke[] = rows(db, 'SELECT * FROM canvas_strokes ORDER BY ord').map(r => ({
    id: str(r.id), tabId: str(r.tabId), points: parseArr<number>(r.points),
    color: str(r.color), width: num(r.width), createdAt: str(r.createdAt),
  }))

  const canvasLabels: CanvasLabel[] = rows(db, 'SELECT * FROM canvas_labels ORDER BY ord').map(r => ({
    id: str(r.id), tabId: str(r.tabId), text: str(r.text),
    x: num(r.x), y: num(r.y), fontSize: num(r.fontSize), color: str(r.color), createdAt: str(r.createdAt),
  }))

  const canvasRails: CanvasRail[] = rows(db, 'SELECT * FROM canvas_rails ORDER BY ord').map(r => ({
    id: str(r.id), tabId: str(r.tabId), name: str(r.name), color: str(r.color),
    stationIds: parseArr<string>(r.stationIds), createdAt: str(r.createdAt),
  }))

  const canvasStations: CanvasStation[] = rows(db, 'SELECT * FROM canvas_stations ORDER BY ord').map(r => ({
    id: str(r.id), tabId: str(r.tabId), name: str(r.name),
    x: num(r.x), y: num(r.y), status: (str(r.status) || 'todo') as CanvasStation['status'], createdAt: str(r.createdAt),
  }))

  return { masterProjects, activeMasterProjectId, notes, noteFolders, files, fileFolders, projects, research, researchFolders, sketches, flows, plans, planFolders, timelineBands, aiConversations, canvasBoards, canvasTabs, canvasCards, canvasArrows, canvasGroups, canvasStrokes, canvasLabels, canvasRails, canvasStations }
}

// Saves are serialized through a single chain so that two debounced writes can
// never overlap and persist out of order (which would silently lose the newer
// edit if the older write happened to flush last).
let saveChain: Promise<void> = Promise.resolve()

// While a backup import is restoring (and afterwards, until the page reloads),
// all NORMAL writes must be frozen. Two failure modes otherwise overwrite the
// freshly-restored database with the STALE pre-import in-memory state (the
// sample seed, or the mindtrain default "プラン 1"):
//  - the store's debounced 400ms autosave firing DURING the restore, which would
//    queue after the restore's own write in saveChain and win, and
//  - the reload's `pagehide`/`visibilitychange` flush handlers firing AFTER it.
// So the importer freezes writes BEFORE it starts and performs its own writes
// through restoreState/restoreKv (which bypass the freeze but share saveChain).
// The flag lives only in the dying JS context; the reloaded page starts a fresh
// module with writes enabled again. thawWrites exists for the import's failure
// path, where no reload happens and normal persistence must resume.
let writesFrozen = false
export function freezeWrites(): void { writesFrozen = true }
export function thawWrites(): void { writesFrozen = false }

function enqueueSaveState(state: AppState): Promise<void> {
  saveChain = saveChain.catch(() => {}).then(() => doSaveState(state))
  return saveChain
}

/** Replace the entire database contents with the given state (atomic), then persist the bytes. */
export function saveState(state: AppState): Promise<void> {
  if (writesFrozen) return Promise.resolve()
  return enqueueSaveState(state)
}

/** Import-only variant of saveState: writes even while writes are frozen. */
export function restoreState(state: AppState): Promise<void> {
  return enqueueSaveState(state)
}

/**
 * Wait until every queued save has been flushed to storage. The folder-sync
 * push reads the on-disk DB file, so it must not run while a save is in flight.
 */
export function drainSaves(): Promise<void> {
  return saveChain.then(() => undefined, () => undefined)
}

async function doSaveState(state: AppState): Promise<void> {
  const db = await getDb()
  // Defensive: an imported legacy backup (pre-master-project) may lack newer
  // collections such as masterProjects. Default every array so a missing field
  // can't throw mid-transaction; the scoping columns then write NULL and are
  // backfilled by normalizeMasterProjects on the next load.
  state = {
    ...state,
    masterProjects: state.masterProjects ?? [],
    notes: state.notes ?? [],
    noteFolders: state.noteFolders ?? [],
    files: state.files ?? [],
    fileFolders: state.fileFolders ?? [],
    projects: state.projects ?? [],
    research: state.research ?? [],
    researchFolders: state.researchFolders ?? [],
    sketches: state.sketches ?? [],
    flows: state.flows ?? [],
    plans: state.plans ?? [],
    planFolders: state.planFolders ?? [],
    timelineBands: state.timelineBands ?? [],
    aiConversations: state.aiConversations ?? [],
    canvasBoards: state.canvasBoards ?? [],
    canvasTabs: state.canvasTabs ?? [],
    canvasCards: state.canvasCards ?? [],
    canvasArrows: state.canvasArrows ?? [],
    canvasGroups: state.canvasGroups ?? [],
    canvasStrokes: state.canvasStrokes ?? [],
    canvasLabels: state.canvasLabels ?? [],
    canvasRails: state.canvasRails ?? [],
    canvasStations: state.canvasStations ?? [],
    activeMasterProjectId: state.activeMasterProjectId ?? '',
  }
  db.run('BEGIN TRANSACTION')
  try {
    for (const t of ['master_projects', 'notes', 'note_folders', 'files', 'file_folders', 'projects', 'tasks', 'research', 'research_folders', 'sketches', 'flows', 'plans', 'plan_folders', 'timeline_bands', 'ai_conversations', 'canvas_boards', 'canvas_tabs', 'canvas_cards', 'canvas_arrows', 'canvas_groups', 'canvas_strokes', 'canvas_labels', 'canvas_rails', 'canvas_stations']) {
      db.run(`DELETE FROM ${t}`)
    }

    const insert = (sql: string, rowsToInsert: (string | number | null)[][]) => {
      const stmt = db.prepare(sql)
      for (const params of rowsToInsert) stmt.run(params)
      stmt.free()
    }

    insert('INSERT INTO master_projects (ord,id,name,createdAt,archivedAt,folder) VALUES (?,?,?,?,?,?)',
      state.masterProjects.map((p, i) => [i, p.id, p.name, p.createdAt, p.archivedAt ?? null, p.folder ?? null].map(B)))

    insert('INSERT INTO notes (ord,id,masterProjectId,title,content,tags,createdAt,updatedAt,folderId,pinned,archivedAt,shared,refByMasterIds,attachments) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      state.notes.map((n, i) => [i, n.id, n.masterProjectId, n.title, n.content, JSON.stringify(n.tags ?? []), n.createdAt, n.updatedAt, n.folderId ?? null, n.pinned ? 1 : 0, n.archivedAt ?? null, n.shared ? 1 : 0, JSON.stringify(n.refByMasterIds ?? []), n.attachments && n.attachments.length ? JSON.stringify(n.attachments) : null].map(B)))

    insert('INSERT INTO note_folders (ord,id,masterProjectId,name,createdAt,parentId,color) VALUES (?,?,?,?,?,?,?)',
      state.noteFolders.map((f, i) => [i, f.id, f.masterProjectId, f.name, f.createdAt, f.parentId ?? null, f.color ?? null].map(B)))

    insert('INSERT INTO files (ord,id,masterProjectId,linkedMasterIds,name,url,mime,size,tags,folderId,comment,versions,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      state.files.map((f, i) => [i, f.id, f.masterProjectId, JSON.stringify(f.linkedMasterIds ?? []), f.name, f.url, f.mime, f.size, JSON.stringify(f.tags ?? []), f.folderId ?? null, f.comment ?? null, f.versions && f.versions.length ? JSON.stringify(f.versions) : null, f.createdAt].map(B)))

    insert('INSERT INTO file_folders (ord,id,masterProjectId,name,createdAt,parentId,color) VALUES (?,?,?,?,?,?,?)',
      state.fileFolders.map((f, i) => [i, f.id, f.masterProjectId, f.name, f.createdAt, f.parentId ?? null, f.color ?? null].map(B)))

    insert('INSERT INTO projects (ord,id,masterProjectId,name,description,createdAt,color) VALUES (?,?,?,?,?,?,?)',
      state.projects.map((p, i) => [i, p.id, p.masterProjectId, p.name, p.description, p.createdAt, p.color ?? null].map(B)))

    let taskOrd = 0
    const taskRows: (string | number | null)[][] = []
    for (const p of state.projects) {
      for (const t of p.tasks) {
        taskRows.push([taskOrd++, t.id, p.id, t.title, t.description, t.status, JSON.stringify(t.tags ?? []), t.createdAt, t.startDate ?? null, t.endDate ?? null, t.parentId ?? null, JSON.stringify(t.linkedNoteIds ?? []), t.priority ?? null, t.completedAt ?? null, t.shared ? 1 : 0, t.sharedAlias ?? null, JSON.stringify(t.fileIds ?? [])].map(B))
      }
    }
    insert('INSERT INTO tasks (ord,id,projectId,title,description,status,tags,createdAt,startDate,endDate,parentId,linkedNoteIds,priority,completedAt,shared,sharedAlias,fileIds) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', taskRows)

    insert('INSERT INTO research (ord,id,masterProjectId,title,url,description,tags,category,createdAt,folderId,archivedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      state.research.map((r, i) => [i, r.id, r.masterProjectId, r.title, r.url, r.description, JSON.stringify(r.tags ?? []), r.category, r.createdAt, r.folderId ?? null, r.archivedAt ?? null].map(B)))

    insert('INSERT INTO research_folders (ord,id,masterProjectId,name,createdAt,parentId,color) VALUES (?,?,?,?,?,?,?)',
      state.researchFolders.map((f, i) => [i, f.id, f.masterProjectId, f.name, f.createdAt, f.parentId ?? null, f.color ?? null].map(B)))

    insert('INSERT INTO sketches (ord,id,masterProjectId,name,strokes,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)',
      state.sketches.map((s, i) => [i, s.id, s.masterProjectId, s.name, JSON.stringify(s.strokes ?? []), s.createdAt, s.updatedAt].map(B)))

    insert('INSERT INTO flows (ord,id,masterProjectId,name,nodes,edges,groups,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)',
      state.flows.map((f, i) => [i, f.id, f.masterProjectId, f.name, JSON.stringify(f.nodes ?? []), JSON.stringify(f.edges ?? []), JSON.stringify(f.groups ?? []), f.createdAt, f.updatedAt].map(B)))

    insert('INSERT INTO plans (ord,id,masterProjectId,name,content,folderId,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?)',
      state.plans.map((p, i) => [i, p.id, p.masterProjectId, p.name, p.content, p.folderId ?? null, p.createdAt, p.updatedAt].map(B)))

    insert('INSERT INTO plan_folders (ord,id,masterProjectId,name,createdAt,parentId,color) VALUES (?,?,?,?,?,?,?)',
      state.planFolders.map((f, i) => [i, f.id, f.masterProjectId, f.name, f.createdAt, f.parentId ?? null, f.color ?? null].map(B)))

    insert('INSERT INTO timeline_bands (ord,id,masterProjectId,title,startDate,endDate,color,createdAt) VALUES (?,?,?,?,?,?,?,?)',
      state.timelineBands.map((b, i) => [i, b.id, b.masterProjectId, b.title, b.startDate, b.endDate, b.color ?? null, b.createdAt].map(B)))

    insert('INSERT INTO ai_conversations (ord,id,masterProjectId,title,messages,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)',
      state.aiConversations.map((c, i) => [i, c.id, c.masterProjectId, c.title, JSON.stringify(c.messages ?? []), c.createdAt, c.updatedAt].map(B)))

    insert('INSERT INTO canvas_boards (ord,id,projectId,name,color,createdAt) VALUES (?,?,?,?,?,?)',
      state.canvasBoards.map((b, i) => [i, b.id, b.projectId, b.name, b.color ?? null, b.createdAt].map(B)))

    insert('INSERT INTO canvas_tabs (ord,id,projectId,boardId,name,createdAt) VALUES (?,?,?,?,?,?)',
      state.canvasTabs.map((t, i) => [i, t.id, t.projectId, t.boardId ?? null, t.name, t.createdAt].map(B)))

    insert('INSERT INTO canvas_cards (ord,id,tabId,type,title,content,url,color,locked,pages,crop,bookmarks,pdf,frames,stationId,refNoteId,refTaskId,refSketchId,refTabId,refPlanId,refFileId,draftWhen,shape,x,y,width,height,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      state.canvasCards.map((c, i) => [i, c.id, c.tabId, c.type, c.title, c.content,
        c.url ?? null, c.color ?? null, c.locked ? 1 : 0, c.pages ? JSON.stringify(c.pages) : null,
        c.crop ? JSON.stringify(c.crop) : null,
        c.bookmarks && c.bookmarks.length ? JSON.stringify(c.bookmarks) : null,
        c.pdf ? JSON.stringify(c.pdf) : null,
        c.frames && c.frames.length ? JSON.stringify(c.frames) : null,
        c.stationId ?? null,
        c.refNoteId ?? null, c.refTaskId ?? null, c.refSketchId ?? null, c.refTabId ?? null, c.refPlanId ?? null, c.refFileId ?? null,
        c.draftWhen ?? null,
        c.shape ?? null,
        c.x, c.y, c.width, c.height, c.createdAt].map(B)))

    insert('INSERT INTO canvas_arrows (ord,id,tabId,x1,y1,x2,y2,fromCardId,toCardId,label,curved,color,width,fromPort,toPort,points,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      state.canvasArrows.map((a, i) => [i, a.id, a.tabId, a.x1, a.y1, a.x2, a.y2,
        a.fromCardId ?? null, a.toCardId ?? null, a.label ?? null, a.curved ? 1 : 0,
        a.color ?? null, a.width ?? null, a.fromPort ?? null, a.toPort ?? null,
        a.points && a.points.length ? JSON.stringify(a.points) : null, a.createdAt].map(B)))

    insert('INSERT INTO canvas_groups (ord,id,tabId,title,x,y,width,height,createdAt) VALUES (?,?,?,?,?,?,?,?,?)',
      state.canvasGroups.map((g, i) => [i, g.id, g.tabId, g.title, g.x, g.y, g.width, g.height, g.createdAt].map(B)))

    insert('INSERT INTO canvas_strokes (ord,id,tabId,points,color,width,createdAt) VALUES (?,?,?,?,?,?,?)',
      state.canvasStrokes.map((s, i) => [i, s.id, s.tabId, JSON.stringify(s.points ?? []), s.color, s.width, s.createdAt].map(B)))

    insert('INSERT INTO canvas_labels (ord,id,tabId,text,x,y,fontSize,color,createdAt) VALUES (?,?,?,?,?,?,?,?,?)',
      state.canvasLabels.map((l, i) => [i, l.id, l.tabId, l.text, l.x, l.y, l.fontSize, l.color, l.createdAt].map(B)))

    insert('INSERT INTO canvas_rails (ord,id,tabId,name,color,stationIds,createdAt) VALUES (?,?,?,?,?,?,?)',
      state.canvasRails.map((r, i) => [i, r.id, r.tabId, r.name, r.color, JSON.stringify(r.stationIds ?? []), r.createdAt].map(B)))

    insert('INSERT INTO canvas_stations (ord,id,tabId,name,x,y,status,createdAt) VALUES (?,?,?,?,?,?,?,?)',
      state.canvasStations.map((s, i) => [i, s.id, s.tabId, s.name, s.x, s.y, s.status, s.createdAt].map(B)))

    db.run("INSERT OR REPLACE INTO meta (key,value) VALUES ('initialized','1'), ('schema_version',?), ('activeMasterProject',?)", [String(SCHEMA_VERSION), state.activeMasterProjectId ?? ''])
    db.run('COMMIT')
  } catch (e) {
    db.run('ROLLBACK')
    throw e
  }

  const out = db.export()
  // Never overwrite the on-disk file with an image SQLite can't read back —
  // verify the export opens cleanly first (guards against in-memory corruption
  // propagating to disk, which is how data loss becomes permanent).
  if (sqlModule) {
    const probe = new sqlModule.Database(out)
    try {
      probe.exec('PRAGMA quick_check')
    } finally {
      try { probe.close() } catch { /* ignore */ }
    }
  }
  await saveBytes(out)
}

// ── Generic key/value blobs (used to persist the mindtrain store inside the
// same SQLite DB, so it rides along in the file and in backups). Writes are
// funneled through the shared saveChain so they never race Constella's saveState.

/** Read a stored string blob, or null if absent. */
export async function loadKv(key: string): Promise<string | null> {
  const db = await getDb()
  const stmt = db.prepare('SELECT value FROM app_kv WHERE key=?')
  try {
    stmt.bind([key])
    if (stmt.step()) { const v = stmt.getAsObject().value; return v == null ? null : String(v) }
    return null
  } finally { stmt.free() }
}

function enqueueSaveKv(key: string, value: string | null): Promise<void> {
  saveChain = saveChain.catch(() => {}).then(async () => {
    const db = await getDb()
    if (value == null) db.run('DELETE FROM app_kv WHERE key=?', [key])
    else db.run('INSERT OR REPLACE INTO app_kv (key, value) VALUES (?, ?)', [key, value])
    await saveBytes(db.export())
  })
  return saveChain
}

/** Write (or, with null, delete) a string blob. Serialized via saveChain + persisted. */
export function saveKv(key: string, value: string | null): Promise<void> {
  if (writesFrozen) return Promise.resolve()
  return enqueueSaveKv(key, value)
}

/** Import-only variant of saveKv: writes even while writes are frozen. */
export function restoreKv(key: string, value: string | null): Promise<void> {
  return enqueueSaveKv(key, value)
}

// A cheap version token of the persisted DB, to detect when another device (iPad
// over the LAN) changed it and we should reload. '' when unavailable.
export async function dbEtag(): Promise<string> {
  try {
    if (isRemote) return await (await fetch('/api/db/etag', { cache: 'no-store' })).text()
    const api = (window as unknown as { api?: { dbEtag?: () => Promise<string> } }).api
    if (api?.dbEtag) return await api.dbEtag()
  } catch { /* ignore */ }
  return ''
}

// Drop the in-memory DB and re-read it from storage, to pick up changes another
// device made (focus-sync). Drains pending saves first so nothing in flight is lost.
export async function reloadState(): Promise<AppState | null> {
  await saveChain.catch(() => {})
  dbInstance = null
  initPromise = null
  return loadState()
}

/** Wipe the database (used for development resets). */
export async function resetDb(): Promise<void> {
  dbInstance = null
  initPromise = null
  const ed = electronDb()
  // Resets use the dedicated channel — an empty db:save payload is now a no-op
  // (a single buggy save call must never be able to delete the database).
  if (ed) { await (ed.reset ? ed.reset() : Promise.resolve()).catch(() => {}); return }
  const db = await openIdb()
  await new Promise<void>((resolve) => {
    const tx = db.transaction(IDB_STORE, 'readwrite')
    tx.objectStore(IDB_STORE).delete(IDB_KEY)
    tx.oncomplete = () => resolve()
    tx.onerror = () => resolve()
  })
}
