import Database from 'better-sqlite3'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EntireProvider, type CommandRunner } from './entire-provider'
import { digest } from './privacy'
import { SessionStore } from './store'

const dirs: string[] = []
function tempRepo(): { root: string; storePath: string; repoId: string } {
  const base = mkdtempSync(join(tmpdir(), 'mi-store-'))
  dirs.push(base)
  const root = join(base, 'repo')
  const storePath = join(base, 'store', 'session-context.sqlite')
  mkdirSync(root, { recursive: true })
  mkdirSync(dirname(storePath), { recursive: true })
  return { root, storePath, repoId: 'repo-mi-test' }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('ModelIntelligenceStore & SessionStore v9 migration', () => {
  it('migrates a v8 database to v9 transactionally and supports readOnly reopen', () => {
    const { storePath, repoId } = tempRepo()
    const legacy = new Database(storePath)
    legacy.exec(`
      CREATE TABLE identity(repositoryId TEXT PRIMARY KEY, cursorKey TEXT NOT NULL, revision INTEGER NOT NULL);
      CREATE TABLE sessions(
        id TEXT PRIMARY KEY, provider TEXT NOT NULL DEFAULT 'entire', providerSessionId TEXT NOT NULL,
        providerVersion TEXT NOT NULL, agent TEXT NOT NULL, startedAt TEXT, endedAt TEXT,
        lastObserved TEXT NOT NULL, state TEXT NOT NULL, coverage TEXT NOT NULL,
        revision INTEGER NOT NULL, eventCount INTEGER NOT NULL, payloadBytes INTEGER NOT NULL,
        sourceDigest TEXT NOT NULL, sourceBytes INTEGER NOT NULL,
        worktreeId TEXT, generation TEXT, executionId TEXT, commitSha TEXT,
        sourceObservation TEXT NOT NULL DEFAULT '{}', importState TEXT NOT NULL DEFAULT 'UNKNOWN',
        coverageReasons TEXT NOT NULL DEFAULT '{}',
        UNIQUE(provider, agent, providerSessionId));
      CREATE TABLE events(
        id TEXT PRIMARY KEY, sessionId TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL, type TEXT NOT NULL, timestamp TEXT, tool TEXT, success INTEGER,
        files TEXT NOT NULL, sourcePosition INTEGER NOT NULL,
        digest TEXT NOT NULL, bytes INTEGER NOT NULL, omission TEXT, sanitized INTEGER NOT NULL,
        UNIQUE(sessionId, ordinal));
      CREATE TABLE session_associations(
        id TEXT PRIMARY KEY, sessionId TEXT NOT NULL, providerSessionId TEXT NOT NULL, provider TEXT NOT NULL,
        observedAt TEXT NOT NULL, payload TEXT NOT NULL, integrity TEXT NOT NULL);
      CREATE TABLE capture_health(
        id TEXT PRIMARY KEY, worktreeId TEXT NOT NULL, generation TEXT NOT NULL, cycleId TEXT NOT NULL,
        observedAt TEXT NOT NULL, payload TEXT NOT NULL, integrity TEXT NOT NULL);
      CREATE TABLE capture_health_latest(target TEXT PRIMARY KEY, observationId TEXT NOT NULL REFERENCES capture_health(id));
      INSERT INTO identity VALUES ('${repoId}', 'k1', 1);
      INSERT INTO sessions(id, provider, providerSessionId, providerVersion, agent, lastObserved, state, coverage, revision, eventCount, payloadBytes, sourceDigest, sourceBytes)
      VALUES ('s-v8', 'entire', 'p-v8', '0.12.2', 'codex', '2026-10-01T00:00:00.000Z', 'ENDED', 'PARTIAL', 1, 0, 0, 'd-v8', 0);
      PRAGMA user_version = 8;
    `)
    legacy.close()

    const store = new SessionStore(storePath, repoId)
    expect(store.session('s-v8').providerVersion).toBe('0.12.2')
    expect(store.modelIntelligence.summarizeSession('s-v8').coverageStatus).toBe('UNAVAILABLE')
    store.close()

    const ro = new SessionStore(storePath, repoId, true)
    expect(ro.session('s-v8').id).toBe('s-v8')
    expect(ro.modelIntelligence.listModelFacts('s-v8')).toEqual([])
    ro.close()

    expect(() => new SessionStore(storePath, 'wrong-repo', true)).toThrow('REPOSITORY_MISMATCH')
  })

  it('tracks 2 models in one session, preserves 0 vs null, avoids double-counting cumulative/subagent/checkpoint, and paginates', () => {
    const { storePath, repoId } = tempRepo()
    const store = new SessionStore(storePath, repoId)
    const { sessionId } = store.ingest({
      providerSessionId: 'multi-model-1',
      providerVersion: '0.13.4',
      agent: 'codex',
      state: 'ENDED',
      endedAt: '2026-11-20T12:00:00.000Z',
      coverage: 'PARTIAL',
      importState: 'METADATA_ONLY',
      sourceDigest: digest('multi-model-1'),
      sourceBytes: 0
    }, [])

    const firstWrite = store.modelIntelligence.recordFacts(sessionId, {
      modelFacts: [
        {
          scope: 'turn', scopeId: 'turn:1', ordinal: 1, sourceSurface: 'codex_native_jsonl',
          sourceVersion: '0.169.0-alpha.11.1', observability: 'requested', provider: 'openai',
          client: 'codex', model: 'gpt-5.4', effort: 'high', coverageStatus: 'COMPLETE'
        },
        {
          scope: 'turn', scopeId: 'turn:2', ordinal: 2, sourceSurface: 'codex_native_jsonl',
          sourceVersion: '0.169.0-alpha.11.1', observability: 'requested', provider: 'openai',
          client: 'codex', model: 'gpt-5.4-mini', effort: 'low', coverageStatus: 'COMPLETE'
        }
      ],
      usageFacts: [
        {
          usageScope: 'call_delta', scopeId: 'call:1', ordinal: 1, sourceSurface: 'codex_native_jsonl',
          sourceVersion: '0.169.0-alpha.11.1', observability: 'reported', model: 'gpt-5.4', effort: 'high',
          inputTokens: 100, cacheReadTokens: 0, outputTokens: 20, totalTokens: 120, coverageStatus: 'COMPLETE'
        },
        {
          usageScope: 'call_delta', scopeId: 'call:2', ordinal: 2, sourceSurface: 'codex_native_jsonl',
          sourceVersion: '0.169.0-alpha.11.1', observability: 'reported', model: 'gpt-5.4-mini', effort: 'low',
          inputTokens: 50, outputTokens: 10, totalTokens: 60, coverageStatus: 'COMPLETE'
        },
        {
          usageScope: 'session_cumulative', scopeId: 'cum:1', ordinal: 1, sourceSurface: 'codex_native_jsonl',
          sourceVersion: '0.169.0-alpha.11.1', observability: 'reported', model: 'gpt-5.4',
          inputTokens: 100, cacheReadTokens: 0, outputTokens: 20, totalTokens: 120, coverageStatus: 'COMPLETE'
        },
        {
          usageScope: 'session_cumulative', scopeId: 'cum:2', ordinal: 2, sourceSurface: 'codex_native_jsonl',
          sourceVersion: '0.169.0-alpha.11.1', observability: 'reported', model: 'gpt-5.4-mini',
          inputTokens: 150, cacheReadTokens: 0, outputTokens: 30, totalTokens: 180, coverageStatus: 'COMPLETE'
        },
        {
          usageScope: 'checkpoint_window', scopeId: 'cp-1', ordinal: 3, sourceSurface: 'entire_checkpoint_session_metadata',
          sourceVersion: '0.13.4', observability: 'reported', model: 'gpt-5.4',
          inputTokens: 100, outputTokens: 20, totalTokens: 120, coverageStatus: 'COMPLETE'
        },
        {
          usageScope: 'subagent_total', scopeId: 'sub-1', ordinal: 4, sourceSurface: 'codex_native_jsonl',
          sourceVersion: '0.169.0-alpha.11.1', observability: 'reported', model: 'gpt-5.4-mini',
          parentSessionId: sessionId, inputTokens: 900, outputTokens: 100, totalTokens: 1000, coverageStatus: 'COMPLETE'
        }
      ]
    })
    expect(firstWrite).toEqual({ written: true, modelRowsChanged: 2, usageRowsChanged: 6 })

    // Idempotent replay without mutating sourceDigest or revision
    const beforeSession = store.session(sessionId)
    const replay = store.modelIntelligence.recordFacts(sessionId, {
      modelFacts: [
        {
          scope: 'turn', scopeId: 'turn:1', ordinal: 1, sourceSurface: 'codex_native_jsonl',
          sourceVersion: '0.169.0-alpha.11.1', observability: 'requested', provider: 'openai',
          client: 'codex', model: 'gpt-5.4', effort: 'high', coverageStatus: 'COMPLETE'
        }
      ]
    })
    expect(replay).toEqual({ written: false, modelRowsChanged: 0, usageRowsChanged: 0 })
    const afterSession = store.session(sessionId)
    expect(afterSession.sourceDigest).toBe(beforeSession.sourceDigest)
    expect(afterSession.revision).toBe(beforeSession.revision)

    // Verify 0 vs null preservation on call_delta rows
    const deltas = store.modelIntelligence.listUsageFacts(sessionId, { usageScope: 'call_delta' })
    expect(deltas).toHaveLength(2)
    expect(deltas[0].cacheReadTokens).toBe(0)
    expect(deltas[1].cacheReadTokens).toBeNull()

    // Pagination check
    expect(store.modelIntelligence.listModelFacts(sessionId, { offset: 0, limit: 1 })).toHaveLength(1)
    expect(store.modelIntelligence.listModelFacts(sessionId, { offset: 1, limit: 1 })[0].model).toBe('gpt-5.4-mini')

    // Summary check: cumulative snapshot used (180), not summed with 120 or subagent (1000) or checkpoint (120)
    const summary = store.modelIntelligence.summarizeSession(sessionId)
    expect(summary.models).toEqual(['gpt-5.4', 'gpt-5.4-mini'])
    expect(summary.efforts).toEqual(['high', 'low'])
    expect(summary.primaryUsage).toEqual({
      scope: 'session_cumulative',
      input: 150,
      cacheRead: 0,
      output: 30,
      total: 180
    })
    expect(summary.checkpointUsage).toHaveLength(1)
    expect(summary.subagentUsage).toHaveLength(1)
    expect(summary.subagentUsage[0].total).toBe(1000)
    store.close()
  })

  it('ingests Entire 0.13.4 + 0.12.2 fixtures and rejects no-grant config without writing', async () => {
    const { root, storePath, repoId } = tempRepo()
    mkdirSync(join(root, '.entire'), { recursive: true })
    writeFileSync(join(root, '.entire', 'settings.local.json'), JSON.stringify({ strategy_options: { push_sessions: false } }))
    const exePath = join(dirname(storePath), 'entire.exe')
    writeFileSync(exePath, 'pinned fixture')
    const store = new SessionStore(storePath, repoId)

    // Negative no-grant case
    writeFileSync(join(dirname(storePath), 'session-context.provider.json'), JSON.stringify({
      enabled: false,
      repositoryId: repoId,
      executable: exePath,
      sha256: digest('pinned fixture'),
      version: '0.13.4'
    }))
    const providerNoGrant = new EntireProvider(store, root, () => {}, async () => ({ code: 0, text: '[]', limited: false }))
    try {
      await expect(providerNoGrant.refresh()).resolves.toMatchObject({ code: 'CAPTURE_NOT_ENABLED' })
      expect(store.count()).toBe(0)

      // 0.13.4 discovery with additive benign field & adversarial private field
      writeFileSync(join(dirname(storePath), 'session-context.provider.json'), JSON.stringify({
        enabled: true,
        repositoryId: repoId,
        executable: exePath,
        sha256: digest('pinned fixture'),
        version: '0.13.4'
      }))
      const makeRunner = (version: string, listPayload: unknown[]): CommandRunner => async (exe, args) => {
        if (exe === 'git' && args.includes('ls-files')) return { code: 1, limited: false, text: '' }
        if (args[0] === 'version') return { code: 0, limited: false, text: `Entire CLI ${version}\n` }
        if (args.includes('--help')) return { code: 0, limited: false, text: 'Flags: --json --transcript\n' }
        if (args[1] === 'list') return { code: 0, limited: false, text: JSON.stringify(listPayload) }
        return { code: 1, limited: false, text: '' }
      }
      const runner134 = makeRunner('0.13.4', [{
        session_id: 's-134',
        agent: 'codex',
        status: 'ENDED',
        worktree_path: root,
        started_at: '2026-11-20T10:00:00.000Z',
        ended_at: '2026-11-20T10:10:00.000Z',
        model: 'gpt-5.4',
        turns: 4,
        tokens: { input: 300, output: 100, cache_read: 0, total: 400, api_calls: 3 },
        provider_client: 'codex-cli',
        prompt_preview: 'PRIVATE_PROMPT_MUST_NOT_PERSIST'
      }])
      const provider134 = new EntireProvider(store, root, () => {}, runner134)
      await expect(provider134.refresh()).resolves.toMatchObject({ imported: 1 })
      const s134 = store.byProvider('s-134', 'entire', 'codex')!
      const sum134 = store.modelIntelligence.summarizeSession(s134.id)
      expect(sum134.models).toEqual(['gpt-5.4'])
      expect(sum134.primaryUsage).toEqual({
        scope: 'session_total',
        input: 300,
        output: 100,
        cacheRead: 0,
        total: 400,
        apiCalls: 3
      })
      expect(sum134.unknownFieldPaths).toEqual(['entire.session.provider_client'])
      expect(JSON.stringify(sum134)).not.toContain('PRIVATE_PROMPT_MUST_NOT_PERSIST')

      // 0.12.2 historical fixture without tokens
      writeFileSync(join(dirname(storePath), 'session-context.provider.json'), JSON.stringify({
        enabled: true,
        repositoryId: repoId,
        executable: exePath,
        sha256: digest('pinned fixture'),
        version: '0.12.2'
      }))
      const runner122 = makeRunner('0.12.2', [{
        session_id: 's-122',
        agent: 'claude-code',
        status: 'ENDED',
        worktree_path: root,
        started_at: '2026-09-01T10:00:00.000Z',
        ended_at: '2026-09-01T10:05:00.000Z'
      }])
      const provider122 = new EntireProvider(store, root, () => {}, runner122)
      await expect(provider122.refresh()).resolves.toMatchObject({ imported: 1 })
      const s122 = store.byProvider('s-122', 'entire', 'claude-code')!
      const sum122 = store.modelIntelligence.summarizeSession(s122.id)
      expect(sum122.primaryUsage).toEqual({ scope: 'unavailable' })
      expect(sum122.coverageStatus).toBe('UNAVAILABLE')
      expect(sum122.unavailableReasons).toContain('ENTIRE_0_12_2_NO_SESSION_TOKENS')
    } finally {
      store.close()
    }
  })
})
