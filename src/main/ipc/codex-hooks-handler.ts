import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { SettingsService } from '../core/settings-service'
import {
  disableUserProfileCodex, enrollRepositoryForUserCodex, enrollUserProfileCodex, revokeNativeHooks,
  userCodexProfileStatus
} from '../session-context/native-hook-enrollment'
import { resolveDistributableNodeRuntime, resolvePortableHelperContent } from '../session-context/native-hook-profile'
import type { CodexUserHooksInstallInput } from '../../shared/types/codex-hooks-types'

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

export function registerCodexHooksHandlers(options: CodexHooksHandlerOptions, trustedUrl: string): void {
  const trusted = (url: string) => {
    try { return new URL(url).href.split('#')[0] === new URL(trustedUrl).href.split('#')[0] }
    catch { return false }
  }
  const bind = (name: string, validateCount: (count: number) => boolean, callback: (...args: unknown[]) => unknown) => {
    ipcMain.handle(`codex-hooks:${name}`, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      const url = event.senderFrame?.url
      if (!validateCount(args.length) || event.senderFrame !== event.sender.mainFrame || event.sender.isDestroyed() || !url || !trusted(url)) {
        throw new Error('INVALID_CODEX_HOOKS_REQUEST')
      }
      return callback(...args)
    })
  }

  const loadAutoEnroll = () => options.settingsService.loadSettings().codexCapture?.autoEnrollNewProjects === true

  bind('status', count => count <= 1, (repositoryId?: unknown) => {
    if (repositoryId !== undefined && typeof repositoryId !== 'string') throw new Error('INVALID_CODEX_HOOKS_REQUEST')
    const status = userCodexProfileStatus({ profile: options.profile, repositoryId })
    return { ...status, autoEnrollNewProjects: status.profileEnabled ? status.autoEnrollNewProjects : loadAutoEnroll() }
  })

  bind('install', count => count === 1, (rawInput: unknown) => {
    if (!isPlainObject(rawInput)) throw new Error('INVALID_CODEX_HOOKS_REQUEST')
    const input = rawInput as CodexUserHooksInstallInput
    if (input.autoEnrollNewProjects !== undefined) {
      const current = options.settingsService.loadSettings()
      options.settingsService.saveSettings({
        ...current,
        codexCapture: {
          ...current.codexCapture,
          autoEnrollNewProjects: Boolean(input.autoEnrollNewProjects),
          ...(input.gitCommitTool !== undefined ? { gitCommitTool: input.gitCommitTool } : {})
        }
      })
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
    const result = enrollUserProfileCodex({
      profile: options.profile,
      codexHome: typeof input.codexHome === 'string' ? input.codexHome : undefined,
      helperContent,
      nodePath: runtime.nodePath,
      runAsNode: runtime.runAsNode,
      clientPath: typeof input.clientPath === 'string' ? input.clientPath : undefined,
      gitCommitTool: typeof input.gitCommitTool === 'string' ? input.gitCommitTool : undefined,
      autoEnrollNewProjects: input.autoEnrollNewProjects ?? loadAutoEnroll(),
      enrollActiveRepositories: input.enrollActiveRepositories,
      repositoryIds: Array.isArray(input.repositoryIds) ? input.repositoryIds.filter((id): id is string => typeof id === 'string') : undefined,
      cutoverLegacy: input.cutoverLegacy === true,
      authorized: true,
      allowWorktreeRuntime: !options.packaged
    })
    const status = userCodexProfileStatus({ profile: options.profile, codexHome: result.codexHome })
    return {
      state: result.state,
      trust: result.trust,
      enrolledRepositories: result.enrolledRepositories,
      ...(result.cutover ? { cutover: result.cutover } : {}),
      status
    }
  })

  bind('disable', count => count <= 1, (codexHome?: unknown) => {
    if (codexHome !== undefined && typeof codexHome !== 'string') throw new Error('INVALID_CODEX_HOOKS_REQUEST')
    const result = disableUserProfileCodex(options.profile, true, codexHome)
    const status = userCodexProfileStatus({ profile: options.profile, codexHome })
    return { state: result.state, status }
  })

  bind('enroll-repository', count => count === 1 || count === 2, (repositoryId: unknown, rawOptions?: unknown) => {
    if (typeof repositoryId !== 'string' || !repositoryId) throw new Error('INVALID_CODEX_HOOKS_REQUEST')
    const opts = isPlainObject(rawOptions) ? rawOptions : {}
    const result = enrollRepositoryForUserCodex(options.profile, repositoryId, {
      authorized: true,
      gitCommitTool: typeof opts.gitCommitTool === 'string' ? opts.gitCommitTool : undefined,
      cutoverLegacy: opts.cutoverLegacy === true
    })
    const status = userCodexProfileStatus({ profile: options.profile, repositoryId })
    return { state: result.state, ...(result.cutover ? { cutover: result.cutover } : {}), status }
  })

  bind('revoke-repository', count => count === 1, (repositoryId: unknown) => {
    if (typeof repositoryId !== 'string' || !repositoryId) throw new Error('INVALID_CODEX_HOOKS_REQUEST')
    const result = revokeNativeHooks(options.profile, repositoryId, 'codex', true)
    const status = userCodexProfileStatus({ profile: options.profile, repositoryId })
    return { state: result.state, status }
  })
}
