import { ipcMain } from 'electron'
import type { DashService } from '../core/dash/dash-service'

export function registerDashHandlers(service: DashService): void {
  ipcMain.handle('dash:execute', (_event, input: string, repoPath: string) => {
    if (typeof repoPath !== 'string' || !repoPath.trim())
      return {
        success: false,
        report: { steps: [], error: { code: 'NOT_FOUND', message: 'Selecione um projeto.' } }
      }
    return service.execute(input, repoPath)
  })
}
