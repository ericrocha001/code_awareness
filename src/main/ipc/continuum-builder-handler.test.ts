import { afterEach, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fixture, markdown } from '../continuum/continuum-test-fixtures'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { countCanonicalTokens } from '../core/tokenizer'
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
  const preview = await f.call({ action: 'preview', composition })
  expect(existsSync(join(f.dir, 'context-bundle-results'))).toBe(false)
  expect(preview.markdown).toContain(f.service.get(receipt.artifactId)!.rawMarkdown)
  expect(preview.markdownBytes).toBe(Buffer.byteLength(preview.markdown))
  expect(preview.tokenCount).toBe(countCanonicalTokens(preview.markdown).tokenCount)
  expect(preview).not.toHaveProperty('compression')
  await expect(f.call({ action: 'preview', composition, profile: 'off' })).rejects.toThrow('UNSUPPORTED_BUNDLE_PROFILE')
  await expect(f.call({ action: 'export', composition, intent: 'copy', profile: 'strong' })).rejects.toThrow('UNSUPPORTED_BUNDLE_PROFILE')
  expect((await f.call({ action: 'export', composition, intent: 'copy' })).retained).toBe(true)
  expect(clipboard.writeText).toHaveBeenLastCalledWith(preview.markdown)
  const recent = await f.call({ action: 'recent' })
  expect(recent).toHaveLength(1)
  expect(recent[0]).not.toHaveProperty('compression')
  expect(recent[0].sha256).toBe(createHash('sha256').update(preview.markdown).digest('hex'))
  const legacyBytes = Buffer.from('<!-- PAKT:json -->\n@from json\n[1]{name|active}\nHistórico ç 🚀|false\n<!-- /PAKT -->\n')
  const history = new BundleResultHistory(join(f.dir, 'context-bundle-results'))
  const { id: _id, sha256: _sha, bytes: _bytes, ...metadata } = recent[0]
  const legacy = history.retain(metadata, legacyBytes)
  history.close()
  const db = new Database(join(f.dir, 'context-bundle-results', 'results.sqlite'))
  const row = db.prepare('SELECT metadata_json FROM results WHERE id = ?').get(legacy.id) as { metadata_json: string }
  db.prepare('UPDATE results SET metadata_json = ? WHERE id = ?').run(JSON.stringify({ ...JSON.parse(row.metadata_json), compression: { applied: true, profile: 'strong', originalTokens: 100, outputTokens: 50 } }), legacy.id)
  db.close()
  expect((await f.call({ action: 'recent' }))[0].compression.applied).toBe(true)
  await f.call({ action: 'reuse', id: legacy.id })
  expect(clipboard.writeText).toHaveBeenLastCalledWith(legacyBytes.toString())
  f.service.update(receipt.artifactId, 1, f.service.get(receipt.artifactId)!.rawMarkdown + '\nChanged')
  const get = vi.spyOn(f.service, 'get')
  expect((await f.call({ action: 'reuse', id: recent[0].id })).historicalAt).toBe(recent[0].generatedAt)
  expect(clipboard.writeText).toHaveBeenLastCalledWith(preview.markdown)
  expect(get).not.toHaveBeenCalled()
  await expect(f.call({ action: 'export', composition, intent: 'copy' })).rejects.toThrow(/REVISION_CONFLICT|STALE/)
  const next = await f.call({ action: 'restore', id: recent[0].id, mode: 'members' })
  expect(next.components[0].members[0].revision).toBe(2)
  expect(await f.call({ action: 'recent' })).toHaveLength(2)
  await f.call({ action: 'export', composition: next, intent: 'copy' })
  expect(await f.call({ action: 'recent' })).toHaveLength(3)
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
