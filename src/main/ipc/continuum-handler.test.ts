import { beforeEach, expect, it, vi } from 'vitest'
import { registerContinuumHandlers } from './continuum-handler'
import type { RepositoryContinuumSession } from '../continuum/project-continuum-session'

const { handlers, send } = vi.hoisted(() => ({ handlers: new Map<string, Function>(), send: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: (key: string, handler: Function) => handlers.set(key, handler) }, BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send } }] } }))
beforeEach(() => { handlers.clear(); send.mockClear() })
it('exposes only scoped reads, resolves catalog identity from active checkout and separates the canonical Markdown body', () => {
  let current: { repositoryId: string; repositoryPath: string } | null = { repositoryId: 'catalog-A', repositoryPath: '/A' }
  let changed: () => void = () => {}
  const service = { list: vi.fn(() => ({ artifacts: [{ artifactId: 'a', name: 'A' }], nextCursor: 'cursor' })), facets: vi.fn(() => [{ key: 'unknown', values: [{ value: false, count: 1 }] }]),
    get: vi.fn(() => ({ artifactId: 'a', revision: 2, metadata: { name: 'A', kind: 'UNSEEN' }, createdAt: 'created', updatedAt: 'updated', rawMarkdown: '---\nname: A\ndescription: Read A\nkind: UNSEEN\n---\n# Body\nç 🚀' })) }
  registerContinuumHandlers({ getActiveSession: () => current, getActiveService: () => current ? service : null, onChanged: (listener: () => void) => { changed = listener; return () => {} } } as unknown as RepositoryContinuumSession)
  expect([...handlers.keys()].sort()).toEqual(['continuum:facets', 'continuum:get', 'continuum:list'])
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
