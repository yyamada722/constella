// Highlight.js stylesheet catalogue. Each theme is imported via Vite's ?url so
// the build emits real asset URLs we can swap into a single <link> element at
// runtime. Static `import 'highlight.js/styles/x.css'` is avoided so nothing
// competes with the dynamic link.
import githubUrl from 'highlight.js/styles/github.css?url'
import githubDarkUrl from 'highlight.js/styles/github-dark.css?url'
import atomOneDarkUrl from 'highlight.js/styles/atom-one-dark.css?url'
import monokaiUrl from 'highlight.js/styles/monokai.css?url'
import nordUrl from 'highlight.js/styles/nord.css?url'
import tokyoNightDarkUrl from 'highlight.js/styles/tokyo-night-dark.css?url'
import vs2015Url from 'highlight.js/styles/vs2015.css?url'

export type CodeThemeId =
  | 'github' | 'github-dark' | 'atom-one-dark' | 'monokai' | 'nord' | 'tokyo-night-dark' | 'vs2015'

// `bg` mirrors each stylesheet's `.hljs` background (github uses a soft slate
// tint instead of its pure white so the light default keeps the current look).
// App CSS strips the background from the <code> element and paints the <pre>
// with var(--hljs-bg) instead, so block background always matches text color
// even when code theme polarity differs from the app theme.
export const CODE_THEMES: { id: CodeThemeId; label: string; isDark: boolean; url: string; bg: string }[] = [
  { id: 'github',           label: 'GitHub Light',     isDark: false, url: githubUrl,        bg: 'rgb(248 250 252)' },
  { id: 'github-dark',      label: 'GitHub Dark',      isDark: true,  url: githubDarkUrl,    bg: '#0d1117' },
  { id: 'atom-one-dark',    label: 'Atom One Dark',    isDark: true,  url: atomOneDarkUrl,   bg: '#282c34' },
  { id: 'monokai',          label: 'Monokai',          isDark: true,  url: monokaiUrl,       bg: '#272822' },
  { id: 'nord',             label: 'Nord',             isDark: true,  url: nordUrl,          bg: '#2e3440' },
  { id: 'tokyo-night-dark', label: 'Tokyo Night Dark', isDark: true,  url: tokyoNightDarkUrl, bg: '#1a1b26' },
  { id: 'vs2015',           label: 'VS 2015',          isDark: true,  url: vs2015Url,        bg: '#1e1e1e' },
]

export const CODE_THEMES_BY_ID = Object.fromEntries(
  CODE_THEMES.map(t => [t.id, t])
) as Record<CodeThemeId, typeof CODE_THEMES[number]>
