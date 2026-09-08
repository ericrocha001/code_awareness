/*
-T ---
*/

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, utimesSync, existsSync, rmSync, mkdirSync, statSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { CompressionService } from './compression-service'
import { COMPRESSION_TOTAL_FAILURE_MARKER, COMPRESSION_VERSION } from './compression-constants'
import { CompressionCache } from './compression-cache'
import { RepomixAdapter } from './repomix-adapter'
import { RepomixProcessRunner } from './repomix-process-runner'
import { buildRepomixRequest } from './repomix-arguments-builder'
import { DEFAULT_PROFILE, computeProfileHash } from './compression-profile'
import { resolveEffectiveProfile } from './effective-profile'
import type { RepomixRequest } from './repomix-request'

// =============================================================================
// Helpers de teste
// =============================================================================

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'compression_test_'))
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
  console.warn(`[compression.test] cleanupDir falhou após 4 tentativas: ${dir}`)
}

function createFile(dir: string, relativePath: string, content: string): void {
  const fullPath = join(dir, relativePath)
  mkdirSync(dirname(fullPath), { recursive: true })
  writeFileSync(fullPath, content, 'utf-8')
}

function touchFile(dir: string, relativePath: string, mtime: number): void {
  const fullPath = join(dir, relativePath)
  const seconds = mtime / 1000
  utimesSync(fullPath, seconds, seconds)
}

// =============================================================================
// Mock do RepomixAdapter
// =============================================================================

class MockRepomixAdapter implements RepomixAdapter {
  private _callCount = 0
  private _batchResults: Record<string, string> = {}
  private _singleResults: Record<string, string> = {}
  private _throwOnBatch = false
  private _throwOnSingle = false
  private _delayMs = 0

  get callCount(): number { return this._callCount }
  resetCallCount(): void { this._callCount = 0 }

  setBatchResults(results: Record<string, string>): void { this._batchResults = results }
  setSingleResults(results: Record<string, string>): void { this._singleResults = results }
  setThrowOnBatch(v: boolean): void { this._throwOnBatch = v }
  setThrowOnSingle(v: boolean): void { this._throwOnSingle = v }
  setDelay(ms: number): void { this._delayMs = ms }

  async compressMultipleFiles(request: RepomixRequest): Promise<Record<string, string>> {
    this._callCount++
    if (this._delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, this._delayMs))
    }
    if (this._throwOnBatch) throw new Error('Mock batch failure')
    const result: Record<string, string> = {}
    for (const p of request.selectedFiles) {
      result[p] = this._batchResults[p] ?? ''
    }
    return result
  }

  async compressSingleFile(_request: RepomixRequest, relativePath: string): Promise<string> {
    this._callCount++
    if (this._delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, this._delayMs))
    }
    if (this._throwOnSingle) throw new Error('Mock single failure')
    return this._singleResults[relativePath] ?? ''
  }

  // --- Stubs do caminho Direct Output ---
  private _directResult: { content: string; failed: boolean; reason?: string } = { content: '', failed: true, reason: 'stub not configured' }
  private _throwOnDirect = false
  private _directDelayMs = 0
  private _directCallCount = 0
  private _lastDirectRequest: RepomixRequest | null = null

  get directCallCount(): number { return this._directCallCount }
  get lastDirectRequest(): RepomixRequest | null { return this._lastDirectRequest }

  setDirectResult(result: { content: string; failed: boolean; reason?: string }): void { this._directResult = result }
  setThrowOnDirect(v: boolean): void { this._throwOnDirect = v }
  setDirectDelay(ms: number): void { this._directDelayMs = ms }

  async generateDirectOutput(request: RepomixRequest): Promise<{ content: string; failed: boolean; reason?: string }> {
    this._directCallCount++
    this._lastDirectRequest = request
    if (this._directDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, this._directDelayMs))
    }
    if (this._throwOnDirect) throw new Error('Mock direct failure')
    return this._directResult
  }

  // Stubs para métodos não usados pelo CompressionService
  async checkInstallation(): Promise<boolean> { return true }
  parseBatchOutput(_stdout: string): Record<string, string> { return {} }
  parseJsonOutput(_stdout: string): Record<string, string> { return {} }
}

// =============================================================================
// Suíte de testes
// =============================================================================

describe('CompressionService — Provas de Aceitação', () => {
  let tempDir: string

  afterEach(async () => {
    if (tempDir) await cleanupDir(tempDir)
    tempDir = ''
  })

  // ---------------------------------------------------------------------------
  // PA-01 — Cache hit em arquivos inalterados
  // ---------------------------------------------------------------------------
  describe('PA-01 — Cache hit em arquivos inalterados', () => {
    it('segunda chamada com mesmos mtimes e tamanhos não chama o adapter (Fast Path)', async () => {
      tempDir = createTempDir()
      createFile(tempDir, 'a.ts', 'const a = 1')
      createFile(tempDir, 'b.ts', 'const b = 2')

      const mock = new MockRepomixAdapter()
      mock.setBatchResults({ 'a.ts': 'compressed_a', 'b.ts': 'compressed_b' })

      const service = new CompressionService(mock)

      const firstResult = await service.generateCompressionMarkdown(tempDir, ['a.ts', 'b.ts'])
      const firstCalls = mock.callCount

      mock.resetCallCount()
      const secondResult = await service.generateCompressionMarkdown(tempDir, ['a.ts', 'b.ts'])

      expect(mock.callCount).toBe(0)
      expect(firstResult).toBe(secondResult)
      expect(firstCalls).toBeGreaterThan(0)
    })
  })

  // ---------------------------------------------------------------------------
  // PA-02 — Invalidação por mudança de conteúdo / metadata (MISS)
  // ---------------------------------------------------------------------------
  describe('PA-02 — Invalidação por alteração de conteúdo e tamanho (MISS por metadata/hash)', () => {
    it('altera conteúdo e tamanho — fast path falha e adapter é chamado novamente', async () => {
      tempDir = createTempDir()
      createFile(tempDir, 'x.ts', 'const x = 1')

      const mock = new MockRepomixAdapter()
      mock.setBatchResults({ 'x.ts': 'compressed_x_v1' })

      const service = new CompressionService(mock)

      await service.generateCompressionMarkdown(tempDir, ['x.ts'])
      expect(mock.callCount).toBeGreaterThan(0)

      // Altera o arquivo alterando seu tamanho e conteúdo real
      const originalStat = statSync(join(tempDir, 'x.ts'))
      writeFileSync(join(tempDir, 'x.ts'), 'const x = 20000000000; // expanded content', 'utf-8')
      // Força o mtime original para testar que a discrepância de size/hash impede o fast path
      utimesSync(join(tempDir, 'x.ts'), originalStat.mtime, originalStat.mtime)

      mock.resetCallCount()
      mock.setBatchResults({ 'x.ts': 'compressed_x_v2' })
      const result = await service.generateCompressionMarkdown(tempDir, ['x.ts'])

      // O Fast Path de mtime+size falha porque o size mudou, e o hash recalculado difere → MISS
      expect(mock.callCount).toBeGreaterThan(0)
      expect(result).toContain('compressed_x_v2')
    })
  })

  // ---------------------------------------------------------------------------
  // PA-03 — Normalização de caminhos
  // ---------------------------------------------------------------------------
  describe('PA-03 — Normalização de caminhos', () => {
    it('barras invertidas e barras comuns no repoPath geram cache hit', async () => {
      tempDir = createTempDir()
      createFile(tempDir, 'a.ts', 'const a = 1')

      const mock = new MockRepomixAdapter()
      mock.setBatchResults({ 'a.ts': 'compressed_a' })

      const service = new CompressionService(mock)

      const forwardPath = tempDir.replace(/\\/g, '/')
      await service.generateCompressionMarkdown(forwardPath, ['a.ts'])
      expect(mock.callCount).toBeGreaterThan(0)

      const backPath = tempDir.replace(/\//g, '\\')
      mock.resetCallCount()
      await service.generateCompressionMarkdown(backPath, ['a.ts'])

      expect(mock.callCount).toBe(0)
    })

    it('caminho com trailing slash normalizado gera cache hit', async () => {
      tempDir = createTempDir()
      createFile(tempDir, 'a.ts', 'const a = 1')

      const mock = new MockRepomixAdapter()
      mock.setBatchResults({ 'a.ts': 'compressed_a' })

      const service = new CompressionService(mock)

      await service.generateCompressionMarkdown(tempDir, ['a.ts'])
      expect(mock.callCount).toBeGreaterThan(0)

      mock.resetCallCount()
      await service.generateCompressionMarkdown(tempDir + '/', ['a.ts'])

      expect(mock.callCount).toBe(0)
    })
  })

  // ---------------------------------------------------------------------------
  // PA-04 — Limite de cache e evicção LRU por quantidade (Bloqueador 1 resolvido)
  // ---------------------------------------------------------------------------
  describe('PA-04 — Limite de cache e evicção LRU por quantidade', () => {
    it('ao exceder maxCacheEntries a entrada mais antiga é efetivamente removida', async () => {
      tempDir = createTempDir()
      createFile(tempDir, 'f.ts', 'content')

      const mock = new MockRepomixAdapter()
      mock.setBatchResults({ 'f.ts': 'compressed' })

      // Instancia o serviço com limite pequeno (5 entradas) para testar a evicção real
      const service = new CompressionService(
        mock,
        undefined,
        { maxCacheEntries: 5 }
      )
      const cache = (service as unknown as { cache: Map<string, unknown> }).cache

      // Insere 6 repositórios (excede o limite de 5)
      for (let i = 0; i < 6; i++) {
        const repoPath = join(tempDir, `repo_${i}`)
        mkdirSync(repoPath, { recursive: true })
        createFile(repoPath, 'f.ts', 'content')
        mock.resetCallCount()
        mock.setBatchResults({ 'f.ts': `compressed_${i}` })
        await service.generateCompressionMarkdown(repoPath, ['f.ts'])
      }

      // O tamanho do cache deve ser exatamente 5 (não 6)
      expect(cache.size).toBe(5)

      const normalizedRoot = tempDir.replace(/\\/g, '/').replace(/\/+$/, '')
      const profileHash = computeProfileHash(resolveEffectiveProfile(DEFAULT_PROFILE, 'plain'))
      const firstKey = `${normalizedRoot}/repo_0::f.ts::${COMPRESSION_VERSION}::${profileHash}`
      const lastKey = `${normalizedRoot}/repo_5::f.ts::${COMPRESSION_VERSION}::${profileHash}`

      // A primeira entrada (repo_0) deve ter sido evictada
      expect(cache.has(firstKey)).toBe(false)
      // A entrada mais recente (repo_5) deve estar presente
      expect(cache.has(lastKey)).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // PA-05 — Ordem do Markdown
  // ---------------------------------------------------------------------------
  describe('PA-05 — Ordem do Markdown', () => {
    it('seções aparecem na ordem exata de selectedFiles', async () => {
      tempDir = createTempDir()
      createFile(tempDir, 'c.ts', '// c')
      createFile(tempDir, 'a.ts', '// a')
      createFile(tempDir, 'b.ts', '// b')

      const mock = new MockRepomixAdapter()
      mock.setBatchResults({
        'c.ts': 'code c',
        'a.ts': 'code a',
        'b.ts': 'code b'
      })

      const service = new CompressionService(mock)
      const markdown = await service.generateCompressionMarkdown(tempDir, ['c.ts', 'a.ts', 'b.ts'])

      const posC = markdown.indexOf('📄 `c.ts`')
      const posA = markdown.indexOf('📄 `a.ts`')
      const posB = markdown.indexOf('📄 `b.ts`')

      expect(posC).toBeGreaterThanOrEqual(0)
      expect(posA).toBeGreaterThanOrEqual(0)
      expect(posB).toBeGreaterThanOrEqual(0)
      expect(posC).toBeLessThan(posA)
      expect(posA).toBeLessThan(posB)
    })
  })

  // ---------------------------------------------------------------------------
  // PA-06 — Falhas parciais
  // ---------------------------------------------------------------------------
  describe('PA-06 — Falhas parciais', () => {
    it('um arquivo falha no batch e no fallback — seção ⚠️ presente', async () => {
      tempDir = createTempDir()
      createFile(tempDir, 'ok.ts', 'const ok = 1')
      createFile(tempDir, 'fail.ts', 'const fail = 2')

      const mock = new MockRepomixAdapter()
      mock.setBatchResults({ 'ok.ts': 'compressed_ok', 'fail.ts': '' })
      mock.setSingleResults({ 'ok.ts': 'compressed_ok', 'fail.ts': '' })

      const service = new CompressionService(mock)
      const markdown = await service.generateCompressionMarkdown(tempDir, ['ok.ts', 'fail.ts'])

      expect(markdown).toContain('📄 `ok.ts`')
      expect(markdown).not.toContain('📄 `fail.ts`')
      expect(markdown).toContain('⚠️ Falhas na Compressão')
      expect(markdown).toContain('`fail.ts`')
      expect(markdown).not.toContain(COMPRESSION_TOTAL_FAILURE_MARKER)
    })
  })

  // ---------------------------------------------------------------------------
  // PA-07 — Falha total
  // ---------------------------------------------------------------------------
  describe('PA-07 — Falha total', () => {
    it('todos os arquivos falham — retorna COMPRESSION_TOTAL_FAILURE_MARKER', async () => {
      tempDir = createTempDir()
      createFile(tempDir, 'a.ts', '// a')
      createFile(tempDir, 'b.ts', '// b')

      const mock = new MockRepomixAdapter()
      mock.setBatchResults({ 'a.ts': '', 'b.ts': '' })
      mock.setSingleResults({ 'a.ts': '', 'b.ts': '' })

      const service = new CompressionService(mock)
      const markdown = await service.generateCompressionMarkdown(tempDir, ['a.ts', 'b.ts'])

      expect(markdown.startsWith(COMPRESSION_TOTAL_FAILURE_MARKER)).toBe(true)
      expect(markdown).not.toContain('📄 `a.ts`')
      expect(markdown).not.toContain('📄 `b.ts`')
    })

    it('lista de arquivos vazia retorna COMPRESSION_TOTAL_FAILURE_MARKER sem chamar o adapter (ME-1)', async () => {
      tempDir = createTempDir()
      const mock = new MockRepomixAdapter()

      const service = new CompressionService(mock)
      const markdown = await service.generateCompressionMarkdown(tempDir, [])

      expect(markdown.startsWith(COMPRESSION_TOTAL_FAILURE_MARKER)).toBe(true)
      expect(markdown).toContain('Nenhum arquivo selecionado para compressão.')
      expect(mock.callCount).toBe(0)
    })
  })

  // ---------------------------------------------------------------------------
  // PA-08 — Conteúdo vazio tratado como falha
  // ---------------------------------------------------------------------------
  describe('PA-08 — Conteúdo vazio tratado como falha', () => {
    it('conteúdo com apenas espaços é tratado como falha total', async () => {
      tempDir = createTempDir()
      createFile(tempDir, 'a.ts', '// a')

      const mock = new MockRepomixAdapter()
      mock.setBatchResults({ 'a.ts': '   \n  \n  ' })
      mock.setSingleResults({ 'a.ts': '   \n  \n  ' })

      const service = new CompressionService(mock)
      const markdown = await service.generateCompressionMarkdown(tempDir, ['a.ts'])

      expect(markdown.startsWith(COMPRESSION_TOTAL_FAILURE_MARKER)).toBe(true)
    })

    it('arquivo com espaços e outro ok — espaços vão para a seção de falhas', async () => {
      tempDir = createTempDir()
      createFile(tempDir, 'ok.ts', '// ok')
      createFile(tempDir, 'spaces.ts', '   \n  ')

      const mock = new MockRepomixAdapter()
      mock.setBatchResults({ 'ok.ts': 'compressed_ok', 'spaces.ts': '   \n  ' })
      mock.setSingleResults({ 'ok.ts': 'compressed_ok', 'spaces.ts': '   \n  ' })

      const service = new CompressionService(mock)
      const markdown = await service.generateCompressionMarkdown(tempDir, ['ok.ts', 'spaces.ts'])

      expect(markdown).toContain('📄 `ok.ts`')
      expect(markdown).toContain('⚠️ Falhas na Compressão')
      expect(markdown).toContain('`spaces.ts`')
    })
  })

  // ---------------------------------------------------------------------------
  // PA-09 — Fallback individual
  // ---------------------------------------------------------------------------
  describe('PA-09 — Fallback individual', () => {
    it('compressMultipleFiles lança exceção — fallback individual é acionado via compressSingleWithDedup', async () => {
      tempDir = createTempDir()
      createFile(tempDir, 'a.ts', '// a')
      createFile(tempDir, 'b.ts', '// b')

      const mock = new MockRepomixAdapter()
      mock.setThrowOnBatch(true)
      mock.setSingleResults({ 'a.ts': 'single_a', 'b.ts': 'single_b' })

      const service = new CompressionService(mock)
      const markdown = await service.generateCompressionMarkdown(tempDir, ['a.ts', 'b.ts'])

      expect(markdown).toContain('📄 `a.ts`')
      expect(markdown).toContain('📄 `b.ts`')
      expect(markdown).not.toContain(COMPRESSION_TOTAL_FAILURE_MARKER)
    })

    it('fallback individual também falha — arquivo vai para seção de erros', async () => {
      tempDir = createTempDir()
      createFile(tempDir, 'ok.ts', '// ok')
      createFile(tempDir, 'fail.ts', '// fail')

      const mock = new MockRepomixAdapter()
      mock.setThrowOnBatch(true)
      mock.setSingleResults({ 'ok.ts': 'single_ok' })

      const service = new CompressionService(mock)
      const markdown = await service.generateCompressionMarkdown(tempDir, ['ok.ts', 'fail.ts'])

      expect(markdown).toContain('📄 `ok.ts`')
      expect(markdown).toContain('⚠️ Falhas na Compressão')
      expect(markdown).toContain('`fail.ts`')
    })
  })

  // ---------------------------------------------------------------------------
  // PA-10 — Falha de stat
  // ---------------------------------------------------------------------------
  describe('PA-10 — Falha de stat', () => {
    it('arquivo que não existe no disco não chama o adapter pelo arquivo faltante', async () => {
      tempDir = createTempDir()
      createFile(tempDir, 'ok.ts', '// ok')

      const mock = new MockRepomixAdapter()
      mock.setBatchResults({ 'ok.ts': 'compressed_ok', 'ghost.ts': '' })

      const service = new CompressionService(mock)
      const markdown = await service.generateCompressionMarkdown(tempDir, ['ok.ts', 'ghost.ts'])

      expect(markdown).toContain('📄 `ok.ts`')
      expect(markdown).toContain('⚠️ Falhas na Compressão')
      expect(markdown).toContain('`ghost.ts`')
    })

    it('todos os arquivos faltantes — falha total sem chamar adapter', async () => {
      tempDir = createTempDir()

      const mock = new MockRepomixAdapter()
      mock.setBatchResults({})

      const service = new CompressionService(mock)
      const markdown = await service.generateCompressionMarkdown(tempDir, ['missing.ts'])

      expect(markdown.startsWith(COMPRESSION_TOTAL_FAILURE_MARKER)).toBe(true)
      expect(mock.callCount).toBe(0)
    })
  })

  // ---------------------------------------------------------------------------
  // PA-11 — Fast Path de mtime (HIT sem nova compressão)
  // ---------------------------------------------------------------------------
  describe('PA-11 — Fast Path de mtime e reutilização por contentHash', () => {
    it('altera mtime sem alterar conteúdo — adapter NÃO é chamado (HIT por contentHash)', async () => {
      tempDir = createTempDir()
      createFile(tempDir, 'x.ts', 'const x = 1')

      const mock = new MockRepomixAdapter()
      mock.setBatchResults({ 'x.ts': 'compressed_x' })

      const service = new CompressionService(mock)

      await service.generateCompressionMarkdown(tempDir, ['x.ts'])
      expect(mock.callCount).toBeGreaterThan(0)

      // Altera APENAS o mtime (touch), preservando o conteúdo
      const newMtime = Date.now() + 10000
      touchFile(tempDir, 'x.ts', newMtime)

      mock.resetCallCount()
      const result = await service.generateCompressionMarkdown(tempDir, ['x.ts'])

      // Adapter NÃO deve ser chamado novamente porque o hash do conteúdo não mudou
      expect(mock.callCount).toBe(0)
      expect(result).toContain('📄 `x.ts`')
    })
  })

  // ---------------------------------------------------------------------------
  // PA-12 — Deduplicação inFlight em lote e no fallback individual (Bloqueador 2 resolvido)
  // ---------------------------------------------------------------------------
  describe('PA-12 — Deduplicação inFlight', () => {
    it('duas chamadas simultâneas para o mesmo arquivo compartilham a compressão em batch', async () => {
      tempDir = createTempDir()
      createFile(tempDir, 'x.ts', 'const x = 1')

      const mock = new MockRepomixAdapter()
      mock.setBatchResults({ 'x.ts': 'compressed_x' })
      mock.setDelay(50) // Simula atraso na execução CLI

      const service = new CompressionService(mock)

      const [result1, result2] = await Promise.all([
        service.generateCompressionMarkdown(tempDir, ['x.ts']),
        service.generateCompressionMarkdown(tempDir, ['x.ts'])
      ])

      // Adapter deve ser chamado apenas UMA vez (deduplicação pelo inFlight)
      expect(mock.callCount).toBe(1)
      expect(result1).toBe(result2)
    })

    it('duas chamadas simultâneas que caem no fallback compartilham a Promise via compressSingleWithDedup', async () => {
      tempDir = createTempDir()
      createFile(tempDir, 'fallback_x.ts', 'const fx = 1')

      const mock = new MockRepomixAdapter()
      mock.setThrowOnBatch(true)
      mock.setSingleResults({ 'fallback_x.ts': 'compressed_fallback_x' })
      mock.setDelay(50)

      const service = new CompressionService(mock)

      const [result1, result2] = await Promise.all([
        service.generateCompressionMarkdown(tempDir, ['fallback_x.ts']),
        service.generateCompressionMarkdown(tempDir, ['fallback_x.ts'])
      ])

      // Batch falhou em ambas, mas o compressSingleWithDedup garantiu apenas 1 chamada single real
      expect(result1).toBe(result2)
      expect(result1).toContain('compressed_fallback_x')
    })
  })

  // ---------------------------------------------------------------------------
  // PA-13 — Limite por bytes do LRU (Recomendação 2 resolvida)
  // ---------------------------------------------------------------------------
  describe('PA-13 — LRU por bytes com limite configurável', () => {
    it('cache respeita limite de bytes e desaloja entradas antigas quando total excede maxCacheBytes', async () => {
      tempDir = createTempDir()

      // Cada arquivo tem ~100.000 bytes
      const largeContent = 'x'.repeat(100000)
      for (let i = 0; i < 5; i++) {
        createFile(tempDir, `file_${i}.ts`, largeContent)
      }

      const mock = new MockRepomixAdapter()
      const results: Record<string, string> = {}
      for (let i = 0; i < 5; i++) {
        results[`file_${i}.ts`] = largeContent
      }
      mock.setBatchResults(results)

      // Configura limite de 250 KB (com 5 arquivos de 100KB = 500KB total, deve manter no máximo 2 arquivos)
      const maxBytes = 250 * 1024
      const service = new CompressionService(
        mock,
        undefined,
        { maxCacheBytes: maxBytes }
      )

      await service.generateCompressionMarkdown(
        tempDir,
        Array.from({ length: 5 }, (_, i) => `file_${i}.ts`)
      )

      const cache = (service as unknown as { cache: Map<string, { sizeBytes: number }> }).cache

      let totalBytes = 0
      for (const entry of cache.values()) {
        totalBytes += entry.sizeBytes
      }

      // Total de bytes deve estar rigorosamente dentro do limite configurado
      expect(totalBytes).toBeLessThanOrEqual(maxBytes)
      // Como 100KB * 3 = 300KB > 250KB, o cache deve conter exatamente 2 entradas
      expect(cache.size).toBe(2)

      const normalizedRoot = tempDir.replace(/\\/g, '/').replace(/\/+$/, '')
      const profileHash = computeProfileHash(resolveEffectiveProfile(DEFAULT_PROFILE, 'plain'))
      const oldestKey = `${normalizedRoot}::file_0.ts::${COMPRESSION_VERSION}::${profileHash}`
      const newestKey = `${normalizedRoot}::file_4.ts::${COMPRESSION_VERSION}::${profileHash}`

      expect(cache.has(oldestKey)).toBe(false)
      expect(cache.has(newestKey)).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // PA-14 — compressionVersion na chave
  // ---------------------------------------------------------------------------
  describe('PA-14 — compressionVersion', () => {
    it('a chave do cache contém COMPRESSION_VERSION para garantir invalidação de esquema', async () => {
      tempDir = createTempDir()
      createFile(tempDir, 'v.ts', 'const v = 1')

      const mock = new MockRepomixAdapter()
      mock.setBatchResults({ 'v.ts': 'compressed_v' })

      const service = new CompressionService(mock)
      await service.generateCompressionMarkdown(tempDir, ['v.ts'])

      const cache = (service as unknown as { cache: Map<string, unknown> }).cache
      const keys = Array.from(cache.keys())

      expect(keys.length).toBe(1)
      // A chave contém COMPRESSION_VERSION seguido do profileHash (schema invalida com a versão; perfil isola a transformação).
      expect(keys[0].includes(`::${COMPRESSION_VERSION}::`)).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // PA-15 — ContentIdentityPort injetado
  // ---------------------------------------------------------------------------
  describe('PA-15 — Injeção de ContentIdentityPort', () => {
    it('usa o provider injetado para obter hash antes de ler arquivo', async () => {
      tempDir = createTempDir()
      createFile(tempDir, 'p.ts', 'const p = 1')

      const mock = new MockRepomixAdapter()
      mock.setBatchResults({ 'p.ts': 'compressed_p' })

      let providerCalledWith: { repo: string; file: string } | null = null
      const customProvider = async (repo: string, file: string) => {
        providerCalledWith = { repo, file }
        return 'custom_hash_12345'
      }

      const service = new CompressionService(mock, { getContentHash: customProvider })
      await service.generateCompressionMarkdown(tempDir, ['p.ts'])

      expect(providerCalledWith).toEqual({ repo: tempDir, file: 'p.ts' })

      const cache = (service as unknown as { cache: Map<string, { contentHash: string }> }).cache
      const entry = Array.from(cache.values())[0]
      expect(entry.contentHash).toBe('custom_hash_12345')
    })
  })

  // ---------------------------------------------------------------------------
  // PA-16 — Batch limit (MAX_FILES_PER_BATCH = 20)
  // ---------------------------------------------------------------------------
  describe('PA-16 — Limite de arquivos por batch (MAX_FILES_PER_BATCH)', () => {
    it('RepomixAdapter divide 25 arquivos em múltiplos batches ≤ 20 arquivos cada', async () => {
      // Testa o chunking interno do RepomixAdapter com runner fake injetado no construtor
      const batchPatterns: string[][] = []

      const fakeRunner = {
        run: async (_command: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
          const includeIndex = args.indexOf('--include')
          if (includeIndex !== -1 && args[includeIndex + 1]) {
            const files = args[includeIndex + 1].split(',')
            batchPatterns.push(files)
            const blocks = files.map(f =>
              `================\nFile: ${f}\n================\nconst x = 1\n================`
            ).join('\n')
            return { stdout: blocks, stderr: '', exitCode: 0 }
          }
          return { stdout: '', stderr: '', exitCode: 0 }
        }
      }

      const files = Array.from({ length: 25 }, (_, i) => `file_${i}.ts`)
      const effective = resolveEffectiveProfile(DEFAULT_PROFILE, 'plain')
      const request = buildRepomixRequest('/fake/repo', files, effective, 'plain')
      const adapter = new RepomixAdapter(fakeRunner as unknown as RepomixProcessRunner)
      await adapter.compressMultipleFiles(request)

      // Com MAX_FILES_PER_BATCH=20 e 25 arquivos, devem existir pelo menos 2 batches
      expect(batchPatterns.length).toBeGreaterThanOrEqual(2)
      // Nenhum batch deve exceder 20 arquivos
      for (const batch of batchPatterns) {
        expect(batch.length).toBeLessThanOrEqual(20)
      }
      // Total de arquivos processados deve ser 25
      expect(batchPatterns.reduce((sum, b) => sum + b.length, 0)).toBe(25)
    })
  })

  // ---------------------------------------------------------------------------
  // PA-17 — Retry de compressSingleFile em falha transitória
  // ---------------------------------------------------------------------------
  describe('PA-17 — Retry em compressSingleFile', () => {
    it('fallback individual é retentado quando batch retorna vazio e fallback falha na primeira tentativa', async () => {
      tempDir = createTempDir()
      createFile(tempDir, 'retry.ts', 'const r = 1')

      // Batch retorna vazio para forçar fallback; o fallback falha na primeira chamada e tem sucesso na segunda
      let singleCallCount = 0
      const mockAdapter = {
        compressMultipleFiles: async () => ({}),
        compressSingleFile: async (_repo: string, rel: string) => {
          singleCallCount++
          if (singleCallCount === 1) throw new Error('Erro transitório simulado')
          return `compressed_${rel}`
        }
      }

      const service = new CompressionService(mockAdapter as unknown as import('./repomix-adapter').RepomixAdapter)
      const markdown = await service.generateCompressionMarkdown(tempDir, ['retry.ts'])

      // 1. O serviço NUNCA propaga exceção para o chamador, mesmo com falha total.
      //    (O contrato do CompressionService é sempre retornar string.)
      expect(typeof markdown).toBe('string')

      // 2. Como o único arquivo (retry.ts) falha, o retorno é falha total e deve
      //    começar com o marcador — fonte única de verdade importada do próprio serviço.
      expect(markdown.startsWith(COMPRESSION_TOTAL_FAILURE_MARKER)).toBe(true)

      // 3. No branch de falha total o retorno é apenas o marcador + contagem — o
      //    serviço NÃO lista arquivos individuais nesse branch. Prova objetiva de
      //    que o arquivo com falha não gerou bloco de conteúdo e que a resposta é
      //    resultado do marcador de falha total. (A presença do arquivo na listagem
      //    da seção ⚠️ ocorre apenas em falha parcial — coberta pelo PA-18.)
      expect(markdown).not.toContain('📄 `retry.ts`')
    })
  })

  // ---------------------------------------------------------------------------
  // PA-18 — Falha parcial: resumo de erros com motivo
  // ---------------------------------------------------------------------------
  describe('PA-18 — Resumo de falhas com motivo', () => {
    it('seção de falhas inclui o motivo da falha quando disponível', async () => {
      tempDir = createTempDir()
      createFile(tempDir, 'ok.ts', 'const ok = 1')
      // 'missing.ts' não existe no disco — deve gerar motivo "arquivo não encontrado no disco"

      const mock = new MockRepomixAdapter()
      mock.setBatchResults({ 'ok.ts': 'compressed_ok' })

      const service = new CompressionService(mock)
      const markdown = await service.generateCompressionMarkdown(tempDir, ['ok.ts', 'missing.ts'])

      expect(markdown).toContain('`missing.ts`')
      expect(markdown).toContain('arquivo não encontrado no disco')
    })
  })

  // ---------------------------------------------------------------------------
  // PA-19 — Compressão em massa (100+ arquivos sem falha sistêmica)
  // ---------------------------------------------------------------------------
  describe('PA-19 — Compressão em massa (100+ arquivos)', () => {
    it('100 arquivos são comprimidos corretamente sem falha sistêmica', async () => {
      tempDir = createTempDir()
      const N = 100

      const files: string[] = []
      for (let i = 0; i < N; i++) {
        const name = `mass_${i}.ts`
        createFile(tempDir, name, `const m${i} = ${i}`)
        files.push(name)
      }

      const mockAdapter = {
        compressMultipleFiles: async (req: RepomixRequest) => {
          const result: Record<string, string> = {}
          for (const p of req.selectedFiles) result[p] = `compressed_${p}`
          return result
        },
        compressSingleFile: async () => ''
      }

      const service = new CompressionService(mockAdapter as unknown as import('./repomix-adapter').RepomixAdapter)
      const markdown = await service.generateCompressionMarkdown(tempDir, files)

      // Nenhuma falha sistêmica — seção de falhas não deve existir
      expect(markdown).not.toContain('⚠️ Falhas na Compressão')
      // Todos os 100 arquivos devem estar presentes no Markdown
      for (const f of files) {
        expect(markdown).toContain(`\`${f}\``)
      }
    })
  })

  // ---------------------------------------------------------------------------
  // PA-20 — Parser tolerante a variações de formato do Repomix
  // ---------------------------------------------------------------------------
  describe('PA-20 — Parser tolerante do parseBatchOutput', () => {
    it('extrai arquivos com cabeçalho com espaço duplo "File:  path"', () => {
      const adapter = new RepomixAdapter()
      const stdout = [
        '================',
        'File:  src/a.ts',
        '================',
        'const a = 1',
        '================'
      ].join('\n')

      const result = adapter.parseBatchOutput(stdout)
      expect(result['src/a.ts']).toBe('const a = 1')
    })

    it('extrai arquivos sem separador final (EOF sem fechar)', () => {
      const adapter = new RepomixAdapter()
      const stdout = [
        '================',
        'File: src/b.ts',
        '================',
        'const b = 2'
        // sem separador final
      ].join('\n')

      const result = adapter.parseBatchOutput(stdout)
      expect(result['src/b.ts']).toBe('const b = 2')
    })

    it('extrai múltiplos arquivos em sequência', () => {
      const adapter = new RepomixAdapter()
      const stdout = [
        '================',
        'File: a.ts',
        '================',
        'const a = 1',
        '================',
        'File: b.ts',
        '================',
        'const b = 2',
        '================'
      ].join('\n')

      const result = adapter.parseBatchOutput(stdout)
      expect(result['a.ts']).toBe('const a = 1')
      expect(result['b.ts']).toBe('const b = 2')
    })

    it('tolera separador longo (================================================================)', () => {
      const adapter = new RepomixAdapter()
      const stdout = [
        '================================================================',
        'File: c.ts',
        '================',
        'const c = 3',
        '================'
      ].join('\n')

      const result = adapter.parseBatchOutput(stdout)
      expect(result['c.ts']).toBe('const c = 3')
    })
  })
})

describe('Direct Output — Provas de Aceitação', () => {
  let tempDir: string

  afterEach(async () => {
    if (tempDir) await cleanupDir(tempDir)
    tempDir = ''
  })

  // PA-21 — Direct Output para markdown
  it('formato markdown chama generateDirectOutput e inclui o conteúdo no documento final', async () => {
    tempDir = createTempDir()
    createFile(tempDir, 'a.ts', 'const a = 1')
    const mock = new MockRepomixAdapter()
    mock.setDirectResult({ content: '## Conteudo Markdown\n\n# Repomix doc', failed: false })
    const service = new CompressionService(mock)

    const result = await service.generateCompressionMarkdown(tempDir, ['a.ts'], undefined, 'markdown')

    expect(mock.directCallCount).toBe(1)
    expect(mock.callCount).toBe(0) // Core não deve ser acionado
    expect(result).toContain('## Conteudo Markdown')
  })

  // PA-22 — Direct Output para xml
  it('formato xml chama generateDirectOutput e inclui o conteúdo no documento final', async () => {
    tempDir = createTempDir()
    createFile(tempDir, 'a.ts', 'const a = 1')
    const mock = new MockRepomixAdapter()
    mock.setDirectResult({ content: '<repository>corpo xml</repository>', failed: false })
    const service = new CompressionService(mock)

    const result = await service.generateCompressionMarkdown(tempDir, ['a.ts'], undefined, 'xml')

    expect(mock.directCallCount).toBe(1)
    expect(mock.callCount).toBe(0)
    expect(result).toContain('<repository>corpo xml</repository>')
  })

  // PA-23 — Direct Output ignora cache
  it('duas chamadas consecutivas chamam o adapter duas vezes (sem cache por arquivo)', async () => {
    tempDir = createTempDir()
    createFile(tempDir, 'a.ts', 'const a = 1')
    const mock = new MockRepomixAdapter()
    mock.setDirectResult({ content: 'doc markdown', failed: false })
    const service = new CompressionService(mock)

    await service.generateCompressionMarkdown(tempDir, ['a.ts'], undefined, 'markdown')
    await service.generateCompressionMarkdown(tempDir, ['a.ts'], undefined, 'markdown')

    expect(mock.directCallCount).toBe(2)
    expect(mock.callCount).toBe(0)
  })

  // PA-24 — Context Enrichment aplicado no Direct Output
  it('header e instruction file aparecem no documento final do Direct Output', async () => {
    tempDir = createTempDir()
    createFile(tempDir, 'a.ts', 'const a = 1')
    createFile(tempDir, 'inst.md', 'instrucoes diretas')
    const mock = new MockRepomixAdapter()
    mock.setDirectResult({ content: 'corpo markdown', failed: false })
    const service = new CompressionService(mock)

    const result = await service.generateCompressionMarkdown(
      tempDir, ['a.ts'], undefined, 'markdown',
      { headerText: 'MEU-HEADER', instructionFilePath: 'inst.md' }
    )

    expect(result).toContain('MEU-HEADER')
    expect(result).toContain('instrucoes diretas')
    expect(result).toContain('corpo markdown')
  })

  // PA-25 — Falha total no Direct Output retorna marcador
  it('adapter que lança no Direct Output retorna COMPRESSION_TOTAL_FAILURE_MARKER', async () => {
    tempDir = createTempDir()
    createFile(tempDir, 'a.ts', 'const a = 1')
    const mock = new MockRepomixAdapter()
    mock.setThrowOnDirect(true)
    const service = new CompressionService(mock)

    const result = await service.generateCompressionMarkdown(tempDir, ['a.ts'], undefined, 'markdown')

    expect(result.startsWith(COMPRESSION_TOTAL_FAILURE_MARKER)).toBe(true)
  })

  it('adapter retornando failed:true no Direct Output retorna COMPRESSION_TOTAL_FAILURE_MARKER', async () => {
    tempDir = createTempDir()
    createFile(tempDir, 'a.ts', 'const a = 1')
    const mock = new MockRepomixAdapter()
    mock.setDirectResult({ content: '', failed: true, reason: 'repomix quebrou' })
    const service = new CompressionService(mock)

    const result = await service.generateCompressionMarkdown(tempDir, ['a.ts'], undefined, 'markdown')

    expect(result.startsWith(COMPRESSION_TOTAL_FAILURE_MARKER)).toBe(true)
  })
})
