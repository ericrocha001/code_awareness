import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { ContinuumService } from '../continuum/continuum-service'
import { ContextPickerService } from './context-picker-service'
import type { PickerCatalog, PickerPreview } from '../../shared/web-activation/context-picker-contract'

const desktop = vi.hoisted(() => ({ writeText: vi.fn(), getPath: vi.fn() }))
vi.mock('electron', () => ({ clipboard: { writeText: desktop.writeText }, app: { getPath: desktop.getPath } }))

const origin = 'https://chatgpt.com'
const hash = (data: Buffer | string) => createHash('sha256').update(data).digest('hex')
const connected = () => true
const webp = Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQ/Y/+ByKi/wEA', 'base64')
let downloads: string | undefined

afterEach(() => {
  if (downloads) rmSync(downloads, { recursive: true, force: true })
  downloads = undefined
  vi.clearAllMocks()
})

function project(repositoryId: string) {
  const rawMarkdown = '\uFEFF# Private document\r\n\r\n  à 🚀 \t\r\n'
  const text = { artifactId: 'artifact-document', revision: 1, rawMarkdown, contentHash: hash(rawMarkdown),
    metadata: { name: repositoryId, kind: 'DOCUMENT' } }
  const visual = { ...text, artifactId: 'artifact-visual', metadata: { name: 'Image', kind: 'VISUAL_REFERENCE' } }
  const records = [text, visual]
  const service = {
    assertRepository: (id: string) => { if (id !== repositoryId) throw new Error('REPOSITORY_CONTEXT_CHANGED') },
    assertActive: vi.fn(),
    assertSelection: vi.fn(),
    assertBuilderSelection: (selection: { artifactId: string; expectedRevision: number }[]) => {
      if (selection.some(({ artifactId, expectedRevision }) =>
        records.find(item => item.artifactId === artifactId)?.revision !== expectedRevision)) {
        throw new Error('REVISION_CONFLICT')
      }
    },
    list: vi.fn(() => ({ artifacts: records.map(({ artifactId, revision, metadata }) => ({
      artifactId, revision, ...metadata
    })) })),
    tags: () => [{ slug: 'architecture', name: 'Architecture' }],
    facets: () => [{ key: 'executionId', values: [] }, { key: 'kind', values: [] }],
    selectionTokens: async (items: { artifactId: string }[]) => items.map(({ artifactId }) => ({ artifactId, rawMarkdownTokenCount: 12 })),
    get: vi.fn((id: string) => records.find(item => item.artifactId === id)),
    getVisual: vi.fn(() => ({ data: webp, media: { sha256: hash(webp), bytes: webp.length } }))
  }
  return { current: { repositoryId, revision: 1, name: repositoryId, service: service as unknown as ContinuumService }, text, visual, service }
}

it('lists metadata in the active project and rejects stale selection across scope changes', async () => {
  const first = project('first')
  const second = project('second')
  let active: typeof first.current | null = first.current
  const picker = new ContextPickerService(() => active)
  const execute = (request: unknown, webOrigin = origin) => picker.execute({ webOrigin, request }, connected)
  const page = await execute({ action: 'catalog', filters: { tag: 'architecture' } }) as PickerCatalog
  expect(page.projectName).toBe('first')
  expect(page.artifacts[0].name).toBe('first')
  expect(page).not.toHaveProperty('rawMarkdown')
  expect(page.facets?.map(facet => facet.key)).toEqual(['kind'])
  expect(first.service.get).not.toHaveBeenCalled()
  expect(first.service.getVisual).not.toHaveBeenCalled()
  expect(first.service.list).toHaveBeenCalledWith({ tag: 'architecture', limit: 20 })

  const copy = { action: 'copy', scope: page.scope, selected: [{ artifactId: first.text.artifactId, expectedRevision: 1 }] }
  await expect(execute(copy, 'https://chatgpt.com.example.com')).rejects.toThrow('ORIGIN_NOT_ALLOWED')
  active = second.current
  await expect(execute(copy)).rejects.toThrow('PROJECT_CONTEXT_CHANGED')
  expect((await execute({ action: 'catalog', filters: {} }) as PickerCatalog).artifacts[0].name).toBe('second')
  active = null
  await expect(execute(copy)).rejects.toThrow('NO_ACTIVE_PROJECT')
  active = first.current
  const fresh = await execute({ action: 'catalog', filters: {} }) as PickerCatalog
  first.text.revision += 1
  await expect(execute({ ...copy, scope: fresh.scope })).rejects.toThrow('REVISION_CONFLICT')
  expect(desktop.writeText).not.toHaveBeenCalled()
})

it('previews mixed documents without media bytes and sends literal text and individual originals to explicit fallbacks', async () => {
  const source = project('source')
  downloads = mkdtempSync(join(tmpdir(), 'picker-downloads-'))
  desktop.getPath.mockReturnValue(downloads)
  const picker = new ContextPickerService(() => source.current)
  const execute = (request: unknown) => picker.execute({ webOrigin: origin, request }, connected)
  const page = await execute({ action: 'catalog', filters: {} }) as PickerCatalog
  const selected = [source.visual, source.text].map(item => ({ artifactId: item.artifactId, expectedRevision: item.revision }))
  const preview = await execute({ action: 'preview', scope: page.scope, selected }) as PickerPreview
  expect(preview.artifactTokens).toEqual(selected.map(({ artifactId }) => ({ artifactId, rawMarkdownTokenCount: 12 })))
  expect(preview.hasVisuals).toBe(true)
  expect(preview.tokenCount).toBeGreaterThan(0)
  expect(preview.members.map(item => item.artifactId)).toEqual(selected.map(item => item.artifactId))
  expect(source.service.getVisual).not.toHaveBeenCalled()
  expect(preview).not.toHaveProperty('markdown')

  await expect(execute({ action: 'copy', scope: page.scope, selected: [selected[1]] })).resolves.toEqual({ outcome: 'copied' })
  expect(desktop.writeText).toHaveBeenCalledWith(source.text.rawMarkdown)
  const attached = await execute({ action: 'attach', scope: page.scope, selected: [selected[1]] })
  expect(attached).toEqual({ files: [{ name: 'source.md', type: 'text/markdown', encoded: Buffer.from(source.text.rawMarkdown).toString('base64') }] })
  const downloaded = await execute({ action: 'download', scope: page.scope, selected })
  expect(downloaded).toMatchObject({ outcome: 'downloaded', names: ['Image.md', 'Image.webp', 'source.md'] })
  const subdir = readdirSync(downloads)
  expect(subdir).toHaveLength(1)
  expect(readFileSync(join(downloads, subdir[0], 'Image.webp'))).toEqual(webp)
  expect(readFileSync(join(downloads, subdir[0], 'source.md'))).toEqual(Buffer.from(source.text.rawMarkdown))

  await expect(picker.execute({ webOrigin: origin, request: { action: 'copy', scope: page.scope, selected } }, () => false))
    .rejects.toThrow('PICKER_SESSION_EXPIRED')
  expect(desktop.writeText).toHaveBeenCalledTimes(1)
})

it('gives distinct safe names to Markdown with colliding titles and refuses an oversized native batch', async () => {
  const source = project('source')
  source.text.metadata.name = 'CON: bases'
  source.visual.metadata.name = 'con_ bases'
  source.visual.metadata.kind = 'DOCUMENT'
  const picker = new ContextPickerService(() => source.current)
  const execute = (request: unknown) => picker.execute({ webOrigin: origin, request }, connected)
  const page = await execute({ action: 'catalog', filters: {} }) as PickerCatalog
  const request = {
    action: 'attach', scope: page.scope,
    selected: [source.text, source.visual].map(item => ({ artifactId: item.artifactId, expectedRevision: item.revision }))
  }
  const materialized = await execute(request)
  expect(materialized).toMatchObject({ files: [{ name: 'CON_ bases.md' }, { name: 'con_ bases-2.md' }] })
  source.text.rawMarkdown = 'doc\n'.repeat(180_000)
  source.text.contentHash = hash(source.text.rawMarkdown)
  await expect(execute(request)).rejects.toThrow('PICKER_FILES_TOO_LARGE')
})
