import { useState, useEffect, useRef, useMemo } from 'react'
import { Sparkles, X, Send, Settings as SettingsIcon, Loader2, Trash2, StopCircle, FileText, Copy, CheckSquare, Check, History, Plus } from 'lucide-react'
import { useApp } from '../store'
import { Note, Task, Project, AIConversation, AIMessage } from '../types'
import { generateId } from '../utils'
import { MarkdownText } from './MarkdownText'
import { confirmDialog } from './ConfirmDialog'
import { usePopoverDismiss } from './usePopoverDismiss'

type AIApi = {
  getSettings: () => Promise<{ hasKey: boolean; model: string }>
  setSettings: (s: { apiKey?: string; model?: string }) => Promise<{ hasKey: boolean; model: string }>
  chat: (
    streamId: string,
    opts: { system: string; messages: { role: 'user' | 'assistant'; content: string }[]; model?: string; maxTokens?: number },
    onChunk: (t: string) => void,
    onDone: (info: { stopReason: string | null; usage: unknown }) => void,
    onError: (m: string) => void,
  ) => () => void
  cancel: (id: string) => void
}

interface Msg { role: 'user' | 'assistant'; content: string }

const MODELS = [
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6 (推奨・$3/$15 per 1M tok)' },
  { id: 'claude-haiku-4-5',  label: 'Haiku 4.5 (高速・$1/$5 per 1M tok)' },
  { id: 'claude-opus-4-8',   label: 'Opus 4.8 (最高品質・$5/$25 per 1M tok)' },
]

// Build a project-scoped system context: a compact summary of the active master
// project's notes/tasks/research/canvas titles so Claude can answer about
// "this project" without us shipping the entire DB on every request.
function buildSystemPrompt(state: ReturnType<typeof useApp>['state']): string {
  const active = state.activeMasterProjectId
  const proj = state.masterProjects.find(p => p.id === active)
  const notes = state.notes.filter(n => n.masterProjectId === active)
  const boards = state.projects.filter(p => p.masterProjectId === active)
  const research = state.research.filter(r => r.masterProjectId === active)
  const tabs = state.canvasTabs.filter(t => t.projectId === active)
  const tabIds = new Set(tabs.map(t => t.id))
  const cards = state.canvasCards.filter(c => tabIds.has(c.tabId))

  const lines: string[] = []
  lines.push('あなたはConstellaという情報整理アプリのAIアシスタントです。')
  lines.push('ユーザーは個人の企画/プリプロ作業をしており、現在のプロジェクト配下の情報について質問してきます。')
  lines.push('回答は日本語で、簡潔かつマークダウンで構造化して返してください。')
  lines.push('')
  lines.push(`## 現在のプロジェクト: ${proj?.name ?? '(未選択)'}`)
  if (notes.length) {
    lines.push(`### ノート (${notes.length}件)`)
    notes.slice(0, 30).forEach(n => lines.push(`- ${n.title || '(無題)'}: ${(n.content || '').slice(0, 200).replace(/\n/g, ' ')}`))
  }
  if (boards.length) {
    lines.push(`### タスク (${boards.length}ボード)`)
    boards.slice(0, 10).forEach(b => {
      lines.push(`#### ${b.name}`)
      b.tasks.slice(0, 30).forEach(t => {
        const d = t.startDate || t.endDate ? ` [${t.startDate ?? '…'}〜${t.endDate ?? '…'}]` : ''
        lines.push(`- [${t.status}] ${t.title}${d}${t.description ? ' — ' + t.description.slice(0, 120).replace(/\n/g, ' ') : ''}`)
      })
    })
  }
  if (research.length) {
    lines.push(`### リサーチ (${research.length}件)`)
    research.slice(0, 20).forEach(r => lines.push(`- ${r.title}: ${r.url}${r.category ? ' (' + r.category + ')' : ''}`))
  }
  if (cards.length) {
    lines.push(`### キャンバスカード (${cards.length}枚)`)
    cards.slice(0, 30).forEach(c => lines.push(`- [${c.type}] ${c.title || '(無題)'}${c.content ? ': ' + c.content.slice(0, 120).replace(/\n/g, ' ') : ''}`))
  }
  return lines.join('\n')
}

export default function AIChatPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state, dispatch } = useApp()
  const ai = (window as unknown as { api?: { ai?: AIApi } }).api?.ai
  // Lightweight in-panel toast for action feedback ("コピーしました" etc.).
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flashToast = (m: string) => {
    setToast(m)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 2200)
  }
  const [hasKey, setHasKey] = useState(false)
  const [model, setModel] = useState('claude-sonnet-4-6')
  const [showSettings, setShowSettings] = useState(false)
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [includeContext, setIncludeContext] = useState(true)
  // Persisted conversation: when not null, edits/streams sync to this conversation in
  // the store. When null, the next send creates a new one (lazy creation — no empty
  // conversations get persisted just from opening the panel).
  const [activeConvId, setActiveConvId] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const streamIdRef = useRef<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  // Outside-click / Esc close for the two inline dropdowns. Their trigger buttons
  // live in the header (outside the panel element), so pass the trigger as extraRef
  // to keep the opening click from immediately re-closing the panel.
  const historyBtnRef = useRef<HTMLButtonElement>(null)
  const settingsBtnRef = useRef<HTMLButtonElement>(null)
  const historyRef = usePopoverDismiss<HTMLDivElement>(historyOpen, () => setHistoryOpen(false), historyBtnRef)
  const settingsRef = usePopoverDismiss<HTMLDivElement>(showSettings, () => setShowSettings(false), settingsBtnRef)

  // Conversations belong to the active master project — switching projects starts fresh.
  const conversations = useMemo(
    () => state.aiConversations.filter(c => c.masterProjectId === state.activeMasterProjectId).slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [state.aiConversations, state.activeMasterProjectId],
  )
  // Reset the panel when the user switches master project so we don't carry one
  // project's conversation into another.
  useEffect(() => {
    setActiveConvId(null)
    setMessages([])
    setHistoryOpen(false)
  }, [state.activeMasterProjectId])

  useEffect(() => { if (!ai) return; ai.getSettings().then(s => { setHasKey(s.hasKey); setModel(s.model) }).catch(() => {}) }, [ai])
  useEffect(() => { if (open && !hasKey) setShowSettings(true) }, [open, hasKey])
  // Autoscroll on new content.
  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }) }, [messages])

  const system = useMemo(() => includeContext ? buildSystemPrompt(state) : 'あなたはConstellaのAIアシスタントです。日本語でマークダウンで簡潔に答えてください。', [state, includeContext])

  function saveKey() {
    if (!ai) return
    const k = apiKeyInput.trim()
    ai.setSettings({ apiKey: k || undefined, model }).then(s => { setHasKey(s.hasKey); setApiKeyInput(''); if (s.hasKey) setShowSettings(false) }).catch(() => {})
  }
  function changeModel(m: string) {
    setModel(m)
    if (ai) ai.setSettings({ model: m }).catch(() => {})
  }
  // Discard the current view (does NOT delete the conversation — it stays in history).
  function newConversation() {
    setActiveConvId(null)
    setMessages([])
    setHistoryOpen(false)
  }
  function loadConversation(c: AIConversation) {
    setActiveConvId(c.id)
    setMessages(c.messages.map(m => ({ role: m.role, content: m.content })))
    setHistoryOpen(false)
  }
  async function deleteConversation(id: string) {
    if (!(await confirmDialog('この会話を削除しますか？'))) return
    dispatch({ type: 'DELETE_AI_CONVERSATION', payload: id })
    if (activeConvId === id) { setActiveConvId(null); setMessages([]) }
    flashToast('会話を削除しました')
  }
  // Convert an entire stored conversation to a single Markdown note (each turn becomes
  // a section). Available from the history dropdown; works on any past conversation.
  function saveConvAsNote(c: AIConversation) {
    const body = c.messages.map(m => `### ${m.role === 'user' ? 'あなた' : 'Claude'}\n\n${m.content}`).join('\n\n---\n\n')
    const now = new Date().toISOString()
    dispatch({ type: 'ADD_NOTE', payload: {
      id: generateId(),
      masterProjectId: state.activeMasterProjectId,
      title: `[AI会話] ${c.title}`.slice(0, 80),
      content: body,
      tags: ['AI'],
      createdAt: now, updatedAt: now,
    } as Note })
    flashToast('会話全体をノートに保存しました')
  }
  // Title is auto-derived from the first user turn (stripped of newlines, capped).
  function deriveTitle(firstUserText: string): string {
    return firstUserText.replace(/\s+/g, ' ').trim().slice(0, 40) || '新しい会話'
  }

  function send() {
    const txt = input.trim()
    if (!txt || !ai || streaming) return
    const now = new Date().toISOString()
    const userMsg: AIMessage = { role: 'user', content: txt, createdAt: now }
    // Local UI: append user + an empty assistant placeholder (used as the streaming target).
    const baseLocal: Msg[] = [...messages, { role: 'user', content: txt }, { role: 'assistant', content: '' }]
    setMessages(baseLocal)
    setInput('')
    setStreaming(true)

    // Persist the user turn immediately so it survives a stream crash. baseStored is
    // the snapshot we'll extend with the assistant reply on done/error.
    const priorStored: AIMessage[] = activeConvId
      ? (state.aiConversations.find(c => c.id === activeConvId)?.messages ?? messages.map(m => ({ role: m.role, content: m.content, createdAt: now })))
      : messages.map(m => ({ role: m.role, content: m.content, createdAt: now }))
    const baseStored: AIMessage[] = [...priorStored, userMsg]
    let convId = activeConvId
    if (!convId) {
      convId = generateId()
      setActiveConvId(convId)
      const conv: AIConversation = {
        id: convId, masterProjectId: state.activeMasterProjectId,
        title: deriveTitle(txt), messages: baseStored,
        createdAt: now, updatedAt: now,
      }
      dispatch({ type: 'ADD_AI_CONVERSATION', payload: conv })
    } else {
      const existing = state.aiConversations.find(c => c.id === convId)
      if (existing) {
        dispatch({ type: 'UPDATE_AI_CONVERSATION', payload: { ...existing, messages: baseStored, updatedAt: now } })
      }
    }

    const streamId = Math.random().toString(36).slice(2)
    streamIdRef.current = streamId
    let acc = ''
    // On done/error, append the assistant turn and dispatch a full UPDATE for this
    // conversation. We use closure-captured baseStored/convId/now rather than reading
    // latest state — safe because UPDATE is idempotent and DELETE during a stream is a
    // tolerated edge case (the update just no-ops in the reducer).
    const finalize = (finalText: string) => {
      const t = new Date().toISOString()
      const finalStored: AIMessage[] = [...baseStored, { role: 'assistant', content: finalText, createdAt: t }]
      dispatch({ type: 'UPDATE_AI_CONVERSATION', payload: {
        id: convId!, masterProjectId: state.activeMasterProjectId,
        title: deriveTitle(txt),
        messages: finalStored,
        createdAt: now, updatedAt: t,
      } })
    }
    ai.chat(streamId, {
      system,
      messages: baseLocal.slice(0, -1).map(m => ({ role: m.role, content: m.content })),
      model,
      maxTokens: 4096,
    },
      (delta) => {
        acc += delta
        setMessages(prev => { const copy = prev.slice(); copy[copy.length - 1] = { role: 'assistant', content: acc }; return copy })
      },
      () => { setStreaming(false); streamIdRef.current = null; finalize(acc) },
      (err) => {
        setStreaming(false); streamIdRef.current = null
        const errText = `**エラー**: ${err}`
        setMessages(prev => { const copy = prev.slice(); copy[copy.length - 1] = { role: 'assistant', content: errText }; return copy })
        finalize(errText)
      },
    )
  }
  function stop() {
    if (!ai || !streamIdRef.current) return
    ai.cancel(streamIdRef.current)
    setStreaming(false)
    streamIdRef.current = null
  }

  // ── Reuse actions on assistant messages ──
  function copyMessage(text: string) {
    navigator.clipboard.writeText(text).then(
      () => flashToast('コピーしました'),
      () => flashToast('コピーに失敗しました'),
    )
  }

  // Save a Claude response as a fresh note under the active master project. Title
  // is the first non-empty line stripped of Markdown punctuation; body is verbatim.
  function saveAsNote(text: string) {
    const lines = text.split('\n')
    const firstLine = lines.find(l => l.trim()) ?? 'AIからのメモ'
    const title = firstLine
      .replace(/^#+\s*/, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .trim()
      .slice(0, 80) || 'AIからのメモ'
    const now = new Date().toISOString()
    const note: Note = {
      id: generateId(),
      masterProjectId: state.activeMasterProjectId,
      title,
      content: text,
      tags: ['AI'],
      createdAt: now,
      updatedAt: now,
    }
    dispatch({ type: 'ADD_NOTE', payload: note })
    flashToast(`ノートに保存しました: ${title}`)
  }

  // Pull every top-level bullet / numbered / checkbox item out of the response and
  // turn each into a Todo task. Lines that look like headings or empty bullets are
  // dropped. Lands them on the first board of the active project (creates one if
  // none exists yet).
  function extractTasks(text: string) {
    const titles: string[] = []
    for (const raw of text.split('\n')) {
      const line = raw.trim()
      // Match - foo, * foo, 1. foo, with optional [ ] / [x] checkbox.
      const m = /^(?:[-*]|\d+\.)\s+(?:\[[ xX]\]\s*)?(.+)$/.exec(line)
      if (!m) continue
      const t = m[1]
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .trim()
      if (t.length >= 2 && !t.startsWith('#')) titles.push(t)
    }
    if (titles.length === 0) { flashToast('箇条書きが見つかりませんでした'); return }
    const now = new Date().toISOString()
    const active = state.activeMasterProjectId
    let board: Project | undefined = state.projects.find(p => p.masterProjectId === active)
    if (!board) {
      board = { id: generateId(), masterProjectId: active, name: 'AIから抽出したタスク', description: '', tasks: [], createdAt: now }
      dispatch({ type: 'ADD_PROJECT', payload: board })
    }
    for (const title of titles) {
      const task: Task = { id: generateId(), title, description: '', status: 'todo', tags: ['AI'], createdAt: now }
      dispatch({ type: 'ADD_TASK', payload: { projectId: board.id, task } })
    }
    flashToast(`${titles.length} 件のタスクを「${board.name}」に追加しました`)
  }

  // Hide entirely in non-Electron / browser preview where `window.api.ai` isn't exposed.
  if (!ai) return null

  return (
    <>
      {/* Backdrop (click to close) */}
      {open && <div className="fixed inset-0 z-40 bg-slate-900/10" onClick={onClose} />}
      <aside
        className={`fixed top-0 right-0 h-full w-[420px] max-w-[92vw] z-50 bg-white border-l border-slate-200 shadow-2xl flex flex-col transition-transform duration-200 ${open ? 'translate-x-0' : 'translate-x-full'}`}
        aria-hidden={!open}
      >
        <div className="h-12 px-3 flex items-center gap-1.5 border-b border-slate-200 shrink-0 relative">
          <Sparkles size={16} className="text-indigo-500" />
          <span className="text-sm font-semibold text-slate-800">AI</span>
          <span className="text-[10px] text-slate-400 truncate hidden xl:inline">{model.replace('claude-', '')}</span>
          <button ref={historyBtnRef} onClick={() => setHistoryOpen(v => !v)} title="会話履歴" className={`ml-auto p-1.5 rounded flex items-center gap-1 ${historyOpen ? 'bg-indigo-50 text-indigo-600' : 'text-slate-500 hover:bg-slate-100'}`}>
            <History size={14} />
            {conversations.length > 0 && <span className="text-[10px] font-medium">{conversations.length}</span>}
          </button>
          <button onClick={newConversation} title="新しい会話" className="p-1.5 rounded text-slate-500 hover:bg-slate-100"><Plus size={14} /></button>
          <button onClick={() => setIncludeContext(v => !v)} title={includeContext ? 'プロジェクト全体を文脈に含める（ON）' : 'コンテキスト無し（OFF）'} className={`p-1.5 rounded ${includeContext ? 'text-indigo-600 bg-indigo-50' : 'text-slate-400 hover:bg-slate-100'}`}>
            <FileText size={14} />
          </button>
          <button ref={settingsBtnRef} onClick={() => setShowSettings(s => !s)} title="設定" className="p-1.5 rounded text-slate-500 hover:bg-slate-100"><SettingsIcon size={14} /></button>
          <button onClick={onClose} title="閉じる" className="p-1.5 rounded text-slate-500 hover:bg-slate-100"><X size={14} /></button>
        </div>

        {/* History dropdown — list of saved conversations under the active master project */}
        {historyOpen && (
          <div ref={historyRef} className="border-b border-slate-200 bg-slate-50 max-h-64 overflow-y-auto shrink-0">
            {conversations.length === 0 ? (
              <p className="text-xs text-slate-400 text-center py-4">まだ会話履歴はありません</p>
            ) : conversations.map(c => (
              <div key={c.id} className={`group flex items-center gap-1 px-3 py-2 text-sm cursor-pointer border-b border-slate-100 transition-colors ${activeConvId === c.id ? 'bg-indigo-50 text-indigo-700' : 'text-slate-700 hover:bg-white'}`}
                   onClick={() => loadConversation(c)}>
                <div className="flex-1 min-w-0">
                  <div className="truncate text-xs font-medium">{c.title || '(無題)'}</div>
                  <div className="text-[10px] text-slate-400">{c.messages.length} 件 · {c.updatedAt.slice(0, 10)}</div>
                </div>
                <button onClick={e => { e.stopPropagation(); saveConvAsNote(c) }} title="この会話をノートに保存"
                  className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-amber-100 text-slate-400 hover:text-amber-600 transition-all">
                  <FileText size={12} />
                </button>
                <button onClick={e => { e.stopPropagation(); deleteConversation(c.id) }} title="削除"
                  className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-red-100 text-slate-400 hover:text-red-600 transition-all">
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        )}

        {showSettings && (
          <div ref={settingsRef} className="px-3 py-3 border-b border-slate-200 bg-slate-50 space-y-2 text-sm">
            <div className="text-xs font-semibold text-slate-600">Claude API キー</div>
            <input
              type="password"
              autoFocus
              placeholder={hasKey ? '（保存済み・更新する場合のみ入力）' : 'sk-ant-...'}
              value={apiKeyInput}
              onChange={e => setApiKeyInput(e.target.value)}
              className="w-full text-xs font-mono bg-white border border-slate-300 rounded px-2 py-1.5 outline-none focus:border-indigo-400"
            />
            <p className="text-[10px] text-slate-400 leading-relaxed">
              <a href="https://console.anthropic.com/" target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline">console.anthropic.com</a> で発行。アプリ内 (このPC) に保存され、サーバ送信もLAN公開もされません。
            </p>
            <div className="text-xs font-semibold text-slate-600 mt-2">モデル</div>
            <select value={model} onChange={e => changeModel(e.target.value)} className="w-full text-xs bg-white border border-slate-200 rounded px-2 py-1.5 outline-none focus:border-indigo-400">
              {MODELS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
            <div className="flex gap-1.5 mt-2">
              <button onClick={saveKey} className="px-3 py-1.5 rounded bg-indigo-500 text-white text-xs hover:bg-indigo-600">保存</button>
              <button onClick={() => setShowSettings(false)} className="px-3 py-1.5 rounded text-xs text-slate-600 hover:bg-slate-200">閉じる</button>
            </div>
          </div>
        )}

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
          {messages.length === 0 && !showSettings && (
            <div className="text-xs text-slate-400 text-center py-8 space-y-2">
              <p>プロジェクト「{state.masterProjects.find(p => p.id === state.activeMasterProjectId)?.name ?? ''}」について何でも聞いてください。</p>
              <div className="text-left max-w-[260px] mx-auto space-y-1 text-[11px]">
                <p>💡 試してみる：</p>
                <p className="text-slate-500">「このプロジェクトを要約して」</p>
                <p className="text-slate-500">「今週やるべきタスクを5つ挙げて」</p>
                <p className="text-slate-500">「企画書のドラフトを書いて」</p>
              </div>
            </div>
          )}
          {messages.map((m, i) => {
            const isAssistant = m.role === 'assistant'
            // Show actions on every committed assistant message (skip empty placeholder
            // and skip while streaming the last one — text is still arriving).
            const showActions = isAssistant && !!m.content && !(streaming && i === messages.length - 1)
            return (
              <div key={i} className={`text-sm ${m.role === 'user' ? 'pl-6' : ''}`}>
                <div className={`text-[10px] font-semibold uppercase tracking-wide mb-1 ${m.role === 'user' ? 'text-slate-500 text-right' : 'text-indigo-500'}`}>
                  {m.role === 'user' ? 'あなた' : 'Claude'}
                </div>
                <div className={`group rounded-lg px-3 py-2 ${m.role === 'user' ? 'bg-indigo-50 text-slate-800' : 'bg-slate-50 text-slate-800'}`}>
                  {m.content ? <MarkdownText value={m.content} readOnly textSize="text-sm" /> : <Loader2 size={14} className="animate-spin text-indigo-400" />}
                  {showActions && (
                    <div className="mt-2 pt-2 border-t border-slate-200/70 flex items-center gap-1 opacity-60 group-hover:opacity-100 transition-opacity">
                      <button onClick={() => copyMessage(m.content)} title="クリップボードにコピー" className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-slate-600 hover:bg-slate-200 hover:text-slate-900 transition-colors">
                        <Copy size={12} /> コピー
                      </button>
                      <button onClick={() => saveAsNote(m.content)} title="新しいノートとして保存" className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-slate-600 hover:bg-amber-100 hover:text-amber-700 transition-colors">
                        <FileText size={12} /> ノートに保存
                      </button>
                      <button onClick={() => extractTasks(m.content)} title="箇条書きからタスクを抽出して追加" className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-slate-600 hover:bg-emerald-100 hover:text-emerald-700 transition-colors">
                        <CheckSquare size={12} /> タスクに追加
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        {/* Toast (action feedback) */}
        {toast && (
          <div className="px-3 py-2 border-t border-slate-200 bg-emerald-50 text-emerald-700 text-xs flex items-center gap-2 shrink-0">
            <Check size={14} /> {toast}
          </div>
        )}

        {/* Input */}
        <div className="border-t border-slate-200 p-2 shrink-0">
          <div className="flex items-end gap-1.5">
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send() } }}
              rows={2}
              placeholder={hasKey ? 'メッセージ… (Ctrl+Enter で送信)' : '右上の歯車からAPIキーを設定してください'}
              disabled={!hasKey}
              className="flex-1 text-sm bg-slate-50 border border-slate-200 rounded-md px-2.5 py-1.5 outline-none focus:border-indigo-400 resize-none disabled:opacity-60"
            />
            {streaming
              ? <button onClick={stop} title="停止" className="p-2 rounded bg-red-500 text-white hover:bg-red-600 shrink-0"><StopCircle size={16} /></button>
              : <button onClick={send} disabled={!input.trim() || !hasKey} title="送信 (Ctrl+Enter)" className="p-2 rounded bg-indigo-500 text-white hover:bg-indigo-600 disabled:opacity-30 shrink-0"><Send size={16} /></button>
            }
          </div>
        </div>
      </aside>
    </>
  )
}
