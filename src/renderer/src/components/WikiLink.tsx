import { createContext, useContext, useCallback, useRef, ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApp } from '../store'

// Provides a stable resolver for [[Card Title]] wiki-links in Markdown: it finds a
// canvas card by title and navigates to the canvas focused on it. The function
// identity is stable (reads the latest cards via a ref), so consuming it doesn't
// re-render text on every state change.
const WikiLinkContext = createContext<(title: string) => void>(() => {})

export const useWikiLink = () => useContext(WikiLinkContext)

export function WikiLinkProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  const { state } = useApp()
  const cardsRef = useRef(state.canvasCards)
  cardsRef.current = state.canvasCards
  const notesRef = useRef(state.notes)
  notesRef.current = state.notes
  const activeRef = useRef(state.activeMasterProjectId)
  activeRef.current = state.activeMasterProjectId

  const resolve = useCallback((title: string) => {
    const t = title.trim().toLowerCase()
    const card = cardsRef.current.find(c => (c.title || '').trim().toLowerCase() === t)
    if (card) { navigate('/canvas', { state: { focusCardId: card.id } }); return }
    // キャンバスカードに無ければノートのタイトルで解決（アクティブプロジェクト優先）
    const notes = notesRef.current.filter(n => (n.title || '').trim().toLowerCase() === t)
    const note = notes.find(n => n.masterProjectId === activeRef.current) ?? notes[0]
    if (note) navigate('/', { state: { focusNoteId: note.id } })
  }, [navigate])

  return <WikiLinkContext.Provider value={resolve}>{children}</WikiLinkContext.Provider>
}
