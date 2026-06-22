// Responsabilidades do Script
//
// 1. Registrar os handlers IPC para verificação de repositório Git e listagem de arquivos modificados.
// 2. Registrar os handlers IPC para controle do ciclo de vida do WatcherService.
// 3. Emitir eventos push ao renderer via webContents.send quando arquivos forem detectados pelo watcher.
// 4. Registrar o handler IPC que dispara a geração do Semantic Diff via DiffService.
// 5. Registrar handlers IPC para gerenciamento de arquivos ignorados (temporary/persistent) no diff.

import { ipcMain } from 'electron'
import { GitService } from '../core/git-service'
import { WatcherService } from '../core/watcher-service'
import { DiffService } from '../core/diff-service'
import { SettingsService } from '../core/settings-service'

const gitService = new GitService()
const diffService = new DiffService()
const settingsService = new SettingsService()

// Valida se o path recebido via IPC é uma string não vazia
function isValidPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

export function registerGitHandlers(watcherService: WatcherService): void {
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

  // Reconciliador: remove da lista temporary arquivos que não estão mais na lista de modificados
  ipcMain.handle('git:reconcile-ignored-files', async (_event, repoPath: string, currentModifiedFiles: string[]) => {
    if (!isValidPath(repoPath)) return null
    const settings = settingsService.loadSettings()
    const repoIgnores = settings.ignoredDiffFiles[repoPath]
    if (repoIgnores) {
      const currentSet = new Set(currentModifiedFiles)
      repoIgnores.temporary = repoIgnores.temporary.filter(p => currentSet.has(p))
    }
    settingsService.saveSettings(settings)
    return settings
  })
}
