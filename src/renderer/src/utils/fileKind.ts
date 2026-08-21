// ファイル種別まわりの共通ヘルパー — ファイルライブラリ (FilesPage) とノート
// 付随資料 (NoteAttachments) で共有する。MIME 優先、空なら拡張子から推定。
import { FileText, Image as ImageIcon, Film, Music, File as FileIcon, type LucideIcon } from 'lucide-react'
import { localKind, type LocalKind } from './localFile'

export type FileKind = LocalKind // 'image' | 'pdf' | 'video' | 'audio' | 'other'

export function fileKind(mime: string, name: string): FileKind {
  if (mime.startsWith('image/')) return 'image'
  if (mime === 'application/pdf') return 'pdf'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  // MIME が空/不明（例: 一部のOSのドロップ）→ ファイル名の拡張子から推定
  return localKind(name)
}

export const FILE_KIND_ICON: Record<FileKind, LucideIcon> = {
  image: ImageIcon, pdf: FileText, video: Film, audio: Music, other: FileIcon,
}

export const FILE_KIND_TINT: Record<FileKind, string> = {
  image: 'text-emerald-500', pdf: 'text-rose-500', video: 'text-indigo-500',
  audio: 'text-violet-500', other: 'text-slate-400',
}

export const FILE_KIND_LABEL: Record<FileKind, string> = {
  image: '画像', pdf: 'PDF', video: '動画', audio: '音声', other: 'その他',
}

export function formatSize(bytes: number): string {
  if (!bytes || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`
}
