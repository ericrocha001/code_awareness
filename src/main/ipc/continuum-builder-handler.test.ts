import { afterEach, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fixture, markdown } from '../continuum/continuum-test-fixtures'
import { ContextBundle } from '../continuum/context-bundle'
import { BundleResultHistory } from '../continuum/bundle-result-history'
import { registerContinuumBuilderHandlers } from './continuum-builder-handler'
import type { RepositoryContinuumSession } from '../continuum/project-continuum-session'
import type { BuilderRequest, BundleComponent, BundleComposition } from '../../shared/types/continuum-builder-types'
const { handlers, clipboard } = vi.hoisted(() => ({ handlers: new Map<string, Function>(), clipboard: { writeText: vi.fn() } }))
vi.mock('electron', () => ({ ipcMain: { handle: (key: string, handler: Function) => handlers.set(key, handler) }, clipboard, BrowserWindow: { fromWebContents: () => null } }))
const cleanups: Array<() => void> = []
afterEach(() => { cleanups.splice(0).reverse().forEach(close => close()); vi.restoreAllMocks(); vi.clearAllMocks() })
function setup() {
  const f = fixture(); cleanups.push(f.close)
  let active: typeof f.service | null = f.service
  registerContinuumBuilderHandlers({ getActiveService: () => active, getActiveSession: () => ({ repositoryId: 'catalog-A' }), getStorageBaseDir: () => f.dir, onChanged: () => () => {} } as unknown as RepositoryContinuumSession)
  const sender = { id: Math.random(), isDestroyed: () => false, once: vi.fn() }
  const call = (request: Omit<BuilderRequest, 'repositoryId'> | object) => handlers.get('continuum:builder')!({ sender }, { repositoryId: 'catalog-A', ...request })
  return { ...f, call, switchRepository: () => { active = null } }
}
it('previews ephemerally, exports and reuses exact historical bytes after revisions change without invoking compressor or mounter', async () => {
  const f = setup(), receipt = f.service.publishHuman(markdown('One'))
  const component = await f.call({ action: 'resolve', source: { kind: 'artifact', selected: [{ artifactId: receipt.artifactId, expectedRevision: 1 }] } }) as BundleComponent
  const composition: BundleComposition = { repositoryId: 'catalog-A', components: [component], excluded: [], order: [] }
  const preview = await f.call({ action: 'preview', composition, profile: 'strong' })
  expect(existsSync(join(f.dir, 'context-bundle-results'))).toBe(false)
  expect((await f.call({ action: 'export', composition, intent: 'copy', profile: 'strong' })).retained).toBe(true)
  expect(clipboard.writeText).toHaveBeenLastCalledWith(preview.markdown)
  const recent = await f.call({ action: 'recent' })
  expect(recent).toHaveLength(1)
  f.service.update(receipt.artifactId, 1, f.service.get(receipt.artifactId)!.rawMarkdown + '\nChanged')
  const compress = vi.spyOn(ContextBundle.prototype, 'compressOutput'), get = vi.spyOn(f.service, 'get')
  expect((await f.call({ action: 'reuse', id: recent[0].id })).historicalAt).toBe(recent[0].generatedAt)
  expect(clipboard.writeText).toHaveBeenLastCalledWith(preview.markdown)
  expect(compress).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled()
  await expect(f.call({ action: 'export', composition, intent: 'copy', profile: 'strong' })).rejects.toThrow(/REVISION_CONFLICT|STALE/)
  const next = await f.call({ action: 'restore', id: recent[0].id, mode: 'members' })
  expect(next.components[0].members[0].revision).toBe(2)
  expect(await f.call({ action: 'recent' })).toHaveLength(1)
  await f.call({ action: 'export', composition: next, intent: 'copy' })
  expect(await f.call({ action: 'recent' })).toHaveLength(2)
})
it('keeps successful export successful when history storage fails and aborts on repository switches', async () => {
  const f = setup(), receipt = f.service.publishHuman(markdown('One'))
  const component = await f.call({ action: 'resolve', source: { kind: 'artifact', selected: [{ artifactId: receipt.artifactId, expectedRevision: 1 }] } })
  const composition = { repositoryId: 'catalog-A', components: [component], excluded: [], order: [] }
  vi.spyOn(BundleResultHistory.prototype, 'retain').mockImplementation(() => { throw new Error('DISK_FULL') })
  expect(await f.call({ action: 'export', composition, intent: 'copy' })).toMatchObject({ outcome: 'copied', retained: false, retentionMessage: expect.stringContaining('DISK_FULL') })
  const resolve = vi.spyOn(f.service, 'resolveBuilderComponent').mockImplementation(async () => { f.switchRepository(); return component })
  await expect(f.call({ action: 'resolve', source: component.source })).rejects.toThrow('CONTEXT_CHANGED')
  expect(resolve).toHaveBeenCalledOnce()
})
it('cancels pending composition, rejects overlapping requests and releases the sender for new work', async () => {
  const f = setup(), receipt = f.service.publishHuman(markdown('One'))
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const real = f.service.resolveBuilderComponent.bind(f.service)
  vi.spyOn(f.service, 'resolveBuilderComponent').mockImplementationOnce(async (...args) => { await gate; return real(...args) })
  const source = { kind: 'artifact', selected: [{ artifactId: receipt.artifactId, expectedRevision: 1 }] }
  const pending = f.call({ action: 'resolve', source })
  await expect(f.call({ action: 'resolve', source })).rejects.toThrow('BUNDLE_BUSY')
  await f.call({ action: 'cancel' }); release()
  await expect(pending).rejects.toThrow('BUNDLE_CANCELLED')
  expect(clipboard.writeText).not.toHaveBeenCalled()
  expect((await f.call({ action: 'resolve', source })).members).toHaveLength(1)
})
