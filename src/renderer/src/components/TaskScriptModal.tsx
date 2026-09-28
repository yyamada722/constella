import { useEffect, useMemo, useState } from 'react'
import { SquareTerminal, X, Copy, ChevronDown, ChevronRight, ArrowRight } from 'lucide-react'
import type { Project } from '../types'
import type { Action } from '../store'
import { parseTaskScript, evaluateTaskScript, buildScriptPrompt, STATUS_LABEL, type TaskStatus } from '../utils/taskScript'

const STATUS_CLS: Record<TaskStatus, string> = {
  todo: 'bg-slate-100 text-slate-600',
  'in-progress': 'bg-amber-100 text-amber-700',
  done: 'bg-emerald-100 text-emerald-700',
}

const EXAMPLE = `// 1行1ルール。「状態: 対象」か「対象 -> 状態」
完了: 設計レビュー, "API 実装"
#backend @未着手 -> 進行中
期限<今日 @未着手 -> 進行中
/^テスト/ +子 -> 完了`

const CHEATSHEET: [string, string][] = [
  ['状態', '未着手 / 進行中 / 完了（todo / in-progress / done も可）'],
  ['タイトル', '部分一致（* でワイルドカード）、"完全一致"、/正規表現/'],
  ['id:ID', 'タスク ID で指定（プロンプトの一覧に載る ID）'],
  ['#タグ', 'タグで指定'],
  ['@状態', '現在の状態で絞る（@未着手 @進行中 @完了）'],
  ['期限<今日', '日付。期限 / 開始 と < <= > >= =、値は YYYY-MM-DD / 今日 / 今日+3'],
  ['P1〜P4', '優先度'],
  ['AND / OR', '空白区切りは AND、カンマ区切りは OR。* はすべて'],
  ['+子', 'そのタスクの子孫も対象にする'],
  ['//', 'コメント行'],
]

// 一括編集モーダル: スクリプト（または JSON）を貼り付け → 変更プレビュー →
// 1 undo ステップで適用。評価は開いた時点のタスクに対して行う。
export default function TaskScriptModal({ boards, currentBoardId, dispatch, onClose }: {
  boards: Project[]
  currentBoardId: string | null
  dispatch: (a: Action) => void
  onClose: () => void
}) {
  const [text, setText] = useState('')
  const [allBoards, setAllBoards] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [showHelp, setShowHelp] = useState(false)
  const scope = useMemo(() => allBoards ? boards : boards.filter(b => b.id === currentBoardId), [allBoards, boards, currentBoardId])
  const parsed = useMemo(() => parseTaskScript(text), [text])
  const result = useMemo(() => parsed.ok ? evaluateTaskScript(parsed.rules, scope) : null, [parsed, scope])
  const emptyLines = useMemo(() => parsed.ok ? parsed.rules.filter(r => (result?.matched.get(r.line) ?? 0) === 0) : [], [parsed, result])
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [onClose])

  const apply = () => {
    if (!result || result.changes.length === 0) return
    const actions: Action[] = result.changes.map(c => ({ type: 'UPDATE_TASK', payload: { projectId: c.projectId, task: { ...c.task, status: c.to } } }))
    dispatch(actions.length === 1 ? actions[0] : { type: 'BATCH', payload: actions })
    onClose()
  }

  const boardLabel = allBoards ? `全ボード（${boards.length}）` : (boards.find(b => b.id === currentBoardId)?.name ?? 'ボード')

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/40" onMouseDown={onClose}>
      <div className="bg-white rounded-xl shadow-2xl border border-slate-200 w-[760px] max-w-[94vw] max-h-[90vh] flex flex-col" onMouseDown={e => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-5 pt-4 pb-3 border-b border-slate-100">
          <SquareTerminal size={16} className="text-indigo-500" />
          <span className="text-slate-800 font-semibold">タスク状態の一括編集</span>
          <span className="ml-2 text-xs text-slate-500 truncate min-w-0">対象: <span className="text-slate-700 font-medium">{boardLabel}</span></span>
          <button onClick={onClose} className="ml-auto p-1 rounded hover:bg-slate-100 text-slate-500" title="閉じる"><X size={14} /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex items-center rounded-md border border-slate-200 overflow-hidden text-xs">
              <button onClick={() => setAllBoards(false)} className={`px-2.5 py-1 transition-colors ${!allBoards ? 'bg-indigo-500/15 text-indigo-600' : 'text-slate-500 hover:bg-slate-100'}`}>このボード</button>
              <button onClick={() => setAllBoards(true)} className={`px-2.5 py-1 transition-colors ${allBoards ? 'bg-indigo-500/15 text-indigo-600' : 'text-slate-500 hover:bg-slate-100'}`}>全ボード</button>
            </div>
            <button
              onClick={() => {
                navigator.clipboard.writeText(buildScriptPrompt(scope)).then(
                  () => setNotice('プロンプトをコピーしました — AI に貼り付け、出力されたスクリプトをこの下に戻してください'),
                  () => setNotice('クリップボードへのコピーに失敗しました'),
                )
              }}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-indigo-50 border border-indigo-200 text-indigo-700 text-xs hover:bg-indigo-100 transition-colors"
              title="タスク一覧＋スクリプト文法を含むプロンプトをコピー"
            >
              <Copy size={12} /> AI 用プロンプトをコピー
            </button>
            <button onClick={() => setText(EXAMPLE)} className="px-2.5 py-1.5 rounded-md border border-slate-200 text-xs text-slate-600 hover:bg-slate-50 transition-colors">例を入れる</button>
            <button onClick={() => setShowHelp(v => !v)} className="ml-auto flex items-center gap-1 text-xs text-slate-500 hover:text-slate-800">
              {showHelp ? <ChevronDown size={12} /> : <ChevronRight size={12} />} 書き方
            </button>
          </div>

          {showHelp && (
            <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px] bg-slate-50 border border-slate-200 rounded-md px-3 py-2">
              {CHEATSHEET.map(([k, v]) => (
                <div key={k} className="contents">
                  <code className="text-indigo-700 whitespace-nowrap">{k}</code>
                  <span className="text-slate-600">{v}</span>
                </div>
              ))}
              <div className="col-span-2 text-slate-400 pt-1">評価は実行前の状態に対して行い、同じタスクに複数行が当たったときは後の行が優先されます（連鎖しません）。JSON 配列（{`[{ "title": "…", "status": "done" }]`}、id / match / tag も可）も貼り付けられます。</div>
            </div>
          )}

          <textarea
            value={text}
            onChange={e => { setText(e.target.value); setNotice(null) }}
            placeholder={EXAMPLE}
            rows={8}
            spellCheck={false}
            className="w-full text-xs font-mono bg-slate-50 border border-slate-200 rounded-md px-3 py-2 outline-none focus:border-indigo-400 resize-y"
          />

          <div className="text-xs flex items-center gap-2 flex-wrap">
            {parsed.ok ? (
              <span className="text-slate-600">
                {parsed.rules.length} ルール
                <span className="text-slate-300 mx-1">・</span>
                <span className={`font-semibold ${result && result.changes.length > 0 ? 'text-emerald-600' : 'text-slate-500'}`}>{result?.changes.length ?? 0}件</span> 変更
                {emptyLines.length > 0 && (
                  <span className="ml-2 text-amber-600">該当なし: {emptyLines.map(r => `${r.line}行目`).join('、')}</span>
                )}
              </span>
            ) : text.trim() ? (
              <span className="text-rose-500">{parsed.error || '解釈できません'}</span>
            ) : (
              <span className="text-slate-400">スクリプトを入力または貼り付けてください</span>
            )}
            {notice && <span className="text-[11px] text-emerald-600">{notice}</span>}
          </div>

          {result && result.changes.length > 0 && (
            <div className="border border-slate-200 rounded-md divide-y divide-slate-100 max-h-[38vh] overflow-y-auto">
              {result.changes.map(c => (
                <div key={c.task.id} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                  <span className="text-slate-400 w-8 shrink-0 text-right">{c.line}行</span>
                  <span className="flex-1 min-w-0 truncate text-slate-800">{c.task.title}</span>
                  {allBoards && <span className="text-[10px] text-slate-400 truncate max-w-[120px]">{c.boardName}</span>}
                  <span className={`px-1.5 py-0.5 rounded ${STATUS_CLS[c.from]}`}>{STATUS_LABEL[c.from]}</span>
                  <ArrowRight size={11} className="text-slate-400" />
                  <span className={`px-1.5 py-0.5 rounded ${STATUS_CLS[c.to]}`}>{STATUS_LABEL[c.to]}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 px-5 py-3 border-t border-slate-100">
          <span className="text-[11px] text-slate-400">適用後は Ctrl+Z で一括して元に戻せます</span>
          <button onClick={onClose} className="ml-auto px-3 py-1.5 rounded-lg text-sm text-slate-600 hover:bg-slate-100 transition-colors">キャンセル</button>
          <button
            disabled={!result || result.changes.length === 0}
            onClick={apply}
            className="px-3 py-1.5 rounded-lg text-sm bg-indigo-500 text-white hover:bg-indigo-600 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            {result && result.changes.length > 0 ? `${result.changes.length}件を更新` : '更新'}
          </button>
        </div>
      </div>
    </div>
  )
}
