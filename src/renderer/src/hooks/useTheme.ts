/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Gerenciar o estado do tema ativo (light/dark/system) com persistência em localStorage.
2. Aplicar o atributo data-theme no <body> para ativar os tokens CSS definidos no index.css.
3. Calcular o tema efetivo (light/dark) baseado na preferência do usuário e na media query do sistema.
4. Sincronizar com o tema do sistema operacional via listener IPC quando configurado como "system".

Mapa de Relacionamentos do Script

1. index.css
   - Tipo: Dependência Direta
   - Relação: Consome os tokens CSS via data-theme no <body>.
   - Criticidade: Alta

2. window.codeAwareness.onThemeChanged (preload, Sprint 3)
   - Tipo: Comunicação por Evento
   - Relação: Escuta mudanças de tema do sistema operacional via IPC.
   - Criticidade: Média

3. App.tsx (Sprint 4)
   - Tipo: Fluxo de Dados
   - Relação: Consome { theme, setTheme, effectiveTheme } para controlar o tema da aplicação.
   - Criticidade: Alta

Invariantes do Script

1. O atributo data-theme no <body> deve sempre refletir o valor atual de theme (light/dark/system).
2. O effectiveTheme deve sempre ser um valor resolvido (light ou dark), nunca "system".
3. A preferência do usuário deve ser persistida no localStorage a cada mudança de tema.
4. Todos os listeners (media query e IPC) devem ser removidos no cleanup para evitar memory leaks.
5. Nunca lançar erros não tratados para o componente consumidor.

--- FIM ARQUITETURA DO SCRIPT ---
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