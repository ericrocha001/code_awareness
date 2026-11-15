import { execFileSync } from 'node:child_process'
import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { isQualifiedCodexHookVersion } from '../../shared/native-hook-preflight.cjs'
import type { GitWorktreeRegistry, WorktreeRecord } from '../git-operations/git-worktree-registry'
import { assertProfilePath, assertUserOwned, revision, writeConfig } from '../local-mcp-clients/safe-config-file'
import { availableCatalogRoot, enrollmentKey, openNativeHookCatalog, readNativeEnrollment, type NativeHookEnrollment } from './native-hook-catalog'
import { hookPaths, inspectNativeInstallation, installNativeHooks } from './native-hook-installation'
import { boundedFile, nativeDigest, nativeGitIdentity, nativeHookProviders, type NativeHookProvider } from './native-hooks'

function qualifiedClient(provider: NativeHookProvider, path: string): boolean {
  const name = provider === 'codex' ? /^codex(?:\.exe)?$/i : /^antigravity(?: ide)?(?:\.exe)?$/i
  if (!name.test(basename(path)) || !lstatSync(path).isFile() || realpathSync(path) !== resolve(path)) return false
  if (provider === 'antigravity') return true
  const version = execFileSync(path, ['--version'], { encoding: 'utf8', timeout: 2000, windowsHide: true }).trim().match(/^codex-cli (\S+)$/)?.[1]
  return !!version && isQualifiedCodexHookVersion(version)
}

type Dependencies = Pick<GitWorktreeRegistry, 'resolveCheckout'>
interface Selection { profile: string; repositoryId: string; provider: NativeHookProvider; registry: Dependencies; record: WorktreeRecord }
type ReconciliationScope = 'MANAGED_CREATION' | 'CATALOG_CHECKOUT'
interface ExplicitEnrollment { authorized: boolean; nodePath: string; clientPath: string; helperContent: string; managed: boolean }
interface Enrollment extends NativeHookEnrollment { helperDigest: string }

function checkedExecutable(path: string): string {
  const real = realpathSync(path)
  if (real !== resolve(path) || !lstatSync(real).isFile()) throw new Error('HOOK_EXECUTABLE_UNAVAILABLE')
  return real
}

export async function enrollNativeHooks(selection: Selection, permission?: ExplicitEnrollment, scope: ReconciliationScope = 'MANAGED_CREATION') {
  const { profile, repositoryId, provider, registry, record } = selection
  if (permission && !permission.authorized) throw new Error('HOOK_AUTHORIZATION_REQUIRED')
  const db = openNativeHookCatalog(profile, false)
  try {
    const catalogRoot = availableCatalogRoot(db, repositoryId)
    const previous = db.prepare('SELECT value FROM repository_catalog_meta WHERE key=?').get(enrollmentKey(repositoryId, provider))?.value
    const prior = readNativeEnrollment(db, repositoryId, provider) as Enrollment | undefined
    const previouslyAuthorized = prior && (scope === 'MANAGED_CREATION' ? prior.managed : prior.worktrees[record.worktreeId] === record.generation)
    if (!permission && !previouslyAuthorized) return { state: 'NOT_ENROLLED' as const }
    if (permission) assertUserOwned(join(profile, 'repositories/catalog.db'))
    const commonDirectory = nativeGitIdentity(catalogRoot).commonDirectory
    if (prior && (prior.catalogRoot !== catalogRoot || prior.commonDirectory !== commonDirectory)) throw new Error('HOOK_ENROLLMENT_SCOPE_CHANGED')
    if (nativeGitIdentity(record.path).commonDirectory !== commonDirectory) throw new Error('WORKTREE_MISMATCH')
    const nodePath = checkedExecutable(permission?.nodePath ?? prior!.nodePath)
    const clientPath = checkedExecutable(permission?.clientPath ?? prior!.clientPath)
    if (!qualifiedClient(provider, clientPath)) throw new Error('HOOK_CLIENT_UNQUALIFIED')
    const helperSource = permission?.helperContent
    const helperDigest = helperSource ? nativeDigest(helperSource) : prior!.helperDigest
    if (!/^[a-f0-9]{64}$/.test(helperDigest)) throw new Error('HOOK_HELPER_UNAVAILABLE')
    const helper = join(profile, 'session-context', 'native-hook-' + helperDigest + '.cjs')
    assertProfilePath(helper, profile)
    const helperRevision = revision(helper)
    if (helperRevision.content === null && helperSource) writeConfig(helper, profile, helperRevision, helperSource)
    if (nativeDigest(boundedFile(helper, 512 * 1024)) !== helperDigest) throw new Error('HOOK_COMMAND_DIGEST_MISMATCH')
    const targets = [record]
    if (provider === 'codex') {
      const main = dirname(commonDirectory)
      if (join(main, '.git') !== commonDirectory || nativeGitIdentity(main).root !== main) throw new Error('HOOK_MAIN_UNVERIFIABLE')
      if (main !== record.path) targets.unshift(await registry.resolveCheckout(main))
    }
    const statuses = []
    const worktrees = { ...prior?.worktrees }
    for (const target of targets) {
      const selected = await registry.resolveCheckout(target.path)
      if (availableCatalogRoot(db, repositoryId) !== catalogRoot ||
          nativeGitIdentity(selected.path).commonDirectory !== commonDirectory ||
          selected.worktreeId !== target.worktreeId || selected.generation !== target.generation ||
          db.prepare('SELECT value FROM repository_catalog_meta WHERE key=?').get(enrollmentKey(repositoryId, provider))?.value !== previous) throw new Error('HOOK_ENROLLMENT_SCOPE_CHANGED')
      installNativeHooks({ repositoryId, record: selected, commandPath: helper, nodePath, provider, authorized: true })
      const status = inspectNativeInstallation(selected.path, { repositoryId, ...selected }, process.platform, provider)
      if (status.state !== 'CONFIGURED') throw new Error(status.reasonCode)
      statuses.push({ worktreeId: selected.worktreeId, installation: status.state, handlers: status.installed })
      worktrees[selected.worktreeId] = selected.generation
    }
    const next: Enrollment = { catalogRoot, commonDirectory, nodePath, clientPath, helperDigest, managed: permission?.managed ?? prior!.managed, worktrees }
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

export async function prepareEnrolledNativeHooks(selection: Omit<Selection, 'provider'>, scope: ReconciliationScope) {
  const results = []
  for (const provider of nativeHookProviders) {
    try { results.push({ provider, state: (await enrollNativeHooks({ ...selection, provider }, undefined, scope)).state }) }
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
    const { handlers: _private, ...installation } = inspectNativeInstallation(record.path, { repositoryId, ...record }, process.platform, provider)
    return { installation, enrolled: grant?.catalogRoot === root && grant.worktrees[record.worktreeId] === record.generation,
      discovery: 'NOT_INSPECTED', trust: 'NOT_INSPECTED' }
  } finally { db.close() }
}
