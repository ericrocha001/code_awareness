// Responsabilidades do Script
//
// 1. Registrar os handlers IPC para carregar, salvar configurações e selecionar o vault do Obsidian.

import { ipcMain, dialog, BrowserWindow } from 'electron'
import { SettingsService } from '../core/settings-service'

export function registerSettingsHandlers(settingsService: SettingsService): void {
  ipcMain.handle('load-settings', async () => {
    return settingsService.loadSettings()
  })

  ipcMain.handle('save-settings', async (_event, settings) => {
    settingsService.saveSettings(settings)
    return { success: true }
  })

  ipcMain.handle('select-vault-folder', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) as BrowserWindow
    const { filePaths, canceled } = await dialog.showOpenDialog(win, {
      title: 'Select Obsidian Vault Folder',
      properties: ['openDirectory']
    })

    if (canceled || !filePaths.length) return null
    return filePaths[0]
  })
}
