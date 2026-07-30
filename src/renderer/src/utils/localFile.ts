// `local:` refs — assets referenced IN PLACE on a file server (NAS の UNC パス) or
// the local disk, instead of being imported into the IndexedDB media store. The
// DB stores only `local:<absolute path>`; bytes are read on demand through the
// Electron main process. Browser/remote clients cannot resolve these (no fs
// access) — call sites should degrade to a path chip with no preview.

export const LOCAL_PREFIX = 'local:'

export function isLocalRef(url: string | undefined | null): boolean {
  return !!url && url.startsWith(LOCAL_PREFIX)
}

/** Absolute filesystem path stored inside a `local:` ref. */
export function localRefPath(ref: string): string {
  return ref.slice(LOCAL_PREFIX.length)
}

export function toLocalRef(path: string): string {
  return LOCAL_PREFIX + path
}

/** Filename part of a path or `local:` ref (both / and \ separators). */
export function localFileName(pathOrRef: string): string {
  const p = isLocalRef(pathOrRef) ? localRefPath(pathOrRef) : pathOrRef
  return p.split(/[\\/]/).filter(Boolean).pop() || p
}

interface LocalFileApi {
  /** `kind` pre-selects the OS dialog's file filter; the caller still validates the result. */
  pick: (kind?: LocalKind) => Promise<string[] | null>
  stat: (path: string) => Promise<{ exists: boolean; size?: number; mtime?: number }>
  read: (path: string) => Promise<{ bytes: Uint8Array; mime: string } | null>
  open: (path: string) => Promise<string>
  reveal: (path: string) => Promise<void>
}

export function localFileApi(): LocalFileApi | null {
  const api = (window as unknown as { api?: { localFile?: LocalFileApi } }).api
  return api?.localFile ?? null
}

/** Preview kind inferred from the file extension. */
export type LocalKind = 'image' | 'pdf' | 'video' | 'audio' | 'other'

const EXT_KIND: Record<string, LocalKind> = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', avif: 'image', bmp: 'image', svg: 'image',
  pdf: 'pdf',
  mp4: 'video', webm: 'video', mov: 'video', m4v: 'video', mkv: 'video', ogv: 'video',
  mp3: 'audio', wav: 'audio', ogg: 'audio', m4a: 'audio', flac: 'audio', aac: 'audio',
}

export function localKind(pathOrRef: string): LocalKind {
  const name = localFileName(pathOrRef)
  const dot = name.lastIndexOf('.')
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
  return EXT_KIND[ext] ?? 'other'
}

/** Read the referenced file's bytes as a typed Blob (null if unavailable). */
export async function getLocalBlob(ref: string): Promise<Blob | null> {
  const api = localFileApi()
  if (!api) return null
  try {
    const r = await api.read(localRefPath(ref))
    if (!r) return null
    // Copy into a fresh ArrayBuffer-backed view (IPC can hand back a SharedArrayBuffer-typed view).
    const copy = new Uint8Array(r.bytes)
    return new Blob([copy.buffer], { type: r.mime })
  } catch { return null }
}

// Object URLs are cached per ref. Unlike media.ts (whose blobs are app-authored
// and small) a `local:` ref can point at a multi-GB video on a share, and each
// cached URL pins its bytes in renderer memory for as long as it lives — a few
// large cards used to be enough to push the process into an OOM. So the cache is
// byte-budgeted and evicts least-recently-used entries, revoking their URLs.
//
// Eviction may only touch entries nothing is displaying: revoking a URL that is
// still a live <img>/<video> src would blank it. Call sites that render a
// resolved URL therefore retain it and release on unmount (see useMediaState);
// retained entries are skipped by the sweep even when over budget.
const URL_CACHE_BUDGET = 256 * 1024 * 1024

interface CacheEntry {
  url: string
  size: number
  refs: number
  usedAt: number
}

const urlCache = new Map<string, CacheEntry>()
let cachedBytes = 0
let useCounter = 0

function evictToBudget(): void {
  if (cachedBytes <= URL_CACHE_BUDGET) return
  // Oldest-used first, skipping anything currently on screen.
  const evictable = [...urlCache.entries()].filter(([, e]) => e.refs === 0).sort((a, b) => a[1].usedAt - b[1].usedAt)
  for (const [ref, e] of evictable) {
    if (cachedBytes <= URL_CACHE_BUDGET) break
    URL.revokeObjectURL(e.url)
    urlCache.delete(ref)
    cachedBytes -= e.size
  }
}

/**
 * Object URL for a `local:` ref, or null when the bytes can't be read.
 *
 * Pass `retain` when the URL is about to be displayed: the entry is then pinned
 * as part of the same synchronous step that creates it, so no interleaved
 * eviction can revoke it in the gap, and the caller must {@link releaseLocalUrl}
 * when the element goes away.
 */
export async function resolveLocalUrl(ref: string, retain = false): Promise<string | null> {
  const pin = (e: CacheEntry): string => {
    e.usedAt = ++useCounter
    if (retain) e.refs++
    return e.url
  }
  const cached = urlCache.get(ref)
  if (cached) return pin(cached)
  const blob = await getLocalBlob(ref)
  if (!blob) return null
  // A concurrent caller may have populated the entry while we were reading; keep
  // one URL per ref so retain/release counts stay meaningful.
  const raced = urlCache.get(ref)
  if (raced) return pin(raced)
  const entry: CacheEntry = { url: URL.createObjectURL(blob), size: blob.size, refs: 0, usedAt: ++useCounter }
  urlCache.set(ref, entry)
  cachedBytes += blob.size
  const url = pin(entry)
  evictToBudget()
  return url
}

/** Counterpart to {@link retainLocalUrl}; the entry becomes evictable at zero. */
export function releaseLocalUrl(ref: string): void {
  const e = urlCache.get(ref)
  if (!e) return
  e.refs = Math.max(0, e.refs - 1)
  if (e.refs === 0) evictToBudget()
}
