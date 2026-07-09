// Where this renderer is running, which decides how it reads/writes data:
//  - 'electron': the desktop app (preload `window.api` present) → IPC + IndexedDB.
//  - 'remote'  : a browser (e.g. iPad) pointing at the desktop's LAN server, which
//                injects `window.__CONSTELLA_REMOTE__` → everything over HTTP.
//  - 'browser' : the standalone vite preview → IndexedDB only.
type Runtime = 'electron' | 'remote' | 'browser'

const w = window as unknown as { api?: unknown; __CONSTELLA_REMOTE__?: boolean }

export const RUNTIME: Runtime = w.api ? 'electron' : (w.__CONSTELLA_REMOTE__ ? 'remote' : 'browser')
export const isRemote = RUNTIME === 'remote'
export const isElectron = RUNTIME === 'electron'
