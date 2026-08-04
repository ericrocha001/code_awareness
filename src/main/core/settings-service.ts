/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Persistir e recuperar as configurações locais do aplicativo (ex: caminho do vault Obsidian).
2. Prover instância singleton do serviço de configurações para outros módulos.

Mapa de Relacionamentos do Script

1. git-handler.ts
   - Tipo: Dependência Direta
   - Relação: Consome a instância para gerenciar arquivos ignorados no diff.
   - Criticidade: Alta

Invariantes do Script

1. A instância singleton nunca deve ser recriada após inicialização.
2. Settings antigos sem campos novos devem ser carregados sem erro (compatibilidade retroativa).

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { app } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { AppSettings } from '../../shared/types'

const DEFAULT_SETTINGS = {
  rootFolders: [],
  individualProjects: [],
  hiddenProjects: [],
  ignoredDiffFiles: {},
  tags: {},
  fileTags: {},
  projectPreferences: {}
} as AppSettings

export class SettingsService {
  private static instance: SettingsService

  static getInstance(): SettingsService {
    if (!SettingsService.instance) {
      SettingsService.instance = new SettingsService()
    }
    return SettingsService.instance
  }

  private getConfigFile(): string {
    const configDir = app.getPath('userData')
    return join(configDir, 'settings.json')
  }

  loadSettings(): AppSettings {
    const configFile = this.getConfigFile()
    if (!existsSync(configFile)) return { ...DEFAULT_SETTINGS }
    try {
      const raw = readFileSync(configFile, 'utf-8')
      const parsed = JSON.parse(raw) as Partial<AppSettings>

      // Descarta o campo legado fileImportance (subsistema removido) antes de construir merged
      const { fileImportance: _legacyImportance, ...rest } = parsed

      const merged = {
        ...DEFAULT_SETTINGS,
        ...rest
      }

      // Migração de formato antigo (temporary + persistent) para array simples
      if (rest.ignoredDiffFiles) {
        merged.ignoredDiffFiles = {}
        for (const [repoPath, value] of Object.entries(rest.ignoredDiffFiles)) {
          if (Array.isArray(value)) {
            // Já está no novo formato (array simples)
            merged.ignoredDiffFiles[repoPath] = value
          } else if (typeof value === 'object' && value !== null) {
            // Formato antigo: { temporary: string[], persistent: string[] }
            const { temporary = [], persistent = [] } = value as { temporary?: string[]; persistent?: string[] }
            merged.ignoredDiffFiles[repoPath] = [...temporary, ...persistent]
          }
        }
      }

      merged.rootFolders = rest.rootFolders || []
      merged.individualProjects = rest.individualProjects || []
      merged.hiddenProjects = rest.hiddenProjects || []
      merged.tags = rest.tags || {}
      merged.fileTags = rest.fileTags || {}
      // Defesa em profundidade: se for array (inválido), usa objeto vazio
      merged.projectPreferences = (typeof rest.projectPreferences !== 'object' || Array.isArray(rest.projectPreferences))
        ? {}
        : rest.projectPreferences

      return merged as AppSettings
    } catch {
      return { ...DEFAULT_SETTINGS }
    }
  }

  saveSettings(settings: AppSettings): void {
    const configDir = app.getPath('userData')
    const configFile = this.getConfigFile()
    if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true })
    writeFileSync(configFile, JSON.stringify(settings, null, 2), 'utf-8')
  }
}

// Instância singleton para ser compartilhada entre os módulos
export const settingsService = SettingsService.getInstance()