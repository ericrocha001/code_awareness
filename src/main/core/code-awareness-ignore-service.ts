/*
-T ---
*/

import { existsSync } from 'fs'
import { join } from 'path'
import type { AppSettings } from '../../shared/types'
import type { SettingsService } from './settings-service'

export interface SettingsStoragePort {
  loadSettings(): AppSettings
  saveSettings(settings: AppSettings): void
}

export class CodeAwarenessIgnoreService {
  constructor(private readonly settingsService: SettingsStoragePort | SettingsService) {}

  /**
   * Adiciona um caminho relativo à lista de ignorados do repositório de forma idempotente.
   * Retorna o AppSettings atualizado ou null em caso de argumentos inválidos.
   */
  public add(repoPath: string, relativePath: string): AppSettings | null {
    if (!this.isValidPath(repoPath) || !this.isValidPath(relativePath)) {
      return null
    }

    const normalizedRelative = this.normalizePath(relativePath)
    if (normalizedRelative.length === 0) {
      return null
    }

    const settings = this.settingsService.loadSettings()
    if (!settings.ignoredDiffFiles) {
      settings.ignoredDiffFiles = {}
    }

    const key = this.getRepoIgnoresKey(settings, repoPath)
    if (!settings.ignoredDiffFiles[key]) {
      settings.ignoredDiffFiles[key] = []
    }

    const list = settings.ignoredDiffFiles[key]
    const alreadyExists = list.some((item) => this.normalizePath(item) === normalizedRelative)
    if (!alreadyExists) {
      list.push(normalizedRelative)
    }

    this.settingsService.saveSettings(settings)
    return settings
  }

  /**
   * Remove um caminho relativo da lista de ignorados do repositório.
   * Não lança erro caso o caminho não esteja presente.
   * Retorna o AppSettings atualizado ou null em caso de argumentos inválidos.
   */
  public remove(repoPath: string, relativePath: string): AppSettings | null {
    if (!this.isValidPath(repoPath) || !this.isValidPath(relativePath)) {
      return null
    }

    const normalizedRelative = this.normalizePath(relativePath)
    const settings = this.settingsService.loadSettings()
    if (!settings.ignoredDiffFiles) {
      settings.ignoredDiffFiles = {}
    }

    const key = this.getRepoIgnoresKey(settings, repoPath)
    const list = settings.ignoredDiffFiles[key]
    if (list && Array.isArray(list)) {
      settings.ignoredDiffFiles[key] = list.filter(
        (item) => this.normalizePath(item) !== normalizedRelative
      )
    }

    this.settingsService.saveSettings(settings)
    return settings
  }

  /**
   * Lista todos os caminhos normalizados ignorados para o repositório.
   * Retorna array vazio caso o repositório não tenha ignorados ou em caso de erro.
   */
  public list(repoPath: string): string[] {
    if (!this.isValidPath(repoPath)) {
      return []
    }

    try {
      const settings = this.settingsService.loadSettings()
      if (!settings.ignoredDiffFiles) {
        return []
      }

      const key = this.getRepoIgnoresKey(settings, repoPath)
      const list = settings.ignoredDiffFiles[key]
      if (!Array.isArray(list)) {
        return []
      }

      const normalizedSet = new Set<string>()
      for (const item of list) {
        if (typeof item === 'string') {
          const normalized = this.normalizePath(item)
          if (normalized.length > 0) {
            normalizedSet.add(normalized)
          }
        }
      }

      return Array.from(normalizedSet)
    } catch {
      return []
    }
  }

  /**
   * Verifica se um determinado caminho relativo está ignorado para o repositório.
   */
  public isIgnored(repoPath: string, relativePath: string): boolean {
    if (!this.isValidPath(repoPath) || !this.isValidPath(relativePath)) {
      return false
    }

    const normalizedRelative = this.normalizePath(relativePath)
    const ignoredList = this.list(repoPath)
    return ignoredList.includes(normalizedRelative)
  }

  /**
   * Reconcilia a lista de ignorados removendo caminhos que não existem mais fisicamente no disco.
   * Entradas que contenham curinga (*) são preservadas como padrões manuais.
   * Retorna o AppSettings atualizado ou null em caso de argumentos inválidos.
   */
  public reconcile(repoPath: string): AppSettings | null {
    if (!this.isValidPath(repoPath)) {
      return null
    }

    const settings = this.settingsService.loadSettings()
    if (!settings.ignoredDiffFiles) {
      settings.ignoredDiffFiles = {}
    }

    const key = this.getRepoIgnoresKey(settings, repoPath)
    const repoIgnores = settings.ignoredDiffFiles[key]
    if (repoIgnores && Array.isArray(repoIgnores)) {
      const reconciledList: string[] = []
      const seen = new Set<string>()

      for (const entry of repoIgnores) {
        if (typeof entry !== 'string' || entry.trim().length === 0) {
          continue
        }

        const normalized = this.normalizePath(entry)
        if (seen.has(normalized)) {
          continue
        }

        // Padrões com curinga (*) são preservados sem checagem de disco
        if (normalized.includes('*')) {
          reconciledList.push(normalized)
          seen.add(normalized)
          continue
        }

        // Caminhos literais: valida existência no filesystem
        const fullPath = join(repoPath, normalized)
        if (existsSync(fullPath)) {
          reconciledList.push(normalized)
          seen.add(normalized)
        }
      }

      settings.ignoredDiffFiles[key] = reconciledList
    }

    this.settingsService.saveSettings(settings)
    return settings
  }

  /**
   * Normaliza um caminho para barras normais (/) e remove barras iniciais/finais redundantes.
   */
  public normalizePath(path: string): string {
    return path.replace(/\\/g, '/').replace(/^\/+/, '').trim()
  }

  /**
   * Valida se o caminho é uma string não vazia.
   */
  private isValidPath(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0
  }

  /**
   * Resolve a chave do mapa ignoredDiffFiles suportando caminhos exatos ou normalizados.
   */
  private getRepoIgnoresKey(settings: AppSettings, repoPath: string): string {
    if (settings.ignoredDiffFiles[repoPath]) {
      return repoPath
    }
    const normalizedRepo = this.normalizePath(repoPath)
    if (settings.ignoredDiffFiles[normalizedRepo]) {
      return normalizedRepo
    }
    return repoPath
  }
}
