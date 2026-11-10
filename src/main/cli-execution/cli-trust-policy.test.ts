import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SettingsService } from '../core/settings-service'
import { CliTrustPolicy, type CliLocalContext } from './cli-trust-policy'
import { registerCliPolicyHandlers } from '../ipc/cli-policy-handler'

function createRepoWithWorktrees(baseDir: string, name = 'checkout'): { main: string; wt1: string; wt2: string } {
  const main = join(baseDir, name)
  const wt1 = join(baseDir, `${name}-wt1`)
  const wt2 = join(baseDir, `${name}-wt2`)
  mkdirSync(join(main, '.git', 'worktrees', 'wt1'), { recursive: true })
  mkdirSync(join(main, '.git', 'worktrees', 'wt2'), { recursive: true })
  writeFileSync(join(main, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  mkdirSync(wt1, { recursive: true })
  mkdirSync(wt2, { recursive: true })
  writeFileSync(join(wt1, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'wt1')}\n`)
  writeFileSync(join(main, '.git', 'worktrees', 'wt1', 'commondir'), '../..\n')
  writeFileSync(join(main, '.git', 'worktrees', 'wt1', 'gitdir'), `${join(wt1, '.git')}\n`)
  writeFileSync(join(wt2, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'wt2')}\n`)
  writeFileSync(join(main, '.git', 'worktrees', 'wt2', 'commondir'), '../..\n')
  writeFileSync(join(main, '.git', 'worktrees', 'wt2', 'gitdir'), `${join(wt2, '.git')}\n`)
  return { main, wt1, wt2 }
}

const local = vi.hoisted(() => ({ profile: '', handlers: new Map<string, Function>() }))
vi.mock('electron', () => ({ app: { getPath: () => local.profile }, ipcMain: { handle: (name: string, handler: Function) => local.handlers.set(name, handler) } }))

describe('Desktop-only repository CLI trust', () => {
  let settings: SettingsService, policy: CliTrustPolicy, context: CliLocalContext | null
  const consent = vi.fn(async () => true)
  beforeEach(() => {
    local.profile = mkdtempSync(join(tmpdir(), 'ca-cli-trust-'))
    const path = join(local.profile, 'checkout'); mkdirSync(path)
    context = { repositoryId: 'repo-a', path, revision: 1 }
    settings = new SettingsService()
    policy = new CliTrustPolicy(settings, () => context, consent)
    consent.mockReset().mockResolvedValue(true)
  })
  afterEach(() => rmSync(local.profile, { recursive: true, force: true }))
  it('keeps legacy installs OFF/supervised and requires local consent before persisting trust', async () => {
    expect(settings.loadSettings().cliExecutionEnabled).toBe(false)
    expect(policy.getPolicy().mode).toBe('SUPERVISED')
    await expect(policy.choose('AUTONOMOUS_TRUSTED')).rejects.toThrow('CLI_EXECUTION_DISABLED')
    settings.saveSettings({ ...settings.loadSettings(), cliExecutionEnabled: true })
    consent.mockResolvedValueOnce(false)
    expect(await policy.choose('AUTONOMOUS_TRUSTED')).toBe(false)
    expect(settings.loadSettings().cliAutonomy).toBeUndefined()
    expect(await policy.choose('AUTONOMOUS_TRUSTED')).toBe(true)
    expect(new CliTrustPolicy(new SettingsService(), () => context, consent).getPolicy().mode).toBe('AUTONOMOUS_TRUSTED')
    const saved = settings.loadSettings().cliAutonomy
    settings.saveSettings({ ...settings.loadSettings(), cliAutonomy: { 'repo-b': { mode: 'AUTONOMOUS_TRUSTED', revision: 'remote', checkoutIdentity: 'forged' } } })
    expect(settings.loadSettings().cliAutonomy).toEqual(saved)
    const calls = consent.mock.calls.length
    await policy.choose('SUPERVISED')
    expect(consent).toHaveBeenCalledTimes(calls)
    expect(policy.getPolicy().mode).toBe('SUPERVISED')
  })
  it('does not transfer trust across repository, checkout generation or pending-selection changes', async () => {
    settings.saveSettings({ ...settings.loadSettings(), cliExecutionEnabled: true })
    await policy.choose('AUTONOMOUS_TRUSTED')
    const original = context!
    context = { ...original, repositoryId: 'repo-b', revision: 2 }
    expect(policy.getPolicy().mode).toBe('SUPERVISED')
    context = original
    renameSync(original.path, original.path + '-old'); mkdirSync(original.path)
    expect(policy.getPolicy().mode).toBe('SUPERVISED')
    consent.mockImplementationOnce(async () => { context = { ...original, revision: 3 }; return true })
    await expect(policy.choose('AUTONOMOUS_TRUSTED')).rejects.toThrow('PROJECT_CONTEXT_CHANGED')
    context = null
    await expect(policy.choose('AUTONOMOUS_TRUSTED')).rejects.toThrow('CHECKOUT_IDENTITY_UNAVAILABLE')
  })
  it('accepts changes only from the local owner top frame and keeps stop independent of trust', async () => {
    settings.saveSettings({ ...settings.loadSettings(), cliExecutionEnabled: true })
    const webContents = { mainFrame: {} }, window = { isDestroyed: () => false, webContents }
    const cancel = vi.fn(async () => { operation = null })
    let operation: string | null = 'running'
    registerCliPolicyHandlers(policy, () => window as never, () => ({ getActiveOperationId: () => operation, cancel }) as never)
    const choose = local.handlers.get('cli:choose-mode')!
    await expect(choose({ sender: {}, senderFrame: webContents.mainFrame }, 'AUTONOMOUS_TRUSTED')).rejects.toThrow('LOCAL_OPERATOR_REQUIRED')
    await expect(choose({ sender: webContents, senderFrame: {} }, 'AUTONOMOUS_TRUSTED')).rejects.toThrow('LOCAL_OPERATOR_REQUIRED')
    const event = { sender: webContents, senderFrame: webContents.mainFrame }
    expect(await choose(event, 'AUTONOMOUS_TRUSTED')).toEqual({ accepted: true })
    expect(await local.handlers.get('cli:stop')!(event)).toEqual({ stopped: true })
    expect(cancel).toHaveBeenCalledWith({ operationId: 'running' })
    await expect(choose(event, 'REMOTE_MODE')).rejects.toThrow('INVALID_CLI_MODE')
    await expect(choose(event, 'AUTONOMOUS_CONSULTATIVE', 'REPOSITORY_WORKTREES')).rejects.toThrow('INVALID_CLI_SCOPE')
    await expect(choose(event, 'AUTONOMOUS_TRUSTED', 'UNSUPPORTED_SCOPE')).rejects.toThrow('INVALID_CLI_SCOPE')
  })
  it('does not let a delayed native acceptance supersede revocation or OFF', async () => {
    settings.saveSettings({ ...settings.loadSettings(), cliExecutionEnabled: true })
    let accept!: (value: boolean) => void
    consent.mockImplementationOnce(() => new Promise(resolve => { accept = resolve }))
    const pending = policy.choose('AUTONOMOUS_TRUSTED')
    await policy.choose('SUPERVISED')
    accept(true)
    await expect(pending).rejects.toThrow('POLICY_CHANGED')
    expect(policy.getPolicy().mode).toBe('SUPERVISED')
    consent.mockImplementationOnce(() => new Promise(resolve => { accept = resolve }))
    const disabled = policy.choose('AUTONOMOUS_TRUSTED')
    settings.saveSettings({ ...settings.loadSettings(), cliExecutionEnabled: false })
    accept(true)
    await expect(disabled).rejects.toThrow('POLICY_CHANGED')
  })
  it('keeps legacy grants without scope restricted to active checkout and authorizes repository Worktrees only under REPOSITORY_WORKTREES', async () => {
    const repo = createRepoWithWorktrees(local.profile, 'repo-main')
    const foreign = createRepoWithWorktrees(local.profile, 'repo-foreign')
    context = { repositoryId: 'repo-a', path: repo.main, revision: 1 }
    settings.saveSettings({ ...settings.loadSettings(), cliExecutionEnabled: true })

    // Legacy grant (without scope field) defaults to ACTIVE_CHECKOUT_ONLY and never auto-upgrades
    expect(await policy.choose('AUTONOMOUS_TRUSTED')).toBe(true)
    expect(settings.loadSettings().cliAutonomy?.['repo-a'].scope).toBe('ACTIVE_CHECKOUT_ONLY')
    // Simulate stripped legacy grant lacking scope field on disk
    const currentGrant = settings.loadSettings().cliAutonomy!['repo-a']
    settings.setLocalCliTrust('repo-a', { mode: currentGrant.mode, checkoutIdentity: currentGrant.checkoutIdentity, revision: currentGrant.revision })
    expect(policy.getPolicy()).toMatchObject({ mode: 'AUTONOMOUS_TRUSTED', scope: 'ACTIVE_CHECKOUT_ONLY' })
    expect(policy.getPolicy({ repositoryId: 'repo-a', path: repo.wt1 }).mode).toBe('SUPERVISED')

    // Explicit YOLO grant authorizes active checkout + two Worktrees of same repo without extra dialogs
    expect(await policy.choose('AUTONOMOUS_TRUSTED', 'REPOSITORY_WORKTREES')).toBe(true)
    expect(consent).toHaveBeenCalledTimes(2)
    expect(consent).toHaveBeenLastCalledWith('AUTONOMOUS_TRUSTED', context, 'REPOSITORY_WORKTREES')
    expect(policy.getPolicy()).toMatchObject({ mode: 'AUTONOMOUS_TRUSTED', scope: 'REPOSITORY_WORKTREES', rule: 'local-repository-worktree-trust' })
    expect(policy.getPolicy({ repositoryId: 'repo-a', path: repo.main })).toMatchObject({ mode: 'AUTONOMOUS_TRUSTED', scope: 'REPOSITORY_WORKTREES' })
    expect(policy.getPolicy({ repositoryId: 'repo-a', path: repo.wt1 })).toMatchObject({ mode: 'AUTONOMOUS_TRUSTED', scope: 'REPOSITORY_WORKTREES' })
    expect(policy.getPolicy({ repositoryId: 'repo-a', path: repo.wt2 })).toMatchObject({ mode: 'AUTONOMOUS_TRUSTED', scope: 'REPOSITORY_WORKTREES' })
    expect(consent).toHaveBeenCalledTimes(2)

    // Persists across Desktop restart without reopening dialog
    const restarted = new CliTrustPolicy(new SettingsService(), () => context, consent)
    expect(restarted.getPolicy()).toMatchObject({ mode: 'AUTONOMOUS_TRUSTED', scope: 'REPOSITORY_WORKTREES' })
    expect(restarted.getPolicy({ repositoryId: 'repo-a', path: repo.wt2 })).toMatchObject({ mode: 'AUTONOMOUS_TRUSTED', scope: 'REPOSITORY_WORKTREES' })
    expect(consent).toHaveBeenCalledTimes(2)

    // Blocks foreign repo
    expect(policy.getPolicy({ repositoryId: 'repo-b', path: repo.wt1 }).mode).toBe('SUPERVISED')
    expect(policy.getPolicy({ repositoryId: 'repo-a', path: foreign.main }).mode).toBe('SUPERVISED')
    expect(policy.getPolicy({ repositoryId: 'repo-a', path: foreign.wt1 }).mode).toBe('SUPERVISED')

    // Blocks unregistered directory even with forged gitdir pointer or junction to main .git
    const unregistered = join(local.profile, 'unregistered')
    mkdirSync(unregistered, { recursive: true })
    expect(policy.getPolicy({ repositoryId: 'repo-a', path: unregistered }).mode).toBe('SUPERVISED')
    writeFileSync(join(unregistered, '.git'), `gitdir: ${join(repo.main, '.git', 'worktrees', 'wt1')}\n`)
    expect(policy.getPolicy({ repositoryId: 'repo-a', path: unregistered }).mode).toBe('SUPERVISED')
    const junctionFake = join(local.profile, 'junction-fake')
    mkdirSync(junctionFake, { recursive: true })
    symlinkSync(join(repo.main, '.git'), join(junctionFake, '.git'), 'junction')
    expect(policy.getPolicy({ repositoryId: 'repo-a', path: junctionFake }).mode).toBe('SUPERVISED')

    // Blocks missing commonIdentity tampering & unknown scope
    settings.setLocalCliTrust('repo-a', { mode: 'AUTONOMOUS_TRUSTED', scope: 'REPOSITORY_WORKTREES', checkoutIdentity: currentGrant.checkoutIdentity, revision: 'tampered' })
    expect(policy.getPolicy({ repositoryId: 'repo-a', path: repo.wt1 }).mode).toBe('SUPERVISED')

    // Re-grant YOLO, verify project change & checkout replacement block, then revocation
    expect(await policy.choose('AUTONOMOUS_TRUSTED', 'REPOSITORY_WORKTREES')).toBe(true)
    const originalContext = context!
    context = { ...originalContext, repositoryId: 'repo-b', revision: 2 }
    expect(policy.getPolicy({ repositoryId: 'repo-a', path: repo.wt1 }).mode).toBe('SUPERVISED')
    context = originalContext
    await policy.choose('SUPERVISED')
    expect(policy.getPolicy().mode).toBe('SUPERVISED')
    expect(policy.getPolicy({ repositoryId: 'repo-a', path: repo.wt1 }).mode).toBe('SUPERVISED')

    expect(await policy.choose('AUTONOMOUS_TRUSTED', 'REPOSITORY_WORKTREES')).toBe(true)
    renameSync(repo.main, repo.main + '-old')
    mkdirSync(repo.main)
    expect(policy.getPolicy({ repositoryId: 'repo-a', path: repo.wt1 }).mode).toBe('SUPERVISED')
  })
})
