import { describe, expect, it, vi, beforeEach } from 'vitest'
import { registerDevUpdateHandlers } from './dev-update-handler'
import type { DevUpdateService } from '../dev-update/dev-update-service'
import type { RuntimeIdentityProvider } from '../runtime-identity/runtime-identity-provider'

const handlers = new Map<string, (...args: any[]) => Promise<any>>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: any[]) => Promise<any>) => {
      handlers.set(channel, handler)
    }
  }
}))

describe('registerDevUpdateHandlers', () => {
  beforeEach(() => {
    handlers.clear()
  })

  it('registers devupdate:get-status and devupdate:request-update channels', async () => {
    const mockService = {
      getAvailability: vi.fn(async () => ({ available: true, supervisorConnected: true })),
      executeDevUpdate: vi.fn(async () => ({
        operationId: 'op-ui',
        status: 'SCHEDULED' as const,
        head: 'target-head',
        message: 'DevUpdate agendado',
        postResponse: vi.fn(async () => {})
      }))
    } as unknown as DevUpdateService

    const mockIdentity = {
      getInstanceId: () => 'inst-ui-1'
    } as unknown as RuntimeIdentityProvider

    registerDevUpdateHandlers(mockService, mockIdentity)

    expect(handlers.has('devupdate:get-status')).toBe(true)
    expect(handlers.has('devupdate:request-update')).toBe(true)

    const status = await handlers.get('devupdate:get-status')!()
    expect(status.available).toBe(true)

    const result = await handlers.get('devupdate:request-update')!()
    expect(result.status).toBe('SCHEDULED')
    expect(result.head).toBe('target-head')
    // postResponse should be omitted from IPC serialization
    expect((result as any).postResponse).toBeUndefined()
  })
})
