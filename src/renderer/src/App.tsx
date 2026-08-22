import { useEffect, useRef, useState } from 'react'
import { Routes, Route, useLocation } from 'react-router-dom'
import { RefreshCw, Sparkles } from 'lucide-react'
import Sidebar from './components/Sidebar'
import { WikiLinkProvider } from './components/WikiLink'
import AIChatPanel from './components/AIChatPanel'
import { ConfirmHost } from './components/ConfirmDialog'
import HelpModal, { type HelpRequest } from './components/HelpModal'
import { UpdateNotifier } from './components/UpdateNotifier'
import { useApp } from './store'
import { isRemote, isElectron } from './persistence/runtime'
import MobileApp from './mobile/MobileApp'
import { useStore as useMindtrainStore } from './mindtrain/store/useStore'
import NotesPage from './pages/NotesPage'
import ProjectsPage from './pages/ProjectsPage'
import DashboardPage from './pages/DashboardPage'
import ResearchPage from './pages/ResearchPage'
import FilesPage from './pages/FilesPage'
import SearchPage from './pages/SearchPage'
import CanvasPage from './pages/CanvasPage'
import SketchPage from './pages/SketchPage'
import FlowPage from './pages/FlowPage'
import PlanPage from './pages/PlanPage'
import MindtrainView from './mindtrain/MindtrainView'
import { ThemeProvider } from './theme/ThemeContext'

// Keeps the 路線図 (mindtrain) store — a separate zustand store — in lock-step with
// the global active master project: switching the master switches the route map.
// Lives here (above all routes) so it runs regardless of which page is showing.
function MindtrainBridge() {
  const { state, dispatch } = useApp()
  const activeId = state.activeMasterProjectId
  const name = state.masterProjects.find(p => p.id === activeId)?.name ?? ''

  // One-time reconciliation: every 路線図 plan (workspace) carries a projectId; make
  // sure a master project exists for each distinct one, so legacy/pre-refactor plans
  // stay reachable. Idempotent across launches (once created, the master exists).
  const reconciled = useRef(false)
  useEffect(() => {
    const run = () => {
      if (reconciled.current) return
      reconciled.current = true
      const known = new Set(state.masterProjects.map(p => p.id))
      const seen = new Set<string>()
      for (const m of Object.values(useMindtrainStore.getState().workspaceMeta)) {
        const pid = m.projectId
        if (pid && !known.has(pid) && !seen.has(pid)) {
          seen.add(pid)
          dispatch({ type: 'ADD_MASTER_PROJECT', payload: { id: pid, name: m.name || 'プロジェクト', createdAt: new Date().toISOString() } })
        }
      }
    }
    if (useMindtrainStore.persist.hasHydrated()) run()
    else return useMindtrainStore.persist.onFinishHydration(run)
  }, [])

  useEffect(() => {
    if (!activeId) return
    const run = () => useMindtrainStore.getState().bindWorkspaceToProject(activeId, name)
    // Wait for the mindtrain store's async (SQLite) rehydration before binding,
    // or we'd bind onto the pre-hydration default and lose the loaded route map.
    if (useMindtrainStore.persist.hasHydrated()) run()
    else return useMindtrainStore.persist.onFinishHydration(run)
  }, [activeId, name])
  return null
}

// Manual "pull latest from server" button — shown top-right only when LAN access is
// relevant (this is a remote client, or the desktop has the server enabled). The
// reload-on-focus is automatic; this lets you force a refresh without switching apps.
function SyncButton() {
  const { syncNow } = useApp()
  const [active, setActive] = useState(isRemote)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (isRemote) { setActive(true); return }
    const api = (window as unknown as { api?: { remote?: { status: () => Promise<{ enabled: boolean }> } } }).api?.remote
    api?.status().then(s => setActive(s.enabled)).catch(() => { /* ignore */ })
    const onEvt = (e: Event) => setActive(!!(e as CustomEvent).detail?.enabled)
    window.addEventListener('constella-remote', onEvt)
    return () => window.removeEventListener('constella-remote', onEvt)
  }, [])
  if (!active) return null
  return (
    <button
      onClick={async () => { if (busy) return; setBusy(true); try { await syncNow() } finally { setBusy(false) } }}
      title="サーバの最新データを取得（同期）"
      className="fixed bottom-4 right-4 z-40 flex items-center gap-1.5 px-3 py-2 rounded-full bg-white/90 backdrop-blur border border-slate-200 shadow-md text-xs font-medium text-slate-600 hover:text-indigo-600 hover:border-indigo-300 transition-colors"
    >
      <RefreshCw size={14} className={busy ? 'animate-spin' : ''} /> 同期
    </button>
  )
}

// Floating AI launcher — sits above the Sync button when present; opens the chat panel.
// Hidden in browser/remote runtime (no API key proxy available there).
function AILauncher() {
  const [open, setOpen] = useState(false)
  const available = !isRemote && !!(window as unknown as { api?: { ai?: unknown } }).api?.ai
  if (!available) return null
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="AIアシスタント"
        className="fixed bottom-4 right-20 z-40 flex items-center gap-1.5 px-3 py-2 rounded-full bg-gradient-to-br from-indigo-500 to-violet-500 text-white shadow-lg hover:shadow-xl hover:from-indigo-600 hover:to-violet-600 transition-all text-xs font-medium"
      >
        <Sparkles size={14} /> AI
      </button>
      <AIChatPanel open={open} onClose={() => setOpen(false)} />
    </>
  )
}

// Routes whose page component registers its OWN Ctrl+Z/Y handler (surface-local
// undo semantics, and mindtrain has a separate store). The global fallback must
// not also fire there — window listeners run in registration order, so a
// defaultPrevented check can't help (this global one registers first).
const SELF_UNDO_ROUTES = new Set(['/canvas', '/flow', '/sketch', '/mindtrain'])

// App-wide interaction layer:
//  - Ctrl+Z / Ctrl+Y (Ctrl+Shift+Z) undo/redo on pages that lack their own
//    handler (Notes / Tasks / Research / Dashboard / Search) — deleting a note
//    or editing a task is now always keyboard-undoable. Text fields keep their
//    native typing-undo.
//  - Click-outside (and Escape) closes any open <details> menu — the app-wide
//    "範囲外クリックで閉じる" convention for disclosure popovers.
//  - Window title mirrors the active project.
//  - "?" opens the in-app help (shortcuts chapter).
function GlobalUX({ onHelp }: { onHelp: () => void }) {
  const { state, undo, redo } = useApp()
  const location = useLocation()
  const selfUndo = SELF_UNDO_ROUTES.has(location.pathname)
  const selfUndoRef = useRef(selfUndo)
  selfUndoRef.current = selfUndo

  // Window title: Constella v<version> — <active project>
  useEffect(() => {
    const name = state.masterProjects.find(p => p.id === state.activeMasterProjectId)?.name
    const base = `Constella v${__APP_VERSION__}`
    document.title = name ? `${base} — ${name}` : base
  }, [state.activeMasterProjectId, state.masterProjects])

  useEffect(() => {
    const isTyping = (el: EventTarget | null): boolean => {
      const t = el as HTMLElement | null
      return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)
    }
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return
      const mod = e.ctrlKey || e.metaKey
      if (!selfUndoRef.current) {
        if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return }
        if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return }
      }
      if (e.key === '?' && !mod) { e.preventDefault(); onHelp() }
    }
    const onPointerDown = (e: PointerEvent) => {
      // Close every open <details> popover the click landed outside of.
      const t = e.target as Node
      document.querySelectorAll('details[open]').forEach(d => {
        if (!d.contains(t)) d.removeAttribute('open')
      })
    }
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      document.querySelectorAll('details[open]').forEach(d => d.removeAttribute('open'))
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keydown', onEsc)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keydown', onEsc)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [undo, redo, onHelp])

  return null
}

// Phone-sized non-Electron clients (a phone browser on the LAN server, or the vite
// preview) get the mobile capture-&-reference shell instead of the desktop layout.
// ?mobile=1 / ?desktop=1 override the width heuristic. The desktop Electron app
// never switches — its window can be narrow without losing the full UI.
function useMobileShell(): boolean {
  const decide = () => {
    if (isElectron) return false
    const params = new URLSearchParams(window.location.search)
    if (params.has('desktop')) return false
    if (params.has('mobile')) return true
    // Touch devices are judged by their SMALLER dimension, so rotating a phone
    // to landscape (innerWidth jumps past 768) doesn't flip it to the desktop
    // UI mid-use. An iPad (short side ≥768) still gets the desktop UI. Desktop
    // browsers (fine pointer) keep the plain width check.
    if (window.matchMedia('(pointer: coarse)').matches) {
      return Math.min(window.innerWidth, window.innerHeight) < 768
    }
    return window.innerWidth < 768
  }
  const [mobile, setMobile] = useState(decide)
  useEffect(() => {
    if (isElectron) return
    const onResize = () => setMobile(decide())
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return mobile
}

export default function App() {
  // null = closed; an object per request so repeated opens re-target the chapter.
  const [helpReq, setHelpReq] = useState<HelpRequest | null>(null)
  const mobileShell = useMobileShell()

  // Anywhere in the app (e.g. the sidebar settings menu) can open the help via a
  // CustomEvent — same pattern as 'constella-remote', avoids prop drilling.
  useEffect(() => {
    const onOpen = (e: Event) => setHelpReq({ chapter: (e as CustomEvent).detail?.chapter ?? 'intro' })
    window.addEventListener('constella-open-help', onOpen)
    return () => window.removeEventListener('constella-open-help', onOpen)
  }, [])
  if (mobileShell) {
    return (
      <ThemeProvider>
        <WikiLinkProvider>
          <ConfirmHost />
          <MobileApp />
        </WikiLinkProvider>
      </ThemeProvider>
    )
  }
  return (
    <ThemeProvider>
    <WikiLinkProvider>
      <MindtrainBridge />
      <GlobalUX onHelp={() => setHelpReq({ chapter: 'shortcuts' })} />
      <HelpModal open={helpReq !== null} req={helpReq} onClose={() => setHelpReq(null)} />
      <ConfirmHost />
      <SyncButton />
      <AILauncher />
      <UpdateNotifier />
      <div className="flex h-screen bg-slate-50 dark:bg-slate-950">
        <Sidebar />
        <main className="flex-1 overflow-hidden">
          <Routes>
            <Route path="/" element={<NotesPage />} />
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/projects" element={<ProjectsPage />} />
            <Route path="/flow" element={<FlowPage />} />
            <Route path="/plan" element={<PlanPage />} />
            <Route path="/research" element={<ResearchPage />} />
            <Route path="/files" element={<FilesPage />} />
            <Route path="/canvas" element={<CanvasPage />} />
            <Route path="/sketch" element={<SketchPage />} />
            <Route path="/mindtrain" element={<MindtrainView />} />
            <Route path="/search" element={<SearchPage />} />
          </Routes>
        </main>
      </div>
    </WikiLinkProvider>
    </ThemeProvider>
  )
}
