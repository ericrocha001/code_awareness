import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { AppSettings } from '../../shared/types'
import { AcademyService } from '../academy/academy-service'
import { ActiveProjectService } from '../core/active-project-service'
import { CodeMapService } from '../core/code-map-service'
import type { CompressionPort } from '../core/compression-port'
import { WatcherService } from '../core/watcher-service'
import { WorkspaceService } from '../core/workspace-service'
import { RepositoryCatalogService } from './repository-catalog-service'
import { RepositoryCatalogStore } from './repository-catalog-store'
import { RepositoryRuntimeService } from './repository-runtime-service'

const unusedCompression: CompressionPort = {
  async generateCompressionMarkdown() { throw new Error('not used') }
}

it('accepts real Git, Non-Git, Missing, reopen, restore, CodeMap activation, and Academy destinations', async () => {
  const root = mkdtempSync(join(tmpdir(), 'repository-catalog-acceptance-'))
  const data = mkdtempSync(join(tmpdir(), 'repository-catalog-data-'))
  const create = (name: string, git = false) => {
    const path = join(root, name)
    mkdirSync(join(path, 'src'), { recursive: true })
    if (git) mkdirSync(join(path, '.git'))
    writeFileSync(join(path, 'src', 'index.ts'), `export const name = '${name}'\n`)
    return path
  }
  const gitPath = create('git-repository', true)
  const nonGitPath = create('plain-repository')
  const missingPath = create('missing-repository')
  const settings: AppSettings = {
    rootFolders: [root], individualProjects: [], hiddenProjects: [], ignoredDiffFiles: {}, tags: {}, fileTags: {}, projectPreferences: {}
  }
  const academy = new AcademyService(join(data, 'academy.db'))
  const academyDestinations = {
    registerDestination: async (path: string, name: string) => academy.store.upsertDestination(path, name, true)
  }
  const databasePath = join(data, 'repositories', 'catalog.db')
  let store = new RepositoryCatalogStore(databasePath)
  let catalog = new RepositoryCatalogService(store, new WorkspaceService(), academyDestinations)
  const watcher = new WatcherService()
  const codeMap = new CodeMapService(watcher, unusedCompression)
  const activeProjects = new ActiveProjectService(codeMap)

  try {
    await catalog.initialize(settings)
    const initial = catalog.list()
    expect(initial).toHaveLength(3)
    expect(initial.find((record) => record.localCheckout?.path === gitPath)?.localCheckout?.gitState).toBe('GIT')
    expect(initial.find((record) => record.localCheckout?.path === nonGitPath)?.localCheckout?.gitState).toBe('NON_GIT')
    expect(academy.store.listDestinations().map((item) => item.path).sort()).toEqual([gitPath, missingPath, nonGitPath].sort())

    const missingId = catalog.findByPath(missingPath)!.id
    rmSync(missingPath, { recursive: true, force: true })
    await catalog.refresh(settings)
    expect(catalog.findByPath(missingPath)).toMatchObject({ id: missingId, localCheckout: { availability: 'MISSING' } })

    const runtime = new RepositoryRuntimeService(catalog, codeMap, activeProjects)
    for (const path of [gitPath, nonGitPath]) {
      const record = catalog.findByPath(path)!
      const state = await runtime.activate(record.id)
      expect(state.project?.path).toBe(path.replace(/\\/g, '/'))
      await codeMap.indexRepository(path)
      expect(codeMap.getFiles(path).map((file) => file.relativePath)).toContain('src/index.ts')
    }
    await expect(runtime.activate(missingId)).rejects.toThrow('LOCAL_CHECKOUT_UNAVAILABLE')

    store.close()
    store = new RepositoryCatalogStore(databasePath)
    catalog = new RepositoryCatalogService(store, new WorkspaceService(), academyDestinations)
    expect(catalog.findByPath(missingPath)?.id).toBe(missingId)
    mkdirSync(join(missingPath, 'src'), { recursive: true })
    writeFileSync(join(missingPath, 'src', 'index.ts'), 'export const restored = true\n')
    await catalog.refresh(settings)
    expect(catalog.findByPath(missingPath)).toMatchObject({ id: missingId, localCheckout: { availability: 'AVAILABLE' } })
  } finally {
    await activeProjects.dispose()
    codeMap.closeAll()
    watcher.stop()
    store.close()
    academy.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(data, { recursive: true, force: true })
  }
}, 60_000)
