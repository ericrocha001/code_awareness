/*
-T ---
*/

import { useState, useEffect, useCallback } from 'react'

type ThemePreference = 'light' | 'dark' | 'system'
type EffectiveTheme = 'light' | 'dark'

const STORAGE_KEY = 'theme-preference'
const DEFAULT_THEME: ThemePreference = 'system'

function getStoredTheme(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'light' || stored === 'dark' || stored === 'system') {
      return stored
    }
  } catch {
    // localStorage indisponível; usa padrão
  }
  return DEFAULT_THEME
}

function getSystemTheme(): EffectiveTheme {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

function resolveEffectiveTheme(theme: ThemePreference): EffectiveTheme {
  if (theme === 'system') {
    return getSystemTheme()
  }
  return theme
}

export function useTheme() {
  const [theme, setThemeState] = useState<ThemePreference>(getStoredTheme)
  const [effectiveTheme, setEffectiveTheme] = useState<EffectiveTheme>(() =>
    resolveEffectiveTheme(getStoredTheme())
  )

  // Aplica data-theme no <body> sempre que theme mudar
  useEffect(() => {
    document.body.setAttribute('data-theme', theme)
  }, [theme])

  // Recalcula effectiveTheme quando theme mudar
  useEffect(() => {
    setEffectiveTheme(resolveEffectiveTheme(theme))
  }, [theme])

  // Escuta mudanças na media query do sistema quando theme === 'system'
  useEffect(() => {
    if (theme !== 'system') return

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')

    const handleChange = () => {
      setEffectiveTheme(mediaQuery.matches ? 'dark' : 'light')
    }

    mediaQuery.addEventListener('change', handleChange)
    return () => mediaQuery.removeEventListener('change', handleChange)
  }, [theme])

  // Escuta eventos IPC do processo principal (Sprint 3)
  useEffect(() => {
    // Só se inscreve se o modo for 'system'
    if (theme !== 'system') return
    if (!window.codeAwareness?.onThemeChanged) return

    const unsubscribe = window.codeAwareness.onThemeChanged((isDarkMode: boolean) => {
      setEffectiveTheme(isDarkMode ? 'dark' : 'light')
    })

    return () => unsubscribe()
  }, [theme])

  const setTheme = useCallback((newTheme: ThemePreference) => {
    setThemeState(newTheme)
    try {
      localStorage.setItem(STORAGE_KEY, newTheme)
    } catch {
      // Falha silenciosa na persistência; estado em memória já foi atualizado
    }
  }, [])

  return { theme, setTheme, effectiveTheme }
}