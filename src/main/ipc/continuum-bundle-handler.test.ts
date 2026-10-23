import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { registerContinuumBundleHandlers } from './continuum-bundle-handler'
import type { RepositoryContinuumSession } from '../continuum/project-continuum-session'
const { handlers, save, writeText } = vi.hoisted(() => ({ handlers: new Map<string, Function>(), save: vi.fn(), writeText: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: () => '/downloads' }, BrowserWindow: { fromWebContents: () => ({ isDestroyed: () => false, isVisible: () => true }) }, ipcMain: { handle: (name: string, handler: Function) => handlers.set(name, handler) }, dialog: { showSaveDialog: save }, clipboard: { writeText } }))
let folder: string, current: string, revision: number
const raw = '\uFEFF---\r\nname: Literal\r\ndescription: d\r\nkind: DOCUMENT\r\ntags: [architecture]\r\n---\r\n# body\r\n'
const sender = { id: 1, isDestroyed: () => false, once: vi.fn() }
const service = {
  assertActive: () => { if (current !== 'A') throw new Error('REPOSITORY_CONTEXT_CHANGED') },
  tags: () => [{ slug: 'architecture', name: 'Architecture', description: 'Purpose' }],
  list: () => ({ artifacts: [{ artifactId: 'one' }] }),
  get: () => ({ artifactId: 'one', revision, contentHash: 'hash-' + revision, rawMarkdown: raw, metadata: { name: 'One', kind: 'DOCUMENT', tags: ['architecture'] } })
}
const prepare = (repositoryId = 'A') => handlers.get('continuum:prepare-bundle')!({ sender }, { repositoryId, slug: 'architecture' })
const exportBundle = (snapshotId: string, intent = 'copy') => handlers.get('continuum:export-bundle')!({ sender }, { repositoryId: 'A', snapshotId, intent })
beforeEach(() => {
  vi.clearAllMocks(); current = 'A'; revision = 1; mkdirSync('scratch', { recursive: true }); folder = mkdtempSync(join(process.cwd(), 'scratch', 'bundle-ipc-'))
  registerContinuumBundleHandlers({ getActiveSession: () => ({ repositoryId: current }), getActiveService: () => service } as unknown as RepositoryContinuumSession)
})
afterEach(() => rmSync(folder, { recursive: true, force: true }))
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
