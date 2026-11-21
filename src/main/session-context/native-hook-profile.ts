import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { isQualifiedCodexHookVersion } from '../../shared/native-hook-preflight.cjs'
import { stableDestination } from '../../shared/local-mcp-installation.cjs'
import { assertProfilePath, assertRevision, revision, verifyConfigWriteOwnership, writeConfig, removeConfig, type FileRevision } from '../local-mcp-clients/safe-config-file'
import {
  ANTIGRAVITY_HOOK_NAME,
  antigravityFlatEvents,
  antigravityReferencesBinding,
  composeNativeHooks,
  isPlainHookObject,
  ownedCommandPaths,
  parseAntigravityConfig,
  parseAntigravityUserCommand,
  parseCodexConfig,
  readInstallation,
  rollbackBase,
  sameHookValue,
  type NativeInstallationInspection,
  type OwnedHook
} from './native-hook-installation'
import {
  antigravityHookEvents,
  boundedFile,
  codexHookEvents,
  nativeBindingPath,
  nativeDigest,
  nativeGitCommitToolPattern,
  nativeGitIdentity,
  nativeWorktreeIdentity,
  prepareNativeSpool,
  readNativeBinding,
  sameNativePath,
  type NativeHookBinding,
  type NativeHookEvent,
  type NativeHookProvider
} from './native-hooks'
import { openNativeHookCatalog, readNativeEnrollment, readUserHookProfile } from './native-hook-catalog'

const MAX_HOOK_CONFIG_BYTES = 65536
const MAX_SNAPSHOT_BYTES = 512 * 1024
const helperNamePattern = /^native-hook-([a-f0-9]{64})\.cjs$/

export interface DiscoveredCodexClient {
  path: string
  origin: 'EXPLICIT' | 'DESKTOP' | 'CLI' | 'PATH'
  version: string | null
  qualified: boolean
  reasonCode: string
  surface?: 'IDE' | 'CLI'
}

export type DiscoveredAntigravityClient = DiscoveredCodexClient

export interface UserHookSnapshot {
  schema: 4
  provider: NativeHookProvider
  scope: 'USER'
  codexHome?: string
  configHome?: string
  path: string
  before: string | null
  rollbackBase?: string | null
  installedDigest: string
  owned: OwnedHook
  previousOwned?: OwnedHook
  ownedByEvent?: Partial<Record<NativeHookEvent, OwnedHook>>
  previousOwnedByEvent?: Partial<Record<NativeHookEvent, OwnedHook>>
  cmdWrapperPath?: string
  helperPath: string
  helperDigest: string
  nodePath: string
  runAsNode?: boolean
  clientPath?: string
  clientVersion?: string
  enabled: boolean
  updatedAt: string
}

export type HelperBundleKind = 'PORTABLE' | 'CHECKOUT'

export interface RuntimeHelperBundleOptions {
  packaged: boolean
  appPath: string
  resourcesPath?: string
}

export interface CapturedHelperBundleSource {
  kind: HelperBundleKind
  status: 'CAPTURED' | 'UNAVAILABLE'
  digest?: string
  sourcePath?: string
  statKey?: string
}

export interface CapturedRuntimeHelperState {
  portable: CapturedHelperBundleSource
  checkout: CapturedHelperBundleSource
}

export interface RuntimeHelperExpectation {
  state: 'AVAILABLE' | 'RUNTIME_SOURCE_STALE' | 'UNAVAILABLE'
  reasonCode: 'HELPER_BUNDLE_AVAILABLE' | 'RUNTIME_SOURCE_STALE' | 'HOOK_HELPER_UNAVAILABLE'
  expectedDigest?: string
}

export interface UserCodexInstallationInspection extends NativeInstallationInspection {
  codexHome: string
  configHome: string
  configPath: string
  snapshotPath: string
  enabled: boolean
  scope?: 'USER' | 'CHECKOUT'
  helperKind?: HelperBundleKind
  helperPath?: string
  helperDigest?: string
  nodePath?: string
  runAsNode?: boolean
  clientPath?: string
  clientVersion?: string
}

function resolveSafeHomeDir(explicit: string | undefined, envVar: string | undefined, defaultJoin: string): string {
  const raw = explicit !== undefined ? explicit : envVar
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
  const fallback = resolve(defaultJoin)
  if (existsSync(fallback)) {
    const stat = lstatSync(fallback)
    if (stat.isSymbolicLink() || !stat.isDirectory() || !sameNativePath(realpathSync(fallback), fallback)) {
      throw new Error('UNSAFE_HOOK_DIRECTORY')
    }
  }
  return fallback
}

export function resolveCodexHome(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  return resolveSafeHomeDir(explicit, env.CODEX_HOME, join(homedir(), '.codex'))
}

export function resolveAntigravityConfigHome(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  return resolveSafeHomeDir(explicit, env.ANTIGRAVITY_CONFIG_HOME, join(homedir(), '.gemini', 'config'))
}

export function userHookSnapshotPath(profile: string, provider: NativeHookProvider = 'codex'): string {
  const file = provider === 'antigravity' ? 'antigravity-user-hooks.json' : 'codex-user-hooks.json'
  return join(resolve(profile), 'session-context', file)
}

export function userHelperPath(profile: string, helperDigest: string): string {
  return join(resolve(profile), 'session-context', `native-hook-${helperDigest}.cjs`)
}

export function antigravityCmdWrapperPath(profile: string, digest: string): string {
  return join(resolve(profile), 'session-context', `ag-${digest}.cmd`)
}

export function buildAntigravityCmdWrapperContent(nodePath: string, helperPath: string, runAsNode = false): string {
  if (/["\r\n]/.test(nodePath) || /["\r\n]/.test(helperPath)) throw new Error('INVALID_HOOK_COMMAND')
  return `${runAsNode ? '@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n' : '@echo off\r\n'}"${nodePath}" "${helperPath}"\r\n`
}

export function needsAntigravityCmdWrapper(nodePath: string, platform = process.platform): boolean {
  return platform === 'win32' && /\s/.test(basename(nodePath))
}

export function formatUserAntigravityHookCommand(options: {
  nodePath: string
  helperPath: string
  event: NativeHookEvent
  runAsNode?: boolean
  platform?: NodeJS.Platform
  cmdWrapperPath?: string
}): OwnedHook {
  const { nodePath, helperPath, event, runAsNode = false, platform = process.platform, cmdWrapperPath } = options
  if (!(antigravityHookEvents as readonly NativeHookEvent[]).includes(event)) throw new Error('INVALID_HOOK_COMMAND')
  if (/["\r\n]/.test(nodePath) || /["\r\n]/.test(helperPath)) throw new Error('INVALID_HOOK_COMMAND')
  if (platform === 'win32') {
    if (needsAntigravityCmdWrapper(nodePath, platform)) {
      if (!cmdWrapperPath || !/^ag-[a-f0-9]{64}\.cmd$/.test(basename(cmdWrapperPath)) ||
        /["\r\n&|<>^%;]/.test(dirname(cmdWrapperPath))) {
        throw new Error('INVALID_HOOK_COMMAND')
      }
      const command = `set PATH=${dirname(cmdWrapperPath)};%PATH%&& set CA_PROVIDER=antigravity&& set CA_EVENT=${event}&& set CA_USER_PROFILE=1&& ${basename(cmdWrapperPath)}`
      return { type: 'command', command, timeout: 3 }
    }
    const dir = dirname(nodePath)
    const bin = basename(nodePath)
    if (/["\r\n&|<>^%;]/.test(dir + helperPath) || /[\s"\r\n&|<>^%;\\/:]/.test(bin)) {
      throw new Error('INVALID_HOOK_COMMAND')
    }
    const prefix = runAsNode ? 'set ELECTRON_RUN_AS_NODE=1&& ' : ''
    const command = `${prefix}set PATH=${dir};%PATH%&& set CA_SCRIPT=${helperPath}&& set CA_PROVIDER=antigravity&& set CA_EVENT=${event}&& set CA_USER_PROFILE=1&& ${bin} -e require(process.env.CA_SCRIPT)`
    return { type: 'command', command, timeout: 3 }
  }
  if (runAsNode && /[&|<>^%;'\r\n]/.test(nodePath + helperPath)) throw new Error('INVALID_HOOK_COMMAND')
  const quoted = `"${nodePath}" "${helperPath}" --user-profile --provider=antigravity --event=${event}`
  const command = runAsNode ? `ELECTRON_RUN_AS_NODE=1 ${quoted}` : quoted
  return { type: 'command', command, timeout: 3 }
}

export function formatUserAntigravityHookCommands(options: {
  nodePath: string
  helperPath: string
  runAsNode?: boolean
  platform?: NodeJS.Platform
  cmdWrapperPath?: string
}): Partial<Record<NativeHookEvent, OwnedHook>> {
  const result: Partial<Record<NativeHookEvent, OwnedHook>> = {}
  for (const event of antigravityHookEvents) {
    result[event] = formatUserAntigravityHookCommand({ ...options, event })
  }
  return result
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

export function portableHelperCandidatePaths(
  options: RuntimeHelperBundleOptions,
  kind: HelperBundleKind = 'PORTABLE'
): string[] {
  const filename = kind === 'PORTABLE' ? 'native-hook-portable.cjs' : 'native-hook.cjs'
  return options.packaged && options.resourcesPath
    ? [
        join(options.resourcesPath, 'app.asar.unpacked', 'out', 'session-context', filename),
        join(options.appPath, 'out', 'session-context', filename)
      ]
    : [join(options.appPath, 'out', 'session-context', filename)]
}

function bundleStatKey(path: string): string {
  const stat = lstatSync(path, { bigint: true })
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
}

function captureBundleKind(
  options: RuntimeHelperBundleOptions,
  kind: HelperBundleKind
): CapturedHelperBundleSource {
  for (const candidate of portableHelperCandidatePaths(options, kind)) {
    try {
      if (existsSync(candidate) && lstatSync(candidate).isFile()) {
        const statKey = bundleStatKey(candidate)
        const content = boundedFile(candidate, MAX_SNAPSHOT_BYTES)
        return { kind, status: 'CAPTURED', digest: nativeDigest(content), sourcePath: candidate, statKey }
      }
    } catch {}
  }
  return { kind, status: 'UNAVAILABLE' }
}

export function captureRuntimeHelperSource(options: RuntimeHelperBundleOptions): CapturedRuntimeHelperState {
  return {
    portable: captureBundleKind(options, 'PORTABLE'),
    checkout: captureBundleKind(options, 'CHECKOUT')
  }
}

export function resolveRuntimeHelperExpectation(
  kind: HelperBundleKind,
  captured?: CapturedRuntimeHelperState,
  fallbackOptions?: RuntimeHelperBundleOptions
): RuntimeHelperExpectation {
  if (captured) {
    const entry = kind === 'CHECKOUT' ? captured.checkout : captured.portable
    if (entry.status !== 'CAPTURED' || !entry.sourcePath || !entry.digest || !entry.statKey) {
      return { state: 'UNAVAILABLE', reasonCode: 'HOOK_HELPER_UNAVAILABLE' }
    }
    try {
      const stat = lstatSync(entry.sourcePath, { bigint: true })
      if (!stat.isFile()) return { state: 'RUNTIME_SOURCE_STALE', reasonCode: 'RUNTIME_SOURCE_STALE' }
      const currentStatKey = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
      if (currentStatKey === entry.statKey) {
        return { state: 'AVAILABLE', reasonCode: 'HELPER_BUNDLE_AVAILABLE', expectedDigest: entry.digest }
      }
      const diskDigest = nativeDigest(boundedFile(entry.sourcePath, MAX_SNAPSHOT_BYTES))
      if (diskDigest !== entry.digest) {
        return { state: 'RUNTIME_SOURCE_STALE', reasonCode: 'RUNTIME_SOURCE_STALE' }
      }
      return { state: 'AVAILABLE', reasonCode: 'HELPER_BUNDLE_AVAILABLE', expectedDigest: entry.digest }
    } catch {
      return { state: 'RUNTIME_SOURCE_STALE', reasonCode: 'RUNTIME_SOURCE_STALE' }
    }
  }
  if (fallbackOptions) {
    const live = captureBundleKind(fallbackOptions, kind)
    if (live.status === 'CAPTURED' && live.digest) {
      return { state: 'AVAILABLE', reasonCode: 'HELPER_BUNDLE_AVAILABLE', expectedDigest: live.digest }
    }
  }
  return { state: 'UNAVAILABLE', reasonCode: 'HOOK_HELPER_UNAVAILABLE' }
}

export function resolvePortableHelperContent(options: { packaged: boolean; appPath: string; resourcesPath?: string }): string {
  for (const candidate of portableHelperCandidatePaths(options, 'PORTABLE')) {
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

function readAntigravityVersion(binaryPath: string): string | null {
  const dir = dirname(binaryPath)
  const versionFile = join(dir, 'version')
  if (existsSync(versionFile)) {
    try {
      const text = boundedFile(versionFile, 256).trim().split(/\r?\n/)[0]?.trim()
      if (text && /^[a-zA-Z0-9.+_-]{1,80}$/.test(text)) return text
    } catch {}
  }
  const pkgFile = join(dir, 'resources', 'app', 'package.json')
  if (existsSync(pkgFile)) {
    try {
      const parsed = JSON.parse(boundedFile(pkgFile, 32768)) as { version?: unknown }
      if (typeof parsed.version === 'string' && /^[a-zA-Z0-9.+_-]{1,80}$/.test(parsed.version.trim())) {
        return parsed.version.trim()
      }
    } catch {}
  }
  if (/^agy(?:\.exe)?$/i.test(basename(binaryPath)) || process.platform !== 'win32') {
    const output = execFileSync(binaryPath, ['--version'], {
      encoding: 'utf8', timeout: 2000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
    const first = output.split(/\r?\n/)[0]?.trim() ?? ''
    const match = /([0-9]+\.[0-9]+\.[0-9]+(?:[.+_-][a-zA-Z0-9.+_-]+)?)/.exec(first)
    if (match) return match[1]
  }
  return null
}

export function qualifyAntigravityBinary(
  path: string,
  origin: DiscoveredAntigravityClient['origin'] = 'EXPLICIT',
  surface?: 'IDE' | 'CLI'
): DiscoveredAntigravityClient {
  const name = /^(?:antigravity|agy)(?:\.exe)?$/i
  const inferredSurface: 'IDE' | 'CLI' = surface ?? (/^agy(?:\.exe)?$/i.test(basename(path)) ? 'CLI' : 'IDE')
  try {
    const resolved = resolve(path)
    const real = realpathSync(resolved)
    if (!isAbsolute(resolved) || !name.test(basename(resolved)) || !sameNativePath(real, resolved) || !lstatSync(real).isFile()) {
      return { path, origin, surface: inferredSurface, version: null, qualified: false, reasonCode: 'ANTIGRAVITY_EXECUTABLE_UNAVAILABLE' }
    }
    const version = readAntigravityVersion(real)
    if (!version) return { path: real, origin, surface: inferredSurface, version: null, qualified: false, reasonCode: 'ANTIGRAVITY_VERSION_UNAVAILABLE' }
    return { path: real, origin, surface: inferredSurface, version, qualified: true, reasonCode: 'QUALIFIED' }
  } catch {
    return { path, origin, surface: inferredSurface, version: null, qualified: false, reasonCode: 'ANTIGRAVITY_EXECUTABLE_UNAVAILABLE' }
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

export function discoverAntigravityClients(options: { explicit?: string; localAppData?: string; programFiles?: string; env?: NodeJS.ProcessEnv } = {}): DiscoveredAntigravityClient[] {
  const env = options.env ?? process.env
  const candidates: Array<{ path: string; origin: DiscoveredAntigravityClient['origin']; surface: 'IDE' | 'CLI' }> = []
  if (options.explicit) {
    const surface = /^agy(?:\.exe)?$/i.test(basename(options.explicit)) ? 'CLI' : 'IDE'
    candidates.push({ path: options.explicit, origin: 'EXPLICIT', surface })
  }
  if (process.platform === 'win32') {
    const localAppData = options.localAppData ?? env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
    const programFiles = options.programFiles ?? env.ProgramFiles ?? 'C:\\Program Files'
    for (const desktopExe of [
      join(localAppData, 'Programs', 'Antigravity', 'Antigravity.exe'),
      join(programFiles, 'Antigravity', 'Antigravity.exe')
    ]) {
      if (existsSync(desktopExe)) candidates.push({ path: desktopExe, origin: 'DESKTOP', surface: 'IDE' })
    }
    for (const cliExe of [
      join(localAppData, 'agy', 'bin', 'agy.exe'),
      join(localAppData, 'Programs', 'Antigravity', 'bin', 'agy.exe')
    ]) {
      if (existsSync(cliExe)) candidates.push({ path: cliExe, origin: 'CLI', surface: 'CLI' })
    }
  } else if (process.platform === 'darwin') {
    const appBin = '/Applications/Antigravity.app/Contents/MacOS/Antigravity'
    if (existsSync(appBin)) candidates.push({ path: appBin, origin: 'DESKTOP', surface: 'IDE' })
  }
  const pathDirs = (env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean)
  for (const dir of pathDirs) {
    for (const bin of process.platform === 'win32' ? ['agy.exe', 'antigravity.exe'] : ['agy', 'antigravity']) {
      const candidate = join(dir, bin)
      if (existsSync(candidate)) candidates.push({ path: candidate, origin: 'PATH', surface: /^agy/i.test(bin) ? 'CLI' : 'IDE' })
    }
  }
  const seen = new Set<string>()
  const results: DiscoveredAntigravityClient[] = []
  for (const item of candidates) {
    const inspected = qualifyAntigravityBinary(item.path, item.origin, item.surface)
    const key = process.platform === 'win32' ? inspected.path.toLowerCase() : inspected.path
    if (seen.has(key)) continue
    seen.add(key)
    results.push(inspected)
  }
  return results
}

function resolveConfiguredProviderHome(
  provider: NativeHookProvider,
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  return provider === 'antigravity'
    ? resolveAntigravityConfigHome(explicit, env)
    : resolveCodexHome(explicit, env)
}

function checkUserProviderPaths(
  profile: string,
  configHome: string,
  provider: NativeHookProvider = 'codex'
): { snapshotPath: string; configPath: string } {
  const realProfile = realpathSync(resolve(profile))
  if (!sameNativePath(realProfile, resolve(profile))) throw new Error('OUTSIDE_USER_PROFILE')
  const snapshotPath = userHookSnapshotPath(realProfile, provider)
  const configPath = join(configHome, 'hooks.json')
  assertProfilePath(snapshotPath, realProfile)
  assertProfilePath(configPath, configHome)
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

function validateUserCmdWrapper(wrapperPath: string): string {
  const match = /^ag-([a-f0-9]{64})\.cmd$/.exec(basename(wrapperPath))
  if (!match) throw new Error('HOOK_COMMAND_DIGEST_MISMATCH')
  if (!existsSync(wrapperPath) || !lstatSync(wrapperPath).isFile() || lstatSync(wrapperPath).nlink !== 1 ||
    !sameNativePath(realpathSync(wrapperPath), resolve(wrapperPath))) {
    throw new Error('HOOK_PATH_UNAVAILABLE')
  }
  if (nativeDigest(boundedFile(wrapperPath, 8192)) !== match[1]) {
    throw new Error('HOOK_COMMAND_DIGEST_MISMATCH')
  }
  return match[1]
}

function validateSnapshot(
  snapshotPath: string,
  expectedConfigPath: string,
  expectedProvider: NativeHookProvider = 'codex'
): UserHookSnapshot {
  const text = boundedFile(snapshotPath, MAX_SNAPSHOT_BYTES)
  const parsed = JSON.parse(text) as Partial<UserHookSnapshot>
  const home = parsed.configHome ?? parsed.codexHome
  if (!isPlainHookObject(parsed) || parsed.schema !== 4 || parsed.provider !== expectedProvider || parsed.scope !== 'USER' ||
    typeof home !== 'string' || !home || typeof parsed.path !== 'string' || !sameNativePath(parsed.path, expectedConfigPath) ||
    (parsed.before !== null && typeof parsed.before !== 'string') ||
    (parsed.rollbackBase !== undefined && parsed.rollbackBase !== null && typeof parsed.rollbackBase !== 'string') ||
    typeof parsed.installedDigest !== 'string' || !/^[a-f0-9]{64}$/.test(parsed.installedDigest) ||
    typeof parsed.helperPath !== 'string' || typeof parsed.helperDigest !== 'string' || !/^[a-f0-9]{64}$/.test(parsed.helperDigest) ||
    typeof parsed.nodePath !== 'string' || typeof parsed.enabled !== 'boolean' || !isPlainHookObject(parsed.owned) ||
    (expectedProvider === 'antigravity' && !isPlainHookObject(parsed.ownedByEvent))) {
    throw new Error('INSTALLATION_SNAPSHOT_INVALID')
  }
  return parsed as UserHookSnapshot
}

function referencesUserHelper(command: string): boolean {
  const parsed = parseUserCodexCommand(command)
  if (parsed && helperNamePattern.test(basename(parsed.helperPath))) return true
  const agParsed = parseAntigravityUserCommand(command)
  if (agParsed) return true
  if (/\bag-[a-f0-9]{64}\.cmd\b/.test(command)) return true
  return /native-hook-[a-f0-9]{64}\.cjs/.test(command) && !command.includes('binding.json')
}

function cleanOwnedHandlersFromCodexConfig(
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

function cleanOwnedHandlersFromAntigravityConfig(
  configText: string | null,
  beforeText: string | null,
  ownershipMaps: Array<Partial<Record<NativeHookEvent, OwnedHook>>>
): { cleaned: string | null; removed: number } {
  const value = parseAntigravityConfig(configText)
  const before = parseAntigravityConfig(beforeText)
  const allOwnedCommands = new Set<string>()
  for (const map of ownershipMaps) {
    for (const item of Object.values(map)) {
      if (item?.command) allOwnedCommands.add(item.command)
    }
  }
  if (antigravityReferencesBinding(before, cmd => allOwnedCommands.has(cmd))) {
    throw new Error('INSTALLATION_OWNERSHIP_UNPROVEN')
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key !== ANTIGRAVITY_HOOK_NAME && antigravityReferencesBinding({ [key]: entry }, cmd => referencesUserHelper(cmd))) {
      throw new Error('NATIVE_HANDLER_CONFLICT')
    }
  }
  const rawGroup = value[ANTIGRAVITY_HOOK_NAME]
  if (rawGroup === undefined) return { cleaned: configText, removed: 0 }
  if (!isPlainHookObject(rawGroup)) throw new Error('HOOK_CONFIG_UNSUPPORTED')
  const group: Record<string, unknown> = { ...rawGroup }
  for (const [key, entries] of Object.entries(group)) {
    if (!antigravityHookEvents.includes(key as typeof antigravityHookEvents[number]) &&
      antigravityReferencesBinding({ [key]: entries }, cmd => referencesUserHelper(cmd))) {
      throw new Error('NATIVE_HANDLER_CONFLICT')
    }
  }
  let removed = 0
  for (const event of antigravityHookEvents) {
    const ownedForEvent = ownershipMaps.map(m => m[event]).filter((x): x is OwnedHook => Boolean(x))
    const counts = new Map<string, number>()
    if (antigravityFlatEvents.has(event)) {
      const items = (group[event] as Record<string, unknown>[] | undefined) ?? []
      const filtered = items.filter(hook => {
        const known = ownedForEvent.find(item => hook.command === item.command)
        if (!known) {
          if (typeof hook.command === 'string' && referencesUserHelper(hook.command)) throw new Error('NATIVE_HANDLER_CONFLICT')
          return true
        }
        const count = (counts.get(known.command) ?? 0) + 1
        counts.set(known.command, count)
        if (!sameHookValue(hook, known) || count > 1) throw new Error('NATIVE_HANDLER_CONFLICT')
        removed++
        return false
      })
      if (filtered.length) group[event] = filtered
      else delete group[event]
    } else {
      const groups = (group[event] as { matcher?: unknown; hooks: Record<string, unknown>[]; [key: string]: unknown }[] | undefined) ?? []
      const filteredGroups = groups.flatMap(entry => {
        const hooks = entry.hooks.filter(hook => {
          const known = ownedForEvent.find(item => hook.command === item.command)
          if (!known) {
            if (typeof hook.command === 'string' && referencesUserHelper(hook.command)) throw new Error('NATIVE_HANDLER_CONFLICT')
            return true
          }
          const count = (counts.get(known.command) ?? 0) + 1
          counts.set(known.command, count)
          if (!sameHookValue(hook, known) || entry.matcher !== '*' || count > 1) throw new Error('NATIVE_HANDLER_CONFLICT')
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
  const beforeGroup = isPlainHookObject(before[ANTIGRAVITY_HOOK_NAME]) ? before[ANTIGRAVITY_HOOK_NAME] as Record<string, unknown> : undefined
  if (!remainingKeys.length || (remainingKeys.length === 1 && remainingKeys[0] === 'enabled' && !beforeGroup)) {
    delete value[ANTIGRAVITY_HOOK_NAME]
  } else {
    value[ANTIGRAVITY_HOOK_NAME] = group
  }
  if (!removed) return { cleaned: configText, removed: 0 }
  if (beforeText === null && Object.keys(value).length === 0) {
    return { cleaned: null, removed }
  }
  return { cleaned: JSON.stringify(value, null, 2) + '\n', removed }
}

function composeUserAntigravityHooks(
  text: string | null,
  ownedByEvent: Partial<Record<NativeHookEvent, OwnedHook>>
): string {
  const value = parseAntigravityConfig(text)
  const existing = value[ANTIGRAVITY_HOOK_NAME]
  if (existing !== undefined && isPlainHookObject(existing) && 'enabled' in existing && existing.enabled !== true) {
    throw new Error('HOOK_CONFIG_UNSUPPORTED')
  }
  const group: Record<string, unknown> = existing !== undefined ? { ...(existing as Record<string, unknown>) } : { enabled: true }
  for (const event of antigravityHookEvents) {
    const owned = ownedByEvent[event]
    if (!owned) throw new Error('INVALID_HOOK_COMMAND')
    if (antigravityFlatEvents.has(event)) {
      const handlers = [...((group[event] as Record<string, unknown>[] | undefined) ?? [])]
      if (!handlers.some(hook => hook.command === owned.command)) handlers.push({ ...owned })
      group[event] = handlers
    } else {
      const groups = [...((group[event] as { matcher?: unknown; hooks: Record<string, unknown>[] }[] | undefined) ?? [])]
      if (!groups.some(entry => entry.matcher === '*' && entry.hooks.some(hook => hook.command === owned.command))) {
        groups.push({ matcher: '*', hooks: [{ ...owned }] })
      }
      group[event] = groups
    }
  }
  value[ANTIGRAVITY_HOOK_NAME] = group
  return JSON.stringify(value, null, 2) + '\n'
}

export function inspectUserHookInstallation(
  profile: string,
  provider: NativeHookProvider = 'codex',
  configHomeInput?: string,
  platform = process.platform
): UserCodexInstallationInspection {
  let configHome = ''
  let configPath = ''
  let snapshotPath = ''
  const expected: 7 | 6 = provider === 'antigravity' ? 6 : 7
  const result = (
    state: NativeInstallationInspection['state'],
    reasonCode: string,
    installed = 0,
    extra: Partial<UserCodexInstallationInspection> = {}
  ): UserCodexInstallationInspection => ({
    state, reasonCode, installed, expected, handlers: [], codexHome: configHome, configHome, configPath, snapshotPath, enabled: false, ...extra
  })
  try {
    let effectiveHome = configHomeInput
    const envVar = provider === 'antigravity' ? process.env.ANTIGRAVITY_CONFIG_HOME : process.env.CODEX_HOME
    if (effectiveHome === undefined && !envVar) {
      const existingSnapshot = userHookSnapshotPath(profile, provider)
      if (existsSync(existingSnapshot)) {
        try {
          const parsed = JSON.parse(boundedFile(existingSnapshot, MAX_SNAPSHOT_BYTES)) as { configHome?: unknown; codexHome?: unknown }
          const recorded = parsed.configHome ?? parsed.codexHome
          if (typeof recorded === 'string' && recorded.trim()) effectiveHome = recorded
        } catch {}
      }
    }
    configHome = resolveConfiguredProviderHome(provider, effectiveHome)
    const checked = checkUserProviderPaths(profile, configHome, provider)
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
          const raw = boundedFile(configPath, MAX_HOOK_CONFIG_BYTES)
          const hasUnowned = provider === 'antigravity'
            ? antigravityReferencesBinding(parseAntigravityConfig(raw), cmd => referencesUserHelper(cmd))
            : Object.values(parseCodexConfig(raw).hooks).some(groups => groups.some(group =>
                group.hooks.some(hook => typeof hook.command === 'string' && referencesUserHelper(hook.command))))
          if (hasUnowned) return { ...result('UNKNOWN', 'INSTALLATION_OWNERSHIP_UNPROVEN'), repairability: 'CONFLICT' }
        } catch {
          return { ...result('INCOMPATIBLE', 'HOOK_CONFIG_UNSUPPORTED'), repairability: 'CONFLICT' }
        }
      }
      return result('MISSING', 'NATIVE_CONFIG_MISSING')
    }
    const snapshot = validateSnapshot(snapshotPath, configPath, provider)
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
    const handlers: NativeInstallationInspection['handlers'] = []
    const validatedHelpers = new Set<string>()
    const validatedWrappers = new Set<string>()

    if (provider === 'antigravity') {
      const config = parseAntigravityConfig(text)
      const rawGroup = config[ANTIGRAVITY_HOOK_NAME]
      if (!isPlainHookObject(rawGroup)) {
        return result('INCOMPATIBLE', 'NATIVE_HANDLERS_MISSING', 0, {
          repairability: 'REPAIRABLE', enabled: true,
          helperPath: snapshot.helperPath, helperDigest: snapshot.helperDigest,
          nodePath: snapshot.nodePath, runAsNode: snapshot.runAsNode, clientPath: snapshot.clientPath, clientVersion: snapshot.clientVersion
        })
      }
      if ('enabled' in rawGroup && rawGroup.enabled !== true) {
        return result('INCOMPATIBLE', 'NATIVE_HANDLER_INCOMPATIBLE', 0, { enabled: true })
      }
      for (const event of antigravityHookEvents) {
        const matches: NativeInstallationInspection['handlers'] = []
        const snake = event.replace(/[A-Z]/g, (letter, offset) => (offset ? '_' : '') + letter.toLowerCase())
        const entries = rawGroup[event]
        if (Array.isArray(entries)) {
          const checkAgHook = (hook: Record<string, unknown>, key: string, matcher?: unknown): NativeCodexResultStop => {
            if ((hook.type !== undefined && hook.type !== 'command') || typeof hook.command !== 'string') return undefined
            const parsedCmd = parseAntigravityUserCommand(hook.command)
            if (parsedCmd?.cmdWrapperPath && snapshot.cmdWrapperPath && sameNativePath(parsedCmd.cmdWrapperPath, snapshot.cmdWrapperPath)) {
              if (parsedCmd.cmdWrapperUnavailable) return result('INCOMPATIBLE', 'HOOK_PATH_UNAVAILABLE', handlers.length, { enabled: true })
              if (parsedCmd.cmdWrapperDigestMismatch) return result('INCOMPATIBLE', 'HOOK_COMMAND_DIGEST_MISMATCH', handlers.length, { enabled: true })
            }
            if (!parsedCmd || !sameNativePath(parsedCmd.helperPath, snapshot.helperPath)) {
              if (referencesUserHelper(hook.command)) return { ...result('UNKNOWN', 'NATIVE_HANDLER_CONFLICT'), repairability: 'CONFLICT' }
              return undefined
            }
            if (parsedCmd.event !== event) return result('INCOMPATIBLE', 'NATIVE_HANDLER_INCOMPATIBLE', handlers.length, { enabled: true })
            if (!existsSync(parsedCmd.nodePath) || !lstatSync(parsedCmd.nodePath).isFile() ||
              !sameNativePath(realpathSync(parsedCmd.nodePath), resolve(parsedCmd.nodePath))) {
              return result('INCOMPATIBLE', 'HOOK_PATH_UNAVAILABLE', handlers.length, { enabled: true })
            }
            if (parsedCmd.cmdWrapperPath) {
              if (!validatedWrappers.has(parsedCmd.cmdWrapperPath)) {
                validateUserCmdWrapper(parsedCmd.cmdWrapperPath)
                validatedWrappers.add(parsedCmd.cmdWrapperPath)
              }
            }
            if (!validatedHelpers.has(parsedCmd.helperPath)) {
              const digest = validateUserHelper(parsedCmd.helperPath)
              if (digest !== snapshot.helperDigest) return result('INCOMPATIBLE', 'HOOK_COMMAND_DIGEST_MISMATCH', handlers.length, { enabled: true })
              validatedHelpers.add(parsedCmd.helperPath)
            }
            if ((matcher !== undefined && matcher !== '*') || hook.async === true || hook.timeout !== 3) {
              return result('INCOMPATIBLE', 'NATIVE_HANDLER_INCOMPATIBLE', handlers.length, { enabled: true })
            }
            const expectedHook = formatUserAntigravityHookCommand({
              nodePath: parsedCmd.nodePath,
              helperPath: parsedCmd.helperPath,
              event,
              runAsNode: parsedCmd.runAsNode,
              platform,
              cmdWrapperPath: parsedCmd.cmdWrapperPath
            })
            if (hook.command !== expectedHook.command) {
              return result('INCOMPATIBLE', platform === 'win32' ? 'WINDOWS_COMMAND_INCOMPATIBLE' : 'NATIVE_HANDLER_INCOMPATIBLE', handlers.length, { enabled: true })
            }
            matches.push({ key, event, sourcePath: configPath })
            return undefined
          }
          if (antigravityFlatEvents.has(event)) {
            for (const [handlerIndex, hook] of (entries as Record<string, unknown>[]).entries()) {
              if (!isPlainHookObject(hook)) continue
              const fail = checkAgHook(hook, `${configPath}:${ANTIGRAVITY_HOOK_NAME}:${snake}:${handlerIndex}`)
              if (fail) return fail
            }
          } else {
            for (const [groupIndex, entry] of (entries as Array<{ matcher?: unknown; hooks: Record<string, unknown>[] }>).entries()) {
              if (!isPlainHookObject(entry) || !Array.isArray(entry.hooks)) continue
              for (const [handlerIndex, hook] of entry.hooks.entries()) {
                if (!isPlainHookObject(hook)) continue
                const fail = checkAgHook(hook, `${configPath}:${ANTIGRAVITY_HOOK_NAME}:${snake}:${groupIndex}:${handlerIndex}`, entry.matcher)
                if (fail) return fail
              }
            }
          }
        }
        if (matches.length > 1) return { ...result('INCOMPATIBLE', 'NATIVE_HANDLER_AMBIGUOUS'), repairability: 'CONFLICT', enabled: true }
        handlers.push(...matches)
      }
      cleanOwnedHandlersFromAntigravityConfig(text, snapshot.before, [
        snapshot.ownedByEvent ?? {},
        ...(snapshot.previousOwnedByEvent ? [snapshot.previousOwnedByEvent] : [])
      ])
    } else {
      const config = parseCodexConfig(text)
      for (const event of codexHookEvents) {
        const matches: NativeInstallationInspection['handlers'] = []
        const snake = event.replace(/[A-Z]/g, (letter, offset) => (offset ? '_' : '') + letter.toLowerCase())
        const groups = config.hooks[event] ?? []
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
      cleanOwnedHandlersFromCodexConfig(text, snapshot.before, [snapshot.owned, ...(snapshot.previousOwned ? [snapshot.previousOwned] : [])])
    }

    if (handlers.length !== expected || snapshot.installedDigest !== nativeDigest(text)) {
      const reason = handlers.length !== expected ? 'NATIVE_HANDLERS_MISSING' : 'HOOK_CONFIG_DRIFT'
      return {
        ...result('INCOMPATIBLE', reason, handlers.length),
        repairability: 'REPAIRABLE', enabled: true, scope: 'USER', helperKind: 'PORTABLE',
        helperPath: snapshot.helperPath, helperDigest: snapshot.helperDigest,
        nodePath: snapshot.nodePath, runAsNode: snapshot.runAsNode, clientPath: snapshot.clientPath, clientVersion: snapshot.clientVersion
      }
    }
    return {
      state: 'CONFIGURED', reasonCode: 'USER_INSTALLATION_VERIFIED', digest: snapshot.installedDigest, installed: expected, expected, handlers,
      codexHome: configHome, configHome, configPath, snapshotPath, enabled: true, scope: 'USER', helperKind: 'PORTABLE',
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

type NativeCodexResultStop = UserCodexInstallationInspection | undefined

export function inspectUserCodexInstallation(
  profile: string,
  codexHomeInput?: string,
  platform = process.platform
): UserCodexInstallationInspection {
  return inspectUserHookInstallation(profile, 'codex', codexHomeInput, platform)
}

export function inspectUserAntigravityInstallation(
  profile: string,
  configHomeInput?: string,
  platform = process.platform
): UserCodexInstallationInspection {
  return inspectUserHookInstallation(profile, 'antigravity', configHomeInput, platform)
}

export interface InstallUserHooksResult {
  state: 'CONFIGURED' | 'NO_CHANGE'
  codexHome: string
  configHome: string
  configPath: string
  snapshotPath: string
  helperPath: string
  helperDigest: string
  cmdWrapperPath?: string
  hooksDigest: string
  trust: 'UNCHANGED' | 'REVIEW_REQUIRED'
}

export function installUserHookProfile(options: {
  provider?: NativeHookProvider
  profile: string
  codexHome?: string
  configHome?: string
  helperContent: string
  nodePath: string
  runAsNode?: boolean
  clientPath?: string
  clientVersion?: string
  authorized: boolean
  allowWorktreeRuntime?: boolean
}): InstallUserHooksResult {
  if (!options.authorized) throw new Error('HOOK_AUTHORIZATION_REQUIRED')
  const provider: NativeHookProvider = options.provider ?? 'codex'
  const profile = realpathSync(resolve(options.profile))
  if (!sameNativePath(profile, resolve(options.profile))) throw new Error('OUTSIDE_USER_PROFILE')
  const configHome = resolveConfiguredProviderHome(provider, options.configHome ?? options.codexHome)
  const { snapshotPath, configPath } = checkUserProviderPaths(profile, configHome, provider)
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

  let cmdWrapperPath: string | undefined
  let cmdWrapperContent: string | undefined
  let cmdWrapperRev: FileRevision | undefined
  let owned: OwnedHook
  let ownedByEvent: Partial<Record<NativeHookEvent, OwnedHook>> | undefined
  if (provider === 'antigravity') {
    if (needsAntigravityCmdWrapper(nodePath, process.platform)) {
      cmdWrapperContent = buildAntigravityCmdWrapperContent(nodePath, helperPath, runAsNode)
      const wrapperDigest = nativeDigest(cmdWrapperContent)
      cmdWrapperPath = antigravityCmdWrapperPath(profile, wrapperDigest)
      assertProfilePath(cmdWrapperPath, profile)
      cmdWrapperRev = revision(cmdWrapperPath)
      if (cmdWrapperRev.content !== null && nativeDigest(cmdWrapperRev.content) !== wrapperDigest) {
        throw new Error('HOOK_COMMAND_DIGEST_MISMATCH')
      }
    }
    ownedByEvent = formatUserAntigravityHookCommands({
      nodePath, helperPath, runAsNode, platform: process.platform, cmdWrapperPath
    })
    owned = ownedByEvent.SessionStart!
  } else {
    owned = formatUserCodexHookCommand(nodePath, helperPath, runAsNode)
  }

  const helperRev = revision(helperPath)
  if (helperRev.content !== null && nativeDigest(helperRev.content) !== helperDigest) {
    throw new Error('HOOK_COMMAND_DIGEST_MISMATCH')
  }
  const snapshotRev = revision(snapshotPath)
  const configRev = revision(configPath)
  if (configRev.content !== null && Buffer.byteLength(configRev.content) > MAX_HOOK_CONFIG_BYTES) throw new Error('HOOK_CONFIG_LIMIT')

  let priorSnapshot: UserHookSnapshot | undefined
  const checkUnowned = (raw: string) => provider === 'antigravity'
    ? antigravityReferencesBinding(parseAntigravityConfig(raw), cmd => referencesUserHelper(cmd))
    : Object.values(parseCodexConfig(raw).hooks).some(groups => groups.some(group =>
        group.hooks.some(hook => typeof hook.command === 'string' && referencesUserHelper(hook.command))))

  if (snapshotRev.content !== null) {
    const parsedRaw = JSON.parse(snapshotRev.content) as Partial<UserHookSnapshot>
    if (parsedRaw.enabled === false && typeof parsedRaw.path === 'string' && !sameNativePath(parsedRaw.path, configPath)) {
      validateSnapshot(snapshotPath, parsedRaw.path, provider)
      if (configRev.content !== null && checkUnowned(configRev.content)) throw new Error('INSTALLATION_OWNERSHIP_UNPROVEN')
    } else {
      priorSnapshot = validateSnapshot(snapshotPath, configPath, provider)
    }
  } else if (configRev.content !== null && checkUnowned(configRev.content)) {
    throw new Error('INSTALLATION_OWNERSHIP_UNPROVEN')
  }

  const currentInspection = inspectUserHookInstallation(profile, provider, configHome, process.platform)
  const ownershipSame = provider === 'antigravity'
    ? Boolean(priorSnapshot && sameHookValue(priorSnapshot.ownedByEvent, ownedByEvent))
    : Boolean(priorSnapshot && sameHookValue(priorSnapshot.owned, owned))
  const wrapperReady = !cmdWrapperPath || (cmdWrapperRev?.content === cmdWrapperContent)
  if (priorSnapshot && priorSnapshot.enabled && currentInspection.state === 'CONFIGURED' &&
    ownershipSame && priorSnapshot.helperDigest === helperDigest && wrapperReady &&
    configRev.content !== null && nativeDigest(configRev.content) === priorSnapshot.installedDigest &&
    helperRev.content === options.helperContent) {
    return {
      state: 'NO_CHANGE', codexHome: configHome, configHome, configPath, snapshotPath, helperPath, helperDigest,
      ...(cmdWrapperPath ? { cmdWrapperPath } : {}),
      hooksDigest: priorSnapshot.installedDigest, trust: 'UNCHANGED'
    }
  }

  const priorBefore = priorSnapshot ? priorSnapshot.before : configRev.content
  let base = configRev.content
  if (priorSnapshot) {
    if (configRev.content !== null && nativeDigest(configRev.content) === priorSnapshot.installedDigest) {
      if (priorSnapshot.rollbackBase !== undefined) {
        base = priorSnapshot.rollbackBase
      } else {
        base = provider === 'antigravity'
          ? cleanOwnedHandlersFromAntigravityConfig(configRev.content, priorBefore, [
              priorSnapshot.ownedByEvent ?? {},
              ...(priorSnapshot.previousOwnedByEvent ? [priorSnapshot.previousOwnedByEvent] : [])
            ]).cleaned
          : cleanOwnedHandlersFromCodexConfig(configRev.content, priorBefore, [
              priorSnapshot.owned,
              ...(priorSnapshot.previousOwned ? [priorSnapshot.previousOwned] : [])
            ]).cleaned
      }
    } else if (configRev.content !== null) {
      base = provider === 'antigravity'
        ? cleanOwnedHandlersFromAntigravityConfig(configRev.content, priorBefore, [
            priorSnapshot.ownedByEvent ?? {},
            ...(priorSnapshot.previousOwnedByEvent ? [priorSnapshot.previousOwnedByEvent] : [])
          ]).cleaned
        : cleanOwnedHandlersFromCodexConfig(configRev.content, priorBefore, [
            priorSnapshot.owned,
            ...(priorSnapshot.previousOwned ? [priorSnapshot.previousOwned] : [])
          ]).cleaned
    }
  }

  const after = provider === 'antigravity'
    ? composeUserAntigravityHooks(base, ownedByEvent!)
    : composeNativeHooks(base, owned.command, owned.commandWindows, 'codex')
  if (Buffer.byteLength(after) > MAX_HOOK_CONFIG_BYTES) throw new Error('HOOK_CONFIG_LIMIT')

  const nextSnapshot: UserHookSnapshot = {
    schema: 4,
    provider,
    scope: 'USER',
    ...(provider === 'codex' ? { codexHome: configHome } : {}),
    configHome,
    path: configPath,
    before: priorBefore,
    rollbackBase: base,
    installedDigest: nativeDigest(after),
    owned,
    ...(priorSnapshot && !sameHookValue(priorSnapshot.owned, owned) ? { previousOwned: priorSnapshot.owned } : {}),
    ...(ownedByEvent ? { ownedByEvent } : {}),
    ...(priorSnapshot && ownedByEvent && priorSnapshot.ownedByEvent && !sameHookValue(priorSnapshot.ownedByEvent, ownedByEvent)
      ? { previousOwnedByEvent: priorSnapshot.ownedByEvent }
      : {}),
    ...(cmdWrapperPath ? { cmdWrapperPath } : {}),
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
    ...(cmdWrapperPath && cmdWrapperRev ? [[cmdWrapperPath, cmdWrapperRev] as const] : []),
    [snapshotPath, snapshotRev],
    [configPath, configRev]
  ])
  const writeTargets = [
    ...(helperRev.content === null ? [helperPath] : []),
    ...(cmdWrapperPath && cmdWrapperRev?.content === null ? [cmdWrapperPath] : []),
    snapshotPath,
    configPath
  ]
  const verifyOwner = verifyConfigWriteOwnership(writeTargets, 5000)
  const checkAll = () => {
    checkUserProviderPaths(profile, configHome, provider)
    for (const [p, expectedRev] of revisions) {
      assertProfilePath(p, sameNativePath(p, configPath) ? configHome : profile)
      assertRevision(p, expectedRev)
    }
  }

  if (helperRev.content === null) {
    writeConfig(helperPath, profile, helperRev, options.helperContent, checkAll, undefined, verifyOwner)
    revisions.set(helperPath, revision(helperPath))
  }
  if (cmdWrapperPath && cmdWrapperContent && cmdWrapperRev?.content === null) {
    writeConfig(cmdWrapperPath, profile, cmdWrapperRev, cmdWrapperContent, checkAll, undefined, verifyOwner)
    revisions.set(cmdWrapperPath, revision(cmdWrapperPath))
  }
  writeConfig(snapshotPath, profile, snapshotRev, JSON.stringify(nextSnapshot, null, 2) + '\n', checkAll, undefined, verifyOwner)
  revisions.set(snapshotPath, revision(snapshotPath))
  writeConfig(configPath, configHome, configRev, after, checkAll, undefined, verifyOwner)
  revisions.set(configPath, revision(configPath))
  if (nextSnapshot.previousOwned || nextSnapshot.previousOwnedByEvent) {
    delete nextSnapshot.previousOwned
    delete nextSnapshot.previousOwnedByEvent
    writeConfig(snapshotPath, profile, revisions.get(snapshotPath)!, JSON.stringify(nextSnapshot, null, 2) + '\n', checkAll)
  }

  return {
    state: 'CONFIGURED', codexHome: configHome, configHome, configPath, snapshotPath, helperPath, helperDigest,
    ...(cmdWrapperPath ? { cmdWrapperPath } : {}),
    hooksDigest: nextSnapshot.installedDigest, trust: 'REVIEW_REQUIRED'
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
}): InstallUserHooksResult {
  return installUserHookProfile({ ...options, provider: 'codex' })
}

export function installUserAntigravityHooks(options: {
  profile: string
  configHome?: string
  helperContent: string
  nodePath: string
  runAsNode?: boolean
  clientPath?: string
  clientVersion?: string
  authorized: boolean
  allowWorktreeRuntime?: boolean
}): InstallUserHooksResult {
  return installUserHookProfile({ ...options, provider: 'antigravity' })
}

export function disableUserHookProfile(
  profileInput: string,
  authorized: boolean,
  provider: NativeHookProvider = 'codex',
  configHomeInput?: string
): {
  state: 'DISABLED'
  restored: boolean
  codexHome: string
  configHome: string
  configPath: string
} {
  if (!authorized) throw new Error('HOOK_AUTHORIZATION_REQUIRED')
  const profile = realpathSync(resolve(profileInput))
  let effectiveHome = configHomeInput
  const envVar = provider === 'antigravity' ? process.env.ANTIGRAVITY_CONFIG_HOME : process.env.CODEX_HOME
  if (effectiveHome === undefined && !envVar) {
    const existingSnapshot = userHookSnapshotPath(profile, provider)
    if (existsSync(existingSnapshot)) {
      try {
        const parsed = JSON.parse(boundedFile(existingSnapshot, MAX_SNAPSHOT_BYTES)) as { configHome?: unknown; codexHome?: unknown }
        const recorded = parsed.configHome ?? parsed.codexHome
        if (typeof recorded === 'string' && recorded.trim()) effectiveHome = recorded
      } catch {}
    }
  }
  const configHome = resolveConfiguredProviderHome(provider, effectiveHome)
  const { snapshotPath, configPath } = checkUserProviderPaths(profile, configHome, provider)
  const snapshotRev = revision(snapshotPath)
  if (snapshotRev.content === null) throw new Error('INSTALLATION_SNAPSHOT_MISSING')
  const snapshot = validateSnapshot(snapshotPath, configPath, provider)
  const configRev = revision(configPath)
  const cleanedResult = configRev.content === null
    ? { cleaned: null, removed: 0 }
    : provider === 'antigravity'
      ? cleanOwnedHandlersFromAntigravityConfig(configRev.content, snapshot.before, [
          snapshot.ownedByEvent ?? {},
          ...(snapshot.previousOwnedByEvent ? [snapshot.previousOwnedByEvent] : [])
        ])
      : cleanOwnedHandlersFromCodexConfig(configRev.content, snapshot.before, [
          snapshot.owned,
          ...(snapshot.previousOwned ? [snapshot.previousOwned] : [])
        ])
  if (!snapshot.enabled && cleanedResult.removed === 0) {
    return { state: 'DISABLED', restored: configRev.content === snapshot.before, codexHome: configHome, configHome, configPath }
  }
  const exactInstalled = configRev.content !== null && nativeDigest(configRev.content) === snapshot.installedDigest
  const restore = exactInstalled
    ? (snapshot.rollbackBase !== undefined ? snapshot.rollbackBase : cleanedResult.cleaned)
    : cleanedResult.cleaned
  if (restore !== null) {
    if (provider === 'antigravity') parseAntigravityConfig(restore)
    else parseCodexConfig(restore)
  }
  const verifyOwner = verifyConfigWriteOwnership([snapshotPath, configPath], 5000)
  const nextSnapshot: UserHookSnapshot = { ...snapshot, enabled: false, updatedAt: new Date().toISOString() }
  delete nextSnapshot.previousOwned
  delete nextSnapshot.previousOwnedByEvent
  writeConfig(snapshotPath, profile, snapshotRev, JSON.stringify(nextSnapshot, null, 2) + '\n', undefined, undefined, verifyOwner)
  if (restore === null) removeConfig(configPath, configHome, configRev, verifyOwner)
  else writeConfig(configPath, configHome, configRev, restore, undefined, undefined, verifyOwner)
  return { state: 'DISABLED', restored: restore === snapshot.before, codexHome: configHome, configHome, configPath }
}

export function disableUserCodexHooks(profileInput: string, authorized: boolean, codexHomeInput?: string) {
  return disableUserHookProfile(profileInput, authorized, 'codex', codexHomeInput)
}

export function disableUserAntigravityHooks(profileInput: string, authorized: boolean, configHomeInput?: string) {
  return disableUserHookProfile(profileInput, authorized, 'antigravity', configHomeInput)
}

export interface LegacyCutoverItem {
  path: string
  repositoryId?: string
  state: 'CLEAN' | 'REMOVED' | 'CONFLICT'
  reasonCode: string
  restored?: boolean
}

export function cutoverLegacyProjectHooks(options: {
  provider?: NativeHookProvider
  profile: string
  userConfigPath: string
  repositoryId?: string
  worktreePaths?: string[]
  authorized: boolean
}): { state: 'COMPLETED' | 'DEFERRED'; items: LegacyCutoverItem[] } {
  if (!options.authorized) throw new Error('HOOK_AUTHORIZATION_REQUIRED')
  const provider: NativeHookProvider = options.provider ?? 'codex'
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
        const enrollment = readNativeEnrollment(db, row.id, provider)
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
    const configFile = provider === 'antigravity' ? join(checkoutRoot, '.agents', 'hooks.json') : join(checkoutRoot, '.codex', 'hooks.json')
    const bindingFile = nativeBindingPath(checkoutRoot, provider)
    const snapshotFile = join(dirname(bindingFile), 'installation.json')
    if (!existsSync(configFile)) {
      items.push({ path: checkoutRoot, repositoryId: repoId, state: 'CLEAN', reasonCode: 'NO_PROJECT_HOOKS' })
      continue
    }
    try {
      const configText = boundedFile(configFile, MAX_HOOK_CONFIG_BYTES)
      const hasOwnRef = provider === 'antigravity'
        ? antigravityReferencesBinding(parseAntigravityConfig(configText), cmd => /native-hook(?:-[a-f0-9]{64})?\.cjs/.test(cmd))
        : Object.values(parseCodexConfig(configText).hooks).some(groups => groups.some(group =>
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
      const state = readInstallation(checkoutRoot, undefined, undefined, provider)
      if (!state) {
        hasConflict = true
        items.push({ path: checkoutRoot, repositoryId: repoId, state: 'CONFLICT', reasonCode: 'INSTALLATION_OWNERSHIP_UNPROVEN' })
        continue
      }
      const restore = rollbackBase(state)
      if (restore !== null) {
        if (provider === 'antigravity') parseAntigravityConfig(restore)
        else parseCodexConfig(restore)
      }
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
          ...(provider !== 'codex' ? { provider } : {}),
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

export function cutoverLegacyProjectCodexHooks(options: {
  profile: string
  userConfigPath: string
  repositoryId?: string
  worktreePaths?: string[]
  authorized: boolean
}): { state: 'COMPLETED' | 'DEFERRED'; items: LegacyCutoverItem[] } {
  return cutoverLegacyProjectHooks({ ...options, provider: 'codex' })
}

export function cutoverLegacyProjectAntigravityHooks(options: {
  profile: string
  userConfigPath: string
  repositoryId?: string
  worktreePaths?: string[]
  authorized: boolean
}): { state: 'COMPLETED' | 'DEFERRED'; items: LegacyCutoverItem[] } {
  return cutoverLegacyProjectHooks({ ...options, provider: 'antigravity' })
}

export function bootstrapUserWorktreeBinding(options: {
  provider?: NativeHookProvider
  profile: string
  repositoryId: string
  root: string
  configPath: string
  gitCommitTool?: string
  helperDigest: string
}): { state: 'CONFIGURED' | 'NO_CHANGE'; binding: NativeHookBinding } {
  const provider: NativeHookProvider = options.provider ?? 'codex'
  const realRoot = realpathSync(resolve(options.root))
  const bindingPath = nativeBindingPath(realRoot, provider)
  const spool = join(dirname(bindingPath), 'spool')
  const wt = nativeWorktreeIdentity(realRoot, true)
  const headText = boundedFile(join(wt.admin, 'HEAD'), 4096).trim()
  if (!headText) throw new Error('WORKTREE_STALE')
  const worktreeId = wt.worktreeId(options.repositoryId)
  const binding: NativeHookBinding = {
    schema: 1,
    ...(provider !== 'codex' ? { provider } : {}),
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
    ...(provider === 'codex' && options.gitCommitTool ? { gitCommitTool: options.gitCommitTool } : {})
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
          const profileRow = readUserHookProfile(db, provider)
          const enrollment = readNativeEnrollment(db, options.repositoryId, provider)
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
    const key = `native-hooks:${options.repositoryId}:${provider}`
    const profileRow = readUserHookProfile(db, provider)
    const enrollment = readNativeEnrollment(db, options.repositoryId, provider)
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

export function bootstrapUserCodexWorktreeBinding(options: {
  profile: string
  repositoryId: string
  root: string
  configPath: string
  gitCommitTool?: string
  helperDigest: string
}): { state: 'CONFIGURED' | 'NO_CHANGE'; binding: NativeHookBinding } {
  return bootstrapUserWorktreeBinding({ ...options, provider: 'codex' })
}

export function bootstrapUserAntigravityWorktreeBinding(options: {
  profile: string
  repositoryId: string
  root: string
  configPath: string
  helperDigest: string
}): { state: 'CONFIGURED' | 'NO_CHANGE'; binding: NativeHookBinding } {
  return bootstrapUserWorktreeBinding({ ...options, provider: 'antigravity' })
}
