// Responsabilidades do Script
//
// 1. Registrar os handlers IPC para verificação de repositório Git e listagem de arquivos modificados.
// 2. Registrar os handlers IPC para controle do ciclo de vida do WatcherService.
// 3. Emitir eventos push ao renderer via webContents.send quando arquivos forem detectados pelo watcher.
// 4. Registrar o handler IPC que dispara a geração do Semantic Diff via DiffService.
// 5. Registrar handlers IPC para gerenciamento de arquivos ignorados (temporary/persistent) no diff.
// 6. Validar array vazio no handler git:generate-compression-markdown antes de delegar ao CompressionService.
// 7. Reconciliar ignores temporários usando fs.existsSync (não mais pela lista de modificados).

import { ipcMain } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { GitService } from '../core/git-service'
import { WatcherService } from '../core/watcher-service'
import { DiffService } from '../core/diff-service'
import { SettingsService } from '../core/settings-service'
import { CompressionService } from '../core/compression-service'
import { CodeSourceService } from '../core/code-source-service'
import { RepomixAdapter } from '../core/repomix-adapter'

const gitService = new GitService()
const diffService = new DiffService()
const compressionService = new CompressionService()
const codeSourceService = new CodeSourceService()
const repomixAdapter = new RepomixAdapter()

// Valida se o path recebido via IPC é uma string não vazia
function isValidPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

export function registerGitHandlers(watcherService: WatcherService, settingsService: SettingsService): void {
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
    watcherService.start(dirPath, (filePath) => {
      if (!webContents.isDestroyed()) {
        webContents.send('watcher:file-changed', filePath)
      }
    })
    return { success: true }
  })

  ipcMain.handle('watcher:stop', async () => {
    watcherService.stop()
    return { success: true }
  })

  ipcMain.handle('git:generate-semantic-diff', async (_event, repoPath: string, selectedFiles?: string[]) => {
    if (!isValidPath(repoPath)) return ''
    return diffService.generateSemanticDiff(repoPath, selectedFiles)
  })

  ipcMain.handle('git:get-all-tracked-files', async (_event, dirPath: string) => {
    if (!isValidPath(dirPath)) return []
    return gitService.getAllTrackedFiles(dirPath)
  })

  ipcMain.handle('git:generate-compression-markdown', async (_event, repoPath: string, selectedFiles: string[]) => {
    if (!isValidPath(repoPath) || !Array.isArray(selectedFiles) || selectedFiles.length === 0) return ''
    return compressionService.generateCompressionMarkdown(repoPath, selectedFiles)
  })

  ipcMain.handle('code-source:generate', async (_event, repoPath: string, options?: {
    selectedFiles?: string[]
    format?: 'markdown' | 'xml'
  }) => {
    if (!isValidPath(repoPath)) return { success: false, error: 'Invalid path' }
    return codeSourceService.generateCodeSource(repoPath, options)
  })

  ipcMain.handle('code-source:check-installation', async () => {
    return repomixAdapter.checkInstallation()
  })

  // Adiciona um arquivo à lista de ignorados (temporary ou persistent) para o repositório informado
  ipcMain.handle('git:add-ignored-file', async (_event, repoPath: string, relativePath: string, type: 'temporary' | 'persistent') => {
    if (!isValidPath(repoPath) || !isValidPath(relativePath)) return null
    const settings = settingsService.loadSettings()
    if (!settings.ignoredDiffFiles[repoPath]) {
      settings.ignoredDiffFiles[repoPath] = { temporary: [], persistent: [] }
    }
    const list = settings.ignoredDiffFiles[repoPath][type]
    if (!list.includes(relativePath)) {
      list.push(relativePath)
    }
    settingsService.saveSettings(settings)
    return settings
  })

  // Remove um arquivo da lista de ignorados (temporary ou persistent) para o repositório informado
  ipcMain.handle('git:remove-ignored-file', async (_event, repoPath: string, relativePath: string, type: 'temporary' | 'persistent') => {
    if (!isValidPath(repoPath) || !isValidPath(relativePath)) return null
    const settings = settingsService.loadSettings()
    const repoIgnores = settings.ignoredDiffFiles[repoPath]
    if (repoIgnores) {
      repoIgnores[type] = repoIgnores[type].filter(p => p !== relativePath)
    }
    settingsService.saveSettings(settings)
    return settings
  })

  // Reconciliador: remove da lista temporary apenas arquivos que foram deletados fisicamente do disco.
  // Usa fs.existsSync para verificar a existência real do arquivo, preservando ignores da aba Compression
  // (que lista arquivos "tracked", não apenas "modified").
  ipcMain.handle('git:reconcile-ignored-files', async (_event, repoPath: string, _currentModifiedFiles: string[]) => {
    if (!isValidPath(repoPath)) return null
    const settings = settingsService.loadSettings()
    const repoIgnores = settings.ignoredDiffFiles[repoPath]
    if (repoIgnores) {
      repoIgnores.temporary = repoIgnores.temporary.filter(p => existsSync(join(repoPath, p)))
    }
    settingsService.saveSettings(settings)
    return settings
  })
}
