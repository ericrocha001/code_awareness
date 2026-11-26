import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { stepCodexSourceIndex } from './native-codex-source'
import { nativeDigest } from './native-hooks'
import { nativeReferenceKey } from './native-session-references'
import { SessionStore, sessionStorePath } from './store'

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn()
})

function safeRemove(dir: string) {
  execFileSync(
    'node',
    ['-e', "require('node:fs').rmSync(process.argv[1], { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })", dir],
    { windowsHide: true }
  )
}

function setupCodexFixture(repoId: string) {
  const base = mkdtempSync(join(tmpdir(), 'u2-codex-skill-'))
  cleanup.push(() => safeRemove(base))
  const root = join(base, 'repo')
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git/HEAD'), 'ref: refs/heads/main\n')
  const storePath = sessionStorePath(base, repoId)
  const store = new SessionStore(storePath, repoId)
  cleanup.push(() => { try { store.close() } catch {} })
  const profile = join(base, 'codex-profile')
  const accHash = nativeDigest(JSON.stringify(['u', 'a']))
  const configPath = join(dirname(storePath), 'session-context.provider.json')
  writeFileSync(configPath, JSON.stringify({
    repositoryId: repoId,
    nativeSources: { codex: { profile, creatorAccountHash: accHash } }
  }))
  return { base, root, storePath, store, profile }
}

function writeRollout(
  profile: string,
  root: string,
  sessionUuid: string,
  records: Array<Record<string, unknown>>
) {
  const uuidDay = new Date(Number.parseInt(sessionUuid.replaceAll('-', '').slice(0, 12), 16))
    .toISOString()
    .slice(0, 10)
    .split('-')
  const rolloutDir = join(profile, 'sessions', ...uuidDay)
  mkdirSync(rolloutDir, { recursive: true })
  const rolloutPath = join(rolloutDir, `rollout-2026-11-26T10-00-00-${sessionUuid}.jsonl`)
  const header = {
    timestamp: '2026-11-26T10:00:00Z',
    type: 'session_meta',
    payload: {
      id: sessionUuid,
      session_id: sessionUuid,
      account_scoped: true,
      creator_user_id: 'u',
      creator_account_id: 'a',
      cwd: root,
      runtime_workspace_roots: [root],
      cli_version: '0.169.0-alpha.11.1'
    }
  }
  writeFileSync(rolloutPath, [header, ...records].map(r => JSON.stringify(r)).join('\n') + '\n')
  return rolloutPath
}

describe('U2 — Codex native route Skill pairing, staged isolation, and cleanup', () => {
  it('pairs Skill calls across chunks, hides staged events until promoted, avoids raw body in checkpoint, and cleans up on invalidate/purge', () => {
    const repoId = 'repo-u2-skill'
    const f = setupCodexFixture(repoId)
    const worktreeId = nativeDigest(`wt:${repoId}`)
    const generation = nativeDigest(`gen:${repoId}`)
    const session1 = '01a1e000-0000-7000-8000-000000000101'
    const session2 = '01a1e000-0000-7000-8000-000000000102'
    const nativeHash1 = nativeDigest(JSON.stringify([repoId, 'codex', session1]))
    const nativeHash2 = nativeDigest(JSON.stringify([repoId, 'codex', session2]))
    const SECRET_BODY = 'SECRET_SKILL_SECTION_BODY_MUST_NOT_PERSIST_IN_SQLITE'

    writeRollout(f.profile, f.root, session1, [
      { timestamp: '2026-11-26T10:00:01Z', type: 'turn_context', payload: { turn_id: 'turn-skill-1', cwd: f.root } },
      {
        timestamp: '2026-11-26T10:00:02Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'mcp__code_awareness__get_academy_skill',
          call_id: 'shared-call-id',
          arguments: JSON.stringify({
            skillId: 'sk-deploy',
            view: 'section',
            version: 1,
            path: 'SKILL.md',
            selector: 'sec-preflight'
          })
        }
      },
      {
        timestamp: '2026-11-26T10:00:03Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'get_academy_skill',
          call_id: 'dangling-call-id',
          arguments: JSON.stringify({ skillId: 'sk-dangling' })
        }
      },
      {
        timestamp: '2026-11-26T10:00:04Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'shared-call-id',
          output: JSON.stringify({
            structuredContent: {
              skillId: 'sk-deploy',
              scope: 'PROJECT',
              version: 1,
              packageHash: 'a'.repeat(64),
              path: 'SKILL.md',
              selector: 'sec-preflight',
              range: { startLine: 5, endLine: 15, startOffset: 40, endOffset: 180 },
              content: SECRET_BODY,
              offset: 0,
              totalCharacters: SECRET_BODY.length,
              nextOffset: null
            }
          })
        }
      }
    ])

    // Step 1: stop after 3 lines (staged, not promoted)
    const step1 = stepCodexSourceIndex({
      refs: f.store.references.native,
      storePath: f.storePath,
      repositoryId: repoId,
      worktreeId,
      generation,
      worktreeRoot: f.root,
      nativeHash: nativeHash1,
      sourceSessionId: session1,
      mode: 'STEP',
      stepBudget: { maxLines: 3 },
      assertCurrent: () => {}
    })
    expect(step1.status).toBe('INDEXING_PENDING')

    // Staged checkpoint must NOT expose skill_events yet
    const stagedQuery = f.store.skillIntelligence.querySkillEvents({ nativeSessionId: nativeHash1, skillId: 'sk-deploy' })
    expect(stagedQuery.events).toHaveLength(0)

    // Step 2: finish and promote
    const step2 = stepCodexSourceIndex({
      refs: f.store.references.native,
      storePath: f.storePath,
      repositoryId: repoId,
      worktreeId,
      generation,
      worktreeRoot: f.root,
      nativeHash: nativeHash1,
      sourceSessionId: session1,
      mode: 'STEP',
      stepBudget: { maxLines: 10 },
      assertCurrent: () => {}
    })
    expect(step2.status).toBe('READY')

    const promotedQuery = f.store.skillIntelligence.querySkillEvents({ nativeSessionId: nativeHash1 })
    expect(promotedQuery.events).toHaveLength(2)

    const delivered = promotedQuery.events.find(e => e.skillId === 'sk-deploy')!
    expect(delivered.observationClass).toBe('CONTENT_DELIVERED')
    expect(delivered.deliveryGranularity).toBe('FRAGMENT')
    expect(delivered.version).toBe(1)
    expect(delivered.versionStatus).toBe('EXACT')
    expect(delivered.packageHash).toBe('a'.repeat(64))
    expect(delivered.resourcePath).toBe('SKILL.md')
    expect(delivered.resourceSelector).toBe('sec-preflight')
    expect(delivered.callEventId).toBeTruthy()
    expect(delivered.resultEventId).toBeTruthy()
    expect(delivered.turnId).toBe('turn-skill-1')
    expect(delivered.sourceRevision).toBe(1)

    const dangling = promotedQuery.events.find(e => e.skillId === 'sk-dangling')!
    expect(dangling.observationClass).toBe('ATTEMPT_FAILED_OR_REFUSED')
    expect(dangling.errorCode).toBe('UNPAIRED_TOOL_CALL')
    expect(dangling.gaps).toContain('TOOL_RESULT_MISSING')

    // Verify no raw Skill body persisted anywhere in SQLite
    const rawDb = new Database(f.storePath, { readonly: true })
    cleanup.push(() => rawDb.close())
    const allSkillRows = JSON.stringify(rawDb.prepare('SELECT * FROM skill_events').all())
    expect(allSkillRows).not.toContain(SECRET_BODY)

    // Verify read-only store can query without mutating
    const roStore = new SessionStore(f.storePath, repoId, true)
    cleanup.push(() => roStore.close())
    expect(roStore.skillIntelligence.querySkillEvents({ nativeSessionId: nativeHash1, skillId: 'sk-deploy' }).events).toHaveLength(1)

    // Session 2 with the exact same call_id ('shared-call-id') must produce a distinct eventId
    writeRollout(f.profile, f.root, session2, [
      { timestamp: '2026-11-26T10:01:01Z', type: 'turn_context', payload: { turn_id: 'turn-skill-2', cwd: f.root } },
      {
        timestamp: '2026-11-26T10:01:02Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'get_academy_skill',
          call_id: 'shared-call-id',
          arguments: JSON.stringify({ skillId: 'sk-deploy', view: 'manifest', version: 2 })
        }
      },
      {
        timestamp: '2026-11-26T10:01:03Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'shared-call-id',
          output: JSON.stringify({
            skillId: 'sk-deploy',
            scope: 'PROJECT',
            version: 2,
            packageHash: 'b'.repeat(64),
            files: [{ path: 'SKILL.md', bytes: 100 }]
          })
        }
      }
    ])
    const stepS2 = stepCodexSourceIndex({
      refs: f.store.references.native,
      storePath: f.storePath,
      repositoryId: repoId,
      worktreeId,
      generation,
      worktreeRoot: f.root,
      nativeHash: nativeHash2,
      sourceSessionId: session2,
      mode: 'STEP',
      assertCurrent: () => {}
    })
    expect(stepS2.status).toBe('READY')
    const s2Delivered = f.store.skillIntelligence.querySkillEvents({ nativeSessionId: nativeHash2 }).events[0]
    expect(s2Delivered.eventId).not.toBe(delivered.eventId)
    expect(s2Delivered.observationClass).toBe('DISCOVERED_MANIFEST_FETCHED')

    // Invalidate session1 removes its skill_events & coverage while preserving session2
    const key1 = nativeReferenceKey('codex', repoId, worktreeId, generation, session1)
    f.store.references.native.invalidate(key1)
    expect(f.store.skillIntelligence.querySkillEvents({ nativeSessionId: nativeHash1 }).events).toHaveLength(0)
    expect(f.store.skillIntelligence.querySkillEvents({ nativeSessionId: nativeHash2 }).events).toHaveLength(1)

    // Purge provider removes remaining skill_events
    f.store.references.native.purgeProvider(repoId, 'codex')
    expect(f.store.skillIntelligence.querySkillEvents({ skillId: 'sk-deploy' }).events).toHaveLength(0)
  })
})
