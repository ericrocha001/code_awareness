import { metadataPeriod } from '../continuum/temporal-metadata'
import { beforeEach, expect, it, vi } from 'vitest'
import { registerContinuumHandlers } from './continuum-handler'
import type { RepositoryContinuumSession } from '../continuum/project-continuum-session'
import { parseArtifactMarkdown } from '../continuum/artifact-metadata'

const { handlers, send } = vi.hoisted(() => ({ handlers: new Map<string, Function>(), send: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: (key: string, handler: Function) => handlers.set(key, handler) }, BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send } }] } }))
beforeEach(() => { handlers.clear(); send.mockClear() })
it('scopes all-result snapshots and rejects token responses after repository changes', async () => {
  let current = 'A', finish!: (value: object[]) => void
  const service = { resolveSelection: vi.fn(() => [{ artifactId: 'one', revision: 2 }]), selectionTokens: vi.fn(() => new Promise<object[]>(resolve => { finish = resolve })) }
  registerContinuumHandlers({ getActiveSession: () => ({ repositoryId: current }), getActiveService: () => service, onChanged: () => () => {} } as unknown as RepositoryContinuumSession)
  const resolve = (request: object) => handlers.get('continuum:resolve-selection')!({}, request)
  expect(() => resolve({ repositoryId: 'B' })).toThrow(/REPOSITORY_UNAVAILABLE/)
  expect(() => resolve({ repositoryId: 'A', cursor: 'page' })).toThrow(/INVALID_SELECTION_REQUEST/)
  expect(resolve({ repositoryId: 'A', query: 'filtered', tag: 'tag', metadata: { kind: 'DOCUMENT' }, periods: { date: { year: 2026 } } })).toMatchObject({ repositoryId: 'A', artifacts: [{ artifactId: 'one', revision: 2 }] })
  expect(service.resolveSelection).toHaveBeenCalledWith({ query: 'filtered', tag: 'tag', metadata: { kind: 'DOCUMENT' }, periods: { date: { year: 2026 } } })
  const pending = handlers.get('continuum:selection-tokens')!({}, 'A', [{ artifactId: 'one', expectedRevision: 2 }])
  current = 'B'; finish([{ artifactId: 'one', rawMarkdownTokenCount: 12 }])
  await expect(pending).rejects.toThrow(/REPOSITORY_CONTEXT_CHANGED/)
})
it('binds human tag mutation and upload confirmation to the active repository and forwards tag membership', () => {
  const mutateTags = vi.fn(() => []), tags = vi.fn(() => []), list = vi.fn(() => ({ artifacts: [] })), publishHuman = vi.fn()
  const service = { mutateTags, tags, list, publishHuman }
  registerContinuumHandlers({ getActiveSession: () => ({ repositoryId: 'A' }), getActiveService: () => service, onChanged: () => () => {} } as unknown as RepositoryContinuumSession)
  const mutation = { repositoryId: 'A', intent: 'assign', slug: 'architecture', selected: [{ artifactId: 'one', expectedRevision: 3 }], assigned: true, confirmed: true }
  expect(() => handlers.get('continuum:mutate-tags')!({}, { ...mutation, repositoryId: 'B' })).toThrow('REPOSITORY_UNAVAILABLE')
  expect(mutateTags).not.toHaveBeenCalled()
  handlers.get('continuum:mutate-tags')!({}, mutation)
  expect(mutateTags).toHaveBeenCalledWith(mutation)
  handlers.get('continuum:list')!({}, { repositoryId: 'A', tag: 'architecture' })
  expect(list).toHaveBeenCalledWith({ tag: 'architecture', limit: 30, includeRawMarkdownTokenCount: true })
  const rawMarkdown = '---\nname: Human\ndescription: d\nkind: DOCUMENT\ntags: [architecture]\n---\n# body'
  handlers.get('continuum:publish')!({}, { repositoryId: 'A', fileName: 'human.md', rawMarkdown, confirmedTags: true })
  expect(publishHuman).toHaveBeenCalledWith(rawMarkdown, true)
})
it('scopes suggestions and rejects a result if reconciliation changes the active repository', () => {
  let current = 'A'
  const suggestions = vi.fn(() => ({ repositoryId: 'A', suggestions: [] }))
  const service = { suggestions }
  registerContinuumHandlers({ getActiveSession: () => ({ repositoryId: current }), getActiveService: () => service, onChanged: () => () => {} } as unknown as RepositoryContinuumSession)
  const read = (request: unknown) => handlers.get('continuum:suggestions')!({}, request)
  expect(() => read({ repositoryId: 'B', artifactId: 'source' })).toThrow(/REPOSITORY_UNAVAILABLE/)
  expect(read({ repositoryId: 'A', artifactId: 'source', limit: 2 })).toEqual({ repositoryId: 'A', suggestions: [] })
  expect(suggestions).toHaveBeenCalledWith({ artifactId: 'source', limit: 2 })
  suggestions.mockImplementation(() => { current = 'B'; return { repositoryId: 'A', suggestions: [] } })
  expect(() => read({ repositoryId: 'A', artifactId: 'source' })).toThrow(/REPOSITORY_CONTEXT_CHANGED/)
})
it('scopes graph requests and cancels stale results when the repository changes during reconciliation', () => {
  let current = 'A'
  const graph = vi.fn(() => ({ repositoryId: 'A', nodes: [], edges: [] }))
  const service = { graph }
  registerContinuumHandlers({ getActiveSession: () => ({ repositoryId: current }), getActiveService: () => service, onChanged: () => () => {} } as unknown as RepositoryContinuumSession)
  const read = (request: unknown) => handlers.get('continuum:graph')!({}, request)
  expect(() => read({ repositoryId: 'B' })).toThrow(/REPOSITORY_UNAVAILABLE/)
  expect(read({ repositoryId: 'A', nodeLimit: 10 })).toEqual({ repositoryId: 'A', nodes: [], edges: [] })
  expect(graph).toHaveBeenCalledWith({ nodeLimit: 10 })
  graph.mockImplementation(() => { current = 'B'; return { repositoryId: 'A', nodes: [], edges: [] } })
  expect(() => read({ repositoryId: 'A' })).toThrow(/REPOSITORY_CONTEXT_CHANGED/)
})
it('scopes thumbnail reads and rejects a result after the active service changes', async () => {
  let current = 'A'
  let finish!: (value: Buffer) => void
  const service = { getVisualThumbnail: vi.fn(() => new Promise<Buffer>(resolve => { finish = resolve })) }
  registerContinuumHandlers({ getActiveSession: () => ({ repositoryId: current }), getActiveService: () => current === 'A' ? service : {}, onChanged: () => () => {} } as unknown as RepositoryContinuumSession)
  const read = (repositoryId: string, artifactId: unknown) => handlers.get('continuum:get-visual-thumbnail')!({}, repositoryId, artifactId)
  await expect(read('B', 'visual')).rejects.toThrow(/REPOSITORY_UNAVAILABLE/)
  await expect(read('A', '')).rejects.toThrow(/INVALID_ARGUMENT/)
  const pending = read('A', 'visual')
  current = 'B'; finish(Buffer.from([1]))
  await expect(pending).rejects.toThrow(/REPOSITORY_CONTEXT_CHANGED/)
  current = 'A'
  const accepted = read('A', 'visual'); finish(Buffer.from([2, 3]))
  await expect(accepted).resolves.toEqual({ repositoryId: 'A', artifactId: 'visual', mimeType: 'image/webp', data: new Uint8Array([2, 3]) })
  expect(service.getVisualThumbnail).toHaveBeenCalledTimes(2)
})
it('exposes scoped reads and publication, resolves catalog identity and separates the canonical Markdown body', () => {
  let current: { repositoryId: string; repositoryPath: string } | null = { repositoryId: 'catalog-A', repositoryPath: '/A' }
  let changed: () => void = () => {}
  const service = { list: vi.fn(() => ({ artifacts: [{ artifactId: 'a', name: 'A' }], nextCursor: 'cursor' })), facets: vi.fn(() => [{ key: 'unknown', values: [{ value: false, count: 1 }] }]),
    get: vi.fn(() => ({ artifactId: 'a', revision: 2, metadata: { name: 'A', kind: 'UNSEEN' }, createdAt: 'created', updatedAt: 'updated', rawMarkdown: '---\nname: A\ndescription: Read A\nkind: UNSEEN\n---\n# Body\nç 🚀' })) }
  registerContinuumHandlers({ getActiveSession: () => current, getActiveService: () => current ? service : null, onChanged: (listener: () => void) => { changed = listener; return () => {} } } as unknown as RepositoryContinuumSession)
  expect([...handlers.keys()].sort()).toEqual(['continuum:builder', 'continuum:quick-bundle', 'continuum:resolve-selection', 'continuum:selection-tokens', 'continuum:tag-tokens', 'continuum:export', 'continuum:facets', 'continuum:get', 'continuum:get-visual', 'continuum:get-visual-thumbnail', 'continuum:graph', 'continuum:list', 'continuum:publish', 'continuum:publish-visual', 'continuum:suggestions', 'continuum:tags', 'continuum:mutate-tags'].sort())
  const read = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args)
  expect(read('continuum:facets', '/A')).toMatchObject({ repositoryId: 'catalog-A', facets: [{ key: 'unknown' }] })
  expect(read('continuum:facets', '/B')).toEqual({ repositoryId: null, facets: [] })
  expect(read('continuum:list', { repositoryId: 'catalog-A', query: 'A', metadata: { unknown: false }, cursor: 'cursor' })).toMatchObject({ repositoryId: 'catalog-A', nextCursor: 'cursor' })
  expect(service.list).toHaveBeenCalledWith({ query: 'A', metadata: { unknown: false }, cursor: 'cursor', limit: 30, includeRawMarkdownTokenCount: true })
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
    getActiveService: () => current ? { publishHuman: publish } : null, onChanged: () => () => {} } as unknown as RepositoryContinuumSession)
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
    getActiveService: () => ({ publishHuman: (text: string) => { parseArtifactMarkdown(text); texts.push(text); return { success: true, artifactId: 'new', revision: 1, updatedAt: 'now' } } }),
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

it('validates temporal UI selections strictly and forwards typed periods to the canonical service', () => {
  const list = vi.fn(() => ({ artifacts: [] }))
  const service = { list }
  registerContinuumHandlers({ getActiveSession: () => ({ repositoryId: 'A' }), getActiveService: () => service, onChanged: () => () => {} } as unknown as RepositoryContinuumSession)
  const read = (request: unknown) => handlers.get('continuum:list')!({}, request)
  read({ repositoryId: 'A', periods: { arbitraryKey: { year: 2026, month: 10 } }, metadata: { kind: 'PLAN' } })
  expect(list).toHaveBeenCalledWith({ periods: { arbitraryKey: { year: 2026, month: 10 } }, metadata: { kind: 'PLAN' }, limit: 30, includeRawMarkdownTokenCount: true })
  read({ repositoryId: 'A', sortBy: 'createdAt', includeTags: true })
  expect(list).toHaveBeenLastCalledWith({ sortBy: 'createdAt', includeTags: true, limit: 30, includeRawMarkdownTokenCount: true })
  for (const sortBy of ['invalid', null, 1]) expect(() => read({ repositoryId: 'A', sortBy })).toThrow(/sortBy/)
  for (const includeTags of ['true', null, 1]) expect(() => read({ repositoryId: 'A', includeTags })).toThrow(/includeTags/)
  for (const periods of [[], null, { date: {} }, { date: { year: '2026' } }, { date: { year: 2026, month: 0 } }, { date: { year: 2026, month: 13 } }, { date: { year: 2026.5 } }, { date: { year: 10000 } }, { date: { year: 2026, extra: true } }, { '': { year: 2026 } }, { constructor: { year: 2026 } }]) expect(() => read({ repositoryId: 'A', periods })).toThrow(/INVALID_ARGUMENT/)
  expect(() => read({ repositoryId: 'A', periods: { date: { year: 2026 } }, metadata: { date: '2026-10-11' } })).toThrow(/conflicting/)
})

it('recognizes only complete calendar and time-valid ISO strings, preserving their literal year and month', () => {
  for (const value of ['2026-10-31', '2026-10-31T23:59', '2026-10-31T23:59:59.123Z', '2026-10-31T23:59:59-03:00', '2026-10-31T23:59:59+14:00']) expect(metadataPeriod(value)).toEqual({ year: 2026, month: 10 })
  for (const value of ['2026-02-29', '1900-02-29', '2026-04-31', '2026-00-01', '2026-13-01', '2026-01-00', '2026-01-01junk', '2026-01-01T', '2026-01-01T12:60', '2026-01-01T24:00', '2026-01-01T12:00:60Z', '2026-01-01T12:00+01:60', '2026-01-01T12:00+24:00', 2026, null]) expect(metadataPeriod(value)).toBeNull()
  expect(metadataPeriod('2000-02-29')).toEqual({ year: 2000, month: 2 })
})
