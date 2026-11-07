import { expect, it, vi } from 'vitest'
import { decideAcademyReconciliation, managedConflictPaths, mergeAcademyPackages } from './academy-git-reconciliation'
import { validateAcademyIdentities } from '../../../shared/academy-identity.cjs'
import { AcademyGitSyncService } from './academy-git-sync-service'
import * as snapshots from './academy-git-snapshot'

it('preserves unresolved convergence state after publishing an independent safe commit', async () => {
  const read = vi.spyOn(snapshots, 'readAcademyGitSnapshot').mockResolvedValue({ skills: [] } as any)
  try {
    const sync = Object.create(AcademyGitSyncService.prototype) as any
    const state = { localHead: 'local', migrationComplete: true, businessState: 'LOCAL_CHANGES', workspacePath: 'fixture', autoPublish: false }
    const profile = { branch: 'main', syncState: 'DIRTY' }
    const record = vi.fn()
    sync.exclusive = async (action: any) => action(state)
    sync.observe = async () => ({ sourceCommitSha: 'remote', observedAt: '2026-11-06T00:00:00Z' })
    let applications = 0
    sync.applyRemote = async () => { if (++applications === 2) { state.businessState = 'CONFLICT'; profile.syncState = 'REMOTE_DIVERGED' } }
    sync.prepareLocalCommit = async () => {}
    sync.identity = () => ({ profile, repositoryId: 'repo', remoteUrl: 'fixture://remote' })
    sync.save = () => {}
    sync.git = { getOperationsStatus: async () => false, isAncestor: async () => true }
    sync.transport = { push: async () => {} }
    sync.store = { getGitAuthority: () => ({}), getGitProfile: () => profile, updateGitSyncState: record }
    await sync.publish()
    expect(record).toHaveBeenCalledWith({ syncState: 'REMOTE_DIVERGED', lastPushedCommitSha: 'local' })
  } finally { read.mockRestore() }
})

it('merges disjoint package files and refuses concurrent replacement or delete/update of the same file', () => {
  const base = { skillMd: '---\nname: alpha\ndescription: Alpha\n---\n', artifacts: { 'references/a.md': 'base-a', 'references/b.md': 'base-b' } }
  const local = { ...base, artifacts: { ...base.artifacts, 'references/a.md': 'local-a' } }
  const remote = { ...base, artifacts: { ...base.artifacts, 'references/b.md': 'remote-b' } }
  expect(mergeAcademyPackages(base, local, remote)?.artifacts).toEqual({ 'references/a.md': 'local-a', 'references/b.md': 'remote-b' })
  expect(mergeAcademyPackages(base, local, { ...remote, artifacts: { ...remote.artifacts, 'references/a.md': 'other-a' } })).toBeNull()
  expect(mergeAcademyPackages(base, local, { ...base, artifacts: { 'references/b.md': 'base-b' } })).toBeNull()
})

it('requires stable unique identities and explicit tombstones in the same tree', () => {
  const alpha = { skillId: 'stable-a', path: 'skills/alpha', state: 'PRESENT' }
  const before = validateAcademyIdentities({ schema: 2, skills: [alpha] }, ['skills/alpha'])
  expect(() => validateAcademyIdentities({ schema: 2, skills: [alpha, { ...alpha, path: 'skills/beta' }] }, ['skills/alpha', 'skills/beta'])).toThrow('ACADEMY_IDENTITY_COLLISION')
  expect(() => validateAcademyIdentities({ schema: 2, skills: [{ ...alpha, path: 'skills/beta' }] }, ['skills/alpha'])).toThrow('ACADEMY_IDENTITY_TREE_MISMATCH')
  expect(() => validateAcademyIdentities({ schema: 2, skills: [] }, [], before)).toThrow('ACADEMY_TOMBSTONE_REQUIRED')
  expect(validateAcademyIdentities({ schema: 2, skills: [{ ...alpha, state: 'REMOVED', baseHash: 'a'.repeat(64), revision: 2 }] }, [], before).skills[0].skillId).toBe('stable-a')
})

it.each([
  ['baseline', 'canonical', 'canonical', true, 'CONVERGED'],
  ['baseline', 'baseline', 'new canonical', true, 'PUBLISH'],
  ['canonical', 'canonical', 'canonical', true, 'CONVERGED'],
  ['baseline', 'external', 'canonical', true, 'CONFLICT'],
  [null, 'external', 'canonical', true, 'CONFLICT'],
  [null, '', 'canonical', false, 'PUBLISH'],
  ['baseline', '', 'canonical', false, 'CONFLICT']
])('classifies content without requiring matching HEAD identities', (baseline, remote, canonical, exists, decision) => {
  expect(decideAcademyReconciliation(baseline as string | null, remote as string, canonical as string, exists as boolean)).toBe(decision)
})

it('projects only changed, added and removed managed paths, including file modes', () => {
  expect(managedConflictPaths('100644 blob a\tskills/alpha/SKILL.md\0' + '100644 blob b\tplugin.json\0', '100755 blob a\tskills/alpha/SKILL.md\0' + '100644 blob c\tassets/logo.png\0')).toEqual(['assets/logo.png', 'plugin.json', 'skills/alpha/SKILL.md'])
})
