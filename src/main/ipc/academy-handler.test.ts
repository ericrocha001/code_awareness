import { beforeEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'

const { handle, showItemInFolder } = vi.hoisted(() => ({ handle: vi.fn(), showItemInFolder: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle }, shell: { showItemInFolder } }))

import { registerAcademyHandlers } from './academy-handler'

beforeEach(() => handle.mockClear())

it('routes conflict resolution with observation preconditions and rejects malformed identities', async () => {
  const resolveManagedConflict = vi.fn(async () => ({ syncState: 'REMOTE_DIVERGED' }))
  registerAcademyHandlers({ gitSync: { resolveManagedConflict } } as any)
  const handlers = new Map(handle.mock.calls.map(([channel, handler]) => [channel, handler]))
  const resolve = handlers.get('academy:git-resolve-conflict')!
  expect(await resolve({}, 'a'.repeat(40), 'tree')).toEqual({ syncState: 'REMOTE_DIVERGED' })
  expect(resolveManagedConflict).toHaveBeenCalledWith('a'.repeat(40), 'tree')
  await expect(resolve({}, 'invalid', 'tree')).rejects.toThrow('INVALID_ARGUMENT')
  expect(resolveManagedConflict).toHaveBeenCalledTimes(1)
})

it('registers the bounded Academy IPC surface and stamps UI origin server-side', async () => {
  const service = {
    snapshot: vi.fn(), get: vi.fn(), history: vi.fn(), saveNewSkill: vi.fn(async (value) => value), saveSkill: vi.fn(async (value) => value),
    archive: vi.fn(), restore: vi.fn(), setEnabled: vi.fn(), setDestinationEnabled: vi.fn(), import: vi.fn(), resolveConflict: vi.fn(),
    getDistributionHealth: vi.fn(), listDistributionStates: vi.fn(), reconcileDistribution: vi.fn(), getDeliveryStatus: vi.fn(),

    bootstrapOpenAiPlugin: vi.fn(), getOpenAiPublicationState: vi.fn(), listOpenAiReleases: vi.fn(),
    prepareOpenAiRelease: vi.fn(), confirmOpenAiUpload: vi.fn(), downloadOpenAiRelease: vi.fn(), revokeOpenAiUpload: vi.fn(),
    getOpenAiRelease: vi.fn(() => ({ artifactPath: 'C:/release.zip' })),
    getImportConfirmationPreference: vi.fn(() => ({ mode: 'MANUAL', updatedAt: null })),
    setImportConfirmationPreference: vi.fn((mode) => ({ mode, updatedAt: '2026-11-13T00:00:00Z' })),
    getGeminiExportState: vi.fn(() => ({ latestExport: null })),
    setGeminiExportMode: vi.fn((mode) => ({ mode })),
    prepareGeminiExport: vi.fn(async () => ({ exportId: 'g1' })),
    downloadGeminiExport: vi.fn(async () => ({ mode: 'FULL' })),
    confirmGeminiImport: vi.fn(() => ({ mode: 'INCREMENTAL' })),
    revokeGeminiImport: vi.fn(() => ({ mode: 'INCREMENTAL' })),
    establishGeminiBaseline: vi.fn(() => ({ mode: 'INCREMENTAL' })),
    acknowledgeGeminiManualAction: vi.fn(() => ({ mode: 'INCREMENTAL' })),
    getGeminiExportArtifactPath: vi.fn(async () => 'C:/academy-gemini.zip'),
    approvePublicSkills: vi.fn(async () => []), getPublicationPreference: vi.fn(() => ({ autoIncludeGlobal: false, revision: 0, updatedAt: null })),
    setPublicationPreference: vi.fn(async (autoIncludeGlobal, confirmed) => ({ autoIncludeGlobal, revision: confirmed ? 1 : 0, updatedAt: '2026-11-12T00:00:00Z' })),
    store: { listDestinations: vi.fn(() => [{ id: 'repo', path: 'C:/repo' }]) }
  }
  const onImportConfirmationPreferenceChanged = vi.fn()
  registerAcademyHandlers(service as any, onImportConfirmationPreferenceChanged)
  const handlers = new Map(handle.mock.calls.map(([channel, handler]) => [channel, handler]))
  expect([...handlers.keys()]).toEqual(expect.arrayContaining(['academy:snapshot', 'academy:create', 'academy:update', 'academy:import-destination', 'academy:resolve-conflict']))
  expect([...handlers.keys()]).toEqual(expect.arrayContaining(['academy:distribution-health', 'academy:distribution-states', 'academy:distribution-reconcile', 'academy:delivery-status']))
  expect([...handlers.keys()]).toEqual(expect.arrayContaining([
    'academy:openai-state', 'academy:openai-prepare', 'academy:openai-confirm-upload', 'academy:openai-download', 'academy:openai-revoke-upload',
    'academy:openai-reveal', 'academy:approve-public-batch', 'academy:publication-preference', 'academy:publication-preference-set',
    'academy:import-confirmation-preference', 'academy:import-confirmation-preference-set'
  ]))
  expect([...handlers.keys()]).toEqual(expect.arrayContaining([
    'academy:gemini-export-state', 'academy:gemini-export-set-mode', 'academy:gemini-export-prepare', 'academy:gemini-export-download',
    'academy:gemini-export-confirm-import', 'academy:gemini-export-revoke-import', 'academy:gemini-export-establish-baseline',
    'academy:gemini-export-acknowledge-manual', 'academy:gemini-export-reveal'
  ]))
  await handlers.get('academy:create')!({}, { package: { skillMd: 'x', artifacts: {} }, scope: 'GLOBAL' })
  expect(service.saveNewSkill).toHaveBeenCalledWith(expect.objectContaining({ origin: 'UI' }))
  await handlers.get('academy:update')!({}, { skillId: 'id', expectedVersion: 1, package: { skillMd: 'x', artifacts: {} } })
  await handlers.get('academy:set-enabled')!({}, 'id', false, 7)
  expect(service.setEnabled).toHaveBeenCalledWith('id', false, 7)
  expect(service.saveSkill).toHaveBeenCalledWith(expect.objectContaining({ origin: 'UI', expectedVersion: 1 }))
  await handlers.get('academy:import-destination')!({}, 'repo')
  expect(service.import).toHaveBeenCalledWith(join('C:/repo', '.skills'), 'repo')
  await handlers.get('academy:openai-confirm-upload')!({}, 'release', 'hash')
  expect(service.confirmOpenAiUpload).toHaveBeenCalledWith('release', 'hash')
  await handlers.get('academy:openai-download')!({}, 'release')
  expect(service.downloadOpenAiRelease).toHaveBeenCalledWith('release')
  await handlers.get('academy:openai-revoke-upload')!({}, 'release')
  expect(service.revokeOpenAiUpload).toHaveBeenCalledWith('release')
  expect(handlers.get('academy:import-confirmation-preference')!({})).toEqual({ mode: 'MANUAL', updatedAt: null })
  await handlers.get('academy:import-confirmation-preference-set')!({}, 'AUTOMATIC')
  expect(service.setImportConfirmationPreference).toHaveBeenCalledWith('AUTOMATIC')
  expect(onImportConfirmationPreferenceChanged).toHaveBeenCalledWith('AUTOMATIC')
  expect(() => handlers.get('academy:import-confirmation-preference-set')!({}, 'INVALID')).toThrow('INVALID_ARGUMENT')
  await handlers.get('academy:approve-public-batch')!({}, [{ skillId: 's1', expectedVersion: 1 }], true)
  expect(service.approvePublicSkills).toHaveBeenCalledWith([{ skillId: 's1', expectedVersion: 1 }], true)
  expect(handlers.get('academy:publication-preference')!({})).toEqual({ autoIncludeGlobal: false, revision: 0, updatedAt: null })
  await handlers.get('academy:publication-preference-set')!({}, true, true)
  expect(service.setPublicationPreference).toHaveBeenCalledWith(true, true)
  expect(handlers.get('academy:gemini-export-state')!({})).toEqual({ latestExport: null })
  expect(service.getGeminiExportState).toHaveBeenCalled()
  await handlers.get('academy:gemini-export-set-mode')!({}, 'INCREMENTAL')
  expect(service.setGeminiExportMode).toHaveBeenCalledWith('INCREMENTAL')
  expect(() => handlers.get('academy:gemini-export-set-mode')!({}, 'BAD_MODE')).toThrow('INVALID_ARGUMENT')
  await handlers.get('academy:gemini-export-prepare')!({})
  expect(service.prepareGeminiExport).toHaveBeenCalled()
  await handlers.get('academy:gemini-export-download')!({})
  expect(service.downloadGeminiExport).toHaveBeenCalled()
  await handlers.get('academy:gemini-export-confirm-import')!({}, { skillIds: ['s1'] })
  expect(service.confirmGeminiImport).toHaveBeenCalledWith({ skillIds: ['s1'] })
  await handlers.get('academy:gemini-export-revoke-import')!({}, { skillIds: ['s1'] })
  expect(service.revokeGeminiImport).toHaveBeenCalledWith({ skillIds: ['s1'] })
  await handlers.get('academy:gemini-export-establish-baseline')!({}, { skillIds: ['s1'] })
  expect(service.establishGeminiBaseline).toHaveBeenCalledWith({ skillIds: ['s1'] })
  await handlers.get('academy:gemini-export-acknowledge-manual')!({}, 's1')
  expect(service.acknowledgeGeminiManualAction).toHaveBeenCalledWith('s1')
  expect(() => handlers.get('academy:gemini-export-acknowledge-manual')!({}, '')).toThrow('INVALID_ARGUMENT')
})
