// Responsabilidades do Script
//
// 1. Registrar os handlers IPC para salvar Markdown localmente e no vault do Obsidian.

import { ipcMain, dialog, BrowserWindow } from 'electron'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { VaultService } from '../core/vault-service'

const vaultService = new VaultService()

export function registerFileHandlers(mainWindow: BrowserWindow): void {
  ipcMain.handle('save-markdown', async (_event, markdown: string, repoName: string) => {
    const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
      title: 'Save Markdown',
      defaultPath: `${repoName}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    })

    if (canceled || !filePath) return { success: false, error: 'Cancelled' }

    try {
      writeFileSync(filePath, markdown, 'utf-8')
      return { success: true }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      return { success: false, error: message }
    }
  })

  ipcMain.handle(
    'save-to-obsidian',
    async (_event, markdown: string, repoName: string, vaultPath: string) => {
      try {
        await vaultService.saveToVault(markdown, repoName, vaultPath)
        return { success: true }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        return { success: false, error: message }
      }
    }
  )
}
