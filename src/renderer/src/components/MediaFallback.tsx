// Placeholder shown in place of a card's media when the bytes are not (yet)
// available. Splitting "still loading" from "will never load" matters most for
// `local:` refs: a browser client can never read them, and a NAS path can be
// unreachable or deleted — both used to sit on 読み込み中… forever.
import { FileWarning, FolderOpen, Loader } from 'lucide-react'
import type { MediaStatus } from '../persistence/media'
import { isLocalRef, localFileApi, localFileName, localRefPath } from '../utils/localFile'

const MESSAGE: Record<Exclude<MediaStatus, 'ready'>, string> = {
  loading: '読み込み中…',
  unsupported: 'この端末からはサーバー上のファイルを読めません',
  missing: 'ファイルを読み込めませんでした',
}

export function MediaFallback({ status, refUrl, compact }: {
  /** `ready` is accepted (and rendered as loading) so call sites can pass the hook's status straight through. */
  status: MediaStatus
  /** The card's stored ref, so a `local:` path can be shown / opened. */
  refUrl?: string | null
  /** Tighter layout for small card bodies (image/audio) vs. full-height PDF/video. */
  compact?: boolean
}) {
  const state: Exclude<MediaStatus, 'ready'> = status === 'ready' ? 'loading' : status
  const local = isLocalRef(refUrl)
  const api = localFileApi()
  const path = local && refUrl ? localRefPath(refUrl) : null

  return (
    <div className={`flex flex-col items-center justify-center gap-1 text-center px-3 ${compact ? '' : 'flex-1'}`}>
      <div className="flex items-center gap-1.5 text-slate-400 text-[11px]">
        {state === 'loading'
          ? <Loader size={12} className="animate-spin opacity-70" />
          : <FileWarning size={12} className="opacity-70" />}
        {MESSAGE[state]}
      </div>
      {path && (
        <>
          <span className="text-[10px] text-slate-400 break-all leading-snug max-w-full" title={path}>
            {localFileName(path)}
          </span>
          {state !== 'loading' && api && (
            <button
              onMouseDown={e => e.stopPropagation()}
              onClick={e => { e.stopPropagation(); api.reveal(path).catch(() => {}) }}
              title={path}
              className="mt-0.5 inline-flex items-center gap-1 px-2 py-0.5 rounded border border-slate-200 text-[10px] text-slate-400 hover:text-cyan-600 hover:border-cyan-300 transition-colors"
            >
              <FolderOpen size={10} /> 場所を表示
            </button>
          )}
        </>
      )}
    </div>
  )
}
