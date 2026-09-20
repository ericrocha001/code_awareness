import { BrowserWindow, ipcMain } from 'electron'
import type { SystemHealthCore } from '../system-health/system-health-core'

export function registerSystemHealthHandlers(core: SystemHealthCore): void {
  ipcMain.handle('system-health:get-state', (_event, ...args: unknown[]) => {
    if (args.length) throw new Error('INVALID_ARGUMENTS')
    return core.getState()
  })
  ipcMain.handle('system-health:get-diagnostic-report', (_event, ...args: unknown[]) => {
    if (args.length) throw new Error('INVALID_ARGUMENTS')
    return core.getDiagnosticReport()
  })
  core.onChanged((state) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) continue
      try { window.webContents.send('system-health:changed', state) } catch {}
    }
  })
}
