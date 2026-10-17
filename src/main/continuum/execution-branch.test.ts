import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { ArtifactStore } from './artifact-store'
import { ContinuumService } from './continuum-service'
import type { RepositoryContinuumSession } from './project-continuum-session'
import { GitService } from '../core/git-service'
import { GitBranchInventory } from '../git-operations/git-branch-inventory'
import { GitWorktreeRegistry } from '../git-operations/git-worktree-registry'
import { createTempGitRepo, cleanupTempRepo, gitExec } from '../core/git-test-helpers'
import { readBranchExecutions } from '../work-orchestration/branch-executions'

describe('execution binding with real Git and SQLite', () => {
  let root = '', store: ArtifactStore, service: ContinuumService, current = true
  afterEach(async () => { store?.close(); if (root) await cleanupTempRepo(root) })
  async function setup() {
    root = await createTempGitRepo(); current = true
    await gitExec(root, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
    await gitExec(root, ['commit', '--allow-empty', '-m', 'base'])
    const git = new GitService(), identity = { repositoryId: 'fixture', isActive: () => current }
    const registry = new GitWorktreeRegistry(root, git, identity), reader = new GitBranchInventory(root, git, registry, identity)
    store = new ArtifactStore(join(root, '.git', 'binding.db'), 'fixture')
    service = new ContinuumService(store, undefined, () => current)
    const plan = service.publish('---\nname: Plan on main\ndescription: Binding fixture\nkind: EXECUTABLE_PLAN\nexecutionId: execution-A\n---\nPlan')
    await gitExec(root, ['switch', '-c', 'executor'])
    const tree = (await reader.inventory()).worktrees[0]
    const observe = () => reader.executionSnapshot(tree.worktreeId, tree.generation)
    const active = { repositoryId: 'fixture' }
    const session = { getActiveService: () => current ? service : null, getActiveSession: () => current ? active : null } as unknown as RepositoryContinuumSession
    const projection = async (ref = 'refs/heads/executor', extra = {}) => {
      const branch = (await reader.inventory()).branches.find(b => b.ref === ref)!
      return readBranchExecutions({ getBranchInventory: () => reader.inventory() }, session, { ref, revision: branch.revision, ...extra })
    }
    return { reader, observe, plan, projection }
  }
  it('records one association under concurrent replay, survives HEAD advance/restart and never binds main by equal SHA', async () => {
    const { observe, plan, projection } = await setup()
    const receipts = await Promise.all(Array.from({ length: 4 }, () => service.bindExecutionBranch('execution-A', plan.artifactId, observe)))
    expect(new Set(receipts.map(r => r.artifactId)).size).toBe(1)
    expect(receipts.every(r => r.state === 'PERSISTED')).toBe(true)
    expect((await projection('refs/heads/main') as any).bindings).toEqual([])
    await gitExec(root, ['commit', '--allow-empty', '-m', 'advance'])
    expect((await service.bindExecutionBranch('execution-A', plan.artifactId, observe)).artifactId).toBe(receipts[0].artifactId)
    store.close(); store = new ArtifactStore(join(root, '.git', 'binding.db'), 'fixture'); service = new ContinuumService(store)
    const page = await projection() as any
    expect(page.bindings).toHaveLength(1); expect(page.bindings[0].classification).toBe('VERIFIED_CURRENT')
    const document = service.publish('---\nname: Validation\ndescription: Binding fixture\nkind: VALIDATION_PROOF\nexecutionId: execution-A\n---\nSecret body')
    const docs = await projection(undefined, { bindingId: receipts[0].artifactId, executionId: 'execution-A' }) as any
    expect(docs.artifacts.map((a: { artifactId: string }) => a.artifactId)).toContain(document.artifactId)
    expect(JSON.stringify(docs)).not.toContain('Secret body')
    expect(service.list({ metadata: { bindingRole: 'EXECUTION_BRANCH' } }).artifacts).toHaveLength(1)
    const other = service.publish('---\nname: Second execution\ndescription: Another execution\nkind: EXECUTABLE_PLAN\nexecutionId: execution-B\n---\nPlan B')
    await service.bindExecutionBranch('execution-B', other.artifactId, observe)
    expect((await projection() as any).bindings).toHaveLength(2)
    await gitExec(root, ['switch', 'main'])
    await service.bindExecutionBranch('execution-A', plan.artifactId, observe)
    expect((await projection('refs/heads/main') as any).bindings).toHaveLength(1)
  }, 120000)
  it('rejects source mismatch, contradictory source identity, detached, unknown generation and branch drift', async () => {
    const { observe, plan } = await setup()
    await expect(service.bindExecutionBranch('wrong', plan.artifactId, observe)).rejects.toThrow('EXECUTION_SOURCE_MISMATCH')
    const before = await observe()
    await expect(service.bindExecutionBranch('execution-A', plan.artifactId, async () => ({ ...before, branchGeneration: 'UNKNOWN' }))).rejects.toThrow('BRANCH_IDENTITY_UNAVAILABLE')
    let n = 0
    await expect(service.bindExecutionBranch('execution-A', plan.artifactId, async () => ++n === 1 ? before : { ...before, head: 'changed' })).rejects.toThrow('EXECUTION_BINDING_DRIFT')
    await service.bindExecutionBranch('execution-A', plan.artifactId, observe)
    const alternate = service.publish('---\nname: Other source\ndescription: Binding fixture\nkind: EXECUTABLE_PLAN\nexecutionId: execution-A\n---\nOther')
    await expect(service.bindExecutionBranch('execution-A', alternate.artifactId, observe)).rejects.toThrow('EXECUTION_BINDING_CONFLICT')
    let observations = 0
    await expect(service.bindExecutionBranch('execution-A', plan.artifactId, async () => {
      if (++observations === 2) await gitExec(root, ['switch', 'main'])
      return observe()
    })).rejects.toThrow('EXECUTION_BINDING_DRIFT')
    await gitExec(root, ['switch', 'executor'])
    await gitExec(root, ['switch', '--detach'])
    await expect(observe()).rejects.toThrow('WORKTREE_STALE')
  }, 120000)
  it('keeps recreated and renamed refs historical and permits a new association', async () => {
    const { observe, plan, projection } = await setup()
    const first = await service.bindExecutionBranch('execution-A', plan.artifactId, observe)
    await gitExec(root, ['switch', 'main']); await gitExec(root, ['branch', '-D', 'executor']); await gitExec(root, ['switch', '-c', 'executor'])
    expect((await projection() as any).bindings[0].classification).toBe('HISTORICAL')
    const second = await service.bindExecutionBranch('execution-A', plan.artifactId, observe)
    expect(second.artifactId).not.toBe(first.artifactId)
    expect((await projection() as any).bindings.map((b: { classification: string }) => b.classification).sort()).toEqual(['HISTORICAL', 'VERIFIED_CURRENT'])
    await gitExec(root, ['branch', '-m', 'renamed'])
    expect((await projection('refs/heads/renamed') as any).bindings).toEqual([])
    expect(service.get(first.artifactId)).not.toBeNull()
  }, 120000)
  it('preserves the branch association after checkout removal and isolates multiple executions', async () => {
    const { reader, plan, projection } = await setup()
    const linked = join(root, 'linked')
    await gitExec(root, ['switch', 'main']); await gitExec(root, ['worktree', 'add', linked, 'executor'])
    const tree = (await reader.inventory()).worktrees.find(t => t.branch === 'executor')!
    const receipt = await service.bindExecutionBranch('execution-A', plan.artifactId, () => reader.executionSnapshot(tree.worktreeId, tree.generation))
    await gitExec(root, ['worktree', 'remove', linked])
    const page = await projection() as any
    expect(page.bindings[0]).toMatchObject({ classification: 'VERIFIED_CURRENT', checkout: 'HISTORICAL' })
    expect(service.get(receipt.artifactId)).not.toBeNull()
    await gitExec(root, ['worktree', 'add', linked, 'executor'])
    await expect(reader.executionSnapshot(tree.worktreeId, tree.generation)).rejects.toThrow('WORKTREE_STALE')
    current = false
    await expect(service.bindExecutionBranch('execution-A', plan.artifactId, async () => { throw new Error('unexpected') })).rejects.toThrow('REPOSITORY_CONTEXT_CHANGED')
  }, 120000)
  it('does not certify manual declarations, enforces repository identity and immutable receipts', async () => {
    const { observe, plan, projection } = await setup()
    const snapshot = await observe()
    service.publish(`---\nname: Unverified\ndescription: Binding fixture\nkind: OBSERVATION\nbindingRole: EXECUTION_BRANCH\nrepositoryId: fixture\nexecutionId: execution-A\nbranchRef: refs/heads/executor\nbranchGeneration: ${snapshot.branchGeneration}\n---\nDeclared`)
    expect((await projection() as any).bindings[0].classification).toBe('DECLARED_UNVERIFIED')
    await expect(service.bindExecutionBranch('execution-A', plan.artifactId, async () => ({ ...snapshot, repositoryId: 'other' }))).rejects.toThrow('EXECUTION_SOURCE_MISMATCH')
    const receipt = await service.bindExecutionBranch('execution-A', plan.artifactId, observe)
    expect(() => service.update(receipt.artifactId, 1, service.get(receipt.artifactId)!.rawMarkdown)).toThrow('IMMUTABLE_EXECUTION_BINDING')
    await gitExec(root, ['config', 'core.logAllRefUpdates', 'false']); await gitExec(root, ['switch', 'main']); await gitExec(root, ['branch', '-D', 'executor']); await gitExec(root, ['switch', '-c', 'executor'])
    await expect(observe()).rejects.toThrow('BRANCH_GENERATION_UNKNOWN')
  }, 120000)
  it('fails before persistence on source or repository drift and bounds document membership pagination', async () => {
    const { observe, plan, projection } = await setup()
    const original = service.get(plan.artifactId)!.rawMarkdown
    let reads = 0
    await expect(service.bindExecutionBranch('execution-A', plan.artifactId, async () => {
      const snapshot = await observe()
      if (++reads === 2) service.update(plan.artifactId, 1, original.replace('execution-A', 'execution-changed'))
      return snapshot
    })).rejects.toThrow('EXECUTION_SOURCE_MISMATCH')
    expect(service.list({ metadata: { bindingRole: 'EXECUTION_BRANCH' } }).artifacts).toHaveLength(0)
    service.update(plan.artifactId, 2, original)
    const receipt = await service.bindExecutionBranch('execution-A', plan.artifactId, observe)
    for (let i = 0; i < 12; i++) service.publish(`---\nname: Document ${i}\ndescription: Pagination fixture\nkind: DOCUMENT\nexecutionId: execution-A\n---\nBody`)
    const first = await projection(undefined, { bindingId: receipt.artifactId, executionId: 'execution-A' }) as any
    expect(first.artifacts).toHaveLength(10); expect(first.nextCursor).toBeTruthy()
    const next = await projection(undefined, { bindingId: receipt.artifactId, executionId: 'execution-A', cursor: first.nextCursor }) as any
    expect(next.artifacts).toHaveLength(4)
    expect(new Set([...first.artifacts, ...next.artifacts].map((a: { artifactId: string }) => a.artifactId)).size).toBe(14)
    const snapshot = await observe()
    reads = 0
    await expect(service.bindExecutionBranch('execution-A', plan.artifactId, async () => { if (++reads === 2) current = false; return snapshot })).rejects.toThrow('REPOSITORY_CONTEXT_CHANGED')
  }, 120000)
})
