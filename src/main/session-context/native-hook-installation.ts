import { existsSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { boundedFile, nativeDigest, nativeGitIdentity, nativeHookEvents, prepareNativeSpool, readNativeBinding, type NativeHookBinding } from './native-hooks'
import { assertProfilePath, assertRevision, revision, writeConfig, removeConfig, type FileRevision } from '../local-mcp-clients/safe-config-file'
import type { WorktreeRecord } from '../git-operations/git-worktree-registry'

const MAX_HOOK_CONFIG_BYTES = 65536
const MAX_INSTALLATION_BYTES = 512 * 1024

export interface NativeInstallationInspection {
  state: 'CONFIGURED' | 'MISSING' | 'INCOMPATIBLE' | 'UNKNOWN'
  reasonCode: string
  digest?: string
  installed: number
  repairability?: 'REPAIRABLE' | 'CONFLICT' | 'UNSAFE'
  expected: 7
  handlers: { key: string; event: typeof nativeHookEvents[number] }[]
}
export function inspectNativeInstallation(root: string, target: { repositoryId: string; worktreeId: string; generation: string }, platform = process.platform): NativeInstallationInspection {
  const result = (state: NativeInstallationInspection['state'], reasonCode: string, installed = 0): NativeInstallationInspection => ({ state, reasonCode, installed, expected: 7, handlers: [] })
  const directory = join(root, '.code-awareness/native-hooks'), configPath = join(root, '.codex/hooks.json')
  try {
    checkPaths(root)
    if (!existsSync(join(directory, 'binding.json')) || !existsSync(configPath)) {
      const state = readInstallation(root, target)
      if (state && !state.binding.enabled && state.removed === 0) return result('INCOMPATIBLE', 'NATIVE_CAPTURE_DISABLED')
      return { ...result('MISSING', 'NATIVE_CONFIG_MISSING'), ...(state ? { repairability: 'REPAIRABLE' as const } : {}) }
    }
    const binding = readNativeBinding(join(directory, 'binding.json')), identity = nativeGitIdentity(root)
    if (binding.repositoryId !== target.repositoryId || binding.worktreeId !== target.worktreeId || binding.generation !== target.generation ||
      binding.root !== identity.root || binding.directoryIdentity !== identity.directoryIdentity || binding.commonDirectory !== identity.commonDirectory || binding.spool !== join(directory, 'spool')) return result('INCOMPATIBLE', 'WORKTREE_STALE')
    if ([directory, dirname(configPath), binding.spool].some(path => realpathSync(path) !== resolve(path))) return result('INCOMPATIBLE', 'HOOK_PATH_UNAVAILABLE')
    if (!binding.enabled) return result('INCOMPATIBLE', 'NATIVE_CAPTURE_DISABLED')
    if (!existsSync(join(directory, 'installation.json'))) return result('UNKNOWN', 'INSTALLATION_SNAPSHOT_MISSING')
    const snapshot: HookSnapshot = JSON.parse(boundedFile(join(directory, 'installation.json'), MAX_INSTALLATION_BYTES)), text = boundedFile(configPath, MAX_HOOK_CONFIG_BYTES)
    if (![1, 2].includes(snapshot.schema) || snapshot.path !== configPath) return { ...result('INCOMPATIBLE', 'INSTALLATION_SNAPSHOT_INVALID'), repairability: 'CONFLICT' }
    const config = JSON.parse(text), handlers: NativeInstallationInspection['handlers'] = []
    const bindingPath = join(directory, 'binding.json')
    const validatedCommands = new Set<string>()
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
          if (!validatedCommands.has(paths[2])) {
            const digestPath = /^native-hook-([a-f0-9]{64})\.cjs$/.exec(paths[2].split(/[\\/]/).at(-1)!)
            if (digestPath && nativeDigest(boundedFile(paths[2], MAX_INSTALLATION_BYTES)) !== digestPath[1]) return result('INCOMPATIBLE', 'HOOK_COMMAND_DIGEST_MISMATCH', handlers.length)
            validatedCommands.add(paths[2])
          }
          const windows = '& ' + paths.slice(1).map(path => "'" + path.replaceAll("'", "''") + "'").join(' ')
          if (platform === 'win32' && hook.commandWindows !== windows) return result('INCOMPATIBLE', 'WINDOWS_COMMAND_INCOMPATIBLE', handlers.length)
          const name = event.replace(/[A-Z]/g, (letter, offset) => (offset ? '_' : '') + letter.toLowerCase())
          matches.push({ key: `${configPath}:${name}:${groupIndex}:${handlerIndex}`, event })
        }
      }
      if (matches.length > 1) return result('INCOMPATIBLE', 'NATIVE_HANDLER_AMBIGUOUS', handlers.length)
      handlers.push(...matches)
    }
    const bindingDrift = snapshot.schema === 2 && !same(snapshot.binding, binding)
    if (handlers.length !== 7 || snapshot.installedDigest !== nativeDigest(text) || bindingDrift) {
      const state = readInstallation(root, target)
      const reason = handlers.length !== 7 ? 'NATIVE_HANDLERS_MISSING' : bindingDrift ? 'HOOK_BINDING_DRIFT' : 'HOOK_CONFIG_DRIFT'
      return { ...result('INCOMPATIBLE', reason, handlers.length), repairability: state ? 'REPAIRABLE' : 'CONFLICT' }
    }
    return { state: 'CONFIGURED', reasonCode: 'INSTALLATION_VERIFIED', digest: snapshot.installedDigest, installed: 7, expected: 7, handlers }
  } catch (error) { return { ...result('UNKNOWN', 'INSTALLATION_UNVERIFIABLE'), repairability: error instanceof Error && /(?:UNSAFE|LINK|PROFILE|PATH)/.test(error.message) ? 'UNSAFE' : 'CONFLICT' } }
}

interface OwnedHook { type: 'command'; command: string; commandWindows?: string; timeout: 3 }
interface HookSnapshot { schema: 1 | 2; path: string; before: string | null; installedDigest: string; owned?: OwnedHook; binding?: NativeHookBinding; rollbackBase?: string | null; previousOwned?: OwnedHook }
interface InstallationState { snapshot: HookSnapshot; binding: NativeHookBinding; owned: OwnedHook; text: string | null; cleaned: string | null; revisions: Map<string, FileRevision>; removed: number }
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b)
function hookPaths(root: string) {
  const directory = join(root, '.code-awareness/native-hooks')
  return { directory, bindingPath: join(directory, 'binding.json'), snapshotPath: join(directory, 'installation.json'), configPath: join(root, '.codex/hooks.json') }
}
function checkPaths(root: string): void {
  if (realpathSync(root) !== resolve(root)) throw new Error('UNSAFE_HOOK_DIRECTORY')
  const paths = hookPaths(root)
  for (const path of [paths.directory, paths.bindingPath, paths.snapshotPath, paths.configPath, join(paths.directory, 'spool')]) assertProfilePath(path, root)
}
function parseConfig(text: string | null): { hooks: Record<string, { matcher?: unknown; hooks: Record<string, unknown>[]; [key: string]: unknown }[]>; [key: string]: unknown } {
  const value = text === null ? {} : JSON.parse(text)
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.hooks && (typeof value.hooks !== 'object' || Array.isArray(value.hooks))) throw new Error('HOOK_CONFIG_UNSUPPORTED')
  value.hooks ??= {}
  if (Object.values(value.hooks).some(groups => !Array.isArray(groups) || groups.some(group => !group || typeof group !== 'object' || !Array.isArray(group.hooks)))) throw new Error('HOOK_CONFIG_UNSUPPORTED')
  return value
}
function ownsBinding(binding: NativeHookBinding, root: string, target: { repositoryId: string; worktreeId: string; generation: string }): void {
  const identity = nativeGitIdentity(root)
  if (binding.schema !== 1 || typeof binding.enabled !== 'boolean' || !/^[a-f0-9]{64}$/.test(binding.worktreeId) || !/^[a-f0-9]{64}$/.test(binding.generation) || binding.gitCommitTool !== undefined && !/^mcp__[a-zA-Z0-9_-]+__commit_git_changes$/.test(binding.gitCommitTool)) throw new Error('INVALID_BINDING')
  if (binding.repositoryId !== target.repositoryId || binding.worktreeId !== target.worktreeId || binding.generation !== target.generation || binding.root !== identity.root || binding.directoryIdentity !== identity.directoryIdentity || binding.commonDirectory !== identity.commonDirectory || binding.spool !== join(hookPaths(root).directory, 'spool')) throw new Error('WORKTREE_STALE')
}
function readInstallation(root: string, target?: { repositoryId: string; worktreeId: string; generation: string }, desired?: OwnedHook): InstallationState | undefined {
  checkPaths(root)
  const { configPath, bindingPath, snapshotPath } = hookPaths(root)
  const revisions = new Map([configPath, bindingPath, snapshotPath].map(path => [path, revision(path)]))
  const snapshotText = revisions.get(snapshotPath)!.content
  if (snapshotText === null) {
    if (revisions.get(bindingPath)!.content !== null) throw new Error('INSTALLATION_SNAPSHOT_MISSING')
    return
  }
  if (Buffer.byteLength(snapshotText) > MAX_INSTALLATION_BYTES) throw new Error('INSTALLATION_SNAPSHOT_LIMIT')
  const snapshot = JSON.parse(snapshotText) as HookSnapshot
  if (![1, 2].includes(snapshot.schema) || snapshot.path !== configPath || snapshot.before !== null && typeof snapshot.before !== 'string' || !/^[a-f0-9]{64}$/.test(snapshot.installedDigest)) throw new Error('INSTALLATION_SNAPSHOT_INVALID')
  const binding = revisions.get(bindingPath)!.content !== null ? readNativeBinding(bindingPath) : snapshot.schema === 2 ? snapshot.binding : undefined
  if (!binding) throw new Error('INSTALLATION_BINDING_UNPROVEN')
  ownsBinding(binding, root, target ?? binding)
  if (snapshot.schema === 2) {
    if (!snapshot.binding) throw new Error('INSTALLATION_BINDING_UNPROVEN')
    ownsBinding(snapshot.binding, root, target ?? binding)
  }
  const text = revisions.get(configPath)!.content
  if (text !== null && Buffer.byteLength(text) > MAX_HOOK_CONFIG_BYTES) throw new Error('HOOK_CONFIG_LIMIT')
  const value = parseConfig(text)
  let owned = snapshot.owned
  if (snapshot.schema === 1) {
    const candidates = new Map<string, OwnedHook>()
    if (desired) candidates.set(desired.command, desired)
    for (const groups of Object.values(value.hooks)) for (const group of groups) for (const hook of group.hooks) {
      if (hook.type === 'command' && typeof hook.command === 'string' && hook.timeout === 3) candidates.set(hook.command, hook as unknown as OwnedHook)
    }
    owned = [...candidates.values()].find(hook => nativeDigest(composeNativeHooks(snapshot.before, hook.command, hook.commandWindows)) === snapshot.installedDigest)
  }
  if (!owned || owned.type !== 'command' || owned.timeout !== 3 || typeof owned.command !== 'string' || !same(Object.keys(owned).sort(), ['command', 'commandWindows', 'timeout', 'type'].filter(key => key !== 'commandWindows' || owned!.commandWindows !== undefined).sort())) throw new Error('INSTALLATION_OWNERSHIP_UNPROVEN')
  const command = /^"([^"\r\n]+)" "([^"\r\n]+)" "([^"\r\n]+)"$/.exec(owned.command)
  if (!command || command[3] !== bindingPath) throw new Error('INSTALLATION_OWNERSHIP_UNPROVEN')
  const before = parseConfig(snapshot.before)
  const ownership = [owned, ...(snapshot.previousOwned ? [snapshot.previousOwned] : [])]
  for (const prior of ownership) {
    if (prior.type !== 'command' || prior.timeout !== 3 || typeof prior.command !== 'string' || prior.commandWindows !== undefined && typeof prior.commandWindows !== 'string' || !/^"([^"\r\n]+)" "([^"\r\n]+)" "([^"\r\n]+)"$/.exec(prior.command) || !prior.command.endsWith('"' + bindingPath + '"')) throw new Error('INSTALLATION_OWNERSHIP_UNPROVEN')
  }
  let removed = 0
  for (const event of nativeHookEvents) {
    if ((before.hooks[event] ?? []).some(group => group.hooks.some(hook => ownership.some(known => hook.command === known.command)))) throw new Error('INSTALLATION_OWNERSHIP_UNPROVEN')
    const counts = new Map<string, number>()
    const groups = value.hooks[event] ?? []
    value.hooks[event] = groups.flatMap(group => {
      const hooks = group.hooks.filter(hook => {
        const known = ownership.find(known => hook.command === known.command)
        if (!known) {
          if (typeof hook.command === 'string' && hook.command.endsWith(' "' + bindingPath + '"')) throw new Error('NATIVE_HANDLER_CONFLICT')
          return true
        }
        const count = (counts.get(known.command) ?? 0) + 1; counts.set(known.command, count)
        if (!same(hook, known) || group.matcher !== undefined || count > 1) throw new Error('NATIVE_HANDLER_CONFLICT')
        removed++
        return false
      })
      return hooks.length || Object.keys(group).some(key => key !== 'hooks') ? [{ ...group, hooks }] : []
    })
  }
  return { snapshot, binding, owned, text, cleaned: removed ? JSON.stringify(value, null, 2) + '\n' : text, revisions, removed }
}
function rollbackBase(state: InstallationState): string | null {
  const exactConfig = state.text !== null && nativeDigest(state.text) === state.snapshot.installedDigest
  if (!exactConfig) return state.cleaned
  if (state.snapshot.schema === 1) return state.snapshot.before
  return state.snapshot.rollbackBase === undefined ? state.cleaned : state.snapshot.rollbackBase
}
function publish(root: string, revisions: Map<string, FileRevision>, path: string, content: string | null): void {
  const check = () => {
    checkPaths(root)
    for (const [path, expected] of revisions) { assertProfilePath(path, root); assertRevision(path, expected) }
  }
  check()
  if (content === null) removeConfig(path, root, revisions.get(path)!)
  else writeConfig(path, root, revisions.get(path)!, content, check)
  revisions.set(path, revision(path))
}
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


export function installNativeHooks(options: { repositoryId: string; record: WorktreeRecord; commandPath: string; commandContent?: string; nodePath: string; gitCommitTool?: string; authorized: boolean }): { state: 'CONFIGURED' | 'NO_CHANGE'; bindingPath: string; hooksDigest: string; capture: 'UNOBSERVED'; trust: 'UNCHANGED' | 'REVIEW_REQUIRED' } {
  if (!options.authorized) throw new Error('HOOK_AUTHORIZATION_REQUIRED')
  if (options.gitCommitTool !== undefined && !/^mcp__[a-zA-Z0-9_-]+__commit_git_changes$/.test(options.gitCommitTool)) throw new Error('INVALID_BINDING')
  if (options.record.detached || options.record.missing || options.record.prunable || !options.record.branch || !options.record.head) throw new Error('WORKTREE_STALE')
  const root = options.record.path, paths = hookPaths(root)
  checkPaths(root)
  const { commandPath, commandContent } = options
  for (const path of [commandPath, options.nodePath]) {
    if (/["\r\n]/.test(path) || resolve(path) !== path ||
      (existsSync(path) ? realpathSync(path) !== path : path !== commandPath || commandContent === undefined)) throw new Error('INVALID_HOOK_COMMAND')
  }
  let commandRevision: FileRevision | undefined
  if (commandContent !== undefined) {
    const expected = join(root, 'out/session-context', 'native-hook-' + nativeDigest(commandContent) + '.cjs')
    const legacy = join(root, 'out/session-context/native-hook.cjs')
    if ((commandPath !== expected && commandPath !== legacy) || Buffer.byteLength(commandContent) > MAX_INSTALLATION_BYTES) throw new Error('INVALID_HOOK_COMMAND')
    assertProfilePath(commandPath, root)
    commandRevision = revision(commandPath)
    if ((commandPath === legacy || commandRevision.content !== null) && commandRevision.content !== commandContent) throw new Error('HOOK_COMMAND_DIGEST_MISMATCH')
  }
  const command = '"' + options.nodePath + '" "' + options.commandPath + '" "' + paths.bindingPath + '"'
  const commandWindows = '& ' + [options.nodePath, options.commandPath, paths.bindingPath].map(path => "'" + path.replaceAll("'", "''") + "'").join(' ')
  const owned: OwnedHook = { type: 'command', command, commandWindows, timeout: 3 }
  const state = readInstallation(root, { repositoryId: options.repositoryId, ...options.record }, owned)
  if (state?.snapshot.previousOwned && !same(state.owned, owned)) throw new Error('INSTALLATION_REPAIR_PENDING')
  const knownGitCommitTool = state?.snapshot.schema === 2 ? state.snapshot.binding?.gitCommitTool : state?.binding.gitCommitTool
  const gitCommitTool = options.gitCommitTool ?? knownGitCommitTool
  const binding: NativeHookBinding = { schema: 1, enabled: true, repositoryId: options.repositoryId, worktreeId: options.record.worktreeId, generation: options.record.generation,
    ...nativeGitIdentity(root), spool: join(paths.directory, 'spool'), ...(gitCommitTool ? { gitCommitTool } : {}) }
  if (state && !state.snapshot.previousOwned && same(state.binding, binding) && same(state.owned, owned) && state.text !== null && nativeDigest(state.text) === state.snapshot.installedDigest && inspectNativeInstallation(root, binding).state === 'CONFIGURED') return { state: 'NO_CHANGE', bindingPath: paths.bindingPath, hooksDigest: state.snapshot.installedDigest, capture: 'UNOBSERVED', trust: 'UNCHANGED' }
  const revisions = state?.revisions ?? new Map([paths.configPath, paths.bindingPath, paths.snapshotPath].map(path => [path, revision(path)]))
  if (commandRevision) revisions.set(commandPath, commandRevision)
  const before = state ? state.snapshot.before : revisions.get(paths.configPath)!.content
  if (before !== null && Buffer.byteLength(before) > MAX_HOOK_CONFIG_BYTES) throw new Error('HOOK_CONFIG_LIMIT')
  const base = state ? rollbackBase(state) : before
  const after = composeNativeHooks(base, command, commandWindows)
  if (Buffer.byteLength(after) > MAX_HOOK_CONFIG_BYTES) throw new Error('HOOK_CONFIG_LIMIT')
  if (!state && Object.values(parseConfig(before).hooks).some(groups => groups.some(group => group.hooks.some(hook =>
    typeof hook.command === 'string' && hook.command.endsWith(' "' + paths.bindingPath + '"'))))) throw new Error('INSTALLATION_OWNERSHIP_UNPROVEN')
  const snapshot: HookSnapshot = { schema: 2, path: paths.configPath, before, installedDigest: nativeDigest(after), owned, binding, rollbackBase: base,
    ...(state && !same(state.owned, owned) ? { previousOwned: state.owned } : state?.snapshot.previousOwned ? { previousOwned: state.snapshot.previousOwned } : {}) }
  const snapshotText = JSON.stringify(snapshot)
  if (Buffer.byteLength(snapshotText) > MAX_INSTALLATION_BYTES) throw new Error('INSTALLATION_SNAPSHOT_LIMIT')
  checkPaths(root)
  for (const [path, expected] of revisions) assertRevision(path, expected)
  if (commandContent !== undefined && commandRevision?.content === null) publish(root, revisions, commandPath, commandContent)
  prepareNativeSpool(binding.spool)
  publish(root, revisions, paths.snapshotPath, snapshotText)
  publish(root, revisions, paths.bindingPath, JSON.stringify(binding))
  publish(root, revisions, paths.configPath, after)
  if (snapshot.previousOwned) { delete snapshot.previousOwned; publish(root, revisions, paths.snapshotPath, JSON.stringify(snapshot)) }
  return { state: 'CONFIGURED', bindingPath: paths.bindingPath, hooksDigest: snapshot.installedDigest, capture: 'UNOBSERVED', trust: 'REVIEW_REQUIRED' }
}

export function disableNativeHooks(root: string, authorized: boolean): { state: 'DISABLED'; restored: boolean } {
  if (!authorized) throw new Error('HOOK_AUTHORIZATION_REQUIRED')
  const state = readInstallation(root)
  if (!state) throw new Error('INSTALLATION_SNAPSHOT_MISSING')
  const { configPath, bindingPath } = hookPaths(root)
  if (!state.binding.enabled && state.removed === 0) return { state: 'DISABLED', restored: state.text === state.snapshot.before }
  const restore = rollbackBase(state)
  parseConfig(restore)
  publish(root, state.revisions, bindingPath, JSON.stringify({ ...state.binding, enabled: false }))
  publish(root, state.revisions, configPath, restore)
  return { state: 'DISABLED', restored: restore === state.snapshot.before }
}
