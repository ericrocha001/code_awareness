/*
-T ---
*/

import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import type { RepomixAdapter } from './repomix-adapter'
import type { RepomixRequest } from './repomix-request'
import type { ContentIdentityPort } from './content-identity-port'
import type { CompressionPort } from './compression-port'
import type { CompressionProfile, OutputFormat, ContextEnrichment } from '../../shared/types'
import { DEFAULT_PROFILE, computeProfileHash } from './compression-profile'
import { resolveEffectiveProfile } from './effective-profile'
import { CodeMapService } from './code-map-service'
import { WatcherService } from './watcher-service'
import { RepositoryChangeReadiness } from './repository-change-readiness'

// Mock do RepositoryModel para isolar a PA-06 contra bindings nativos de banco no runtime Node/Vitest
vi.mock('./repository-model', () => {
  class FakeRepositoryModel {
    readonly readiness = new RepositoryChangeReadiness()
    private readonly repoPath: string
    private files: Array<{ id: string; relativePath: string; language: string; contentHash: string }> = []

    constructor(repoPath: string) {
      this.repoPath = repoPath
    }

    async backfillContentHashes(): Promise<void> {}
    async backfillSymbolReferences(): Promise<number> { return 0 }
    async backfillContextReferences(): Promise<void> {}
    async reconcileWithDisk(): Promise<unknown> { return {} }
    pruneKnownBinaryFiles(): number { return 0 }
    getRepositoryId(): string { return 'fake-repo-id' }

    async indexRepository(): Promise<{ filesIndexed: number; elementsExtracted: number }> {
      this.files = [{ id: 'file-anchor', relativePath: 'anchor.ts', language: 'typescript', contentHash: 'hash-anchor' }]
      return { filesIndexed: 1, elementsExtracted: 1 }
    }

    getFiles(): Array<{ id: string; relativePath: string; language: string; contentHash: string }> {
      if (this.files.length === 0) {
        this.files = [{ id: 'file-anchor', relativePath: 'anchor.ts', language: 'typescript', contentHash: 'hash-anchor' }]
      }
      return this.files
    }

    getModifiedFiles(): Array<{ id: string; relativePath: string; language: string; contentHash: string }> {
      return []
    }

    getElementsByRepository(): unknown[] { return [] }
    getRelationships(): unknown[] { return [] }

    getFileByRelativePath(rel: string): { id: string; relativePath: string; language: string; contentHash: string } | null {
      return this.getFiles().find((f) => f.relativePath === rel) ?? null
    }

    getRepoPath(): string { return this.repoPath }
    close(): void {}
  }

  return {
    RepositoryModel: FakeRepositoryModel,
    createRepositoryModel: (repoPath: string) => new FakeRepositoryModel(repoPath)
  }
})

// Referência tipada usada apenas pela PA-02/PA-03 (import dinâmico; nunca estático).
type CompressionServiceRef = import('./compression-service').CompressionService

// =============================================================================
// Helpers
// =============================================================================

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'compression_arch_'))
}

function createFile(dir: string, relativePath: string, content: string): void {
  const fullPath = join(dir, relativePath)
  mkdirSync(dirname(fullPath), { recursive: true })
  writeFileSync(fullPath, content, 'utf-8')
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

// Adapter mockado que distingue o caminho (Core vs Direct Output) e varia a saída
// pelo perfil efetivo (removeComments) — permite asserções determinísticas de rota
// e de não-deduplicação por perfil. O delay de macrotask garante sobreposição em
// chamadas concorrentes para exercitar o dedup real.
class ArchitectureMockAdapter implements RepomixAdapter {
  directCallCount = 0
  coreCallCount = 0

  async generateDirectOutput(
    request: RepomixRequest
  ): Promise<{ content: string; failed: boolean; reason?: string }> {
    this.directCallCount++
    await new Promise((resolve) => setTimeout(resolve, 50))
    const removeComments = request.profile.path === 'direct-output' && request.profile.removeComments === true
    const marker = removeComments ? 'NO-CMTS' : 'WITH-CMTS'
    return { content: `# direct-content ${marker}`, failed: false }
  }

  async compressMultipleFiles(request: RepomixRequest): Promise<Record<string, string>> {
    this.coreCallCount++
    const results: Record<string, string> = {}
    for (const file of request.selectedFiles) results[file] = `core:${file}`
    return results
  }

  async compressSingleFile(_request: RepomixRequest, relativePath: string): Promise<string> {
    this.coreCallCount++
    return `core:${relativePath}`
  }

  async checkInstallation(): Promise<boolean> {
    return true
  }
  parseBatchOutput(_stdout: string): Record<string, string> { return {} }
  parseJsonOutput(_stdout: string): Record<string, string> { return {} }
}

// Instancia o CompressionService via import dinâmico, mantendo o arquivo sem
// referência estática à implementação real (restrição da PA-06).
async function createRealService(adapter: RepomixAdapter): Promise<CompressionServiceRef> {
  const { CompressionService } = await import('./compression-service')
  return new CompressionService(adapter)
}

// =============================================================================
// Fakes para a PA-06 (DIP) — nenhuma dependência do CompressionService real.
// =============================================================================

class FakeContentIdentityPort implements ContentIdentityPort {
  readonly calls: string[][] = []
  async getContentHash(repoPath: string, relativePath: string): Promise<string | null> {
    this.calls.push([repoPath, relativePath])
    return null
  }
}

class FakeCompressionPort implements CompressionPort {
  readonly calls: Array<{ repoPath: string; selectedFiles: string[] }> = []
  constructor(private readonly identity: ContentIdentityPort | null = null) {}

  async generateCompressionMarkdown(
    repoPath: string,
    selectedFiles: string[],
    _profile?: CompressionProfile,
    _outputFormat?: OutputFormat,
    _enrichment?: ContextEnrichment
  ): Promise<string> {
    if (this.identity && selectedFiles.length > 0) {
      await this.identity.getContentHash(repoPath, selectedFiles[0])
    }
    this.calls.push({ repoPath, selectedFiles })
    return '# fake compressed content'
  }
}

// =============================================================================
// Provas de Aceitação
// =============================================================================

describe('Compression Architecture — Cinturão de Segurança', () => {
  let tempDir: string

  afterEach(async () => {
    if (tempDir) await cleanupDir(tempDir)
    tempDir = ''
  })

  // PA-02 — Contratos de Formato (Os 4 Formatos)
  describe('PA-02 — Contratos de Formato (Os 4 Formatos)', () => {
    it('plain/json acionam o Core; markdown/xml acionam o Direct Output; saída coerente com a rota', async () => {
      tempDir = createTempDir()
      createFile(tempDir, 'a.ts', 'const a = 1')
      const mock = new ArchitectureMockAdapter()
      const service = await createRealService(mock)

      // plain → Compression Core (estrutura de blocos ## 📄), sem conteúdo de Direct Output
      const plain = await service.generateCompressionMarkdown(tempDir, ['a.ts'], DEFAULT_PROFILE, 'plain')
      expect(plain).toContain('## 📄')
      expect(plain).toContain('core:a.ts')
      expect(plain).not.toContain('# direct-content')
      expect(mock.coreCallCount).toBeGreaterThan(0)
      expect(mock.directCallCount).toBe(0)

      // json → Direct Output (passthrough nativo; sin blocos ## 📄 do Core)
      const coreCallsBeforeJson = mock.coreCallCount
      const json = await service.generateCompressionMarkdown(tempDir, ['a.ts'], DEFAULT_PROFILE, 'json')
      expect(json).toContain('# direct-content WITH-CMTS')
      expect(json).not.toContain('## 📄')
      expect(mock.coreCallCount).toBe(coreCallsBeforeJson) // Core não acionado
      expect(mock.directCallCount).toBe(1)

      // markdown → Direct Output (conteúdo bruto do adapter, sem blocos ## 📄)
      const md = await service.generateCompressionMarkdown(tempDir, ['a.ts'], DEFAULT_PROFILE, 'markdown')
      expect(md).toContain('# direct-content WITH-CMTS')
      expect(md).not.toContain('## 📄')

      // xml → Direct Output
      const coreCallsBeforeXml = mock.coreCallCount
      const xml = await service.generateCompressionMarkdown(tempDir, ['a.ts'], DEFAULT_PROFILE, 'xml')
      expect(xml).toContain('# direct-content WITH-CMTS')
      expect(xml).not.toContain('## 📄')
      expect(mock.coreCallCount).toBe(coreCallsBeforeXml) // Core não acionado no Direct Output

      expect(mock.directCallCount).toBe(3) // json + md + xml
    })
  })

  // PA-03 — Identidade e Deduplicação (directInFlight)
  describe('PA-03 — Identidade e Deduplicação (directInFlight)', () => {
    it('Cenário A (Enrichment): enrichment diferente deduplica o adapter; documentos finais diferentes', async () => {
      tempDir = createTempDir()
      createFile(tempDir, 'a.ts', 'const a = 1')
      const mock = new ArchitectureMockAdapter()
      const service = await createRealService(mock)

      const [rA, rB] = await Promise.all([
        service.generateCompressionMarkdown(tempDir, ['a.ts'], DEFAULT_PROFILE, 'markdown', { headerText: 'HEADER-A' }),
        service.generateCompressionMarkdown(tempDir, ['a.ts'], DEFAULT_PROFILE, 'markdown', { headerText: 'HEADER-B' })
      ])

      expect(mock.directCallCount).toBe(1) // dedup: mesmo perfil/arquivos/formato → 1 chamada
      expect(rA).toContain('# direct-content')
      expect(rB).toContain('# direct-content')
      expect(rA).toContain('HEADER-A')
      expect(rA).not.toContain('HEADER-B')
      expect(rB).toContain('HEADER-B')
      expect(rB).not.toContain('HEADER-A')
      expect(rA).not.toBe(rB) // montagem independente do enrichment
    })

    it('Cenário B (Profile): perfil efetivo diferente NÃO deduplica o adapter; resultados diferentes', async () => {
      tempDir = createTempDir()
      createFile(tempDir, 'a.ts', 'const a = 1')
      const mock = new ArchitectureMockAdapter()
      const service = await createRealService(mock)

      const profileWithComments = { ...DEFAULT_PROFILE, removeComments: true }

      const [rA, rB] = await Promise.all([
        service.generateCompressionMarkdown(tempDir, ['a.ts'], profileWithComments, 'markdown'),
        service.generateCompressionMarkdown(tempDir, ['a.ts'], DEFAULT_PROFILE, 'markdown')
      ])

      // A chave do directInFlight deve incluir o hash do perfil efetivo.
      expect(mock.directCallCount).toBe(2)
      expect(rA).toContain('NO-CMTS')
      expect(rB).toContain('WITH-CMTS')
      expect(rA).not.toBe(rB)
    })
  })

  // PA-05 — Identidade Semântica do Effective Profile
  describe('PA-05 — Identidade Semântica do Effective Profile', () => {
    it('showLineNumbers (no-op no core) não altera o profileHash no caminho compression-core', () => {
      const a = resolveEffectiveProfile({ ...DEFAULT_PROFILE, showLineNumbers: true }, 'plain')
      const b = resolveEffectiveProfile({ ...DEFAULT_PROFILE, showLineNumbers: false }, 'plain')
      expect(computeProfileHash(a)).toBe(computeProfileHash(b))
    })

    it('outputFilePathStyle (inexistente na CLI) não altera o profileHash em nenhum caminho', () => {
      for (const format of ['plain', 'markdown'] as const) {
        const a = resolveEffectiveProfile({ ...DEFAULT_PROFILE, outputFilePathStyle: 'target-relative' }, format)
        const b = resolveEffectiveProfile({ ...DEFAULT_PROFILE, outputFilePathStyle: 'cwd-relative' }, format)
        expect(computeProfileHash(a)).toBe(computeProfileHash(b))
      }
    })

    it('mesmo Stored Profile com formatos diferentes (plain vs markdown) gera EffectiveProfile/hash diferentes', () => {
      const effPlain = resolveEffectiveProfile(DEFAULT_PROFILE, 'plain')
      const effMarkdown = resolveEffectiveProfile(DEFAULT_PROFILE, 'markdown')
      expect(effPlain).not.toEqual(effMarkdown)
      expect(computeProfileHash(effPlain)).not.toBe(computeProfileHash(effMarkdown))
    })
  })

  // PA-06 — Inversão de Dependência (Comportamental)
  describe('PA-06 — Inversão de Dependência (Comportamental)', () => {
    let service: CodeMapService | null = null

    afterEach(() => {
      try {
        service?.closeAll()
      } catch {
        // limpeza tolerante no Windows
      }
      service = null
    })

    it('CodeMapService usa a porta de compressão injetada (DIP real, não documental)', async () => {
      tempDir = createTempDir()
      createFile(tempDir, 'anchor.ts', 'export const anchor = 1')

      const contentIdentity = new FakeContentIdentityPort()
      const compressionPort = new FakeCompressionPort(contentIdentity)
      // Inversão de dependência: injeta SOMENTE portas fakes — nunca o CompressionService real.
      const svc = new CodeMapService(new WatcherService(), compressionPort)
      service = svc

      await svc.openRepository(tempDir)
      await svc.indexRepository(tempDir)

      const files = svc.getFiles(tempDir)
      expect(files.length).toBeGreaterThan(0)

      const anchorId = files[0].id
      const result = await svc.generateCompressedScopeMarkdown(tempDir, anchorId)

      expect(result.success).toBe(true)
      expect(compressionPort.calls.length).toBe(1)
      expect(compressionPort.calls[0].selectedFiles).toContain(files[0].relativePath)
      // A porta de identidade composta também foi acionada pela porta de compressão.
      expect(contentIdentity.calls.length).toBeGreaterThan(0)
    })
  })
})
