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
  it('defaults to SUPERVISED, persists AUTONOMOUS bound to commonIdentity, stays independent of CLI autonomy, and revokes immediately', async () => {
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
    const confirm = vi.fn(async () => true)
    const policy = new GitDeliveryTrustPolicy(settings, () => context, confirm)

    expect(policy.getPolicy()).toMatchObject({ mode: 'SUPERVISED', allowedRemotes: [] })
    expect(settings.loadSettings().cliExecutionEnabled).toBe(false)
    expect(settings.loadSettings().cliAutonomy).toBeUndefined()

    expect(await policy.choose('AUTONOMOUS')).toBe(true)
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(policy.getPolicy({ repositoryId: 'repo-1', path: repo })).toMatchObject({
      mode: 'AUTONOMOUS',
      allowedRemotes: ['origin']
    })
    expect(policy.getPolicy({ repositoryId: 'repo-1', path: wt }).mode).toBe('AUTONOMOUS')
    expect(policy.getPolicy({ repositoryId: 'repo-other', path: repo }).mode).toBe('SUPERVISED')
    expect(settings.loadSettings().cliAutonomy).toBeUndefined()

    const saved = settings.loadSettings().gitDeliveryAutonomy
    settings.saveSettings({
      ...settings.loadSettings(),
      gitDeliveryAutonomy: { 'repo-other': { mode: 'AUTONOMOUS', commonIdentity: 'forged', revision: 'forged' } }
    })
    expect(settings.loadSettings().gitDeliveryAutonomy).toEqual(saved)

    expect(await policy.choose('SUPERVISED')).toBe(true)
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(policy.getPolicy({ repositoryId: 'repo-1', path: repo }).mode).toBe('SUPERVISED')
    expect(policy.getPolicy({ repositoryId: 'repo-1', path: wt }).mode).toBe('SUPERVISED')

    context = null
    expect(policy.getPolicy().mode).toBe('SUPERVISED')
  })

  it('returns false without persisting when confirmation is declined', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'git-delivery-policy-deny-'))
    userDataRoots.push(userData)
    local.profile = userData

    const repo = await createTempGitRepo()
    roots.push(repo)
    writeFileSync(join(repo, 'a.txt'), 'v1\n')
    await stageAll(repo)
    await commit(repo, 'init')

    const settings = new SettingsService()
    const policy = new GitDeliveryTrustPolicy(
      settings,
      () => ({ repositoryId: 'repo-1', path: repo, revision: 1 }),
      async () => false
    )

    expect(await policy.choose('AUTONOMOUS')).toBe(false)
    expect(policy.getPolicy({ repositoryId: 'repo-1', path: repo }).mode).toBe('SUPERVISED')
    expect(settings.loadSettings().gitDeliveryAutonomy).toBeUndefined()
  })
})
