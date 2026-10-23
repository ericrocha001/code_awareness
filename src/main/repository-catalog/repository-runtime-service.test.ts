import { describe, expect, it, vi } from 'vitest'
import type { ActiveProjectState, CapabilityReadiness } from '../../shared/types/active-project-types'
import type { RepositoryRecord } from '../../shared/types/repository-catalog-types'
import { ActiveProjectService } from '../core/active-project-service'
import { RepositoryRuntimeService } from './repository-runtime-service'

const deferred = () => { let resolve!: () => void, reject!: (error: Error) => void; const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const flush = () => new Promise<void>(resolve => setImmediate(resolve))
const record = (id: string): RepositoryRecord => ({ id, name: id, status: 'ACTIVE', localCheckout: { path: '/' + id, availability: 'AVAILABLE', gitState: 'GIT' }, github: null, createdAt: '', updatedAt: '' })
function setup() {
  const a = record('A'), b = record('B'), opens = { A: deferred(), B: deferred() }
  const catalog = { resolveAvailable: (id: string) => { if (id !== 'A' && id !== 'B') throw Error('NOT_FOUND'); return id === 'A' ? a : b } }
  const codeMap = { openRepository: vi.fn((path: string) => opens[path.slice(1) as 'A' | 'B'].promise),
    getOpenProjects: () => [a, b].map(r => ({ id: 'legacy-' + r.id, name: r.name, path: r.localCheckout!.path })),
    closeRepository: vi.fn(), getReadiness: vi.fn((): CapabilityReadiness => ({ state: 'READY' })) }
  const projects = new ActiveProjectService(codeMap, path => path === '/A' ? a : b)
  const runtime = new RepositoryRuntimeService(catalog, codeMap, projects)
  return { a, b, opens, projects, runtime, codeMap }
}

describe('catalog-bound active context', () => {
  it('restores the logical repository before CodeMap readiness and skips duplicate restoration', async () => {
    const { projects, runtime, codeMap } = setup()
    const restored = await runtime.restoreLastActive('A')
    expect(restored).toMatchObject({ project: { id: 'A' }, context: { identity: 'IDENTITY_BOUND', capabilities: { codeMap: { state: 'INITIALIZING' } } } })
    expect(codeMap.openRepository).toHaveBeenCalledExactlyOnceWith('/A')
    await runtime.restoreLastActive('A')
    expect(codeMap.openRepository).toHaveBeenCalledTimes(1)
    expect(projects.getState().project?.id).toBe('A')
  })
  it('leaves empty startup unbound and allows manual choice after unavailable restoration', async () => {
    const { projects, runtime } = setup()
    expect((await runtime.restoreLastActive()).project).toBeNull()
    expect((await runtime.restoreLastActive('unknown')).project).toBeNull()
    expect(projects.getState().context?.identity).toBe('UNBOUND')
    expect((await runtime.activate('B')).project?.id).toBe('B')
  })
  it('never replaces a newer explicit choice, including a restoration still binding', async () => {
    const { projects, runtime } = setup(), barrier = deferred()
    projects.onBeforeChange(() => barrier.promise)
    const restored = runtime.restoreLastActive('A'); await flush()
    const explicit = runtime.activate('B'); barrier.resolve()
    await Promise.all([restored, explicit])
    expect(projects.getState().project?.id).toBe('B')
    await runtime.restoreLastActive('A')
    expect(projects.getState().project?.id).toBe('B')
  })
  it('never restores HOST preference into PREVIEW context', async () => {
    const projects = new ActiveProjectService({ getOpenProjects: () => [], closeRepository: () => {} }, undefined,
      { mode: 'PREVIEW', sessionId: 'approved-preview' })
    const catalog = { resolveAvailable: vi.fn(() => record('B')) }, codeMap = { getOpenProjects: () => [], openRepository: vi.fn(async () => {}) }
    const runtime = new RepositoryRuntimeService(catalog, codeMap, projects)
    expect((await runtime.restoreLastActive('B')).context?.mode).toBe('PREVIEW')
    expect(catalog.resolveAvailable).not.toHaveBeenCalled(); expect(codeMap.openRepository).not.toHaveBeenCalled()
  })
  it.each(['REPOSITORY_NOT_FOUND', 'REPOSITORY_HIDDEN', 'LOCAL_CHECKOUT_UNAVAILABLE'])('keeps startup unbound and manual activation available on %s', async reason => {
    const { projects, codeMap } = setup()
    const runtime = new RepositoryRuntimeService({ resolveAvailable: id => { if (id === 'A') throw Error(reason); return record('B') } }, codeMap, projects)
    expect((await runtime.restoreLastActive('A')).project).toBeNull()
    expect(codeMap.openRepository).not.toHaveBeenCalled()
    expect((await runtime.activate('B')).project?.id).toBe('B')
  })
  it('preserves fixed preview context and does not claim an authenticated repository before selection', async () => {
    const projects = new ActiveProjectService({ getOpenProjects: () => [], closeRepository: () => {} }, undefined,
      { mode: 'PREVIEW', sessionId: 'approved-bootstrap-session', target: { repositoryId: 'A', worktreeId: 'tree', generation: 'generation', path: '/A' } })
    expect(projects.getState().context).toMatchObject({ mode: 'PREVIEW', sessionId: 'approved-bootstrap-session', repositoryId: null, identity: 'UNBOUND', dataPolicy: 'EMPTY' })
    await projects.bind(record('A'))
    expect(() => projects.bind(record('B'))).toThrow('PREVIEW_CONTEXT_LOCKED')
    expect(projects.getState().context).toMatchObject({ mode: 'PREVIEW', sessionId: 'approved-bootstrap-session', repositoryId: 'A', dataPolicy: 'EMPTY' })
    await projects.dispose()
    expect(projects.getState().context).toMatchObject({ mode: 'PREVIEW', sessionId: 'approved-bootstrap-session', identity: 'UNBOUND' })
  })
  it('binds before slow CodeMap and preserves identity and independent consumers when opening fails', async () => {
    const { projects, runtime, opens, codeMap } = setup(), documents = vi.fn(), before = vi.fn(async () => {})
    let selection = -1
    projects.onBeforeChange(before)
    projects.onChanged(state => { if (state.revision === selection) return; selection = state.revision; documents(state.project?.id); projects.updateCapability(state.revision, 'continuum', { state: 'READY' }) })
    const state = await runtime.activate('A')
    expect(state).toMatchObject({ revision: 1, project: { id: 'A', path: '/A' }, context: { identity: 'IDENTITY_BOUND', repositoryId: 'A', legacyCodeMapProjectId: null,
      mode: 'HOST', sessionId: null, dataPolicy: 'HOST_CANONICAL', capabilities: { codeMap: { state: 'INITIALIZING' }, continuum: { state: 'READY' }, channel: { state: 'UNINITIALIZED' } } } })
    expect(codeMap.openRepository).toHaveBeenCalledExactlyOnceWith('/A')
    opens.A.reject(Error('private SQLite failure'))
    await flush()
    expect(projects.getState()).toMatchObject({ revision: 1, project: { id: 'A' }, context: { repositoryId: 'A', capabilities: { codeMap: { state: 'UNAVAILABLE', reasonCode: 'CODEMAP_OPEN_FAILED' }, continuum: { state: 'READY' } } } })
    expect(documents).toHaveBeenCalledExactlyOnceWith('A'); expect(before).toHaveBeenCalledTimes(1)
    await projects.closeRepository('/A'); expect(projects.getState().project).toBeNull()
  })

  it('retains the explicit CodeMap id adapter without replacing logical identity, and projects maintenance failure', async () => {
    const { projects, opens, codeMap } = setup(), maintenance = deferred()
    codeMap.getReadiness.mockReturnValue({ state: 'DEGRADED' })
    const runtimeWithMaintenance = new RepositoryRuntimeService({ resolveAvailable: () => record('A') },
      { ...codeMap, awaitMaintenance: () => maintenance.promise, getReadiness: () => ({ state: 'DEGRADED' }) }, projects)
    await runtimeWithMaintenance.activate('A'); opens.A.resolve(); await flush()
    expect(projects.getState()).toMatchObject({ project: { id: 'A' }, context: { repositoryId: 'A', legacyCodeMapProjectId: 'legacy-A', capabilities: { codeMap: { state: 'DEGRADED' } } } })
    maintenance.resolve(); await flush()
    expect(projects.getState().revision).toBe(1)
    await projects.activate('legacy-A'); expect(projects.getState().project?.id).toBe('A')
  })

  it('does not publish a former project when concurrent selection wins before binding', async () => {
    const { projects, runtime, opens } = setup(), barrier = deferred(), seen: string[] = []
    projects.onBeforeChange(() => barrier.promise)
    projects.onChanged(state => { if (state.project) seen.push(state.project.id) })
    const first = runtime.activate('A'); await flush()
    const second = runtime.activate('B'); barrier.resolve()
    await Promise.all([first, second]); opens.A.resolve(); opens.B.resolve(); await flush()
    expect(seen.every(id => id === 'B')).toBe(true)
    expect(projects.getState().context?.repositoryId).toBe('B')
  })

  it('does not cancel a pending selection when an unrelated inactive checkout closes', async () => {
    const { projects, runtime, opens } = setup(), barrier = deferred()
    projects.onBeforeChange(() => barrier.promise)
    const selected = runtime.activate('A'); await flush()
    const closed = projects.closeRepository('/B')
    barrier.resolve(); await Promise.all([selected, closed]); opens.A.resolve(); await flush()
    expect(projects.getState().context?.repositoryId).toBe('A')
  })

  it('rejects late CodeMap results after another selection, close or disposal', async () => {
    const { projects, runtime, opens } = setup(), seen: ActiveProjectState[] = []
    projects.onChanged(state => { seen.push(state) })
    await runtime.activate('A'); await runtime.activate('B')
    opens.B.resolve(); await flush(); const b = projects.getState()
    opens.A.reject(Error('old failure')); await flush(); expect(projects.getState()).toEqual(b)
    projects.updateCapability(1, 'continuum', { state: 'READY' }); expect(projects.getState()).toEqual(b)
    await projects.dispose(); const ended = projects.getState()
    projects.updateCapability(ended.revision, 'channel', { state: 'READY' }); expect(projects.getState()).toEqual(ended)
    expect(seen.filter(s => s.project?.id === 'A').every(s => s.revision === 1)).toBe(true)
  })

  it('preserves state on invalid catalog selection, and protects projection snapshots from consumers', async () => {
    const { projects, runtime, opens } = setup()
    await runtime.activate('A'); opens.A.resolve(); await flush(); const prior = projects.getState()
    await expect(runtime.activate('unknown')).rejects.toThrow('NOT_FOUND')
    expect(projects.getState()).toEqual(prior)
    prior.context!.capabilities.codeMap.state = 'UNAVAILABLE'; prior.project!.id = 'intruder'
    expect(projects.getState().project?.id).toBe('A'); expect(projects.getState().context?.capabilities.codeMap.state).toBe('READY')
  })

  it('keeps a pending preparation valid after a rejected selection and reflects later model readiness on reads', async () => {
    const { projects, runtime, opens, codeMap } = setup()
    await runtime.activate('A')
    await expect(runtime.activate('unknown')).rejects.toThrow('NOT_FOUND')
    opens.A.resolve(); await flush()
    expect(projects.getState().context?.legacyCodeMapProjectId).toBe('legacy-A')
    const before = projects.getState()
    codeMap.getReadiness.mockReturnValue({ state: 'DEGRADED' })
    const failed = projects.getState()
    expect(failed.revision).toBe(before.revision)
    expect(failed.context!.revision).toBeGreaterThan(before.context!.revision)
    expect(failed.context!.capabilities.codeMap.state).toBe('DEGRADED')
    codeMap.getReadiness.mockReturnValue({ state: 'READY' })
    expect(projects.getState().context!.capabilities.codeMap.state).toBe('READY')
  })
})
