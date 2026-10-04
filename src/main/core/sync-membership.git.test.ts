/**
 * Testes de RepositoryFileMembership com Git real e provas de consistência
 * entre discovery e incremental intake ao nível de membership (sem SQLite).
 *
 * Lane: Git — requer processos Git reais e repositórios temporários.
 * Não misturar com a lane Node (*.test.ts) que deve ser rápida e sem spawns.
 * Os testes que usam RepositoryModel (SQLite) estão em codemap-membership.e2e.test.ts.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { RepositoryFileMembership } from './repository-file-membership'
import { GitService } from './git-service'
import {
  createTempGitRepo,
  writeFile as gitWrite,
  stageAll,
  commit,
  cleanupTempRepo
} from './git-test-helpers'

// ─── RepositoryFileMembership — Git real ─────────────────────────────────────

describe('RepositoryFileMembership — Git real', () => {
  let repo = ''

  afterEach(async () => {
    if (repo) {
      await cleanupTempRepo(repo)
    }
    repo = ''
  })

  it('arquivo raiz coberto por .gitignore é classified como ignored', async () => {
    repo = await createTempGitRepo()
    gitWrite(repo, '.gitignore', '*.log\n')
    gitWrite(repo, 'build.log', 'log')
    await stageAll(repo)
    await commit(repo, 'init')

    const m = new RepositoryFileMembership(repo, new GitService())
    expect(await m.classify('build.log')).toBe('ignored')
  })

  it('arquivo não ignorado em repositório Git é eligible', async () => {
    repo = await createTempGitRepo()
    gitWrite(repo, '.gitignore', '*.log\n')
    gitWrite(repo, 'main.ts', 'export const x = 1\n')
    await stageAll(repo)
    await commit(repo, 'init')

    const m = new RepositoryFileMembership(repo, new GitService())
    expect(await m.classify('main.ts')).toBe('eligible')
  })

  it('nested .gitignore: infra/gateway/.wrangler é ignored', async () => {
    repo = await createTempGitRepo()
    gitWrite(repo, '.gitignore', '')
    gitWrite(repo, 'infra/gateway/.gitignore', '.wrangler/\n')
    gitWrite(repo, 'infra/gateway/.wrangler/state.json', '{}')
    gitWrite(repo, 'infra/gateway/src.ts', 'x')
    await stageAll(repo)
    await commit(repo, 'init')

    const m = new RepositoryFileMembership(repo, new GitService())
    const batch = await m.classifyBatch(['infra/gateway/.wrangler/state.json', 'infra/gateway/src.ts'])
    expect(batch.get('infra/gateway/.wrangler/state.json')).toBe('ignored')
    expect(batch.get('infra/gateway/src.ts')).toBe('eligible')
  })

  it('continuum inbox path é ignored quando coberto por .gitignore', async () => {
    repo = await createTempGitRepo()
    gitWrite(repo, '.gitignore', '.code-awareness/\n')
    gitWrite(repo, '.code-awareness/continuum/inbox/artifact.json', '{}')
    gitWrite(repo, 'src.ts', 'x')
    await stageAll(repo)
    await commit(repo, 'init')

    const m = new RepositoryFileMembership(repo, new GitService())
    const batch = await m.classifyBatch(['.code-awareness/continuum/inbox/artifact.json', 'src.ts'])
    expect(batch.get('.code-awareness/continuum/inbox/artifact.json')).toBe('ignored')
    expect(batch.get('src.ts')).toBe('eligible')
  })

  it('filterEligible retorna somente paths eligible', async () => {
    repo = await createTempGitRepo()
    gitWrite(repo, '.gitignore', '*.log\n')
    gitWrite(repo, 'main.ts', 'export const x = 1\n')
    gitWrite(repo, 'build.log', 'log')
    await stageAll(repo)
    await commit(repo, 'init')

    const m = new RepositoryFileMembership(repo, new GitService())
    const eligible = await m.filterEligible(['main.ts', 'build.log'])
    expect(eligible).toContain('main.ts')
    expect(eligible).not.toContain('build.log')
  })

  it('initial discovery e incremental intake concordam sobre membership', async () => {
    repo = await createTempGitRepo()
    gitWrite(repo, '.gitignore', 'dist/\n*.log\n')
    gitWrite(repo, 'src/main.ts', 'export const x = 1\n')
    gitWrite(repo, 'dist/bundle.js', 'bundle')
    gitWrite(repo, 'build.log', 'log')
    gitWrite(repo, 'README.md', '# test')
    await stageAll(repo)
    await commit(repo, 'init')

    const git = new GitService()
    const m = new RepositoryFileMembership(repo, git)

    // Candidatos da descoberta inicial (via git ls-files)
    const candidates = await git.listAllFiles(repo)
    const candidatePaths = candidates.map(c => c.relativePath)

    // git ls-files não retorna ignorados — portanto nenhum deve ser 'ignored' pelo membership
    const batch = await m.classifyBatch(candidatePaths)
    for (const [, cls] of batch) {
      expect(cls).not.toBe('ignored')
    }

    // Arquivos ignorados não aparecem nos candidatos
    expect(candidatePaths).not.toContain('dist/bundle.js')
    expect(candidatePaths).not.toContain('build.log')
    // Arquivos elegíveis aparecem
    expect(candidatePaths).toContain('src/main.ts')
    expect(candidatePaths).toContain('README.md')
  })
})
