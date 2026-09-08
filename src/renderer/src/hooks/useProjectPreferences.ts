/*
-T ---
*/

import { useState, useEffect } from 'react'
import type { ProjectPreferences } from '@shared/types'

const DEFAULT_PREFERENCES: ProjectPreferences = {
  sidebarOpen: true
}

export function useProjectPreferences(repoPath: string | null) {
  const [preferences, setPreferences] = useState<ProjectPreferences>(DEFAULT_PREFERENCES)

  useEffect(() => {
    if (!repoPath) return

    const load = async () => {
      try {
        const settings = await window.codeAwareness.loadSettings()
        let prefs = settings.projectPreferences?.[repoPath] ?? DEFAULT_PREFERENCES

        // Migração: remove campo viewMode obsoleto (era usado pelo Kanban, removido)
        if ('viewMode' in prefs) {
          const { viewMode, ...cleaned } = prefs as any
          prefs = cleaned
          settings.projectPreferences = settings.projectPreferences || {}
          settings.projectPreferences[repoPath] = prefs
          await window.codeAwareness.saveSettings(settings)
        }

        setPreferences(prefs)
      } catch {
        setPreferences(DEFAULT_PREFERENCES)
      }
    }

    load()
  }, [repoPath])

  const updateSidebarOpen = async (open: boolean) => {
    if (!repoPath) return
    const next = { ...preferences, sidebarOpen: open }
    setPreferences(next)
    await savePreferences(repoPath, next)
  }

  // Mescla sobre o valor atual e persiste — mesmo canal do updateSidebarOpen.
  // Chamado apenas no dragEnd do redimensionamento (nunca por delta).
  const updateFileViewColumnWidths = async (
    widths: Partial<Record<'toggle' | 'identity' | 'path' | 'tags' | 'tokens' | 'actions', number>>
  ) => {
    if (!repoPath) return
    const next = {
      ...preferences,
      fileViewColumnWidths: { ...preferences.fileViewColumnWidths, ...widths }
    }
    setPreferences(next)
    await savePreferences(repoPath, next)
  }

  return {
    preferences,
    updateSidebarOpen,
    updateFileViewColumnWidths
  }
}

async function savePreferences(repoPath: string, preferences: ProjectPreferences) {
  try {
    const settings = await window.codeAwareness.loadSettings()
    settings.projectPreferences = settings.projectPreferences || {}
    settings.projectPreferences[repoPath] = preferences
    await window.codeAwareness.saveSettings(settings)
  } catch {
    // Falha silenciosa no salvamento; estado local já foi atualizado.
  }
}