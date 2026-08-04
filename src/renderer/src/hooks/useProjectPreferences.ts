/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Carregar preferências de UI por projeto a partir do settings.json.
2. Expor setters tipados para sidebar e modo de visualização com salvamento automático.
3. Retornar estado atual consolidado para consumo dos componentes.

Mapa de Relacionamentos do Script

1. window.codeAwareness.loadSettings/saveSettings
   - Tipo: Dependência Direta
   - Relação: Lê e persiste preferências no settings.json.
   - Criticidade: Alta

2. GlobalSidebar.tsx
   - Tipo: Fluxo de Dados
   - Relação: Consome o estado de sidebar e atualiza via hook.
   - Criticidade: Alta

3. CodeSourceView.tsx
   - Tipo: Fluxo de Dados
   - Relação: Consome o modo de visualização e atualiza via hook.
   - Criticidade: Alta

Invariantes do Script

1. Sempre retornar valores válidos mesmo quando repoPath for nulo.
2. Nunca lançar erros não tratados para o componente consumidor.
3. O salvamento deve sempre refletir o mesmo estado retornado para a UI.

--- FIM ARQUITETURA DO SCRIPT ---
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

  return {
    preferences,
    updateSidebarOpen
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