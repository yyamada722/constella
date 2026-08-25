import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App'
import { AppProvider } from './store'
import { getMediaBlob } from './persistence/media'
// Bundled UI fonts (offline). IBM Plex Sans JP is the primary face; Noto Sans JP
// is bundled as a broad-coverage fallback. @fontsource ships per-weight woff2
// split by unicode-range, so only the glyph subsets actually used get loaded.
import '@fontsource/ibm-plex-sans-jp/400.css'
import '@fontsource/ibm-plex-sans-jp/500.css'
import '@fontsource/ibm-plex-sans-jp/700.css'
import '@fontsource/noto-sans-jp/400.css'
import '@fontsource/noto-sans-jp/500.css'
import '@fontsource/noto-sans-jp/700.css'
// Klee One (教科書体系) — 執筆テーマの「手書き」フォント用。unicode-range 分割
// なので実際に使うまでグリフはロードされない。
import '@fontsource/klee-one/400.css'
import '@fontsource/klee-one/600.css'
import './index.css'
// Auto-generated dark-theme remaps (scripts/gen-dark-css.mjs). MUST come after
// index.css so the :where(.dark) overrides win by source order.
import './dark-overrides.css'
// Typol markdown editor styles + KaTeX. Highlight.js styles are loaded dynamically
// via theme/applyTheme.ts so the user-selected code colorscheme can swap at runtime.
import 'katex/dist/katex.min.css'
import './components/typol/typol.css'
// 執筆テーマ (.wt-*) — typol.css の後に読み込んでトークンを上書きする。
import './components/typol/writing-themes.css'

// Desktop only: when LAN access serves media to a remote device (iPad), the main
// process asks this renderer for the bytes (media lives in our IndexedDB). Answer.
{
  const api = (window as unknown as {
    api?: {
      onRemoteMediaRequest?: (cb: (reqId: string, id: string) => void) => void
      replyRemoteMedia?: (reqId: string, bytes: Uint8Array | null, mime?: string) => void
    }
  }).api
  if (api?.onRemoteMediaRequest && api.replyRemoteMedia) {
    api.onRemoteMediaRequest(async (reqId, id) => {
      try {
        const blob = await getMediaBlob('idb:' + id)
        const bytes = blob ? new Uint8Array(await blob.arrayBuffer()) : null
        // Pass the stored blob's MIME along so the LAN server can serve a real
        // Content-Type — remote clients type-sniff previews (PDF/画像) from it.
        api.replyRemoteMedia!(reqId, bytes, blob?.type || '')
      } catch { api.replyRemoteMedia!(reqId, null) }
    })
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      <AppProvider>
        <App />
      </AppProvider>
    </HashRouter>
  </React.StrictMode>
)
