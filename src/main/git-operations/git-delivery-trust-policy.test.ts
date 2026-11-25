import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsService } from '../core/settings-service'
import { cleanupTempRepo, commit, createTempGitRepo, gitExec, stageAll } from '../core/git-test-helpers'
import { GitDeliveryTrustPolicy, type GitDeliveryLocalContext } from './git-delivery-trust-policy'

const local = vi.hoisted(() => ({ profile: '' }))
vi.mock('electron', () => ({ app: { getPath: () => local.profile } }))

const roots: string[] = []
const userDataRoots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await cleanupTempRepo(root)
  for (const dir of userDataRoots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('GitDeliveryTrustPolicy', () => {
  it('defaults to AUTONOMOUS when gitDeliveryAutonomy is absent, stays independent of CLI autonomy, revokes to SUPERVISED, and restores without popup', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'git-delivery-policy-'))
    userDataRoots.push(userData)
    local.profile = userData

    const repo = await createTempGitRepo()
    roots.push(repo)
    writeFileSync(join(repo, 'a.txt'), 'v1\n')
    await stageAll(repo)
    await commit(repo, 'init')
    const wt = join(mkdtempSync(join(tmpdir(), 'git-delivery-wt-')), 'wt')
    userDataRoots.push(join(wt, '..'))
    await gitExec(repo, ['worktree', 'add', '-b', 'feat/wt', wt])

    const settings = new SettingsService()
    let context: GitDeliveryLocalContext | null = { repositoryId: 'repo-1', path: repo, revision: 1 }
    const policy = new GitDeliveryTrustPolicy(settings, () => context)

    // Default without any gitDeliveryAutonomy grant or CLI autonomy
    expect(settings.loadSettings().gitDeliveryAutonomy).toBeUndefined()
    expect(settings.loadSettings().cliExecutionEnabled).toBe(false)
    expect(settings.loadSettings().cliAutonomy).toBeUndefined()
    expect(policy.getPolicy({ repositoryId: 'repo-1', path: repo })).toMatchObject({
      mode: 'AUTONOMOUS',
      revision: 'default',
      rule: 'local-repository-git-delivery-default',
      allowedRemotes: ['origin']
    })
    expect(policy.getPolicy({ repositoryId: 'repo-1', path: wt }).mode).toBe('AUTONOMOUS')
    expect(policy.getPolicy({ repositoryId: 'repo-other', path: repo }).mode).toBe('SUPERVISED')

    // saveSettings cannot forge gitDeliveryAutonomy
    settings.saveSettings({
      ...settings.loadSettings(),
      gitDeliveryAutonomy: { 'repo-other': { mode: 'AUTONOMOUS', commonIdentity: 'forged', revision: 'forged' } }
    })
    expect(settings.loadSettings().gitDeliveryAutonomy).toBeUndefined()

    // Explicit revocation to SUPERVISED
    expect(await policy.choose('SUPERVISED')).toBe(true)
    expect(policy.getPolicy({ repositoryId: 'repo-1', path: repo }).mode).toBe('SUPERVISED')
    expect(policy.getPolicy({ repositoryId: 'repo-1', path: wt }).mode).toBe('SUPERVISED')

    // Restoring AUTONOMOUS works without confirmation callback
    expect(await policy.choose('AUTONOMOUS')).toBe(true)
    expect(policy.getPolicy({ repositoryId: 'repo-1', path: repo }).mode).toBe('AUTONOMOUS')

    // Missing context fails closed
    context = null
    expect(policy.getPolicy().mode).toBe('SUPERVISED')
  })

  it('fails closed when persisted grant has divergent commonIdentity or invalid mode', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'git-delivery-policy-invalid-'))
    userDataRoots.push(userData)
    local.profile = userData

    const repo = await createTempGitRepo()
    roots.push(repo)
    writeFileSync(join(repo, 'a.txt'), 'v1\n')
    await stageAll(repo)
    await commit(repo, 'init')

    const settings = new SettingsService()
    settings.setLocalGitDeliveryTrust('repo-1', {
      mode: 'AUTONOMOUS',
      commonIdentity: 'divergent-identity',
      revision: 'rev-1'
    })
    const policy = new GitDeliveryTrustPolicy(
      settings,
      () => ({ repositoryId: 'repo-1', path: repo, revision: 1 })
    )

    expect(policy.getPolicy({ repositoryId: 'repo-1', path: repo })).toMatchObject({
      mode: 'SUPERVISED',
      revision: 'invalid:rev-1'
    })
  })
})
