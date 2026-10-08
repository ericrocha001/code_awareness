import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitService } from '../core/git-service'
import { createTempGitRepo, cleanupTempRepo, gitExec, stageAll, commit } from '../core/git-test-helpers'
import { GitHubGitTransport } from '../github/github-git-transport'
import { GitOperationsService } from './git-operations-service'
import { executeGitOperationsTool } from './git-operations-mcp'
import { ChannelMcpAdapter } from '../mcp/channel-mcp-adapter'
import { createMcpHttpServer } from '../mcp/mcp-http-server'
import type { ProjectContextNavigation } from '../core/context/project-context-navigation'
import type { WorktreeApprovalPort, WorktreeSnapshot } from './git-worktree-ownership'
import { GitWorktreeValidation } from './git-worktree-validation'
import { RuntimeIdentityProvider } from '../runtime-identity/runtime-identity-provider'
import type { ValidationLedger } from '../validation-ledger/validation-ledger'
import type { RecordProofInput, ValidationProof } from '../validation-ledger/validation-ledger-types'

const roots: string[] = []
const finishers: Array<() => Promise<void>> = []
afterEach(async () => { for (const finish of finishers.splice(0)) await finish(); for (const root of roots.splice(0)) await cleanupTempRepo(root) })

async function fixture(approval?: WorktreeApprovalPort) {
  const root = await createTempGitRepo(); roots.push(root)
  const external = mkdtempSync(join(tmpdir(), 'IDE worktrees ')); roots.push(external)
  writeFileSync(join(root, 'file.txt'), 'baseline\n')
  await stageAll(root); await commit(root, 'baseline')
  const a = join(external, 'agent a'), b = join(external, 'agent b')
  await gitExec(root, ['worktree', 'add', '-b', 'agent-a', a])
  await gitExec(root, ['worktree', 'add', '--detach', b])
  writeFileSync(join(a, 'file.txt'), 'changed\n')
  const git = new GitService()
  let active = true
  const service = new GitOperationsService(root, git, new GitHubGitTransport(null, git), { repositoryId: 'repository-test', isActive: () => active }, false, approval)
  const call = async (name: string, args = {}) => JSON.parse((await executeGitOperationsTool(service, name, args)).content[0].text)
  return { root, a, b, git, service, call, deactivate: () => { active = false } }
}

function worktreeSnapshot(s: WorktreeSnapshot): WorktreeSnapshot {
  return { branch: s.branch, head: s.head, indexRevision: s.indexRevision, worktreeRevision: s.worktreeRevision, operation: s.operation }
}

async function approvedWorktree(call: (name: string, args?: any) => Promise<any>, id: string, operations: string[], branches: string[], startPoints: string[] = [], paths: string[] = [], recovery = false) {
  const state = await call('inspect_worktree', { worktreeId: id })
  const request = await call('handoff_worktree_for_git', { action: recovery ? 'RECOVER' : 'REQUEST', worktreeId: id, snapshot: worktreeSnapshot(state), scope: { operations, paths, branches, startPoints }, durationSeconds: 300 })
  for (let i = 0; i < 600; i++) {
    const accepted = await call('handoff_worktree_for_git', { action: 'ACCEPT', requestId: request.requestId, requestCredential: request.requestCredential })
    if (accepted.state === 'KNOWN_GRANTED') return { worktreeId: id, leaseId: accepted.leaseId, leaseCredential: accepted.leaseCredential, snapshot: worktreeSnapshot(state) }
    if (accepted.state !== 'PENDING') throw new Error(accepted.code ?? accepted.state)
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error('APPROVAL_TIMEOUT')
}

describe('canonical worktree operations', () => {
  it('creates an exclusive checkpoint branch from detached HEAD only after handoff and refuses an occupied branch', async () => {
    const f = await fixture(async () => true)
    const before = await f.service.getState()
    const detached = (await f.call('discover_worktrees')).worktrees.find((w: any) => w.detached)
    const ownership = await approvedWorktree(f.call, detached.worktreeId, ['CREATE_BRANCH'], ['checkpoint-b', 'agent-a'])
    const created = await f.call('mutate_worktree', { ...ownership, action: 'CREATE_BRANCH', operationId: 'branch-detached', branch: 'checkpoint-b' })
    expect(created).toMatchObject({ branch: 'checkpoint-b', head: detached.head, dirty: false })
    expect(await f.service.getState()).toEqual(before)
    const state = await f.call('inspect_worktree', { worktreeId: detached.worktreeId })
    expect(await f.call('mutate_worktree', { ...ownership, snapshot: worktreeSnapshot(state), action: 'CREATE_BRANCH', operationId: 'occupied-branch', branch: 'agent-a' })).toMatchObject({ code: 'WORKTREE_BRANCH_OCCUPIED' })
    expect(await f.git.getCurrentBranch(f.b)).toBe('checkpoint-b')
    expect(await f.git.getCurrentCommitHash(f.b)).toBe(detached.head)
    expect(await f.service.getState()).toEqual(before)
  }, 300000)

  it('refuses duplicate creation and preserves external, dirty, locked and unintegrated worktrees during cleanup', async () => {
    const f = await fixture(async () => true)
    const discovery = await f.call('discover_worktrees')
    const main = discovery.worktrees.find((w: any) => w.path === f.root)
    const external = discovery.worktrees.find((w: any) => w.path === f.a)
    await gitExec(f.root, ['branch', 'existing-unoccupied'])
    const duplicate = await approvedWorktree(f.call, main.worktreeId, ['CREATE_WORKTREE'], ['existing-unoccupied'], [main.head])
    expect(await f.call('manage_worktree', { ...duplicate, action: 'CREATE', operationId: 'duplicate-create', branch: 'existing-unoccupied', startPoint: main.head })).toMatchObject({ code: 'BRANCH_ALREADY_EXISTS' })
    const creation = await approvedWorktree(f.call, main.worktreeId, ['CREATE_WORKTREE'], ['cleanup-guard'], [main.head], [], true)
    const created = await f.call('manage_worktree', { ...creation, action: 'CREATE', operationId: 'create-cleanup', branch: 'cleanup-guard', startPoint: main.head })
    expect(created.result).toBe('CREATED')
    const workspace = created.worktree
    const close = async (id: string, operationId: string) => {
      const ownership = await approvedWorktree(f.call, id, ['CLOSE'], [main.branch])
      return f.call('manage_worktree', { ...ownership, action: 'CLOSE', operationId, preservedBranch: main.branch })
    }
    expect(await close(external.worktreeId, 'close-external')).toMatchObject({ code: 'WORKTREE_NOT_MANAGED' })
    expect(readFileSync(join(f.a, 'file.txt'), 'utf8')).toBe('changed\n')
    writeFileSync(join(workspace.path, 'dirty.txt'), 'keep dirty content')
    expect(await close(workspace.worktreeId, 'close-dirty')).toMatchObject({ code: 'DIRTY_WORKTREE' })
    expect(readFileSync(join(workspace.path, 'dirty.txt'), 'utf8')).toBe('keep dirty content')
    unlinkSync(join(workspace.path, 'dirty.txt'))
    await gitExec(f.root, ['worktree', 'lock', workspace.path])
    expect(await close(workspace.worktreeId, 'close-locked')).toMatchObject({ code: 'WORKTREE_LOCKED' })
    await gitExec(f.root, ['worktree', 'unlock', workspace.path])
    writeFileSync(join(workspace.path, 'unintegrated.txt'), 'keep commit\n'); await stageAll(workspace.path); await commit(workspace.path, 'unintegrated commit')
    expect(await close(workspace.worktreeId, 'close-unintegrated')).toMatchObject({ code: 'WORKTREE_PRESERVATION_REQUIRED' })
    expect(await gitExec(workspace.path, ['show', 'HEAD:unintegrated.txt'])).toBe('keep commit\n')
    expect((await f.call('discover_worktrees')).worktrees).toHaveLength(4)
  }, 600000)
  it('isolates conflicts in a managed checkout and resolves only explicitly approved content before an exact merge checkpoint', async () => {
    const f = await fixture(async () => true)
    await stageAll(f.a); await commit(f.a, 'source change')
    writeFileSync(join(f.root, 'file.txt'), 'target\n'); await stageAll(f.root); await commit(f.root, 'target change')
    const discovery = await f.call('discover_worktrees')
    const main = discovery.worktrees.find((w: any) => w.path === f.root)
    const source = discovery.worktrees.find((w: any) => w.path === f.a)
    const before = await f.service.getState()
    const preview = await f.call('preview_worktree_integration', { sourceWorktreeId: source.worktreeId, targetBranch: main.branch })
    const creation = await approvedWorktree(f.call, main.worktreeId, ['CREATE_WORKTREE'], ['conflict-integration'], [main.head])
    const created = await f.call('manage_worktree', { ...creation, action: 'CREATE', operationId: 'create-conflict', branch: 'conflict-integration', startPoint: main.head })
    expect(created.result).toBe('CREATED')
    const workspace = created.worktree
    const ownership = await approvedWorktree(f.call, workspace.worktreeId, ['INTEGRATE', 'COMMIT'], ['conflict-integration', main.branch], [source.head], ['file.txt'])
    expect(await f.call('integrate_worktree', { ...ownership, action: 'APPLY', operationId: 'apply-conflict', previewId: preview.previewId })).toMatchObject({ result: 'CONFLICTS', paths: ['file.txt'], integrationValidated: false })
    expect(await f.service.getState()).toEqual(before)
    expect(await f.git.getCurrentCommitHash(f.a)).toBe(source.head)
    const conflicted = await f.call('inspect_worktree', { worktreeId: workspace.worktreeId })
    expect(conflicted).toMatchObject({ operation: 'MERGE', conflictCount: 1 })
    const evidence = await f.call('get_worktree_conflict', { worktreeId: workspace.worktreeId, path: 'file.txt', side: 'WORKTREE' })
    expect(evidence.content).toContain('<<<<<<<')
    const resolution = { ...ownership, snapshot: worktreeSnapshot(conflicted), operationId: 'resolve-conflict', path: 'file.txt', resolution: 'CONTENT', expectedConflictRevision: evidence.conflictRevision, content: 'both changes preserved\n' }
    expect(await f.call('resolve_worktree_conflict', resolution)).toMatchObject({ remainingConflictCount: 0, replayed: false })
    expect(await f.call('resolve_worktree_conflict', resolution)).toMatchObject({ replayed: true })
    const resolved = await f.call('inspect_worktree', { worktreeId: workspace.worktreeId })
    const checkpoint = await f.call('mutate_worktree', { ...ownership, snapshot: worktreeSnapshot(resolved), operationId: 'commit-merge-resolution', action: 'COMMIT', message: 'resolved integration checkpoint' })
    expect(checkpoint).toMatchObject({ dirty: false, operation: null })
    expect((await gitExec(workspace.path, ['rev-list', '--parents', '-n', '1', 'HEAD'])).trim().split(' ')).toHaveLength(3)
    expect(await f.service.getState()).toEqual(before)
    expect(await gitExec(workspace.path, ['show', 'HEAD:file.txt'])).toBe('both changes preserved\n')
  }, 600000)
  it('prepares and validates an isolated integration before promoting through approved target ownership', async () => {
    const f = await fixture(async () => true)
    writeFileSync(join(f.root, 'package.json'), JSON.stringify({ scripts: { 'test:node': 'node acceptance.cjs' } }))
    writeFileSync(join(f.root, 'acceptance.cjs'), "require('node:assert/strict').match(require('node:fs').readFileSync('file.txt','utf8'),/^changed\\r?\\n$/)")
    await stageAll(f.root); await commit(f.root, 'validation profile')
    await gitExec(f.a, ['add', 'file.txt']); await commit(f.a, 'implementation')
    const identity = { repositoryId: 'repository-test', isActive: () => true }
    const proofs = new Map<string, ValidationProof>()
    const ledger = { recordProof: (input: RecordProofInput) => {
      const proof = { ...input, proofId: `proof-${proofs.size + 1}`, recordedAt: new Date().toISOString() } as ValidationProof
      proofs.set(proof.proofId, proof); return proof
    }, getProof: (id: string) => proofs.get(id) ?? null } as unknown as ValidationLedger
    const validation = new GitWorktreeValidation(f.root, f.git, identity, ledger, new RuntimeIdentityProvider({ rootDir: f.root }))
    finishers.push(() => validation.shutdown())
    const service = new GitOperationsService(f.root, f.git, new GitHubGitTransport(null, f.git), identity, false, async () => true, false, validation)
    const adapter = new ChannelMcpAdapter({ projectId: 'test', repoRoot: f.root, navigation: {} as ProjectContextNavigation, gitOperations: service })
    const server = createMcpHttpServer(adapter, () => {})
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    finishers.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('NO_ENDPOINT')
    const call = async (name: string, args = {}) => {
      const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
      const reply = await response.json() as { result: { content: Array<{ text: string }> } }
      return JSON.parse(reply.result.content[0].text)
    }
    const snapshot = (s: WorktreeSnapshot) => ({ branch: s.branch, head: s.head, indexRevision: s.indexRevision, worktreeRevision: s.worktreeRevision, operation: s.operation })
    const grant = async (id: string, operations: string[], branches: string[], startPoints: string[], recovery = false) => {
      const state = await call('inspect_worktree', { worktreeId: id })
      const pending = await call('handoff_worktree_for_git', { action: recovery ? 'RECOVER' : 'REQUEST', worktreeId: id, snapshot: snapshot(state), scope: { operations, paths: [], branches, startPoints }, durationSeconds: 300 })
      for (let i = 0; i < 600; i++) {
        const accepted = await call('handoff_worktree_for_git', { action: 'ACCEPT', requestId: pending.requestId, requestCredential: pending.requestCredential })
        if (accepted.state === 'KNOWN_GRANTED') return { worktreeId: id, leaseId: accepted.leaseId, leaseCredential: accepted.leaseCredential, snapshot: snapshot(state) }
        if (accepted.state !== 'PENDING') throw new Error(accepted.code ?? accepted.state)
        await new Promise(resolve => setTimeout(resolve, 200))
      }
      throw new Error('APPROVAL_TIMEOUT')
    }
    const discovery = await call('discover_worktrees')
    const main = discovery.worktrees.find((w: any) => w.path === f.root)
    const source = discovery.worktrees.find((w: any) => w.branch === 'agent-a')
    const before = await service.getState()
    const preview = await call('preview_worktree_integration', { sourceWorktreeId: source.worktreeId, targetBranch: main.branch })
    expect(preview).toMatchObject({ mode: 'MERGE', promotionBlockers: ['TARGET_OWNERSHIP_REQUIRED'] })
    const creation = await grant(main.worktreeId, ['CREATE_WORKTREE'], ['integration-check'], [main.head])
    const created = await call('manage_worktree', { ...creation, operationId: 'create-integration', action: 'CREATE', branch: 'integration-check', startPoint: main.head })
    expect(created.result).toBe('CREATED')
    await call('handoff_worktree_for_git', { action: 'RELEASE', worktreeId: main.worktreeId, leaseId: creation.leaseId, leaseCredential: creation.leaseCredential })
    const workspace = created.worktree
    const integration = await grant(workspace.worktreeId, ['INTEGRATE'], ['integration-check', main.branch], [source.head])
    const applied = await call('integrate_worktree', { ...integration, operationId: 'apply-integration', action: 'APPLY', previewId: preview.previewId })
    expect(applied).toMatchObject({ result: 'INTEGRATION_PREPARED', integrationValidated: false })
    expect(readFileSync(join(workspace.path, 'file.txt'), 'utf8')).toMatch(/^changed\r?\n$/)
    expect(JSON.parse(readFileSync(join(workspace.path, 'package.json'), 'utf8')).scripts['test:node']).toBe('node acceptance.cjs')
    expect(await service.getState()).toEqual(before)
    await call('handoff_worktree_for_git', { action: 'RELEASE', worktreeId: workspace.worktreeId, leaseId: integration.leaseId, leaseCredential: integration.leaseCredential })
    const prepared = await call('inspect_worktree', { worktreeId: workspace.worktreeId })
    const verification = await grant(workspace.worktreeId, ['INTEGRATE'], ['integration-check', main.branch], [prepared.head])
    const started = await call('start_worktree_validation', { ...verification, operationId: 'validate-integration', profileId: 'test-node' })
    expect(started.status).toBe('RUNNING')
    let done: any
    for (let i = 0; i < 150; i++) {
      done = await call('get_worktree_validation', { runId: started.runId })
      if (done.status !== 'RUNNING') break
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    expect(done, JSON.stringify(done)).toMatchObject({ status: 'PASSED' })
    expect(proofs.get(done.proofId)?.commandProfile).toMatchObject({ cwd: workspace.path, checkout: { worktreeId: workspace.worktreeId, head: prepared.head, issuer: 'VALIDATION_EXECUTION' } })
    expect(await validation.verify(workspace.worktreeId, prepared.head, [done.proofId])).toBe(true)
    expect(await validation.verify(workspace.worktreeId, source.head, [done.proofId])).toBe(false)
    const genuine = proofs.get(done.proofId)!
    proofs.set(done.proofId, { ...genuine, commandProfile: { ...genuine.commandProfile!, cwd: f.root } })
    expect(await validation.verify(workspace.worktreeId, prepared.head, [done.proofId])).toBe(false)
    proofs.set(done.proofId, genuine)
    expect(await call('integrate_worktree', { ...verification, action: 'PROMOTE', operationId: 'unowned-target', previewId: preview.previewId, integrationWorktreeId: workspace.worktreeId, proofIds: [done.proofId] })).toMatchObject({ code: 'WORKTREE_TARGET_OWNERSHIP_REQUIRED' })
    expect(await service.getState()).toEqual(before)
    writeFileSync(join(f.root, 'local-note.txt'), 'preserve this dirty target')
    const dirtyPreview = await call('preview_worktree_integration', { sourceWorktreeId: source.worktreeId, targetBranch: main.branch })
    expect(dirtyPreview.promotionBlockers).toContain('TARGET_DIRTY')
    const target = await grant(main.worktreeId, ['INTEGRATE'], [main.branch], [prepared.head])
    expect(await call('integrate_worktree', { ...target, action: 'PROMOTE', operationId: 'dirty-target', previewId: dirtyPreview.previewId, integrationWorktreeId: workspace.worktreeId, proofIds: [done.proofId] })).toMatchObject({ code: 'DIRTY_WORKTREE' })
    expect(readFileSync(join(f.root, 'local-note.txt'), 'utf8')).toBe('preserve this dirty target')
    expect((await service.getState()).head).toBe(before.head)
    unlinkSync(join(f.root, 'local-note.txt'))
    const freshPreview = await call('preview_worktree_integration', { sourceWorktreeId: source.worktreeId, targetBranch: main.branch })
    const recovered = await grant(main.worktreeId, ['INTEGRATE'], [main.branch], [prepared.head], true)
    const promoteArgs = { ...recovered, action: 'PROMOTE', operationId: 'promote-integration', previewId: freshPreview.previewId, integrationWorktreeId: workspace.worktreeId, proofIds: [done.proofId] }
    const promoted = await call('integrate_worktree', promoteArgs)
    expect(promoted).toMatchObject({ result: 'INTEGRATED', validation: 'INTEGRATION_VALIDATED', integratedHead: prepared.head })
    expect(await gitExec(f.root, ['show', 'HEAD:file.txt'])).toBe('changed\n')
    expect(await call('integrate_worktree', promoteArgs)).toMatchObject({ replayed: true })
    expect(await call('integrate_worktree', { ...promoteArgs, operationId: 'stale-preview', snapshot: snapshot(await call('inspect_worktree', { worktreeId: main.worktreeId })) })).toMatchObject({ code: 'WORKTREE_PREVIEW_STALE' })
    writeFileSync(join(f.b, 'second.txt'), 'second session\n')
    await stageAll(f.b); await commit(f.b, 'second session checkpoint')
    const second = (await call('discover_worktrees')).worktrees.find((w: any) => w.path === f.b)
    const secondPreview = await call('preview_worktree_integration', { sourceWorktreeId: second.worktreeId, targetBranch: main.branch })
    const combining = await grant(workspace.worktreeId, ['INTEGRATE'], ['integration-check', main.branch], [second.head], true)
    expect(await call('integrate_worktree', { ...combining, action: 'APPLY', operationId: 'apply-second', previewId: secondPreview.previewId })).toMatchObject({ result: 'INTEGRATION_PREPARED' })
    expect((await service.getState()).head).toBe(prepared.head)
    const secondPrepared = await call('inspect_worktree', { worktreeId: workspace.worktreeId })
    expect(await validation.verify(workspace.worktreeId, secondPrepared.head, [done.proofId])).toBe(false)
    expect(readFileSync(join(workspace.path, 'second.txt'), 'utf8')).toMatch(/^second session\r?\n$/)
    await call('handoff_worktree_for_git', { action: 'RELEASE', worktreeId: workspace.worktreeId, leaseId: combining.leaseId, leaseCredential: combining.leaseCredential })
    const secondVerification = await grant(workspace.worktreeId, ['INTEGRATE', 'PUSH'], ['integration-check', main.branch], [secondPrepared.head])
    const secondStarted = await call('start_worktree_validation', { ...secondVerification, operationId: 'validate-second', profileId: 'test-node' })
    expect(secondStarted.status).toBe('RUNNING')
    let secondDone: any
    for (let i = 0; i < 150; i++) {
      secondDone = await call('get_worktree_validation', { runId: secondStarted.runId })
      if (secondDone.status !== 'RUNNING') break
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    expect(secondDone, JSON.stringify(secondDone)).toMatchObject({ status: 'PASSED', freshness: 'CURRENT' })
    const remote = mkdtempSync(join(tmpdir(), 'worktree-publish-')); roots.push(remote)
    await gitExec(f.root, ['init', '--bare', remote]); await gitExec(f.root, ['remote', 'add', 'origin', remote])
    const publishArgs = { ...secondVerification, snapshot: snapshot(await call('inspect_worktree', { worktreeId: workspace.worktreeId })), operationId: 'publish-second', branch: 'integration-check', remote: 'origin' }
    expect(await call('publish_worktree', publishArgs)).toMatchObject({ result: 'PUBLISHED', integrated: false, pushedHead: secondPrepared.head })
    expect((await service.getState()).head).toBe(prepared.head)
    expect((await gitExec(remote, ['rev-parse', 'refs/heads/integration-check'])).trim()).toBe(secondPrepared.head)
    expect(await call('publish_worktree', publishArgs)).toMatchObject({ replayed: true })
    const secondTarget = await grant(main.worktreeId, ['INTEGRATE'], [main.branch], [secondPrepared.head], true)
    expect(await call('integrate_worktree', { ...secondTarget, action: 'PROMOTE', operationId: 'promote-second', previewId: secondPreview.previewId, integrationWorktreeId: workspace.worktreeId, proofIds: [secondDone.proofId] })).toMatchObject({ result: 'INTEGRATED', integratedHead: secondPrepared.head, validation: 'INTEGRATION_VALIDATED' })
    expect(await gitExec(f.root, ['show', 'HEAD:second.txt'])).toBe('second session\n')
    expect(await f.git.getCurrentCommitHash(f.a)).toBe(source.head)
    expect(await f.git.getCurrentCommitHash(f.b)).toBe(second.head)
    await validation.shutdown()
  }, 1200000)
  it('creates a managed branch/worktree without a project switch and closes only a preserved managed checkout', async () => {
    const f = await fixture(async () => true)
    const discovery = await f.call('discover_worktrees')
    const main = discovery.worktrees.find((w: any) => w.path === f.root)
    const before = await f.service.getState()
    const snapshot = (state: WorktreeSnapshot): WorktreeSnapshot => ({ branch: state.branch, head: state.head, indexRevision: state.indexRevision, worktreeRevision: state.worktreeRevision, operation: state.operation })
    const grant = async (id: string, operations: string[], branches: string[], startPoints: string[] = []) => {
      return approvedWorktree(f.call, id, operations, branches, startPoints)
    }
    const creation = await grant(main.worktreeId, ['CREATE_WORKTREE'], ['managed-integration'], [before.head!])
    const createArgs = { action: 'CREATE', ...creation, operationId: 'create-managed', branch: 'managed-integration', startPoint: before.head }
    const allowedCreate = { action: createArgs.action, worktreeId: createArgs.worktreeId, leaseId: createArgs.leaseId, leaseCredential: createArgs.leaseCredential, snapshot: createArgs.snapshot, operationId: createArgs.operationId, branch: createArgs.branch, startPoint: createArgs.startPoint }
    const created = await f.call('manage_worktree', allowedCreate)
    expect(created).toMatchObject({ result: 'CREATED', managed: true, projectChanged: false })
    expect(created.worktree.path).not.toBe(f.a)
    expect((await f.call('discover_worktrees')).worktrees).toHaveLength(4)
    expect(await f.call('manage_worktree', allowedCreate)).toMatchObject({ replayed: true })
    expect(await f.service.getState()).toEqual(before)
    const closing = await grant(created.worktree.worktreeId, ['CLOSE'], [before.branch!])
    const closeArgs = { action: 'CLOSE', worktreeId: created.worktree.worktreeId, leaseId: closing.leaseId, leaseCredential: closing.leaseCredential, snapshot: closing.snapshot, operationId: 'close-managed', preservedBranch: before.branch }
    expect(await f.call('manage_worktree', closeArgs)).toMatchObject({ result: 'CLOSED' })
    expect(await f.call('manage_worktree', closeArgs)).toMatchObject({ result: 'CLOSED', replayed: true })
    expect((await f.call('discover_worktrees')).worktrees).toHaveLength(3)
    expect(await f.service.getState()).toEqual(before)
  }, 300000)

  it('requires a locally approved handoff and commits exactly the selected checkpoint with recoverable receipts', async () => {
    let approve!: (allow: boolean) => void
    const f = await fixture(() => new Promise(resolve => { approve = resolve }))
    const beforeMain = await f.service.getState()
    const id = (await f.call('discover_worktrees')).worktrees.find((w: any) => w.branch === 'agent-a').worktreeId
    const inspected = await f.call('inspect_worktree', { worktreeId: id })
    const snapshot = (state: WorktreeSnapshot): WorktreeSnapshot => ({ branch: state.branch, head: state.head, indexRevision: state.indexRevision, worktreeRevision: state.worktreeRevision, operation: state.operation })
    const request = await f.call('handoff_worktree_for_git', { action: 'REQUEST', worktreeId: id, snapshot: snapshot(inspected), scope: { operations: ['STAGE', 'COMMIT'], paths: ['file.txt'], branches: [] }, durationSeconds: 300 })
    expect(await f.call('handoff_worktree_for_git', { action: 'ACCEPT', requestId: request.requestId, requestCredential: request.requestCredential })).toMatchObject({ state: 'PENDING', mutationAllowed: false })
    const stage = { action: 'STAGE', worktreeId: id, leaseId: request.requestId, leaseCredential: request.requestCredential, operationId: 'stage-worktree', snapshot: snapshot(inspected), paths: ['file.txt'] }
    expect(await f.call('mutate_worktree', stage)).toMatchObject({ code: 'WORKTREE_OWNERSHIP_REQUIRED' })
    approve(true)
    let lease: any
    for (let i = 0; i < 600; i++) {
      lease = await f.call('handoff_worktree_for_git', { action: 'ACCEPT', requestId: request.requestId, requestCredential: request.requestCredential })
      if (lease.state !== 'PENDING') break
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    expect(lease.state).toBe('KNOWN_GRANTED')
    const staged = await f.call('mutate_worktree', stage)
    expect(staged).toMatchObject({ stagedCount: 1, replayed: false })
    expect(await f.call('mutate_worktree', stage)).toMatchObject({ replayed: true, indexRevision: staged.indexRevision })
    expect(await f.call('mutate_worktree', { ...stage, paths: ['different.txt'] })).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    const committed = await f.call('mutate_worktree', { action: 'COMMIT', worktreeId: id, leaseId: lease.leaseId, leaseCredential: lease.leaseCredential, operationId: 'commit-worktree', snapshot: snapshot(staged), message: 'checkpoint' })
    expect(committed).toMatchObject({ dirty: false, stagedCount: 0, replayed: false })
    expect(await gitExec(f.a, ['show', '--format=', '--name-only', 'HEAD'])).toBe('file.txt\n')
    expect(await f.service.getState()).toEqual(beforeMain)
    expect(await f.call('handoff_worktree_for_git', { action: 'RELEASE', worktreeId: id, leaseId: lease.leaseId, leaseCredential: lease.leaseCredential })).toMatchObject({ state: 'RELEASED' })
    expect((await f.call('inspect_worktree', { worktreeId: id })).ownership).toBe('NOT_GRANTED')
  }, 300000)

  it('serves selective source through the real MCP HTTP route and keeps scoped mutation read-only', async () => {
    const f = await fixture()
    const adapter = new ChannelMcpAdapter({ projectId: 'test', repoRoot: f.root, navigation: {} as ProjectContextNavigation, gitOperations: f.service })
    const server = createMcpHttpServer(adapter, () => {})
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('NO_ENDPOINT')
      const call = async (name: string, args: object) => {
        const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
        const reply = await response.json() as { result: { content: Array<{ text: string }> } }
        return JSON.parse(reply.result.content[0].text)
      }
      const id = (await call('discover_worktrees', {})).worktrees.find((w: any) => w.branch === 'agent-a').worktreeId
      expect(await call('read_worktree_file', { worktreeId: id, path: 'file.txt', startLine: 1, endLine: 1 })).toMatchObject({ content: 'changed\n' })
      const selected = await f.service.selectWorktree(id)
      const before = await selected.service.getState()
      await expect(selected.service.stage({ mode: 'STAGE', paths: ['file.txt'], expectedIndexRevision: before.indexRevision, expectedWorktreeRevision: before.worktreeRevision })).rejects.toThrow('WORKTREE_OWNERSHIP_REQUIRED')
      expect(await selected.service.getState()).toEqual(before)
      expect(await call('stage_git_changes', { worktreeId: id, mode: 'STAGE', paths: ['file.txt'], expectedIndexRevision: before.indexRevision, expectedWorktreeRevision: before.worktreeRevision, operationId: 'no-ownership' })).toMatchObject({ code: 'INVALID_ARGUMENT' })
    } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
  }, 60000)

  it('bounds diff and change pages and rejects continuation after drift or a different worktree', async () => {
    const f = await fixture()
    const discovery = await f.call('discover_worktrees')
    const id = discovery.worktrees.find((w: any) => w.branch === 'agent-a').worktreeId
    const other = discovery.worktrees.find((w: any) => w.detached).worktreeId
    for (let i = 0; i < 101; i++) writeFileSync(join(f.a, `new-${i}.txt`), 'content\n')
    const changes = await f.call('get_worktree_changes', { worktreeId: id })
    expect(changes.changes).toHaveLength(100)
    expect((await f.call('get_worktree_changes', { worktreeId: id, cursor: changes.nextCursor })).changes).toHaveLength(2)
    writeFileSync(join(f.a, 'file.txt'), 'Δ 🚀\n'.repeat(5000))
    const diff = await f.call('get_worktree_diff', { worktreeId: id, paths: ['file.txt'], mode: 'WORKTREE' })
    expect(Buffer.byteLength(diff.patch)).toBeLessThanOrEqual(24000)
    expect(diff.nextCursor).toBeTruthy()
    expect(await f.call('get_worktree_diff', { worktreeId: other, paths: ['file.txt'], mode: 'WORKTREE', cursor: diff.nextCursor })).toMatchObject({ code: 'GIT_STATE_CHANGED' })
    writeFileSync(join(f.a, 'new-0.txt'), 'drift\n')
    expect(await f.call('get_worktree_changes', { worktreeId: id, cursor: changes.nextCursor })).toMatchObject({ code: 'GIT_STATE_CHANGED' })
    expect(await f.call('get_worktree_diff', { worktreeId: id, paths: ['file.txt'], mode: 'WORKTREE', cursor: diff.nextCursor })).toMatchObject({ code: 'GIT_STATE_CHANGED' })
  }, 60000)

  it('reads literal dirty/untracked intervals and rejects metadata, traversal, junctions, binary and stale revisions', async () => {
    const f = await fixture()
    const id = (await f.call('discover_worktrees')).worktrees.find((w: any) => w.branch === 'agent-a').worktreeId
    const literal = '\uFEFFprimeira\r\nΔ 🚀 segunda\r\nterceira'
    writeFileSync(join(f.a, 'unicode.txt'), literal)
    const request = { worktreeId: id, path: 'unicode.txt', startLine: 2, endLine: 2 }
    const read = await f.call('read_worktree_file', request)
    expect(read.content).toBe('Δ 🚀 segunda\r\n')
    expect((await f.call('read_worktree_file', { ...request, startLine: 1, endLine: 3 })).content).toBe(literal)
    expect((await f.call('get_worktree_changes', { worktreeId: id })).changes).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'unicode.txt', untracked: true })]))
    expect((await f.call('get_worktree_diff', { worktreeId: id, paths: ['file.txt'], mode: 'WORKTREE' })).patch).toContain('+changed')
    for (const path of ['../file.txt', '.git', '.git/config', 'C:/Windows/win.ini']) {
      expect(await f.call('read_worktree_file', { ...request, path })).toMatchObject({ code: 'PATH_OUTSIDE_REPOSITORY' })
    }
    const outside = join(f.root, 'outside'); mkdirSync(outside)
    writeFileSync(join(outside, 'secret.txt'), 'secret')
    symlinkSync(outside, join(f.a, 'escape'), 'junction')
    expect(await f.call('read_worktree_file', { ...request, path: 'escape/secret.txt', startLine: 1, endLine: 1 })).toMatchObject({ code: 'PATH_OUTSIDE_REPOSITORY' })
    writeFileSync(join(f.a, 'binary'), Buffer.from([0, 1, 2]))
    expect(await f.call('read_worktree_file', { ...request, path: 'binary' })).toMatchObject({ code: 'WORKTREE_FILE_BINARY' })
    writeFileSync(join(f.a, 'large.txt'), 'x'.repeat(24001))
    expect(await f.call('read_worktree_file', { ...request, path: 'large.txt', startLine: 1, endLine: 1 })).toMatchObject({ code: 'WORKTREE_RANGE_BYTE_LIMIT' })
    writeFileSync(join(f.a, 'unicode.txt'), 'different\n')
    expect(await f.call('read_worktree_file', { ...request, startLine: 1, endLine: 1, expectedRevision: read.revision })).toMatchObject({ code: 'GIT_STATE_CHANGED' })
  }, 60000)

  it('discovers main and external dirty/detached worktrees without changing the main checkout', async () => {
    const f = await fixture()
    const before = await f.service.getState()
    const discovery = await f.call('discover_worktrees')
    expect(discovery.repositoryId).toBe('repository-test')
    expect(discovery.worktrees).toHaveLength(3)
    expect(JSON.stringify(discovery)).not.toContain('changed')
    const dirty = discovery.worktrees.find((w: any) => w.branch === 'agent-a')
    expect(await f.call('inspect_worktree', { worktreeId: dirty.worktreeId })).toMatchObject({ dirty: true, ownership: 'NOT_GRANTED', mutationAllowed: false })
    expect(discovery.worktrees.some((w: any) => w.detached)).toBe(true)
    expect(await f.service.getState()).toEqual(before)
    expect(await f.call('inspect_worktree', { worktreeId: 'a'.repeat(64) })).toMatchObject({ code: 'WORKTREE_NOT_DISCOVERED' })
    expect(await f.call('inspect_worktree', { worktreeId: f.a })).toMatchObject({ code: 'INVALID_ARGUMENT' })
    f.deactivate()
    expect(await f.call('inspect_worktree', { worktreeId: dirty.worktreeId })).toMatchObject({ code: 'WORKTREE_REPOSITORY_CHANGED' })
  }, 60000)

  it('rejects missing and replaced registrations', async () => {
    const f = await fixture()
    const discovery = await f.call('discover_worktrees')
    const detached = discovery.worktrees.find((w: any) => w.detached)
    await gitExec(f.root, ['worktree', 'remove', f.b])
    await gitExec(f.root, ['worktree', 'add', '--detach', f.b])
    expect(await f.call('inspect_worktree', { worktreeId: detached.worktreeId })).toMatchObject({ code: 'WORKTREE_STALE' })
    const replacement = (await f.call('discover_worktrees')).worktrees.find((w: any) => w.detached)
    rmSync(f.b, { recursive: true })
    expect(await f.call('inspect_worktree', { worktreeId: replacement.worktreeId })).toMatchObject({ code: 'WORKTREE_STALE' })
  }, 60000)
})
