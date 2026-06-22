// Responsabilidades do Script
//
// 1. Persistir e recuperar as configurações locais do aplicativo (ex: caminho do vault Obsidian).

import { app } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { AppSettings } from '../../shared/types'

const DEFAULT_SETTINGS: AppSettings = {
  obsidianVaultPath: null,
  rootFolders: [],
  individualProjects: [],
  hiddenProjects: [],
  ignoredDiffFiles: {}
}

export class SettingsService {
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
        ignoredDiffFiles: parsed.ignoredDiffFiles || {}
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
