import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { canonicalDesktopProfile } from '../desktop-profile'
import { GitWorktreeRegistry } from '../git-operations/git-worktree-registry'
import { availableCatalogRoot, openNativeHookCatalog } from './native-hook-catalog'
import { enrolledNativeStatus, enrollNativeHooks, revokeNativeHooks } from './native-hook-enrollment'
import { nativeHookProviders, type NativeHookProvider } from './native-hooks'

declare const __CODE_AWARENESS_NATIVE_HOOK_BUNDLE__: string

export async function runNativeHookCli(args: string[]) {
  const [action] = args
  if (!['install', 'status', 'disable'].includes(action)) throw new Error('HOOK_ACTION_UNSUPPORTED')
  const opt = (key: string) => args.find(value => value.startsWith('--' + key + '='))?.slice(key.length + 3)
  const provider = (opt('provider') ?? 'codex') as NativeHookProvider
  if (!nativeHookProviders.includes(provider)) throw new Error('PROVIDER_UNSUPPORTED')
  const repositoryId = opt('repository')
  if (!repositoryId) throw new Error('HOOK_REPOSITORY_REQUIRED')
  const appData = process.platform === 'darwin' ? join(homedir(), 'Library/Application Support') :
    process.platform === 'win32' ? process.env.APPDATA : process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  const selectedProfile = opt('profile') ?? (appData && canonicalDesktopProfile(appData).userData)
  if (!selectedProfile) throw new Error('HOOK_CATALOG_UNAVAILABLE')
  const profile = realpathSync(resolve(selectedProfile))
  if (profile !== resolve(selectedProfile)) throw new Error('HOOK_CATALOG_UNAVAILABLE')
  const authorized = args.includes('--authorized')
  if (action !== 'status' && !authorized) throw new Error('HOOK_AUTHORIZATION_REQUIRED')
  if (action === 'disable') return revokeNativeHooks(profile, repositoryId, provider, authorized)

  const db = openNativeHookCatalog(profile, true)
  let root: string
  try { root = availableCatalogRoot(db, repositoryId) } finally { db.close() }
  const git = (cwd: string, ...parameters: string[]) => execFileSync('git',
    ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', cwd, ...parameters],
    { cwd: profile, encoding: 'utf8', timeout: 4000, windowsHide: true })
  const rev = async (cwd: string, ...parameters: string[]) => git(cwd, 'rev-parse', ...parameters).trim()
  const common = (cwd: string) => rev(cwd, '--path-format=absolute', '--git-common-dir')
  const registry = new GitWorktreeRegistry(root, {
    getCommonDirectory: common,
    getRepositoryDirectories: async cwd => ({ common: await common(cwd), admin: await rev(cwd, '--absolute-git-dir') }),
    listWorktreeRecords: async cwd => git(cwd, 'worktree', 'list', '--porcelain', '-z'),
    getCurrentBranch: async cwd => git(cwd, 'branch', '--show-current').trim() || null,
    getCurrentCommitHash: cwd => rev(cwd, 'HEAD'),
    getWorktreeRoot: cwd => rev(cwd, '--show-toplevel')
  }, { repositoryId, isActive: () => true })
  const cwd = process.cwd()
  const record = await registry.resolveCheckout(cwd)
  if (action === 'status') return enrolledNativeStatus(profile, repositoryId, provider, record)
  const clientPath = opt(provider)
  if (!clientPath) throw new Error('HOOK_CLIENT_SELECTION_REQUIRED')
  return enrollNativeHooks({ profile, repositoryId, provider, record, registry }, {
    authorized, clientPath, nodePath: process.execPath, helperContent: __CODE_AWARENESS_NATIVE_HOOK_BUNDLE__,
    managed: args.includes('--authorize-managed-worktrees')
  })
}

if (require.main === module) runNativeHookCli(process.argv.slice(2)).then(
  result => console.log(JSON.stringify(result)),
  error => { console.error(JSON.stringify({ code: /^[A-Z_]+$/.test(error?.message) ? error.message : 'HOOK_OPERATION_FAILED' })); process.exitCode = 1 }
)
