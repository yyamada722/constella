// Durable media store. Images / PDFs / videos used to be held as ephemeral
// `blob:` object URLs that die on reload; here we persist the actual bytes in
// IndexedDB (available in both the browser preview and the Electron renderer)
// and reference them by a stable `idb:<id>` URL.
import { useEffect, useState } from 'react'
import { generateId } from '../utils'
import { isRemote } from './runtime'

const DB_NAME = 'constella_media'
const OLD_DB_NAME = 'maind_set_media' // pre-rename store; migrated once on first open
const STORE = 'blobs'
const VERSION = 1

export const MEDIA_PREFIX = 'idb:'

let dbPromise: Promise<IDBDatabase> | null = null

function rawOpen(name: string, version?: number, create = false): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = version != null ? indexedDB.open(name, version) : indexedDB.open(name)
    req.onupgradeneeded = () => { const db = req.result; if (create && !db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE) }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

// One-time copy of blobs from the former `maind_set_media` store into the new
// one. Only runs when the new store is empty, and never deletes the old data
// (left as a safety backup), so it is idempotent and non-destructive.
async function migrateOldMedia(newDb: IDBDatabase): Promise<void> {
  const isEmpty = await new Promise<boolean>((resolve) => {
    const tx = newDb.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).count()
    req.onsuccess = () => resolve(req.result === 0)
    req.onerror = () => resolve(false)
  })
  if (!isEmpty) return
  // Avoid creating an empty old DB if it never existed.
  try {
    const dbs = await indexedDB.databases()
    if (dbs.length && !dbs.some(d => d.name === OLD_DB_NAME)) return
  } catch { /* databases() unsupported → just try opening below */ }
  let oldDb: IDBDatabase
  try { oldDb = await rawOpen(OLD_DB_NAME) } catch { return }
  if (!oldDb.objectStoreNames.contains(STORE)) { oldDb.close(); return }
  const entries = await new Promise<[IDBValidKey, Blob][]>((resolve) => {
    const out: [IDBValidKey, Blob][] = []
    const tx = oldDb.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).openCursor()
    req.onsuccess = () => { const cur = req.result; if (cur) { out.push([cur.key, cur.value as Blob]); cur.continue() } else resolve(out) }
    req.onerror = () => resolve(out)
  })
  oldDb.close()
  if (!entries.length) return
  await new Promise<void>((resolve, reject) => {
    const tx = newDb.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    for (const [k, v] of entries) store.put(v, k)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = (async () => {
    const db = await rawOpen(DB_NAME, VERSION, true)
    try { await migrateOldMedia(db) } catch { /* best-effort; old store stays intact */ }
    return db
  })()
  return dbPromise
}

export function isMediaRef(url: string | undefined | null): boolean {
  return !!url && url.startsWith(MEDIA_PREFIX)
}

/** Persist a file/blob and return its stable `idb:<id>` reference. */
export async function putMedia(blob: Blob): Promise<string> {
  // Remote clients (iPad over LAN) can view media but can't add new media yet — the
  // desktop renderer owns the media store. Surface a clear error to the caller.
  if (isRemote) throw new Error('外部アクセス（iPadなど）からのメディア追加は未対応です。PC側で追加してください。')
  const id = generateId()
  const db = await openDB()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(blob, id)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  return MEDIA_PREFIX + id
}

export async function getMediaBlob(ref: string): Promise<Blob | null> {
  const id = ref.slice(MEDIA_PREFIX.length)
  if (isRemote) {
    try { const res = await fetch(`/api/media/${id}`, { cache: 'no-store' }); return res.ok ? await res.blob() : null } catch { return null }
  }
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(id)
    req.onsuccess = () => resolve((req.result as Blob) ?? null)
    req.onerror = () => reject(req.error)
  })
}

// Export every stored blob as a { id -> dataURL } map (for backups).
export async function exportAllMedia(): Promise<Record<string, string>> {
  const db = await openDB()
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).openCursor()
    const out: Record<string, string> = {}
    const reads: Promise<void>[] = []
    req.onsuccess = () => {
      const cur = req.result
      if (cur) {
        const key = String(cur.key), blob = cur.value as Blob
        reads.push(new Promise<void>(res => { const fr = new FileReader(); fr.onloadend = () => { if (typeof fr.result === 'string') out[key] = fr.result; res() }; fr.readAsDataURL(blob) }))
        cur.continue()
      } else {
        Promise.all(reads).then(() => resolve(out))
      }
    }
    req.onerror = () => resolve(out)
  })
}

// Restore blobs from a { id -> dataURL } map (from a backup).
export async function importMedia(map: Record<string, string>): Promise<void> {
  const entries = await Promise.all(
    Object.entries(map).map(async ([key, dataUrl]) => [key, await (await fetch(dataUrl)).blob()] as [string, Blob])
  )
  const db = await openDB()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    for (const [key, blob] of entries) store.put(blob, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function deleteMedia(ref: string): Promise<void> {
  if (!isMediaRef(ref)) return
  if (isRemote) return // remote clients never delete the desktop's media store
  const id = ref.slice(MEDIA_PREFIX.length)
  const cached = urlCache.get(ref)
  if (cached) { URL.revokeObjectURL(cached); urlCache.delete(ref) }
  const db = await openDB()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(id)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

/**
 * Delete stored blobs that are not referenced by `liveRefs` — with a GRACE
 * PERIOD. A blob is only deleted after it has stayed unreferenced for 7 days
 * (tracked across runs in localStorage). This protects media that is only
 * referenced by a backup/older DB state (e.g. right after a corruption
 * recovery, before the full state is restored) from being reclaimed by a boot
 * into a partial state. Returns the number of blobs actually deleted.
 */
const SWEEP_CANDIDATES_KEY = 'constella.media.sweepCandidates'
const SWEEP_GRACE_MS = 7 * 24 * 60 * 60 * 1000

export async function sweepMedia(liveRefs: Iterable<string | undefined | null>): Promise<number> {
  if (isRemote) return 0 // the desktop renderer owns the media store & its sweep
  const live = new Set<string>()
  for (const ref of liveRefs) if (isMediaRef(ref)) live.add(ref!.slice(MEDIA_PREFIX.length))
  // firstSeenUnreferenced timestamps from previous runs.
  let candidates: Record<string, number> = {}
  try { candidates = JSON.parse(localStorage.getItem(SWEEP_CANDIDATES_KEY) || '{}') } catch { /* reset */ }
  const now = Date.now()
  const db = await openDB()
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    const req = store.getAllKeys()
    let removed = 0
    req.onsuccess = () => {
      const next: Record<string, number> = {}
      for (const key of req.result) {
        if (typeof key !== 'string') continue
        if (live.has(key)) continue // referenced → drop any pending candidacy
        const firstSeen = candidates[key] ?? now
        if (now - firstSeen >= SWEEP_GRACE_MS) {
          store.delete(key)
          removed++
        } else {
          next[key] = firstSeen // still in grace — keep waiting
        }
      }
      try { localStorage.setItem(SWEEP_CANDIDATES_KEY, JSON.stringify(next)) } catch { /* ignore */ }
    }
    tx.oncomplete = () => resolve(removed)
    tx.onerror = () => resolve(removed)
  })
}

// Object URLs are cached per ref and reused for the app lifetime — cheap, and
// avoids re-reading the blob on every render.
const urlCache = new Map<string, string>()

export async function resolveMediaUrl(ref: string): Promise<string | null> {
  const cached = urlCache.get(ref)
  if (cached) return cached
  // Remote: the LAN server serves the bytes directly — use the URL as-is (no blob).
  if (isRemote) { const url = `/api/media/${ref.slice(MEDIA_PREFIX.length)}`; urlCache.set(ref, url); return url }
  const blob = await getMediaBlob(ref)
  if (!blob) return null
  const url = URL.createObjectURL(blob)
  urlCache.set(ref, url)
  return url
}

/**
 * Resolve a card URL for rendering. Pass-through for normal http/data/blob URLs
 * (incl. the bundled sample PDF); `idb:` refs are loaded from IndexedDB and
 * turned into a usable object URL.
 */
export function useMediaUrl(ref: string | undefined | null): string | undefined {
  const [url, setUrl] = useState<string | undefined>(() => (ref && !isMediaRef(ref) ? ref : undefined))
  useEffect(() => {
    let alive = true
    if (!ref) { setUrl(undefined); return }
    if (!isMediaRef(ref)) { setUrl(ref); return }
    setUrl(undefined)
    resolveMediaUrl(ref).then(u => { if (alive) setUrl(u ?? undefined) })
    return () => { alive = false }
  }, [ref])
  return url
}
