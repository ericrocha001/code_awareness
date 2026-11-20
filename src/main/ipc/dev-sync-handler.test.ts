import { describe, expect, it, vi, beforeEach } from 'vitest'
import { registerDevSyncHandlers } from './dev-sync-handler'
import type { DevSyncService } from '../dev-sync/dev-sync-service'
import type { RuntimeIdentityProvider } from '../runtime-identity/runtime-identity-provider'

const handlers = new Map<string, (...args: any[]) => Promise<any>>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: any[]) => Promise<any>) => {
      handlers.set(channel, handler)
    }
  }
}))

describe('registerDevSyncHandlers', () => {
  beforeEach(() => {
    handlers.clear()
  })

  it('registers devsync:get-status and devsync:request-sync channels', async () => {
    const mockService = {
      getAvailability: vi.fn(async () => ({ available: true, supervisorConnected: true })),
      executeDevSync: vi.fn(async () => ({
        operationId: 'op-ui',
        status: 'SCHEDULED' as const,
        head: 'target-head',
        message: 'DevSync agendado',
        postResponse: vi.fn(async () => {})
      }))
    } as unknown as DevSyncService

    const mockIdentity = {
      getInstanceId: () => 'inst-ui-1'
    } as unknown as RuntimeIdentityProvider

    registerDevSyncHandlers(mockService, mockIdentity)

    expect(handlers.has('devsync:get-status')).toBe(true)
    expect(handlers.has('devsync:request-sync')).toBe(true)

    const status = await handlers.get('devsync:get-status')!()
    expect(status.available).toBe(true)

    const result = await handlers.get('devsync:request-sync')!()
    expect(result.status).toBe('SCHEDULED')
    expect(result.head).toBe('target-head')
    // postResponse should be omitted from IPC serialization
    expect((result as any).postResponse).toBeUndefined()
  })
})
