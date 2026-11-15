import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { WEB_NATIVE_HOST_NAME } from './web-activation-types'

const WORKTREE_PATH_RE = /[\\/]worktrees?[\\/]/i
const EXTENSION_ID_RE = /^[a-z0-9]{16,64}$/i

export type NativeBrowserTarget = 'chrome' | 'edge'

export interface NativeHostRegistryRunner {
  addDefaultStringValue(keyPath: string, value: string): void
  deleteKey(keyPath: string): void
}

export interface InstallNativeHostOptions {
  extensionIds: readonly string[]
  hostScriptPath: string
  installDir?: string
  runtimeExecutable?: string
  runtimeArgs?: readonly string[]
  userDataPath?: string
  browsers?: readonly NativeBrowserTarget[]
  registry?: NativeHostRegistryRunner
}

export interface InstallNativeHostResult {
  hostName: string
  installDir: string
  manifestPath: string
  launcherPath: string
  allowedOrigins: string[]
  registryKeys: string[]
}

export interface UninstallNativeHostOptions {
  installDir?: string
  browsers?: readonly NativeBrowserTarget[]
  registry?: NativeHostRegistryRunner
}

export function isWorktreeDestination(targetPath: string): boolean {
  return WORKTREE_PATH_RE.test(resolve(targetPath))
}

export function resolveStableWebActivationDir(localAppData?: string): string {
  const base =
    localAppData ??
    process.env.LOCALAPPDATA ??
    join(homedir(), 'AppData', 'Local')
  return join(base, 'CodeAwareness', 'web-activation')
}

export function getBrowserNativeMessagingRegistryKey(
  browser: NativeBrowserTarget,
  hostName = WEB_NATIVE_HOST_NAME
): string {
  if (browser === 'edge') {
    return `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${hostName}`
  }
  return `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${hostName}`
}

export function normalizeExtensionAllowedOrigins(extensionIds: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of extensionIds) {
    const cleaned = raw.trim().toLowerCase()
    const match = /^chrome-extension:\/\/([a-z0-9]{16,64})\/?$/i.exec(cleaned)
    const id = match ? match[1] : cleaned
    if (!EXTENSION_ID_RE.test(id)) {
      throw new Error(`INVALID_EXTENSION_ID:${raw}`)
    }
    const origin = `chrome-extension://${id}/`
    if (!seen.has(origin)) {
      seen.add(origin)
      out.push(origin)
    }
  }
  if (out.length === 0) {
    throw new Error('EXTENSION_IDS_REQUIRED')
  }
  return out
}

function createWindowsRegistryRunner(): NativeHostRegistryRunner {
  return {
    addDefaultStringValue(keyPath: string, value: string): void {
      execFileSync('reg.exe', ['add', keyPath, '/ve', '/t', 'REG_SZ', '/d', value, '/f'], {
        windowsHide: true,
        stdio: 'pipe'
      })
    },
    deleteKey(keyPath: string): void {
      try {
        execFileSync('reg.exe', ['delete', keyPath, '/f'], {
          windowsHide: true,
          stdio: 'pipe'
        })
      } catch (err) {
        const stderr = err && typeof err === 'object' && 'stderr' in err
          ? String((err as { stderr?: unknown }).stderr ?? '')
          : ''
        if (stderr.includes('unable to find') || stderr.includes('não pôde localizar')) {
          return
        }
        // Ignore absent registry key; rethrow unexpected failures only if message does not indicate missing key
        const status = err && typeof err === 'object' && 'status' in err ? (err as { status?: number }).status : undefined
        if (status === 1) return
        throw err
      }
    }
  }
}

export function buildWindowsLauncherCmd(options: {
  runtimeExecutable: string
  runtimeArgs?: readonly string[]
  hostScriptPath: string
  userDataPath?: string
}): string {
  const quote = (value: string) => `"${value.replace(/"/g, '')}"`
  const extraArgs = options.runtimeArgs ? options.runtimeArgs.map(quote).join(' ') : ''
  const userDataEnv = options.userDataPath
    ? `set "CODE_AWARENESS_USER_DATA=${options.userDataPath.replace(/"/g, '')}"\r\n`
    : ''
  const argsSection = extraArgs ? ` ${extraArgs}` : ''
  return (
    '@echo off\r\n' +
    'setlocal\r\n' +
    userDataEnv +
    `${quote(options.runtimeExecutable)}${argsSection} ${quote(options.hostScriptPath)} %*\r\n`
  )
}

export function installNativeMessagingHost(options: InstallNativeHostOptions): InstallNativeHostResult {
  const installDir = resolve(options.installDir ?? resolveStableWebActivationDir())
  const resolvedHostScript = resolve(options.hostScriptPath)

  if (isWorktreeDestination(installDir)) {
    throw new Error(`WORKTREE_DESTINATION_UNSUPPORTED:${installDir}`)
  }
  if (isWorktreeDestination(resolvedHostScript)) {
    throw new Error(`WORKTREE_HOST_SCRIPT_UNSUPPORTED:${resolvedHostScript}`)
  }

  const allowedOrigins = normalizeExtensionAllowedOrigins(options.extensionIds)
  const browsers = options.browsers && options.browsers.length > 0 ? options.browsers : (['chrome', 'edge'] as const)
  const registry = options.registry ?? createWindowsRegistryRunner()

  mkdirSync(installDir, { recursive: true })
  const launcherPath = join(installDir, 'code-awareness-web-host.cmd')
  const manifestPath = join(installDir, `${WEB_NATIVE_HOST_NAME}.json`)

  const launcherContents = buildWindowsLauncherCmd({
    runtimeExecutable: options.runtimeExecutable ?? process.execPath,
    runtimeArgs: options.runtimeArgs,
    hostScriptPath: resolvedHostScript,
    userDataPath: options.userDataPath
  })
  writeFileSync(launcherPath, launcherContents, 'utf8')

  const manifest = {
    name: WEB_NATIVE_HOST_NAME,
    description: 'Code Awareness Local Web Activation Native Messaging Bridge',
    path: launcherPath,
    type: 'stdio',
    allowed_origins: allowedOrigins
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')

  const registryKeys = browsers.map((browser) => getBrowserNativeMessagingRegistryKey(browser, WEB_NATIVE_HOST_NAME))
  for (const keyPath of registryKeys) {
    registry.addDefaultStringValue(keyPath, manifestPath)
  }

  return {
    hostName: WEB_NATIVE_HOST_NAME,
    installDir,
    manifestPath,
    launcherPath,
    allowedOrigins,
    registryKeys
  }
}

export function uninstallNativeMessagingHost(options: UninstallNativeHostOptions = {}): void {
  const installDir = resolve(options.installDir ?? resolveStableWebActivationDir())
  const browsers = options.browsers && options.browsers.length > 0 ? options.browsers : (['chrome', 'edge'] as const)
  const registry = options.registry ?? createWindowsRegistryRunner()

  for (const browser of browsers) {
    registry.deleteKey(getBrowserNativeMessagingRegistryKey(browser, WEB_NATIVE_HOST_NAME))
  }

  const launcherPath = join(installDir, 'code-awareness-web-host.cmd')
  const manifestPath = join(installDir, `${WEB_NATIVE_HOST_NAME}.json`)
  if (existsSync(launcherPath)) rmSync(launcherPath, { force: true })
  if (existsSync(manifestPath)) rmSync(manifestPath, { force: true })
}
