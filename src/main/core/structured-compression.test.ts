/*
-T ---
*/

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync, utimesSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { CompressionService } from './compression-service'
import { RepomixAdapter } from './repomix-adapter'
import type { RepomixRequest } from './repomix-request'
import type { CompressionProfile } from '../../shared/types'

// =============================================================================
// Helpers de teste
// =============================================================================

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'structured_comp_test_'))
}

async function cleanupDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 })
      }
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
}

function createFile(dir: string, relativePath: string, content: string): void {
  const fullPath = join(dir, relativePath)
  mkdirSync(dirname(fullPath), { recursive: true })
  writeFileSync(fullPath, content, 'utf-8')
}

// =============================================================================
// Mock do RepomixAdapter
// =============================================================================

class MockRepomixAdapter implements RepomixAdapter {
  private _callCount = 0
  private _batchResults: Record<string, string> = {}
  private _singleResults: Record<string, string> = {}
  private _lastBatchRequest: RepomixRequest | null = null

  get callCount(): number {
    return this._callCount
  }
  get lastBatchRequest(): RepomixRequest | null {
    return this._lastBatchRequest
  }

  resetCallCount(): void {
    this._callCount = 0
  }

  setBatchResults(results: Record<string, string>): void {
    this._batchResults = results
  }

  setSingleResults(results: Record<string, string>): void {
    this._singleResults = results
  }

  async compressMultipleFiles(request: RepomixRequest): Promise<Record<string, string>> {
    this._callCount++
    this._lastBatchRequest = request
    const result: Record<string, string> = {}
    for (const p of request.selectedFiles) {
      result[p] = this._batchResults[p] ?? ''
    }
    return result
  }

  async compressSingleFile(_request: RepomixRequest, relativePath: string): Promise<string> {
    this._callCount++
    return this._singleResults[relativePath] ?? ''
  }

  async generateDirectOutput(_request: RepomixRequest): Promise<{ content: string; failed: boolean; reason?: string }> {
    return { content: '', failed: true, reason: 'not implemented in mock' }
  }

  async checkInstallation(): Promise<boolean> {
    return true
  }
  parseBatchOutput(_stdout: string): Record<string, string> {
    return {}
  }
  parseJsonOutput(_stdout: string): Record<string, string> {
    return {}
  }
}

// =============================================================================
// Suíte de Testes: compressFilesStructured
// =============================================================================

describe('Structured Compression — compressFilesStructured', () => {
  let tempDir: string | null = null

  afterEach(async () => {
    if (tempDir) {
      await cleanupDir(tempDir)
      tempDir = null
    }
  })

  // SC-01: 3 arquivos, todos novos (sem cache)
  it('SC-01 — 3 arquivos novos: results com 3 entradas, errors vazio, adapter chamado', async () => {
    tempDir = createTempDir()
    createFile(tempDir, 'a.ts', 'const a = 1')
    createFile(tempDir, 'b.ts', 'const b = 2')
    createFile(tempDir, 'c.ts', 'const c = 3')

    const mock = new MockRepomixAdapter()
    mock.setBatchResults({
      'a.ts': 'compressed_a',
      'b.ts': 'compressed_b',
      'c.ts': 'compressed_c'
    })

    const service = new CompressionService(mock)
    const result = await service.compressFilesStructured(tempDir, ['a.ts', 'b.ts', 'c.ts'])

    expect(result.results).toEqual({
      'a.ts': 'compressed_a',
      'b.ts': 'compressed_b',
      'c.ts': 'compressed_c'
    })
    expect(result.errors).toEqual([])
    expect(result.errorReasons).toEqual({})
    expect(mock.callCount).toBe(1)
  })

  // SC-02: Segunda chamada sem mudanças (cache hit)
  it('SC-02 — Segunda chamada sem mudanças: results com 3 entradas, adapter chamado 0 vezes', async () => {
    tempDir = createTempDir()
    createFile(tempDir, 'a.ts', 'const a = 1')
    createFile(tempDir, 'b.ts', 'const b = 2')
    createFile(tempDir, 'c.ts', 'const c = 3')

    const mock = new MockRepomixAdapter()
    mock.setBatchResults({
      'a.ts': 'compressed_a',
      'b.ts': 'compressed_b',
      'c.ts': 'compressed_c'
    })

    const service = new CompressionService(mock)
    // Primeira chamada: popula o cache
    await service.compressFilesStructured(tempDir, ['a.ts', 'b.ts', 'c.ts'])
    expect(mock.callCount).toBe(1)

    // Reset da contagem
    mock.resetCallCount()

    // Segunda chamada idêntica: cache hit total
    const result2 = await service.compressFilesStructured(tempDir, ['a.ts', 'b.ts', 'c.ts'])
    expect(result2.results).toEqual({
      'a.ts': 'compressed_a',
      'b.ts': 'compressed_b',
      'c.ts': 'compressed_c'
    })
    expect(result2.errors).toEqual([])
    expect(mock.callCount).toBe(0)
  })

  // SC-03: 1 arquivo modificado entre chamadas
  it('SC-03 — 1 arquivo modificado entre chamadas: adapter chamado 1 vez para o modificado', async () => {
    tempDir = createTempDir()
    createFile(tempDir, 'a.ts', 'const a = 1')
    createFile(tempDir, 'b.ts', 'const b = 2')
    createFile(tempDir, 'c.ts', 'const c = 3')

    const mock = new MockRepomixAdapter()
    mock.setBatchResults({
      'a.ts': 'compressed_a',
      'b.ts': 'compressed_b',
      'c.ts': 'compressed_c'
    })

    const service = new CompressionService(mock)
    await service.compressFilesStructured(tempDir, ['a.ts', 'b.ts', 'c.ts'])
    expect(mock.callCount).toBe(1)

    // Modifica apenas b.ts (alterando conteúdo e forçando novo mtime)
    createFile(tempDir, 'b.ts', 'const b = 999')
    const fullPathB = join(tempDir, 'b.ts')
    const futureTime = (Date.now() + 5000) / 1000
    utimesSync(fullPathB, futureTime, futureTime)

    mock.resetCallCount()
    mock.setBatchResults({
      'b.ts': 'compressed_b_v2'
    })

    const result2 = await service.compressFilesStructured(tempDir, ['a.ts', 'b.ts', 'c.ts'])
    expect(result2.results).toEqual({
      'a.ts': 'compressed_a',
      'b.ts': 'compressed_b_v2',
      'c.ts': 'compressed_c'
    })
    expect(result2.errors).toEqual([])
    expect(mock.callCount).toBe(1)
    expect(mock.lastBatchRequest?.selectedFiles).toEqual(['b.ts'])
  })

  // SC-04: 1 arquivo falha na compressão
  it('SC-04 — 1 arquivo falha na compressão: results com N-1 entradas, errors com 1 entrada e razão', async () => {
    tempDir = createTempDir()
    createFile(tempDir, 'ok.ts', 'const ok = 1')
    createFile(tempDir, 'fail.ts', 'const fail = 2')

    const mock = new MockRepomixAdapter()
    mock.setBatchResults({ 'ok.ts': 'compressed_ok', 'fail.ts': '' })
    mock.setSingleResults({ 'ok.ts': 'compressed_ok', 'fail.ts': '' })

    const service = new CompressionService(mock)
    const result = await service.compressFilesStructured(tempDir, ['ok.ts', 'fail.ts'])

    expect(result.results).toEqual({
      'ok.ts': 'compressed_ok'
    })
    expect(result.results['fail.ts']).toBeUndefined()
    expect(result.errors).toContain('fail.ts')
    expect(result.errorReasons['fail.ts']).toBeDefined()
    expect(result.errorReasons['fail.ts'].length).toBeGreaterThan(0)
  })

  // SC-05: selectedFiles vazio
  it('SC-05 — selectedFiles vazio: results vazio, errors vazio, adapter não chamado', async () => {
    tempDir = createTempDir()

    const mock = new MockRepomixAdapter()
    const service = new CompressionService(mock)
    const result = await service.compressFilesStructured(tempDir, [])

    expect(result.results).toEqual({})
    expect(result.errors).toEqual([])
    expect(result.errorReasons).toEqual({})
    expect(mock.callCount).toBe(0)
  })

  // SC-06: Profile customizado
  it('SC-06 — Profile customizado: adapter recebe request com profile configurado', async () => {
    tempDir = createTempDir()
    createFile(tempDir, 'a.ts', 'const a = 1')

    const mock = new MockRepomixAdapter()
    mock.setBatchResults({ 'a.ts': 'compressed_a' })

    const customProfile: CompressionProfile = {
      removeComments: true,
      removeEmptyLines: true,
      truncateBase64: true
    }

    const service = new CompressionService(mock)
    await service.compressFilesStructured(tempDir, ['a.ts'], customProfile)

    expect(mock.callCount).toBe(1)
    expect(mock.lastBatchRequest).not.toBeNull()
    expect(mock.lastBatchRequest?.profile.removeComments).toBe(true)
    expect(mock.lastBatchRequest?.profile.removeEmptyLines).toBe(true)
    expect(mock.lastBatchRequest?.profile.truncateBase64).toBe(true)
  })


  // SC-07: Formato direct-output (ex: 'xml')
  it('SC-07 — Formato xml (direct-output): lança erro informando que direct-output não é suportado', async () => {
    tempDir = createTempDir()
    createFile(tempDir, 'a.ts', 'const a = 1')

    const mock = new MockRepomixAdapter()
    const service = new CompressionService(mock)

    await expect(
      service.compressFilesStructured(tempDir, ['a.ts'], undefined, 'xml')
    ).rejects.toThrow(/direct-output/)
  })
})
