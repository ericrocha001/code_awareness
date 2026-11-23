import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { nativeDigest } from './native-hooks'
import {
  dismissSessionSourceOnboarding,
  grantSessionSourceAccess,
  inspectSessionSourceGrants,
  revokeSessionSourceAccess,
  updateLexicalIndexAccess
} from './session-source-grants'
import { SessionStore, sessionStorePath } from './store'

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn()
})

function safeRemove(dir: string) {
  execFileSync('node', ['-e', "require('node:fs').rmSync(process.argv[1], { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })", dir], { windowsHide: true })
}

function writeCodexHeader(codexProfile: string, sessionId: string, userId: string, accountId: string) {
  const dir = join(codexProfile, 'sessions', '2026', '11', '23')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `rollout-2026-11-23T10-00-00-${sessionId}.jsonl`),
    JSON.stringify({
      type: 'session_meta',
      payload: {
        id: sessionId,
        session_id: sessionId,
        account_scoped: true,
        creator_user_id: userId,
        creator_account_id: accountId
      }
    }) + '\n'
  )
}

it('U1 enables one-click grants per repository, preserves unknown keys, enforces idempotency/CAS/revocation, and handles ambiguous Codex accounts', () => {
  const base = mkdtempSync(join(tmpdir(), 'u1-grants-'))
  cleanup.push(() => safeRemove(base))
  const agProfile = join(base, 'ag-profile')
  const codexProfile = join(base, 'codex-profile')
  mkdirSync(agProfile, { recursive: true })
  mkdirSync(codexProfile, { recursive: true })
  writeCodexHeader(codexProfile, '01a1e000-0000-7000-8000-000000000001', 'u1', 'a1')

  const repoId = 'repo-u1-oneclick'
  const storePath = sessionStorePath(base, repoId)
  const configPath = join(dirname(storePath), 'session-context.provider.json')
  const opts = { antigravityProfile: agProfile, codexProfile }

  // 1. Initial state without config file -> MISSING, needsOnboarding: true, FTS off
  const initial = inspectSessionSourceGrants(base, repoId, opts)
  expect(initial.needsOnboarding).toBe(true)
  expect(initial.allowLexicalIndex).toBe(false)
  expect(initial.providers.antigravityApp).toMatchObject({ state: 'MISSING', eligible: true, allowLexicalIndex: false })
  expect(initial.providers.codex).toMatchObject({ state: 'MISSING', eligible: true, allowLexicalIndex: false })

  // Preserve unknown keys if config exists
  mkdirSync(dirname(configPath), { recursive: true })
  writeFileSync(configPath, JSON.stringify({ repositoryId: repoId, customNote: 'keep-me' }))

  // 2. ReadOnly cannot mutate
  expect(() => grantSessionSourceAccess({ baseProfile: base, repositoryId: repoId, options: { ...opts, readOnly: true } })).toThrow('STORE_READ_ONLY')

  // 3. One-click enable grants both eligible providers without enabling FTS5
  const enabled = grantSessionSourceAccess({ baseProfile: base, repositoryId: repoId, options: opts })
  expect(enabled.providers.antigravityApp.state).toBe('READY')
  expect(enabled.providers.codex.state).toBe('READY')
  expect(enabled.allowLexicalIndex).toBe(false)
  expect(enabled.needsOnboarding).toBe(false)

  const persisted = JSON.parse(readFileSync(configPath, 'utf8'))
  expect(persisted.customNote).toBe('keep-me')
  expect(persisted.nativeSources.codex.creatorAccountHash).toBe(nativeDigest(JSON.stringify(['u1', 'a1'])))
  expect(persisted.nativeSources.antigravityApp.allowLexicalIndex).toBe(false)

  // 4. Duplicate call is idempotent
  const idempotent = grantSessionSourceAccess({ baseProfile: base, repositoryId: repoId, options: opts })
  expect(idempotent.providers.antigravityApp.state).toBe('READY')
  expect(idempotent.providers.codex.state).toBe('READY')

  // 5. Other repositoryId remains isolated
  const other = inspectSessionSourceGrants(base, 'repo-other', opts)
  expect(other.providers.antigravityApp.state).toBe('MISSING')

  // 6. Toggle FTS5 on and off
  const ftsOn = updateLexicalIndexAccess({ baseProfile: base, repositoryId: repoId, allowLexicalIndex: true, options: opts })
  expect(ftsOn.allowLexicalIndex).toBe(true)
  const ftsOff = updateLexicalIndexAccess({ baseProfile: base, repositoryId: repoId, allowLexicalIndex: false, options: opts })
  expect(ftsOff.allowLexicalIndex).toBe(false)

  // 7. Revoke invalidates grants & derived SQLite store
  const store = new SessionStore(storePath, repoId)
  store.close()
  const revoked = revokeSessionSourceAccess({ baseProfile: base, repositoryId: repoId, provider: 'all', options: opts })
  expect(revoked.providers.antigravityApp.state).toBe('REVOKED')
  expect(revoked.providers.codex.state).toBe('REVOKED')
  expect(revoked.allowLexicalIndex).toBe(false)

  // 8. Multiple Codex accounts require explicit selection (never guess first)
  writeCodexHeader(codexProfile, '01a1e000-0000-7000-8000-000000000002', 'u2', 'a2')
  const multi = inspectSessionSourceGrants(base, repoId, opts)
  expect(multi.providers.codex.accountSelectionRequired).toBe(true)
  expect(multi.providers.codex.accountCandidates).toHaveLength(2)
  const partial = grantSessionSourceAccess({ baseProfile: base, repositoryId: repoId, options: opts })
  expect(partial.partialSuccess).toBe(true)
  expect(partial.providers.antigravityApp.state).toBe('READY')
  expect(partial.providers.codex.state).toBe('REVOKED')
  expect(() => grantSessionSourceAccess({
    baseProfile: base,
    repositoryId: repoId,
    selectedCodexAccountHash: '0'.repeat(64),
    options: opts
  })).toThrow('IDENTITY_MISMATCH')

  // 9. Dismiss suppresses onboarding banner
  const dismissed = dismissSessionSourceOnboarding({ baseProfile: base, repositoryId: 'repo-other', options: opts })
  expect(dismissed.dismissed).toBe(true)
  expect(dismissed.needsOnboarding).toBe(false)
}, 120_000)
