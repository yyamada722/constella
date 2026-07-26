import { useState, useRef, useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { FileText, FolderKanban, Globe, Search, Settings, LayoutDashboard, Download, Upload, TrainFront, Boxes, ChevronDown, Check, Pencil, Plus, Trash2, Brush, Wifi, PanelLeftClose, PanelLeftOpen, Activity, Palette, GitBranch, Map } from 'lucide-react'
import { useApp } from '../store'
import { useStore as useMindtrainStore } from '../mindtrain/store/useStore'
import { exportBackup, importBackup } from '../persistence/backup'
import { generateId } from '../utils'
import { SettingsModal } from './SettingsModal'
import { confirmDialog } from './ConfirmDialog'

const navItems = [
  { path: '/dashboard', icon: Activity, label: 'ダッシュボード', color: 'text-emerald-500' },
  { path: '/', icon: FileText, label: 'ノート', color: 'text-amber-600' },
  { path: '/projects', icon: FolderKanban, label: 'タスク', color: 'text-emerald-600' },
  { path: '/flow', icon: GitBranch, label: 'フロー', color: 'text-teal-600' },
  { path: '/plan', icon: Map, label: '計画', color: 'text-cyan-600' },
  { path: '/research', icon: Globe, label: 'リサーチ', color: 'text-sky-600' },
  { path: '/canvas', icon: LayoutDashboard, label: 'キャンバス', color: 'text-indigo-600' },
  { path: '/sketch', icon: Brush, label: 'スケッチ', color: 'text-fuchsia-600' },
  { path: '/mindtrain', icon: TrainFront, label: '路線図', color: 'text-rose-600' },
  { path: '/search', icon: Search, label: '検索', color: 'text-violet-600' },
]

export default function Sidebar() {
  const location = useLocation()
  const navigate = useNavigate()
  const { state, dispatch } = useApp()
  const [menuOpen, setMenuOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // Collapse / hover-to-expand. Persist the explicit preference but always
  // expand when a dropdown is open so the user can keep interacting.
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem('constella.sidebar.collapsed') === '1' } catch { return false }
  })
  const [hover, setHover] = useState(false)
  const hoverTimerRef = useRef<number | null>(null)
  useEffect(() => {
    try { localStorage.setItem('constella.sidebar.collapsed', collapsed ? '1' : '0') } catch { /* ignore */ }
  }, [collapsed])
  // Hover-expand has a 280ms enter delay so brushing past doesn't unfold the sidebar.
  // Leave has 180ms so users can drift across to dropdowns without triggering re-collapse.
  const onEnter = () => {
    if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null }
    if (!collapsed) return
    hoverTimerRef.current = window.setTimeout(() => setHover(true), 280)
  }
  const onLeave = () => {
    if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null }
    if (!collapsed) return
    hoverTimerRef.current = window.setTimeout(() => setHover(false), 180)
  }

  // Resizable width — drag the right edge to adjust. Persisted; 160–360 px.
  const [width, setWidth] = useState(() => {
    try { const v = Number(localStorage.getItem('constella.sidebar.width') || '224'); return v >= 160 && v <= 360 ? v : 224 } catch { return 224 }
  })
  const [resizing, setResizing] = useState(false)
  useEffect(() => {
    try { localStorage.setItem('constella.sidebar.width', String(width)) } catch { /* ignore */ }
  }, [width])
  function startResize(e: React.MouseEvent) {
    e.preventDefault()
    const startX = e.clientX
    const base = width
    setResizing(true)
    const onMove = (ev: MouseEvent) => {
      const next = Math.max(160, Math.min(360, base + (ev.clientX - startX)))
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

  // External LAN access (desktop only; the main process runs the server).
  type RemoteStatus = { enabled: boolean; port: number; urls: { label: string; url: string }[] }
  const remoteApi = (window as unknown as { api?: { remote?: { status: () => Promise<RemoteStatus>; set: (on: boolean) => Promise<RemoteStatus> } } }).api?.remote
  const [remote, setRemote] = useState<RemoteStatus>({ enabled: false, port: 0, urls: [] })
  useEffect(() => { remoteApi?.status().then(setRemote).catch(() => { /* ignore */ }) }, [remoteApi])
  const toggleRemote = async () => {
    try {
      const st = await remoteApi!.set(!remote.enabled)
      setRemote(st)
      window.dispatchEvent(new CustomEvent('constella-remote', { detail: st })) // let the Sync button show/hide
    } catch { /* ignore */ }
  }

  // Global master-project switcher state.
  const [projMenuOpen, setProjMenuOpen] = useState(false)
  const [editingMasterId, setEditingMasterId] = useState<string | null>(null)
  const masters = state.masterProjects
  const activeMaster = masters.find(m => m.id === state.activeMasterProjectId) ?? masters[0] ?? null

  function switchMaster(id: string) {
    setProjMenuOpen(false)
    if (id !== state.activeMasterProjectId) dispatch({ type: 'SET_ACTIVE_MASTER_PROJECT', payload: id })
  }

  function addMaster() {
    const m = { id: generateId(), name: '新しいプロジェクト', createdAt: new Date().toISOString() }
    dispatch({ type: 'ADD_MASTER_PROJECT', payload: m })
    dispatch({ type: 'SET_ACTIVE_MASTER_PROJECT', payload: m.id })
    setEditingMasterId(m.id)
  }

  async function deleteMaster(id: string) {
    if (masters.length <= 1) return
    const m = masters.find(x => x.id === id)
    if (!(await confirmDialog(`プロジェクト「${m?.name ?? ''}」と、その中のキャンバス・ノート・タスク・リサーチ・路線図をすべて削除します。よろしいですか？`))) return
    // If deleting the active master, switch to a survivor first (also moving the
    // route map off the doomed workspace) so nothing references the deleted id.
    if (id === state.activeMasterProjectId) {
      const next = masters.find(x => x.id !== id)
      if (next) {
        dispatch({ type: 'SET_ACTIVE_MASTER_PROJECT', payload: next.id })
        useMindtrainStore.getState().bindWorkspaceToProject(next.id, next.name)
      }
    }
    dispatch({ type: 'DELETE_MASTER_PROJECT', payload: id })
    useMindtrainStore.getState().dropProjectPlans(id)
  }

  // Human-readable "last backup export" stamp for the settings menu. Bumped in
  // localStorage after each successful export so it survives reloads.
  const [lastBackup, setLastBackup] = useState<string | null>(() => {
    try { return localStorage.getItem('constella.lastBackupExport') } catch { return null }
  })
  const lastBackupLabel = (() => {
    if (!lastBackup) return 'まだありません'
    const then = new Date(lastBackup).getTime()
    if (!Number.isFinite(then)) return 'まだありません'
    const days = Math.floor((Date.now() - then) / 86400000)
    return days <= 0 ? '今日' : `${days}日前`
  })()

  const doExport = async () => {
    setBusy('書き出し中…'); setMenuOpen(false)
    try {
      await exportBackup(state)
      const stamp = new Date().toISOString()
      try { localStorage.setItem('constella.lastBackupExport', stamp) } catch { /* ignore */ }
      setLastBackup(stamp)
    } catch { /* ignore */ }
    setBusy(null)
  }

  const onImportFile = async (file: File | undefined) => {
    if (!file) return
    if (!(await confirmDialog('現在のデータをバックアップの内容で置き換えます。よろしいですか？', { confirmLabel: '置き換える' }))) return
    setBusy('読み込み中…')
    try { await importBackup(file); window.location.reload() } catch (e) { alert(String(e instanceof Error ? e.message : e)); setBusy(null) }
  }

  // When collapsed AND not hovering AND no dropdown open → render the compact strip.
  const expanded = !collapsed || hover || projMenuOpen || menuOpen
  const outerW = collapsed ? 48 : width
  const innerW = expanded ? width : 48

  return (
    <div className={`relative h-full shrink-0 ${resizing ? '' : 'transition-[width] duration-200'}`} style={{ width: outerW }}>
      <aside
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        className={`absolute inset-y-0 left-0 bg-white border-r border-slate-200 flex flex-col ${resizing ? '' : 'transition-[width] duration-200'} ${collapsed && hover ? 'shadow-2xl z-40' : ''}`}
        style={{ width: innerW }}
      >
      <div className={`h-14 flex items-center border-b border-slate-200 shrink-0 gap-2 ${expanded ? 'px-3' : 'px-1 justify-center'}`}>
        {expanded && (
          <h1 className="text-lg font-bold tracking-tight flex-1 truncate pl-2">
            <span className="text-indigo-600">Constel</span>
            <span className="text-slate-700">la</span>
          </h1>
        )}
        <button
          onClick={() => setCollapsed(c => !c)}
          title={collapsed ? 'サイドバーを開く' : 'サイドバーを畳む'}
          className="p-1.5 rounded hover:bg-slate-100 text-slate-400 hover:text-slate-700 shrink-0"
        >
          {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
        </button>
      </div>

      {/* Global master-project switcher — the top of the hierarchy. Switching it
          re-scopes every tool (canvas / notes / 路線図 / research / tasks). */}
      <div className={`pt-3 pb-1 relative ${expanded ? 'px-3' : 'px-2'}`}>
        {expanded && <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide px-1 pb-1">プロジェクト</div>}
        <button
          onClick={() => setProjMenuOpen(o => !o)}
          className={`w-full flex items-center gap-2 rounded-lg text-sm font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 transition-colors ${expanded ? 'px-2.5 py-2' : 'p-2 justify-center'}`}
          title={expanded ? 'プロジェクトを切り替え' : (activeMaster?.name ?? 'プロジェクト')}
        >
          <Boxes size={16} className="text-indigo-500 shrink-0" />
          {expanded && <>
            <span className="flex-1 truncate text-left">{activeMaster?.name ?? 'プロジェクト'}</span>
            <ChevronDown size={14} className="text-slate-400 shrink-0" />
          </>}
        </button>
        {projMenuOpen && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setProjMenuOpen(false)} />
            <div className="absolute left-3 right-3 mt-1 z-20 bg-white border border-slate-200 rounded-lg shadow-xl py-1">
              <div className="max-h-72 overflow-y-auto">
                {masters.map(m => (
                  <div
                    key={m.id}
                    onClick={() => switchMaster(m.id)}
                    className={`group flex items-center gap-2 px-2.5 py-1.5 text-sm cursor-pointer hover:bg-slate-100 ${
                      m.id === state.activeMasterProjectId ? 'text-indigo-600' : 'text-slate-700'
                    }`}
                  >
                    <Check size={14} className={`shrink-0 ${m.id === state.activeMasterProjectId ? 'opacity-100' : 'opacity-0'}`} />
                    {editingMasterId === m.id ? (
                      <input
                        autoFocus
                        type="text"
                        value={m.name}
                        onChange={e => dispatch({ type: 'UPDATE_MASTER_PROJECT', payload: { ...m, name: e.target.value } })}
                        onBlur={() => setEditingMasterId(null)}
                        onKeyDown={e => { if (e.key === 'Enter') setEditingMasterId(null) }}
                        onClick={e => e.stopPropagation()}
                        className="flex-1 min-w-0 bg-transparent border-b border-indigo-300 outline-none text-sm text-slate-800"
                      />
                    ) : (
                      <span className="flex-1 min-w-0 truncate" onDoubleClick={e => { e.stopPropagation(); setEditingMasterId(m.id) }}>{m.name}</span>
                    )}
                    <button
                      onClick={e => { e.stopPropagation(); setEditingMasterId(m.id) }}
                      className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-slate-200 text-slate-400 hover:text-slate-700 transition-all shrink-0"
                      title="名前を変更"
                    >
                      <Pencil size={12} />
                    </button>
                    {masters.length > 1 && (
                      <button
                        onClick={e => { e.stopPropagation(); deleteMaster(m.id) }}
                        className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-slate-200 text-slate-400 hover:text-rose-500 transition-all shrink-0"
                        title="プロジェクトを削除"
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <div className="border-t border-slate-100 mt-1 pt-1">
                <button onClick={() => { setProjMenuOpen(false); addMaster() }} className="w-full flex items-center gap-2 px-2.5 py-1.5 text-sm text-indigo-600 hover:bg-indigo-50">
                  <Plus size={14} /> 新しいプロジェクト
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      <nav className={`flex-1 py-3 space-y-1 ${expanded ? 'px-3' : 'px-2'}`}>
        {navItems.map(({ path, icon: Icon, label, color }) => {
          const isActive = path === '/' ? location.pathname === '/' : location.pathname.startsWith(path)
          return (
            <button
              key={path}
              onClick={() => navigate(path)}
              title={expanded ? '' : label}
              className={`w-full flex items-center rounded-lg text-sm font-medium transition-all
                ${expanded ? 'gap-3 px-3 py-2.5' : 'p-2 justify-center'}
                ${isActive
                  ? 'bg-slate-100 text-slate-900'
                  : 'text-slate-500 hover:text-slate-900 hover:bg-slate-100'
                }`}
            >
              <Icon size={18} className={isActive ? color : ''} />
              {expanded && label}
            </button>
          )
        })}
      </nav>

      <div className={`border-t border-slate-200 relative ${expanded ? 'p-3' : 'p-2'}`}>
        {menuOpen && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
            <div className="absolute bottom-full left-3 right-3 mb-1 z-20 bg-white border border-slate-200 rounded-lg shadow-xl py-1">
              {remoteApi && (
                <div className="px-3 py-2 border-b border-slate-100">
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-2 text-sm text-slate-700"><Wifi size={15} /> 外部アクセス</span>
                    <button onClick={toggleRemote} title="LAN公開のオン/オフ" className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${remote.enabled ? 'bg-indigo-500' : 'bg-slate-300'}`}>
                      <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${remote.enabled ? 'translate-x-4' : ''}`} />
                    </button>
                  </div>
                  {remote.enabled && (
                    <div className="mt-1.5 text-[11px] text-slate-500">
                      <div className="mb-0.5">iPad等のブラウザで開く:</div>
                      {remote.urls.length === 0 && <div className="text-slate-400">アドレス取得中…</div>}
                      {remote.urls.map(u => (
                        <div key={u.url} className="flex items-baseline gap-1">
                          <span className="text-[9px] text-slate-400 shrink-0 w-14 truncate" title={u.label}>{u.label}</span>
                          <span className="font-mono text-indigo-600 select-all break-all">{u.url}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {remote.enabled && <p className="mt-1 text-[10px] text-slate-400">認証なし・基本は1台ずつ。別ネット/VPNからは「Tailscale」の行のURLを使用。</p>}
                </div>
              )}
              <button
                onClick={() => { setSettingsOpen(true); setMenuOpen(false) }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-slate-700 hover:bg-slate-100"
              >
                <Palette size={15} /> 外観・コードテーマ…
              </button>
              <div className="h-px bg-slate-200 my-1" />
              <button onClick={doExport} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-slate-700 hover:bg-slate-100">
                <Download size={15} /> バックアップを書き出し
              </button>
              <button onClick={() => { setMenuOpen(false); fileRef.current?.click() }} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-slate-700 hover:bg-slate-100">
                <Upload size={15} /> バックアップを読み込み
              </button>
              <div className="text-[10px] text-slate-400 px-3 py-1">最終書き出し: {lastBackupLabel}</div>
            </div>
          </>
        )}
        <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={e => onImportFile(e.target.files?.[0])} />
        <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
        <button
          onClick={() => setMenuOpen(o => !o)}
          title={expanded ? '' : (busy ?? '設定 / バックアップ')}
          className={`w-full flex items-center rounded-lg text-sm text-slate-500 hover:text-slate-800 hover:bg-slate-100 transition-all ${expanded ? 'gap-3 px-3 py-2.5' : 'p-2 justify-center'}`}
        >
          <Settings size={18} />
          {expanded && (busy ?? '設定 / バックアップ')}
        </button>
      </div>
      {/* Resize handle on the right edge — only when expanded */}
      {expanded && (
        <div
          onMouseDown={startResize}
          title="ドラッグで幅を調整"
          className={`absolute top-0 bottom-0 right-0 w-1.5 cursor-ew-resize hover:bg-indigo-300/60 ${resizing ? 'bg-indigo-400/70' : ''} transition-colors`}
        />
      )}
      </aside>
    </div>
  )
}
