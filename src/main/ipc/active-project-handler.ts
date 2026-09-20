import { BrowserWindow, ipcMain } from 'electron'
import type { ActiveProjectService } from '../core/active-project-service'

export function registerActiveProjectHandlers(projects: ActiveProjectService): void {
  ipcMain.handle('project:get-active', () => projects.getState())
  ipcMain.handle('project:activate', async (_event, projectId: unknown) => {
    if (projectId !== null && (typeof projectId !== 'string' || projectId.length === 0)) {
      return { success: false, error: 'Invalid project identity' }
    }
    try {
      return { success: true, data: await projects.activate(projectId) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Project activation failed' }
    }
  })
  projects.onChanged((state) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) continue
      try { window.webContents.send('project:active-changed', state) } catch {}
    }
  })
}
