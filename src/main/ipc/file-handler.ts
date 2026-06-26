// Responsabilidades do Script
//
// 1. Registrar os handlers IPC para salvar Markdown localmente e no vault do Obsidian.
// 2. Registrar o handler IPC para selecionar uma pasta de repositório via diálogo nativo do Electron.

import { ipcMain, dialog, BrowserWindow } from 'electron'
import { writeFileSync } from 'fs'
import { basename } from 'path'
import { VaultService } from '../core/vault-service'

const vaultService = new VaultService()

export function registerFileHandlers(): void {
  ipcMain.handle('save-markdown', async (event, markdown: string, repoName: string) => {
    const win = BrowserWindow.fromWebContents(event.sender) as BrowserWindow
    const { filePath, canceled } = await dialog.showSaveDialog(win, {
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

  ipcMain.handle('save-xml', async (event, xml: string, repoName: string) => {
    const win = BrowserWindow.fromWebContents(event.sender) as BrowserWindow
    const { filePath, canceled } = await dialog.showSaveDialog(win, {
      title: 'Save XML',
      defaultPath: `${repoName}.xml`,
      filters: [{ name: 'XML', extensions: ['xml'] }]
    })

    if (canceled || !filePath) return { success: false, error: 'Cancelled' }

    try {
      writeFileSync(filePath, xml, 'utf-8')
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

  ipcMain.handle('select-folder', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) as BrowserWindow
    const { filePaths, canceled } = await dialog.showOpenDialog(win, {
      title: 'Select Repository Folder',
      properties: ['openDirectory']
    })

    if (canceled || !filePaths.length) return null
    const path = filePaths[0]
    return {
      path,
      name: basename(path)
    }
  })
}
