import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '../../shared/types'
import type { ActiveProjectState } from '../../shared/types/active-project-types'
import { WorkspaceService } from '../core/workspace-service'
import { RepositoryCatalogService } from './repository-catalog-service'
import { RepositoryCatalogStore } from './repository-catalog-store'
import { RepositoryRuntimeService } from './repository-runtime-service'

const roots: string[] = []
const settings = (values: Partial<AppSettings> = {}): AppSettings => ({
  rootFolders: [], individualProjects: [], hiddenProjects: [], ignoredDiffFiles: {}, tags: {}, fileTags: {}, projectPreferences: {}, ...values
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'repository-catalog-'))
  roots.push(root)
  return root
}

function repository(root: string, name: string, git = false): string {
  const path = join(root, name)
  mkdirSync(path, { recursive: true })
  if (git) mkdirSync(join(path, '.git'))
  writeFileSync(join(path, 'README.md'), name)
  return path
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Repository Catalog', () => {
  it('preserves a path-independent identity across reimport, normalized duplicates, and reopen', async () => {
    const root = tempRoot()
    const checkout = repository(root, 'alpha', true)
    const databasePath = join(root, 'data', 'catalog.db')
    const store = new RepositoryCatalogStore(databasePath)
    const catalog = new RepositoryCatalogService(store, new WorkspaceService())

    const first = await catalog.importLocal(checkout)
    const second = await catalog.importLocal(`${checkout}\\`)
    expect(second.id).toBe(first.id)
    expect(catalog.list(true)).toHaveLength(1)
    expect(first.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(first.id).not.toContain('alpha')
    store.close()

    const reopenedStore = new RepositoryCatalogStore(databasePath)
    expect(reopenedStore.list(true)[0].id).toBe(first.id)
    reopenedStore.close()
  })

  it('preserves hidden and missing records, keeps automatic discovery hidden, and restores explicitly', async () => {
    const root = tempRoot()
    const checkout = repository(root, 'beta')
    const store = new RepositoryCatalogStore(join(root, 'catalog.db'))
    const catalog = new RepositoryCatalogService(store, new WorkspaceService())
    const imported = await catalog.importLocal(checkout)

    catalog.hide(imported.id)
    await catalog.importRoot(root)
    expect(store.get(imported.id).status).toBe('HIDDEN')
    const restored = await catalog.importLocal(checkout)
    expect(restored).toMatchObject({ id: imported.id, status: 'ACTIVE' })

    rmSync(checkout, { recursive: true, force: true })
    await catalog.refresh(settings())
    expect(store.get(imported.id).localCheckout?.availability).toBe('MISSING')
    expect(() => catalog.resolveAvailable(imported.id)).toThrow('LOCAL_CHECKOUT_UNAVAILABLE')

    mkdirSync(checkout)
    await catalog.refresh(settings())
    expect(store.get(imported.id)).toMatchObject({ id: imported.id, localCheckout: { availability: 'AVAILABLE', gitState: 'NON_GIT' } })
    store.close()
  })

  it('migrates legacy discovery once with Git, Non-Git, hidden, and Academy destination preservation', async () => {
    const root = tempRoot()
    const data = tempRoot()
    const git = repository(root, 'git-repo', true)
    const nonGit = repository(root, 'non-git')
    const hidden = repository(root, 'hidden')
    const destination = { registerDestination: vi.fn(async () => undefined) }
    const store = new RepositoryCatalogStore(join(data, 'catalog.db'))
    const catalog = new RepositoryCatalogService(store, new WorkspaceService(), destination)
    const legacy = settings({ rootFolders: [root], individualProjects: [nonGit], hiddenProjects: [hidden] })

    await catalog.initialize(legacy)
    const first = store.list(true)
    expect(first).toHaveLength(3)
    expect(first.find((record) => record.localCheckout?.path === git)?.localCheckout?.gitState).toBe('GIT')
    expect(first.find((record) => record.localCheckout?.path === nonGit)?.localCheckout?.gitState).toBe('NON_GIT')
    expect(first.find((record) => record.localCheckout?.path === hidden)?.status).toBe('HIDDEN')
    expect(destination.registerDestination).toHaveBeenCalledTimes(2)

    const identities = new Map(first.map((record) => [record.localCheckout!.path, record.id]))
    await catalog.initialize(legacy)
    expect(store.list(true).map((record) => [record.localCheckout!.path, record.id])).toEqual(
      first.map((record) => [record.localCheckout!.path, identities.get(record.localCheckout!.path)])
    )
    expect(destination.registerDestination).toHaveBeenCalledTimes(2)
    store.close()
  })

  it('discovers new root children without duplicates and activates only available checkouts through CodeMap', async () => {
    const root = tempRoot()
    const data = tempRoot()
    const git = repository(root, 'git', true)
    const nonGit = repository(root, 'plain')
    const store = new RepositoryCatalogStore(join(data, 'catalog.db'))
    const catalog = new RepositoryCatalogService(store, new WorkspaceService())
    await catalog.importRoot(root)
    await catalog.importRoot(root)
    expect(catalog.list()).toHaveLength(2)

    const activeState: ActiveProjectState = { revision: 1, project: { id: 'runtime-id', path: git.replace(/\\/g, '/'), name: 'git' } }
    const codeMap = {
      openRepository: vi.fn(async () => undefined),
      getOpenProjects: vi.fn(() => [activeState.project!])
    }
    const active = { getState: vi.fn(() => ({ revision: 0, project: null })), activate: vi.fn(async () => activeState) }
    const runtime = new RepositoryRuntimeService(catalog, codeMap, active)
    const gitRecord = catalog.findByPath(git)!
    await expect(runtime.activate(gitRecord.id)).resolves.toEqual(activeState)
    expect(codeMap.openRepository).toHaveBeenCalledWith(git)
    expect(active.activate).toHaveBeenCalledWith('runtime-id')

    rmSync(nonGit, { recursive: true, force: true })
    await catalog.refresh(settings())
    const missing = catalog.findByPath(nonGit)!
    await expect(runtime.activate(missing.id)).rejects.toThrow('LOCAL_CHECKOUT_UNAVAILABLE')
    expect(catalog.list(true)).toContainEqual(expect.objectContaining({ id: missing.id, localCheckout: expect.objectContaining({ availability: 'MISSING' }) }))
    store.close()
  })

  it('ignores an obsolete activation that finishes after a newer catalog selection', async () => {
    const root = tempRoot()
    const a = repository(root, 'a')
    const b = repository(root, 'b')
    const store = new RepositoryCatalogStore(join(root, 'data', 'catalog.db'))
    const catalog = new RepositoryCatalogService(store, new WorkspaceService())
    const recordA = await catalog.importLocal(a)
    const recordB = await catalog.importLocal(b)
    let finishA!: () => void
    const codeMap = {
      openRepository: vi.fn((path: string) => path === a ? new Promise<void>((resolve) => { finishA = resolve }) : Promise.resolve()),
      getOpenProjects: vi.fn(() => [{ id: 'B', path: b.replace(/\\/g, '/'), name: 'b' }])
    }
    const stateB: ActiveProjectState = { revision: 1, project: { id: 'B', path: b.replace(/\\/g, '/'), name: 'b' } }
    const active = { getState: vi.fn(() => stateB), activate: vi.fn(async () => stateB) }
    const runtime = new RepositoryRuntimeService(catalog, codeMap, active)

    const first = runtime.activate(recordA.id)
    await runtime.activate(recordB.id)
    finishA()
    await first
    expect(active.activate).toHaveBeenCalledTimes(1)
    expect(active.activate).toHaveBeenCalledWith('B')
    store.close()
  })
})
