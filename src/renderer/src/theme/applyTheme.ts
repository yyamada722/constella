// DOM-mutation helpers for theme + code-colorscheme application.
import { setMermaidTheme } from '../components/typol/mermaid'
import { CODE_THEMES_BY_ID, type CodeThemeId } from './hljsThemes'

export type ThemeMode = 'light' | 'dark'

const HLJS_LINK_ID = 'constella-hljs-theme'

function ensureHljsLink(): HTMLLinkElement {
  let link = document.getElementById(HLJS_LINK_ID) as HTMLLinkElement | null
  if (!link) {
    link = document.createElement('link')
    link.id = HLJS_LINK_ID
    link.rel = 'stylesheet'
    document.head.appendChild(link)
  }
  return link
}

export function applyThemeMode(mode: ThemeMode) {
  document.documentElement.classList.toggle('dark', mode === 'dark')
  setMermaidTheme(mode)
}

export function applyCodeTheme(id: CodeThemeId) {
  const t = CODE_THEMES_BY_ID[id]
  if (!t) return
  const link = ensureHljsLink()
  // Resolve to absolute URL for an accurate equality check AND assignment —
  // link.href always reads absolute, so assigning the relative t.url would
  // make the very next call see a mismatch and re-set the stylesheet, causing
  // a flash of unstyled code on every re-render.
  const abs = new URL(t.url, location.href).href
  if (link.href !== abs) link.href = abs
}
