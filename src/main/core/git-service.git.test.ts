/*
-T ---
*/

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { GitService } from './git-service'
import {
  createTempGitRepo,
  cleanupTempRepo,
  gitExec,
  writeFile,
  deleteFile,
  stageAll,
  commit,
  touch
} from './git-test-helpers'

describe('GitService', () => {
  // ─── Limitação Explícita (PA-07) ──────────────────────────────────────────
  // O mecanismo de timeout de runGit (10s) NÃO é exercitado de forma automatizada:
  // provocar um subprocesso travado seria não-determinístico e introduziria
  // flakiness. O timeout é coberto por revisão, não por teste automatizado.
  // PA-07 — Timeout: fora do escopo automatizado (decisão documentada).

  let repo: string
  const gitService = new GitService()

  afterEach(async () => {
    if (repo) await cleanupTempRepo(repo)
    repo = ''
  })

  async function setupRepo(): Promise<string> {
    repo = await createTempGitRepo()
    return repo
  }

  // ─── PA-01 — isGitRepository ──────────────────────────────────────────────
  describe('isGitRepository', () => {
    it('retorna true para um diretório criado com git init', async () => {
      await setupRepo()
      await expect(gitService.isGitRepository(repo)).resolves.toBe(true)
    })

    it('retorna false para um diretório temporário sem .git', async () => {
      const plain = mkdtempSync(join(tmpdir(), 'git_test_')) // sem git init
      await expect(gitService.isGitRepository(plain)).resolves.toBe(false)
      await cleanupTempRepo(plain)
    })

    // ACHADO/contrato atual: existsSync(dirPath/.git) não distingue `.git`
    // como diretório de `.git` como arquivo (worktree). Refinamento futuro além
    // desta Sprint. TODO(refinamento): tratar `.git` arquivo no isGitRepository.
  })

  // ─── PA-02 — getModifiedFiles (contrato pós-Sprint 1) ────────────────────
  describe('getModifiedFiles', () => {
    it('reporta arquivo modificado com changeType modified', async () => {
      repo = await setupRepo()
      writeFile(repo, 'a.ts', 'v1\n')
      await stageAll(repo)
      await commit(repo, 'init')

      writeFile(repo, 'a.ts', 'v2\n')
      const files = await gitService.getModifiedFiles(repo)
      const f = files.find((x) => x.relativePath === 'a.ts')
      expect(f?.changeType).toBe('modified')
    })

    it('reporta arquivo novo sem commit como added', async () => {
      repo = await setupRepo()
      writeFile(repo, 'new.ts', 'x\n')
      const files = await gitService.getModifiedFiles(repo)
      const f = files.find((x) => x.relativePath === 'new.ts')
      expect(f?.changeType).toBe('added')
    })

    it('expõe arquivo deletado com changeType deleted e metadados zerados (Sprint 1)', async () => {
      repo = await setupRepo()
      writeFile(repo, 'del.ts', 'old\n')
      await stageAll(repo)
      await commit(repo, 'init')

      deleteFile(repo, 'del.ts')
      const files = await gitService.getModifiedFiles(repo)
      const f = files.find((x) => x.relativePath === 'del.ts')
      expect(f?.changeType).toBe('deleted')
      expect(f?.mtime).toBe(0)
      expect(f?.size).toBe(0)
    })

    it('reporta arquivo untracked individual dentro de diretório', async () => {
      repo = await setupRepo()
      writeFile(repo, 'dir/sub.ts', 'x\n')
      const files = await gitService.getModifiedFiles(repo)
      const f = files.find((x) => x.relativePath === 'dir/sub.ts')
      expect(f?.changeType).toBe('added')
    })

    it('reporta caminho com acentos (utf-8) sem quebras', async () => {
      repo = await setupRepo()
      writeFile(repo, 'relatório.ts', 'x\n')
      const files = await gitService.getModifiedFiles(repo)
      const f = files.find((x) => x.relativePath === 'relatório.ts')
      expect(f?.changeType).toBe('added')
    })
it('exclui pastas internas da listagem', async () => {
      repo = await setupRepo()
      writeFile(repo, 'code_awareness/test.md', 'x')
      writeFile(repo, 'code_checkpoints/test.json', '{}')
      writeFile(repo, '.sprintdiff/test.md', 'x')
      writeFile(repo, 'ok.ts', 'x')

      const files = await gitService.getModifiedFiles(repo)
      const paths = files.map((f) => f.relativePath)
      expect(paths).toContain('ok.ts')
      expect(paths).not.toContain('code_awareness/test.md')
      expect(paths).not.toContain('code_checkpoints/test.json')
      expect(paths).not.toContain('.sprintdiff/test.md')
    })

    it('ordena por mtime descendente com timestamps distintos', async () => {
      repo = await setupRepo()
      writeFile(repo, 'f1.ts', 'x\n')
      writeFile(repo, 'f2.ts', 'x\n')
      writeFile(repo, 'f3.ts', 'x\n')
      await stageAll(repo)
      await commit(repo, 'init')

      writeFile(repo, 'f1.ts', 'v\n')
      touch(repo, 'f1.ts', 1000)
      writeFile(repo, 'f2.ts', 'v\n')
      touch(repo, 'f2.ts', 3000)
      writeFile(repo, 'f3.ts', 'v\n')
      touch(repo, 'f3.ts', 2000)

      const order = (await gitService.getModifiedFiles(repo)).map((f) => f.relativePath)
      expect(order).toEqual(['f2.ts', 'f3.ts', 'f1.ts'])
    })

    it('retorna [] e nunca lança para caminho inexistente', async () => {
      const ghost = join(tmpdir(), `git_ghost_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`)
      await expect(gitService.getModifiedFiles(ghost)).resolves.toEqual([])
      await cleanupTempRepo(ghost)
    })

    it('retorna [] para diretório que não é repositório Git', async () => {
      const plain = mkdtempSync(join(tmpdir(), 'git_test_')) // sem git init
      await expect(gitService.getModifiedFiles(plain)).resolves.toEqual([])
      await cleanupTempRepo(plain)
    })

    // PA-06 — staged + unstaged simultâneos (MM): código dominante M → modified
    it('mapeia estado MM (staged+unstaged) como modified', async () => {
      repo = await setupRepo()
      writeFile(repo, 'mm.ts', 'v1\n')
      await stageAll(repo)
      await commit(repo, 'init')

      writeFile(repo, 'mm.ts', 'v2\n')
      await stageAll(repo)
      writeFile(repo, 'mm.ts', 'v3\n') // deixa unstaged

      const files = await gitService.getModifiedFiles(repo)
      expect(files.find((x) => x.relativePath === 'mm.ts')?.changeType).toBe('modified')
    })

    // PA-06 — rename com código desconhecido (R → modified), nomes ASCII com espaço
    it('trata rename via git mv expondo o novo nome (código R cai em modified)', async (ctx) => {
      repo = await setupRepo()
      writeFile(repo, 'old file.txt', 'same\n')
      await stageAll(repo)
      await commit(repo, 'init')

      try {
        await gitExec(repo, ['mv', 'old file.txt', 'new file.txt'])
      } catch {
        // git mv indisponível/diferente neste ambiente: pula com motivo explícito.
        ctx.skip('git mv não suportado neste ambiente')
        return
      }

      const files = await gitService.getModifiedFiles(repo)
      expect(files.some((f) => f.relativePath === 'new file.txt')).toBe(true)
    })

    // PA-06 — core.quotePath true (padrão) com não-ASCII deletado:
    // o escaped octal não é decodificado pelo parser, mas o ramo deleted (Sprint 1) ainda o expõe.
    it('expõe deletado não-ASCII com core.quotePath true (sem decodificar octal)', async () => {
      repo = await setupRepo()
      await gitExec(repo, ['config', 'core.quotePath', 'true'])
      writeFile(repo, 'café.ts', 'x\n')
      await stageAll(repo)
      await commit(repo, 'init')

      deleteFile(repo, 'café.ts')
      const files = await gitService.getModifiedFiles(repo)
      // O parser remove aspas mas não decodifica \303\251; ainda assim a entrada
      // deleted é exposta (invariante Sprint 1). ACHADO: decodificação de octal é
      // refinamento futuro em parseGitStatus, fora desta Sprint.
      expect(files.some((f) => f.changeType === 'deleted')).toBe(true)
    })
  })

  // ─── PA-03 — getAllFiles (invariante nº 5 preservada para este método) ──
  describe('getAllFiles', () => {
    it('lista tracked + untracked sem duplicatas, sempre changeType tracked', async () => {
      repo = await setupRepo()
      writeFile(repo, 'a.ts', 'a\n')
      writeFile(repo, 'b.ts', 'b\n')
      await stageAll(repo)
      await commit(repo, 'init')

      writeFile(repo, 'untracked.ts', 'u\n')

      const files = await gitService.getAllFiles(repo)
      const paths = files.map((f) => f.relativePath)
      expect(new Set(paths).size).toBe(paths.length)
      expect(paths).toContain('a.ts')
      expect(paths).toContain('b.ts')
      expect(paths).toContain('untracked.ts')
      for (const f of files) expect(f.changeType).toBe('tracked')
    })

    it('exclui arquivos ausentes do disco (invariante nº 5)', async () => {
      repo = await setupRepo()
      writeFile(repo, 'gone.ts', 'x\n')
      await stageAll(repo)
      await commit(repo, 'init')

      deleteFile(repo, 'gone.ts')
      const files = await gitService.getAllFiles(repo)
      expect(files.some((f) => f.relativePath === 'gone.ts')).toBe(false)
    })

    it('exclui pastas internas', async () => {
      repo = await setupRepo()
      writeFile(repo, 'code_awareness/x.md', 'x')
      writeFile(repo, '.sprintdiff/y.md', 'x')
      writeFile(repo, 'ok.ts', 'x')
      const paths = (await gitService.getAllFiles(repo)).map((f) => f.relativePath)
      expect(paths).toContain('ok.ts')
      expect(paths).not.toContain('code_awareness/x.md')
      expect(paths).not.toContain('.sprintdiff/y.md')
    })

    it('ordena por mtime descendente', async () => {
      repo = await setupRepo()
      writeFile(repo, 'a.ts', 'a\n')
      writeFile(repo, 'b.ts', 'b\n')
      writeFile(repo, 'c.ts', 'c\n')
      await stageAll(repo)
      await commit(repo, 'init')

      touch(repo, 'c.ts', 3000)
      touch(repo, 'b.ts', 2000)
      touch(repo, 'a.ts', 1000)

      const order = (await gitService.getAllFiles(repo)).map((f) => f.relativePath)
      expect(order).toEqual(['c.ts', 'b.ts', 'a.ts'])
    })
  })
// ─── PA-04 — getModifiedHunks e getFileAtHead ────────────────────────────
  describe('getModifiedHunks e getFileAtHead', () => {
    it('retorna hunk correto para uma linha alterada', async () => {
      repo = await setupRepo()
      writeFile(repo, 'h.ts', 'a\nb\nc\nd\ne\n')
      await stageAll(repo)
      await commit(repo, 'init')

      writeFile(repo, 'h.ts', 'a\nb\nX\nd\ne\n')
      const hunks = await gitService.getModifiedHunks(repo, 'h.ts')
      expect(hunks.length).toBeGreaterThanOrEqual(1)
      const h = hunks[0]
      expect(h.oldStart).toBe(3)
      expect(h.oldCount).toBe(1)
      expect(h.start).toBe(3)
      expect(h.count).toBe(1)
    })

    it('getFileAtHead retorna conteúdo commitado, nunca o atual', async () => {
      repo = await setupRepo()
      writeFile(repo, 'f.ts', 'ORIG\n')
      await stageAll(repo)
      await commit(repo, 'init')

      writeFile(repo, 'f.ts', 'CURRENT\n')
      await expect(gitService.getFileAtHead(repo, 'f.ts')).resolves.toBe('ORIG\n')
    })

    it('getFileAtHead retorna null para arquivo inexistente no HEAD', async () => {
      repo = await setupRepo()
      writeFile(repo, 'f.ts', 'x\n')
      await stageAll(repo)
      await commit(repo, 'init')

      await expect(gitService.getFileAtHead(repo, 'ghost.ts')).resolves.toBeNull()
    })
  })

  // ─── PA-05 — getCurrentCommitHash ────────────────────────────────────────
  describe('getCurrentCommitHash', () => {
    it('retorna null sem commits e hash de 40 hex após commit', async () => {
      repo = await setupRepo()
      await expect(gitService.getCurrentCommitHash(repo)).resolves.toBeNull()

      writeFile(repo, 'a.ts', 'x\n')
      await stageAll(repo)
      await commit(repo, 'first')
      const hash = await gitService.getCurrentCommitHash(repo)
      expect(hash).toMatch(/^[0-9a-f]{40}$/)
    })
  })

  // ─── Sprint 1 (quotePath) — Regressão: caminhos não-ASCII ──────────────
  describe('quotePath — caminhos não-ASCII (Sprint 1)', () => {
    it('PA-01 — getModifiedFiles retorna caminho UTF-8 cru para arquivo modificado com acento', async () => {
      repo = await setupRepo()
      writeFile(repo, 'relatório.ts', 'a\n')
      await stageAll(repo)
      await commit(repo, 'init')
      writeFile(repo, 'relatório.ts', 'b\n')

      const files = await gitService.getModifiedFiles(repo)
      expect(files.some((f) => f.relativePath === 'relatório.ts' && f.changeType === 'modified')).toBe(true)
    })

    it('PA-02 — caminho UTF-8 cru para arquivo untracked com acento (added)', async () => {
      repo = await setupRepo()
      writeFile(repo, 'configuração.ts', 'x\n')

      const files = await gitService.getModifiedFiles(repo)
      const f = files.find((x) => x.relativePath === 'configuração.ts')
      expect(f?.changeType).toBe('added')
    })

    it('PA-03 — caminho UTF-8 cru para arquivo deletado com acento', async () => {
      repo = await setupRepo()
      writeFile(repo, 'análise.ts', 'x\n')
      await stageAll(repo)
      await commit(repo, 'init')

      deleteFile(repo, 'análise.ts')
      const files = await gitService.getModifiedFiles(repo)
      const f = files.find((x) => x.relativePath === 'análise.ts')
      expect(f?.changeType).toBe('deleted')
      expect(f?.mtime).toBe(0)
      expect(f?.size).toBe(0)
    })

    it('PA-04 — getAllFiles retorna caminho UTF-8 cru para arquivo tracked com acento', async () => {
      repo = await setupRepo()
      writeFile(repo, 'resumo.md', 'x\n')
      await stageAll(repo)
      await commit(repo, 'init')

      const files = await gitService.getAllFiles(repo)
      const f = files.find((x) => x.relativePath === 'resumo.md')
      expect(f?.changeType).toBe('tracked')
    })

    it('PA-05 — caminho ASCII com espaços continua funcionando', async () => {
      repo = await setupRepo()
      writeFile(repo, 'meu arquivo.txt', 'a\n')
      await stageAll(repo)
      await commit(repo, 'init')
      writeFile(repo, 'meu arquivo.txt', 'b\n')

      const files = await gitService.getModifiedFiles(repo)
      expect(files.some((x) => x.relativePath === 'meu arquivo.txt' && x.changeType === 'modified')).toBe(true)
    })

    it('PA-06 — renames continuam funcionando expondo o novo nome', async (ctx) => {
      repo = await setupRepo()
      writeFile(repo, 'antigo.ts', 'x\n')
      await stageAll(repo)
      await commit(repo, 'init')

      try {
        await gitExec(repo, ['mv', 'antigo.ts', 'novo.ts'])
      } catch {
        ctx.skip('git mv não suportado neste ambiente')
        return
      }

      const files = await gitService.getModifiedFiles(repo)
      expect(files.some((x) => x.relativePath === 'novo.ts')).toBe(true)
    })

    it('PA-07 — pastas internas continuam excluídas', async () => {
      repo = await setupRepo()
      writeFile(repo, 'code_awareness/x.md', 'x')
      writeFile(repo, 'ok.ts', 'x')

      const paths = (await gitService.getModifiedFiles(repo)).map((x) => x.relativePath)
      expect(paths).toContain('ok.ts')
      expect(paths).not.toContain('code_awareness/x.md')
    })
  })
})

// ─── checkIgnoreBatch — Membership Classification (Sprint 4) ─────────────────
describe('GitService.checkIgnoreBatch', () => {
  let repo = ''
  const gitService = new GitService()

  afterEach(async () => {
    if (repo) await cleanupTempRepo(repo)
    repo = ''
  })

  it('retorna Set vazio para repositório sem .gitignore', async () => {
    repo = await createTempGitRepo()
    writeFile(repo, 'src.ts', 'x')
    const result = await gitService.checkIgnoreBatch(repo, ['src.ts'])
    expect(result).toBeInstanceOf(Set)
    expect(result.has('src.ts')).toBe(false)
  })

  it('retorna path ignorado quando coberto pelo .gitignore da raiz', async () => {
    repo = await createTempGitRepo()
    writeFile(repo, '.gitignore', '*.log\n')
    writeFile(repo, 'build.log', 'x')
    await stageAll(repo)
    await commit(repo, 'init')

    const result = await gitService.checkIgnoreBatch(repo, ['build.log', 'src.ts'])
    expect(result.has('build.log')).toBe(true)
    expect(result.has('src.ts')).toBe(false)
  })

  it('respeita nested .gitignore em subdiretório', async () => {
    repo = await createTempGitRepo()
    writeFile(repo, '.gitignore', '')
    writeFile(repo, 'infra/gateway/.gitignore', '.wrangler/\n')
    writeFile(repo, 'infra/gateway/.wrangler/state.json', '{}')
    writeFile(repo, 'infra/gateway/src.ts', 'x')
    await stageAll(repo)
    await commit(repo, 'init')

    const result = await gitService.checkIgnoreBatch(repo, [
      'infra/gateway/.wrangler/state.json',
      'infra/gateway/src.ts'
    ])
    expect(result.has('infra/gateway/.wrangler/state.json')).toBe(true)
    expect(result.has('infra/gateway/src.ts')).toBe(false)
  })

  it('retorna Set vazio para lista vazia de paths', async () => {
    repo = await createTempGitRepo()
    const result = await gitService.checkIgnoreBatch(repo, [])
    expect(result.size).toBe(0)
  })

  it('retorna Set vazio (fail-open) quando o processo git falha', async () => {
    const result = await gitService.checkIgnoreBatch('/nonexistent/path/that/does/not/exist', ['file.ts'])
    expect(result).toBeInstanceOf(Set)
    expect(result.size).toBe(0)
  })

  describe('Git Write Primitives (Academy boundary)', () => {
    it('stages only specified paths and excludes external files from commit', async () => {
      repo = await createTempGitRepo()
      // Initial commit so HEAD exists
      writeFile(repo, 'README.md', '# Initial')
      await stageAll(repo)
      await commit(repo, 'initial')

      // Modify both inside skills/ and outside skills/
      writeFile(repo, 'skills/my-skill/SKILL.md', '---\nname: my-skill\n---\n# My Skill')
      writeFile(repo, 'external-file.txt', 'do not stage me')

      expect(await gitService.hasWorkingTreeChanges(repo, 'skills')).toBe(true)
      expect(await gitService.hasStagedChanges(repo)).toBe(false)

      // Stage only skills
      await gitService.stagePaths(repo, ['skills'])
      expect(await gitService.hasStagedChanges(repo)).toBe(true)

      // Commit
      const sha = await gitService.commit(repo, 'Academy sync: 1 skills (hash123)')
      expect(sha).toBeDefined()
      expect(sha?.length).toBe(40)

      // Working tree in skills is clean, but external-file.txt is still untracked!
      expect(await gitService.hasWorkingTreeChanges(repo, 'skills')).toBe(false)
      const modified = await gitService.getModifiedFiles(repo)
      expect(modified.map((f) => f.relativePath)).toEqual(['external-file.txt'])

      // Calling commit again with nothing staged returns null (no empty commit)
      const secondSha = await gitService.commit(repo, 'noop commit')
      expect(secondSha).toBeNull()
    })
  })
})

