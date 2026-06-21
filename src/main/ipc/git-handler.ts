// Responsabilidades do Script
//
// 1. Registrar os handlers IPC para verificação de repositório Git e listagem de arquivos modificados.
// 2. Registrar os handlers IPC para controle do ciclo de vida do WatcherService.
// 3. Emitir eventos push ao renderer via webContents.send quando arquivos forem detectados pelo watcher.
// 4. Registrar o handler IPC que dispara a geração do Semantic Diff via DiffService.

import { ipcMain } from 'electron'
import { GitService } from '../core/git-service'
import { WatcherService } from '../core/watcher-service'
import { DiffService } from '../core/diff-service'

const gitService = new GitService()
const diffService = new DiffService()

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

  ipcMain.handle('git:generate-semantic-diff', async (_event, repoPath: string) => {
    if (!isValidPath(repoPath)) return ''
    return diffService.generateSemanticDiff(repoPath)
  })
}
