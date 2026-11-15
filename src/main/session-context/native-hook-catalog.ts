import { lstatSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { desktopProfilePaths } from '../desktop-profile'
import { boundedFile, nativeDigest, nativeGitIdentity, type NativeHookBinding, type NativeHookProvider } from './native-hooks'

export interface NativeHookEnrollment {
  catalogRoot: string
  commonDirectory: string
  worktrees: Record<string, string>
  managed: boolean
  nodePath: string
  clientPath: string
}

export function enrollmentKey(repositoryId: string, provider: NativeHookProvider): string {
  return 'native-hooks:' + repositoryId + ':' + provider
}

export function openNativeHookCatalog(profile: string, readOnly: boolean): DatabaseSync {
  const path = desktopProfilePaths(profile).repositoryCatalogPath
  if (!lstatSync(path).isFile() || realpathSync(path) !== resolve(path)) throw new Error('HOOK_CATALOG_UNAVAILABLE')
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
  if (root !== resolve(row.checkout_path)) throw new Error('HOOK_REPOSITORY_UNAVAILABLE')
  return root
}

export function readNativeEnrollment(db: DatabaseSync, repositoryId: string, provider: NativeHookProvider): NativeHookEnrollment | undefined {
  const row = db.prepare('SELECT value FROM repository_catalog_meta WHERE key=?').get(enrollmentKey(repositoryId, provider))
  if (!row) return
  if (typeof row.value !== 'string') throw new Error('HOOK_ENROLLMENT_INVALID')
  const value = JSON.parse(row.value) as Partial<NativeHookEnrollment>
  if (typeof value.catalogRoot !== 'string' || typeof value.commonDirectory !== 'string' || typeof value.clientPath !== 'string' ||
    typeof value.nodePath !== 'string' || typeof value.managed !== 'boolean' || !value.worktrees ||
    typeof value.worktrees !== 'object' || Array.isArray(value.worktrees)) throw new Error('HOOK_ENROLLMENT_INVALID')
  return value as NativeHookEnrollment
}

export function authorizeDistributedBinding(helper: string, binding: NativeHookBinding): void {
  const directory = dirname(helper)
  const digest = /^native-hook-([a-f0-9]{64})\.cjs$/.exec(helper.slice(directory.length + 1))?.[1]
  if (!digest || directory !== join(dirname(directory), 'session-context') ||
    realpathSync(helper) !== resolve(helper) || lstatSync(helper).nlink !== 1 || nativeDigest(boundedFile(helper, 512 * 1024)) !== digest) throw new Error('HOOK_HELPER_UNAVAILABLE')
  const db = openNativeHookCatalog(dirname(directory), true)
  try {
    const root = availableCatalogRoot(db, binding.repositoryId)
    const enrollment = readNativeEnrollment(db, binding.repositoryId, binding.provider ?? 'codex')
    if (enrollment?.catalogRoot !== root || enrollment.commonDirectory !== binding.commonDirectory ||
        enrollment.worktrees[binding.worktreeId] !== binding.generation ||
        nativeGitIdentity(root).commonDirectory !== binding.commonDirectory) throw new Error('HOOK_ENROLLMENT_REQUIRED')
  } finally { db.close() }
}
