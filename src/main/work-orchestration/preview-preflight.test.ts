import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PreviewPreflightService, previewPath } from './preview-preflight'
import { PreviewProfileStore } from './preview-profile-store'
import { previewProfileSchema, previewFingerprint, bytesFingerprint, type PreviewProfile } from './preview-profile'
import * as fileSystem from 'node:fs/promises'
import { PreviewNpmDependencies } from './preview-npm-dependencies'

let root: string, tree: string, directory: string, store: PreviewProfileStore, profile: PreviewProfile
const hash = bytesFingerprint
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'preview-u1-')); tree = join(root, 'tree'); directory = join(root, 'profiles')
  await mkdir(tree); await mkdir(directory)
  const manifest = '{}', lock = JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/example': { version: '1.0.0' } } })
  profile = { schemaVersion: 1, profileId: 'web', revision: 1, repositoryId: 'repo', runtime: 'WEB_DEV_SERVER', runtimeVersion: '22',
    command: { executable: process.execPath, executableHash: hash(await readFile(process.execPath)), args: ['server.js'], cwd: '.', inputs: [{ path: 'package.json', fingerprint: hash(manifest) }] }, env: {}, resources: [{ name: 'http', strategy: 'SESSION_ENDPOINT' }],
    dependencies: { packageManager: 'npm', packageManagerVersion: '10.9.4', manifest: 'package.json', lockfile: 'package-lock.json', manifestHash: hash(manifest), lockfileHash: hash(lock), abi: '127', materialization: 'installed.json' },
    cooperation: { manifest: 'preview.json', fingerprint: hash('{}') }, security: { mode: 'profile_only', requirements: [] },
    network: { destinations: ['http://127.0.0.1:5173'], openNetworkConsent: false, credentials: 'TARGET_OWN_TEST_PROFILE' },
    probes: { readiness: { kind: 'HTTP', address: 'http://127.0.0.1:5173/ready', timeoutMs: 1000 }, liveness: 'READINESS', attestation: 'NONE' },
    shutdown: { spawn: 'JOB_LIST_AT_CREATE', breakaway: false, killOnJobClose: true, graceMs: 100, forceMs: 1000 } }
  await writeFile(join(tree, 'package.json'), manifest); await writeFile(join(tree, 'package-lock.json'), lock); await writeFile(join(tree, 'preview.json'), '{}')
  await mkdir(join(tree, 'node_modules/example'), { recursive: true }); await writeFile(join(tree, 'node_modules/example/package.json'), '{"version":"1.0.0"}')
  await writeFile(join(tree, 'installed.json'), JSON.stringify({ lockfileHash: hash(lock), runtimeVersion: '22', abi: '127', packageManagerVersion: '10.9.4' }))
  store = new PreviewProfileStore(directory); await save()
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
async function save() { await writeFile(join(directory, 'profiles.json'), JSON.stringify([profile])) }
const selection = () => ({ repositoryId: 'repo', worktreeId: 'tree', generation: 'generation', profileId: profile.profileId, fingerprint: previewFingerprint(profile) })
function reader() {
  const record = { path: tree, generation: 'generation', locked: false, detached: false }
  return { getCoordinationIdentity: vi.fn(async () => ({ repositoryId: 'repo', record })), getCoordinationSnapshot: vi.fn(async () => ({ record,
    snapshot: { head: 'sha', branch: 'feature', operation: null, indexRevision: 'index', worktreeRevision: 'dirty' }, stagedCount: 1, unstagedCount: 1, untrackedCount: 1, conflictCount: 0, reference: false })) } as any
}
it('checks a selected dirty worktree without setup, execution or false readiness', async () => {
  await store.approve(profile, async () => true)
  const before = await readFile(join(tree, 'package-lock.json'), 'utf8'), git = reader()
  const result = await new PreviewPreflightService(store).check(git, selection())
  expect(result).toMatchObject({ status: 'UNKNOWN', readiness: 'NOT_OBSERVED', process: 'NOT_IMPLEMENTED', snapshot: { dirty: true } })
  expect(result.diagnostics.map(d => d.reasonCode)).toEqual(['RUNTIME_COMPATIBILITY_UNVERIFIED'])
  expect(git.getCoordinationSnapshot).toHaveBeenCalledTimes(2)
  expect(await readFile(join(tree, 'package-lock.json'), 'utf8')).toBe(before)
})
it('blocks network and filesystem requirements with typed enforcement gaps and independent resolution', async () => {
  profile.security.requirements = [{ capability: 'NETWORK_EGRESS_RESTRICTION', guarantee: 'loopback only enforced' }, { capability: 'FILESYSTEM_WRITE_SEPARATION', guarantee: 'no writes outside checkout' }]
  await save(); await store.approve(profile, async () => true)
  const result = await new PreviewPreflightService(store).check(reader(), selection())
  expect(result.status).toBe('INCOMPATIBLE')
  const diagnostic = result.diagnostics.find(d => d.reasonCode === 'SECURITY_ISOLATION_UNAVAILABLE')!
  expect(diagnostic.missingRequirements).toHaveLength(2)
  expect(diagnostic.missingRequirements![0]).toMatchObject({ capability: 'NETWORK_EGRESS_RESTRICTION', availableMechanism: { kind: 'NONE' }, resolutions: [{ requiresIndependentApproval: true }] })
  expect(profile.security.requirements).toHaveLength(2)
})
it('invalidates grants on policy revision but not everyday source edits', async () => {
  await store.approve(profile, async () => true)
  await writeFile(join(tree, 'feature.ts'), 'updated source')
  expect(await store.approved(profile)).toBe(true)
  profile.revision++; await save()
  expect(await store.approved(profile)).toBe(false)
  const result = await new PreviewPreflightService(store).check(reader(), selection())
  expect(result.diagnostics.some(d => d.reasonCode === 'PROFILE_APPROVAL_REQUIRED')).toBe(true)
})
it('rejects stale profile, repository and generation before compatibility reads', async () => {
  const service = new PreviewPreflightService(store)
  await expect(service.check(reader(), { ...selection(), fingerprint: 'stale' })).rejects.toThrow('PROFILE_CHANGED')
  const git = reader(); git.getCoordinationIdentity.mockResolvedValue({ repositoryId: 'other', record: { generation: 'generation' } })
  await expect(service.check(git, selection())).rejects.toThrow('REPOSITORY_MISMATCH')
  await expect(service.check(reader(), { ...selection(), generation: 'old' })).rejects.toThrow('WORKTREE_STALE')
})
it('detects lockfile and installed version mismatch, not merely the lock hash', async () => {
  await store.approve(profile, async () => true)
  await writeFile(join(tree, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}')
  expect((await new PreviewPreflightService(store).check(reader(), selection())).diagnostics.some(d => d.reasonCode === 'DEPENDENCY_INPUT_CHANGED')).toBe(true)
  await writeFile(join(tree, 'node_modules/example/package.json'), '{"version":"2.0.0"}')
  await writeFile(join(tree, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/example': { version: '1.0.0' } } }))
  expect((await new PreviewPreflightService(store).check(reader(), selection())).diagnostics.some(d => d.message === 'DEPENDENCY_VERSION_MISMATCH')).toBe(true)
})
it('legacy checkout is incompatible and remains unpatched', async () => {
  await rm(join(tree, 'preview.json'))
  const result = await new PreviewPreflightService(store).check(reader(), selection())
  expect(result.diagnostics.some(d => d.reasonCode === 'COOPERATION_UNAVAILABLE')).toBe(true)
  await expect(readFile(join(tree, 'preview.json'))).rejects.toThrow()
})
it('rejects escape paths and linked dependency directories physically', async () => {
  await expect(previewPath(tree, '../profiles/profiles.json')).rejects.toThrow('PATH_OUTSIDE_WORKTREE')
  await symlink(directory, join(tree, 'linked'), 'junction')
  await expect(previewPath(tree, 'linked/profiles.json')).rejects.toThrow('PATH_OUTSIDE_WORKTREE')
  await expect(new PreviewProfileStore(tree).assertExternal(tree)).rejects.toThrow('PROFILE_STORE_INSIDE_WORKTREE')
})
it('revalidates drift and refuses approval of a changed profile', async () => {
  const git = reader(); const first = await git.getCoordinationSnapshot()
  git.getCoordinationSnapshot.mockResolvedValueOnce(first).mockResolvedValueOnce({ ...first, snapshot: { ...first.snapshot, head: 'changed' } })
  await expect(new PreviewPreflightService(store).check(git, selection())).rejects.toThrow('GIT_STATE_CHANGED')
  await expect(store.approve(profile, async () => { profile.revision++; await save(); return true })).rejects.toThrow('PROFILE_CHANGED')
})
it('rejects free shell/cwd fields, unsafe shutdown and missing readiness', () => {
  for (const change of [{ command: { ...profile.command, shell: true } }, { command: { ...profile.command, cwd: '../main' } }, { shutdown: { ...profile.shutdown, breakaway: true } }, { probes: { ...profile.probes, readiness: undefined } }]) expect(previewProfileSchema.safeParse({ ...profile, ...change }).success).toBe(false)
})
it('never persists approval after project context is revoked', async () => {
  await expect(store.approve(profile, async () => true, () => { throw new Error('PROJECT_CONTEXT_CHANGED') })).rejects.toThrow('PROJECT_CONTEXT_CHANGED')
  expect(await store.approved(profile)).toBe(false)
})
it('allows an absent optional dependency but refuses absent required packages, including contradictory optional flags', async () => {
  const inspector = new PreviewNpmDependencies()
  const manifest = Buffer.from('{"optionalDependencies":{"optional":"1.0.0"}}')
  const optional = Buffer.from('{"lockfileVersion":3,"packages":{"":{},"node_modules/optional":{"version":"1.0.0","optional":true}}}')
  expect((await inspector.inspect(tree, profile, 'g', manifest, optional)).diagnostics).toEqual([])
  const required = Buffer.from('{"lockfileVersion":3,"packages":{"":{},"node_modules/required":{"version":"1.0.0","optional":true}}}')
  expect((await inspector.inspect(tree, profile, 'g', Buffer.from('{"dependencies":{"required":"1.0.0"}}'), required)).diagnostics).toMatchObject([{ reasonCode: 'DEPENDENCIES_MISSING', status: 'MISSING' }])
})
it('accepts an npm workspace linked inside this worktree and rejects undeclared, external and incompatible links', async () => {
  const inspector = new PreviewNpmDependencies(), manifest = Buffer.from('{"workspaces":["packages/*"]}')
  const lock = Buffer.from('{"lockfileVersion":3,"packages":{"":{},"packages/local":{"version":"1.0.0"},"node_modules/local":{"link":true,"resolved":"packages/local"}}}')
  await mkdir(join(tree, 'packages/local'), { recursive: true })
  await writeFile(join(tree, 'packages/local/package.json'), '{"name":"local","version":"1.0.0"}')
  await symlink(join(tree, 'packages/local'), join(tree, 'node_modules/local'), 'junction')
  expect((await inspector.inspect(tree, profile, 'g', manifest, lock)).diagnostics).toEqual([])
  expect((await inspector.inspect(tree, profile, 'g', Buffer.from('{"workspaces":["./packages/**/local"]}'), lock)).diagnostics).toEqual([])
  expect((await inspector.inspect(tree, profile, 'g', Buffer.from('{"workspaces":["packages/{local,other}"]}'), lock)).diagnostics).toMatchObject([{ reasonCode: 'DEPENDENCY_WORKSPACE_UNVERIFIABLE', status: 'UNKNOWN' }])
  await expect(inspector.inspect(tree, profile, 'g', Buffer.from('{}'), lock)).rejects.toThrow('DEPENDENCY_LINK_UNSUPPORTED')
  await writeFile(join(tree, 'packages/local/package.json'), '{"name":"local","version":"2.0.0"}')
  expect((await inspector.inspect(tree, profile, 'g', manifest, lock)).diagnostics).toMatchObject([{ reasonCode: 'DEPENDENCY_MISMATCH' }])
  await rm(join(tree, 'node_modules/local')); await symlink(directory, join(tree, 'node_modules/local'), 'junction')
  await expect(inspector.inspect(tree, profile, 'g', manifest, lock)).rejects.toThrow('PATH_OUTSIDE_WORKTREE')
})
it('never mistakes a broken optional link or corrupt optional install for a legitimately absent dependency', async () => {
  const inspector = new PreviewNpmDependencies(), manifest = Buffer.from('{}')
  const lock = Buffer.from('{"lockfileVersion":3,"packages":{"":{},"node_modules/optional":{"version":"1.0.0","optional":true}}}')
  const external = Buffer.from('{"lockfileVersion":3,"packages":{"":{},"node_modules/optional":{"link":true,"resolved":"../external","optional":true}}}')
  await expect(inspector.inspect(tree, profile, 'g', manifest, external)).rejects.toThrow('DEPENDENCY_LINK_UNSUPPORTED')
  await mkdir(join(tree, 'node_modules/optional'))
  expect((await inspector.inspect(tree, profile, 'g', manifest, lock)).diagnostics).toMatchObject([{ reasonCode: 'DEPENDENCY_MISMATCH' }])
  await rm(join(tree, 'node_modules/optional'), { recursive: true })
  const target = join(tree, 'optional-target'); await mkdir(target)
  await symlink(target, join(tree, 'node_modules/optional'), 'junction'); await rm(target, { recursive: true })
  await expect(inspector.inspect(tree, profile, 'g', manifest, lock)).rejects.toThrow('DEPENDENCY_LINK_BROKEN')
})
it('reuses installed manifest reads and lock analysis while rechecking paths and metadata; invalidates lock, installation, runtime and ABI changes', async () => {
  const read = vi.fn(fileSystem.readFile), files = { ...fileSystem, readFile: read as typeof fileSystem.readFile }
  const inspector = new PreviewNpmDependencies(files), manifest = Buffer.from('{}'), lock = await readFile(join(tree, 'package-lock.json'))
  const parse = vi.spyOn(JSON, 'parse')
  const first = await inspector.inspect(tree, profile, 'g', manifest, lock)
  expect(read).toHaveBeenCalledTimes(1)
  expect((await inspector.inspect(tree, profile, 'g', manifest, lock)).basis).toBe(first.basis)
  expect(read).toHaveBeenCalledTimes(1)
  expect(parse.mock.calls.filter(([text]) => text === lock.toString())).toHaveLength(1)
  parse.mockRestore()
  await writeFile(join(tree, 'node_modules/example/package.json'), '{"version":"2.0.0"}')
  const changed = await inspector.inspect(tree, profile, 'g', manifest, lock)
  expect(changed.basis).not.toBe(first.basis)
  expect(changed.diagnostics).toMatchObject([{ reasonCode: 'DEPENDENCY_MISMATCH' }])
  expect(read).toHaveBeenCalledTimes(2)
  await inspector.inspect(tree, profile, 'g', manifest, Buffer.concat([lock, Buffer.from(' ')]))
  expect(read).toHaveBeenCalledTimes(3)
  await inspector.inspect(tree, { ...profile, runtimeVersion: 'different' }, 'g', manifest, lock)
  expect(read).toHaveBeenCalledTimes(4)
  await inspector.inspect(tree, { ...profile, dependencies: { ...profile.dependencies, abi: 'different' } }, 'g', manifest, lock)
  expect(read).toHaveBeenCalledTimes(5)
})
it('does not cache positive runtime compatibility when uninspected package bytes change', async () => {
  await store.approve(profile, async () => true)
  const service = new PreviewPreflightService(store)
  expect((await service.check(reader(), selection())).status).toBe('UNKNOWN')
  await writeFile(join(tree, 'node_modules/example/index.js'), 'changed code')
  const second = await service.check(reader(), selection())
  expect(second.status).toBe('UNKNOWN')
  expect(second.diagnostics.some(d => d.reasonCode === 'RUNTIME_COMPATIBILITY_UNVERIFIED')).toBe(true)
})
it('returns UNKNOWN for missing materialization evidence instead of declaring installed dependencies absent', async () => {
  await store.approve(profile, async () => true)
  await rm(join(tree, 'installed.json'))
  const result = await new PreviewPreflightService(store).check(reader(), selection())
  expect(result.status).toBe('UNKNOWN')
  expect(result.diagnostics.map(d => d.reasonCode)).toEqual(['DEPENDENCY_MATERIALIZATION_UNVERIFIABLE'])
})
