import { existsSync, mkdirSync, writeFileSync, unlinkSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { boundedFile, nativeDigest, nativeGitIdentity, nativeHookEvents, prepareNativeSpool, readNativeBinding, type NativeHookBinding } from './native-hooks'
import type { WorktreeRecord } from '../git-operations/git-worktree-registry'

export interface NativeInstallationInspection {
  state: 'CONFIGURED' | 'MISSING' | 'INCOMPATIBLE' | 'UNKNOWN'
  reasonCode: string
  digest?: string
  installed: number
  expected: 7
  handlers: { key: string; event: typeof nativeHookEvents[number] }[]
}
export function inspectNativeInstallation(root: string, target: { repositoryId: string; worktreeId: string; generation: string }, platform = process.platform): NativeInstallationInspection {
  const result = (state: NativeInstallationInspection['state'], reasonCode: string, installed = 0): NativeInstallationInspection => ({ state, reasonCode, installed, expected: 7, handlers: [] })
  const directory = join(root, '.code-awareness/native-hooks'), configPath = join(root, '.codex/hooks.json')
  try {
    if (!existsSync(join(directory, 'binding.json')) || !existsSync(configPath)) return result('MISSING', 'NATIVE_CONFIG_MISSING')
    const binding = readNativeBinding(join(directory, 'binding.json')), identity = nativeGitIdentity(root)
    if (binding.repositoryId !== target.repositoryId || binding.worktreeId !== target.worktreeId || binding.generation !== target.generation ||
      binding.root !== identity.root || binding.directoryIdentity !== identity.directoryIdentity || binding.commonDirectory !== identity.commonDirectory || binding.spool !== join(directory, 'spool')) return result('INCOMPATIBLE', 'WORKTREE_STALE')
    if ([directory, dirname(configPath), binding.spool].some(path => realpathSync(path) !== resolve(path))) return result('INCOMPATIBLE', 'HOOK_PATH_UNAVAILABLE')
    if (!binding.enabled) return result('INCOMPATIBLE', 'NATIVE_CAPTURE_DISABLED')
    if (!existsSync(join(directory, 'installation.json'))) return result('UNKNOWN', 'INSTALLATION_SNAPSHOT_MISSING')
    const snapshot: HookSnapshot = JSON.parse(boundedFile(join(directory, 'installation.json'), 131072)), text = boundedFile(configPath, 65536)
    if (snapshot.schema !== 1 || snapshot.path !== configPath || snapshot.installedDigest !== nativeDigest(text)) return result('INCOMPATIBLE', 'HOOK_CONFIG_DRIFT')
    const config = JSON.parse(text), handlers: NativeInstallationInspection['handlers'] = []
    const bindingPath = join(directory, 'binding.json')
    for (const event of nativeHookEvents) {
      const matches: NativeInstallationInspection['handlers'] = []
      if (!Array.isArray(config.hooks?.[event])) continue
      for (const [groupIndex, group] of config.hooks[event].entries()) {
        if (!Array.isArray(group?.hooks)) continue
        for (const [handlerIndex, hook] of group.hooks.entries()) {
          if (hook?.type !== 'command' || typeof hook.command !== 'string') continue
          const paths = /^"([^"\r\n]+)" "([^"\r\n]+)" "([^"\r\n]+)"$/.exec(hook.command)
          if (!paths || paths[3] !== bindingPath) continue
          if (group.matcher !== undefined || hook.async === true || hook.timeout !== 3) return result('INCOMPATIBLE', 'NATIVE_HANDLER_INCOMPATIBLE', handlers.length)
          if (paths.slice(1).some(path => resolve(path) !== path || !existsSync(path) || realpathSync(path) !== path)) return result('INCOMPATIBLE', 'HOOK_PATH_UNAVAILABLE', handlers.length)
          const windows = '& ' + paths.slice(1).map(path => "'" + path.replaceAll("'", "''") + "'").join(' ')
          if (platform === 'win32' && hook.commandWindows !== windows) return result('INCOMPATIBLE', 'WINDOWS_COMMAND_INCOMPATIBLE', handlers.length)
          const name = event.replace(/[A-Z]/g, (letter, offset) => (offset ? '_' : '') + letter.toLowerCase())
          matches.push({ key: `${configPath}:${name}:${groupIndex}:${handlerIndex}`, event })
        }
      }
      if (matches.length > 1) return result('INCOMPATIBLE', 'NATIVE_HANDLER_AMBIGUOUS', handlers.length)
      handlers.push(...matches)
    }
    if (handlers.length !== 7) return result('INCOMPATIBLE', 'NATIVE_HANDLERS_MISSING', handlers.length)
    return { state: 'CONFIGURED', reasonCode: 'INSTALLATION_VERIFIED', digest: snapshot.installedDigest, installed: 7, expected: 7, handlers }
  } catch { return result('UNKNOWN', 'INSTALLATION_UNVERIFIABLE') }
}

interface HookSnapshot { schema: 1; path: string; before: string | null; installedDigest: string }
export function composeNativeHooks(text: string | null, command: string, commandWindows?: string): string {
  const value = text === null ? {} : JSON.parse(text)
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.hooks && (typeof value.hooks !== 'object' || Array.isArray(value.hooks))) throw new Error('HOOK_CONFIG_UNSUPPORTED')
  value.hooks ??= {}
  for (const event of nativeHookEvents) {
    const groups = value.hooks[event] ?? []
    if (!Array.isArray(groups)) throw new Error('HOOK_CONFIG_UNSUPPORTED')
    if (!groups.some(group => Array.isArray(group?.hooks) && group.hooks.some((hook: { command?: string }) => hook.command === command))) groups.push({ hooks: [{ type: 'command', command, ...(commandWindows ? { commandWindows } : {}), timeout: 3 }] })
    value.hooks[event] = groups
  }
  return JSON.stringify(value, null, 2) + '\n'
}

export function installNativeHooks(options: { repositoryId: string; record: WorktreeRecord; commandPath: string; nodePath: string; gitCommitTool?: string; authorized: boolean }): { state: 'CONFIGURED'; bindingPath: string; hooksDigest: string; capture: 'UNOBSERVED' } {
  if (!options.authorized) throw new Error('HOOK_AUTHORIZATION_REQUIRED')
  if (options.gitCommitTool !== undefined && !/^mcp__[a-zA-Z0-9_-]+__commit_git_changes$/.test(options.gitCommitTool)) throw new Error('INVALID_BINDING')
  if (options.record.detached || options.record.missing || options.record.prunable || !options.record.branch || !options.record.head) throw new Error('WORKTREE_STALE')
  const root = options.record.path, directory = join(root, '.code-awareness/native-hooks'), bindingPath = join(directory, 'binding.json')
  if (existsSync(join(directory, 'installation.json'))) throw new Error('NATIVE_HOOK_ALREADY_CONFIGURED')
  for (const path of [options.commandPath, options.nodePath]) if (!existsSync(path) || /["\r\n]/.test(path) || resolve(path) !== path) throw new Error('INVALID_HOOK_COMMAND')
  prepareNativeSpool(join(directory, 'spool'))
  const binding: NativeHookBinding = { schema: 1, enabled: true, repositoryId: options.repositoryId, worktreeId: options.record.worktreeId, generation: options.record.generation,
    ...nativeGitIdentity(root), spool: join(directory, 'spool'), ...(options.gitCommitTool ? { gitCommitTool: options.gitCommitTool } : {}) }
  const path = join(root, '.codex/hooks.json'), before = existsSync(path) ? boundedFile(path, 65536) : null
  const command = `"${options.nodePath}" "${options.commandPath}" "${bindingPath}"`
  const commandWindows = '& ' + [options.nodePath, options.commandPath, bindingPath].map(path => "'" + path.replaceAll("'", "''") + "'").join(' ')
  const after = composeNativeHooks(before, command, commandWindows)
  if (Buffer.byteLength(after) > 65536) throw new Error('HOOK_CONFIG_LIMIT')
  mkdirSync(dirname(path), { recursive: true })
  if (realpathSync(dirname(path)) !== resolve(dirname(path))) throw new Error('UNSAFE_HOOK_DIRECTORY')
  const snapshot: HookSnapshot = { schema: 1, path, before, installedDigest: nativeDigest(after) }
  writeFileSync(join(directory, 'installation.json'), JSON.stringify(snapshot), { flag: 'wx', mode: 0o600 })
  writeFileSync(bindingPath, JSON.stringify(binding), { flag: 'wx', mode: 0o600 })
  readNativeBinding(bindingPath)
  if ((existsSync(path) ? boundedFile(path, 65536) : null) !== before) throw new Error('HOOK_CONFIG_CHANGED')
  writeFileSync(path, after, { mode: 0o600 })
  return { state: 'CONFIGURED', bindingPath, hooksDigest: snapshot.installedDigest, capture: 'UNOBSERVED' }
}

export function disableNativeHooks(root: string, authorized: boolean): { state: 'DISABLED'; restored: boolean } {
  if (!authorized) throw new Error('HOOK_AUTHORIZATION_REQUIRED')
  const directory = join(root, '.code-awareness/native-hooks'), bindingPath = join(directory, 'binding.json')
  const binding = readNativeBinding(bindingPath)
  writeFileSync(bindingPath, JSON.stringify({ ...binding, enabled: false }), { mode: 0o600 })
  const snapshot: HookSnapshot = JSON.parse(boundedFile(join(directory, 'installation.json'), 131072))
  const path = join(root, '.codex/hooks.json')
  if (snapshot.schema !== 1 || snapshot.path !== path || nativeDigest(boundedFile(path, 65536)) !== snapshot.installedDigest) return { state: 'DISABLED', restored: false }
  if (snapshot.before === null) unlinkSync(path)
  else writeFileSync(path, snapshot.before, { mode: 0o600 })
  return { state: 'DISABLED', restored: true }
}
