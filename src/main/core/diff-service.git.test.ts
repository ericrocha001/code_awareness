/*
-T ---
*/

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { DiffService, MAX_FILE_SIZE } from './diff-service'
import { GitService } from './git-service'
import {
  createTempGitRepo,
  cleanupTempRepo,
  writeFile,
  deleteFile,
  stageAll,
  commit
} from './git-test-helpers'

describe('DiffService', () => {
  let repo: string

  function makeService(): DiffService {
    // Sprint 2: injeta o GitService explicitamente para validar a injeção de dependência.
    return new DiffService(new GitService())
  }

  afterEach(async () => {
    if (repo) await cleanupTempRepo(repo)
    repo = ''
  })

  async function setupRepo(): Promise<string> {
    repo = await createTempGitRepo()
    return repo
  }

  // ─── PA-08 — Caso vazio ──────────────────────────────────────────────────
  describe('caso vazio', () => {
    it('retorna mensagem padrão quando não há alterações', async () => {
      await setupRepo()
      const service = makeService()
      await expect(service.generateSemanticDiff(repo)).resolves.toBe('# Nenhuma alteração detectada.')
    })
  })

  // ─── PA-09 — selectedFiles (três estados) ────────────────────────────────
  describe('selectedFiles', () => {
    async function seedTwoModified(): Promise<string> {
      const r = await setupRepo()
      writeFile(r, 'f1.ts', '1\n2\n3\n')
      writeFile(r, 'f2.ts', 'a\nb\nc\n')
      await stageAll(r)
      await commit(r, 'init')

      writeFile(r, 'f1.ts', '1\nCHANGED\n3\n')
      writeFile(r, 'f2.ts', 'a\nCHANGED\nc\n')
      return r
    }

    it('undefined processa todos os modificados', async () => {
      const r = await seedTwoModified()
      const out = await makeService().generateSemanticDiff(r, undefined)
      expect(out).toContain('## 📄 `f1.ts` (modificado)')
      expect(out).toContain('## 📄 `f2.ts` (modificado)')
    })

    // ACHADO de contrato (não é bug): `[]` é truthy mas `selectedFiles.length > 0`
    // é false, então o código cai no mesmo ramo de `undefined` e processa todos.
    it('array vazio comporta-se como undefined (processa todos)', async () => {
      const r = await seedTwoModified()
      const out = await makeService().generateSemanticDiff(r, [])
      expect(out).toContain('## 📄 `f1.ts` (modificado)')
      expect(out).toContain('## 📄 `f2.ts` (modificado)')
    })

    it('subconjunto processa apenas a interseção e ignora inexistentes', async () => {
      const r = await seedTwoModified()
      const service = makeService()

      const subset = await service.generateSemanticDiff(r, ['f1.ts'])
      expect(subset).toContain('## 📄 `f1.ts` (modificado)')
      expect(subset).not.toContain('f2.ts')

      // Caminho inexistente na lista de modificados é descartado silenciosamente.
      const ghostOnly = await service.generateSemanticDiff(r, ['ghost.ts'])
      expect(ghostOnly).toBe('# Nenhuma alteração detectada.')
    })
  })
// ─── PA-10 — Formatos de seção ────────────────────────────────────────────
  describe('formatos de seção', () => {
    it('adicionado: cabeçalho (adicionado) com bloco positivo contendo o conteúdo integral', async () => {
      await setupRepo()
      writeFile(repo, 'new.ts', 'const x = 1\n')
      const out = await makeService().generateSemanticDiff(repo)
      expect(out).toContain('## 📄 `new.ts` (adicionado)')
      expect(out).toContain('*(Nenhuma versão anterior identificada)*')
      expect(out).toContain('const x = 1')
    })

    it('modificado: cabeçalho (modificado) com hunks e blocos 🟥/🟩', async () => {
      const r = await setupRepo()
      writeFile(r, 'm.ts', '1\n2\n3\n')
      await stageAll(r)
      await commit(r, 'init')

      writeFile(r, 'm.ts', '1\nX2\n3\n')
      const out = await makeService().generateSemanticDiff(r)
      expect(out).toContain('## 📄 `m.ts` (modificado)')
      expect(out).toContain('### 🔍 Hunk 1')
      expect(out).toContain('#### 🟥 [Código Original / Removido]')
      expect(out).toContain('#### 🟩 [Código Novo / Adicionado]')
    })

    it('deletado: cabeçalho (excluído) com conteúdo do HEAD no bloco negativo (Sprint 1)', async () => {
      const r = await setupRepo()
      writeFile(r, 'del.ts', 'OLDCONTENT\n')
      await stageAll(r)
      await commit(r, 'init')

      deleteFile(r, 'del.ts')
      const out = await makeService().generateSemanticDiff(r)
      expect(out).toContain('## 📄 `del.ts` (excluído)')
      expect(out).toContain('#### 🟥 [Código Original / Removido]')
      expect(out).toContain('OLDCONTENT')
    })
  })
// ─── PA-11 — Fronteira de 2 MB ───────────────────────────────────────────
  describe('fronteira de 2 MB', () => {
    function contentOf(bytes: number): string {
      return Buffer.alloc(bytes, 0x61).toString('utf-8') // 'a' repetido
    }

    it('arquivo de exatamente 2 MB é processado (código usa >)', async () => {
      await setupRepo()
      writeFile(repo, 'big.ts', contentOf(MAX_FILE_SIZE))
      const out = await makeService().generateSemanticDiff(repo)
      expect(out).toContain('## 📄 `big.ts` (adicionado)')
      expect(out).not.toContain('Arquivo muito grande para gerar o diff semântico')
    })

    it('arquivo de 2 MB + 1 byte retorna aviso de arquivo muito grande', async () => {
      await setupRepo()
      writeFile(repo, 'big.ts', contentOf(MAX_FILE_SIZE + 1))
      const out = await makeService().generateSemanticDiff(repo)
      expect(out).toContain('*Arquivo muito grande para gerar o diff semântico (> 2MB).*')
    })

    it('deletado com conteúdo histórico > 2 MB retorna aviso específico', async () => {
      const r = await setupRepo()
      writeFile(r, 'huge.ts', contentOf(MAX_FILE_SIZE + 1))
      await stageAll(r)
      await commit(r, 'init')

      deleteFile(r, 'huge.ts')
      const out = await makeService().generateSemanticDiff(r)
      expect(out).toContain('*Arquivo original removido era muito grande (> 2MB).*')
    })
  })
// ─── PA-12 — Múltiplos hunks ──────────────────────────────────────────────
  describe('múltiplos hunks', () => {
    it('gera duas seções de hunk para duas regiões modificadas', async () => {
      const r = await setupRepo()
      writeFile(r, 'multi.ts', '1\n2\n3\n4\n5\n6\n')
      await stageAll(r)
      await commit(r, 'init')

      writeFile(r, 'multi.ts', '1\nX2\n3\n4\nY5\n6\n')
      const out = await makeService().generateSemanticDiff(r)
      const hunks = out.match(/### 🔍 Hunk \d+/g) ?? []
      expect(hunks.length).toBe(2)
      expect(out).toContain('(Linha 2 ➔ Linha 2)')
      expect(out).toContain('(Linha 5 ➔ Linha 5)')
    })
  })

  // ─── PA-13 — Robustez ────────────────────────────────────────────────────
  describe('robustez', () => {
    it('caminho não-Git nunca propaga exceção', async () => {
      const plain = mkdtempSync(join(tmpdir(), 'git_test_')) // sem git init
      repo = plain
      const service = makeService()
      const out = await service.generateSemanticDiff(plain)
      expect(typeof out).toBe('string')
    })
  })
})