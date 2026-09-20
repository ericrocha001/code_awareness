/*
-T ---
*/

import { app } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { AppSettings, OutputFormat, ContextEnrichment } from '../../shared/types'
import { DEFAULT_COMPRESSION_SETTINGS, normalizeCompressionProfile } from './compression-profile'
import { DEFAULT_DASH_SETTINGS, normalizeDashSettings } from '../../shared/utils/dash-settings'
import { desktopProfilePaths } from '../desktop-profile'

const DEFAULT_SETTINGS = {
  rootFolders: [],
  remoteAccessEnabled: false,
  transportKind: 'ngrok',
  individualProjects: [],
  hiddenProjects: [],
  ignoredDiffFiles: {},
  tags: {},
  fileTags: {},
  projectPreferences: {},
  compressionSettings: DEFAULT_COMPRESSION_SETTINGS,
  dashSettings: DEFAULT_DASH_SETTINGS
} as AppSettings

export class SettingsService {
  private readonly listeners = new Set<() => void>()

  onChanged(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private static instance: SettingsService

  static getInstance(): SettingsService {
    if (!SettingsService.instance) {
      SettingsService.instance = new SettingsService()
    }
    return SettingsService.instance
  }

  private getConfigFile(): string {
    return desktopProfilePaths(app.getPath('userData')).settingsPath
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
      merged.remoteAccessEnabled = rest.remoteAccessEnabled === true
      merged.transportKind = rest.transportKind === 'relay' ? 'relay' : 'ngrok'
      merged.individualProjects = rest.individualProjects || []
      merged.hiddenProjects = rest.hiddenProjects || []
      merged.tags = rest.tags || {}
      merged.fileTags = rest.fileTags || {}
      // Defesa em profundidade: se for array (inválido), usa objeto vazio
      merged.projectPreferences = (typeof rest.projectPreferences !== 'object' || Array.isArray(rest.projectPreferences))
        ? {}
        : rest.projectPreferences

      // CompressionSettings: ausente/corrompido → default; presente → normaliza o perfil defensivamente
      if (rest.compressionSettings && typeof rest.compressionSettings === 'object') {
        const raw = rest.compressionSettings as { profile?: unknown; outputFormat?: unknown; enrichment?: unknown }
        const format: OutputFormat =
          raw.outputFormat === 'markdown' || raw.outputFormat === 'xml' || raw.outputFormat === 'json'
            ? raw.outputFormat
            : 'plain'
        const enrichment =
          raw.enrichment && typeof raw.enrichment === 'object' && !Array.isArray(raw.enrichment)
            ? (raw.enrichment as ContextEnrichment)
            : undefined
        merged.compressionSettings = {
          profile: normalizeCompressionProfile(raw.profile),
          outputFormat: format,
          ...(enrichment ? { enrichment } : {})
        }
      } else {
        merged.compressionSettings = { ...DEFAULT_COMPRESSION_SETTINGS }
      }

      // DashSettings: ausente/corrompido → default; presente → normaliza defensivamente
      if (rest.dashSettings && typeof rest.dashSettings === 'object') {
        merged.dashSettings = normalizeDashSettings(rest.dashSettings)
      } else {
        merged.dashSettings = { ...DEFAULT_DASH_SETTINGS }
      }

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
    for (const listener of this.listeners) listener()
  }
}

// Instância singleton para ser compartilhada entre os módulos
export const settingsService = SettingsService.getInstance()
