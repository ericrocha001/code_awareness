import { beforeEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'

const { handle, showItemInFolder } = vi.hoisted(() => ({ handle: vi.fn(), showItemInFolder: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle }, shell: { showItemInFolder } }))

import { registerAcademyHandlers } from './academy-handler'

beforeEach(() => handle.mockClear())

it('registers the bounded Academy IPC surface and stamps UI origin server-side', async () => {
  const service = {
    snapshot: vi.fn(), get: vi.fn(), history: vi.fn(), create: vi.fn(async (value) => value), update: vi.fn(async (value) => value),
    archive: vi.fn(), restore: vi.fn(), setDestinationEnabled: vi.fn(), import: vi.fn(), resolveConflict: vi.fn(),
    getDistributionHealth: vi.fn(), listDistributionStates: vi.fn(), reconcileDistribution: vi.fn(),
    bootstrapOpenAiPlugin: vi.fn(), getOpenAiPublicationState: vi.fn(), listOpenAiReleases: vi.fn(),
    prepareOpenAiRelease: vi.fn(), confirmOpenAiUpload: vi.fn(), getOpenAiRelease: vi.fn(() => ({ artifactPath: 'C:/release.zip' })),
    store: { listDestinations: vi.fn(() => [{ id: 'repo', path: 'C:/repo' }]) }
  }
  registerAcademyHandlers(service as any)
  const handlers = new Map(handle.mock.calls.map(([channel, handler]) => [channel, handler]))
  expect([...handlers.keys()]).toEqual(expect.arrayContaining(['academy:snapshot', 'academy:create', 'academy:update', 'academy:import-destination', 'academy:resolve-conflict']))
  expect([...handlers.keys()]).toEqual(expect.arrayContaining(['academy:distribution-health', 'academy:distribution-states', 'academy:distribution-reconcile']))
  expect([...handlers.keys()]).toEqual(expect.arrayContaining(['academy:openai-state', 'academy:openai-prepare', 'academy:openai-confirm-upload', 'academy:openai-reveal']))
  await handlers.get('academy:create')!({}, { package: { skillMd: 'x', artifacts: {} }, scope: 'GLOBAL' })
  expect(service.create).toHaveBeenCalledWith(expect.objectContaining({ origin: 'UI' }))
  await handlers.get('academy:update')!({}, { skillId: 'id', expectedVersion: 1, package: { skillMd: 'x', artifacts: {} } })
  expect(service.update).toHaveBeenCalledWith(expect.objectContaining({ origin: 'UI', expectedVersion: 1 }))
  await handlers.get('academy:import-destination')!({}, 'repo')
  expect(service.import).toHaveBeenCalledWith(join('C:/repo', '.skills'), 'repo')
  await handlers.get('academy:openai-confirm-upload')!({}, 'release', 'hash')
  expect(service.confirmOpenAiUpload).toHaveBeenCalledWith('release', 'hash')
})
