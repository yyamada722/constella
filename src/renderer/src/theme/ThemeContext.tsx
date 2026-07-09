import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { applyCodeTheme, applyThemeMode, type ThemeMode } from './applyTheme'
import type { CodeThemeId } from './hljsThemes'

const THEME_KEY = 'constella.theme'
const CODE_KEY = 'constella.codeTheme'

interface ThemeCtx {
  mode: ThemeMode
  setMode: (m: ThemeMode) => void
  codeTheme: CodeThemeId
  setCodeTheme: (c: CodeThemeId) => void
}

const Ctx = createContext<ThemeCtx | null>(null)
export const useTheme = () => {
  const v = useContext(Ctx)
  if (!v) throw new Error('useTheme outside ThemeProvider')
  return v
}

function readMode(): ThemeMode {
  try {
    const v = localStorage.getItem(THEME_KEY)
    if (v === 'dark' || v === 'light') return v
  } catch { /* ignore */ }
  return 'light'
}
function readCode(): CodeThemeId {
  try {
    const v = localStorage.getItem(CODE_KEY)
    if (v) return v as CodeThemeId
  } catch { /* ignore */ }
  return 'github'
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(readMode)
  const [codeTheme, setCodeThemeState] = useState<CodeThemeId>(readCode)

  useEffect(() => { applyThemeMode(mode) }, [mode])
  useEffect(() => { applyCodeTheme(codeTheme) }, [codeTheme])

  const setMode = useCallback((m: ThemeMode) => {
    setModeState(m)
    try { localStorage.setItem(THEME_KEY, m) } catch { /* ignore */ }
  }, [])
  const setCodeTheme = useCallback((c: CodeThemeId) => {
    setCodeThemeState(c)
    try { localStorage.setItem(CODE_KEY, c) } catch { /* ignore */ }
  }, [])

  return <Ctx.Provider value={{ mode, setMode, codeTheme, setCodeTheme }}>{children}</Ctx.Provider>
}
