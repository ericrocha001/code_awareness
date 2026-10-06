import { BrowserWindow, ipcMain } from 'electron'
import type { ChannelStateProjection } from '../integrations/channel-state-projection'

export function registerChannelHandlers(projection: ChannelStateProjection): void {
  ipcMain.handle('channel:get-state', (_event, ...args: unknown[]) => {
    if (args.length) throw new Error('INVALID_ARGUMENTS')
    return projection.getState()
  })
  projection.onChanged((state) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) continue
      try { window.webContents.send('channel:changed', state) } catch {}
    }
  })
}
