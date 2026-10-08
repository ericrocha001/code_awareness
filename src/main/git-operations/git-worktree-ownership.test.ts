import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import { afterEach, describe, expect, it } from 'vitest'
import { GitWorktreeOwnership, withWorktreeTransaction, type WorktreeObservation, type WorktreeApprovalPort } from './git-worktree-ownership'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture(approve: WorktreeApprovalPort) {
  const root = mkdtempSync(join(tmpdir(), 'ownership ')); roots.push(root)
  const common = join(root, 'common'), administrative = join(root, 'admin')
  mkdirSync(common); mkdirSync(administrative)
  let now = 1000
  const observed: WorktreeObservation = { repositoryId: 'repository', commonDirectory: common, administrativeDirectory: administrative,
    worktreeId: 'a'.repeat(64), generation: 'generation', path: root,
    snapshot: { branch: 'agent', head: 'a'.repeat(40), indexRevision: 'b'.repeat(64), worktreeRevision: 'c'.repeat(64), operation: null }, contentRevision: 'd'.repeat(64) }
  const observe = async () => structuredClone(observed)
  const manager = new GitWorktreeOwnership(observe, approve, () => now)
  const scope = { operations: ['STAGE' as const], paths: ['selected.txt'], branches: [] }
  return { root, common, administrative, manager, observed, observe, scope, advance: () => { now += 301000 }, clock: () => now }
}
async function accept(manager: GitWorktreeOwnership, request: { requestId: string; requestCredential: string }) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await manager.accept(request.requestId, request.requestCredential)
    if (value.state !== 'PENDING') return value
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('APPROVAL_DID_NOT_COMPLETE')
}

describe('local worktree ownership authority', () => {
  it('requires local recovery to reconcile an interrupted validation and revokes the previous grant', async () => {
    const f = fixture(async () => true)
    const old = await f.manager.request(f.observed.worktreeId, f.observed.snapshot, f.scope, 300)
    expect(await accept(f.manager, old)).toMatchObject({ state: 'KNOWN_GRANTED' })
    const directory = join(f.common, 'code-awareness-validation-locks'); mkdirSync(directory)
    const marker = join(directory, f.observed.worktreeId + '.lock')
    writeFileSync(marker, JSON.stringify({ pid: process.pid, worktreeId: f.observed.worktreeId, state: 'RECOVERY_PENDING' }))
    const ordinary = await f.manager.request(f.observed.worktreeId, f.observed.snapshot, f.scope, 300)
    expect(await accept(f.manager, ordinary)).toMatchObject({ state: 'FAILED', code: 'WORKTREE_RECOVERY_REQUIRED' })
    expect(readFileSync(marker, 'utf8')).toContain('RECOVERY_PENDING')
    const recovered = await f.manager.request(f.observed.worktreeId, f.observed.snapshot, f.scope, 300, true)
    expect(await accept(f.manager, recovered)).toMatchObject({ state: 'KNOWN_GRANTED' })
    await expect(f.manager.execute(f.observed.worktreeId, old.requestId, old.requestCredential, 'STAGE', async () => {})).rejects.toThrow('WORKTREE_OWNERSHIP_REQUIRED')
  })
  it('enforces the transaction lock against another Node process and leaves crash recovery fail-closed', async () => {
    const f = fixture(async () => false)
    const modulePath = join(f.root, 'ownership.cjs')
    writeFileSync(modulePath, transpileModule(readFileSync(join(process.cwd(), 'src/main/git-operations/git-worktree-ownership.ts'), 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText)
    const script = `const {withWorktreeTransaction}=require(process.argv[1]); withWorktreeTransaction(process.argv[2],process.argv[3],async()=>{process.stdout.write('LOCKED'); await new Promise(resolve=>process.stdin.once('data',resolve));}).then(()=>process.exit(0)).catch(()=>process.exit(1));`
    const child = spawn(process.execPath, ['-e', script, modulePath, f.common, f.administrative], { shell: false, stdio: ['pipe', 'pipe', 'pipe'] })
    try {
      const [data] = await once(child.stdout, 'data')
      expect(data.toString()).toBe('LOCKED')
      await expect(withWorktreeTransaction(f.common, f.administrative, async () => {})).rejects.toThrow('WORKTREE_TRANSACTION_BUSY')
      const exited = once(child, 'exit')
      child.kill()
      await exited
      await expect(withWorktreeTransaction(f.common, f.administrative, async () => {})).rejects.toThrow('WORKTREE_TRANSACTION_BUSY')
      expect(readFileSync(join(f.common, 'code-awareness-worktrees.lock'), 'utf8')).toContain(String(child.pid))
      const denied = await f.manager.request(f.observed.worktreeId, f.observed.snapshot, f.scope, 300, true)
      expect(await accept(f.manager, denied)).toMatchObject({ state: 'DENIED' })
      await expect(withWorktreeTransaction(f.common, f.administrative, async () => {})).rejects.toThrow('WORKTREE_TRANSACTION_BUSY')
      const reconciled = new GitWorktreeOwnership(f.observe, async () => true, f.clock)
      const recovery = await reconciled.request(f.observed.worktreeId, f.observed.snapshot, f.scope, 300, true)
      expect(await accept(reconciled, recovery)).toMatchObject({ state: 'KNOWN_GRANTED' })
      await withWorktreeTransaction(f.common, f.administrative, async () => {})
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill() }
  }, 10000)

  it('does not authorize a pending request; requires local approval and explicit acceptance', async () => {
    let decide!: (approved: boolean) => void
    const f = fixture(() => new Promise(resolve => { decide = resolve }))
    const request = await f.manager.request(f.observed.worktreeId, f.observed.snapshot, f.scope, 300)
    expect(await f.manager.accept(request.requestId, request.requestCredential)).toMatchObject({ state: 'PENDING', mutationAllowed: false })
    await expect(f.manager.execute(f.observed.worktreeId, request.requestId, request.requestCredential, 'STAGE', async () => writeFileSync(join(f.root, 'index'), 'mutated'))).rejects.toThrow('WORKTREE_OWNERSHIP_REQUIRED')
    decide(true)
    const grant = await accept(f.manager, request)
    expect(grant.state, JSON.stringify(grant)).toBe('KNOWN_GRANTED')
    await f.manager.execute(f.observed.worktreeId, request.requestId, request.requestCredential, 'STAGE', async () => writeFileSync(join(f.root, 'index'), 'selected'))
    expect(readFileSync(join(f.root, 'index'), 'utf8')).toBe('selected')
    await expect(f.manager.execute(f.observed.worktreeId, request.requestId, request.requestCredential, 'COMMIT', async () => {})).rejects.toThrow('WORKTREE_INTENT_NOT_GRANTED')
    expect(readFileSync(join(f.common, 'code-awareness-worktree-ownership', f.observed.worktreeId + '.json'), 'utf8')).not.toContain(request.requestCredential)
  })

  it('refuses drift, expired grants and restart takeover; only a new local reconciliation can recover', async () => {
    const f = fixture(async () => true)
    const request = await f.manager.request(f.observed.worktreeId, f.observed.snapshot, f.scope, 300)
    await accept(f.manager, request)
    f.observed.contentRevision = 'changed'
    await expect(f.manager.execute(f.observed.worktreeId, request.requestId, request.requestCredential, 'STAGE', async () => {})).rejects.toThrow('GIT_STATE_CHANGED')
    f.observed.contentRevision = 'd'.repeat(64)
    f.advance()
    await expect(f.manager.execute(f.observed.worktreeId, request.requestId, request.requestCredential, 'STAGE', async () => {})).rejects.toThrow('WORKTREE_GRANT_EXPIRED')
    const restarted = new GitWorktreeOwnership(f.observe, async () => true, f.clock)
    await expect(restarted.execute(f.observed.worktreeId, request.requestId, request.requestCredential, 'STAGE', async () => {})).rejects.toThrow('WORKTREE_RECOVERY_REQUIRED')
    const ordinary = await restarted.request(f.observed.worktreeId, f.observed.snapshot, f.scope, 300)
    expect(await accept(restarted, ordinary)).toMatchObject({ state: 'FAILED', code: 'WORKTREE_RECOVERY_REQUIRED' })
    const recovery = await restarted.request(f.observed.worktreeId, f.observed.snapshot, f.scope, 300, true)
    expect((await accept(restarted, recovery)).state).toBe('KNOWN_GRANTED')
    await restarted.execute(f.observed.worktreeId, recovery.requestId, recovery.requestCredential, 'RELEASE', async () => {})
    expect(await restarted.state(f.observed.worktreeId)).toBe('NOT_GRANTED')
  })

  it('serializes the common directory and preserves a stale lock instead of taking it over', async () => {
    const f = fixture(async () => false)
    await withWorktreeTransaction(f.common, f.administrative, async () => {
      await expect(withWorktreeTransaction(f.common, f.administrative, async () => {})).rejects.toThrow('WORKTREE_TRANSACTION_BUSY')
    })
    const stale = join(f.common, 'code-awareness-worktrees.lock')
    writeFileSync(stale, 'crashed transaction')
    await expect(withWorktreeTransaction(f.common, f.administrative, async () => {})).rejects.toThrow('WORKTREE_TRANSACTION_BUSY')
    expect(readFileSync(stale, 'utf8')).toBe('crashed transaction')
  })
})
