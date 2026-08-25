/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Validar a construção das seções de Context Enrichment (header, instruction file, git diffs e git logs) para a montagem final.
2. Provar que o header text é aplicado na montagem final e que o excesso de 16KB é rejeitado com erro claro.
3. Provar que o instruction file é lido quando válido e omitido com warning quando inexistente — sem abortar o fluxo.
4. Provar que git diff e git log são incluídos quando habilitados, respeitando o limite de commits.
5. Provar que o enriquecimento não invalida o cache por arquivo e que sua ausência preserva a retrocompatibilidade.

Mapa de Relacionamentos do Script

1. context-enrichment-service.ts
   - Tipo: Dependência Direta
   - Relação: Testa buildEnrichmentSections, clampLogsCount e MAX_HEADER_TEXT_LENGTH.
   - Criticidade: Alta

2. compression-service.ts
   - Tipo: Dependência Direta
   - Relação: Usa CompressionService (com adapter de teste fake) como prova de integração da aplicação das seções no documento final.
   - Criticidade: Alta

3. shared/types.ts
   - Tipo: Contrato / Interface
   - Relação: Consome o tipo ContextEnrichment para parametrizar o enriquecimento nestado.
   - Criticidade: Média

Invariantes do Script

1. Os testes de Git usam repositório Git real temporário com identidade local configurada — sem mocks de Git.
2. Diretórios temporários são sempre limpos ao final, de forma tolerante a lock do filesystem (Windows).
3. Caminhos absolutos e path traversal do instruction file nunca resultam em leitura de arquivo.
4. O enriquecimento não altera a cacheKey por arquivo — mesmo profileHash serve para documentos com enriquecimento diferente.
*/

import { describe, it, expect, vi, afterEach } from 'vitest'
import { CompressionService } from './compression-service'
import { buildEnrichmentSections, MAX_HEADER_TEXT_LENGTH } from './context-enrichment-service'
import type { RepomixAdapter } from './repomix-adapter'
import type { RepomixRequest } from './repomix-request'
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'

let warnSpy: ReturnType<typeof vi.spyOn>
afterEach(() => {
  warnSpy?.mockRestore()
})

// =============================================================================
// Helpers de teste — Context Enrichment
// =============================================================================

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ctxenrich_'))
}

async function cleanupDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 })
      }
      return
    } catch {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  // eslint-disable-next-line no-console
  console.warn(`[ctxenrich.test] cleanupDir falhou após 4 tentativas: ${dir}`)
}

function createFile(dir: string, relativePath: string, content: string): void {
  const fullPath = join(dir, relativePath)
  mkdirSync(dirname(fullPath), { recursive: true })
  writeFileSync(fullPath, content, 'utf-8')
}

class MockAdapter implements RepomixAdapter {
  calls = 0
  batchResults: Record<string, string> = {}

  async compressMultipleFiles(request: RepomixRequest): Promise<Record<string, string>> {
    this.calls++
    const result: Record<string, string> = {}
    for (const p of request.selectedFiles) result[p] = this.batchResults[p] ?? ''
    return result
  }

  async compressSingleFile(_request: RepomixRequest, relativePath: string): Promise<string> {
    this.calls++
    return this.batchResults[relativePath] ?? ''
  }

  async checkInstallation(): Promise<boolean> { return true }
  async generateDirectOutput(
    _request: RepomixRequest
  ): Promise<{ content: string; failed: boolean; reason?: string }> {
    return { content: '', failed: true, reason: 'stub not configured' }
  }
  parseBatchOutput(_stdout: string): Record<string, string> { return {} }
  parseJsonOutput(_stdout: string): Record<string, string> { return {} }
}

function gitSetup(dir: string, ...args: string[]): void {
  execSync(`git ${args.map(a => `"${a}"`).join(' ')}`, { cwd: dir, stdio: 'ignore' })
}

function initGitRepo(dir: string): void {
  gitSetup(dir, 'init')
  gitSetup(dir, 'config', 'user.email', 'test@test')
  gitSetup(dir, 'config', 'user.name', 'Test')
}
describe('Context Enrichment — Provas de Aceitação', () => {
  let tempDir: string

  afterEach(async () => {
    if (tempDir) await cleanupDir(tempDir)
    tempDir = ''
  })

  // PA-E01 — Header Text aplicado na montagem final
  describe('PA-E01 — Header Text aplicado na montagem final', () => {
    it('header aparece no documento final', async () => {
      tempDir = createTempDir()
      createFile(tempDir, 'a.ts', 'const a = 1')
      const mock = new MockAdapter()
      mock.batchResults = { 'a.ts': 'compressed_a' }
      const service = new CompressionService(mock)

      const result = await service.generateCompressionMarkdown(
        tempDir, ['a.ts'], undefined, 'plain',
        { headerText: 'Meu header' }
      )
      expect(result).toContain('## 📋 Contexto Adicional')
      expect(result).toContain('Meu header')
      expect(result).toContain('compressed_a')
    })
  })

  // PA-E02 — Header Text excedente rejeitado
  describe('PA-E02 — Header Text excedente rejeitado', () => {
    it('lança erro claro ao exceder 16KB', async () => {
      tempDir = createTempDir()
      const big = 'a'.repeat(MAX_HEADER_TEXT_LENGTH + 1)
      await expect(buildEnrichmentSections({ headerText: big }, tempDir)).rejects.toThrow(/16KB/)
    })
  })

  // PA-E03 — Instruction File existente aplicado
  describe('PA-E03 — Instruction File existente aplicado', () => {
    it('conteúdo do arquivo aparece no documento final', async () => {
      tempDir = createTempDir()
      createFile(tempDir, 'a.ts', 'const a = 1')
      createFile(tempDir, 'inst.md', 'conteudo de instrucoes')
      const mock = new MockAdapter()
      mock.batchResults = { 'a.ts': 'compressed_a' }
      const service = new CompressionService(mock)

      const result = await service.generateCompressionMarkdown(
        tempDir, ['a.ts'], undefined, 'plain',
        { instructionFilePath: 'inst.md' }
      )
      expect(result).toContain('## 📖 Instruções')
      expect(result).toContain('conteudo de instrucoes')
    })
  })

  // PA-E04 — Instruction File inexistente omitido gracefully
  describe('PA-E04 — Instruction File inexistente omitido gracefully', () => {
    it('não aborta e omite a seção com warning', async () => {
      tempDir = createTempDir()
      createFile(tempDir, 'a.ts', 'const a = 1')
      const mock = new MockAdapter()
      mock.batchResults = { 'a.ts': 'compressed_a' }
      const service = new CompressionService(mock)

      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const result = await service.generateCompressionMarkdown(
        tempDir, ['a.ts'], undefined, 'plain',
        { instructionFilePath: 'nao_existe.md' }
      )
      expect(result).toContain('compressed_a')
      expect(result).not.toContain('## 📖 Instruções')
      expect(warnSpy).toHaveBeenCalled()
    })
  })
// PA-E05 — Git Diffs incluídos
  describe('PA-E05 — Git Diffs incluídos', () => {
    it('seção de diffs aparece no documento final', async () => {
      tempDir = createTempDir()
      createFile(tempDir, 'a.ts', 'const a = 1')
      initGitRepo(tempDir)
      gitSetup(tempDir, 'add', '-A')
      gitSetup(tempDir, 'commit', '-m', 'init')
      // Alteração não staggeada no working tree → aparece no git diff
      writeFileSync(join(tempDir, 'a.ts'), 'const a = 2', 'utf-8')

      const mock = new MockAdapter()
      mock.batchResults = { 'a.ts': 'compressed_a' }
      const service = new CompressionService(mock)

      const result = await service.generateCompressionMarkdown(
        tempDir, ['a.ts'], undefined, 'plain',
        { includeDiffs: true }
      )
      expect(result).toContain('## 🔀 Alterações Recentes (Git Diff)')
      expect(result).toContain('diff --git')
    })
  })

  // PA-E06 — Git Logs incluídos com limite
  describe('PA-E06 — Git Logs incluídos com limite', () => {
    it('seção de logs aparece limitada ao includeLogsCount', async () => {
      tempDir = createTempDir()
      createFile(tempDir, 'a.ts', 'const a = 1')
      initGitRepo(tempDir)
      for (const msg of ['commit-um', 'commit-dois', 'commit-tres', 'commit-quatro']) {
        writeFileSync(join(tempDir, 'a.ts'), `const a = 1; // ${msg}`, 'utf-8')
        gitSetup(tempDir, 'add', '-A')
        gitSetup(tempDir, 'commit', '-m', msg)
      }

      const mock = new MockAdapter()
      mock.batchResults = { 'a.ts': 'compressed_a' }
      const service = new CompressionService(mock)

      const result = await service.generateCompressionMarkdown(
        tempDir, ['a.ts'], undefined, 'plain',
        { includeLogs: true, includeLogsCount: 3 }
      )
      expect(result).toContain('## 📜 Histórico Recente (Git Log)')
      expect(result).toContain('commit-quatro')
      expect(result).toContain('commit-dois')
      // 4 commits, limite 3 → o mais antigo fica fora do log
      expect(result).not.toContain('commit-um')
    })
  })

  // PA-E07 — Enriquecimento não afeta cache
  describe('PA-E07 — Enriquecimento não afeta cache', () => {
    it('mesmo profileHash = mesmo cache; documento final difere', async () => {
      tempDir = createTempDir()
      createFile(tempDir, 'a.ts', 'const a = 1')
      const mock = new MockAdapter()
      mock.batchResults = { 'a.ts': 'compressed_a' }
      const service = new CompressionService(mock)

      const rA = await service.generateCompressionMarkdown(
        tempDir, ['a.ts'], undefined, 'plain',
        { headerText: 'HEADER-A' }
      )
      expect(mock.calls).toBeGreaterThan(0)

      mock.calls = 0
      const rB = await service.generateCompressionMarkdown(
        tempDir, ['a.ts'], undefined, 'plain',
        { headerText: 'HEADER-B' }
      )
      // Cache hit — enriquecimento NÃO invalida o cache por arquivo
      expect(mock.calls).toBe(0)

      expect(rA).toContain('HEADER-A')
      expect(rA).not.toContain('HEADER-B')
      expect(rB).toContain('HEADER-B')
      expect(rB).not.toContain('HEADER-A')
      expect(rA).toContain('compressed_a')
      expect(rB).toContain('compressed_a')
      expect(rA).not.toBe(rB)
    })
  })

  // PA-E08 — Sem enriquecimento (retrocompatibilidade)
  describe('PA-E08 — Sem enriquecimento (retrocompatibilidade)', () => {
    it('documento idêntico ao comportamento anterior (sem seções de enriquecimento)', async () => {
      tempDir = createTempDir()
      createFile(tempDir, 'a.ts', 'const a = 1')
      const mock = new MockAdapter()
      mock.batchResults = { 'a.ts': 'compressed_a' }
      const service = new CompressionService(mock)

      const result = await service.generateCompressionMarkdown(tempDir, ['a.ts'])
      expect(result).not.toContain('## 📋 Contexto Adicional')
      expect(result).not.toContain('## 📖 Instruções')
      expect(result).not.toContain('## 🔀 Alterações Recentes')
      expect(result).not.toContain('## 📜 Histórico Recente')
      expect(result).toContain('# Code Compression —')
      expect(result).toContain('compressed_a')
    })
  })
})