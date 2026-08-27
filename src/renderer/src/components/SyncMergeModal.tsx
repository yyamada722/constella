// 同期競合の「項目単位マージ」モーダル — 競合バナーの「内容を確認して選ぶ…」から。
// 相手だけ/自分だけ/両方 の変更を分類し、フィールドの変更プレビュー付きで
// どこまで取り込むかを行ごとに選んでマージ → 新世代として push する。
import { useEffect, useState } from 'react'
import { X, GitMerge } from 'lucide-react'
import { useApp } from '../store'
import { prepareSyncMerge, applySyncMerge, type SyncMergePlan, type SyncMergeRow } from '../persistence/syncMerge'
import { manualFolderSync } from '../persistence/folderSync'

interface Props {
  open: boolean
  onClose: () => void
}

const SIDE_HEAD: Record<SyncMergeRow['side'], { title: string; hint: string }> = {
  both: { title: '両方で変更(要確認)', hint: 'どちらの版を残すか選んでください' },
  theirs: { title: '相手の変更', hint: '既定で取り込みます。取り込みたくない変更は「自分」に切り替え' },
  mine: { title: 'このPCの変更', hint: '既定で維持します。操作ミスなど不要な変更は「相手」で元に戻せます' },
}

function RowView({ row, deviceName, onSet }: { row: SyncMergeRow; deviceName: string; onSet: (r: 'theirs' | 'mine') => void }) {
  return (
    <div className="px-3 py-2 text-xs">
      <div className="flex items-center gap-2">
        <span className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500 shrink-0">{row.typeLabel}</span>
        <span className="flex-1 min-w-0 truncate text-slate-700 dark:text-slate-200 font-medium" title={row.label}>{row.label}</span>
        <span className="text-[10px] text-slate-400 shrink-0">{row.kindText}</span>
        <div className="flex rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden shrink-0">
          {(['theirs', 'mine'] as const).map(r => (
            <button
              key={r}
              onClick={() => onSet(r)}
              title={r === 'theirs' ? `${deviceName} の版にする` : 'このPCの版にする'}
              className={`px-2 py-0.5 text-[11px] ${row.resolution === r ? 'bg-indigo-500 text-white' : 'bg-white dark:bg-slate-900 text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800'}`}
            >
              {r === 'theirs' ? '相手' : '自分'}
            </button>
          ))}
        </div>
      </div>
      {row.fields.length > 0 && (
        <div className="mt-1 ml-1 space-y-0.5">
          {row.fields.map((f, i) => (
            <div key={i} className="flex items-baseline gap-1.5 text-[11px]">
              <span className="text-slate-400 shrink-0 w-20 truncate">{f.label}</span>
              {f.label === '…' ? (
                <span className="text-slate-400">他にも変更があります</span>
              ) : (
                <>
                  <span className={`truncate max-w-[180px] ${row.resolution === 'mine' ? 'text-slate-700 dark:text-slate-200 font-medium' : 'text-slate-400 line-through'}`}>{f.mine}</span>
                  <span className="text-slate-300 shrink-0">→</span>
                  <span className={`truncate max-w-[180px] ${row.resolution === 'theirs' ? 'text-indigo-600 font-medium' : 'text-slate-400'}`}>{f.theirs}</span>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function SyncMergeModal({ open, onClose }: Props) {
  const { state, dispatch } = useApp()
  const [plan, setPlan] = useState<SyncMergePlan | null>(null)
  const [rows, setRows] = useState<SyncMergeRow[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) { setPlan(null); setRows([]); setError(null); return }
    let alive = true
    prepareSyncMerge(state).then(p => {
      if (!alive) return
      setPlan(p)
      if (p.ok) setRows(p.rows.map(r => ({ ...r })))
    }).catch(e => { if (alive) setError(String(e instanceof Error ? e.message : e)) })
    return () => { alive = false }
    // 開いた瞬間の状態で差分を固定する(開いている間の編集は対象外)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!open) return null

  const setResolution = (key: string, r: 'theirs' | 'mine'): void =>
    setRows(prev => prev.map(x => (x.key === key ? { ...x, resolution: r } : x)))
  const setAll = (side: SyncMergeRow['side'], r: 'theirs' | 'mine'): void =>
    setRows(prev => prev.map(x => (x.side === side ? { ...x, resolution: r } : x)))

  const apply = async (): Promise<void> => {
    if (!plan?.ok || busy) return
    setBusy(true)
    setError(null)
    try {
      const r = await applySyncMerge(plan, rows)
      if (!r.ok) { setError(r.message); return }
      dispatch({ type: 'APPLY_STATE_PATCH', payload: r.patch })
      onClose()
      // 状態表示を「同期済み」に更新し、メディアの差分転送も走らせる。
      manualFolderSync().catch(() => { /* ignore */ })
    } finally { setBusy(false) }
  }

  const takeCount = rows.filter(r => r.resolution === 'theirs').length
  const deviceName = plan?.ok ? plan.deviceName : '相手のマシン'
  const groups = (['both', 'theirs', 'mine'] as const).map(side => ({ side, list: rows.filter(r => r.side === side) })).filter(g => g.list.length > 0)

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-900/40" onMouseDown={onClose}>
      <div
        className="w-[640px] max-w-[94vw] max-h-[88vh] flex flex-col bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-2xl p-5"
        onMouseDown={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-2">
          <h2 className="flex items-center gap-2 text-base font-semibold text-slate-800 dark:text-slate-100">
            <GitMerge size={17} /> 変更内容を確認してマージ
          </h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500"><X size={16} /></button>
        </div>

        {!plan && !error && <div className="py-8 text-center text-sm text-slate-400">差分を計算中…</div>}
        {error && <div className="mb-3 px-3 py-2 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-xs">{error}</div>}
        {plan && !plan.ok && (
          <div className="px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-amber-900 text-xs">{plan.message}</div>
        )}

        {plan?.ok && (
          <>
            <p className="text-xs text-slate-500 dark:text-slate-400 mb-2">
              「{deviceName}」との差分が {rows.length} 件あります。矢印の左が<b>このPC</b>、右が<b>相手</b>の値です。行ごとにどちらを残すか選べます。
            </p>
            <div className="flex-1 min-h-0 overflow-y-auto border border-slate-200 dark:border-slate-700 rounded-lg">
              {rows.length === 0 && (
                <div className="py-8 text-center text-sm text-slate-400">実質的な差分はありません。「マージを適用」でこのまま解決できます。</div>
              )}
              {groups.map(g => (
                <div key={g.side}>
                  <div className="sticky top-0 flex items-center gap-2 px-3 py-1.5 bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 text-[11px]">
                    <span className="font-semibold text-slate-600 dark:text-slate-300">{SIDE_HEAD[g.side].title}({g.list.length})</span>
                    <span className="text-slate-400 flex-1 truncate">{SIDE_HEAD[g.side].hint}</span>
                    <button onClick={() => setAll(g.side, 'theirs')} className="px-1.5 py-0.5 rounded border border-slate-200 dark:border-slate-600 text-slate-500 hover:bg-white dark:hover:bg-slate-700">全て相手</button>
                    <button onClick={() => setAll(g.side, 'mine')} className="px-1.5 py-0.5 rounded border border-slate-200 dark:border-slate-600 text-slate-500 hover:bg-white dark:hover:bg-slate-700">全て自分</button>
                  </div>
                  <div className="divide-y divide-slate-100 dark:divide-slate-800">
                    {g.list.map(row => (
                      <RowView key={row.key} row={row} deviceName={deviceName} onSet={r => setResolution(row.key, r)} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-3 flex items-center gap-2">
              <span className="text-[11px] text-slate-400">相手の変更を {takeCount} 件取り込み / 残りはこのPCを維持。適用後は Ctrl+Z で丸ごと戻せます</span>
              <button onClick={onClose} className="ml-auto px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800">キャンセル</button>
              <button
                onClick={() => { void apply() }}
                disabled={busy}
                className="px-3 py-1.5 rounded-lg bg-indigo-500 text-white text-xs font-semibold hover:bg-indigo-600 disabled:opacity-50"
              >
                {busy ? '適用中…' : 'マージを適用'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
