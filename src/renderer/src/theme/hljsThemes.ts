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

export const CODE_THEMES: { id: CodeThemeId; label: string; isDark: boolean; url: string }[] = [
  { id: 'github',           label: 'GitHub Light',     isDark: false, url: githubUrl },
  { id: 'github-dark',      label: 'GitHub Dark',      isDark: true,  url: githubDarkUrl },
  { id: 'atom-one-dark',    label: 'Atom One Dark',    isDark: true,  url: atomOneDarkUrl },
  { id: 'monokai',          label: 'Monokai',          isDark: true,  url: monokaiUrl },
  { id: 'nord',             label: 'Nord',             isDark: true,  url: nordUrl },
  { id: 'tokyo-night-dark', label: 'Tokyo Night Dark', isDark: true,  url: tokyoNightDarkUrl },
  { id: 'vs2015',           label: 'VS 2015',          isDark: true,  url: vs2015Url },
]

export const CODE_THEMES_BY_ID = Object.fromEntries(
  CODE_THEMES.map(t => [t.id, t])
) as Record<CodeThemeId, typeof CODE_THEMES[number]>
