import { existsSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import {
  antigravityHookEvents, boundedFile, codexHookEvents, nativeDigest, nativeGitIdentity,
  prepareNativeSpool, readNativeBinding, type NativeHookBinding, type NativeHookEvent, type NativeHookProvider
} from './native-hooks'
import { assertProfilePath, assertRevision, revision, writeConfig, removeConfig, type FileRevision } from '../local-mcp-clients/safe-config-file'
import type { WorktreeRecord } from '../git-operations/git-worktree-registry'

const MAX_HOOK_CONFIG_BYTES = 65536
const MAX_INSTALLATION_BYTES = 512 * 1024
export const ANTIGRAVITY_HOOK_NAME = 'code-awareness-session-context'
const antigravityFlatEvents = new Set<NativeHookEvent>(['SessionStart', 'PreInvocation', 'PostInvocation', 'Stop'])

const providerEvents = (provider: NativeHookProvider = 'codex'): readonly NativeHookEvent[] =>
  provider === 'antigravity' ? antigravityHookEvents : codexHookEvents

export interface NativeInstallationInspection {
  state: 'CONFIGURED' | 'MISSING' | 'INCOMPATIBLE' | 'UNKNOWN'
  reasonCode: string
  digest?: string
  installed: number
  repairability?: 'REPAIRABLE' | 'CONFLICT' | 'UNSAFE'
  expected: 7 | 6
  handlers: { key: string; event: NativeHookEvent }[]
}

function formatAntigravityWindowsCommand(nodePath: string, commandPath: string, bindingPath: string): string {
  return `set PATH=${dirname(nodePath)};%PATH%&& set CA_SCRIPT=${commandPath}&& set CA_BINDING=${bindingPath}&& ${basename(nodePath)} -e process.argv[2]=process.env.CA_BINDING;require(process.env.CA_SCRIPT)`
}

function parseHandlerCommand(command: string): [string, string, string, string] | null {
  const quoted = /^"([^"\r\n]+)" "([^"\r\n]+)" "([^"\r\n]+)"$/.exec(command)
  if (quoted) return [quoted[0], quoted[1], quoted[2], quoted[3]]
  const winCmd = /^set PATH=([^"\r\n&|<>^%;]+);%PATH%&& set CA_SCRIPT=([^"\r\n&|<>^%]+)&& set CA_BINDING=([^"\r\n&|<>^%]+)&& ([^"\r\n&|<>^%\\/: ]+) -e process\.argv\[2\]=process\.env\.CA_BINDING;require\(process\.env\.CA_SCRIPT\)$/.exec(command)
  if (winCmd) return [winCmd[0], join(winCmd[1], winCmd[4]), winCmd[2], winCmd[3]]
  return null
}

function referencesBindingPath(command: string, bindingPath: string): boolean {
  return command.endsWith(' "' + bindingPath + '"') || command.includes('set CA_BINDING=' + bindingPath + '&&')
}

function validateHandlerCommand(
  command: string,
  bindingPath: string,
  validatedCommands: Set<string>
): string[] | 'NOT_OWNED' | 'HOOK_PATH_UNAVAILABLE' | 'HOOK_COMMAND_DIGEST_MISMATCH' {
  const paths = parseHandlerCommand(command)
  if (!paths || paths[3] !== bindingPath) return 'NOT_OWNED'
  if (paths.slice(1).some(path => resolve(path) !== path || !existsSync(path) || !statSync(path).isFile() || realpathSync(path) !== path)) {
    return 'HOOK_PATH_UNAVAILABLE'
  }
  if (!validatedCommands.has(paths[2])) {
    const digestPath = /^native-hook-([a-f0-9]{64})\.cjs$/.exec(paths[2].split(/[\\/]/).at(-1)!)
    if (digestPath && nativeDigest(boundedFile(paths[2], MAX_INSTALLATION_BYTES)) !== digestPath[1]) {
      return 'HOOK_COMMAND_DIGEST_MISMATCH'
    }
    validatedCommands.add(paths[2])
  }
  return paths
}

function inspectHandlerList(
  list: Record<string, unknown>[],
  bindingPath: string,
  validatedCommands: Set<string>,
  onOwned: (paths: string[], hook: Record<string, unknown>, handlerIndex: number) => string | undefined
): string | undefined {
  for (const [handlerIndex, hook] of list.entries()) {
    if (hook?.type !== 'command' || typeof hook.command !== 'string') continue
    const validated = validateHandlerCommand(hook.command, bindingPath, validatedCommands)
    if (validated === 'NOT_OWNED') continue
    if (typeof validated === 'string') return validated
    const failure = onOwned(validated, hook, handlerIndex)
    if (failure) return failure
  }
  return undefined
}

export function inspectNativeInstallation(
  root: string,
  target: { repositoryId: string; worktreeId: string; generation: string },
  platform = process.platform,
  provider: NativeHookProvider = 'codex'
): NativeInstallationInspection {
  const events = providerEvents(provider), expected = events.length as 7 | 6
  const result = (state: NativeInstallationInspection['state'], reasonCode: string, installed = 0): NativeInstallationInspection =>
    ({ state, reasonCode, installed, expected, handlers: [] })
  const { directory, bindingPath, snapshotPath, configPath } = hookPaths(root, provider)
  try {
    checkPaths(root, provider)
    if (!existsSync(bindingPath) || !existsSync(configPath)) {
      const state = readInstallation(root, target, undefined, provider)
      if (state && !state.binding.enabled && state.removed === 0) return result('INCOMPATIBLE', 'NATIVE_CAPTURE_DISABLED')
      return { ...result('MISSING', 'NATIVE_CONFIG_MISSING'), ...(state ? { repairability: 'REPAIRABLE' as const } : {}) }
    }
    const binding = readNativeBinding(bindingPath), identity = nativeGitIdentity(root)
    if ((binding.provider ?? 'codex') !== provider || binding.repositoryId !== target.repositoryId || binding.worktreeId !== target.worktreeId ||
      binding.generation !== target.generation || binding.root !== identity.root || binding.directoryIdentity !== identity.directoryIdentity ||
      binding.commonDirectory !== identity.commonDirectory || binding.spool !== join(directory, 'spool')) return result('INCOMPATIBLE', 'WORKTREE_STALE')
    if ([directory, dirname(configPath), binding.spool].some(path => realpathSync(path) !== resolve(path))) return result('INCOMPATIBLE', 'HOOK_PATH_UNAVAILABLE')
    if (!binding.enabled) return result('INCOMPATIBLE', 'NATIVE_CAPTURE_DISABLED')
    if (!existsSync(snapshotPath)) return { ...result('UNKNOWN', 'INSTALLATION_SNAPSHOT_MISSING'), repairability: 'CONFLICT' }
    const snapshot: HookSnapshot = JSON.parse(boundedFile(snapshotPath, MAX_INSTALLATION_BYTES)), text = boundedFile(configPath, MAX_HOOK_CONFIG_BYTES)
    if (![1, 2].includes(snapshot.schema) || snapshot.path !== configPath || (snapshot.provider ?? 'codex') !== provider) {
      return { ...result('INCOMPATIBLE', 'INSTALLATION_SNAPSHOT_INVALID'), repairability: 'CONFLICT' }
    }
    const config = JSON.parse(text), handlers: NativeInstallationInspection['handlers'] = []
    const validatedCommands = new Set<string>()
    if (provider === 'antigravity') {
      const group = config && typeof config === 'object' && !Array.isArray(config) ? (config as Record<string, unknown>)[ANTIGRAVITY_HOOK_NAME] : undefined
      if (group && typeof group === 'object' && !Array.isArray(group)) {
        const hookGroup = group as Record<string, unknown>
        if ('enabled' in hookGroup && hookGroup.enabled !== true) return result('INCOMPATIBLE', 'NATIVE_HANDLER_INCOMPATIBLE', 0)
        for (const event of antigravityHookEvents) {
          const matches: NativeInstallationInspection['handlers'] = []
          const name = event.replace(/[A-Z]/g, (letter, offset) => (offset ? '_' : '') + letter.toLowerCase())
          const entries = hookGroup[event]
          if (!Array.isArray(entries)) continue
          if (antigravityFlatEvents.has(event)) {
            const failure = inspectHandlerList(entries as Record<string, unknown>[], bindingPath, validatedCommands, (paths, hook, handlerIndex) => {
              if (hook.async === true || hook.timeout !== 3) return 'NATIVE_HANDLER_INCOMPATIBLE'
              if (platform === 'win32' && hook.command !== formatAntigravityWindowsCommand(paths[1], paths[2], paths[3])) return 'WINDOWS_COMMAND_INCOMPATIBLE'
              matches.push({ key: `${configPath}:${ANTIGRAVITY_HOOK_NAME}:${name}:${handlerIndex}`, event })
              return undefined
            })
            if (failure) return result('INCOMPATIBLE', failure, handlers.length)
          } else {
            for (const [groupIndex, entry] of entries.entries()) {
              if (!Array.isArray(entry?.hooks)) continue
              const failure = inspectHandlerList(entry.hooks as Record<string, unknown>[], bindingPath, validatedCommands, (paths, hook, handlerIndex) => {
                if (entry.matcher !== '*' || hook.async === true || hook.timeout !== 3) return 'NATIVE_HANDLER_INCOMPATIBLE'
                if (platform === 'win32' && hook.command !== formatAntigravityWindowsCommand(paths[1], paths[2], paths[3])) return 'WINDOWS_COMMAND_INCOMPATIBLE'
                matches.push({ key: `${configPath}:${ANTIGRAVITY_HOOK_NAME}:${name}:${groupIndex}:${handlerIndex}`, event })
                return undefined
              })
              if (failure) return result('INCOMPATIBLE', failure, handlers.length)
            }
          }
          if (matches.length > 1) return { ...result('INCOMPATIBLE', 'NATIVE_HANDLER_AMBIGUOUS'), repairability: 'CONFLICT' }
          handlers.push(...matches)
        }
      }
    } else {
      for (const event of codexHookEvents) {
        const matches: NativeInstallationInspection['handlers'] = []
        if (!Array.isArray(config.hooks?.[event])) continue
        const name = event.replace(/[A-Z]/g, (letter, offset) => (offset ? '_' : '') + letter.toLowerCase())
        for (const [groupIndex, group] of config.hooks[event].entries()) {
          if (!Array.isArray(group?.hooks)) continue
          const failure = inspectHandlerList(group.hooks as Record<string, unknown>[], bindingPath, validatedCommands, (paths, hook, handlerIndex) => {
            if (group.matcher !== undefined || hook.async === true || hook.timeout !== 3) return 'NATIVE_HANDLER_INCOMPATIBLE'
            const windows = '& ' + paths.slice(1).map(path => "'" + path.replaceAll("'", "''") + "'").join(' ')
            if (platform === 'win32' && hook.commandWindows !== windows) return 'WINDOWS_COMMAND_INCOMPATIBLE'
            matches.push({ key: `${configPath}:${name}:${groupIndex}:${handlerIndex}`, event })
            return undefined
          })
          if (failure) return result('INCOMPATIBLE', failure, handlers.length)
        }
        if (matches.length > 1) return { ...result('INCOMPATIBLE', 'NATIVE_HANDLER_AMBIGUOUS'), repairability: 'CONFLICT' }
        handlers.push(...matches)
      }
    }
    const state = readInstallation(root, target, undefined, provider)
    const bindingDrift = snapshot.schema === 2 && !same(snapshot.binding, binding)
    if (handlers.length !== expected || state?.removed !== expected || snapshot.installedDigest !== nativeDigest(text) || bindingDrift) {
      const reason = handlers.length !== expected || state?.removed !== expected ? 'NATIVE_HANDLERS_MISSING' : bindingDrift ? 'HOOK_BINDING_DRIFT' : 'HOOK_CONFIG_DRIFT'
      return { ...result('INCOMPATIBLE', reason, handlers.length), repairability: state ? 'REPAIRABLE' : 'CONFLICT' }
    }
    return { state: 'CONFIGURED', reasonCode: 'INSTALLATION_VERIFIED', digest: snapshot.installedDigest, installed: expected, expected, handlers }
  } catch (error) {
    const code = error instanceof Error ? error.message : ''
    if (code === 'WORKTREE_STALE') return result('INCOMPATIBLE', code)
    if (code === 'INSTALLATION_OWNERSHIP_UNPROVEN' || code === 'INSTALLATION_SNAPSHOT_MISSING' || code === 'NATIVE_HANDLER_CONFLICT') {
      return { ...result('UNKNOWN', code), repairability: 'CONFLICT' }
    }
    return { ...result('UNKNOWN', 'INSTALLATION_UNVERIFIABLE'), repairability: /(?:UNSAFE|LINK|PROFILE|PATH)/.test(code) ? 'UNSAFE' : 'CONFLICT' }
  }
}

interface OwnedHook { type: 'command'; command: string; commandWindows?: string; timeout: 3 }
interface HookSnapshot { schema: 1 | 2; provider?: NativeHookProvider; path: string; before: string | null; installedDigest: string; owned?: OwnedHook; binding?: NativeHookBinding; rollbackBase?: string | null; previousOwned?: OwnedHook }
interface InstallationState { snapshot: HookSnapshot; binding: NativeHookBinding; owned: OwnedHook; text: string | null; cleaned: string | null; revisions: Map<string, FileRevision>; removed: number }
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b)
const plainObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

export function hookPaths(root: string, provider: NativeHookProvider = 'codex') {
  const directory = provider === 'antigravity' ? join(root, '.code-awareness/native-hooks/antigravity') : join(root, '.code-awareness/native-hooks')
  const configPath = provider === 'antigravity' ? join(root, '.agents/hooks.json') : join(root, '.codex/hooks.json')
  return { directory, bindingPath: join(directory, 'binding.json'), snapshotPath: join(directory, 'installation.json'), configPath }
}
function checkPaths(root: string, provider: NativeHookProvider = 'codex'): void {
  if (realpathSync(root) !== resolve(root)) throw new Error('UNSAFE_HOOK_DIRECTORY')
  const paths = hookPaths(root, provider)
  for (const path of [paths.directory, paths.bindingPath, paths.snapshotPath, paths.configPath, join(paths.directory, 'spool')]) assertProfilePath(path, root)
}

function parseCodexConfig(text: string | null): { hooks: Record<string, { matcher?: unknown; hooks: Record<string, unknown>[]; [key: string]: unknown }[]>; [key: string]: unknown } {
  const value = text === null ? {} : JSON.parse(text)
  if (!plainObject(value) || value.hooks && !plainObject(value.hooks)) throw new Error('HOOK_CONFIG_UNSUPPORTED')
  value.hooks ??= {}
  if (Object.values(value.hooks as Record<string, unknown>).some(groups => !Array.isArray(groups) || groups.some(group => !plainObject(group) || !Array.isArray(group.hooks)))) throw new Error('HOOK_CONFIG_UNSUPPORTED')
  return value as { hooks: Record<string, { matcher?: unknown; hooks: Record<string, unknown>[]; [key: string]: unknown }[]>; [key: string]: unknown }
}

function parseAntigravityConfig(text: string | null): Record<string, unknown> {
  const value = text === null ? {} : JSON.parse(text)
  if (!plainObject(value)) throw new Error('HOOK_CONFIG_UNSUPPORTED')
  const group = value[ANTIGRAVITY_HOOK_NAME]
  if (group !== undefined) {
    if (!plainObject(group) || ('enabled' in group && typeof group.enabled !== 'boolean')) throw new Error('HOOK_CONFIG_UNSUPPORTED')
    for (const event of antigravityHookEvents) {
      const entries = group[event]
      if (entries === undefined) continue
      if (!Array.isArray(entries)) throw new Error('HOOK_CONFIG_UNSUPPORTED')
      if (antigravityFlatEvents.has(event)) {
        if (entries.some(item => !plainObject(item))) throw new Error('HOOK_CONFIG_UNSUPPORTED')
      } else {
        if (entries.some(item => !plainObject(item) || !Array.isArray(item.hooks) || item.hooks.some(hook => !plainObject(hook)))) throw new Error('HOOK_CONFIG_UNSUPPORTED')
      }
    }
  }
  return value
}

function antigravityReferencesBinding(value: unknown, predicate: (command: string) => boolean): boolean {
  if (!plainObject(value)) return false
  for (const item of Object.values(value)) {
    if (Array.isArray(item)) {
      for (const entry of item) {
        if (plainObject(entry)) {
          if (typeof entry.command === 'string' && predicate(entry.command)) return true
          if (Array.isArray(entry.hooks) && entry.hooks.some(hook => plainObject(hook) && typeof hook.command === 'string' && predicate(hook.command))) return true
        }
      }
    } else if (plainObject(item) && antigravityReferencesBinding(item, predicate)) {
      return true
    }
  }
  return false
}

function ownsBinding(binding: NativeHookBinding, root: string, target: { repositoryId: string; worktreeId: string; generation: string }, provider: NativeHookProvider = 'codex'): void {
  const identity = nativeGitIdentity(root)
  if (binding.schema !== 1 || (binding.provider ?? 'codex') !== provider || typeof binding.enabled !== 'boolean' || !/^[a-f0-9]{64}$/.test(binding.worktreeId) || !/^[a-f0-9]{64}$/.test(binding.generation) || binding.gitCommitTool !== undefined && !/^mcp__[a-zA-Z0-9_-]+__commit_git_changes$/.test(binding.gitCommitTool)) throw new Error('INVALID_BINDING')
  if (binding.repositoryId !== target.repositoryId || binding.worktreeId !== target.worktreeId || binding.generation !== target.generation || binding.root !== identity.root || binding.directoryIdentity !== identity.directoryIdentity || binding.commonDirectory !== identity.commonDirectory || binding.spool !== join(hookPaths(root, provider).directory, 'spool')) throw new Error('WORKTREE_STALE')
}

function readInstallation(root: string, target?: { repositoryId: string; worktreeId: string; generation: string }, desired?: OwnedHook, provider: NativeHookProvider = 'codex'): InstallationState | undefined {
  checkPaths(root, provider)
  const { configPath, bindingPath, snapshotPath } = hookPaths(root, provider)
  const revisions = new Map([configPath, bindingPath, snapshotPath].map(path => [path, revision(path)]))
  const snapshotText = revisions.get(snapshotPath)!.content
  if (snapshotText === null) {
    if (revisions.get(bindingPath)!.content !== null) throw new Error('INSTALLATION_SNAPSHOT_MISSING')
    return
  }
  if (Buffer.byteLength(snapshotText) > MAX_INSTALLATION_BYTES) throw new Error('INSTALLATION_SNAPSHOT_LIMIT')
  const snapshot = JSON.parse(snapshotText) as HookSnapshot
  if (![1, 2].includes(snapshot.schema) || snapshot.path !== configPath || (snapshot.provider ?? 'codex') !== provider || snapshot.before !== null && typeof snapshot.before !== 'string' || !/^[a-f0-9]{64}$/.test(snapshot.installedDigest)) throw new Error('INSTALLATION_SNAPSHOT_INVALID')
  const binding = revisions.get(bindingPath)!.content !== null ? readNativeBinding(bindingPath) : snapshot.schema === 2 ? snapshot.binding : undefined
  if (!binding) throw new Error('INSTALLATION_BINDING_UNPROVEN')
  ownsBinding(binding, root, target ?? binding, provider)
  if (snapshot.schema === 2) {
    if (!snapshot.binding) throw new Error('INSTALLATION_BINDING_UNPROVEN')
    ownsBinding(snapshot.binding, root, target ?? binding, provider)
  }
  const text = revisions.get(configPath)!.content
  if (text !== null && Buffer.byteLength(text) > MAX_HOOK_CONFIG_BYTES) throw new Error('HOOK_CONFIG_LIMIT')
  let owned = snapshot.owned
  const value = provider === 'antigravity' ? parseAntigravityConfig(text) : parseCodexConfig(text)
  if (snapshot.schema === 1) {
    if (provider !== 'codex') throw new Error('INSTALLATION_SNAPSHOT_INVALID')
    const codexValue = value as ReturnType<typeof parseCodexConfig>
    const candidates = new Map<string, OwnedHook>()
    if (desired) candidates.set(desired.command, desired)
    for (const groups of Object.values(codexValue.hooks)) for (const group of groups) for (const hook of group.hooks) {
      if (hook.type === 'command' && typeof hook.command === 'string' && hook.timeout === 3) candidates.set(hook.command, hook as unknown as OwnedHook)
    }
    owned = [...candidates.values()].find(hook => nativeDigest(composeNativeHooks(snapshot.before, hook.command, hook.commandWindows, 'codex')) === snapshot.installedDigest)
  }
  if (!owned || owned.type !== 'command' || owned.timeout !== 3 || typeof owned.command !== 'string' || !same(Object.keys(owned).sort(), ['command', 'commandWindows', 'timeout', 'type'].filter(key => key !== 'commandWindows' || owned!.commandWindows !== undefined).sort())) throw new Error('INSTALLATION_OWNERSHIP_UNPROVEN')
  const command = parseHandlerCommand(owned.command)
  if (!command || command[3] !== bindingPath) throw new Error('INSTALLATION_OWNERSHIP_UNPROVEN')
  const ownership = [owned, ...(snapshot.previousOwned ? [snapshot.previousOwned] : [])]
  for (const prior of ownership) {
    if (prior.type !== 'command' || prior.timeout !== 3 || typeof prior.command !== 'string' || prior.commandWindows !== undefined && typeof prior.commandWindows !== 'string' || !parseHandlerCommand(prior.command) || !referencesBindingPath(prior.command, bindingPath)) throw new Error('INSTALLATION_OWNERSHIP_UNPROVEN')
  }
  let removed = 0
  if (provider === 'antigravity') {
    const before = parseAntigravityConfig(snapshot.before)
    const ownedCommands = new Set(ownership.map(item => item.command))
    if (antigravityReferencesBinding(before, cmd => ownedCommands.has(cmd))) throw new Error('INSTALLATION_OWNERSHIP_UNPROVEN')
    for (const [key, entry] of Object.entries(value)) {
      if (key !== ANTIGRAVITY_HOOK_NAME && antigravityReferencesBinding({ [key]: entry }, cmd => referencesBindingPath(cmd, bindingPath))) throw new Error('NATIVE_HANDLER_CONFLICT')
    }
    const group = plainObject(value[ANTIGRAVITY_HOOK_NAME]) ? { ...(value[ANTIGRAVITY_HOOK_NAME] as Record<string, unknown>) } : undefined
    if (group) {
      for (const [key, entries] of Object.entries(group)) {
        if (!antigravityHookEvents.includes(key as typeof antigravityHookEvents[number]) && antigravityReferencesBinding({ [key]: entries }, cmd => referencesBindingPath(cmd, bindingPath))) {
          throw new Error('NATIVE_HANDLER_CONFLICT')
        }
      }
      for (const event of antigravityHookEvents) {
        const counts = new Map<string, number>()
        if (antigravityFlatEvents.has(event)) {
          const items = (group[event] as Record<string, unknown>[] | undefined) ?? []
          const filtered = items.filter(hook => {
            const known = ownership.find(item => hook.command === item.command)
            if (!known) {
              if (typeof hook.command === 'string' && referencesBindingPath(hook.command, bindingPath)) throw new Error('NATIVE_HANDLER_CONFLICT')
              return true
            }
            const count = (counts.get(known.command) ?? 0) + 1; counts.set(known.command, count)
            if (!same(hook, known) || count > 1) throw new Error('NATIVE_HANDLER_CONFLICT')
            removed++
            return false
          })
          if (filtered.length) group[event] = filtered
          else delete group[event]
        } else {
          const groups = (group[event] as { matcher?: unknown; hooks: Record<string, unknown>[]; [key: string]: unknown }[] | undefined) ?? []
          const filteredGroups = groups.flatMap(entry => {
            const hooks = entry.hooks.filter(hook => {
              const known = ownership.find(item => hook.command === item.command)
              if (!known) {
                if (typeof hook.command === 'string' && referencesBindingPath(hook.command, bindingPath)) throw new Error('NATIVE_HANDLER_CONFLICT')
                return true
              }
              const count = (counts.get(known.command) ?? 0) + 1; counts.set(known.command, count)
              if (!same(hook, known) || entry.matcher !== '*' || count > 1) throw new Error('NATIVE_HANDLER_CONFLICT')
              removed++
              return false
            })
            return hooks.length || Object.keys(entry).some(key => key !== 'hooks' && key !== 'matcher') ? [{ ...entry, hooks }] : []
          })
          if (filteredGroups.length) group[event] = filteredGroups
          else delete group[event]
        }
      }
      const remainingKeys = Object.keys(group)
      const beforeGroup = plainObject(before[ANTIGRAVITY_HOOK_NAME]) ? before[ANTIGRAVITY_HOOK_NAME] as Record<string, unknown> : undefined
      if (!remainingKeys.length || (remainingKeys.length === 1 && remainingKeys[0] === 'enabled' && !beforeGroup)) {
        delete value[ANTIGRAVITY_HOOK_NAME]
      } else {
        value[ANTIGRAVITY_HOOK_NAME] = group
      }
    }
  } else {
    const before = parseCodexConfig(snapshot.before), codexValue = value as ReturnType<typeof parseCodexConfig>
    for (const event of codexHookEvents) {
      if ((before.hooks[event] ?? []).some(group => group.hooks.some(hook => ownership.some(known => hook.command === known.command)))) throw new Error('INSTALLATION_OWNERSHIP_UNPROVEN')
      const counts = new Map<string, number>()
      const groups = codexValue.hooks[event] ?? []
      codexValue.hooks[event] = groups.flatMap(group => {
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
  }
  return { snapshot, binding, owned, text, cleaned: removed ? JSON.stringify(value, null, 2) + '\n' : text, revisions, removed }
}

function rollbackBase(state: InstallationState): string | null {
  const exactConfig = state.text !== null && nativeDigest(state.text) === state.snapshot.installedDigest
  if (!exactConfig) return state.cleaned
  if (state.snapshot.schema === 1) return state.snapshot.before
  return state.snapshot.rollbackBase === undefined ? state.cleaned : state.snapshot.rollbackBase
}
function publish(root: string, revisions: Map<string, FileRevision>, path: string, content: string | null, provider: NativeHookProvider = 'codex'): void {
  const check = () => {
    checkPaths(root, provider)
    for (const [path, expected] of revisions) { assertProfilePath(path, root); assertRevision(path, expected) }
  }
  check()
  if (content === null) removeConfig(path, root, revisions.get(path)!)
  else writeConfig(path, root, revisions.get(path)!, content, check)
  revisions.set(path, revision(path))
}

export function composeNativeHooks(text: string | null, command: string, commandWindows?: string, provider: NativeHookProvider = 'codex'): string {
  if (provider === 'antigravity') {
    const value = parseAntigravityConfig(text)
    const existing = value[ANTIGRAVITY_HOOK_NAME]
    if (existing !== undefined && plainObject(existing) && 'enabled' in existing && existing.enabled !== true) throw new Error('HOOK_CONFIG_UNSUPPORTED')
    const group: Record<string, unknown> = existing !== undefined ? { ...(existing as Record<string, unknown>) } : { enabled: true }
    for (const event of antigravityHookEvents) {
      if (antigravityFlatEvents.has(event)) {
        const handlers = [...((group[event] as Record<string, unknown>[] | undefined) ?? [])]
        if (!handlers.some(hook => hook.command === command)) handlers.push({ type: 'command', command, timeout: 3 })
        group[event] = handlers
      } else {
        const groups = [...((group[event] as { matcher?: unknown; hooks: Record<string, unknown>[] }[] | undefined) ?? [])]
        if (!groups.some(entry => entry.matcher === '*' && entry.hooks.some(hook => hook.command === command))) {
          groups.push({ matcher: '*', hooks: [{ type: 'command', command, timeout: 3 }] })
        }
        group[event] = groups
      }
    }
    value[ANTIGRAVITY_HOOK_NAME] = group
    return JSON.stringify(value, null, 2) + '\n'
  }
  const value = text === null ? {} : JSON.parse(text)
  if (!plainObject(value) || value.hooks && !plainObject(value.hooks)) throw new Error('HOOK_CONFIG_UNSUPPORTED')
  value.hooks ??= {}
  for (const event of codexHookEvents) {
    const groups = (value.hooks as Record<string, unknown>)[event] ?? []
    if (!Array.isArray(groups)) throw new Error('HOOK_CONFIG_UNSUPPORTED')
    if (!groups.some(group => Array.isArray(group?.hooks) && group.hooks.some((hook: { command?: string }) => hook.command === command))) groups.push({ hooks: [{ type: 'command', command, ...(commandWindows ? { commandWindows } : {}), timeout: 3 }] })
    ;(value.hooks as Record<string, unknown>)[event] = groups
  }
  return JSON.stringify(value, null, 2) + '\n'
}

export function installNativeHooks(options: { repositoryId: string; record: WorktreeRecord; commandPath: string; commandContent?: string; nodePath: string; gitCommitTool?: string; provider?: NativeHookProvider; authorized: boolean }): { state: 'CONFIGURED' | 'NO_CHANGE'; bindingPath: string; hooksDigest: string; capture: 'UNOBSERVED'; trust: 'UNCHANGED' | 'REVIEW_REQUIRED' } {
  if (!options.authorized) throw new Error('HOOK_AUTHORIZATION_REQUIRED')
  const provider: NativeHookProvider = options.provider ?? 'codex'
  if (options.gitCommitTool !== undefined && !/^mcp__[a-zA-Z0-9_-]+__commit_git_changes$/.test(options.gitCommitTool)) throw new Error('INVALID_BINDING')
  if (options.record.detached || options.record.missing || options.record.prunable || !options.record.branch || !options.record.head) throw new Error('WORKTREE_STALE')
  const root = options.record.path, paths = hookPaths(root, provider)
  checkPaths(root, provider)
  const { commandPath, commandContent } = options
  for (const path of [commandPath, options.nodePath]) {
    if (/["\r\n]/.test(path) || resolve(path) !== path ||
      (existsSync(path) ? realpathSync(path) !== path : path !== commandPath || commandContent === undefined)) throw new Error('INVALID_HOOK_COMMAND')
  }
  if (provider === 'antigravity' && process.platform === 'win32' &&
    [commandPath, options.nodePath, paths.bindingPath].some(path => /[&|<>^%;]/.test(path))) {
    throw new Error('INVALID_HOOK_COMMAND')
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
  const command = provider === 'antigravity' && process.platform === 'win32'
    ? formatAntigravityWindowsCommand(options.nodePath, options.commandPath, paths.bindingPath)
    : '"' + options.nodePath + '" "' + options.commandPath + '" "' + paths.bindingPath + '"'
  const commandWindows = provider === 'codex'
    ? '& ' + [options.nodePath, options.commandPath, paths.bindingPath].map(path => "'" + path.replaceAll("'", "''") + "'").join(' ')
    : undefined
  const owned: OwnedHook = commandWindows ? { type: 'command', command, commandWindows, timeout: 3 } : { type: 'command', command, timeout: 3 }
  const state = readInstallation(root, { repositoryId: options.repositoryId, ...options.record }, owned, provider)
  if (state?.snapshot.previousOwned && !same(state.owned, owned)) throw new Error('INSTALLATION_REPAIR_PENDING')
  const knownGitCommitTool = state?.snapshot.schema === 2 ? state.snapshot.binding?.gitCommitTool : state?.binding.gitCommitTool
  const gitCommitTool = provider === 'codex' ? (options.gitCommitTool ?? knownGitCommitTool) : undefined
  const binding: NativeHookBinding = { schema: 1, ...(provider === 'antigravity' ? { provider } : {}), enabled: true, repositoryId: options.repositoryId, worktreeId: options.record.worktreeId, generation: options.record.generation,
    ...nativeGitIdentity(root), spool: join(paths.directory, 'spool'), ...(gitCommitTool ? { gitCommitTool } : {}) }
  if (state && !state.snapshot.previousOwned && same(state.binding, binding) && same(state.owned, owned) && state.text !== null && nativeDigest(state.text) === state.snapshot.installedDigest && inspectNativeInstallation(root, binding, process.platform, provider).state === 'CONFIGURED') return { state: 'NO_CHANGE', bindingPath: paths.bindingPath, hooksDigest: state.snapshot.installedDigest, capture: 'UNOBSERVED', trust: 'UNCHANGED' }
  const revisions = state?.revisions ?? new Map([paths.configPath, paths.bindingPath, paths.snapshotPath].map(path => [path, revision(path)]))
  if (commandRevision) revisions.set(commandPath, commandRevision)
  const before = state ? state.snapshot.before : revisions.get(paths.configPath)!.content
  if (before !== null && Buffer.byteLength(before) > MAX_HOOK_CONFIG_BYTES) throw new Error('HOOK_CONFIG_LIMIT')
  const base = state ? rollbackBase(state) : before
  const after = composeNativeHooks(base, command, commandWindows, provider)
  if (Buffer.byteLength(after) > MAX_HOOK_CONFIG_BYTES) throw new Error('HOOK_CONFIG_LIMIT')
  if (!state) {
    const unownedBindingRef = provider === 'antigravity'
      ? antigravityReferencesBinding(parseAntigravityConfig(before), cmd => referencesBindingPath(cmd, paths.bindingPath))
      : Object.values(parseCodexConfig(before).hooks).some(groups => groups.some(group => group.hooks.some(hook =>
          typeof hook.command === 'string' && hook.command.endsWith(' "' + paths.bindingPath + '"'))))
    if (unownedBindingRef) throw new Error('INSTALLATION_OWNERSHIP_UNPROVEN')
  }
  const snapshot: HookSnapshot = { schema: 2, ...(provider === 'antigravity' ? { provider } : {}), path: paths.configPath, before, installedDigest: nativeDigest(after), owned, binding, rollbackBase: base,
    ...(state && !same(state.owned, owned) ? { previousOwned: state.owned } : state?.snapshot.previousOwned ? { previousOwned: state.snapshot.previousOwned } : {}) }
  const snapshotText = JSON.stringify(snapshot)
  if (Buffer.byteLength(snapshotText) > MAX_INSTALLATION_BYTES) throw new Error('INSTALLATION_SNAPSHOT_LIMIT')
  checkPaths(root, provider)
  for (const [path, expected] of revisions) assertRevision(path, expected)
  if (commandContent !== undefined && commandRevision?.content === null) publish(root, revisions, commandPath, commandContent, provider)
  prepareNativeSpool(binding.spool)
  publish(root, revisions, paths.snapshotPath, snapshotText, provider)
  publish(root, revisions, paths.bindingPath, JSON.stringify(binding), provider)
  publish(root, revisions, paths.configPath, after, provider)
  if (snapshot.previousOwned) { delete snapshot.previousOwned; publish(root, revisions, paths.snapshotPath, JSON.stringify(snapshot), provider) }
  return { state: 'CONFIGURED', bindingPath: paths.bindingPath, hooksDigest: snapshot.installedDigest, capture: 'UNOBSERVED', trust: 'REVIEW_REQUIRED' }
}

export function disableNativeHooks(root: string, authorized: boolean, provider: NativeHookProvider = 'codex'): { state: 'DISABLED'; restored: boolean } {
  if (!authorized) throw new Error('HOOK_AUTHORIZATION_REQUIRED')
  const state = readInstallation(root, undefined, undefined, provider)
  if (!state) throw new Error('INSTALLATION_SNAPSHOT_MISSING')
  const { configPath, bindingPath } = hookPaths(root, provider)
  if (!state.binding.enabled && state.removed === 0) return { state: 'DISABLED', restored: state.text === state.snapshot.before }
  const restore = rollbackBase(state)
  if (provider === 'antigravity') parseAntigravityConfig(restore)
  else parseCodexConfig(restore)
  publish(root, state.revisions, bindingPath, JSON.stringify({ ...state.binding, enabled: false }), provider)
  publish(root, state.revisions, configPath, restore, provider)
  return { state: 'DISABLED', restored: restore === state.snapshot.before }
}
