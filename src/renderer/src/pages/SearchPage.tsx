import { useEffect, useMemo, useRef, useState } from 'react'
import { FileText, FolderKanban, Globe, LayoutDashboard, Type, TrainFront } from 'lucide-react'
import { useApp } from '../store'
import { useNavigate } from 'react-router-dom'
import { SearchInput } from '../components/SearchInput'

type ResultType = 'note' | 'task' | 'research' | 'card' | 'label' | 'station'

interface SearchResult {
  id: string
  type: ResultType
  title: string
  preview: string
  tags: string[]
  meta?: string
}

const typeConfig = {
  note: { icon: FileText, color: 'text-amber-600', label: 'ノート' },
  task: { icon: FolderKanban, color: 'text-emerald-600', label: 'タスク' },
  research: { icon: Globe, color: 'text-sky-600', label: 'リサーチ' },
  card: { icon: LayoutDashboard, color: 'text-indigo-600', label: 'カード' },
  label: { icon: Type, color: 'text-violet-600', label: 'ラベル' },
  station: { icon: TrainFront, color: 'text-rose-600', label: '駅' },
} as const

// Highlight every substring match (case-insensitive) inside a snippet with <mark>.
function highlight(text: string, q: string) {
  if (!q) return text
  const lower = text.toLowerCase()
  const lq = q.toLowerCase()
  if (!lower.includes(lq)) return text
  const out: (string | JSX.Element)[] = []
  let i = 0
  while (i < text.length) {
    const idx = lower.indexOf(lq, i)
    if (idx === -1) { out.push(text.slice(i)); break }
    if (idx > i) out.push(text.slice(i, idx))
    out.push(<mark key={idx} className="bg-amber-200/70 text-slate-900 rounded-sm px-0.5">{text.slice(idx, idx + q.length)}</mark>)
    i = idx + q.length
  }
  return <>{out}</>
}

export default function SearchPage() {
  const { state } = useApp()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState<ResultType | 'all'>('all')
  const [activeIdx, setActiveIdx] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const results = useMemo(() => {
    if (!query.trim()) return []
    const q = query.toLowerCase()
    const items: SearchResult[] = []

    for (const note of state.notes) {
      if (note.title.toLowerCase().includes(q) || note.content.toLowerCase().includes(q) || note.tags.some(t => t.toLowerCase().includes(q))) {
        items.push({ id: note.id, type: 'note', title: note.title, preview: note.content.slice(0, 100), tags: note.tags })
      }
    }

    for (const project of state.projects) {
      for (const task of project.tasks) {
        if (task.title.toLowerCase().includes(q) || task.description.toLowerCase().includes(q) || task.tags.some(t => t.toLowerCase().includes(q))) {
          items.push({ id: task.id, type: 'task', title: task.title, preview: task.description || project.name, tags: task.tags, meta: project.name })
        }
      }
    }

    for (const item of state.research) {
      if (item.archivedAt) continue
      if (item.title.toLowerCase().includes(q) || item.description.toLowerCase().includes(q) || item.url.toLowerCase().includes(q)) {
        items.push({ id: item.id, type: 'research', title: item.title, preview: item.description || item.url, tags: item.tags })
      }
    }

    const tabName = (tabId: string) => state.canvasTabs.find(t => t.id === tabId)?.name ?? 'キャンバス'
    for (const card of state.canvasCards) {
      const pagesText = (card.pages || []).map(p => `${p.name} ${p.content}`).join(' ')
      if (`${card.title} ${card.content} ${pagesText}`.toLowerCase().includes(q)) {
        const preview = (card.content || (card.pages || []).map(p => p.content).join(' ') || card.title).slice(0, 100)
        items.push({ id: card.id, type: 'card', title: card.title || '(無題カード)', preview, tags: [], meta: tabName(card.tabId) })
      }
    }
    for (const label of state.canvasLabels) {
      if (label.text.toLowerCase().includes(q)) {
        items.push({ id: label.id, type: 'label', title: label.text || '(空のラベル)', preview: 'ラベル', tags: [], meta: tabName(label.tabId) })
      }
    }
    // キャンバスの線路: 駅名と路線名。路線ヒットはその路線の先頭駅へジャンプする。
    for (const station of state.canvasStations) {
      if (station.name.toLowerCase().includes(q)) {
        const rails = state.canvasRails.filter(r => r.stationIds.includes(station.id)).map(r => r.name)
        items.push({ id: station.id, type: 'station', title: station.name || '(無名の駅)', preview: rails.join('・') || '駅', tags: [], meta: tabName(station.tabId) })
      }
    }
    for (const rail of state.canvasRails) {
      if (rail.name.toLowerCase().includes(q)) {
        const first = rail.stationIds.map(id => state.canvasStations.find(s => s.id === id)).find(Boolean)
        if (first) items.push({ id: first.id, type: 'station', title: rail.name, preview: `路線（${rail.stationIds.length}駅)`, tags: [], meta: tabName(rail.tabId) })
      }
    }

    return items
  }, [query, state])

  const filtered = typeFilter === 'all' ? results : results.filter(r => r.type === typeFilter)

  // Reset active row when results change.
  useEffect(() => { setActiveIdx(0) }, [query, typeFilter])

  function open(r: SearchResult) {
    if (r.type === 'note') navigate('/', { state: { focusNoteId: r.id } })
    else if (r.type === 'task') navigate(`/projects?taskId=${r.id}`)
    else if (r.type === 'research') navigate('/research')
    else if (r.type === 'card') navigate('/canvas', { state: { focusCardId: r.id } })
    else if (r.type === 'station') navigate('/canvas', { state: { focusStationId: r.id } })
    else navigate('/canvas', { state: { focusLabelId: r.id } })
  }

  // Global keyboard nav: ↑↓ navigate, Enter opens. Esc handled inside SearchInput (clears).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!filtered.length) return
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIdx(i => Math.min(filtered.length - 1, i + 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIdx(i => Math.max(0, i - 1))
      } else if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        // Only when not editing an input — let SearchInput's own Enter handler commit history first.
        const ae = document.activeElement as HTMLElement | null
        if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return
        e.preventDefault()
        if (filtered[activeIdx]) open(filtered[activeIdx])
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [filtered, activeIdx])

  // Scroll active row into view.
  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(`[data-result-idx="${activeIdx}"]`)
    node?.scrollIntoView({ block: 'nearest' })
  }, [activeIdx])

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 pt-8 pb-4">
        <div className="max-w-2xl mx-auto">
          <SearchInput
            value={query}
            onChange={setQuery}
            historyKey="constella.global.search"
            placeholder="ノート / タスク / リサーチ / カード を検索…"
            size="md"
            autoFocus
          />

          {query && (
            <div className="flex gap-2 mt-3 flex-wrap">
              <button
                onClick={() => setTypeFilter('all')}
                className={`text-xs px-3 py-1 rounded-full transition-colors
                  ${typeFilter === 'all' ? 'bg-violet-500/20 text-violet-600' : 'bg-slate-100 text-slate-500 hover:text-slate-700'}`}
              >
                すべて ({results.length})
              </button>
              {(['note', 'task', 'research', 'card', 'label'] as const).map(type => {
                const count = results.filter(r => r.type === type).length
                if (count === 0) return null
                return (
                  <button
                    key={type}
                    onClick={() => setTypeFilter(type)}
                    className={`text-xs px-3 py-1 rounded-full transition-colors
                      ${typeFilter === type ? 'bg-violet-500/20 text-violet-600' : 'bg-slate-100 text-slate-500 hover:text-slate-700'}`}
                  >
                    {typeConfig[type].label} ({count})
                  </button>
                )
              })}
              {filtered.length > 0 && (
                <span className="ml-auto text-[10px] text-slate-400 self-center">↑↓で選択・Enterで開く・Escでクリア</span>
              )}
            </div>
          )}
        </div>
      </div>

      <div ref={listRef} className="flex-1 overflow-y-auto px-6 pb-6">
        <div className="max-w-2xl mx-auto space-y-2">
          {filtered.map((result, idx) => {
            const config = typeConfig[result.type]
            const Icon = config.icon
            const active = idx === activeIdx
            return (
              <button
                key={`${result.type}-${result.id}`}
                data-result-idx={idx}
                onMouseEnter={() => setActiveIdx(idx)}
                onClick={() => open(result)}
                className={`w-full text-left p-4 rounded-xl border transition-colors ${
                  active
                    ? 'bg-violet-50 border-violet-300'
                    : 'bg-slate-50 border-slate-200 hover:border-slate-300'
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <Icon size={14} className={config.color} />
                  <span className="text-[10px] text-slate-500 uppercase tracking-wider">{config.label}</span>
                  {result.meta && <span className="text-[10px] text-slate-400">&middot; {result.meta}</span>}
                </div>
                <p className="text-sm font-medium text-slate-800">{highlight(result.title || '(無題)', query)}</p>
                <p className="text-xs text-slate-500 mt-1 truncate">{highlight(result.preview, query)}</p>
              </button>
            )
          })}
          {query && filtered.length === 0 && (
            <div className="text-center py-12 text-slate-400 text-sm">
              「{query}」に一致する結果はありません
            </div>
          )}
          {!query && (
            <div className="text-center py-12 text-slate-400 text-sm">
              キーワードを入力して検索（履歴は localStorage）
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
