/**
 * Testes do Change Intake Gate, RepositoryFileMembership, harness de instrumentação
 * e causalidade de correlação.
 *
 * Cobre cenários da Unidade 1 (harness), Unidade 2 (membership), Unidade 3 (intake gate)
 * e Unidade 4 (causalidade/coalescing).
 *
 * Runtime: Node.js (vitest run) — não requer SQLite nativo.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { SyncHarness } from './sync-harness'
import { RepositoryFileMembership, type MembershipGitService } from './repository-file-membership'
import { RepositorySynchronizer } from './repository-synchronizer'
import { repositoryEventBus } from './repository-events'
import { telemetryService } from './telemetry-service'
import { RepositoryChangeReadiness } from './repository-change-readiness'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  const dir = join(tmpdir(), `intake_test_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

async function cleanupDir(dir: string): Promise<void> {
  for (let i = 0; i < 4; i++) {
    try {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      await new Promise(r => setTimeout(r, 80))
    }
  }
}

/** Git service stub — controla quais paths são "ignorados" */
function makeGitStub(isGit = false, ignoredPaths: string[] = []): MembershipGitService {
  return {
    isGitRepository: async () => isGit,
    checkIgnoreBatch: async (_repoPath, paths) => {
      const ignored = new Set<string>()
      for (const p of paths) {
        if (ignoredPaths.some(i => p === i || p.startsWith(i + '/'))) ignored.add(p)
      }
      return ignored
    }
  }
}

/** RepositoryModel stub mínimo para testes sem SQLite */
function makeModelStub(repoPath: string, indexedPaths: string[] = []) {
  const modified = new Set<string>()
  const files = indexedPaths.map(p => ({ relativePath: p, status: 'indexed', contentHash: null }))

  return {
    readiness: new RepositoryChangeReadiness(),
    getRepoPath: () => repoPath,
    getRepositoryId: () => 'test-repo-id',
    getModifiedFiles: () => files.filter(f => modified.has(f.relativePath)),
    getFiles: () => [...files],
    getFileByRelativePath: (p: string) => files.find(f => f.relativePath === p) ?? null,
    markFileModified: (p: string) => {
      const f = files.find(x => x.relativePath === p)
      if (f) { f.status = 'modified'; modified.add(p) }
    },
    markFileIndexed: (p: string) => {
      const f = files.find(x => x.relativePath === p)
      if (f) { f.status = 'indexed'; modified.delete(p) }
    },
    updateFileContent: async (_p: string, _cid: string) => true,
    updateFileMetadata: () => {},
    updateLastSyncAt: () => {}
  } as unknown as import('./repository-model').RepositoryModel
}

// ─── SyncHarness ─────────────────────────────────────────────────────────────

describe('SyncHarness', () => {
  it('inicia com contadores zerados', () => {
    const h = new SyncHarness()
    expect(h.snapshot()).toEqual({
      observations: 0,
      accepted: 0,
      rejected: 0,
      stabilizationAttempts: 0,
      verificationAttempts: 0,
      reindexAttempts: 0
    })
  })

  it('incrementa counters corretos por evento', () => {
    const h = new SyncHarness()
    h.record('observed')
    h.record('observed')
    h.record('accepted')
    h.record('rejected')
    h.record('rejected')
    h.record('stabilization')
    h.record('verification')
    h.record('reindex')
    const s = h.snapshot()
    expect(s.observations).toBe(2)
    expect(s.accepted).toBe(1)
    expect(s.rejected).toBe(2)
    expect(s.stabilizationAttempts).toBe(1)
    expect(s.verificationAttempts).toBe(1)
    expect(s.reindexAttempts).toBe(1)
  })

  it('reset limpa todos os contadores', () => {
    const h = new SyncHarness()
    h.record('observed')
    h.record('reindex')
    h.reset()
    const s = h.snapshot()
    expect(s.observations).toBe(0)
    expect(s.reindexAttempts).toBe(0)
  })

  it('snapshot retorna cópia imutável', () => {
    const h = new SyncHarness()
    h.record('observed')
    const s1 = h.snapshot()
    h.record('observed')
    const s2 = h.snapshot()
    expect(s1.observations).toBe(1)
    expect(s2.observations).toBe(2)
  })
})

// ─── RepositoryFileMembership — não-Git ───────────────────────────────────────

describe('RepositoryFileMembership — non-Git', () => {
  let repoPath: string

  beforeEach(() => {
    repoPath = makeTempDir()
  })

  afterEach(async () => {
    await cleanupDir(repoPath)
  })

  it('classifica arquivo de texto elegível como eligible', async () => {
    writeFileSync(join(repoPath, 'src.ts'), 'export const x = 1\n', 'utf-8')
    const m = new RepositoryFileMembership(repoPath, makeGitStub(false))
    expect(await m.classify('src.ts')).toBe('eligible')
  })

  it('classifica diretório como directory', async () => {
    mkdirSync(join(repoPath, 'subdir'))
    const m = new RepositoryFileMembership(repoPath, makeGitStub(false))
    expect(await m.classify('subdir')).toBe('directory')
  })

  it('classifica path inexistente sem indexed como deleted-unknown', async () => {
    const m = new RepositoryFileMembership(repoPath, makeGitStub(false))
    expect(await m.classify('ghost.ts')).toBe('deleted-unknown')
  })

  it('classifica path inexistente com indexed como deleted-indexed', async () => {
    const m = new RepositoryFileMembership(repoPath, makeGitStub(false))
    expect(await m.classify('ghost.ts', new Set(['ghost.ts']))).toBe('deleted-indexed')
  })

  it('classifica arquivo em node_modules como ineligible', async () => {
    mkdirSync(join(repoPath, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(repoPath, 'node_modules', 'pkg', 'index.ts'), 'export {}', 'utf-8')
    const m = new RepositoryFileMembership(repoPath, makeGitStub(false))
    expect(await m.classify('node_modules/pkg/index.ts')).toBe('ineligible')
  })

  it('classifica arquivo .png como ineligible', async () => {
    writeFileSync(join(repoPath, 'icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const m = new RepositoryFileMembership(repoPath, makeGitStub(false))
    expect(await m.classify('icon.png')).toBe('ineligible')
  })

  it('classifyBatch retorna resultado correto para múltiplos paths', async () => {
    writeFileSync(join(repoPath, 'a.ts'), 'export const a = 1\n', 'utf-8')
    writeFileSync(join(repoPath, 'b.ts'), 'export const b = 2\n', 'utf-8')
    mkdirSync(join(repoPath, 'dist'))
    const m = new RepositoryFileMembership(repoPath, makeGitStub(false))
    const result = await m.classifyBatch(['a.ts', 'b.ts', 'dist', 'missing.ts'])
    expect(result.get('a.ts')).toBe('eligible')
    expect(result.get('b.ts')).toBe('eligible')
    expect(result.get('dist')).toBe('directory')
    expect(result.get('missing.ts')).toBe('deleted-unknown')
  })
})

// ─── RepositoryFileMembership — Git ──────────────────────────────────────────

describe('RepositoryFileMembership — Git', () => {
  let repoPath: string

  beforeEach(() => {
    repoPath = makeTempDir()
  })

  afterEach(async () => {
    await cleanupDir(repoPath)
  })

  it('arquivo em .gitignore é classificado como ignored', async () => {
    writeFileSync(join(repoPath, 'secret.env'), 'SECRET=abc\n', 'utf-8')
    const m = new RepositoryFileMembership(repoPath, makeGitStub(true, ['secret.env']))
    expect(await m.classify('secret.env')).toBe('ignored')
  })

  it('arquivo não ignorado pelo Git é eligible', async () => {
    writeFileSync(join(repoPath, 'main.ts'), 'export const x = 1\n', 'utf-8')
    const m = new RepositoryFileMembership(repoPath, makeGitStub(true, []))
    expect(await m.classify('main.ts')).toBe('eligible')
  })

  it('nested .gitignore: arquivo em subdir ignorado é classified como ignored', async () => {
    mkdirSync(join(repoPath, 'infra', 'gateway', '.wrangler'), { recursive: true })
    writeFileSync(join(repoPath, 'infra', 'gateway', '.wrangler', 'state.json'), '{}', 'utf-8')
    // Stub simula que git check-ignore reportaria este path como ignorado
    const m = new RepositoryFileMembership(repoPath, makeGitStub(true, ['infra/gateway/.wrangler/state.json']))
    expect(await m.classify('infra/gateway/.wrangler/state.json')).toBe('ignored')
  })

  it('classifyBatch com Git: separa eligible de ignored', async () => {
    writeFileSync(join(repoPath, 'src.ts'), 'export {}', 'utf-8')
    writeFileSync(join(repoPath, 'build.log'), 'log', 'utf-8')
    const m = new RepositoryFileMembership(repoPath, makeGitStub(true, ['build.log']))
    const result = await m.classifyBatch(['src.ts', 'build.log'])
    expect(result.get('src.ts')).toBe('eligible')
    expect(result.get('build.log')).toBe('ignored')
  })

  it('falha do git stub → fail-open: arquivo é eligible', async () => {
    writeFileSync(join(repoPath, 'src.ts'), 'export {}', 'utf-8')
    const faultyGit: MembershipGitService = {
      isGitRepository: async () => true,
      checkIgnoreBatch: async () => { throw new Error('git error') }
    }
    const m = new RepositoryFileMembership(repoPath, faultyGit)
    // Quando checkIgnoreBatch lança, o catch no RepositoryFileMembership faz fail-open
    // retornando Set() vazio → arquivo não é ignorado → eligible
    expect(await m.classify('src.ts')).toBe('eligible')
  })
})

// ─── Change Intake Gate — integração com RepositorySynchronizer ──────────────

describe('Change Intake Gate', () => {
  let repoPath: string
  let sync: RepositorySynchronizer | null

  beforeEach(() => {
    repoPath = makeTempDir()
    sync = null
  })

  afterEach(async () => {
    sync?.dispose()
    sync = null
    await cleanupDir(repoPath)
  })

  const WAIT_MS = 900 // debounce(500) + margem

  it('diretório não atinge stabilization nem reindex', async () => {
    mkdirSync(join(repoPath, 'docs'))
    const harness = new SyncHarness()
    const membership = new RepositoryFileMembership(repoPath, makeGitStub(false))
    const model = makeModelStub(repoPath)
    sync = new RepositorySynchronizer(model, 'test-repo-id', { membership, harness })

    repositoryEventBus.emitFileModified('test-repo-id', 'docs')
    await new Promise(r => setTimeout(r, WAIT_MS))

    const s = harness.snapshot()
    expect(s.observations).toBe(1)
    expect(s.rejected).toBe(1)
    expect(s.stabilizationAttempts).toBe(0)
    expect(s.verificationAttempts).toBe(0)
    expect(s.reindexAttempts).toBe(0)
  })

  it('arquivo ignorado (Git stub) não atinge stabilization nem reindex', async () => {
    writeFileSync(join(repoPath, 'secret.env'), 'SECRET=abc\n', 'utf-8')
    const harness = new SyncHarness()
    const membership = new RepositoryFileMembership(repoPath, makeGitStub(true, ['secret.env']))
    const model = makeModelStub(repoPath)
    sync = new RepositorySynchronizer(model, 'test-repo-id', { membership, harness })

    repositoryEventBus.emitFileModified('test-repo-id', 'secret.env')
    await new Promise(r => setTimeout(r, WAIT_MS))

    const s = harness.snapshot()
    expect(s.rejected).toBe(1)
    expect(s.stabilizationAttempts).toBe(0)
    expect(s.reindexAttempts).toBe(0)
  })

  it('path inexistente nunca indexado (deleted-unknown) é descartado', async () => {
    const harness = new SyncHarness()
    const membership = new RepositoryFileMembership(repoPath, makeGitStub(false))
    const model = makeModelStub(repoPath, []) // sem indexed paths
    sync = new RepositorySynchronizer(model, 'test-repo-id', { membership, harness })

    repositoryEventBus.emitFileModified('test-repo-id', 'ghost.ts')
    await new Promise(r => setTimeout(r, WAIT_MS))

    const s = harness.snapshot()
    expect(s.rejected).toBe(1)
    expect(s.stabilizationAttempts).toBe(0)
  })

  it('arquivo elegível avança para stabilization e verification', async () => {
    writeFileSync(join(repoPath, 'main.ts'), 'export const x = 1\n', 'utf-8')
    const harness = new SyncHarness()
    const membership = new RepositoryFileMembership(repoPath, makeGitStub(false))
    const model = makeModelStub(repoPath)
    sync = new RepositorySynchronizer(model, 'test-repo-id', { membership, harness })

    repositoryEventBus.emitFileModified('test-repo-id', 'main.ts')
    await new Promise(r => setTimeout(r, WAIT_MS))

    const s = harness.snapshot()
    expect(s.observations).toBe(1)
    expect(s.accepted).toBe(1)
    expect(s.stabilizationAttempts).toBe(1)
    expect(s.verificationAttempts).toBe(1)
    // Arquivo novo (não indexado) → reindex tentado
    expect(s.reindexAttempts).toBe(1)
  })

  it('burst de eventos do mesmo arquivo é coalesced — apenas 1 accepted', async () => {
    writeFileSync(join(repoPath, 'burst.ts'), 'export const x = 1\n', 'utf-8')
    const harness = new SyncHarness()
    const membership = new RepositoryFileMembership(repoPath, makeGitStub(false))
    const model = makeModelStub(repoPath)
    sync = new RepositorySynchronizer(model, 'test-repo-id', { membership, harness })

    // Emite 5 eventos rapidamente — devem ser coalescidos pelo debounce
    for (let i = 0; i < 5; i++) {
      repositoryEventBus.emitFileModified('test-repo-id', 'burst.ts')
    }
    await new Promise(r => setTimeout(r, WAIT_MS))

    const s = harness.snapshot()
    expect(s.observations).toBe(5) // 5 observados
    // Apenas 1 aceito (1 entra na fila, os outros 4 são dedup)
    expect(s.accepted).toBe(1)
    expect(s.stabilizationAttempts).toBe(1)
    expect(s.reindexAttempts).toBe(1)
  })

  it('sem membership: tudo é aceito (comportamento legado preservado)', async () => {
    writeFileSync(join(repoPath, 'main.ts'), 'export const x = 1\n', 'utf-8')
    const harness = new SyncHarness()
    const model = makeModelStub(repoPath)
    // Sem membership — fallback para accept-all
    sync = new RepositorySynchronizer(model, 'test-repo-id', { harness })

    repositoryEventBus.emitFileModified('test-repo-id', 'main.ts')
    await new Promise(r => setTimeout(r, WAIT_MS))

    const s = harness.snapshot()
    expect(s.rejected).toBe(0)
    expect(s.accepted).toBe(1)
  })
})

// ─── Correlation ID — causalidade por path ────────────────────────────────────

describe('Correlation ID causality', () => {
  it('PendingFileEntry preserva correlationId do evento de origem', async () => {
    const repoPath = makeTempDir()
    try {
      writeFileSync(join(repoPath, 'a.ts'), 'export {}', 'utf-8')
      const model = makeModelStub(repoPath)
      const capturedCids: string[] = []

      // Subscrevemos telemetria para capturar INTAKE_ACCEPTED e verificar que
      // o correlationId emitido corresponde ao do evento original.
      const origCid = 'deadbeef'
      const unsubscribe = telemetryService.subscribe((entry) => {
        if (entry.event === 'INTAKE_ACCEPTED' || entry.event === 'QUEUED') {
          capturedCids.push(entry.correlationId)
        }
      })

      const sync = new RepositorySynchronizer(model, 'test-repo-id')
      repositoryEventBus.emitFileModified('test-repo-id', 'a.ts', origCid)

      await new Promise(r => setTimeout(r, 900))

      sync.dispose()
      unsubscribe()
      await cleanupDir(repoPath)

      // O cid original deve aparecer tanto no QUEUED quanto no INTAKE_ACCEPTED
      expect(capturedCids).toContain(origCid)
    } catch (e) {
      await cleanupDir(repoPath)
      throw e
    }
  })
})

// ─── TelemetryService — subscription ─────────────────────────────────────────

describe('TelemetryService subscription', () => {
  it('subscriber recebe entradas de log', () => {
    const received: string[] = []
    const unsub = telemetryService.subscribe(e => received.push(e.event))
    telemetryService.log('test-cid', 'CODE_MAP', 'TEST_EVENT', { x: 1 })
    unsub()
    expect(received).toContain('TEST_EVENT')
  })

  it('subscriber recebe entradas de erro com isError=true', () => {
    const received: Array<{ event: string; isError: boolean }> = []
    const unsub = telemetryService.subscribe(e => received.push({ event: e.event, isError: e.isError }))
    telemetryService.logError('test-cid', 'CODE_MAP', 'TEST_ERROR')
    unsub()
    const found = received.find(r => r.event === 'TEST_ERROR')
    expect(found?.isError).toBe(true)
  })

  it('desassinatura remove o subscriber', () => {
    const received: string[] = []
    const unsub = telemetryService.subscribe(e => received.push(e.event))
    unsub()
    telemetryService.log('test-cid', 'CODE_MAP', 'AFTER_UNSUB')
    expect(received).not.toContain('AFTER_UNSUB')
  })

  it('subscriber que lança não derruba telemetria', () => {
    const unsub = telemetryService.subscribe(() => { throw new Error('bad subscriber') })
    expect(() => telemetryService.log('test-cid', 'CODE_MAP', 'RESILIENCE_TEST')).not.toThrow()
    unsub()
  })

  it('payload está disponível no subscriber', () => {
    const payloads: unknown[] = []
    const unsub = telemetryService.subscribe(e => { if (e.event === 'PAYLOAD_TEST') payloads.push(e.payload) })
    telemetryService.log('test-cid', 'CODE_MAP', 'PAYLOAD_TEST', { key: 'value' })
    unsub()
    expect(payloads[0]).toEqual({ key: 'value' })
  })
})
