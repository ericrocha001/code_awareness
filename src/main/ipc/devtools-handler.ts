/*
-T ---
*/

import { ipcMain, BrowserWindow } from 'electron'
import { DevToolsManager } from '../core/devtools-manager'

export function registerDevToolsHandlers(mainWindow: BrowserWindow): void {
  ipcMain.handle('devtools:toggle', () => {
    // Guarda de segurança contra acesso a janela destruída
    if (!mainWindow || mainWindow.isDestroyed()) {
      return { success: false }
    }
    DevToolsManager.toggle(mainWindow)
    return { success: true }
  })
}
