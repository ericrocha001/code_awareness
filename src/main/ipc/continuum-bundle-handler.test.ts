import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { registerContinuumBundleHandlers } from './continuum-bundle-handler'
import type { RepositoryContinuumSession } from '../continuum/project-continuum-session'
const { handlers, save, writeText } = vi.hoisted(() => ({ handlers: new Map<string, Function>(), save: vi.fn(), writeText: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: () => '/downloads' }, BrowserWindow: { fromWebContents: () => ({ isDestroyed: () => false, isVisible: () => true }) }, ipcMain: { handle: (name: string, handler: Function) => handlers.set(name, handler) }, dialog: { showSaveDialog: save }, clipboard: { writeText } }))
let folder: string, current: string, revision: number
const raw = '\uFEFF---\r\nname: Literal\r\ndescription: d\r\nkind: DOCUMENT\r\ntags: [architecture]\r\n---\r\n# body\r\n'
const sender = { id: 1, isDestroyed: () => false, once: vi.fn() }
const service = {
  assertActive: () => { if (current !== 'A') throw new Error('REPOSITORY_CONTEXT_CHANGED') },
  assertRepository: (repositoryId: string) => { if (current !== 'A' || repositoryId !== 'A') throw new Error('REPOSITORY_CONTEXT_CHANGED') },
  assertSelection: (selected: { artifactId: string; expectedRevision: number }[]) => { if (!selected.length || selected.some(item => item.artifactId !== 'one' || item.expectedRevision !== revision)) throw new Error('REVISION_CONFLICT') },
  tags: () => [{ slug: 'architecture', name: 'Architecture', description: '' }],
  list: () => ({ artifacts: [{ artifactId: 'one' }] }),
  get: () => ({ artifactId: 'one', revision, contentHash: createHash('sha256').update(raw).digest('hex'), rawMarkdown: raw, metadata: { name: 'One', kind: 'DOCUMENT', tags: ['architecture'] } })
}
const prepare = (repositoryId = 'A') => handlers.get('continuum:prepare-bundle')!({ sender }, { repositoryId, slug: 'architecture' })
const exportBundle = (snapshotId: string, intent = 'copy') => handlers.get('continuum:export-bundle')!({ sender }, { repositoryId: 'A', snapshotId, intent })
beforeEach(() => {
  vi.clearAllMocks(); current = 'A'; revision = 1; mkdirSync('scratch', { recursive: true }); folder = mkdtempSync(join(process.cwd(), 'scratch', 'bundle-ipc-'))
  registerContinuumBundleHandlers({ getActiveSession: () => ({ repositoryId: current }), getActiveService: () => service } as unknown as RepositoryContinuumSession)
})
afterEach(() => rmSync(folder, { recursive: true, force: true }))
it('exports explicit selections and invalidates their snapshot on composer close without touching clipboard', async () => {
  const preview = handlers.get('continuum:prepare-bundle')!({ sender }, { repositoryId: 'A', source: { kind: 'selection', selected: [{ artifactId: 'one', expectedRevision: 1 }] } })
  await exportBundle(preview.snapshotId)
  expect(writeText).toHaveBeenCalledWith(preview.markdown)
  handlers.get('continuum:discard-bundle')!({ sender }, preview.snapshotId)
  writeText.mockClear()
  await expect(exportBundle(preview.snapshotId)).rejects.toThrow(/BUNDLE_SNAPSHOT_UNAVAILABLE/)
  expect(writeText).not.toHaveBeenCalled()
  const fresh = handlers.get('continuum:prepare-bundle')!({ sender }, { repositoryId: 'A', source: { kind: 'selection', selected: [{ artifactId: 'one', expectedRevision: 1 }] } })
  revision++
  await expect(exportBundle(fresh.snapshotId)).rejects.toThrow(/REVISION_CONFLICT/)
  expect(writeText).not.toHaveBeenCalled()
})
it('aborts a save waiting in the native dialog if its composer snapshot is discarded', async () => {
  const preview = prepare()
  let finish!: (value: object) => void
  save.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const pending = exportBundle(preview.snapshotId, 'zip')
  handlers.get('continuum:discard-bundle')!({ sender }, preview.snapshotId)
  finish({ canceled: false, filePath: join(folder, 'closed.zip') })
  await expect(pending).rejects.toThrow(/BUNDLE_SNAPSHOT_UNAVAILABLE/)
  expect(readdirSync(folder)).toEqual([])
  expect(writeText).not.toHaveBeenCalled()
})
it('copies and saves the exact same prepared composition and refuses wrong repository or sender/snapshot identity', async () => {
  expect(() => prepare('B')).toThrow('REPOSITORY_UNAVAILABLE')
  const preview = prepare()
  await exportBundle(preview.snapshotId)
  expect(writeText).toHaveBeenCalledWith(preview.markdown)
  expect(preview.markdown).toContain(raw)
  save.mockResolvedValue({ canceled: false, filePath: join(folder, 'context.md') })
  await exportBundle(preview.snapshotId, 'markdown')
  expect(readFileSync(join(folder, 'context.md'), 'utf8')).toBe(preview.markdown)
  expect(save.mock.calls[0][1].defaultPath).toBe(join('/downloads', 'architecture-context.md'))
  await expect(exportBundle('forged')).rejects.toThrow('BUNDLE_SNAPSHOT_UNAVAILABLE')
})
it('rejects revision/context changes after native dialog, cancels safely and leaves no partial file', async () => {
  const preview = prepare()
  save.mockResolvedValueOnce({ canceled: true })
  expect(await exportBundle(preview.snapshotId, 'markdown')).toMatchObject({ outcome: 'cancelled' })
  let finish!: (value: object) => void
  save.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const pending = exportBundle(preview.snapshotId, 'markdown')
  await expect(exportBundle(preview.snapshotId)).rejects.toThrow('BUNDLE_BUSY')
  revision++; finish({ canceled: false, filePath: join(folder, 'stale.md') })
  await expect(pending).rejects.toThrow('BUNDLE_SNAPSHOT_STALE')
  const next = prepare(), switched = exportBundle(next.snapshotId, 'markdown')
  current = 'B'; finish({ canceled: false, filePath: join(folder, 'other.md') })
  await expect(switched).rejects.toThrow('REPOSITORY_CONTEXT_CHANGED')
  expect(readdirSync(folder)).toEqual([])
})
it('saves a valid ZIP container and leaves no partial output on cancellation, extension and write failures', async () => {
  const preview = prepare()
  save.mockResolvedValueOnce({ canceled: true })
  expect(await exportBundle(preview.snapshotId, 'zip')).toMatchObject({ outcome: 'cancelled' })
  expect(readdirSync(folder)).toEqual([])
  save.mockResolvedValueOnce({ canceled: false, filePath: join(folder, 'context.zip') })
  await exportBundle(preview.snapshotId, 'zip')
  expect(readFileSync(join(folder, 'context.zip')).readUInt32LE(0)).toBe(0x04034b50)
  save.mockResolvedValueOnce({ canceled: false, filePath: join(folder, 'wrong.txt') })
  await expect(exportBundle(preview.snapshotId, 'zip')).rejects.toThrow('INVALID_EXPORT_EXTENSION')
  save.mockResolvedValueOnce({ canceled: false, filePath: join(folder, 'absent', 'missing.zip') })
  await expect(exportBundle(preview.snapshotId, 'zip')).rejects.toThrow()
  expect(readdirSync(folder)).toEqual(['context.zip'])
})
it('prepares and copies current membership in one call with a compact receipt and no snapshot sharing', async () => {
  const receipt = await handlers.get('continuum:quick-bundle')!({ sender }, { repositoryId: 'A', slug: 'architecture', intent: 'copy' })
  expect(receipt).toMatchObject({ repositoryId: 'A', slug: 'architecture', count: 1, outcome: 'copied', hasVisuals: false })
  expect(receipt).not.toHaveProperty('markdown')
  expect(writeText.mock.calls[0][0]).toContain(raw)
  await expect(exportBundle(receipt.snapshotId)).rejects.toThrow('BUNDLE_SNAPSHOT_UNAVAILABLE')
  revision++
  const next = await handlers.get('continuum:quick-bundle')!({ sender }, { repositoryId: 'A', slug: 'architecture', intent: 'copy' })
  expect(next.snapshotId).not.toBe(receipt.snapshotId)
  expect(writeText.mock.calls[1][0]).toContain('revisão 2')
})
