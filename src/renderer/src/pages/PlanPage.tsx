// 計画ページ (/plan) — アセット撮影の出張・ロケハンなどを TripMD 互換の markdown で
// 記述し、日別タイムラインとして表示する。eチケットの PDF は「添付」(idb: に取り込み)
// または「サーバー参照」(local: パス参照) としてリンクし、プレビューでクリック展開。
import { useState, useMemo, useRef, useEffect } from 'react'
import {
  Plus, Trash2, Pencil, Eye, Columns2, Map, Paperclip, HardDrive, CircleHelp,
} from 'lucide-react'
import { useApp } from '../store'
import { Plan } from '../types'
import { generateId } from '../utils'
import { putMedia } from '../persistence/media'
import { localFileApi, localFileName, toLocalRef } from '../utils/localFile'
import { ItineraryView } from '../components/ItineraryView'
import { confirmDialog } from '../components/ConfirmDialog'

const TEMPLATE = `---
title: アセット撮影 出張計画
timezone: Asia/Tokyo
currency: JPY
---

## 2026-08-01

> [!NOTE] 持ち物
> カメラ本体 / 予備バッテリー / カラーチェッカー / 三脚 / ND フィルター

> [07:30] - [09:45] flight NH000 from 羽田空港^HND to 新千歳空港^CTS
> - price: JPY {28000}
> - note: eチケットは「添付」からPDFをリンク

> [11:00] hotel チェックイン :: ホテル名
> [13:00] - [17:00] shoot 街並みアセット撮影 at 撮影場所
> - note: フォトグラメトリ用に全周撮影

## 2026-08-02

> [09:00] - [12:00] scan 素材スキャン at ロケ地
> [pm] shopping 資料・小物調達
> [18:00] flight NH001 from 新千歳空港^CTS to 羽田空港^HND
> - price: JPY {28000}
`

const SYNTAX_HELP: [string, string][] = [
  ['## 2026-08-01', '日付見出し（@Asia/Tokyo でTZ指定可）'],
  ['> [09:00] shoot タイトル', '予定行（時刻+種別+内容）'],
  ['> [09:00] - [17:00] …', '時間の範囲'],
  ['> [am] / [pm] / []', 'おおまかな時刻・未定'],
  ['… from 羽田^HND to 新千歳^CTS', '出発地 → 到着地（^は略号バッジ）'],
  ['… at 場所  /  … :: 場所', '場所の指定'],
  ['> - price: JPY {28000*2}', '費用（{}内は計算式可・自動合計）'],
  ['> - note: メモ', '任意のメタデータ'],
  ['> [!NOTE] 持ち物', 'アラート（NOTE/TIP/WARNING/CAUTION）'],
  ['[名前](https://…)', 'リンク（クリックで内容をインライン表示）'],
  ['[チケット.pdf](idb:… / local:…)', '添付・サーバー参照（クリックでPDF等を展開）'],
]

const EVENT_TYPES = 'flight / train / bus / car / ferry / walk / hotel / meal / cafe / museum / activity / shoot / scan / location / meeting / shopping / prep'

export default function PlanPage() {
  const { state, dispatch } = useApp()
  const active = state.activeMasterProjectId
  const plans = useMemo(
    () => state.plans.filter(p => p.masterProjectId === active).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [state.plans, active]
  )
  const [selectedId, setSelectedId] = useState<string | null>(plans[0]?.id ?? null)
  const selected = plans.find(p => p.id === selectedId) ?? null
  // マスター切替や削除で選択が消えたら先頭へフォールバック。
  useEffect(() => {
    if (!selected && plans.length > 0) setSelectedId(plans[0].id)
    if (plans.length === 0 && selectedId) setSelectedId(null)
  }, [plans, selected, selectedId])

  const [viewMode, setViewMode] = useState<'edit' | 'split' | 'preview'>(() => {
    try {
      const v = localStorage.getItem('constella.plan.viewMode')
      return v === 'edit' || v === 'preview' ? v : 'split'
    } catch { return 'split' }
  })
  useEffect(() => { try { localStorage.setItem('constella.plan.viewMode', viewMode) } catch { /* ignore */ } }, [viewMode])

  const textRef = useRef<HTMLTextAreaElement>(null)
  const localApi = localFileApi()

  const update = (patch: Partial<Plan>) => {
    if (!selected) return
    dispatch({ type: 'UPDATE_PLAN', payload: { ...selected, ...patch, updatedAt: new Date().toISOString() } })
  }

  const addPlan = () => {
    const now = new Date().toISOString()
    const p: Plan = { id: generateId(), masterProjectId: active, name: '新しい撮影計画', content: TEMPLATE, createdAt: now, updatedAt: now }
    dispatch({ type: 'ADD_PLAN', payload: p })
    setSelectedId(p.id)
    if (viewMode === 'preview') setViewMode('split')
  }

  const deletePlan = async (p: Plan) => {
    if (!(await confirmDialog(`計画「${p.name}」を削除します。よろしいですか？`))) return
    dispatch({ type: 'DELETE_PLAN', payload: p.id })
    if (selectedId === p.id) setSelectedId(null)
  }

  // ── caret 位置に markdown を挿入 ──
  const insertAtCaret = (text: string) => {
    if (!selected) return
    const ta = textRef.current
    const v = selected.content
    if (!ta) { update({ content: v + (v.endsWith('\n') || !v ? '' : '\n') + text }); return }
    const s = ta.selectionStart ?? v.length
    const e = ta.selectionEnd ?? s
    const next = v.slice(0, s) + text + v.slice(e)
    update({ content: next })
    requestAnimationFrame(() => {
      ta.focus()
      const pos = s + text.length
      ta.setSelectionRange(pos, pos)
    })
  }

  // 添付: ファイルを media ストアへ取り込み → [name](idb:…) を挿入
  const attachFile = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.onchange = async () => {
      const files = [...(input.files ?? [])]
      const parts: string[] = []
      for (const f of files) {
        try { parts.push(`[${f.name}](${await putMedia(f)})`) } catch { /* remote 等 */ }
      }
      if (parts.length) insertAtCaret(parts.join(' '))
    }
    input.click()
  }

  // サーバー参照: パスだけを保存する local: リンクを挿入（Electron のみ）
  const insertLocalRef = async () => {
    if (!localApi) return
    const paths = await localApi.pick().catch(() => null)
    if (!paths?.length) return
    insertAtCaret(paths.map(p => `[${localFileName(p)}](${toLocalRef(p)})`).join(' '))
  }

  const showEditor = viewMode !== 'preview' && !!selected
  const showPreview = viewMode !== 'edit' && !!selected

  return (
    <div className="h-full flex bg-white">
      {/* ── 計画リスト ── */}
      <div className="w-56 shrink-0 border-r border-slate-200 flex flex-col bg-slate-50/60">
        <div className="px-3 py-2.5 border-b border-slate-200 flex items-center justify-between">
          <span className="text-xs font-semibold text-slate-500 flex items-center gap-1.5"><Map size={13} className="text-cyan-600" /> 撮影計画</span>
          <button onClick={addPlan} title="新しい計画" className="p-1 rounded hover:bg-slate-200 text-slate-500 hover:text-cyan-600 transition-colors">
            <Plus size={15} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto py-1">
          {plans.length === 0 && (
            <div className="px-3 py-6 text-[11px] text-slate-400 text-center leading-relaxed">
              計画がまだありません。<br />+ で撮影出張の行程を作成
            </div>
          )}
          {plans.map(p => (
            <div
              key={p.id}
              onClick={() => setSelectedId(p.id)}
              className={`group mx-1.5 mb-0.5 px-2 py-1.5 rounded-md cursor-pointer flex items-center gap-1.5 ${
                p.id === selectedId ? 'bg-cyan-50 border border-cyan-200' : 'border border-transparent hover:bg-slate-100'
              }`}
            >
              <div className="flex-1 min-w-0">
                <div className={`text-xs truncate ${p.id === selectedId ? 'text-cyan-800 font-medium' : 'text-slate-700'}`}>{p.name || '無題の計画'}</div>
                <div className="text-[9px] text-slate-400">{p.updatedAt.slice(0, 10)}</div>
              </div>
              <button
                onClick={e => { e.stopPropagation(); deletePlan(p) }}
                title="削除"
                className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-rose-100 text-slate-400 hover:text-rose-500 transition-all"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* ── メイン ── */}
      <div className="flex-1 min-w-0 flex flex-col">
        {selected ? (
          <>
            {/* ヘッダ */}
            <div className="px-4 py-2 border-b border-slate-200 flex items-center gap-2">
              <input
                value={selected.name}
                onChange={e => update({ name: e.target.value })}
                placeholder="計画名"
                className="flex-1 min-w-0 text-sm font-semibold text-slate-800 bg-transparent outline-none focus:bg-slate-50 rounded px-1.5 py-1"
              />
              {/* 添付ボタン群（編集時のみ） */}
              {showEditor && (
                <>
                  <button
                    onClick={attachFile}
                    title="ファイルを添付（アプリ内に取り込み、[名前](idb:…) を挿入）"
                    className="flex items-center gap-1 px-2 py-1 rounded-md border border-slate-200 text-[11px] text-slate-600 hover:border-indigo-300 hover:text-indigo-600 transition-colors"
                  >
                    <Paperclip size={12} /> 添付
                  </button>
                  {localApi && (
                    <button
                      onClick={insertLocalRef}
                      title="サーバー / ローカルのファイルをパス参照でリンク（取り込まず [名前](local:パス) を挿入）"
                      className="flex items-center gap-1 px-2 py-1 rounded-md border border-slate-200 text-[11px] text-slate-600 hover:border-cyan-300 hover:text-cyan-600 transition-colors"
                    >
                      <HardDrive size={12} /> サーバー参照
                    </button>
                  )}
                  <details className="relative">
                    <summary className="list-none cursor-pointer p-1 rounded hover:bg-slate-100 text-slate-400 hover:text-slate-600 flex" title="記法ヘルプ">
                      <CircleHelp size={15} />
                    </summary>
                    <div className="absolute right-0 top-7 z-30 w-[380px] p-3 rounded-lg border border-slate-200 bg-white shadow-xl">
                      <div className="text-[11px] font-semibold text-slate-600 mb-2">記法（TripMD 互換）</div>
                      <div className="space-y-1">
                        {SYNTAX_HELP.map(([syn, desc]) => (
                          <div key={syn} className="flex items-start gap-2 text-[11px]">
                            <code className="shrink-0 px-1 py-0.5 rounded bg-slate-100 font-mono text-slate-600 text-[10px]">{syn}</code>
                            <span className="text-slate-500">{desc}</span>
                          </div>
                        ))}
                      </div>
                      <div className="mt-2 pt-2 border-t border-slate-100 text-[10px] text-slate-400 leading-relaxed">
                        種別の例: {EVENT_TYPES}
                      </div>
                    </div>
                  </details>
                </>
              )}
              {/* 表示切替 */}
              <div className="flex rounded-md border border-slate-200 overflow-hidden">
                {([['edit', Pencil, '編集'], ['split', Columns2, '分割'], ['preview', Eye, 'プレビュー']] as const).map(([mode, Icon, label]) => (
                  <button
                    key={mode}
                    onClick={() => setViewMode(mode)}
                    title={label}
                    className={`px-2 py-1 flex items-center gap-1 text-[11px] transition-colors ${
                      viewMode === mode ? 'bg-cyan-50 text-cyan-700' : 'text-slate-500 hover:bg-slate-50'
                    }`}
                  >
                    <Icon size={12} /> {label}
                  </button>
                ))}
              </div>
            </div>

            {/* 本文 */}
            <div className="flex-1 min-h-0 flex">
              {showEditor && (
                <textarea
                  ref={textRef}
                  value={selected.content}
                  onChange={e => update({ content: e.target.value })}
                  spellCheck={false}
                  placeholder={'## 2026-08-01\n\n> [09:00] shoot 撮影内容 at 場所'}
                  className={`${showPreview ? 'w-1/2 border-r border-slate-200' : 'flex-1'} min-w-0 resize-none outline-none p-4 font-mono text-[12.5px] leading-relaxed text-slate-700 bg-slate-50/40`}
                />
              )}
              {showPreview && (
                <div className={`${showEditor ? 'w-1/2' : 'flex-1'} min-w-0 overflow-y-auto`}>
                  <ItineraryView content={selected.content} fallbackTitle={selected.name} />
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 text-slate-400">
            <Map size={40} className="opacity-30" />
            <div className="text-sm">撮影出張・ロケハンの行程を markdown で計画できます</div>
            <button
              onClick={addPlan}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-500/10 border border-cyan-500/30 text-cyan-600 hover:bg-cyan-500/20 transition-colors text-sm"
            >
              <Plus size={15} /> 撮影計画を作成
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
