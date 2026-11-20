import { ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import type { DevSyncService } from '../dev-sync/dev-sync-service'
import type { DevSyncAvailability, DevSyncResult } from '../dev-sync/dev-sync-types'
import type { RuntimeIdentityProvider } from '../runtime-identity/runtime-identity-provider'

export function registerDevSyncHandlers(
  devSyncService: DevSyncService,
  runtimeIdentity: RuntimeIdentityProvider
): void {
  ipcMain.handle('devsync:get-status', async (): Promise<DevSyncAvailability> => {
    return devSyncService.getAvailability()
  })

  ipcMain.handle('devsync:request-sync', async (): Promise<DevSyncResult> => {
    const expectedInstanceId = runtimeIdentity.getInstanceId()
    const operationId = `ui-sync-${randomUUID()}`
    const result = await devSyncService.executeDevSync({
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
          console.error('[DevSync IPC] postResponse failed:', err)
        }
      })
    }

    // Omit postResponse function from IPC serialization
    const { postResponse, ...serializable } = result
    return serializable
  })
}
