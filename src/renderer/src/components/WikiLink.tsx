import { createContext, useContext, useCallback, useRef, useLayoutEffect, ReactNode } from 'react'
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
  const notesRef = useRef(state.notes)
  const activeRef = useRef(state.activeMasterProjectId)
  // レンダー中の ref 書き込みは破棄されたレンダーの値が漏れうるため、コミット後に同期する
  useLayoutEffect(() => {
    cardsRef.current = state.canvasCards
    notesRef.current = state.notes
    activeRef.current = state.activeMasterProjectId
  }, [state.canvasCards, state.notes, state.activeMasterProjectId])

  const resolve = useCallback((title: string) => {
    const t = title.trim().toLowerCase()
    const card = cardsRef.current.find(c => (c.title || '').trim().toLowerCase() === t)
    if (card) { navigate('/canvas', { state: { focusCardId: card.id } }); return }
    // キャンバスカードに無ければノートのタイトルで解決。NotesPage が表示できる
    // ノートに限る（自プロジェクト or 参照済み共有ノート、アーカイブ除外）—
    // 表示不能な focusNoteId を渡すと選択が先頭ノートへ黙って差し替わるため。
    const active = activeRef.current
    const notes = notesRef.current.filter(n =>
      !n.archivedAt &&
      (n.title || '').trim().toLowerCase() === t &&
      (n.masterProjectId === active || (n.shared && (n.refByMasterIds ?? []).includes(active))))
    const note = notes.find(n => n.masterProjectId === active) ?? notes[0]
    if (note) navigate('/', { state: { focusNoteId: note.id } })
  }, [navigate])

  return <WikiLinkContext.Provider value={resolve}>{children}</WikiLinkContext.Provider>
}
