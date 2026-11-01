import { ipcMain, type BrowserWindow } from 'electron'
import type { CliTrustPolicy } from '../cli-execution/cli-trust-policy'
import type { CliExecutionService } from '../cli-execution/cli-execution-service'
import type { CliMode } from '../../shared/types/cli-policy-types'

export function registerCliPolicyHandlers(policy: CliTrustPolicy, getWindow: () => BrowserWindow | null, getService: () => CliExecutionService | null): void {
  const local = (event: Electron.IpcMainInvokeEvent) => {
    const window = getWindow()
    if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('LOCAL_OPERATOR_REQUIRED')
  }
  ipcMain.handle('cli:choose-mode', async (event, mode: CliMode) => { local(event); return { accepted: await policy.choose(mode) } })
  ipcMain.handle('cli:stop', async event => {
    local(event)
    const service = getService(), operationId = service?.getActiveOperationId()
    if (service && operationId) await service.cancel({ operationId })
    return { stopped: !service?.getActiveOperationId() }
  })
}
