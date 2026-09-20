import { BrowserWindow, ipcMain } from 'electron'
import type { ChatGptIntegrationProjection } from '../integrations/chatgpt-integration-projection'

export function registerChatGptIntegrationHandlers(projection: ChatGptIntegrationProjection): void {
  ipcMain.handle('integration:chatgpt:get-state', (_event, ...args: unknown[]) => {
    if (args.length) throw new Error('INVALID_ARGUMENTS')
    return projection.getState()
  })
  projection.onChanged((state) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) continue
      try { window.webContents.send('integration:chatgpt:changed', state) } catch {}
    }
  })
}
