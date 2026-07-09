import { useEffect, useMemo, useRef, useState } from 'react'
import { X, Pencil, Eye } from 'lucide-react'
import { Note, Task, Project } from '../types'
import { useApp } from '../store'
import { MarkdownText } from './MarkdownText'

// Right-side panel that shows the linked notes of the currently-selected task.
// Mounted in ProjectsPage layout as a sibling of the main view; collapses to width
// 0 when there's nothing to show (no selected task or task has no linked notes).
const PANEL_MIN = 280
const PANEL_MAX = 560
const PANEL_DEFAULT = 360

export default function NotePanel({ selectedTask, selectedBoard, onClose }: {
  selectedTask: Task | null
  selectedBoard: Project | null
  onClose: () => void
}) {
  const { state, dispatch } = useApp()
  const linkedIds = selectedTask?.linkedNoteIds ?? []
  const notes = useMemo(() => {
    const map = new Map(state.notes.map(n => [n.id, n]))
    return linkedIds.map(id => map.get(id)).filter((n): n is Note => !!n)
  }, [state.notes, linkedIds])
  const open = !!selectedTask && notes.length > 0

  // Resizable width (drag the LEFT edge to widen/shrink). Persisted.
  const [width, setWidth] = useState(() => {
    try { const v = Number(localStorage.getItem('constella.notePanel.width') || String(PANEL_DEFAULT)); return v >= PANEL_MIN && v <= PANEL_MAX ? v : PANEL_DEFAULT } catch { return PANEL_DEFAULT }
  })
  const [resizing, setResizing] = useState(false)
  useEffect(() => {
    try { localStorage.setItem('constella.notePanel.width', String(width)) } catch { /* ignore */ }
  }, [width])
  function startResize(e: React.MouseEvent) {
    e.preventDefault()
    const startX = e.clientX
    const base = width
    setResizing(true)
    const onMove = (ev: MouseEvent) => {
      // Dragging LEFT widens (we're attached to the right edge of the layout).
      const next = Math.max(PANEL_MIN, Math.min(PANEL_MAX, base - (ev.clientX - startX)))
      setWidth(next)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      setResizing(false)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // Active tab — reset when the selected task changes.
  const [activeIdx, setActiveIdx] = useState(0)
  useEffect(() => { setActiveIdx(0) }, [selectedTask?.id])
  const activeNote = notes[activeIdx] ?? notes[0]

  // Edit-mode toggle (otherwise notes are rendered in markdown view mode).
  const [editMode, setEditMode] = useState(false)
  useEffect(() => { setEditMode(false) }, [selectedTask?.id, activeIdx])

  // ESC closes the panel when focus is inside it.
  const panelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (panelRef.current && panelRef.current.contains(document.activeElement)) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  function updateNote(patch: Partial<Note>) {
    if (!activeNote) return
    dispatch({ type: 'UPDATE_NOTE', payload: { ...activeNote, ...patch, updatedAt: new Date().toISOString() } })
  }
  function unlink(noteId: string) {
    if (!selectedTask || !selectedBoard) return
    const next = (selectedTask.linkedNoteIds ?? []).filter(id => id !== noteId)
    dispatch({ type: 'UPDATE_TASK', payload: { projectId: selectedBoard.id, task: { ...selectedTask, linkedNoteIds: next.length > 0 ? next : undefined } } })
  }

  return (
    <div className={`relative h-full shrink-0 ${resizing ? '' : 'transition-[width] duration-200'}`} style={{ width: open ? width : 0 }}>
      <div
        ref={panelRef}
        className={`absolute inset-y-0 right-0 bg-white border-l border-slate-200 flex flex-col ${resizing ? '' : 'transition-[width] duration-200'} ${open ? '' : 'pointer-events-none opacity-0'}`}
        style={{ width: open ? width : 0 }}
      >
        {/* Header */}
        <div className="h-14 px-3 flex items-center gap-2 border-b border-slate-200 shrink-0">
          <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide truncate flex-1">関連ノート</span>
          {activeNote && (
            <button
              onClick={() => setEditMode(e => !e)}
              title={editMode ? 'プレビュー' : '編集'}
              className={`p-1 rounded hover:bg-slate-100 ${editMode ? 'text-emerald-600' : 'text-slate-400 hover:text-slate-700'}`}
            >
              {editMode ? <Eye size={14} /> : <Pencil size={14} />}
            </button>
          )}
          <button onClick={onClose} title="閉じる" className="p-1 rounded hover:bg-slate-100 text-slate-400 hover:text-slate-700">
            <X size={14} />
          </button>
        </div>
        {/* Tabs (only when >1 note) */}
        {notes.length > 1 && (
          <div className="flex overflow-x-auto border-b border-slate-200 shrink-0 bg-slate-50">
            {notes.map((n, i) => (
              <button
                key={n.id}
                onClick={() => setActiveIdx(i)}
                className={`px-3 py-2 text-xs whitespace-nowrap border-b-2 transition-colors ${i === activeIdx ? 'border-emerald-500 text-slate-800 bg-white' : 'border-transparent text-slate-500 hover:text-slate-700'}`}
                title={n.title || '(無題)'}
              >
                <span className="inline-block max-w-[14ch] truncate align-middle">{n.title || '(無題)'}</span>
              </button>
            ))}
          </div>
        )}
        {/* Active note body */}
        {activeNote && (
          <div className="flex-1 flex flex-col min-h-0">
            <input
              value={activeNote.title}
              onChange={e => updateNote({ title: e.target.value })}
              placeholder="ノートタイトル"
              className="px-4 pt-3 pb-1 text-base font-semibold text-slate-800 outline-none border-b border-slate-100 bg-transparent"
            />
            <MarkdownText
              key={activeNote.id + (editMode ? ':e' : ':v')}
              value={activeNote.content}
              onChange={v => updateNote({ content: v })}
              editing={editMode}
              extraClass="flex-1 min-h-0 px-4 py-2"
              placeholder="ここにメモを書く…（マークダウン対応）"
            />
            <div className="px-3 py-2 border-t border-slate-100 flex items-center justify-between text-[10px] text-slate-400">
              <span className="truncate">更新: {activeNote.updatedAt?.slice(0, 16).replace('T', ' ')}</span>
              <button onClick={() => unlink(activeNote.id)} className="hover:text-rose-500 shrink-0" title="このタスクとのリンクを外す">このタスクから外す</button>
            </div>
          </div>
        )}
        {/* Left-edge resize handle */}
        {open && (
          <div
            onMouseDown={startResize}
            title="ドラッグで幅を調整"
            className={`absolute top-0 bottom-0 left-0 w-1.5 cursor-ew-resize hover:bg-indigo-300/60 ${resizing ? 'bg-indigo-400/70' : ''} transition-colors`}
          />
        )}
      </div>
    </div>
  )
}
