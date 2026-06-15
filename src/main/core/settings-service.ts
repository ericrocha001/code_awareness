// Responsabilidades do Script
//
// 1. Persistir e recuperar as configurações locais do aplicativo (ex: caminho do vault Obsidian).

import { app } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { AppSettings } from '../../shared/types'

const CONFIG_DIR = app.getPath('userData')
const CONFIG_FILE = join(CONFIG_DIR, 'settings.json')

const DEFAULT_SETTINGS: AppSettings = {
  obsidianVaultPath: null
}

export class SettingsService {
  loadSettings(): AppSettings {
    if (!existsSync(CONFIG_FILE)) return { ...DEFAULT_SETTINGS }
    try {
      const raw = readFileSync(CONFIG_FILE, 'utf-8')
      return JSON.parse(raw) as AppSettings
    } catch {
      return { ...DEFAULT_SETTINGS }
    }
  }

  saveSettings(settings: AppSettings): void {
    if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true })
    writeFileSync(CONFIG_FILE, JSON.stringify(settings, null, 2), 'utf-8')
  }
}
