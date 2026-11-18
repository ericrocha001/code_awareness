import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { canonicalDesktopProfile } from '../desktop-profile'
import { availableCatalogRoot, openNativeHookCatalog } from './native-hook-catalog'
import {
  disableUserProfileCodex, enrolledNativeStatus, enrollNativeHooks, enrollRepositoryForUserCodex,
  enrollUserProfileCodex, nativeHookRegistry, prepareExternalNativeHooks, revokeNativeHooks, userCodexProfileStatus
} from './native-hook-enrollment'
import { cutoverLegacyProjectCodexHooks, resolveCodexHome, resolveDistributableNodeRuntime } from './native-hook-profile'
import { nativeHookProviders, type NativeHookProvider } from './native-hooks'

declare const __CODE_AWARENESS_NATIVE_HOOK_BUNDLE__: string

export async function runNativeHookCli(args: string[]) {
  const [action] = args
  if (!['install', 'prepare', 'status', 'disable', 'enroll', 'cutover'].includes(action)) throw new Error('HOOK_ACTION_UNSUPPORTED')
  const opt = (key: string) => args.find(value => value.startsWith('--' + key + '='))?.slice(key.length + 3)
  const provider = (opt('provider') ?? 'codex') as NativeHookProvider
  if (!nativeHookProviders.includes(provider)) throw new Error('PROVIDER_UNSUPPORTED')
  const repositoryId = opt('repository')
  const userScope = args.includes('--user') || opt('scope') === 'user'
  const appData = process.platform === 'darwin' ? join(homedir(), 'Library/Application Support') :
    process.platform === 'win32' ? process.env.APPDATA : process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  const selectedProfile = opt('profile') ?? (appData && canonicalDesktopProfile(appData).userData)
  if (!selectedProfile) throw new Error('HOOK_CATALOG_UNAVAILABLE')
  const profile = realpathSync(resolve(selectedProfile))
  if (profile !== resolve(selectedProfile)) throw new Error('HOOK_CATALOG_UNAVAILABLE')
  const authorized = args.includes('--authorized')
  if (action !== 'status' && !authorized) throw new Error('HOOK_AUTHORIZATION_REQUIRED')
  const codexHome = opt('codex-home')

  if (userScope || action === 'cutover' || (action === 'status' && !repositoryId)) {
    if (provider !== 'codex') throw new Error('PROVIDER_UNSUPPORTED')
    if (action === 'status') {
      return userCodexProfileStatus({ profile, codexHome, repositoryId, explicitClientPath: opt('codex') })
    }
    if (action === 'disable') {
      return disableUserProfileCodex(profile, authorized, codexHome)
    }
    if (action === 'cutover') {
      return cutoverLegacyProjectCodexHooks({
        profile,
        userConfigPath: join(resolveCodexHome(codexHome), 'hooks.json'),
        repositoryId,
        authorized
      })
    }
    if (action === 'install') {
      const runtime = resolveDistributableNodeRuntime({ packaged: false, execPath: process.execPath, allowWorktreeRuntime: args.includes('--allow-worktree-runtime') })
      return enrollUserProfileCodex({
        profile,
        codexHome,
        helperContent: __CODE_AWARENESS_NATIVE_HOOK_BUNDLE__,
        nodePath: runtime.nodePath,
        runAsNode: runtime.runAsNode,
        clientPath: opt('codex'),
        gitCommitTool: opt('git-commit-tool'),
        autoEnrollNewProjects: args.includes('--auto-enroll'),
        enrollActiveRepositories: args.includes('--enroll-active'),
        repositoryIds: repositoryId ? [repositoryId] : undefined,
        cutoverLegacy: args.includes('--cutover'),
        authorized,
        allowWorktreeRuntime: args.includes('--allow-worktree-runtime')
      })
    }
  }

  if (!repositoryId) throw new Error('HOOK_REPOSITORY_REQUIRED')
  if (action === 'enroll') {
    if (provider !== 'codex') throw new Error('PROVIDER_UNSUPPORTED')
    return enrollRepositoryForUserCodex(profile, repositoryId, {
      authorized,
      gitCommitTool: opt('git-commit-tool'),
      cutoverLegacy: args.includes('--cutover')
    })
  }
  if (action === 'prepare') {
    if (provider !== 'codex') throw new Error('PROVIDER_UNSUPPORTED')
    const prepared = await prepareExternalNativeHooks(profile, repositoryId, process.cwd())
    if (prepared.state === 'NOT_ENROLLED') throw new Error('HOOK_ENROLLMENT_REQUIRED')
    return prepared
  }
  if (action === 'disable') return revokeNativeHooks(profile, repositoryId, provider, authorized)

  const db = openNativeHookCatalog(profile, true)
  let root: string
  try { root = availableCatalogRoot(db, repositoryId) } finally { db.close() }
  const registry = nativeHookRegistry(profile, root, repositoryId)
  const cwd = process.cwd()
  const record = await registry.resolveCheckout(cwd)
  if (action === 'status') return enrolledNativeStatus(profile, repositoryId, provider, record)
  const clientPath = opt(provider)
  if (!clientPath) throw new Error('HOOK_CLIENT_SELECTION_REQUIRED')
  return enrollNativeHooks({ profile, repositoryId, provider, record, registry }, {
    authorized,
    clientPath,
    nodePath: process.execPath,
    helperContent: __CODE_AWARENESS_NATIVE_HOOK_BUNDLE__,
    managed: args.includes('--authorize-managed-worktrees'),
    externalPreparation: args.includes('--authorize-external-worktrees'),
    gitCommitTool: opt('git-commit-tool')
  })
}

if (require.main === module) runNativeHookCli(process.argv.slice(2)).then(
  result => console.log(JSON.stringify(result)),
  error => { console.error(JSON.stringify({ code: /^[A-Z_]+$/.test(error?.message) ? error.message : 'HOOK_OPERATION_FAILED' })); process.exitCode = 1 }
)
