/**
 * Provas de integridade do MembershipPort integrado ao RepositoryModel.
 *
 * Valida que discovery (indexRepository, reconcileWithDisk) e intake incremental
 * usam a mesma semântica canônica de membership: arquivos cobertos por .gitignore
 * (raiz ou nested) não aparecem no índice e não são tratados como "unexpected".
 *
 * Lane: Native — requer SQLite (better-sqlite3) + Git real.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { RepositoryFileMembership } from './repository-file-membership'
import { GitService } from './git-service'
import { createRepositoryModel } from './repository-model'
import { closeRepositoryDatabase } from './repository-database'
import {
  createTempGitRepo,
  writeFile as gitWrite,
  stageAll,
  commit,
  cleanupTempRepo
} from './git-test-helpers'

describe('RepositoryModel + MembershipPort — Git real', () => {
  let repo = ''

  afterEach(async () => {
    if (repo) {
      closeRepositoryDatabase(repo)
      await cleanupTempRepo(repo)
    }
    repo = ''
  })

  it('indexRepository não inclui arquivos cobertos por .gitignore da raiz', async () => {
    repo = await createTempGitRepo()
    gitWrite(repo, '.gitignore', '*.log\nbuild/\n')
    gitWrite(repo, 'src/main.ts', 'export const x = 1\n')
    gitWrite(repo, 'build.log', 'log content')
    mkdirSync(join(repo, 'build'), { recursive: true })
    writeFileSync(join(repo, 'build', 'output.js'), 'bundle', 'utf-8')
    await stageAll(repo)
    await commit(repo, 'init')

    const membership = new RepositoryFileMembership(repo, new GitService())
    const model = createRepositoryModel(repo, undefined, membership)

    await model.indexRepository()

    const paths = model.getFiles().map(f => f.relativePath)

    expect(paths).toContain('src/main.ts')
    expect(paths).not.toContain('build.log')
    expect(paths).not.toContain('build/output.js')
  })

  it('indexRepository não inclui arquivos cobertos por nested .gitignore', async () => {
    repo = await createTempGitRepo()
    gitWrite(repo, '.gitignore', '')
    gitWrite(repo, 'infra/gateway/.gitignore', '.wrangler/\n')
    gitWrite(repo, 'infra/gateway/.wrangler/state.json', '{"key":"val"}')
    gitWrite(repo, 'infra/gateway/src.ts', 'export const x = 1\n')
    gitWrite(repo, 'src/app.ts', 'export const app = 1\n')
    await stageAll(repo)
    await commit(repo, 'init')

    const membership = new RepositoryFileMembership(repo, new GitService())
    const model = createRepositoryModel(repo, undefined, membership)

    await model.indexRepository()

    const paths = model.getFiles().map(f => f.relativePath)

    expect(paths).toContain('infra/gateway/src.ts')
    expect(paths).toContain('src/app.ts')
    expect(paths).not.toContain('infra/gateway/.wrangler/state.json')
  })

  it('reconcileWithDisk não indexa arquivos ignorados como unexpected', async () => {
    repo = await createTempGitRepo()
    gitWrite(repo, '.gitignore', '*.log\n')
    gitWrite(repo, 'src/main.ts', 'export const x = 1\n')
    await stageAll(repo)
    await commit(repo, 'init')

    const membership = new RepositoryFileMembership(repo, new GitService())
    const model = createRepositoryModel(repo, undefined, membership)

    await model.indexRepository()
    expect(model.getFiles().map(f => f.relativePath)).toContain('src/main.ts')

    // Arquivo ignorado aparece após indexação
    gitWrite(repo, 'debug.log', 'log content')

    const result = await model.reconcileWithDisk({ indexUnexpected: true })

    expect(model.getFiles().map(f => f.relativePath)).not.toContain('debug.log')
    expect(result.indexedUnexpected).toBe(0)
  })

  it('reconcileWithDisk indexa novo arquivo elegível como unexpected', async () => {
    repo = await createTempGitRepo()
    gitWrite(repo, '.gitignore', '*.log\n')
    gitWrite(repo, 'src/existing.ts', 'export const x = 1\n')
    await stageAll(repo)
    await commit(repo, 'init')

    const membership = new RepositoryFileMembership(repo, new GitService())
    const model = createRepositoryModel(repo, undefined, membership)

    await model.indexRepository()

    gitWrite(repo, 'src/new.ts', 'export const y = 2\n')

    const result = await model.reconcileWithDisk({ indexUnexpected: true })

    expect(model.getFiles().map(f => f.relativePath)).toContain('src/new.ts')
    expect(result.indexedUnexpected).toBeGreaterThan(0)
  })

  it('sem membership: comportamento legado preservado', async () => {
    repo = await createTempGitRepo()
    gitWrite(repo, 'src/main.ts', 'export const x = 1\n')
    await stageAll(repo)
    await commit(repo, 'init')

    const model = createRepositoryModel(repo)
    await model.indexRepository()

    expect(model.getFiles().some(f => f.relativePath === 'src/main.ts')).toBe(true)
  })
})
