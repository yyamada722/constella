// ファイル種別まわりの共通ヘルパー — ファイルライブラリ (FilesPage) とノート
// 付随資料 (NoteAttachments) で共有する。MIME 優先、空なら拡張子から推定。
import { FileText, Image as ImageIcon, Film, Music, File as FileIcon, Briefcase, type LucideIcon } from 'lucide-react'
import { localKind, type LocalKind } from './localFile'

export type FileKind = LocalKind // 'image' | 'pdf' | 'video' | 'audio' | 'office' | 'other'

export function fileKind(mime: string, name: string): FileKind {
  if (mime.startsWith('image/')) return 'image'
  if (mime === 'application/pdf') return 'pdf'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  if (isOfficeMime(mime)) return 'office'
  // MIME が空/不明（例: 一部のOSのドロップ）→ ファイル名の拡張子から推定
  return localKind(name)
}

export const FILE_KIND_ICON: Record<FileKind, LucideIcon> = {
  image: ImageIcon, pdf: FileText, video: Film, audio: Music, office: Briefcase, other: FileIcon,
}

export const FILE_KIND_TINT: Record<FileKind, string> = {
  image: 'text-emerald-500', pdf: 'text-rose-500', video: 'text-indigo-500',
  audio: 'text-violet-500', office: 'text-sky-600', other: 'text-slate-400',
}

export const FILE_KIND_LABEL: Record<FileKind, string> = {
  image: '画像', pdf: 'PDF', video: '動画', audio: '音声', office: 'Office', other: 'その他',
}

export function formatSize(bytes: number): string {
  if (!bytes || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`
}

// ── Office 文書 ──
// プレビューはアプリ内レンダラ（docx-preview / SheetJS / pptx-preview）で行う。
// 対応するのは OOXML（.docx/.xlsx/.pptx）と、SheetJS が読める旧 Excel/ODS のみ。
// 旧 Word/PowerPoint（.doc/.ppt）と ODT/ODP は 'unsupported'（OSのアプリで開く）。
export type OfficeFormat = 'docx' | 'xlsx' | 'pptx' | 'unsupported'

const OFFICE_MIME: Record<string, OfficeFormat> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-excel.sheet.macroenabled.12': 'xlsx',
  'application/vnd.ms-excel': 'xlsx',
  'application/vnd.oasis.opendocument.spreadsheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/msword': 'unsupported',
  'application/vnd.ms-powerpoint': 'unsupported',
  'application/vnd.oasis.opendocument.text': 'unsupported',
  'application/vnd.oasis.opendocument.presentation': 'unsupported',
}
const OFFICE_EXT: Record<string, OfficeFormat> = {
  docx: 'docx', xlsx: 'xlsx', xlsm: 'xlsx', xls: 'xlsx', ods: 'xlsx', pptx: 'pptx',
  doc: 'unsupported', ppt: 'unsupported', odt: 'unsupported', odp: 'unsupported',
}

function isOfficeMime(mime: string): boolean {
  return mime.toLowerCase() in OFFICE_MIME
}

/** Office 文書の描画方式。拡張子優先（MIME は OS により zip/octet-stream で届くことがある）。 */
export function officeFormat(mime: string, name: string): OfficeFormat {
  const dot = name.lastIndexOf('.')
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
  return OFFICE_EXT[ext] ?? OFFICE_MIME[mime.toLowerCase()] ?? 'unsupported'
}
