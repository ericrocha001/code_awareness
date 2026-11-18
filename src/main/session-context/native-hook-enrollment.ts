import { execFileSync } from 'node:child_process'
import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { isQualifiedCodexHookVersion } from '../../shared/native-hook-preflight.cjs'
import { GitWorktreeRegistry, type WorktreeRecord } from '../git-operations/git-worktree-registry'
import { assertProfilePath, assertUserOwned, revision, writeConfig } from '../local-mcp-clients/safe-config-file'
import {
  availableCatalogRoot, enrollmentKey, openNativeHookCatalog, profileIntegrationKey, readNativeEnrollment, readUserCodexProfile,
  type NativeHookEnrollment, type UserCodexHookProfile
} from './native-hook-catalog'
import { inspectNativeInstallation, installNativeHooks } from './native-hook-installation'
import {
  bootstrapUserCodexWorktreeBinding, cutoverLegacyProjectCodexHooks, disableUserCodexHooks, discoverCodexClients,
  inspectUserCodexInstallation, installUserCodexHooks, qualifyCodexBinary, resolveCodexHome, type DiscoveredCodexClient,
  type LegacyCutoverItem
} from './native-hook-profile'
import { boundedFile, nativeDigest, nativeGitCommitToolPattern, nativeGitDirectories, nativeGitIdentity, nativeHookProviders, type NativeHookProvider } from './native-hooks'

function qualifiedClient(provider: NativeHookProvider, path: string): boolean {
  const name = provider === 'codex' ? /^codex(?:\.exe)?$/i : /^antigravity(?: ide)?(?:\.exe)?$/i
  if (!name.test(basename(path)) || !lstatSync(path).isFile() || realpathSync(path) !== resolve(path)) return false
  if (provider === 'antigravity') return true
  const version = execFileSync(path, ['--version'], { encoding: 'utf8', timeout: 2000, windowsHide: true }).trim().match(/^codex-cli (\S+)$/)?.[1]
  return !!version && isQualifiedCodexHookVersion(version)
}

type Dependencies = Pick<GitWorktreeRegistry, 'resolveCheckout'>
interface Selection { profile: string; repositoryId: string; provider: NativeHookProvider; registry: Dependencies; record: WorktreeRecord }
type ReconciliationScope = 'MANAGED_CREATION' | 'CATALOG_CHECKOUT' | 'EXTERNAL_PREPARATION'
interface ExplicitEnrollment {
  authorized: boolean
  nodePath: string
  clientPath: string
  helperContent: string
  managed: boolean
  externalPreparation?: boolean
  gitCommitTool?: string
}

function checkedExecutable(path: string): string {
  const real = realpathSync(path)
  if (real !== resolve(path) || !lstatSync(real).isFile()) throw new Error('HOOK_EXECUTABLE_UNAVAILABLE')
  return real
}

export async function enrollNativeHooks(
  selection: Omit<Selection, 'record'> & { record: WorktreeRecord | string },
  permission?: ExplicitEnrollment,
  scope: ReconciliationScope = 'MANAGED_CREATION'
) {
  const { profile, repositoryId, provider, registry, record } = selection
  if (permission && !permission.authorized) throw new Error('HOOK_AUTHORIZATION_REQUIRED')
  if (provider !== 'codex' && (permission?.externalPreparation || permission?.gitCommitTool !== undefined)) throw new Error('PROVIDER_UNSUPPORTED')
  if (permission?.gitCommitTool !== undefined && !nativeGitCommitToolPattern.test(permission.gitCommitTool)) throw new Error('INVALID_BINDING')
  const reader = openNativeHookCatalog(profile, true)
  let catalogRoot: string
  let existingProfile: UserCodexHookProfile | undefined
  let existingGrant: NativeHookEnrollment | undefined
  try {
    catalogRoot = availableCatalogRoot(reader, repositoryId)
    existingProfile = provider === 'codex' ? readUserCodexProfile(reader, 'codex') : undefined
    existingGrant = readNativeEnrollment(reader, repositoryId, provider)
  } finally { reader.close() }

  const selected = await registry.resolveCheckout(typeof record === 'string' ? record : record.path)
  if ((typeof record !== 'string' && (selected.path !== record.path || selected.worktreeId !== record.worktreeId || selected.generation !== record.generation)) ||
      selected.locked || selected.missing || selected.prunable || !selected.head) throw new Error('WORKTREE_STALE')

  if (provider === 'codex' && existingProfile?.enabled && !permission) {
    const allowed = scope === 'MANAGED_CREATION' ? existingGrant?.managed : existingGrant?.worktrees[selected.worktreeId] === selected.generation || existingGrant?.externalPreparation
    if (!allowed) return { state: 'NOT_ENROLLED' as const }
    const prepared = bootstrapUserCodexWorktreeBinding({
      profile,
      repositoryId,
      root: selected.path,
      configPath: existingProfile.configPath,
      gitCommitTool: existingGrant?.gitCommitTool ?? existingProfile.gitCommitTool,
      helperDigest: existingProfile.helperDigest
    })
    return { state: prepared.state, statuses: [{ worktreeId: selected.worktreeId, installation: 'CONFIGURED' as const, handlers: 7 }], trust: 'NOT_INSPECTED' as const }
  }

  const db = openNativeHookCatalog(profile, false)
  try {
    const resolvedCatalogRoot = availableCatalogRoot(db, repositoryId)
    const previous = db.prepare('SELECT value FROM repository_catalog_meta WHERE key=?').get(enrollmentKey(repositoryId, provider))?.value
    const prior = readNativeEnrollment(db, repositoryId, provider)
    const previouslyAuthorized = prior && (scope === 'MANAGED_CREATION' ? prior.managed : prior.worktrees[selected.worktreeId] === selected.generation)
    if (!permission && !previouslyAuthorized) return { state: 'NOT_ENROLLED' as const }
    if (permission) assertUserOwned(join(profile, 'repositories/catalog.db'))
    const commonDirectory = nativeGitIdentity(resolvedCatalogRoot).commonDirectory
    if (prior && (prior.catalogRoot !== resolvedCatalogRoot || prior.commonDirectory !== commonDirectory)) throw new Error('HOOK_ENROLLMENT_SCOPE_CHANGED')
    if (nativeGitIdentity(selected.path).commonDirectory !== commonDirectory) throw new Error('WORKTREE_MISMATCH')
    const nodePath = checkedExecutable(permission?.nodePath ?? prior!.nodePath)
    const clientPath = checkedExecutable(permission?.clientPath ?? prior!.clientPath)
    if (!qualifiedClient(provider, clientPath)) throw new Error('HOOK_CLIENT_UNQUALIFIED')
    const helperSource = permission?.helperContent
    const helperDigest = helperSource ? nativeDigest(helperSource) : prior?.helperDigest
    if (!helperDigest || !/^[a-f0-9]{64}$/.test(helperDigest)) throw new Error('HOOK_HELPER_UNAVAILABLE')
    const helper = join(profile, 'session-context', 'native-hook-' + helperDigest + '.cjs')
    assertProfilePath(helper, profile)
    const helperRevision = revision(helper)
    if (helperRevision.content === null && helperSource) writeConfig(helper, profile, helperRevision, helperSource)
    if (nativeDigest(boundedFile(helper, 512 * 1024)) !== helperDigest) throw new Error('HOOK_COMMAND_DIGEST_MISMATCH')
    const targets = [selected]
    if (provider === 'codex') {
      const main = dirname(commonDirectory)
      if (join(main, '.git') !== commonDirectory || nativeGitIdentity(main).root !== main) throw new Error('HOOK_MAIN_UNVERIFIABLE')
      if (main !== selected.path) targets.unshift(await registry.resolveCheckout(main))
    }
    const gitCommitTool = permission?.gitCommitTool ?? prior?.gitCommitTool
    const statuses = []
    const worktrees = { ...prior?.worktrees }
    for (const target of targets) {
      const refreshed = await registry.resolveCheckout(target.path)
      if (availableCatalogRoot(db, repositoryId) !== resolvedCatalogRoot ||
          nativeGitIdentity(refreshed.path).commonDirectory !== commonDirectory ||
          refreshed.worktreeId !== target.worktreeId || refreshed.generation !== target.generation ||
          db.prepare('SELECT value FROM repository_catalog_meta WHERE key=?').get(enrollmentKey(repositoryId, provider))?.value !== previous) throw new Error('HOOK_ENROLLMENT_SCOPE_CHANGED')
      installNativeHooks({ repositoryId, record: refreshed, commandPath: helper, nodePath, provider, gitCommitTool, authorized: true })
      const status = inspectNativeInstallation(refreshed.path, { repositoryId, ...refreshed }, process.platform, provider)
      if (status.state !== 'CONFIGURED') throw new Error(status.reasonCode)
      statuses.push({ worktreeId: refreshed.worktreeId, installation: status.state, handlers: status.installed })
      worktrees[refreshed.worktreeId] = refreshed.generation
    }
    const next: NativeHookEnrollment = {
      scope: prior?.scope ?? 'CHECKOUT',
      catalogRoot: resolvedCatalogRoot,
      commonDirectory,
      nodePath,
      clientPath,
      helperDigest,
      managed: permission?.managed ?? prior!.managed,
      ...(provider === 'codex' && (permission?.externalPreparation ?? prior?.externalPreparation) ? { externalPreparation: true } : {}),
      ...(gitCommitTool ? { gitCommitTool } : {}),
      worktrees
    }
    db.exec('BEGIN IMMEDIATE')
    try {
      const key = enrollmentKey(repositoryId, provider)
      if (availableCatalogRoot(db, repositoryId) !== catalogRoot ||
          db.prepare('SELECT value FROM repository_catalog_meta WHERE key=?').get(key)?.value !== previous) throw new Error('HOOK_ENROLLMENT_SCOPE_CHANGED')
      db.prepare('INSERT INTO repository_catalog_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(next))
      db.exec('COMMIT')
    } catch (error) { db.exec('ROLLBACK'); throw error }
    return { state: 'CONFIGURED' as const, statuses, trust: 'NOT_INSPECTED' as const }
  } finally { db.close() }
}

export function enrollUserProfileCodex(options: {
  profile: string
  codexHome?: string
  helperContent: string
  nodePath: string
  runAsNode?: boolean
  clientPath?: string
  gitCommitTool?: string
  autoEnrollNewProjects?: boolean
  enrollActiveRepositories?: boolean
  repositoryIds?: string[]
  cutoverLegacy?: boolean
  worktreePaths?: string[]
  authorized: boolean
  allowWorktreeRuntime?: boolean
}): {
  state: 'CONFIGURED' | 'NO_CHANGE' | 'DEFERRED'
  codexHome: string
  configPath: string
  helperPath: string
  helperDigest: string
  hooksDigest: string
  trust: 'UNCHANGED' | 'REVIEW_REQUIRED'
  enrolledRepositories: string[]
  cutover?: { state: 'COMPLETED' | 'DEFERRED'; items: LegacyCutoverItem[] }
} {
  if (!options.authorized) throw new Error('HOOK_AUTHORIZATION_REQUIRED')
  if (options.gitCommitTool !== undefined && !nativeGitCommitToolPattern.test(options.gitCommitTool)) {
    throw new Error('INVALID_BINDING')
  }
  const profile = realpathSync(resolve(options.profile))
  assertUserOwned(join(profile, 'repositories/catalog.db'))

  let clientVersion: string | undefined
  let clientPath: string | undefined
  if (options.clientPath) {
    const inspectedClient = qualifyCodexBinary(options.clientPath, 'EXPLICIT')
    if (!inspectedClient.qualified || !inspectedClient.version) throw new Error(inspectedClient.reasonCode)
    clientPath = inspectedClient.path
    clientVersion = inspectedClient.version
  }

  const installed = installUserCodexHooks({
    profile,
    codexHome: options.codexHome,
    helperContent: options.helperContent,
    nodePath: options.nodePath,
    runAsNode: options.runAsNode,
    clientPath,
    clientVersion,
    authorized: true,
    allowWorktreeRuntime: options.allowWorktreeRuntime
  })

  const cutover = options.cutoverLegacy
    ? cutoverLegacyProjectCodexHooks({
        profile,
        userConfigPath: installed.configPath,
        worktreePaths: options.worktreePaths,
        authorized: true
      })
    : undefined
  const conflictedRepos = new Set(
    (cutover?.items ?? []).filter(item => item.state === 'CONFLICT' && item.repositoryId).map(item => item.repositoryId!)
  )

  const db = openNativeHookCatalog(profile, false)
  const enrolledRepositories: string[] = []
  try {
    db.exec('BEGIN IMMEDIATE')
    const priorProfile = readUserCodexProfile(db, 'codex')
    const nextProfile: UserCodexHookProfile = {
      schema: 1,
      enabled: true,
      codexHome: installed.codexHome,
      configPath: installed.configPath,
      helperDigest: installed.helperDigest,
      nodePath: checkedExecutable(options.nodePath),
      ...(options.runAsNode ? { runAsNode: true } : {}),
      ...(clientPath ? { clientPath } : priorProfile?.clientPath ? { clientPath: priorProfile.clientPath } : {}),
      ...(clientVersion ? { clientVersion } : priorProfile?.clientVersion ? { clientVersion: priorProfile.clientVersion } : {}),
      autoEnrollNewProjects: options.autoEnrollNewProjects ?? priorProfile?.autoEnrollNewProjects ?? false,
      ...(options.gitCommitTool ? { gitCommitTool: options.gitCommitTool } : priorProfile?.gitCommitTool ? { gitCommitTool: priorProfile.gitCommitTool } : {}),
      updatedAt: new Date().toISOString()
    }
    db.prepare('INSERT INTO repository_catalog_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(profileIntegrationKey('codex'), JSON.stringify(nextProfile))

    const activeRows = db.prepare(`SELECT id, checkout_path FROM repository_catalog_records
      WHERE status='ACTIVE' AND availability='AVAILABLE' AND git_state='GIT'`).all() as Array<{ id: string; checkout_path: string }>
    const requestedIds = options.repositoryIds ? new Set(options.repositoryIds) : undefined
    for (const row of activeRows) {
      if (conflictedRepos.has(row.id)) continue
      const existing = readNativeEnrollment(db, row.id, 'codex')
      const shouldEnroll = Boolean(existing) || options.enrollActiveRepositories === true || Boolean(requestedIds?.has(row.id))
      if (!shouldEnroll) continue
      const root = realpathSync(row.checkout_path)
      const commonDirectory = nativeGitIdentity(root).commonDirectory
      const effectiveTool = options.gitCommitTool ?? existing?.gitCommitTool ?? nextProfile.gitCommitTool
      const nextEnrollment: NativeHookEnrollment = {
        scope: 'USER',
        catalogRoot: root,
        commonDirectory,
        worktrees: existing?.commonDirectory === commonDirectory ? existing.worktrees : {},
        managed: true,
        externalPreparation: true,
        helperDigest: installed.helperDigest,
        nodePath: nextProfile.nodePath,
        clientPath: nextProfile.clientPath ?? existing?.clientPath ?? '',
        ...(effectiveTool ? { gitCommitTool: effectiveTool } : {})
      }
      db.prepare('INSERT INTO repository_catalog_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
        .run(enrollmentKey(row.id, 'codex'), JSON.stringify(nextEnrollment))
      enrolledRepositories.push(row.id)
    }
    db.exec('COMMIT')
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw error
  } finally { db.close() }

  return {
    state: cutover?.state === 'DEFERRED' ? 'DEFERRED' : installed.state,
    codexHome: installed.codexHome,
    configPath: installed.configPath,
    helperPath: installed.helperPath,
    helperDigest: installed.helperDigest,
    hooksDigest: installed.hooksDigest,
    trust: installed.trust,
    enrolledRepositories,
    ...(cutover ? { cutover } : {})
  }
}

export function enrollRepositoryForUserCodex(
  profileInput: string,
  repositoryId: string,
  options: { authorized: boolean; gitCommitTool?: string; cutoverLegacy?: boolean; worktreePaths?: string[] }
): { state: 'ENROLLED' | 'NO_CHANGE' | 'DEFERRED'; repositoryId: string; commonDirectory: string; cutover?: { state: 'COMPLETED' | 'DEFERRED'; items: LegacyCutoverItem[] } } {
  if (!options.authorized) throw new Error('HOOK_AUTHORIZATION_REQUIRED')
  if (options.gitCommitTool !== undefined && !nativeGitCommitToolPattern.test(options.gitCommitTool)) {
    throw new Error('INVALID_BINDING')
  }
  const profile = realpathSync(resolve(profileInput))
  assertUserOwned(join(profile, 'repositories/catalog.db'))

  const reader = openNativeHookCatalog(profile, true)
  let profileRow: UserCodexHookProfile | undefined
  try {
    profileRow = readUserCodexProfile(reader, 'codex')
  } finally { reader.close() }
  if (!profileRow?.enabled) throw new Error('HOOK_PROFILE_NOT_ENABLED')
  const inspected = inspectUserCodexInstallation(profile, profileRow.codexHome, process.platform)
  if (inspected.state !== 'CONFIGURED') throw new Error(inspected.reasonCode)

  const cutover = options.cutoverLegacy
    ? cutoverLegacyProjectCodexHooks({
        profile,
        userConfigPath: profileRow.configPath,
        repositoryId,
        worktreePaths: options.worktreePaths,
        authorized: true
      })
    : undefined
  if (cutover?.state === 'DEFERRED') {
    return { state: 'DEFERRED', repositoryId, commonDirectory: '', cutover }
  }

  const db = openNativeHookCatalog(profile, false)
  try {
    db.exec('BEGIN IMMEDIATE')
    const activeProfile = readUserCodexProfile(db, 'codex')
    if (!activeProfile?.enabled) throw new Error('HOOK_PROFILE_NOT_ENABLED')
    const root = availableCatalogRoot(db, repositoryId)
    const commonDirectory = nativeGitIdentity(root).commonDirectory
    const existing = readNativeEnrollment(db, repositoryId, 'codex')
    const effectiveTool = options.gitCommitTool ?? existing?.gitCommitTool ?? activeProfile.gitCommitTool
    const next: NativeHookEnrollment = {
      scope: 'USER',
      catalogRoot: root,
      commonDirectory,
      worktrees: existing?.commonDirectory === commonDirectory ? existing.worktrees : {},
      managed: true,
      externalPreparation: true,
      helperDigest: activeProfile.helperDigest,
      nodePath: activeProfile.nodePath,
      clientPath: activeProfile.clientPath ?? existing?.clientPath ?? '',
      ...(effectiveTool ? { gitCommitTool: effectiveTool } : {})
    }
    const serialized = JSON.stringify(next)
    const key = enrollmentKey(repositoryId, 'codex')
    const prevValue = db.prepare('SELECT value FROM repository_catalog_meta WHERE key=?').get(key)?.value
    if (prevValue === serialized) {
      db.exec('COMMIT')
      return { state: 'NO_CHANGE', repositoryId, commonDirectory, ...(cutover ? { cutover } : {}) }
    }
    db.prepare('INSERT INTO repository_catalog_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, serialized)
    db.exec('COMMIT')
    return { state: 'ENROLLED', repositoryId, commonDirectory, ...(cutover ? { cutover } : {}) }
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw error
  } finally { db.close() }
}

export function disableUserProfileCodex(profileInput: string, authorized: boolean, codexHomeInput?: string) {
  if (!authorized) throw new Error('HOOK_AUTHORIZATION_REQUIRED')
  const profile = realpathSync(resolve(profileInput))
  assertUserOwned(join(profile, 'repositories/catalog.db'))
  const disabled = disableUserCodexHooks(profile, true, codexHomeInput)
  const db = openNativeHookCatalog(profile, false)
  try {
    db.exec('BEGIN IMMEDIATE')
    const existing = readUserCodexProfile(db, 'codex')
    if (existing) {
      db.prepare('INSERT INTO repository_catalog_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
        .run(profileIntegrationKey('codex'), JSON.stringify({ ...existing, enabled: false, updatedAt: new Date().toISOString() }))
    }
    db.exec('COMMIT')
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw error
  } finally { db.close() }
  return disabled
}

export function reconcileRepositoryCodexHooks(
  profileInput: string,
  repositoryId: string,
  autoEnrollPreference: boolean
): { state: 'ENROLLED' | 'NO_CHANGE' | 'SKIPPED' | 'PROFILE_DISABLED' } {
  const profile = realpathSync(resolve(profileInput))
  const db = openNativeHookCatalog(profile, true)
  let profileRow: UserCodexHookProfile | undefined
  let existing: NativeHookEnrollment | undefined
  try {
    profileRow = readUserCodexProfile(db, 'codex')
    existing = readNativeEnrollment(db, repositoryId, 'codex')
  } finally { db.close() }
  if (!profileRow?.enabled) return { state: 'PROFILE_DISABLED' }
  if (!existing && (!autoEnrollPreference || !profileRow.autoEnrollNewProjects)) return { state: 'SKIPPED' }
  const res = enrollRepositoryForUserCodex(profile, repositoryId, { authorized: true })
  return { state: res.state === 'DEFERRED' ? 'SKIPPED' : res.state }
}

export function userCodexProfileStatus(options: {
  profile: string
  codexHome?: string
  repositoryId?: string
  explicitClientPath?: string
}) {
  const profile = realpathSync(resolve(options.profile))
  const installation = inspectUserCodexInstallation(profile, options.codexHome, process.platform)
  const codexHome = installation.codexHome || resolveCodexHome(options.codexHome)
  const clients: DiscoveredCodexClient[] = discoverCodexClients({ explicit: options.explicitClientPath })
  const db = openNativeHookCatalog(profile, true)
  let profileRecord: UserCodexHookProfile | undefined
  let repositoryEnrollment: NativeHookEnrollment | undefined
  const enrolledRepositoryIds: string[] = []
  try {
    profileRecord = readUserCodexProfile(db, 'codex')
    const activeRows = db.prepare(`SELECT id FROM repository_catalog_records WHERE status='ACTIVE' AND availability='AVAILABLE' AND git_state='GIT'`).all() as Array<{ id: string }>
    for (const row of activeRows) {
      const grant = readNativeEnrollment(db, row.id, 'codex')
      if (grant) enrolledRepositoryIds.push(row.id)
      if (options.repositoryId && row.id === options.repositoryId) repositoryEnrollment = grant
    }
  } finally { db.close() }

  return {
    scope: 'USER' as const,
    codexHome,
    configPath: installation.configPath,
    profileEnabled: profileRecord?.enabled === true,
    autoEnrollNewProjects: profileRecord?.autoEnrollNewProjects === true,
    gitCommitTool: profileRecord?.gitCommitTool,
    installation: (() => {
      const { handlers: _handlers, ...rest } = installation
      return rest
    })(),
    clients,
    enrolledRepositoryIds,
    ...(options.repositoryId ? {
      repositoryEnrolled: Boolean(repositoryEnrollment),
      externalPreparation: repositoryEnrollment?.externalPreparation === true
    } : {}),
    trust: 'NOT_INSPECTED' as const
  }
}

export function nativeHookRegistry(profile: string, root: string, repositoryId: string, deadline = Infinity) {
  const git = (cwd: string, ...parameters: string[]) => {
    const remaining = deadline - performance.now()
    if (remaining <= 0) throw new Error('HOOK_PREPARATION_TIMEOUT')
    if (process.env.GIT_DIR || process.env.GIT_WORK_TREE || process.env.GIT_COMMON_DIR) throw new Error('WORKTREE_MISMATCH')
    try {
      return execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', cwd, ...parameters],
        { cwd: profile, encoding: 'utf8', timeout: Math.max(1, Math.min(4000, Math.floor(remaining))), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ETIMEDOUT') throw new Error('HOOK_PREPARATION_TIMEOUT')
      throw error
    }
  }
  const rev = async (cwd: string, ...parameters: string[]) => git(cwd, 'rev-parse', ...parameters).trim()
  const common = async (cwd: string) => nativeGitDirectories(cwd, true).commonDirectory
  return new GitWorktreeRegistry(root, {
    getCommonDirectory: common,
    getRepositoryDirectories: async cwd => {
      const { commonDirectory: common, admin } = nativeGitDirectories(cwd, true)
      return { common, admin }
    },
    listWorktreeRecords: async cwd => git(cwd, 'worktree', 'list', '--porcelain', '-z'),
    getCurrentBranch: async cwd => git(cwd, 'branch', '--show-current').trim() || null,
    getCurrentCommitHash: cwd => rev(cwd, 'HEAD'),
    getWorktreeRoot: cwd => rev(cwd, '--show-toplevel')
  }, { repositoryId, isActive: () => performance.now() < deadline })
}

export async function prepareExternalNativeHooks(profile: string, repositoryId: string, cwd: string, deadline = Infinity) {
  const db = openNativeHookCatalog(profile, true)
  let root: string
  let profileRow: UserCodexHookProfile | undefined
  let grant: NativeHookEnrollment | undefined
  try {
    root = availableCatalogRoot(db, repositoryId)
    profileRow = readUserCodexProfile(db, 'codex')
    grant = readNativeEnrollment(db, repositoryId, 'codex')
  } finally { db.close() }
  if (performance.now() >= deadline) throw new Error('HOOK_PREPARATION_TIMEOUT')
  if (profileRow?.enabled) {
    if (!grant?.externalPreparation) return { state: 'NOT_ENROLLED' as const }
    const identity = nativeGitIdentity(cwd)
    if (identity.commonDirectory !== grant.commonDirectory) throw new Error('WORKTREE_MISMATCH')
    const prepared = bootstrapUserCodexWorktreeBinding({
      profile,
      repositoryId,
      root: cwd,
      configPath: profileRow.configPath,
      gitCommitTool: grant.gitCommitTool ?? profileRow.gitCommitTool,
      helperDigest: profileRow.helperDigest
    })
    return {
      state: prepared.state,
      statuses: [{ worktreeId: prepared.binding.worktreeId, installation: 'CONFIGURED' as const, handlers: 7 }],
      trust: 'NOT_INSPECTED' as const
    }
  }
  const registry = nativeHookRegistry(profile, root, repositoryId, deadline)
  return enrollNativeHooks({ profile, repositoryId, provider: 'codex', registry, record: cwd }, undefined, 'EXTERNAL_PREPARATION')
}

export async function prepareEnrolledNativeHooks(selection: Omit<Selection, 'provider'>, scope: ReconciliationScope) {
  const results = []
  for (const provider of nativeHookProviders) {
    try {
      const res = await enrollNativeHooks({ ...selection, provider }, undefined, scope)
      results.push({ provider, state: res.state === 'NO_CHANGE' ? 'CONFIGURED' : res.state })
    }
    catch { results.push({ provider, state: 'PREPARATION_BLOCKED' }) }
  }
  return results
}

export function revokeNativeHooks(profile: string, repositoryId: string, provider: NativeHookProvider, authorized: boolean) {
  if (!authorized) throw new Error('HOOK_AUTHORIZATION_REQUIRED')
  assertUserOwned(join(profile, 'repositories/catalog.db'))
  const db = openNativeHookCatalog(profile, false)
  try {
    db.prepare('DELETE FROM repository_catalog_meta WHERE key=?').run(enrollmentKey(repositoryId, provider))
    return { state: 'REVOKED' as const }
  } finally { db.close() }
}

export function enrolledNativeStatus(profile: string, repositoryId: string, provider: NativeHookProvider, record: WorktreeRecord) {
  const db = openNativeHookCatalog(profile, true)
  try {
    const root = availableCatalogRoot(db, repositoryId)
    const grant = readNativeEnrollment(db, repositoryId, provider)
    const profileRow = provider === 'codex' ? readUserCodexProfile(db, 'codex') : undefined
    const { handlers: _private, ...installation } = inspectNativeInstallation(record.path, { repositoryId, ...record }, process.platform, provider)
    return {
      installation,
      enrolled: grant?.catalogRoot === root && (grant.worktrees[record.worktreeId] === record.generation || Boolean(profileRow?.enabled && grant.externalPreparation)),
      ...(provider === 'codex' ? {
        scope: profileRow?.enabled ? 'USER' : 'CHECKOUT',
        externalPreparation: grant?.externalPreparation === true,
        gitCommitTool: grant?.gitCommitTool
      } : {}),
      discovery: 'NOT_INSPECTED',
      trust: 'NOT_INSPECTED'
    }
  } finally { db.close() }
}
