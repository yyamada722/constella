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
  pick: () => Promise<string[] | null>
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

// Object URLs are cached per ref for the app lifetime (same policy as media.ts).
// The URL is a byte snapshot; re-launching the app picks up server-side changes.
const urlCache = new Map<string, string>()

export async function resolveLocalUrl(ref: string): Promise<string | null> {
  const cached = urlCache.get(ref)
  if (cached) return cached
  const blob = await getLocalBlob(ref)
  if (!blob) return null
  const url = URL.createObjectURL(blob)
  urlCache.set(ref, url)
  return url
}
