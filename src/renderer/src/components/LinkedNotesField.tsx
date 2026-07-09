import { useMemo, useState } from 'react'
import { Plus, FileText, Share2 } from 'lucide-react'
import { Note, Task } from '../types'
import { useApp } from '../store'
import { generateId } from '../utils'

// Edit-mode field for managing a task's linked Notes. Used inside both the Kanban
// TaskCard editor and the Gantt editor popover so the UX is identical in both places.
// Chip row of currently-linked notes + a `+` disclosure that opens a search picker.
export default function LinkedNotesField({ task, onChange }: {
  task: Task
  onChange: (linkedNoteIds: string[]) => void
}) {
  const { state, dispatch } = useApp()
  const active = state.activeMasterProjectId
  // Own notes + shared notes from OTHER master projects (referenceable cross-project).
  const notesInScope = useMemo(() => {
    const own = state.notes.filter(n => n.masterProjectId === active && !n.archivedAt)
    const sharedExternal = state.notes.filter(n => n.masterProjectId !== active && n.shared && !n.archivedAt)
    return [...own, ...sharedExternal].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
  }, [state.notes, active])
  const isExternal = (n: Note) => n.masterProjectId !== active
  const linkedIds = task.linkedNoteIds ?? []
  const linkedNotes = useMemo(() => {
    // Resolve against ALL notes so cross-project shared notes render too.
    const m = new Map(state.notes.map(n => [n.id, n]))
    return linkedIds.map(id => m.get(id)).filter((n): n is Note => !!n)
  }, [linkedIds, state.notes])
  const [query, setQuery] = useState('')
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return notesInScope
    return notesInScope.filter(n => (n.title || '').toLowerCase().includes(q) || (n.content || '').toLowerCase().includes(q))
  }, [notesInScope, query])

  function toggle(id: string) {
    const has = linkedIds.includes(id)
    onChange(has ? linkedIds.filter(x => x !== id) : [...linkedIds, id])
  }
  function createAndLink() {
    if (!active) return
    const now = new Date().toISOString()
    const note: Note = {
      id: generateId(),
      masterProjectId: active,
      title: task.title || '新しいノート',
      content: '',
      tags: [],
      createdAt: now,
      updatedAt: now,
    }
    dispatch({ type: 'ADD_NOTE', payload: note })
    onChange([...linkedIds, note.id])
  }

  return (
    <div className="flex items-start gap-1.5 text-[11px] text-slate-500">
      <span className="shrink-0 mt-0.5">関連ノート</span>
      <div className="flex-1 flex flex-wrap gap-1 min-w-0">
        {linkedNotes.map(n => (
          <span key={n.id} className="inline-flex items-center gap-0.5 max-w-[140px] bg-indigo-50 border border-indigo-200 text-indigo-700 rounded px-1.5 py-0.5 text-[10px]">
            {isExternal(n) ? <Share2 size={9} className="shrink-0" /> : <FileText size={9} className="shrink-0" />}
            <span className="truncate" title={isExternal(n) ? `${n.title || '(無題)'}（共有ノート）` : (n.title || '(無題)')}>{n.title || '(無題)'}</span>
            <button onClick={() => toggle(n.id)} className="text-indigo-400 hover:text-rose-500 -mr-0.5" title="リンクを外す">×</button>
          </span>
        ))}
        {linkedNotes.length === 0 && <span className="text-[10px] text-slate-400 italic self-center">(未リンク)</span>}
      </div>
      <details className="relative shrink-0">
        <summary className="list-none cursor-pointer w-5 h-5 rounded hover:bg-slate-100 flex items-center justify-center text-slate-400 hover:text-slate-700" title="ノートをリンク">
          <Plus size={12} />
        </summary>
        <div className="absolute right-0 top-6 z-30 w-[260px] bg-white border border-slate-200 rounded-lg shadow-xl p-2"
             onClick={e => e.stopPropagation()}>
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="ノートを検索…"
            className="w-full text-xs bg-slate-50 border border-slate-200 rounded px-2 py-1 outline-none focus:border-emerald-400 mb-1"
          />
          <div className="max-h-[200px] overflow-y-auto">
            {filtered.length === 0 && <div className="text-[10px] text-slate-400 px-1 py-2">該当なし</div>}
            {filtered.map(n => {
              const checked = linkedIds.includes(n.id)
              return (
                <label key={n.id} className={`flex items-center gap-2 px-1.5 py-1 hover:bg-slate-50 rounded cursor-pointer text-xs ${checked ? 'text-indigo-700' : 'text-slate-600'}`}>
                  <input type="checkbox" checked={checked} onChange={() => toggle(n.id)} className="shrink-0" />
                  <span className="truncate flex-1">{n.title || '(無題)'}</span>
                  {isExternal(n) && <span className="shrink-0 inline-flex items-center gap-0.5 text-[9px] text-indigo-500" title="他プロジェクトの共有ノート"><Share2 size={9} /> 共有</span>}
                </label>
              )
            })}
          </div>
          <button
            onClick={createAndLink}
            className="w-full mt-1 text-[10px] px-2 py-1 rounded border border-dashed border-slate-300 text-slate-500 hover:border-emerald-400 hover:text-emerald-600 flex items-center justify-center gap-1"
          >
            <Plus size={10} /> 新規ノートを作成してリンク
          </button>
        </div>
      </details>
    </div>
  )
}
