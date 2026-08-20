// 自動アップデートのUI。メインプロセス(updater.ts)の状態をミラーして、
//  - Winインストーラー版(mode='auto'): DL完了時に「再起動して更新」トースト
//  - mac/ポータブル版(mode='notify'): 新版検知時に「ダウンロードページを開く」トースト
// を出す。トーストは「あとで」でそのバージョンに限り再表示しない(localStorage)。
// auto系統は終了時にも自動適用されるので、無視しても次回起動で最新になる。
import { useEffect, useState } from 'react'
import { RefreshCw, ArrowUpCircle, X } from 'lucide-react'

export type UpdateState =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'uptodate' }
  | { phase: 'available'; version: string; url: string }
  | { phase: 'downloading'; version: string; percent: number }
  | { phase: 'downloaded'; version: string }
  | { phase: 'error'; message: string }

export interface UpdateApi {
  get: () => Promise<{ current: string; mode: 'auto' | 'notify'; state: UpdateState }>
  check: () => Promise<void>
  install: () => void
  openPage: () => Promise<void>
  onState: (cb: (state: UpdateState) => void) => () => void
}

export const updateApi: UpdateApi | undefined =
  (window as unknown as { api?: { update?: UpdateApi } }).api?.update

// メイン側のアップデート状態を購読する。設定モーダルとトーストで共用。
export function useUpdateState(): { current: string; mode: 'auto' | 'notify'; state: UpdateState } {
  const [snap, setSnap] = useState<{ current: string; mode: 'auto' | 'notify'; state: UpdateState }>({
    current: '', mode: 'notify', state: { phase: 'idle' },
  })
  useEffect(() => {
    if (!updateApi) return
    let alive = true
    updateApi.get().then(s => { if (alive) setSnap(s) }).catch(() => { /* ignore */ })
    const off = updateApi.onState(state => setSnap(prev => ({ ...prev, state })))
    return () => { alive = false; off() }
  }, [])
  return snap
}

const SKIP_KEY = 'constella.update.skipVersion'

export function UpdateNotifier() {
  const { mode, state } = useUpdateState()
  const [dismissed, setDismissed] = useState<string | null>(() => {
    try { return localStorage.getItem(SKIP_KEY) } catch { return null }
  })

  if (!updateApi) return null

  // トーストを出すのは「ユーザーの操作が意味を持つ」2状態のみ。
  const toast =
    state.phase === 'downloaded' ? { version: state.version, kind: 'restart' as const } :
    mode === 'notify' && state.phase === 'available' ? { version: state.version, kind: 'open' as const } :
    null
  if (!toast || dismissed === toast.version) return null

  const dismiss = () => {
    setDismissed(toast.version)
    try { localStorage.setItem(SKIP_KEY, toast.version) } catch { /* ignore */ }
  }

  return (
    <div className="fixed bottom-16 right-4 z-50 w-[300px] bg-white border border-slate-200 rounded-xl shadow-2xl p-3.5">
      <div className="flex items-start gap-2.5">
        <ArrowUpCircle size={18} className="text-indigo-500 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-slate-800">
            {toast.kind === 'restart' ? `v${toast.version} の準備ができました` : `新しいバージョン v${toast.version}`}
          </div>
          <p className="mt-0.5 text-[11px] text-slate-500">
            {toast.kind === 'restart'
              ? '再起動すると適用されます（次回終了時にも自動で適用）。'
              : 'リリースページから最新版をダウンロードできます。'}
          </p>
          <div className="mt-2 flex items-center gap-2">
            {toast.kind === 'restart' ? (
              <button
                onClick={() => updateApi.install()}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-indigo-500 hover:bg-indigo-600 text-white text-xs font-medium transition-colors"
              >
                <RefreshCw size={12} /> 再起動して更新
              </button>
            ) : (
              <button
                onClick={() => { void updateApi.openPage() }}
                className="px-2.5 py-1 rounded-lg bg-indigo-500 hover:bg-indigo-600 text-white text-xs font-medium transition-colors"
              >
                ダウンロードページを開く
              </button>
            )}
            <button onClick={dismiss} className="px-2 py-1 rounded-lg text-xs text-slate-500 hover:bg-slate-100">
              あとで
            </button>
          </div>
        </div>
        <button onClick={dismiss} title="閉じる" className="p-0.5 rounded hover:bg-slate-100 text-slate-400 shrink-0">
          <X size={14} />
        </button>
      </div>
    </div>
  )
}
