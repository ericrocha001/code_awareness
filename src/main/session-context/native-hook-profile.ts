import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { isQualifiedCodexHookVersion } from '../../shared/native-hook-preflight.cjs'
import { stableDestination } from '../../shared/local-mcp-installation.cjs'
import { assertProfilePath, assertRevision, revision, verifyConfigWriteOwnership, writeConfig, removeConfig, type FileRevision } from '../local-mcp-clients/safe-config-file'
import {
  composeNativeHooks, isPlainHookObject, ownedCommandPaths, parseCodexConfig, readInstallation, rollbackBase, sameHookValue,
  type NativeInstallationInspection, type OwnedHook
} from './native-hook-installation'
import {
  boundedFile, codexHookEvents, nativeBindingPath, nativeDigest, nativeGitCommitToolPattern, nativeGitIdentity,
  nativeWorktreeIdentity, prepareNativeSpool, readNativeBinding, sameNativePath, type NativeHookBinding
} from './native-hooks'
import { openNativeHookCatalog, readNativeEnrollment, readUserCodexProfile } from './native-hook-catalog'

const MAX_HOOK_CONFIG_BYTES = 65536
const MAX_SNAPSHOT_BYTES = 512 * 1024
const helperNamePattern = /^native-hook-([a-f0-9]{64})\.cjs$/

export interface DiscoveredCodexClient {
  path: string
  origin: 'EXPLICIT' | 'DESKTOP' | 'CLI' | 'PATH'
  version: string | null
  qualified: boolean
  reasonCode: string
}

export interface UserHookSnapshot {
  schema: 4
  provider: 'codex'
  scope: 'USER'
  codexHome: string
  path: string
  before: string | null
  rollbackBase?: string | null
  installedDigest: string
  owned: OwnedHook
  previousOwned?: OwnedHook
  helperPath: string
  helperDigest: string
  nodePath: string
  runAsNode?: boolean
  clientPath?: string
  clientVersion?: string
  enabled: boolean
  updatedAt: string
}

export interface UserCodexInstallationInspection extends NativeInstallationInspection {
  codexHome: string
  configPath: string
  snapshotPath: string
  enabled: boolean
  helperPath?: string
  helperDigest?: string
  nodePath?: string
  runAsNode?: boolean
  clientPath?: string
  clientVersion?: string
}

export function resolveCodexHome(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  const raw = explicit !== undefined ? explicit : env.CODEX_HOME
  if (raw !== undefined) {
    const trimmed = raw.trim()
    if (!trimmed) {
      if (explicit !== undefined) throw new Error('HOOK_PROFILE_UNAVAILABLE')
    } else {
      if (!isAbsolute(trimmed)) throw new Error('HOOK_PROFILE_UNAVAILABLE')
      const resolved = resolve(trimmed)
      if (existsSync(resolved)) {
        const stat = lstatSync(resolved)
        if (stat.isSymbolicLink() || !stat.isDirectory() || !sameNativePath(realpathSync(resolved), resolved)) {
          throw new Error('UNSAFE_HOOK_DIRECTORY')
        }
      }
      return resolved
    }
  }
  const fallback = resolve(join(homedir(), '.codex'))
  if (existsSync(fallback)) {
    const stat = lstatSync(fallback)
    if (stat.isSymbolicLink() || !stat.isDirectory() || !sameNativePath(realpathSync(fallback), fallback)) {
      throw new Error('UNSAFE_HOOK_DIRECTORY')
    }
  }
  return fallback
}

export function userHookSnapshotPath(profile: string): string {
  return join(resolve(profile), 'session-context', 'codex-user-hooks.json')
}

export function userHelperPath(profile: string, helperDigest: string): string {
  return join(resolve(profile), 'session-context', `native-hook-${helperDigest}.cjs`)
}

export function formatUserCodexHookCommand(nodePath: string, helperPath: string, runAsNode = false): OwnedHook {
  if (/["\r\n]/.test(nodePath) || /["\r\n]/.test(helperPath)) throw new Error('INVALID_HOOK_COMMAND')
  if (runAsNode && /[&|<>^%;'\r\n]/.test(nodePath + helperPath)) throw new Error('INVALID_HOOK_COMMAND')
  const quoted = `"${nodePath}" "${helperPath}"`
  const command = runAsNode ? `ELECTRON_RUN_AS_NODE=1 ${quoted}` : quoted
  const ps = `& '${nodePath.replaceAll("'", "''")}' '${helperPath.replaceAll("'", "''")}'`
  const commandWindows = runAsNode ? `$env:ELECTRON_RUN_AS_NODE='1'; ${ps}` : ps
  return { type: 'command', command, commandWindows, timeout: 3 }
}

export function parseUserCodexCommand(command: string): { nodePath: string; helperPath: string; runAsNode: boolean } | null {
  const match = /^(ELECTRON_RUN_AS_NODE=1 )?"([^"\r\n]+)" "([^"\r\n]+)"$/.exec(command)
  if (!match) return null
  return { runAsNode: Boolean(match[1]), nodePath: match[2], helperPath: match[3] }
}

export function resolveDistributableNodeRuntime(options: {
  packaged: boolean
  execPath: string
  env?: NodeJS.ProcessEnv
  allowWorktreeRuntime?: boolean
}): { nodePath: string; runAsNode: boolean } {
  const env = options.env ?? process.env
  if (options.packaged) {
    const executable = stableDestination(options.execPath)
    if (!existsSync(executable) || !lstatSync(executable).isFile() || !sameNativePath(realpathSync(executable), executable)) {
      throw new Error('NODE_RUNTIME_UNAVAILABLE')
    }
    return { nodePath: executable, runAsNode: true }
  }
  const candidates = [
    ...(env.npm_node_execpath ? [{ path: env.npm_node_execpath, runAsNode: false }] : []),
    ...(!/[\\/]worktrees?[\\/]/i.test(options.execPath) && /^node(?:\.exe)?$/i.test(basename(options.execPath))
      ? [{ path: options.execPath, runAsNode: false }] : []),
    ...(process.platform === 'win32' && env.ProgramFiles ? [{ path: join(env.ProgramFiles, 'nodejs', 'node.exe'), runAsNode: false }] : []),
    ...(options.allowWorktreeRuntime ? [{ path: options.execPath, runAsNode: !/^node(?:\.exe)?$/i.test(basename(options.execPath)) }] : [])
  ]
  for (const candidate of candidates) {
    if (!candidate.path || !isAbsolute(candidate.path) || !existsSync(candidate.path)) continue
    try {
      const real = realpathSync(candidate.path)
      if (!sameNativePath(real, resolve(candidate.path)) || !lstatSync(real).isFile()) continue
      if (!options.allowWorktreeRuntime && /[\\/]worktrees?[\\/]/i.test(real)) continue
      const version = execFileSync(real, ['--version'], {
        encoding: 'utf8', windowsHide: true, timeout: 3000,
        env: candidate.runAsNode ? { ...env, ELECTRON_RUN_AS_NODE: '1' } : env
      }).trim()
      if (/^v(2[0-9]|[3-9]\d)\./.test(version)) return { nodePath: real, runAsNode: candidate.runAsNode }
    } catch {}
  }
  throw new Error('NODE_RUNTIME_UNAVAILABLE')
}

export function resolvePortableHelperContent(options: { packaged: boolean; appPath: string; resourcesPath?: string }): string {
  const candidates = options.packaged && options.resourcesPath
    ? [
        join(options.resourcesPath, 'app.asar.unpacked', 'out', 'session-context', 'native-hook-portable.cjs'),
        join(options.appPath, 'out', 'session-context', 'native-hook-portable.cjs')
      ]
    : [join(options.appPath, 'out', 'session-context', 'native-hook-portable.cjs')]
  for (const candidate of candidates) {
    if (existsSync(candidate) && lstatSync(candidate).isFile()) {
      return boundedFile(candidate, MAX_SNAPSHOT_BYTES)
    }
  }
  throw new Error('HOOK_HELPER_UNAVAILABLE')
}

export function qualifyCodexBinary(path: string, origin: DiscoveredCodexClient['origin'] = 'EXPLICIT'): DiscoveredCodexClient {
  const name = /^codex(?:\.exe)?$/i
  try {
    const resolved = resolve(path)
    const real = realpathSync(resolved)
    if (!isAbsolute(resolved) || !name.test(basename(resolved)) || !sameNativePath(real, resolved) || !lstatSync(real).isFile()) {
      return { path, origin, version: null, qualified: false, reasonCode: 'CODEX_EXECUTABLE_UNAVAILABLE' }
    }
    const output = execFileSync(real, ['--version'], { encoding: 'utf8', timeout: 2000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    const version = /^codex-cli ([a-zA-Z0-9.+_-]{1,80})$/.exec(output)?.[1] ?? null
    if (!version) return { path: real, origin, version: null, qualified: false, reasonCode: 'CODEX_VERSION_UNAVAILABLE' }
    return isQualifiedCodexHookVersion(version)
      ? { path: real, origin, version, qualified: true, reasonCode: 'QUALIFIED' }
      : { path: real, origin, version, qualified: false, reasonCode: 'VERSION_UNSUPPORTED' }
  } catch {
    return { path, origin, version: null, qualified: false, reasonCode: 'CODEX_EXECUTABLE_UNAVAILABLE' }
  }
}

export function discoverCodexClients(options: { explicit?: string; localAppData?: string; programFiles?: string; env?: NodeJS.ProcessEnv } = {}): DiscoveredCodexClient[] {
  const env = options.env ?? process.env
  const candidates: Array<{ path: string; origin: DiscoveredCodexClient['origin'] }> = []
  if (options.explicit) candidates.push({ path: options.explicit, origin: 'EXPLICIT' })
  if (process.platform === 'win32') {
    const programFiles = options.programFiles ?? env.ProgramFiles ?? 'C:\\Program Files'
    const windowsApps = join(programFiles, 'WindowsApps')
    try {
      if (existsSync(windowsApps)) {
        for (const entry of readdirSync(windowsApps)) {
          if (!/^OpenAI\.Codex_/i.test(entry)) continue
          const desktopExe = join(windowsApps, entry, 'app', 'resources', 'codex.exe')
          if (existsSync(desktopExe)) candidates.push({ path: desktopExe, origin: 'DESKTOP' })
        }
      }
    } catch {}
    const localAppData = options.localAppData ?? env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
    const cliRoot = join(localAppData, 'OpenAI', 'Codex', 'bin')
    try {
      if (existsSync(cliRoot)) {
        const direct = join(cliRoot, 'codex.exe')
        if (existsSync(direct)) candidates.push({ path: direct, origin: 'CLI' })
        for (const entry of readdirSync(cliRoot)) {
          const nested = join(cliRoot, entry, 'codex.exe')
          if (existsSync(nested)) candidates.push({ path: nested, origin: 'CLI' })
        }
      }
    } catch {}
  }
  const pathDirs = (env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean)
  for (const dir of pathDirs) {
    const candidate = join(dir, process.platform === 'win32' ? 'codex.exe' : 'codex')
    if (existsSync(candidate)) candidates.push({ path: candidate, origin: 'PATH' })
  }
  const seen = new Set<string>()
  const results: DiscoveredCodexClient[] = []
  for (const item of candidates) {
    const inspected = qualifyCodexBinary(item.path, item.origin)
    const key = process.platform === 'win32' ? inspected.path.toLowerCase() : inspected.path
    if (seen.has(key)) continue
    seen.add(key)
    results.push(inspected)
  }
  return results
}

function checkUserCodexPaths(profile: string, codexHome: string): { snapshotPath: string; configPath: string } {
  const realProfile = realpathSync(resolve(profile))
  if (!sameNativePath(realProfile, resolve(profile))) throw new Error('OUTSIDE_USER_PROFILE')
  const snapshotPath = userHookSnapshotPath(realProfile)
  const configPath = join(codexHome, 'hooks.json')
  assertProfilePath(snapshotPath, realProfile)
  assertProfilePath(configPath, codexHome)
  return { snapshotPath, configPath }
}

function validateUserHelper(helperPath: string): string {
  const match = helperNamePattern.exec(basename(helperPath))
  if (!match) throw new Error('HOOK_HELPER_UNAVAILABLE')
  if (!existsSync(helperPath) || !lstatSync(helperPath).isFile() || lstatSync(helperPath).nlink !== 1 || !sameNativePath(realpathSync(helperPath), resolve(helperPath))) {
    throw new Error('HOOK_PATH_UNAVAILABLE')
  }
  if (nativeDigest(boundedFile(helperPath, MAX_SNAPSHOT_BYTES)) !== match[1]) {
    throw new Error('HOOK_COMMAND_DIGEST_MISMATCH')
  }
  return match[1]
}

function validateSnapshot(snapshotPath: string, expectedConfigPath: string): UserHookSnapshot {
  const text = boundedFile(snapshotPath, MAX_SNAPSHOT_BYTES)
  const parsed = JSON.parse(text) as Partial<UserHookSnapshot>
  if (!isPlainHookObject(parsed) || parsed.schema !== 4 || parsed.provider !== 'codex' || parsed.scope !== 'USER' ||
    typeof parsed.codexHome !== 'string' || typeof parsed.path !== 'string' || !sameNativePath(parsed.path, expectedConfigPath) ||
    (parsed.before !== null && typeof parsed.before !== 'string') ||
    (parsed.rollbackBase !== undefined && parsed.rollbackBase !== null && typeof parsed.rollbackBase !== 'string') ||
    typeof parsed.installedDigest !== 'string' || !/^[a-f0-9]{64}$/.test(parsed.installedDigest) ||
    typeof parsed.helperPath !== 'string' || typeof parsed.helperDigest !== 'string' || !/^[a-f0-9]{64}$/.test(parsed.helperDigest) ||
    typeof parsed.nodePath !== 'string' || typeof parsed.enabled !== 'boolean' || !isPlainHookObject(parsed.owned)) {
    throw new Error('INSTALLATION_SNAPSHOT_INVALID')
  }
  return parsed as UserHookSnapshot
}

function referencesUserHelper(command: string): boolean {
  const parsed = parseUserCodexCommand(command)
  if (parsed && helperNamePattern.test(basename(parsed.helperPath))) return true
  return /native-hook-[a-f0-9]{64}\.cjs/.test(command) && !command.includes('binding.json')
}

function cleanOwnedHandlersFromConfig(
  configText: string | null,
  beforeText: string | null,
  ownership: OwnedHook[]
): { cleaned: string | null; removed: number } {
  const value = parseCodexConfig(configText)
  const before = parseCodexConfig(beforeText)
  const ownedCommands = new Set(ownership.map(item => item.command))
  let removed = 0
  for (const event of codexHookEvents) {
    if ((before.hooks[event] ?? []).some(group => group.hooks.some(hook => typeof hook.command === 'string' && ownedCommands.has(hook.command)))) {
      throw new Error('INSTALLATION_OWNERSHIP_UNPROVEN')
    }
    const counts = new Map<string, number>()
    const groups = value.hooks[event] ?? []
    const nextGroups = groups.flatMap(group => {
      const hooks = group.hooks.filter(hook => {
        const known = ownership.find(item => hook.command === item.command)
        if (!known) {
          if (typeof hook.command === 'string' && referencesUserHelper(hook.command)) throw new Error('NATIVE_HANDLER_CONFLICT')
          return true
        }
        const count = (counts.get(known.command) ?? 0) + 1
        counts.set(known.command, count)
        if (!sameHookValue(hook, known) || group.matcher !== undefined || count > 1) throw new Error('NATIVE_HANDLER_CONFLICT')
        removed++
        return false
      })
      return hooks.length || Object.keys(group).some(key => key !== 'hooks') ? [{ ...group, hooks }] : []
    })
    if (nextGroups.length) value.hooks[event] = nextGroups
    else delete value.hooks[event]
  }
  if (!removed) return { cleaned: configText, removed: 0 }
  if (beforeText === null && Object.keys(value.hooks).length === 0 && Object.keys(value).length === 1) {
    return { cleaned: null, removed }
  }
  return { cleaned: JSON.stringify(value, null, 2) + '\n', removed }
}

export function inspectUserCodexInstallation(
  profile: string,
  codexHomeInput?: string,
  platform = process.platform
): UserCodexInstallationInspection {
  let codexHome = ''
  let configPath = ''
  let snapshotPath = ''
  const result = (
    state: NativeInstallationInspection['state'],
    reasonCode: string,
    installed = 0,
    extra: Partial<UserCodexInstallationInspection> = {}
  ): UserCodexInstallationInspection => ({
    state, reasonCode, installed, expected: 7, handlers: [], codexHome, configPath, snapshotPath, enabled: false, ...extra
  })
  try {
    let effectiveCodexHome = codexHomeInput
    if (effectiveCodexHome === undefined && !process.env.CODEX_HOME) {
      const existingSnapshot = userHookSnapshotPath(profile)
      if (existsSync(existingSnapshot)) {
        try {
          const parsed = JSON.parse(boundedFile(existingSnapshot, MAX_SNAPSHOT_BYTES)) as { codexHome?: unknown }
          if (typeof parsed.codexHome === 'string' && parsed.codexHome.trim()) effectiveCodexHome = parsed.codexHome
        } catch {}
      }
    }
    codexHome = resolveCodexHome(effectiveCodexHome)
    const checked = checkUserCodexPaths(profile, codexHome)
    snapshotPath = checked.snapshotPath
    configPath = checked.configPath
  } catch (error) {
    const code = error instanceof Error ? error.message : ''
    return { ...result('UNKNOWN', 'INSTALLATION_UNVERIFIABLE'), repairability: /(?:UNSAFE|LINK|PROFILE|PATH)/.test(code) ? 'UNSAFE' : 'CONFLICT' }
  }

  try {
    const hasSnapshot = existsSync(snapshotPath)
    const hasConfig = existsSync(configPath)
    if (!hasSnapshot) {
      if (hasConfig) {
        try {
          const parsed = parseCodexConfig(boundedFile(configPath, MAX_HOOK_CONFIG_BYTES))
          const hasUnowned = Object.values(parsed.hooks).some(groups => groups.some(group =>
            group.hooks.some(hook => typeof hook.command === 'string' && referencesUserHelper(hook.command))))
          if (hasUnowned) return { ...result('UNKNOWN', 'INSTALLATION_OWNERSHIP_UNPROVEN'), repairability: 'CONFLICT' }
        } catch {
          return { ...result('INCOMPATIBLE', 'HOOK_CONFIG_UNSUPPORTED'), repairability: 'CONFLICT' }
        }
      }
      return result('MISSING', 'NATIVE_CONFIG_MISSING')
    }
    const snapshot = validateSnapshot(snapshotPath, configPath)
    if (!snapshot.enabled) {
      return result('INCOMPATIBLE', 'NATIVE_CAPTURE_DISABLED', 0, {
        enabled: false, helperPath: snapshot.helperPath, helperDigest: snapshot.helperDigest,
        nodePath: snapshot.nodePath, runAsNode: snapshot.runAsNode, clientPath: snapshot.clientPath, clientVersion: snapshot.clientVersion,
        repairability: 'REPAIRABLE'
      })
    }
    if (!hasConfig) {
      return result('MISSING', 'NATIVE_CONFIG_MISSING', 0, {
        enabled: snapshot.enabled, helperPath: snapshot.helperPath, helperDigest: snapshot.helperDigest,
        nodePath: snapshot.nodePath, runAsNode: snapshot.runAsNode, clientPath: snapshot.clientPath, clientVersion: snapshot.clientVersion,
        repairability: 'REPAIRABLE'
      })
    }
    const text = boundedFile(configPath, MAX_HOOK_CONFIG_BYTES)
    const config = parseCodexConfig(text)
    const handlers: NativeInstallationInspection['handlers'] = []
    const validatedHelpers = new Set<string>()
    for (const event of codexHookEvents) {
      const matches: NativeInstallationInspection['handlers'] = []
      const groups = config.hooks[event] ?? []
      const snake = event.replace(/[A-Z]/g, (letter, offset) => (offset ? '_' : '') + letter.toLowerCase())
      for (const [groupIndex, group] of groups.entries()) {
        for (const [handlerIndex, hook] of group.hooks.entries()) {
          if (hook?.type !== 'command' || typeof hook.command !== 'string') continue
          const parsedCmd = parseUserCodexCommand(hook.command)
          if (!parsedCmd || !sameNativePath(parsedCmd.helperPath, snapshot.helperPath)) {
            if (referencesUserHelper(hook.command)) return { ...result('UNKNOWN', 'NATIVE_HANDLER_CONFLICT'), repairability: 'CONFLICT' }
            continue
          }
          if (!existsSync(parsedCmd.nodePath) || !lstatSync(parsedCmd.nodePath).isFile() || !sameNativePath(realpathSync(parsedCmd.nodePath), resolve(parsedCmd.nodePath))) {
            return result('INCOMPATIBLE', 'HOOK_PATH_UNAVAILABLE', handlers.length, { enabled: true })
          }
          if (!validatedHelpers.has(parsedCmd.helperPath)) {
            const digest = validateUserHelper(parsedCmd.helperPath)
            if (digest !== snapshot.helperDigest) return result('INCOMPATIBLE', 'HOOK_COMMAND_DIGEST_MISMATCH', handlers.length, { enabled: true })
            validatedHelpers.add(parsedCmd.helperPath)
          }
          if (group.matcher !== undefined || hook.async === true || hook.timeout !== 3) {
            return result('INCOMPATIBLE', 'NATIVE_HANDLER_INCOMPATIBLE', handlers.length, { enabled: true })
          }
          const expectedHook = formatUserCodexHookCommand(parsedCmd.nodePath, parsedCmd.helperPath, parsedCmd.runAsNode)
          if (platform === 'win32' && hook.commandWindows !== expectedHook.commandWindows) {
            return result('INCOMPATIBLE', 'WINDOWS_COMMAND_INCOMPATIBLE', handlers.length, { enabled: true })
          }
          matches.push({ key: `${configPath}:${snake}:${groupIndex}:${handlerIndex}`, event, sourcePath: configPath })
        }
      }
      if (matches.length > 1) return { ...result('INCOMPATIBLE', 'NATIVE_HANDLER_AMBIGUOUS'), repairability: 'CONFLICT', enabled: true }
      handlers.push(...matches)
    }
    cleanOwnedHandlersFromConfig(text, snapshot.before, [snapshot.owned, ...(snapshot.previousOwned ? [snapshot.previousOwned] : [])])
    if (handlers.length !== 7 || snapshot.installedDigest !== nativeDigest(text)) {
      const reason = handlers.length !== 7 ? 'NATIVE_HANDLERS_MISSING' : 'HOOK_CONFIG_DRIFT'
      return {
        ...result('INCOMPATIBLE', reason, handlers.length),
        repairability: 'REPAIRABLE', enabled: true,
        helperPath: snapshot.helperPath, helperDigest: snapshot.helperDigest,
        nodePath: snapshot.nodePath, runAsNode: snapshot.runAsNode, clientPath: snapshot.clientPath, clientVersion: snapshot.clientVersion
      }
    }
    return {
      state: 'CONFIGURED', reasonCode: 'USER_INSTALLATION_VERIFIED', digest: snapshot.installedDigest, installed: 7, expected: 7, handlers,
      codexHome, configPath, snapshotPath, enabled: true,
      helperPath: snapshot.helperPath, helperDigest: snapshot.helperDigest,
      nodePath: snapshot.nodePath, runAsNode: snapshot.runAsNode, clientPath: snapshot.clientPath, clientVersion: snapshot.clientVersion
    }
  } catch (error) {
    const code = error instanceof Error ? error.message : ''
    if (['HOOK_PATH_UNAVAILABLE', 'HOOK_COMMAND_DIGEST_MISMATCH', 'HOOK_CONFIG_UNSUPPORTED', 'INSTALLATION_SNAPSHOT_INVALID'].includes(code)) {
      return { ...result('INCOMPATIBLE', code), repairability: 'CONFLICT' }
    }
    if (['INSTALLATION_OWNERSHIP_UNPROVEN', 'NATIVE_HANDLER_CONFLICT'].includes(code)) {
      return { ...result('UNKNOWN', code), repairability: 'CONFLICT' }
    }
    return { ...result('UNKNOWN', 'INSTALLATION_UNVERIFIABLE'), repairability: /(?:UNSAFE|LINK|PROFILE|PATH)/.test(code) ? 'UNSAFE' : 'CONFLICT' }
  }
}

export function installUserCodexHooks(options: {
  profile: string
  codexHome?: string
  helperContent: string
  nodePath: string
  runAsNode?: boolean
  clientPath?: string
  clientVersion?: string
  authorized: boolean
  allowWorktreeRuntime?: boolean
}): {
  state: 'CONFIGURED' | 'NO_CHANGE'
  codexHome: string
  configPath: string
  snapshotPath: string
  helperPath: string
  helperDigest: string
  hooksDigest: string
  trust: 'UNCHANGED' | 'REVIEW_REQUIRED'
} {
  if (!options.authorized) throw new Error('HOOK_AUTHORIZATION_REQUIRED')
  const profile = realpathSync(resolve(options.profile))
  if (!sameNativePath(profile, resolve(options.profile))) throw new Error('OUTSIDE_USER_PROFILE')
  const codexHome = resolveCodexHome(options.codexHome)
  const { snapshotPath, configPath } = checkUserCodexPaths(profile, codexHome)
  const nodePath = realpathSync(resolve(options.nodePath))
  if (!isAbsolute(options.nodePath) || !sameNativePath(nodePath, resolve(options.nodePath)) || !lstatSync(nodePath).isFile()) {
    throw new Error('INVALID_HOOK_COMMAND')
  }
  if (!options.allowWorktreeRuntime && /[\\/]worktrees?[\\/]/i.test(nodePath)) {
    throw new Error('INVALID_HOOK_COMMAND')
  }
  if (Buffer.byteLength(options.helperContent) > MAX_SNAPSHOT_BYTES) throw new Error('INVALID_HOOK_COMMAND')
  const helperDigest = nativeDigest(options.helperContent)
  const helperPath = userHelperPath(profile, helperDigest)
  if (!options.allowWorktreeRuntime && /[\\/]worktrees?[\\/]/i.test(helperPath)) {
    throw new Error('INVALID_HOOK_COMMAND')
  }
  assertProfilePath(helperPath, profile)
  const runAsNode = options.runAsNode === true
  const owned = formatUserCodexHookCommand(nodePath, helperPath, runAsNode)

  const helperRev = revision(helperPath)
  if (helperRev.content !== null && nativeDigest(helperRev.content) !== helperDigest) {
    throw new Error('HOOK_COMMAND_DIGEST_MISMATCH')
  }
  const snapshotRev = revision(snapshotPath)
  const configRev = revision(configPath)
  if (configRev.content !== null && Buffer.byteLength(configRev.content) > MAX_HOOK_CONFIG_BYTES) throw new Error('HOOK_CONFIG_LIMIT')

  let priorSnapshot: UserHookSnapshot | undefined
  if (snapshotRev.content !== null) {
    const parsedRaw = JSON.parse(snapshotRev.content) as Partial<UserHookSnapshot>
    if (parsedRaw.enabled === false && typeof parsedRaw.path === 'string' && !sameNativePath(parsedRaw.path, configPath)) {
      validateSnapshot(snapshotPath, parsedRaw.path)
      if (configRev.content !== null) {
        const parsed = parseCodexConfig(configRev.content)
        const hasUnowned = Object.values(parsed.hooks).some(groups => groups.some(group =>
          group.hooks.some(hook => typeof hook.command === 'string' && referencesUserHelper(hook.command))))
        if (hasUnowned) throw new Error('INSTALLATION_OWNERSHIP_UNPROVEN')
      }
    } else {
      priorSnapshot = validateSnapshot(snapshotPath, configPath)
    }
  } else if (configRev.content !== null) {
    const parsed = parseCodexConfig(configRev.content)
    const hasUnowned = Object.values(parsed.hooks).some(groups => groups.some(group =>
      group.hooks.some(hook => typeof hook.command === 'string' && referencesUserHelper(hook.command))))
    if (hasUnowned) throw new Error('INSTALLATION_OWNERSHIP_UNPROVEN')
  }

  const currentInspection = inspectUserCodexInstallation(profile, codexHome, process.platform)
  if (priorSnapshot && priorSnapshot.enabled && currentInspection.state === 'CONFIGURED' &&
    sameHookValue(priorSnapshot.owned, owned) && priorSnapshot.helperDigest === helperDigest &&
    configRev.content !== null && nativeDigest(configRev.content) === priorSnapshot.installedDigest &&
    helperRev.content === options.helperContent) {
    return {
      state: 'NO_CHANGE', codexHome, configPath, snapshotPath, helperPath, helperDigest,
      hooksDigest: priorSnapshot.installedDigest, trust: 'UNCHANGED'
    }
  }

  const priorBefore = priorSnapshot ? priorSnapshot.before : configRev.content
  let base = configRev.content
  if (priorSnapshot) {
    const ownership = [priorSnapshot.owned, ...(priorSnapshot.previousOwned ? [priorSnapshot.previousOwned] : [])]
    if (configRev.content !== null && nativeDigest(configRev.content) === priorSnapshot.installedDigest) {
      base = priorSnapshot.rollbackBase !== undefined ? priorSnapshot.rollbackBase : cleanOwnedHandlersFromConfig(configRev.content, priorBefore, ownership).cleaned
    } else if (configRev.content !== null) {
      base = cleanOwnedHandlersFromConfig(configRev.content, priorBefore, ownership).cleaned
    }
  }
  const after = composeNativeHooks(base, owned.command, owned.commandWindows, 'codex')
  if (Buffer.byteLength(after) > MAX_HOOK_CONFIG_BYTES) throw new Error('HOOK_CONFIG_LIMIT')

  const nextSnapshot: UserHookSnapshot = {
    schema: 4,
    provider: 'codex',
    scope: 'USER',
    codexHome,
    path: configPath,
    before: priorBefore,
    rollbackBase: base,
    installedDigest: nativeDigest(after),
    owned,
    ...(priorSnapshot && !sameHookValue(priorSnapshot.owned, owned) ? { previousOwned: priorSnapshot.owned } : {}),
    helperPath,
    helperDigest,
    nodePath,
    ...(runAsNode ? { runAsNode: true } : {}),
    ...(options.clientPath ? { clientPath: options.clientPath } : {}),
    ...(options.clientVersion ? { clientVersion: options.clientVersion } : {}),
    enabled: true,
    updatedAt: new Date().toISOString()
  }

  const revisions = new Map<string, FileRevision>([
    [helperPath, helperRev],
    [snapshotPath, snapshotRev],
    [configPath, configRev]
  ])
  const writeTargets = [
    ...(helperRev.content === null ? [helperPath] : []),
    snapshotPath,
    configPath
  ]
  const verifyOwner = verifyConfigWriteOwnership(writeTargets, 5000)
  const checkAll = (baseDir: string) => () => {
    checkUserCodexPaths(profile, codexHome)
    for (const [p, expected] of revisions) {
      assertProfilePath(p, sameNativePath(p, configPath) ? codexHome : profile)
      assertRevision(p, expected)
    }
    void baseDir
  }

  if (helperRev.content === null) {
    writeConfig(helperPath, profile, helperRev, options.helperContent, checkAll(profile), undefined, verifyOwner)
    revisions.set(helperPath, revision(helperPath))
  }
  writeConfig(snapshotPath, profile, snapshotRev, JSON.stringify(nextSnapshot, null, 2) + '\n', checkAll(profile), undefined, verifyOwner)
  revisions.set(snapshotPath, revision(snapshotPath))
  writeConfig(configPath, codexHome, configRev, after, checkAll(codexHome), undefined, verifyOwner)
  revisions.set(configPath, revision(configPath))
  if (nextSnapshot.previousOwned) {
    delete nextSnapshot.previousOwned
    writeConfig(snapshotPath, profile, revisions.get(snapshotPath)!, JSON.stringify(nextSnapshot, null, 2) + '\n', checkAll(profile))
  }

  return {
    state: 'CONFIGURED', codexHome, configPath, snapshotPath, helperPath, helperDigest,
    hooksDigest: nextSnapshot.installedDigest, trust: 'REVIEW_REQUIRED'
  }
}

export function disableUserCodexHooks(profileInput: string, authorized: boolean, codexHomeInput?: string): {
  state: 'DISABLED'
  restored: boolean
  codexHome: string
  configPath: string
} {
  if (!authorized) throw new Error('HOOK_AUTHORIZATION_REQUIRED')
  const profile = realpathSync(resolve(profileInput))
  const codexHome = resolveCodexHome(codexHomeInput)
  const { snapshotPath, configPath } = checkUserCodexPaths(profile, codexHome)
  const snapshotRev = revision(snapshotPath)
  if (snapshotRev.content === null) throw new Error('INSTALLATION_SNAPSHOT_MISSING')
  const snapshot = validateSnapshot(snapshotPath, configPath)
  const configRev = revision(configPath)
  const ownership = [snapshot.owned, ...(snapshot.previousOwned ? [snapshot.previousOwned] : [])]
  const cleanedResult = configRev.content === null
    ? { cleaned: null, removed: 0 }
    : cleanOwnedHandlersFromConfig(configRev.content, snapshot.before, ownership)
  if (!snapshot.enabled && cleanedResult.removed === 0) {
    return { state: 'DISABLED', restored: configRev.content === snapshot.before, codexHome, configPath }
  }
  const exactInstalled = configRev.content !== null && nativeDigest(configRev.content) === snapshot.installedDigest
  const restore = exactInstalled
    ? (snapshot.rollbackBase !== undefined ? snapshot.rollbackBase : cleanedResult.cleaned)
    : cleanedResult.cleaned
  if (restore !== null) parseCodexConfig(restore)
  const verifyOwner = verifyConfigWriteOwnership([snapshotPath, configPath], 5000)
  const nextSnapshot: UserHookSnapshot = { ...snapshot, enabled: false, updatedAt: new Date().toISOString() }
  delete nextSnapshot.previousOwned
  writeConfig(snapshotPath, profile, snapshotRev, JSON.stringify(nextSnapshot, null, 2) + '\n', undefined, undefined, verifyOwner)
  if (restore === null) removeConfig(configPath, codexHome, configRev, verifyOwner)
  else writeConfig(configPath, codexHome, configRev, restore, undefined, undefined, verifyOwner)
  return { state: 'DISABLED', restored: restore === snapshot.before, codexHome, configPath }
}

export interface LegacyCutoverItem {
  path: string
  repositoryId?: string
  state: 'CLEAN' | 'REMOVED' | 'CONFLICT'
  reasonCode: string
  restored?: boolean
}

export function cutoverLegacyProjectCodexHooks(options: {
  profile: string
  userConfigPath: string
  repositoryId?: string
  worktreePaths?: string[]
  authorized: boolean
}): { state: 'COMPLETED' | 'DEFERRED'; items: LegacyCutoverItem[] } {
  if (!options.authorized) throw new Error('HOOK_AUTHORIZATION_REQUIRED')
  const profile = realpathSync(resolve(options.profile))
  const candidates = new Map<string, string | undefined>()
  const db = openNativeHookCatalog(profile, true)
  try {
    const records = db.prepare(`SELECT id, checkout_path FROM repository_catalog_records
      WHERE status='ACTIVE' AND availability='AVAILABLE' AND git_state='GIT'`).all() as Array<{ id: string; checkout_path: string }>
    for (const row of records) {
      if (options.repositoryId && row.id !== options.repositoryId) continue
      if (typeof row.checkout_path !== 'string') continue
      try {
        const root = realpathSync(row.checkout_path)
        candidates.set(root, row.id)
        const enrollment = readNativeEnrollment(db, row.id, 'codex')
        if (enrollment && enrollment.catalogRoot === root) {
          for (const wtPath of options.worktreePaths ?? []) {
            try {
              const wtReal = realpathSync(wtPath)
              if (nativeGitIdentity(wtReal).commonDirectory === enrollment.commonDirectory) candidates.set(wtReal, row.id)
            } catch {}
          }
        }
      } catch {}
    }
  } finally { db.close() }

  for (const extra of options.worktreePaths ?? []) {
    try {
      const real = realpathSync(extra)
      if (!candidates.has(real)) candidates.set(real, options.repositoryId)
    } catch {}
  }

  const items: LegacyCutoverItem[] = []
  let hasConflict = false
  for (const [checkoutRoot, repoId] of candidates) {
    const configFile = join(checkoutRoot, '.codex', 'hooks.json')
    const bindingFile = nativeBindingPath(checkoutRoot, 'codex')
    const snapshotFile = join(dirname(bindingFile), 'installation.json')
    if (!existsSync(configFile)) {
      items.push({ path: checkoutRoot, repositoryId: repoId, state: 'CLEAN', reasonCode: 'NO_PROJECT_HOOKS' })
      continue
    }
    try {
      const configText = boundedFile(configFile, MAX_HOOK_CONFIG_BYTES)
      const parsed = parseCodexConfig(configText)
      const hasOwnRef = Object.values(parsed.hooks).some(groups => groups.some(group =>
        group.hooks.some(hook => typeof hook.command === 'string' && /native-hook(?:-[a-f0-9]{64})?\.cjs/.test(hook.command))))
      if (!hasOwnRef && !existsSync(snapshotFile)) {
        items.push({ path: checkoutRoot, repositoryId: repoId, state: 'CLEAN', reasonCode: 'THIRD_PARTY_ONLY' })
        continue
      }
      if (!existsSync(snapshotFile)) {
        hasConflict = true
        items.push({ path: checkoutRoot, repositoryId: repoId, state: 'CONFLICT', reasonCode: 'INSTALLATION_SNAPSHOT_MISSING' })
        continue
      }
      const snapshotRaw = JSON.parse(boundedFile(snapshotFile, MAX_SNAPSHOT_BYTES)) as { schema?: number }
      if (snapshotRaw.schema === 3) {
        items.push({ path: checkoutRoot, repositoryId: repoId, state: 'CLEAN', reasonCode: 'SHARED_SNAPSHOT_NO_LOCAL_MANIFEST' })
        continue
      }
      const state = readInstallation(checkoutRoot, undefined, undefined, 'codex')
      if (!state) {
        hasConflict = true
        items.push({ path: checkoutRoot, repositoryId: repoId, state: 'CONFLICT', reasonCode: 'INSTALLATION_OWNERSHIP_UNPROVEN' })
        continue
      }
      const restore = rollbackBase(state)
      if (restore !== null) parseCodexConfig(restore)
      const configRev = state.revisions.get(configFile)!
      const snapshotRev = state.revisions.get(snapshotFile)!
      const bindingRev = state.revisions.get(bindingFile)!
      const verifyOwner = verifyConfigWriteOwnership([
        configFile,
        snapshotFile,
        ...(bindingRev.content !== null ? [bindingFile] : [])
      ], 5000)
      if (restore === null) removeConfig(configFile, checkoutRoot, configRev, verifyOwner)
      else writeConfig(configFile, checkoutRoot, configRev, restore, undefined, undefined, verifyOwner)

      if (bindingRev.content !== null) {
        const currentBinding = readNativeBinding(bindingFile)
        const nextBinding: NativeHookBinding = {
          ...currentBinding,
          scope: 'USER',
          configPath: options.userConfigPath,
          enabled: true
        }
        writeConfig(bindingFile, checkoutRoot, bindingRev, JSON.stringify(nextBinding), undefined, undefined, verifyOwner)
      }
      removeConfig(snapshotFile, checkoutRoot, snapshotRev, verifyOwner)
      items.push({ path: checkoutRoot, repositoryId: repoId, state: 'REMOVED', reasonCode: 'CUTOVER_CLEANED', restored: restore === state.snapshot.before })
    } catch (error) {
      hasConflict = true
      const reasonCode = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'CUTOVER_CONFLICT'
      items.push({ path: checkoutRoot, repositoryId: repoId, state: 'CONFLICT', reasonCode })
    }
  }
  return { state: hasConflict ? 'DEFERRED' : 'COMPLETED', items }
}

export function bootstrapUserCodexWorktreeBinding(options: {
  profile: string
  repositoryId: string
  root: string
  configPath: string
  gitCommitTool?: string
  helperDigest: string
}): { state: 'CONFIGURED' | 'NO_CHANGE'; binding: NativeHookBinding } {
  const realRoot = realpathSync(resolve(options.root))
  const bindingPath = nativeBindingPath(realRoot, 'codex')
  const spool = join(dirname(bindingPath), 'spool')
  const wt = nativeWorktreeIdentity(realRoot, true)
  const headText = boundedFile(join(wt.admin, 'HEAD'), 4096).trim()
  if (!headText) throw new Error('WORKTREE_STALE')
  const worktreeId = wt.worktreeId(options.repositoryId)
  const binding: NativeHookBinding = {
    schema: 1,
    scope: 'USER',
    enabled: true,
    repositoryId: options.repositoryId,
    worktreeId,
    generation: wt.generation,
    root: wt.root,
    commonDirectory: wt.commonDirectory,
    directoryIdentity: wt.directoryIdentity,
    spool,
    configPath: options.configPath,
    ...(options.gitCommitTool ? { gitCommitTool: options.gitCommitTool } : {})
  }

  assertProfilePath(bindingPath, realRoot)
  const existingRev = revision(bindingPath)
  if (existingRev.content !== null) {
    try {
      const existing = readNativeBinding(bindingPath)
      if (!existing.enabled && existing.generation === wt.generation && existing.worktreeId === worktreeId) {
        throw new Error('NATIVE_CAPTURE_DISABLED')
      }
      if (sameHookValue(existing, binding)) {
        const db = openNativeHookCatalog(options.profile, true)
        try {
          const profileRow = readUserCodexProfile(db, 'codex')
          const enrollment = readNativeEnrollment(db, options.repositoryId, 'codex')
          if (!profileRow?.enabled || profileRow.helperDigest !== options.helperDigest || !enrollment ||
            enrollment.commonDirectory !== wt.commonDirectory || enrollment.worktrees[worktreeId] !== wt.generation) {
            throw new Error('HOOK_ENROLLMENT_REQUIRED')
          }
          return { state: 'NO_CHANGE', binding: existing }
        } finally { db.close() }
      }
    } catch (error) {
      if (error instanceof Error && (error.message === 'NATIVE_CAPTURE_DISABLED' || error.message === 'HOOK_ENROLLMENT_REQUIRED')) throw error
    }
  }

  const db = openNativeHookCatalog(options.profile, false)
  try {
    db.exec('BEGIN IMMEDIATE')
    const key = `native-hooks:${options.repositoryId}:codex`
    const profileRow = readUserCodexProfile(db, 'codex')
    const enrollment = readNativeEnrollment(db, options.repositoryId, 'codex')
    if (!profileRow?.enabled || profileRow.helperDigest !== options.helperDigest || !enrollment ||
      !enrollment.externalPreparation || enrollment.commonDirectory !== wt.commonDirectory ||
      (enrollment.helperDigest !== undefined && enrollment.helperDigest !== options.helperDigest)) {
      throw new Error('HOOK_ENROLLMENT_REQUIRED')
    }
    prepareNativeSpool(spool)
    const verifyFastNoShell = () => {}
    writeConfig(bindingPath, realRoot, existingRev, JSON.stringify(binding), () => {
      assertProfilePath(bindingPath, realRoot)
    }, undefined, verifyFastNoShell)
    const nextEnrollment = {
      ...enrollment,
      scope: 'USER' as const,
      worktrees: { ...enrollment.worktrees, [worktreeId]: wt.generation }
    }
    db.prepare('INSERT INTO repository_catalog_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, JSON.stringify(nextEnrollment))
    db.exec('COMMIT')
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw error
  } finally {
    db.close()
  }
  return { state: 'CONFIGURED', binding }
}
