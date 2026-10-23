import { expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import * as fileSystem from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { GitService } from '../core/git-service'
import { GitOperationsService } from '../git-operations/git-operations-service'
import { GitHubGitTransport } from '../github/github-git-transport'
import { createTempGitRepo, cleanupTempRepo, gitExec, stageAll, commit } from '../core/git-test-helpers'
import { PreviewPreflightService } from './preview-preflight'
import { PreviewProfileStore } from './preview-profile-store'
import { bytesFingerprint, previewFingerprint, type PreviewProfile } from './preview-profile'
import { PreviewRepositories } from './preview-repositories'
import { RepositoryCatalogService } from '../repository-catalog/repository-catalog-service'
import { BranchOrchestrationController } from '../ipc/branch-orchestration-handler'
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

it('uses registry identity and dirty snapshot of a real isolated worktree; preserves main and refuses another repository', async () => {
  const root = await createTempGitRepo(), parent = await mkdtemp(join(tmpdir(), 'preview-real-'))
  try {
    await writeFile(join(root, 'package.json'), '{}'); await stageAll(root); await commit(root, 'baseline')
    const tree = join(parent, 'selected'), directory = join(parent, 'profiles')
    await gitExec(root, ['worktree', 'add', '-b', 'feature', tree]); await mkdir(directory)
    await writeFile(join(tree, 'package.json'), '{"dirty":true}')
    const profile: PreviewProfile = { schemaVersion: 1, profileId: 'legacy', revision: 1, repositoryId: 'repo', runtime: 'WEB_DEV_SERVER', runtimeVersion: '22',
      command: { executable: process.execPath, executableHash: bytesFingerprint(await readFile(process.execPath)), args: ['server.js'], cwd: '.', inputs: [{ path: 'package.json', fingerprint: bytesFingerprint('{"dirty":true}') }] }, env: {}, resources: [{ name: 'http', strategy: 'SESSION_ENDPOINT' }],
      dependencies: { packageManager: 'npm', packageManagerVersion: '10.9.4', manifest: 'package.json', lockfile: 'package-lock.json', manifestHash: 'a'.repeat(64), lockfileHash: 'a'.repeat(64), abi: '127', materialization: 'installed.json' },
      cooperation: { manifest: 'preview.json', fingerprint: 'a'.repeat(64) }, security: { mode: 'profile_only', requirements: [{ capability: 'FILESYSTEM_WRITE_SEPARATION', guarantee: 'protect main' }] },
      network: { destinations: ['http://127.0.0.1'], openNetworkConsent: false, credentials: 'TARGET_OWN_TEST_PROFILE' },
      probes: { readiness: { kind: 'HTTP', address: 'http://127.0.0.1/ready', timeoutMs: 1000 }, liveness: 'READINESS', attestation: 'NONE' },
      shutdown: { spawn: 'JOB_LIST_AT_CREATE', breakaway: false, killOnJobClose: true, graceMs: 100, forceMs: 1000 } }
    await writeFile(join(directory, 'profiles.json'), JSON.stringify([profile]))
    const store = new PreviewProfileStore(directory), preflight = new PreviewPreflightService(store)
    await store.approve(profile, async () => true)
    const git = new GitService(), operations = new GitOperationsService(root, git, new GitHubGitTransport(null, git), { repositoryId: 'repo', isActive: () => true })
    const inventory = await operations.getBranchInventory(), selected = inventory.worktrees.find(w => w.branch === 'feature')!
    const before = { head: await git.getCurrentCommitHash(root), refs: await gitExec(root, ['show-ref']), index: bytesFingerprint(await readFile(join(root, '.git/index'))), content: await readFile(join(root, 'package.json'), 'utf8') }
    const selection = { repositoryId: 'repo', worktreeId: selected.worktreeId, generation: selected.generation, profileId: 'legacy', fingerprint: previewFingerprint(profile) }
    const result = await preflight.check(operations, selection)
    expect(result.snapshot).toMatchObject({ branch: 'feature', dirty: true })
    expect(result.diagnostics.map(d => d.reasonCode)).toEqual(expect.arrayContaining(['SECURITY_ISOLATION_UNAVAILABLE', 'COOPERATION_UNAVAILABLE', 'DEPENDENCIES_MISSING']))
    expect({ head: await git.getCurrentCommitHash(root), refs: await gitExec(root, ['show-ref']), index: bytesFingerprint(await readFile(join(root, '.git/index'))), content: await readFile(join(root, 'package.json'), 'utf8') }).toEqual(before)
    const other = new GitOperationsService(root, git, new GitHubGitTransport(null, git), { repositoryId: 'another-repo', isActive: () => true })
    const otherInventory = await other.getBranchInventory()
    await expect(preflight.check(other, { ...selection, worktreeId: otherInventory.worktrees.find(w => w.branch === 'feature')!.worktreeId })).rejects.toThrow('REPOSITORY_MISMATCH')
  } finally { await cleanupTempRepo(root); await rm(parent, { recursive: true, force: true }) }
}, 60000)

it('preflights repository B through the controller while repository A remains active; rejects mixed identities and catalog drift', async () => {
  const activeRoot = await createTempGitRepo(), otherRoot = await createTempGitRepo(), parent = await mkdtemp(join(tmpdir(), 'preview-catalog-'))
  try {
    for (const root of [activeRoot, otherRoot]) { await writeFile(join(root, 'base.txt'), 'baseline'); await stageAll(root); await commit(root, 'baseline') }
    const tree = join(parent, 'other-tree'), directory = join(parent, 'profiles')
    await gitExec(otherRoot, ['worktree', 'add', '-b', 'feature-b', tree]); await mkdir(directory)
    const manifest = '{"name":"other","workspaces":["packages/*"],"optionalDependencies":{"optional":"1.0.0"}}'
    const lock = '{"lockfileVersion":3,"packages":{"":{},"packages/local":{"version":"1.0.0"},"node_modules/local":{"link":true,"resolved":"packages/local"},"node_modules/optional":{"version":"1.0.0","optional":true}}}'
    await writeFile(join(tree, 'package.json'), manifest); await writeFile(join(tree, 'package-lock.json'), lock); await writeFile(join(tree, 'preview.json'), '{}')
    await mkdir(join(tree, 'packages/local'), { recursive: true }); await mkdir(join(tree, 'node_modules'))
    await writeFile(join(tree, 'packages/local/package.json'), '{"name":"local","version":"1.0.0"}')
    await fileSystem.symlink(join(tree, 'packages/local'), join(tree, 'node_modules/local'), 'junction')
    const profile: PreviewProfile = { schemaVersion: 1, profileId: 'other', revision: 1, repositoryId: 'b', runtime: 'WEB_DEV_SERVER', runtimeVersion: '22',
      command: { executable: process.execPath, executableHash: bytesFingerprint(await readFile(process.execPath)), args: ['server.js'], cwd: '.', inputs: [{ path: 'package.json', fingerprint: bytesFingerprint(manifest) }] }, env: {}, resources: [{ name: 'http', strategy: 'SESSION_ENDPOINT' }],
      dependencies: { packageManager: 'npm', packageManagerVersion: '10.9.4', manifest: 'package.json', lockfile: 'package-lock.json', manifestHash: bytesFingerprint(manifest), lockfileHash: bytesFingerprint(lock), abi: '127', materialization: 'installed.json' },
      cooperation: { manifest: 'preview.json', fingerprint: bytesFingerprint('{}') }, security: { mode: 'profile_only', requirements: [] },
      network: { destinations: ['http://127.0.0.1'], openNetworkConsent: false, credentials: 'TARGET_OWN_TEST_PROFILE' },
      probes: { readiness: { kind: 'HTTP', address: 'http://127.0.0.1/ready', timeoutMs: 1000 }, liveness: 'READINESS', attestation: 'NONE' },
      shutdown: { spawn: 'JOB_LIST_AT_CREATE', breakaway: false, killOnJobClose: true, graceMs: 100, forceMs: 1000 } }
    await writeFile(join(tree, 'installed.json'), JSON.stringify({ lockfileHash: profile.dependencies.lockfileHash, runtimeVersion: '22', abi: '127', packageManagerVersion: '10.9.4' }))
    await writeFile(join(directory, 'profiles.json'), JSON.stringify([profile]))
    const store = new PreviewProfileStore(directory); await store.approve(profile, async () => true)
    const record = { id: 'b', name: 'B', status: 'ACTIVE', updatedAt: 'initial', localCheckout: { path: otherRoot, gitState: 'GIT', availability: 'AVAILABLE' } }
    const discovery = { inspectLocalProject: vi.fn() }
    const catalog = new RepositoryCatalogService({ get: (id: string) => { if (id !== 'b') throw new Error('REPOSITORY_NOT_FOUND'); return record } } as any, discovery as any)
    const git = new GitService(), createGit = vi.fn((path: string, identity: import('../git-operations/git-worktree-registry').WorktreeIdentity) => new GitOperationsService(path, git, new GitHubGitTransport(null, git), identity, true))
    const repositories = new PreviewRepositories(catalog, createGit)
    const activeGit = new GitOperationsService(activeRoot, git, new GitHubGitTransport(null, git), { repositoryId: 'a', isActive: () => true }, true)
    const activeId = (await activeGit.discoverWorktrees()).worktrees[0].worktreeId
    const activeReads = vi.spyOn(activeGit, 'getBranchInventory')
    const state = Object.freeze({ project: Object.freeze({ id: 'active-a', path: activeRoot }), revision: 1 })
    const projects = { getState: () => state } as any
    const controller = new BranchOrchestrationController(projects, async () => false, undefined, store, async () => { record.updatedAt = 'changed'; return true }, repositories)
    controller.bind(activeGit, {} as any, activeRoot)
    const context = { projectId: 'active-a', revision: 1 }, before = { head: await git.getCurrentCommitHash(activeRoot), index: bytesFingerprint(await readFile(join(activeRoot, '.git/index'))), refs: await gitExec(activeRoot, ['show-ref']) }
    const list = await controller.request({ context, operation: { action: 'PREVIEW_WORKTREES', repositoryId: 'b' } })
    if (!list.success || list.data.kind !== 'PREVIEW_WORKTREES') throw new Error(JSON.stringify(list))
    const selected = list.data.worktrees.find(w => w.branch === 'feature-b')!
    const selection = { repositoryId: 'b', worktreeId: selected.worktreeId, generation: selected.generation, profileId: 'other', fingerprint: previewFingerprint(profile) }
    const result = await controller.request({ context, operation: { action: 'PREVIEW_PREFLIGHT', selection } })
    expect(result).toMatchObject({ success: true, context, data: { kind: 'PREVIEW_PREFLIGHT', preflight: { status: 'UNKNOWN', snapshot: { branch: 'feature-b', dirty: true } } } })
    expect(projects.getState()).toBe(state); expect(activeReads).not.toHaveBeenCalled(); expect(discovery.inspectLocalProject).not.toHaveBeenCalled()
    expect({ head: await git.getCurrentCommitHash(activeRoot), index: bytesFingerprint(await readFile(join(activeRoot, '.git/index'))), refs: await gitExec(activeRoot, ['show-ref']) }).toEqual(before)
    for (const [patch, code] of [[{ repositoryId: 'unknown' }, 'REPOSITORY_NOT_FOUND'], [{ worktreeId: activeId }, 'WORKTREE_STALE'], [{ generation: 'wrong' }, 'WORKTREE_IDENTITY_MISMATCH'], [{ fingerprint: 'wrong' }, 'PROFILE_CHANGED']] as const) {
      expect(await controller.request({ context, operation: { action: 'PREVIEW_PREFLIGHT', selection: { ...selection, ...patch } } })).toEqual({ success: false, code })
    }
    profile.revision++; await writeFile(join(directory, 'profiles.json'), JSON.stringify([profile]))
    expect(await controller.request({ context, operation: { action: 'PREVIEW_APPROVE', selection: { ...selection, fingerprint: previewFingerprint(profile) } } })).toEqual({ success: false, code: 'REPOSITORY_CONTEXT_CHANGED' })
    expect(await store.approved(profile)).toBe(false)
  } finally { await cleanupTempRepo(activeRoot); await cleanupTempRepo(otherRoot); await rm(parent, { recursive: true, force: true }) }
}, 60000)
