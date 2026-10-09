import { expect, it, vi } from 'vitest'
import { DashService } from '../core/dash/dash-service'
import { fixtureMap, request } from '../core/dash/dash-v2-fixtures'
const { handle } = vi.hoisted(() => ({ handle: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle } }))
import { registerDashHandlers } from './dash-handler'
it('registers only the single v2 operation with real pipeline', async () => {
  registerDashHandlers(new DashService(fixtureMap()))
  expect(handle).toHaveBeenCalledTimes(1)
  expect(handle.mock.calls[0][0]).toBe('dash:execute')
  const result = await handle.mock.calls[0][1]({}, JSON.stringify(request()), 'repo')
  expect(result).toMatchObject({ success: true, context: '[{"name":"SyncService"}]' })
})
