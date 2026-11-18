import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { desktopProfilePaths } from '../desktop-profile'
import { boundedFile, nativeDigest, nativeGitCommitToolPattern, nativeGitIdentity, sameNativePath, type NativeHookBinding, type NativeHookProvider } from './native-hooks'

export interface NativeHookEnrollment {
  scope?: 'USER' | 'CHECKOUT'
  catalogRoot: string
  commonDirectory: string
  worktrees: Record<string, string>
  managed: boolean
  externalPreparation?: boolean
  gitCommitTool?: string
  helperDigest?: string
  nodePath: string
  clientPath: string
}

export interface UserHookProfile {
  schema: 1
  enabled: boolean
  codexHome?: string
  configHome?: string
  configPath: string
  helperDigest: string
  nodePath: string
  runAsNode?: boolean
  cmdWrapperPath?: string
  clientPath?: string
  clientVersion?: string
  autoEnrollNewProjects: boolean
  gitCommitTool?: string
  updatedAt: string
}
export type UserCodexHookProfile = UserHookProfile

export function enrollmentKey(repositoryId: string, provider: NativeHookProvider): string {
  return 'native-hooks:' + repositoryId + ':' + provider
}

export function profileIntegrationKey(provider: NativeHookProvider = 'codex'): string {
  return 'native-hooks-profile:' + provider
}

export function openNativeHookCatalog(profile: string, readOnly: boolean): DatabaseSync {
  const path = desktopProfilePaths(profile).repositoryCatalogPath
  if (!lstatSync(path).isFile() || !sameNativePath(realpathSync(path), resolve(path))) throw new Error('HOOK_CATALOG_UNAVAILABLE')
  const sqlite = require('node:sqlite') as typeof import('node:sqlite')
  const db = new sqlite.DatabaseSync(path, { readOnly })
  db.exec('PRAGMA busy_timeout=100')
  return db
}

export function availableCatalogRoot(db: DatabaseSync, repositoryId: string): string {
  const row = db.prepare(`SELECT checkout_path FROM repository_catalog_records
    WHERE id=? AND status='ACTIVE' AND availability='AVAILABLE' AND git_state='GIT'`).get(repositoryId)
  if (typeof row?.checkout_path !== 'string') throw new Error('HOOK_REPOSITORY_UNAVAILABLE')
  const root = realpathSync(row.checkout_path)
  if (!sameNativePath(root, resolve(row.checkout_path))) throw new Error('HOOK_REPOSITORY_UNAVAILABLE')
  return root
}

export function readNativeEnrollment(db: DatabaseSync, repositoryId: string, provider: NativeHookProvider): NativeHookEnrollment | undefined {
  const row = db.prepare('SELECT value FROM repository_catalog_meta WHERE key=?').get(enrollmentKey(repositoryId, provider))
  if (!row) return
  if (typeof row.value !== 'string') throw new Error('HOOK_ENROLLMENT_INVALID')
  const value = JSON.parse(row.value) as Partial<NativeHookEnrollment>
  if ((value.scope !== undefined && value.scope !== 'USER' && value.scope !== 'CHECKOUT') ||
    typeof value.catalogRoot !== 'string' || typeof value.commonDirectory !== 'string' || typeof value.clientPath !== 'string' ||
    typeof value.nodePath !== 'string' || typeof value.managed !== 'boolean' || !value.worktrees ||
    (value.externalPreparation !== undefined && typeof value.externalPreparation !== 'boolean') ||
    (value.helperDigest !== undefined && (typeof value.helperDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.helperDigest))) ||
    (value.gitCommitTool !== undefined && (provider !== 'codex' || typeof value.gitCommitTool !== 'string' || !nativeGitCommitToolPattern.test(value.gitCommitTool))) ||
    typeof value.worktrees !== 'object' || Array.isArray(value.worktrees)) throw new Error('HOOK_ENROLLMENT_INVALID')
  return value as NativeHookEnrollment
}

export function readUserHookProfile(db: DatabaseSync, provider: NativeHookProvider = 'codex'): UserHookProfile | undefined {
  const row = db.prepare('SELECT value FROM repository_catalog_meta WHERE key=?').get(profileIntegrationKey(provider))
  if (!row) return
  if (typeof row.value !== 'string') throw new Error('HOOK_PROFILE_INVALID')
  const value = JSON.parse(row.value) as Partial<UserHookProfile>
  const effectiveHome = value.configHome ?? value.codexHome
  if (value.schema !== 1 || typeof value.enabled !== 'boolean' || typeof effectiveHome !== 'string' || !effectiveHome ||
    typeof value.configPath !== 'string' ||
    typeof value.helperDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.helperDigest) || typeof value.nodePath !== 'string' ||
    (value.runAsNode !== undefined && typeof value.runAsNode !== 'boolean') ||
    (value.cmdWrapperPath !== undefined && typeof value.cmdWrapperPath !== 'string') ||
    (value.clientPath !== undefined && typeof value.clientPath !== 'string') ||
    (value.clientVersion !== undefined && typeof value.clientVersion !== 'string') ||
    typeof value.autoEnrollNewProjects !== 'boolean' ||
    (value.gitCommitTool !== undefined && (provider !== 'codex' || typeof value.gitCommitTool !== 'string' || !nativeGitCommitToolPattern.test(value.gitCommitTool))) ||
    typeof value.updatedAt !== 'string') throw new Error('HOOK_PROFILE_INVALID')
  return value as UserHookProfile
}

export function readUserCodexProfile(db: DatabaseSync, provider: NativeHookProvider = 'codex'): UserHookProfile | undefined {
  return readUserHookProfile(db, provider)
}

export function distributedHelperIdentity(helper: string) {
  const directory = dirname(helper)
  const digest = /^native-hook-([a-f0-9]{64})\.cjs$/.exec(basename(helper))?.[1]
  if (!digest || !sameNativePath(directory, join(dirname(directory), 'session-context')) ||
    !sameNativePath(realpathSync(helper), resolve(helper)) || lstatSync(helper).nlink !== 1 || nativeDigest(boundedFile(helper, 512 * 1024)) !== digest) throw new Error('HOOK_HELPER_UNAVAILABLE')
  return { profile: dirname(directory), digest }
}

export function authorizeDistributedBinding(helper: string, binding: NativeHookBinding): void {
  const { profile, digest } = distributedHelperIdentity(helper)
  const db = openNativeHookCatalog(profile, true)
  try {
    const provider = binding.provider ?? 'codex'
    const root = availableCatalogRoot(db, binding.repositoryId)
    const enrollment = readNativeEnrollment(db, binding.repositoryId, provider)
    if (binding.scope === 'USER') {
      const profileIntegration = readUserHookProfile(db, provider)
      if (!profileIntegration?.enabled || profileIntegration.helperDigest !== digest || !binding.configPath ||
        !sameNativePath(profileIntegration.configPath, binding.configPath)) throw new Error('HOOK_ENROLLMENT_REQUIRED')
    }
    if (enrollment?.catalogRoot !== root || enrollment.commonDirectory !== binding.commonDirectory ||
        (enrollment.helperDigest !== undefined && enrollment.helperDigest !== digest) ||
        (provider === 'codex' && enrollment.gitCommitTool !== binding.gitCommitTool) ||
        enrollment.worktrees[binding.worktreeId] !== binding.generation ||
        nativeGitIdentity(root).commonDirectory !== binding.commonDirectory) throw new Error('HOOK_ENROLLMENT_REQUIRED')
  } finally { db.close() }
}

export function resolveEnrolledRepositoryByCommonDir(
  db: DatabaseSync,
  commonDirectory: string,
  helperDigest: string,
  provider: NativeHookProvider = 'codex'
): { repositoryId: string; catalogRoot: string; enrollment: NativeHookEnrollment } | undefined {
  const rows = db.prepare(`SELECT id, checkout_path FROM repository_catalog_records
    WHERE status='ACTIVE' AND availability='AVAILABLE' AND git_state='GIT'`).all() as Array<{ id: string; checkout_path: string }>
  for (const row of rows) {
    try {
      if (typeof row.checkout_path !== 'string') continue
      const root = realpathSync(row.checkout_path)
      if (!sameNativePath(root, resolve(row.checkout_path))) continue
      const enrollment = readNativeEnrollment(db, row.id, provider)
      if (!enrollment || !enrollment.externalPreparation) continue
      if (enrollment.catalogRoot !== root || enrollment.commonDirectory !== commonDirectory) continue
      if (enrollment.helperDigest !== undefined && enrollment.helperDigest !== helperDigest) continue
      if (nativeGitIdentity(root).commonDirectory !== commonDirectory) continue
      return { repositoryId: row.id, catalogRoot: root, enrollment }
    } catch {}
  }
  return undefined
}
