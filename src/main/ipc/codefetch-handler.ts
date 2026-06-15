// Responsabilidades do Script
//
// 1. Registrar os handlers IPC para verificação e execução do Codefetch.

import { ipcMain } from 'electron'
import { CodefetchAdapter } from '../core/codefetch-adapter'

const adapter = new CodefetchAdapter()

export function registerCodefetchHandlers(): void {
  ipcMain.handle('check-codefetch', async () => {
    return adapter.checkInstallation()
  })

  ipcMain.handle('run-codefetch', async (_event, repoPath: string) => {
    return adapter.run(repoPath)
  })
}
