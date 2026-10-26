import Database from 'better-sqlite3'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ArtifactStore } from '../../continuum/artifact-store'
import { inspectWebP } from '../../continuum/visual-media'
import { RepositoryCatalogStore } from '../../repository-catalog/repository-catalog-store'
import { normalizeRepositoryPath, type RepositoryCatalogService } from '../../repository-catalog/repository-catalog-service'
import { bytesFingerprint, previewFingerprint, type PreviewProfile } from '../preview-profile'
import { previewContextManifest, type PreviewContextManifest, type PreviewDataReceipt } from './context-contract'
import type { PreviewSelection, PreviewPreflight } from '../../../shared/types/runtime-preview-types'
import type { PreviewStartClock } from './start-timing'
import { startStage } from './start-timing'
import type { z } from 'zod'

export const previewCorpusPath = (userData: string, repositoryId: string) => join(userData, 'continuum', 'repositories', Buffer.from(repositoryId).toString('base64url'), 'continuum.db')
export const previewCatalogPath = (userData: string) => join(userData, 'repositories', 'catalog.db')
const openReadOnly = (file: string) => new Database(file, { readonly: true, fileMustExist: true })
const schema = (db: Database.Database) => previewFingerprint({ version: db.pragma('user_version', { simple: true }),
  objects: db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all() })

export function expectedCorpusSchema(directory: string, repositoryId: string): string {
  const file = join(directory, 'schema-' + randomUUID() + '.db')
  const store = new ArtifactStore(file, repositoryId); store.close()
  const db = openReadOnly(file)
  try { return schema(db) } finally { db.close(); for (const suffix of ['', '-wal', '-shm']) rmSync(file + suffix, { force: true }) }
}

export function validateCorpus(db: Database.Database, repositoryId: string, policy: NonNullable<PreviewProfile['bootstrap']>, expectedSchema: string) {
  try { return inspectCorpus(db, repositoryId, policy, expectedSchema) }
  catch (error) {
    if (error instanceof Error && /^PREVIEW_DATA_[A-Z_]+$/.test(error.message)) throw error
    throw new Error('PREVIEW_DATA_INTEGRITY_FAILED')
  }
}

function inspectCorpus(db: Database.Database, repositoryId: string, policy: NonNullable<PreviewProfile['bootstrap']>, expectedSchema: string) {
  if (schema(db) !== expectedSchema) throw new Error('PREVIEW_DATA_SCHEMA_INCOMPATIBLE')
  const scope = db.prepare('SELECT repository_id FROM repository_scope').all() as { repository_id: string }[]
  if (scope.length !== 1 || scope[0].repository_id !== repositoryId) throw new Error('PREVIEW_DATA_SCOPE_MISMATCH')
  const bytes = Number(db.pragma('page_count', { simple: true })) * Number(db.pragma('page_size', { simple: true }))
  const artifacts = Number((db.prepare('SELECT count(*) AS n FROM artifacts').get() as { n: number }).n)
  if (bytes > policy.maxBytes || artifacts > policy.maxArtifacts) throw new Error('PREVIEW_DATA_LIMIT_EXCEEDED')
  if (db.pragma('quick_check', { simple: true }) !== 'ok' || (db.pragma('foreign_key_check') as unknown[]).length) throw new Error('PREVIEW_DATA_INTEGRITY_FAILED')
  for (const row of db.prepare('SELECT raw_markdown,content_hash FROM artifacts').iterate() as Iterable<{ raw_markdown: string; content_hash: string }>) {
    if (bytesFingerprint(row.raw_markdown) !== row.content_hash) throw new Error('PREVIEW_DATA_CONTENT_CORRUPT')
  }
  for (const row of db.prepare('SELECT snapshot_json FROM artifact_revisions').iterate() as Iterable<{ snapshot_json: string }>) {
    const revision = JSON.parse(row.snapshot_json)
    if (typeof revision.rawMarkdown !== 'string' || bytesFingerprint(revision.rawMarkdown) !== revision.contentHash) throw new Error('PREVIEW_DATA_CONTENT_CORRUPT')
  }
  let media = 0
  for (const row of db.prepare('SELECT sha256,data,descriptor_json FROM visual_blobs').iterate() as Iterable<{ sha256: string; data: Buffer; descriptor_json: string }>) {
    const descriptor = JSON.parse(row.descriptor_json), dimensions = inspectWebP(row.data)
    if (bytesFingerprint(row.data) !== row.sha256 || descriptor.sha256 !== row.sha256 || descriptor.bytes !== row.data.length || dimensions.width !== descriptor.width || dimensions.height !== descriptor.height) throw new Error('PREVIEW_DATA_MEDIA_CORRUPT')
    media++
  }
  return { bytes, artifacts, media }
}

export interface PreviewContextProvisioner {
  prepare(input: { profile: PreviewProfile; selection: PreviewSelection; sessionId: string; directory: string; worktree: string; source: NonNullable<PreviewPreflight['snapshot']>; timing?: PreviewStartClock; signal?: AbortSignal }): Promise<PreviewContextManifest>
}

export class RepositoryPreviewContextProvisioner implements PreviewContextProvisioner {
  constructor(private readonly catalog: Pick<RepositoryCatalogService, 'resolveAvailable'>, private readonly continuumBase: string) {}

  private source(repositoryId: string) {
    const file = join(this.continuumBase, 'repositories', Buffer.from(repositoryId).toString('base64url'), 'continuum.db')
    if (!existsSync(file) || realpathSync(file).toLowerCase() !== resolve(file).toLowerCase()) throw new Error('PREVIEW_DATA_SOURCE_UNAVAILABLE')
    return file
  }

  quote(profile: PreviewProfile) {
    const policy = profile.bootstrap
    if (!policy) return null
    const repository = this.catalog.resolveAvailable(profile.repositoryId)
    if (policy.dataPolicy === 'EMPTY') return { repositoryId: repository.id, estimatedBytes: 0, artifacts: 0, ...policy }
    const source = this.source(repository.id)
    if (!existsSync(source) || lstatSync(source).isSymbolicLink()) throw new Error('PREVIEW_DATA_SOURCE_UNAVAILABLE')
    const db = openReadOnly(source)
    try {
      const scope = db.prepare('SELECT repository_id FROM repository_scope').get() as { repository_id: string } | undefined
      if (scope?.repository_id !== repository.id) throw new Error('PREVIEW_DATA_SCOPE_MISMATCH')
      return { repositoryId: repository.id, ...policy, estimatedBytes: Number(db.pragma('page_count', { simple: true })) * Number(db.pragma('page_size', { simple: true })),
        artifacts: Number((db.prepare('SELECT count(*) AS n FROM artifacts').get() as { n: number }).n) }
    } finally { db.close() }
  }

  async prepare(input: Parameters<PreviewContextProvisioner['prepare']>[0]): Promise<PreviewContextManifest> {
    const measure = <T>(stage: z.infer<typeof startStage>, work: () => T) => input.timing ? input.timing.measureSync(stage, work) : work()
    input.signal?.throwIfAborted()
    const { profile, selection, directory, sessionId, source } = input, policy = profile.bootstrap!
    if (!policy || profile.adapter?.kind !== 'ELECTRON' || profile.repositoryId !== selection.repositoryId) throw new Error('PREVIEW_CONTEXT_PROFILE_INVALID')
    const repository = this.catalog.resolveAvailable(selection.repositoryId)
    const worktree = realpathSync(input.worktree), userData = join(directory, 'userData')
    mkdirSync(userData, { recursive: true })
    const catalogFile = previewCatalogPath(userData), destination = previewCorpusPath(userData, repository.id)
    if (existsSync(catalogFile) || existsSync(destination)) throw new Error('PREVIEW_DATA_DESTINATION_EXISTS')
    const privateCatalog = new RepositoryCatalogStore(catalogFile)
    try { privateCatalog.provisionPreviewIdentity(repository.id, { name: repository.name, path: worktree, normalizedPath: normalizeRepositoryPath(worktree), status: 'ACTIVE', availability: 'AVAILABLE', gitState: 'GIT' }) }
    finally { privateCatalog.close() }
    mkdirSync(dirname(destination), { recursive: true })
    const expected = measure('context_validation', () => expectedCorpusSchema(directory, repository.id))
    if (policy.dataPolicy === 'EMPTY') { const store = new ArtifactStore(destination, repository.id); store.close() }
    else {
      const file = this.source(repository.id)
      if (resolve(file).toLowerCase() === resolve(destination).toLowerCase() || lstatSync(file).isSymbolicLink()) throw new Error('PREVIEW_DATA_SOURCE_INVALID')
      const db = openReadOnly(file)
      try {
        measure('context_validation', () => validateCorpus(db, repository.id, policy, expected))
        const backup = () => db.backup(destination, { progress: ({ totalPages }) => {
          input.signal?.throwIfAborted()
          if (totalPages * Number(db.pragma('page_size', { simple: true })) > policy.maxBytes) throw new Error('PREVIEW_DATA_LIMIT_EXCEEDED')
          return 128
        } })
        await (input.timing ? input.timing.measure('context_backup', backup) : backup())
      } finally { db.close() }
      const copy = new Database(destination)
      try {
        input.signal?.throwIfAborted()
        measure('context_validation', () => validateCorpus(copy, repository.id, policy, expected))
        measure('context_sanitize', () => copy.exec('DELETE FROM artifact_structure_key; DELETE FROM artifact_structure; DELETE FROM repository_locators; DELETE FROM transport_imports; DELETE FROM legacy_migrations;'))
        measure('context_vacuum', () => copy.exec('VACUUM;'))
        copy.pragma('wal_checkpoint(TRUNCATE)')
      } finally { copy.close() }
    }
    const db = openReadOnly(destination)
    let counts: ReturnType<typeof validateCorpus>
    try { counts = measure('context_validation', () => validateCorpus(db, repository.id, policy, expected)) } finally { db.close() }
    const data: PreviewDataReceipt = { policy: policy.dataPolicy, repositoryId: repository.id, origin: policy.dataPolicy === 'EMPTY' ? 'EMPTY' : 'HOST_REPOSITORY_CONTINUUM',
      at: new Date().toISOString(), schema: expected, digest: measure('context_digest', () => bytesFingerprint(readFileSync(destination))), ...counts }
    if (statSync(destination).size > policy.maxBytes) throw new Error('PREVIEW_DATA_LIMIT_EXCEEDED')
    return previewContextManifest.parse({ version: 1, mode: 'PREVIEW', sessionId, selection, profileRevision: profile.revision, worktree, source, policy, data,
      catalogDigest: measure('context_digest', () => bytesFingerprint(readFileSync(catalogFile))) })
  }
}
