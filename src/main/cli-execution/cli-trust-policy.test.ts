import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SettingsService } from '../core/settings-service'
import { CliTrustPolicy, type CliLocalContext } from './cli-trust-policy'
import { registerCliPolicyHandlers } from '../ipc/cli-policy-handler'

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
})
