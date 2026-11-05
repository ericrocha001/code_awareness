import { existsSync, mkdirSync, writeFileSync, unlinkSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { boundedFile, nativeDigest, nativeGitIdentity, nativeHookEvents, prepareNativeSpool, readNativeBinding, type NativeHookBinding } from './native-hooks'
import type { WorktreeRecord } from '../git-operations/git-worktree-registry'

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
