import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { registerContinuumBundleHandlers } from './continuum-bundle-handler'
import type { RepositoryContinuumSession } from '../continuum/project-continuum-session'

const { handlers, writeText } = vi.hoisted(() => ({ handlers: new Map<string, Function>(), writeText: vi.fn() }))
vi.mock('electron', () => ({
  app: { getPath: () => folder },
  ipcMain: { handle: (name: string, handler: Function) => handlers.set(name, handler) },
  clipboard: { writeText }
}))

let folder: string, current: string, revision: number
const raw = '\uFEFF---\r\nname: Literal\r\ndescription: d\r\nkind: DOCUMENT\r\ntags: [architecture]\r\n---\r\n# body\r\n'
const sender = { id: 1, isDestroyed: () => false, once: vi.fn() }

const service = {
  assertActive: () => { if (current !== 'A') throw new Error('REPOSITORY_CONTEXT_CHANGED') },
  assertRepository: (repositoryId: string) => { if (current !== 'A' || repositoryId !== 'A') throw new Error('REPOSITORY_CONTEXT_CHANGED') },
  assertSelection: (selected: { artifactId: string; expectedRevision: number }[]) => {
    if (!selected.length || selected.some(item => item.artifactId !== 'one' || item.expectedRevision !== revision)) {
      throw new Error('REVISION_CONFLICT')
    }
  },
  tags: () => [{ slug: 'architecture', name: 'Architecture', description: '' }],
  list: () => ({ artifacts: [{ artifactId: 'one' }] }),
  get: () => ({ artifactId: 'one', revision, contentHash: createHash('sha256').update(raw).digest('hex'), rawMarkdown: raw, metadata: { name: 'One', kind: 'DOCUMENT', tags: ['architecture'] } })
}

const quickBundle = (request: object) => handlers.get('continuum:quick-bundle')!({ sender }, request)

beforeEach(() => {
  vi.clearAllMocks()
  current = 'A'
  revision = 1
  mkdirSync('scratch', { recursive: true })
  folder = mkdtempSync(join(process.cwd(), 'scratch', 'bundle-ipc-'))
  registerContinuumBundleHandlers({ getActiveSession: () => ({ repositoryId: current }), getActiveService: () => service } as unknown as RepositoryContinuumSession)
})
afterEach(() => rmSync(folder, { recursive: true, force: true }))

it('only registers continuum:quick-bundle — no prepare/discard/export handlers', () => {
  expect([...handlers.keys()]).toEqual(['continuum:quick-bundle'])
})

it('copies by tag slug and returns compact receipt without markdown property', async () => {
  const receipt = await quickBundle({ repositoryId: 'A', slug: 'architecture', intent: 'copy' })
  expect(receipt).toMatchObject({ repositoryId: 'A', slug: 'architecture', count: 1, outcome: 'copied', hasVisuals: false })
  expect(receipt).not.toHaveProperty('markdown')
  expect(writeText.mock.calls[0][0]).toContain(raw)
})

it('copies by explicit selection with expectedRevision', async () => {
  const receipt = await quickBundle({ repositoryId: 'A', selected: [{ artifactId: 'one', expectedRevision: 1 }], intent: 'copy' })
  expect(receipt).toMatchObject({ repositoryId: 'A', count: 1, outcome: 'copied', hasVisuals: false })
  expect(writeText.mock.calls[0][0]).toContain(raw)
})

it('rejects mismatched expectedRevision', async () => {
  revision = 2
  await expect(quickBundle({ repositoryId: 'A', selected: [{ artifactId: 'one', expectedRevision: 1 }], intent: 'copy' }))
    .rejects.toThrow('REVISION_CONFLICT')
  expect(writeText).not.toHaveBeenCalled()
})

it('rejects when both slug and selected are provided', async () => {
  await expect(quickBundle({ repositoryId: 'A', slug: 'architecture', selected: [{ artifactId: 'one', expectedRevision: 1 }], intent: 'copy' }))
    .rejects.toThrow('INVALID_BUNDLE_REQUEST')
})

it('rejects when neither slug nor selected are provided', async () => {
  await expect(quickBundle({ repositoryId: 'A', intent: 'copy' }))
    .rejects.toThrow('INVALID_BUNDLE_REQUEST')
})

it('rejects wrong repository', async () => {
  await expect(quickBundle({ repositoryId: 'B', slug: 'architecture', intent: 'copy' }))
    .rejects.toThrow('REPOSITORY_UNAVAILABLE')
})

it('saves Markdown directly to Downloads without dialog, with collision-safe filename', async () => {
  const receipt1 = await quickBundle({ repositoryId: 'A', slug: 'architecture', intent: 'markdown' })
  expect(receipt1.outcome).toBe('saved')
  expect(receipt1.filePath).toMatch(/architecture-context\.md$/)
  expect(existsSync(receipt1.filePath!)).toBe(true)
  expect(statSync(receipt1.filePath!).size).toBeGreaterThan(0)
  expect(readFileSync(receipt1.filePath!, 'utf8')).toContain(raw)
  const receipt2 = await quickBundle({ repositoryId: 'A', slug: 'architecture', intent: 'markdown' })
  expect(receipt2.filePath).not.toBe(receipt1.filePath)
  expect(existsSync(receipt2.filePath!)).toBe(true)
  expect(readdirSync(folder).filter(f => f.startsWith('architecture')).length).toBe(2)
})

it('saves ZIP directly to Downloads without dialog', async () => {
  const receipt = await quickBundle({ repositoryId: 'A', slug: 'architecture', intent: 'zip' })
  expect(receipt.outcome).toBe('saved')
  expect(receipt.filePath).toMatch(/architecture-context\.zip$/)
  expect(existsSync(receipt.filePath!)).toBe(true)
  const buf = readFileSync(receipt.filePath!)
  expect(buf.readUInt32LE(0)).toBe(0x04034b50)
})

it('leaves no temporary file after write', async () => {
  await quickBundle({ repositoryId: 'A', slug: 'architecture', intent: 'markdown' })
  const files = readdirSync(folder)
  expect(files.every(f => !f.startsWith('.continuum-bundle-'))).toBe(true)
})

it('blocks concurrent operations per sender', async () => {
  const first = quickBundle({ repositoryId: 'A', slug: 'architecture', intent: 'copy' })
  await expect(quickBundle({ repositoryId: 'A', slug: 'architecture', intent: 'copy' })).rejects.toThrow('BUNDLE_BUSY')
  await first
})

it('detects context change after prepare', async () => {
  let resolveService!: () => void
  const slowService = { ...service, assertActive: () => { if (current !== 'A') throw new Error('REPOSITORY_CONTEXT_CHANGED') } }
  registerContinuumBundleHandlers({ getActiveSession: () => ({ repositoryId: current }), getActiveService: () => slowService } as unknown as RepositoryContinuumSession)
  current = 'B'
  await expect(quickBundle({ repositoryId: 'A', slug: 'architecture', intent: 'copy' }))
    .rejects.toThrow('REPOSITORY_UNAVAILABLE')
})
