/*
-T ---
*/

import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createHash } from 'crypto'
import { resolveContentIdentity } from './compression-content-identity'
import type { CacheEntry } from './compression-cache'

let tempDir: string = ''

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'content_identity_test_'))
}

afterEach(() => {
  if (tempDir && existsSync(tempDir)) {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // Ignora erro de limpeza no Windows
    }
  }
  tempDir = ''
  vi.restoreAllMocks()
})

describe('CompressionContentIdentity — Provas de Aceitação Isoladas', () => {
  // PA-I01 — Fast path O(1) com mtime+size iguais
  describe('PA-I01 — Fast path O(1)', () => {
    it('fast path O(1): mtime+size iguais → fastPathHit=true, cachedContent retornado', async () => {
      const cached: CacheEntry = {
        mtime: 1000,
        size: 500,
        contentHash: 'abc123',
        compressedContent: 'compressed',
        sizeBytes: 10,
        lastAccessed: Date.now()
      }

      const result = await resolveContentIdentity(
        '/repo',
        'file.ts',
        '/nonexistent/path/file.ts', // Caminho inexistente prova que não houve leitura em disco
        cached,
        { mtimeMs: 1000, size: 500 }, // iguais ao cached
        undefined
      )

      expect(result.fastPathHit).toBe(true)
      expect(result.hash).toBe('abc123')
      expect(result.cachedContent).toBe('compressed')
    })
  })

  // PA-I02 — Provider injetado retornando hash
  describe('PA-I02 — Provider injetado', () => {
    it('provider injetado: retorna hash, readFile NÃO é chamado', async () => {
      const provider = { getContentHash: vi.fn().mockResolvedValue('provided-hash') }

      const result = await resolveContentIdentity(
        '/repo',
        'file.ts',
        '/nonexistent/path/file.ts', // Caminho inexistente prova que o provider supriu sem ler o disco
        undefined, // sem cache
        { mtimeMs: 1000, size: 500 },
        provider
      )

      expect(result.hash).toBe('provided-hash')
      expect(result.fastPathHit).toBe(false)
      expect(provider.getContentHash).toHaveBeenCalledWith('/repo', 'file.ts')
    })
  })

  // PA-I03 — Provider falhando aciona fallback
  describe('PA-I03 — Fallback em falha do provider', () => {
    it('provider falhando: aciona fallback para readFile', async () => {
      tempDir = createTempDir()
      const filePath = join(tempDir, 'fallback_test.ts')
      const fileContent = 'const test = "content for hashing"'
      writeFileSync(filePath, fileContent, 'utf-8')

      const expectedHash = createHash('sha256').update(fileContent, 'utf-8').digest('hex')
      const provider = { getContentHash: vi.fn().mockRejectedValue(new Error('provider error')) }

      const result = await resolveContentIdentity(
        tempDir,
        'fallback_test.ts',
        filePath,
        undefined,
        { mtimeMs: 1000, size: 500 },
        provider
      )

      expect(result.hash).toBe(expectedHash)
      expect(result.fastPathHit).toBe(false)
      expect(provider.getContentHash).toHaveBeenCalledWith(tempDir, 'fallback_test.ts')
    })
  })

  // PA-I04 — Cache hit por hash (mtime diferente, hash igual)
  describe('PA-I04 — Cache hit por hash', () => {
    it('cache hit por hash: mtime diferente, hash igual → cachedContent retornado', async () => {
      const cached: CacheEntry = {
        mtime: 1000,
        size: 500,
        contentHash: 'abc123',
        compressedContent: 'compressed',
        sizeBytes: 10,
        lastAccessed: Date.now()
      }

      const provider = { getContentHash: vi.fn().mockResolvedValue('abc123') } // mesmo hash do cached

      const result = await resolveContentIdentity(
        '/repo',
        'file.ts',
        '/nonexistent/path/file.ts',
        cached,
        { mtimeMs: 2000, size: 600 }, // diferentes do cached
        provider
      )

      expect(result.hash).toBe('abc123')
      expect(result.fastPathHit).toBe(false) // não foi fast path (mtime diferente)
      expect(result.cachedContent).toBe('compressed') // mas teve cache hit por hash
    })
  })
})
