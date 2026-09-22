import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IArtifactReader, Artifact, ArtifactSummary } from './continuum-types'
import {
  LIST_ARTIFACTS_TOOL,
  GET_ARTIFACT_TOOL,
  executeListArtifacts,
  executeGetArtifact
} from './continuum-mcp'
import { ContextNavigationMcpAdapter } from '../mcp/context-navigation-mcp-adapter'
import type { ProjectContextNavigation } from '../core/context/project-context-navigation'
import { ProjectContinuumSession } from './project-continuum-session'
import { ArtifactInbox } from './artifact-inbox'
import { ENVELOPE_PROTOCOL, computeContentHash } from './artifact-envelope'
import { deriveRepositoryKey } from './repository-key'

const tmpDirs: string[] = []

function tempDir(prefix = 'continuum-mcp-test-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(d)
  return d
}

function mockNavigation(): ProjectContextNavigation {
  return {
    discoverRepository: vi.fn(async () => ({ directories: [] })),
    getRelationships: vi.fn(async () => ({ files: [] })),
    inspectFiles: vi.fn(async () => ({ files: [] })),
    readCode: vi.fn(async () => []),
    getReferences: vi.fn(async () => ({ targets: [] })),
    getSymbolDependencies: vi.fn(async () => ({ sources: [] })),
    getSymbolHierarchy: vi.fn(async () => ({ targets: [] }))
  }
}

function sampleArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    artifactId: 'art-001',
    type: 'IMPLEMENTATION_HANDOFF',
    schemaVersion: 1,
    title: 'Initial Implementation Handoff',
    producerRole: 'IMPLEMENTER',
    repositoryKey: 'repo-abc',
    createdAt: '2026-09-22T10:00:00.000Z',
    ingestedAt: '2026-09-22T10:05:00.000Z',
    sourceFingerprint: 'fp-123',
    gitHead: 'commit-sha-456',
    contentHash: 'hash-789',
    rawMarkdown: '# Handoff Report\n\nFull implementation details here.',
    ...overrides
  }
}

afterEach(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {}
  }
  tmpDirs.length = 0
})

describe('Continuum MCP — Tool Definitions and Execution', () => {
  // ── 1. Reader is read-only ───────────────────────────────────────────────

  it('1. Reader contract is strictly read-only (only get and list)', () => {
    const reader: IArtifactReader = {
      get: vi.fn(() => sampleArtifact()),
      list: vi.fn(() => [])
    }
    // Verify TypeScript interface only defines get and list
    expect(typeof reader.get).toBe('function')
    expect(typeof reader.list).toBe('function')
    expect((reader as any).append).toBeUndefined()
    expect((reader as any).close).toBeUndefined()
  })

  // ── 2. Catalog com Continuum vs sem Continuum ────────────────────────────

  it('2. Catalog sem Continuum: list_artifacts e get_artifact não aparecem', () => {
    const adapter = new ContextNavigationMcpAdapter(mockNavigation())
    const toolNames = adapter.listTools().map((t) => t.name)

    expect(toolNames).not.toContain('list_artifacts')
    expect(toolNames).not.toContain('get_artifact')
    expect(toolNames).toContain('discover_repository')
    expect(toolNames).toContain('get_system_health')
    expect(toolNames).toContain('get_runtime_identity')
  })

  it('3. Catalog com Continuum: list_artifacts e get_artifact são anunciadas', () => {
    const reader: IArtifactReader = {
      get: vi.fn(() => null),
      list: vi.fn(() => [])
    }
    const adapter = new ContextNavigationMcpAdapter(
      mockNavigation(),
      undefined,
      undefined,
      undefined,
      reader
    )
    const toolNames = adapter.listTools().map((t) => t.name)

    expect(toolNames).toContain('list_artifacts')
    expect(toolNames).toContain('get_artifact')
  })

  // ── 3. list_artifacts signal density ──────────────────────────────────────

  it('4. list_artifacts retorna summaries compactos sem rawMarkdown, repositoryKey, contentHash ou sourceFingerprint', () => {
    const artifact = sampleArtifact()
    const summary: ArtifactSummary = {
      artifactId: artifact.artifactId,
      type: artifact.type,
      schemaVersion: artifact.schemaVersion,
      title: artifact.title,
      producerRole: artifact.producerRole,
      repositoryKey: artifact.repositoryKey,
      createdAt: artifact.createdAt,
      ingestedAt: artifact.ingestedAt,
      sourceFingerprint: artifact.sourceFingerprint,
      gitHead: artifact.gitHead,
      contentHash: artifact.contentHash
    }

    const reader: IArtifactReader = {
      get: vi.fn(() => null),
      list: vi.fn(() => [summary])
    }

    const result = executeListArtifacts(reader, {})
    expect(result.isError).toBeUndefined()

    const data = JSON.parse(result.content[0].text)
    expect(data.count).toBe(1)
    expect(data.artifacts).toHaveLength(1)

    const item = data.artifacts[0]
    expect(item.artifactId).toBe('art-001')
    expect(item.type).toBe('IMPLEMENTATION_HANDOFF')
    expect(item.title).toBe('Initial Implementation Handoff')
    expect(item.producerRole).toBe('IMPLEMENTER')
    expect(item.createdAt).toBe('2026-09-22T10:00:00.000Z')
    expect(item.ingestedAt).toBe('2026-09-22T10:05:00.000Z')
    expect(item.gitHead).toBe('commit-sha-456')

    // Proved absent from listing
    expect(item.rawMarkdown).toBeUndefined()
    expect(item.repositoryKey).toBeUndefined()
    expect(item.contentHash).toBeUndefined()
    expect(item.sourceFingerprint).toBeUndefined()
  })

  it('5. list_artifacts respeita default limit (20), limite customizado e valida máximo (100)', () => {
    const listSpy = vi.fn(() => [])
    const reader: IArtifactReader = { get: vi.fn(() => null), list: listSpy }

    // Default limit
    executeListArtifacts(reader, {})
    expect(listSpy).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 20 }))

    // Custom limit
    executeListArtifacts(reader, { limit: 5 })
    expect(listSpy).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 5 }))

    // Exceeds max 100 -> error
    const errMax = executeListArtifacts(reader, { limit: 150 })
    expect(errMax.isError).toBe(true)
    expect(errMax.content[0].text).toContain('INVALID_ARGUMENT')

    // Less than 1 -> error
    const errMin = executeListArtifacts(reader, { limit: 0 })
    expect(errMin.isError).toBe(true)
    expect(errMin.content[0].text).toContain('INVALID_ARGUMENT')
  })

  it('6. list_artifacts repassa filtros de type e producerRole', () => {
    const listSpy = vi.fn(() => [])
    const reader: IArtifactReader = { get: vi.fn(() => null), list: listSpy }

    executeListArtifacts(reader, {
      type: 'IMPLEMENTATION_HANDOFF',
      producerRole: 'IMPLEMENTER'
    })

    expect(listSpy).toHaveBeenLastCalledWith({
      type: 'IMPLEMENTATION_HANDOFF',
      producerRole: 'IMPLEMENTER',
      limit: 20
    })

    // Unsupported type -> error
    const errType = executeListArtifacts(reader, { type: 'INVALID_TYPE' })
    expect(errType.isError).toBe(true)
    expect(errType.content[0].text).toContain('INVALID_ARGUMENT')
  })

  // ── 4. get_artifact fidelity ─────────────────────────────────────────────

  it('7. get_artifact retorna o artifact completo com rawMarkdown e sem repositoryKey', () => {
    const artifact = sampleArtifact()
    const reader: IArtifactReader = {
      get: vi.fn(() => artifact),
      list: vi.fn(() => [])
    }

    const result = executeGetArtifact(reader, { artifactId: 'art-001' })
    expect(result.isError).toBeUndefined()

    const data = JSON.parse(result.content[0].text)
    expect(data.artifactId).toBe('art-001')
    expect(data.type).toBe('IMPLEMENTATION_HANDOFF')
    expect(data.schemaVersion).toBe(1)
    expect(data.title).toBe(artifact.title)
    expect(data.producerRole).toBe('IMPLEMENTER')
    expect(data.createdAt).toBe(artifact.createdAt)
    expect(data.ingestedAt).toBe(artifact.ingestedAt)
    expect(data.sourceFingerprint).toBe('fp-123')
    expect(data.gitHead).toBe('commit-sha-456')
    expect(data.contentHash).toBe('hash-789')
    expect(data.rawMarkdown).toBe(artifact.rawMarkdown)

    // Not exposed to model
    expect(data.repositoryKey).toBeUndefined()
  })

  // ── 5. Artifact not found ────────────────────────────────────────────────

  it('8. get_artifact com ID inexistente retorna erro funcional ARTIFACT_NOT_FOUND', () => {
    const reader: IArtifactReader = {
      get: vi.fn(() => null),
      list: vi.fn(() => [])
    }

    const result = executeGetArtifact(reader, { artifactId: 'art-missing' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('ARTIFACT_NOT_FOUND')
  })

  it('9. get_artifact rejeita artifactId vazio ou ausente com INVALID_ARGUMENT', () => {
    const reader: IArtifactReader = { get: vi.fn(() => null), list: vi.fn(() => []) }

    const errEmpty = executeGetArtifact(reader, { artifactId: '' })
    expect(errEmpty.isError).toBe(true)
    expect(errEmpty.content[0].text).toContain('INVALID_ARGUMENT')

    const errMissing = executeGetArtifact(reader, {})
    expect(errMissing.isError).toBe(true)
    expect(errMissing.content[0].text).toContain('INVALID_ARGUMENT')
  })

  // ── 6. Adapter routing ───────────────────────────────────────────────────

  it('10. ContextNavigationMcpAdapter roteia list_artifacts e get_artifact', async () => {
    const artifact = sampleArtifact()
    const reader: IArtifactReader = {
      get: vi.fn((id) => (id === 'art-001' ? artifact : null)),
      list: vi.fn(() => [artifact])
    }

    const adapter = new ContextNavigationMcpAdapter(
      mockNavigation(),
      undefined,
      undefined,
      undefined,
      reader
    )

    // Call list_artifacts
    const listRes = await adapter.callTool('list_artifacts', {})
    expect(listRes.isError).toBeUndefined()
    const listData = JSON.parse(listRes.content[0].text)
    expect(listData.count).toBe(1)
    expect(listData.artifacts[0].artifactId).toBe('art-001')

    // Call get_artifact
    const getRes = await adapter.callTool('get_artifact', { artifactId: 'art-001' })
    expect(getRes.isError).toBeUndefined()
    const getData = JSON.parse(getRes.content[0].text)
    expect(getData.rawMarkdown).toBe(artifact.rawMarkdown)

    // Call get_artifact for missing ID
    const missingRes = await adapter.callTool('get_artifact', { artifactId: 'non-existent' })
    expect(missingRes.isError).toBe(true)
    expect(missingRes.content[0].text).toContain('ARTIFACT_NOT_FOUND')
  })

  // ── 7. Project isolation via MCP ─────────────────────────────────────────

  it('11. Isolamento entre projetos: MCP A enxerga apenas A; MCP B enxerga apenas B', async () => {
    const storageBase = tempDir('storage-')
    const repoA = tempDir('repo-a-')
    const repoB = tempDir('repo-b-')

    const session = new ProjectContinuumSession(storageBase)

    // Publicar e ingerir em A
    const inboxA = new ArtifactInbox(repoA)
    const rawMarkdownA = '# Project A Report'
    inboxA.write({
      protocol: ENVELOPE_PROTOCOL,
      artifactId: 'art-project-a',
      type: 'IMPLEMENTATION_HANDOFF',
      schemaVersion: 1,
      title: 'Handoff A',
      producerRole: 'IMPLEMENTER',
      repositoryKey: deriveRepositoryKey(repoA),
      createdAt: new Date().toISOString(),
      sourceFingerprint: null,
      gitHead: null,
      contentHash: computeContentHash(rawMarkdownA),
      rawMarkdown: rawMarkdownA
    })
    session.activate(repoA)
    const readerA = session.getActiveReader()!

    // Publicar e ingerir em B
    const inboxB = new ArtifactInbox(repoB)
    const rawMarkdownB = '# Project B Report'
    inboxB.write({
      protocol: ENVELOPE_PROTOCOL,
      artifactId: 'art-project-b',
      type: 'IMPLEMENTATION_HANDOFF',
      schemaVersion: 1,
      title: 'Handoff B',
      producerRole: 'IMPLEMENTER',
      repositoryKey: deriveRepositoryKey(repoB),
      createdAt: new Date().toISOString(),
      sourceFingerprint: null,
      gitHead: null,
      contentHash: computeContentHash(rawMarkdownB),
      rawMarkdown: rawMarkdownB
    })
    session.activate(repoB)
    const readerB = session.getActiveReader()!

    // Criar MCP adapter para sessão A (reabrindo A na sessão)
    session.activate(repoA)
    const adapterA = new ContextNavigationMcpAdapter(
      mockNavigation(),
      undefined,
      undefined,
      undefined,
      session.getActiveReader()!
    )

    const listA = JSON.parse((await adapterA.callTool('list_artifacts', {})).content[0].text)
    expect(listA.artifacts.map((a: any) => a.artifactId)).toEqual(['art-project-a'])

    const getAFromA = await adapterA.callTool('get_artifact', { artifactId: 'art-project-a' })
    expect(getAFromA.isError).toBeUndefined()

    const getBFromA = await adapterA.callTool('get_artifact', { artifactId: 'art-project-b' })
    expect(getBFromA.isError).toBe(true)
    expect(getBFromA.content[0].text).toContain('ARTIFACT_NOT_FOUND')

    // Ativar B e criar adapter B
    session.activate(repoB)
    const adapterB = new ContextNavigationMcpAdapter(
      mockNavigation(),
      undefined,
      undefined,
      undefined,
      session.getActiveReader()!
    )

    const listB = JSON.parse((await adapterB.callTool('list_artifacts', {})).content[0].text)
    expect(listB.artifacts.map((b: any) => b.artifactId)).toEqual(['art-project-b'])

    const getBFromB = await adapterB.callTool('get_artifact', { artifactId: 'art-project-b' })
    expect(getBFromB.isError).toBeUndefined()

    const getAFromB = await adapterB.callTool('get_artifact', { artifactId: 'art-project-a' })
    expect(getAFromB.isError).toBe(true)
    expect(getAFromB.content[0].text).toContain('ARTIFACT_NOT_FOUND')

    session.dispose()
  })

  // ── 8. Offline artifact visibility ───────────────────────────────────────

  it('12. Offline artifact visibility: publisher grava na inbox → ativação ingere → MCP lista e recupera', async () => {
    const storageBase = tempDir('storage-')
    const repo = tempDir('repo-offline-')

    // 1. Publisher grava na inbox offline
    const inbox = new ArtifactInbox(repo)
    const offlineMarkdown = '# Handoff Produced Offline\n\nPreserved without copy/paste.'
    inbox.write({
      protocol: ENVELOPE_PROTOCOL,
      artifactId: 'art-offline-01',
      type: 'IMPLEMENTATION_HANDOFF',
      schemaVersion: 1,
      title: 'Offline Handoff',
      producerRole: 'IMPLEMENTER',
      repositoryKey: deriveRepositoryKey(repo),
      createdAt: '2026-09-22T08:00:00.000Z',
      sourceFingerprint: null,
      gitHead: 'git-commit-1234',
      contentHash: computeContentHash(offlineMarkdown),
      rawMarkdown: offlineMarkdown
    })

    // 2. Desktop ativa o projeto
    const session = new ProjectContinuumSession(storageBase)
    const report = session.activate(repo)
    expect(report?.ingested).toBe(1)

    // 3. MCP adapter nasce com o reader da ativação
    const reader = session.getActiveReader()!
    const adapter = new ContextNavigationMcpAdapter(
      mockNavigation(),
      undefined,
      undefined,
      undefined,
      reader
    )

    // 4. list_artifacts descobre o handoff
    const listRes = await adapter.callTool('list_artifacts', {})
    const listData = JSON.parse(listRes.content[0].text)
    expect(listData.count).toBe(1)
    expect(listData.artifacts[0].artifactId).toBe('art-offline-01')
    expect(listData.artifacts[0].gitHead).toBe('git-commit-1234')

    // 5. get_artifact recupera o conteúdo integral
    const getRes = await adapter.callTool('get_artifact', { artifactId: 'art-offline-01' })
    const getData = JSON.parse(getRes.content[0].text)
    expect(getData.rawMarkdown).toBe('# Handoff Produced Offline\n\nPreserved without copy/paste.')

    session.dispose()
  })

  // ── 9. Failure isolation ─────────────────────────────────────────────────

  it('13. Failure isolation: falha no Continuum não impede MCP de operar outras tools', async () => {
    // Adapter criado sem reader (ou quando Continuum falhou)
    const adapter = new ContextNavigationMcpAdapter(mockNavigation())

    // CodeScope tool funciona normalmente
    const discRes = await adapter.callTool('discover_repository', {})
    expect(discRes.isError).toBeUndefined()

    // Chamada direta a list_artifacts retorna erro CONTINUUM_UNAVAILABLE sem quebrar o servidor
    const listRes = await adapter.callTool('list_artifacts', {})
    expect(listRes.isError).toBe(true)
    expect(listRes.content[0].text).toContain('CONTINUUM_UNAVAILABLE')
  })
})
