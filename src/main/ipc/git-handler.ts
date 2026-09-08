/*
-T ---
*/

import { ipcMain, shell, BrowserWindow } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { GitService } from '../core/git-service'
import { WatcherService } from '../core/watcher-service'
import { DiffService } from '../core/diff-service'
import { SettingsService } from '../core/settings-service'
import type { CompressionService } from '../core/compression-service'
import type { CompressionSettingsPayload } from '../../shared/types'
import { CodeSourceService } from '../core/code-source-service'
import { RepomixOutputAdapter } from '../core/repomix-output-adapter'
import { SourceGenerationCoordinator } from '../core/source-generation-coordinator'
import { CodeAwarenessIgnoreService } from '../core/code-awareness-ignore-service'

const gitService = new GitService()
const diffService = new DiffService()
const codeSourceService = new CodeSourceService()
const repomixOutputAdapter = new RepomixOutputAdapter()
const sourceGenerationCoordinator = new SourceGenerationCoordinator(codeSourceService)

const watcherUnsubscribers = new Map<string, () => void>()

// Valida se o path recebido via IPC é uma string não vazia
function isValidPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

export function registerGitHandlers(
  watcherService: WatcherService,
  settingsService: SettingsService,
  compressionService: CompressionService,
  ignoreService?: CodeAwarenessIgnoreService
): void {
  const codeAwarenessIgnoreService = ignoreService ?? new CodeAwarenessIgnoreService(settingsService)
  ipcMain.handle('git:check-repository', async (_event, dirPath: string) => {
    if (!isValidPath(dirPath)) return false
    return gitService.isGitRepository(dirPath)
  })

  ipcMain.handle('git:get-modified-files', async (_event, dirPath: string) => {
    if (!isValidPath(dirPath)) return []
    return gitService.getModifiedFiles(dirPath)
  })

  ipcMain.handle('watcher:start', async (event, dirPath: string) => {
    if (!isValidPath(dirPath)) return { success: false }
    const webContents = event.sender
    const normalizedPath = dirPath.replace(/\\/g, '/').replace(/\/$/, '')

    if (watcherUnsubscribers.has(normalizedPath)) {
      return { success: true }
    }

    const unsubscribe = watcherService.subscribe(normalizedPath, (filePath) => {
      if (!webContents.isDestroyed()) {
        webContents.send('watcher:file-changed', filePath)
      }
    })

    watcherUnsubscribers.set(normalizedPath, unsubscribe)
    return { success: true }
  })

  ipcMain.handle('watcher:stop', async () => {
    for (const unsubscribe of watcherUnsubscribers.values()) {
      try {
        unsubscribe()
      } catch (err) {
        console.error('[GitHandler] Erro ao desassinar watcher IPC:', err)
      }
    }
    watcherUnsubscribers.clear()
    return { success: true }
  })

  ipcMain.handle('git:generate-semantic-diff', async (_event, repoPath: string, selectedFiles?: string[]) => {
    if (!isValidPath(repoPath)) return ''
    return diffService.generateSemanticDiff(repoPath, selectedFiles)
  })

  ipcMain.handle('git:get-all-files', async (_event, dirPath: string) => {
    if (!isValidPath(dirPath)) return []
    return gitService.getAllFiles(dirPath)
  })

  ipcMain.handle('git:generate-compression-markdown', async (_event, repoPath: string, selectedFiles: string[], settings?: CompressionSettingsPayload) => {
    if (!isValidPath(repoPath) || !Array.isArray(selectedFiles) || selectedFiles.length === 0) return ''
    const { profile, outputFormat, enrichment } = settings ?? {}
    return compressionService.generateCompressionMarkdown(repoPath, selectedFiles, profile, outputFormat, enrichment)
  })

  ipcMain.handle(
    'code-source:generate-with-profile',
    async (
      _event,
      repoPath: string,
      selectedFiles: string[],
      format?: unknown,
      profile?: unknown,
      meta?: { generationId?: number; sessionKey?: string }
    ) => {
      if (!isValidPath(repoPath)) {
        return { success: false, error: 'repoPath é obrigatório e deve ser uma string não vazia.' }
      }
      if (!Array.isArray(selectedFiles)) {
        return { success: false, error: 'selectedFiles deve ser um array de caminhos.' }
      }

      // Fluxo coordenado: delega ao coordenador quando generationId e sessionKey estão presentes.
      if (meta && typeof meta.generationId === 'number' && typeof meta.sessionKey === 'string') {
        try {
          return await sourceGenerationCoordinator.generate(
            meta.sessionKey,
            meta.generationId,
            { repoPath, selectedFiles, format, profile }
          )
        } catch {
          // GenerationCancelledError relançado pelo coordenador — descarta silenciosamente.
          return { success: false, error: 'Generation cancelled', generationId: meta.generationId }
        }
      }

      // Fluxo legado: sem coordenação, retrocompatibilidade com chamadores antigos.
      return codeSourceService.generateWithProfile({ repoPath, selectedFiles, format, profile })
    }
  )

  ipcMain.handle('code-source:check-installation', async () => {
    return repomixOutputAdapter.checkInstallation()
  })

  // Adiciona um arquivo/padrão à lista de ignorados para o repositório informado
  ipcMain.handle('git:add-ignored-file', async (_event, repoPath: string, relativePath: string) => {
    if (!isValidPath(repoPath) || !isValidPath(relativePath)) return null
    return codeAwarenessIgnoreService.add(repoPath, relativePath)
  })

  // Remove um arquivo/padrão da lista de ignorados para o repositório informado
  ipcMain.handle('git:remove-ignored-file', async (_event, repoPath: string, relativePath: string) => {
    if (!isValidPath(repoPath) || !isValidPath(relativePath)) return null
    return codeAwarenessIgnoreService.remove(repoPath, relativePath)
  })

  // Reconciliador: remove da lista de ignorados apenas padrões/arquivos que representam arquivos
  // deletados fisicamente do disco, evitando entradas fantasma.
  ipcMain.handle('git:reconcile-ignored-files', async (_event, repoPath: string, _currentModifiedFiles?: string[]) => {
    if (!isValidPath(repoPath)) return null
    return codeAwarenessIgnoreService.reconcile(repoPath)
  })

  // Revela um arquivo no Explorer/Finder nativo do sistema operacional
  ipcMain.handle('git:reveal-in-explorer', async (_event, repoPath: string, relativePath: string) => {
    if (!isValidPath(repoPath) || !isValidPath(relativePath)) return false
    const fullPath = join(repoPath, relativePath)
    if (existsSync(fullPath)) {
      shell.showItemInFolder(fullPath)
      return true
    }
    return false
  })
}
