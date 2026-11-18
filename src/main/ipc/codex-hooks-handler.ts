import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { SettingsService } from '../core/settings-service'
import {
  disableUserProfileHooks, enrollRepositoryForUserHooks, enrollUserProfileHooks, revokeNativeHooks,
  userProfileHookStatus
} from '../session-context/native-hook-enrollment'
import { resolveDistributableNodeRuntime, resolvePortableHelperContent } from '../session-context/native-hook-profile'
import type { NativeHookProvider } from '../session-context/native-hooks'
import type { AntigravityUserHooksInstallInput, CodexUserHooksInstallInput } from '../../shared/types/codex-hooks-types'

export interface CodexHooksHandlerOptions {
  profile: string
  appPath: string
  resourcesPath?: string
  packaged: boolean
  settingsService: SettingsService
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function bindProviderHooks(
  options: CodexHooksHandlerOptions,
  trustedUrl: string,
  provider: Extract<NativeHookProvider, 'codex' | 'antigravity'>
): void {
  const channelPrefix = provider === 'antigravity' ? 'antigravity-hooks' : 'codex-hooks'
  const invalidError = provider === 'antigravity' ? 'INVALID_ANTIGRAVITY_HOOKS_REQUEST' : 'INVALID_CODEX_HOOKS_REQUEST'
  const trusted = (url: string) => {
    try { return new URL(url).href.split('#')[0] === new URL(trustedUrl).href.split('#')[0] }
    catch { return false }
  }
  const bind = (name: string, validateCount: (count: number) => boolean, callback: (...args: unknown[]) => unknown) => {
    ipcMain.handle(`${channelPrefix}:${name}`, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      const url = event.senderFrame?.url
      if (!validateCount(args.length) || event.senderFrame !== event.sender.mainFrame || event.sender.isDestroyed() || !url || !trusted(url)) {
        throw new Error(invalidError)
      }
      return callback(...args)
    })
  }

  const loadAutoEnroll = () => {
    const settings = options.settingsService.loadSettings()
    return provider === 'antigravity'
      ? settings.antigravityCapture?.autoEnrollNewProjects === true
      : settings.codexCapture?.autoEnrollNewProjects === true
  }

  bind('status', count => count <= 1, (repositoryId?: unknown) => {
    if (repositoryId !== undefined && typeof repositoryId !== 'string') throw new Error(invalidError)
    const status = userProfileHookStatus({ provider, profile: options.profile, repositoryId })
    return { ...status, autoEnrollNewProjects: status.profileEnabled ? status.autoEnrollNewProjects : loadAutoEnroll() }
  })

  bind('install', count => count === 1, (rawInput: unknown) => {
    if (!isPlainObject(rawInput)) throw new Error(invalidError)
    const input = rawInput as CodexUserHooksInstallInput & AntigravityUserHooksInstallInput
    if (input.autoEnrollNewProjects !== undefined) {
      const current = options.settingsService.loadSettings()
      if (provider === 'antigravity') {
        options.settingsService.saveSettings({
          ...current,
          antigravityCapture: {
            ...current.antigravityCapture,
            autoEnrollNewProjects: Boolean(input.autoEnrollNewProjects)
          }
        })
      } else {
        options.settingsService.saveSettings({
          ...current,
          codexCapture: {
            ...current.codexCapture,
            autoEnrollNewProjects: Boolean(input.autoEnrollNewProjects),
            ...(input.gitCommitTool !== undefined ? { gitCommitTool: input.gitCommitTool } : {})
          }
        })
      }
    }
    const runtime = resolveDistributableNodeRuntime({
      packaged: options.packaged,
      execPath: process.execPath,
      allowWorktreeRuntime: !options.packaged
    })
    const helperContent = resolvePortableHelperContent({
      packaged: options.packaged,
      appPath: options.appPath,
      resourcesPath: options.resourcesPath
    })
    const configHome = typeof input.configHome === 'string'
      ? input.configHome
      : (typeof input.codexHome === 'string' ? input.codexHome : undefined)
    const result = enrollUserProfileHooks({
      provider,
      profile: options.profile,
      configHome,
      helperContent,
      nodePath: runtime.nodePath,
      runAsNode: runtime.runAsNode,
      clientPath: typeof input.clientPath === 'string' ? input.clientPath : undefined,
      ...(provider === 'codex' && typeof input.gitCommitTool === 'string' ? { gitCommitTool: input.gitCommitTool } : {}),
      autoEnrollNewProjects: input.autoEnrollNewProjects ?? loadAutoEnroll(),
      enrollActiveRepositories: input.enrollActiveRepositories,
      repositoryIds: Array.isArray(input.repositoryIds) ? input.repositoryIds.filter((id): id is string => typeof id === 'string') : undefined,
      cutoverLegacy: input.cutoverLegacy === true,
      authorized: true,
      allowWorktreeRuntime: !options.packaged
    })
    const status = userProfileHookStatus({ provider, profile: options.profile, configHome: result.configHome })
    return {
      state: result.state,
      trust: result.trust,
      enrolledRepositories: result.enrolledRepositories,
      ...(result.cutover ? { cutover: result.cutover } : {}),
      status
    }
  })

  bind('disable', count => count <= 1, (configHome?: unknown) => {
    if (configHome !== undefined && typeof configHome !== 'string') throw new Error(invalidError)
    const result = disableUserProfileHooks(options.profile, true, provider, configHome)
    const status = userProfileHookStatus({ provider, profile: options.profile, configHome })
    return { state: result.state, status }
  })

  bind('enroll-repository', count => count === 1 || count === 2, (repositoryId: unknown, rawOptions?: unknown) => {
    if (typeof repositoryId !== 'string' || !repositoryId) throw new Error(invalidError)
    const opts = isPlainObject(rawOptions) ? rawOptions : {}
    const result = enrollRepositoryForUserHooks(options.profile, repositoryId, {
      provider,
      authorized: true,
      ...(provider === 'codex' && typeof opts.gitCommitTool === 'string' ? { gitCommitTool: opts.gitCommitTool } : {}),
      cutoverLegacy: opts.cutoverLegacy === true
    })
    const status = userProfileHookStatus({ provider, profile: options.profile, repositoryId })
    return { state: result.state, ...(result.cutover ? { cutover: result.cutover } : {}), status }
  })

  bind('revoke-repository', count => count === 1, (repositoryId: unknown) => {
    if (typeof repositoryId !== 'string' || !repositoryId) throw new Error(invalidError)
    const result = revokeNativeHooks(options.profile, repositoryId, provider, true)
    const status = userProfileHookStatus({ provider, profile: options.profile, repositoryId })
    return { state: result.state, status }
  })
}

export function registerCodexHooksHandlers(options: CodexHooksHandlerOptions, trustedUrl: string): void {
  bindProviderHooks(options, trustedUrl, 'codex')
}

export function registerAntigravityHooksHandlers(options: CodexHooksHandlerOptions, trustedUrl: string): void {
  bindProviderHooks(options, trustedUrl, 'antigravity')
}
