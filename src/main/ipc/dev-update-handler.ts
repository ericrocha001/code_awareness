import { ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import type { DevUpdateService } from '../dev-update/dev-update-service'
import type { DevUpdateAvailability, DevUpdateResult } from '../dev-update/dev-update-types'
import type { RuntimeIdentityProvider } from '../runtime-identity/runtime-identity-provider'

export function registerDevUpdateHandlers(
  devUpdateService: DevUpdateService,
  runtimeIdentity: RuntimeIdentityProvider
): void {
  ipcMain.handle('devupdate:get-status', async (): Promise<DevUpdateAvailability> => {
    return devUpdateService.getAvailability()
  })

  ipcMain.handle('devupdate:request-update', async (): Promise<DevUpdateResult> => {
    const expectedInstanceId = runtimeIdentity.getInstanceId()
    const operationId = `ui-update-${randomUUID()}`
    const result = await devUpdateService.executeDevUpdate({
      operationId,
      expectedInstanceId,
      caller: 'UI'
    })

    if (result.postResponse) {
      // Execute postResponse shortly after returning response to renderer
      setImmediate(async () => {
        try {
          await result.postResponse?.()
        } catch (err) {
          console.error('[DevUpdate IPC] postResponse failed:', err)
        }
      })
    }

    // Omit postResponse function from IPC serialization
    const { postResponse, ...serializable } = result
    return serializable
  })
}
