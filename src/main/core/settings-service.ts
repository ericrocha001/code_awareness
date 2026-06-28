/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Persistir e recuperar as configurações locais do aplicativo (ex: caminho do vault Obsidian).
2. Prover instância singleton do serviço de configurações para outros módulos.

Mapa de Relacionamentos do Script

1. importance-service.ts
   - Tipo: Dependência Direta
   - Relação: Consome a instância singleton para carregar/salvar classificações de importância.
   - Criticidade: Alta

2. git-handler.ts
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

const DEFAULT_SETTINGS: AppSettings = {
  rootFolders: [],
  individualProjects: [],
  hiddenProjects: [],
  ignoredDiffFiles: {},
  fileImportance: {}
}

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
      return {
        ...DEFAULT_SETTINGS,
        ...parsed,
        rootFolders: parsed.rootFolders || [],
        individualProjects: parsed.individualProjects || [],
        hiddenProjects: parsed.hiddenProjects || [],
        ignoredDiffFiles: parsed.ignoredDiffFiles || {},
        fileImportance: parsed.fileImportance || {}
      }
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