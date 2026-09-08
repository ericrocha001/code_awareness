/*
-T ---
*/

import { BrowserWindow, globalShortcut } from 'electron'

export class DevToolsManager {
  static toggle(mainWindow: BrowserWindow): void {
    if (mainWindow.webContents.isDevToolsOpened()) {
      mainWindow.webContents.closeDevTools()
    } else {
      mainWindow.webContents.openDevTools({ mode: 'right' })
    }
  }

  static registerShortcuts(mainWindow: BrowserWindow): void {
    // Atalho F12 — compatibilidade com navegadores
    globalShortcut.register('F12', () => {
      // Guarda de segurança contra acesso a janela destruída
      if (mainWindow && !mainWindow.isDestroyed()) {
        this.toggle(mainWindow)
      }
    })
    // Atalho Ctrl+Shift+I — atalho padrão do Electron/Chrome DevTools
    globalShortcut.register('CommandOrControl+Shift+I', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        this.toggle(mainWindow)
      }
    })
  }

  static unregisterShortcuts(): void {
    globalShortcut.unregister('F12')
    globalShortcut.unregister('CommandOrControl+Shift+I')
  }
}