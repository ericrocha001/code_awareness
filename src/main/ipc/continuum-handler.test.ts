import { beforeEach, expect, it, vi } from 'vitest'
import { registerContinuumHandlers } from './continuum-handler'
import type { RepositoryContinuumSession } from '../continuum/project-continuum-session'
import { parseArtifactMarkdown } from '../continuum/artifact-metadata'

const { handlers, send } = vi.hoisted(() => ({ handlers: new Map<string, Function>(), send: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: (key: string, handler: Function) => handlers.set(key, handler) }, BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send } }] } }))
beforeEach(() => { handlers.clear(); send.mockClear() })
it('exposes scoped reads and publication, resolves catalog identity and separates the canonical Markdown body', () => {
  let current: { repositoryId: string; repositoryPath: string } | null = { repositoryId: 'catalog-A', repositoryPath: '/A' }
  let changed: () => void = () => {}
  const service = { list: vi.fn(() => ({ artifacts: [{ artifactId: 'a', name: 'A' }], nextCursor: 'cursor' })), facets: vi.fn(() => [{ key: 'unknown', values: [{ value: false, count: 1 }] }]),
    get: vi.fn(() => ({ artifactId: 'a', revision: 2, metadata: { name: 'A', kind: 'UNSEEN' }, createdAt: 'created', updatedAt: 'updated', rawMarkdown: '---\nname: A\ndescription: Read A\nkind: UNSEEN\n---\n# Body\nç 🚀' })) }
  registerContinuumHandlers({ getActiveSession: () => current, getActiveService: () => current ? service : null, onChanged: (listener: () => void) => { changed = listener; return () => {} } } as unknown as RepositoryContinuumSession)
  expect([...handlers.keys()].sort()).toEqual(['continuum:facets', 'continuum:get', 'continuum:list', 'continuum:publish'])
  const read = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args)
  expect(read('continuum:facets', '/A')).toMatchObject({ repositoryId: 'catalog-A', facets: [{ key: 'unknown' }] })
  expect(read('continuum:facets', '/B')).toEqual({ repositoryId: null, facets: [] })
  expect(read('continuum:list', { repositoryId: 'catalog-A', query: 'A', metadata: { unknown: false }, cursor: 'cursor' })).toMatchObject({ repositoryId: 'catalog-A', nextCursor: 'cursor' })
  expect(service.list).toHaveBeenCalledWith({ query: 'A', metadata: { unknown: false }, cursor: 'cursor', limit: 30 })
  expect(read('continuum:get', 'catalog-A', 'a').artifact).toMatchObject({ body: '# Body\nç 🚀', revision: 2 })
  expect(() => read('continuum:list', { repositoryId: 'catalog-A', metadata: { nested: {} } })).toThrow(/scalar/)
  expect(() => read('continuum:list', { repositoryId: 'catalog-A', query: 12 })).toThrow(/query/)
  current = { repositoryId: 'catalog-B', repositoryPath: '/B' }; changed()
  expect(send).toHaveBeenLastCalledWith('continuum:changed', { repositoryId: 'catalog-B' })
  expect(read('continuum:list', { repositoryId: 'catalog-A' })).toEqual({ repositoryId: null, artifacts: [] })
  expect(read('continuum:get', 'catalog-A', 'a')).toEqual({ repositoryId: null, artifact: null })
  current = null; changed()
  expect(read('continuum:facets', '/A')).toEqual({ repositoryId: null, facets: [] })
  expect(send).toHaveBeenLastCalledWith('continuum:changed', { repositoryId: null })
})

it('publishes exact text once and rejects invalid documents or stale/unavailable contexts before writing', () => {
  let current: string | null = 'A'
  const writes: string[] = []
  const publish = vi.fn((text: string) => {
    parseArtifactMarkdown(text)
    writes.push(text)
    return { success: true, artifactId: 'new', revision: 1, updatedAt: 'now' }
  })
  registerContinuumHandlers({ getActiveSession: () => current ? { repositoryId: current } : null,
    getActiveService: () => current ? { publish } : null, onChanged: () => () => {} } as unknown as RepositoryContinuumSession)
  const invoke = (repositoryId: string, rawMarkdown: unknown, fileName: unknown = 'Exact.md') => handlers.get('continuum:publish')!({}, { repositoryId, rawMarkdown, fileName })
  const text = '\uFEFF---\r\nname: Exact\r\ndescription: Read exact\r\nkind: CUSTOM\r\n---\r\n# ç 日本語 🚀 `${literal}` $(command)\r\n'
  expect(invoke('A', text)).toEqual({ success: true, artifactId: 'new', revision: 1, updatedAt: 'now' })
  expect(writes).toEqual([text])
  for (const invalid of ['---', '\uFEFF---\r\nIncomplete', '---\nname: Missing\n---\nBody', '---\nname: Empty\ndescription: Empty\nkind: CUSTOM\n---\n', '---\nname: [\n---\nBody']) {
    expect(() => invoke('A', invalid)).toThrow()
  }
  expect(() => invoke('A', 12)).toThrow(/Markdown/)
  current = 'B'
  expect(() => invoke('A', text)).toThrow(/REPOSITORY_UNAVAILABLE/)
  current = null
  expect(() => invoke('A', text)).toThrow(/REPOSITORY_UNAVAILABLE/)
  expect(writes).toEqual([text])
  expect(publish).toHaveBeenCalledTimes(6)
})

it('adds only default metadata to body-only files, preserving BOM, whitespace and CRLF with safe YAML values', () => {
  const texts: string[] = []
  registerContinuumHandlers({ getActiveSession: () => ({ repositoryId: 'A' }),
    getActiveService: () => ({ publish: (text: string) => { parseArtifactMarkdown(text); texts.push(text); return { success: true, artifactId: 'new', revision: 1, updatedAt: 'now' } } }),
    onChanged: () => () => {} } as unknown as RepositoryContinuumSession)
  const invoke = (fileName: unknown, rawMarkdown: string) => handlers.get('continuum:publish')!({}, { repositoryId: 'A', fileName, rawMarkdown })
  const original = '\uFEFF\r\n# Obsidian\r\n\r\n  ç 日本語 🚀 `${literal}` $(command)  \r\n\r\n'
  const name = 'Nota: "kind: EXECUTABLE_PLAN" & [ç 日本語]'
  expect(invoke(name + '.MD', original)).toMatchObject({ success: true, revision: 1 })
  const parsed = parseArtifactMarkdown(texts[0])
  expect(parsed.body).toBe(original.slice(1))
  expect(texts[0].startsWith('\uFEFF---\n')).toBe(true)
  expect(parsed.metadata).toEqual({ name, description: 'Documento Markdown publicado manualmente pela interface do Continuum. Abra para consultar seu conteúdo.', kind: 'DOCUMENT', date: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/) })
  const date = Date.parse(parsed.metadata.date as string)
  expect(Math.abs(Date.now() - date)).toBeLessThan(5000)
  for (const fileName of [undefined, null, 1, '', '.md', '  .md', 'file.txt', '/dir/file.md', 'dir/file.md', 'dir\\file.md', 'C:file.md', 'C:\\file.md', 'bad\nkind: X.md', 'bad\0.md']) {
    expect(() => invoke(fileName, '# body')).toThrow(/arquivo/)
  }
  for (const invalid of ['', ' \r\n\t', '\uFEFF', '# invalid\0body']) expect(() => invoke('valid.md', invalid)).toThrow(/Markdown/)
  expect(texts).toHaveLength(1)
})
