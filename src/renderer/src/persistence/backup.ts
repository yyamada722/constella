import type { AppState } from '../store'
import { saveState, loadKv, saveKv } from './db'
import { exportAllMedia, importMedia } from './media'

// App marker in backup files. 'maind_set' is the legacy value kept for importing
// older backups; new exports use 'constella'.
const BACKUP_MARKERS = ['constella', 'maind_set'] as const

interface Backup {
  app: (typeof BACKUP_MARKERS)[number]
  version: number
  exportedAt: string
  state: AppState
  media: Record<string, string>
  mindtrain?: string // serialized 路線図 store (zustand persist blob), optional
}

// Download a full backup (structured state + all media blobs) as a single JSON file.
export async function exportBackup(state: AppState): Promise<void> {
  const media = await exportAllMedia()
  const mindtrain = await loadKv('mindtrain')
  const backup: Backup = { app: 'constella', version: 2, exportedAt: new Date().toISOString(), state, media, ...(mindtrain ? { mindtrain } : {}) }
  const blob = new Blob([JSON.stringify(backup)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  a.href = url
  a.download = `constella-backup-${stamp}.json`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

// Restore from a backup file: media to IndexedDB, state to SQLite. Caller should reload.
export async function importBackup(file: File): Promise<void> {
  const backup = JSON.parse(await file.text()) as Partial<Backup>
  if (!backup.app || !BACKUP_MARKERS.includes(backup.app) || !backup.state) throw new Error('Constella のバックアップファイルではありません')
  if (backup.media) await importMedia(backup.media)
  await saveState(backup.state)
  // Restore (or clear) the 路線図 store blob so it matches the backup.
  await saveKv('mindtrain', backup.mindtrain ?? null)
}
