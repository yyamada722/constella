// SQLite-backed persistence for the mindtrain (路線図) store, so its data lives
// in the same Constella database — surviving restarts and riding along in
// backups — instead of a separate localStorage bucket.
//
// Writes are debounced and flushed on pagehide/hide, so dragging a station
// (many rapid store updates) doesn't re-serialize the whole DB on every frame.
import { loadKv, saveKv } from '../persistence/db'

const KEY = 'mindtrain'
const LEGACY_LS_KEY = 'mindtrain-storage' // Phase 1 persisted straight to localStorage
const DEBOUNCE_MS = 500

let pending: string | null = null
let timer: ReturnType<typeof setTimeout> | null = null

function flush(): void {
  if (timer) { clearTimeout(timer); timer = null }
  if (pending != null) { const v = pending; pending = null; void saveKv(KEY, v) }
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flush)
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush() })
}

export const constellaMindtrainStorage = {
  getItem: async (_name: string): Promise<string | null> => {
    const fromDb = await loadKv(KEY)
    if (fromDb != null) return fromDb
    // One-time migration from the Phase 1 localStorage store.
    try {
      const ls = localStorage.getItem(LEGACY_LS_KEY)
      if (ls != null) { await saveKv(KEY, ls); localStorage.removeItem(LEGACY_LS_KEY); return ls }
    } catch { /* ignore */ }
    return null
  },
  setItem: (_name: string, value: string): void => {
    pending = value
    if (timer) clearTimeout(timer)
    timer = setTimeout(flush, DEBOUNCE_MS)
  },
  removeItem: (_name: string): void => {
    pending = null
    if (timer) { clearTimeout(timer); timer = null }
    void saveKv(KEY, null)
  },
}
