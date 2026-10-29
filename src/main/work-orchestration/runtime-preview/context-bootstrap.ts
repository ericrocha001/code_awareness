import { readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { GitService } from '../../core/git-service'
import { GitWorktreeRegistry } from '../../git-operations/git-worktree-registry'
import { normalizeRepositoryPath } from '../../repository-catalog/repository-catalog-service'
import { bytesFingerprint, previewProfileSchema, previewFingerprint } from '../preview-profile'
import { previewContextManifest } from './context-contract'
import { expectedCorpusSchema, previewCatalogPath, previewCorpusPath, validateCorpus } from './context-data'

export async function validatePreviewContext(raw: unknown, input: { sessionId: string; profile: string; approvedProfile: unknown; directory: string; worktree: string }) {
  const parsed = previewContextManifest.safeParse(raw)
  if (!parsed.success) throw new Error('PREVIEW_CONTEXT_MANIFEST_INVALID')
  const context = parsed.data, { selection, source, data } = context
  const profile = previewProfileSchema.safeParse(input.approvedProfile)
  if (!profile.success || profile.data.profileId !== selection.profileId || profile.data.revision !== context.profileRevision || profile.data.repositoryId !== selection.repositoryId ||
    previewFingerprint(profile.data) !== selection.fingerprint || previewFingerprint(profile.data.bootstrap) !== previewFingerprint(context.policy) || profile.data.adapter?.kind !== 'ELECTRON') throw new Error('PREVIEW_CONTEXT_PROFILE_MISMATCH')
  if (context.sessionId !== input.sessionId || selection.fingerprint !== input.profile || context.worktree.toLowerCase() !== input.worktree.toLowerCase() ||
    context.policy.dataPolicy !== data.policy || data.repositoryId !== selection.repositoryId || (data.policy === 'EMPTY') !== (data.origin === 'EMPTY')) throw new Error('PREVIEW_CONTEXT_IDENTITY_MISMATCH')
  const git = new GitService(), registry = new GitWorktreeRegistry(input.worktree, git, { repositoryId: selection.repositoryId, isActive: () => true })
  const verifyGit = async () => {
    const snapshot = await git.captureWorktreeReadSnapshot(input.worktree), identity = await registry.current(snapshot)
    if (identity.worktreeId !== selection.worktreeId || identity.generation !== selection.generation || realpathSync(identity.path).toLowerCase() !== input.worktree.toLowerCase() || identity.locked || identity.detached || identity.prunable || identity.missing) throw new Error('PREVIEW_WORKTREE_IDENTITY_MISMATCH')
    if (snapshot.head !== source.head || snapshot.branch !== source.branch || snapshot.indexRevision !== source.indexRevision || snapshot.worktreeRevision !== source.worktreeRevision || snapshot.operation) throw new Error('PREVIEW_SOURCE_CHANGED_BEFORE_BOOT')
  }
  try { await verifyGit() } catch (error) {
    if (error instanceof Error && /^PREVIEW_[A-Z_]+$/.test(error.message)) throw error
    throw new Error('PREVIEW_GIT_IDENTITY_UNAVAILABLE')
  }
  const userData = join(input.directory, 'userData'), catalogFile = previewCatalogPath(userData), corpus = previewCorpusPath(userData, selection.repositoryId)
  for (const file of data.policy === 'ARTIFACT_FIRST' ? [catalogFile] : [catalogFile, corpus]) if (realpathSync(file).toLowerCase() !== file.toLowerCase()) throw new Error('PREVIEW_DATA_PATH_ESCAPED')
  if (bytesFingerprint(readFileSync(catalogFile)) !== context.catalogDigest || (data.policy !== 'ARTIFACT_FIRST' && bytesFingerprint(readFileSync(corpus)) !== data.digest)) throw new Error('PREVIEW_DATA_DIGEST_MISMATCH')
  const catalog = new Database(catalogFile, { readonly: true, fileMustExist: true })
  try {
    const rows = catalog.prepare('SELECT id,checkout_path,normalized_checkout_path,status,availability,git_state FROM repository_catalog_records').all() as Array<Record<string, string>>
    if (rows.length !== 1 || rows[0].id !== selection.repositoryId || realpathSync(rows[0].checkout_path).toLowerCase() !== input.worktree.toLowerCase() || rows[0].normalized_checkout_path !== normalizeRepositoryPath(input.worktree) || rows[0].status !== 'ACTIVE' || rows[0].availability !== 'AVAILABLE' || rows[0].git_state !== 'GIT') throw new Error('PREVIEW_CATALOG_IDENTITY_MISMATCH')
    if (catalog.pragma('quick_check', { simple: true }) !== 'ok' || (catalog.prepare('SELECT count(*) AS n FROM repository_catalog_github_links').get() as { n: number }).n) throw new Error('PREVIEW_CATALOG_INVALID')
  } finally { catalog.close() }
  if (data.policy === 'ARTIFACT_FIRST') { await verifyGit(); return context }
  const db = new Database(corpus, { readonly: true, fileMustExist: true })
  try {
    const expected = expectedCorpusSchema(input.directory, selection.repositoryId)
    if (expected !== data.schema) throw new Error('PREVIEW_DATA_SCHEMA_INCOMPATIBLE')
    const counts = validateCorpus(db, selection.repositoryId, context.policy, expected)
    if (counts.artifacts !== data.artifacts || counts.media !== data.media || counts.bytes !== data.bytes || (data.policy === 'EMPTY' && (counts.artifacts || counts.media))) throw new Error('PREVIEW_DATA_RECEIPT_MISMATCH')
  } finally { db.close() }
  await verifyGit()
  return context
}
