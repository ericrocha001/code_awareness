import { z } from 'zod'
import { digest } from './privacy'
import type { SessionStore } from './store'
import type { SessionTargetSelection } from './target'

export interface AuthorizedCodexArchiveConnection {
  repositoryId: string
  accountIdentity: string
  version: string
  supports: { archived: boolean; cwd: boolean }
  request(method: 'thread/list', params: { archived: true; cwd: string; limit: number; cursor?: string }, signal: AbortSignal): Promise<unknown>
}
export interface ArchiveObservation {
  code: 'ARCHIVE_PROVIDER_UNAVAILABLE' | 'ARCHIVE_PROVIDER_ERROR' | 'ARCHIVE_OBSERVED' | 'ARCHIVE_INDEX_PARTIAL'
  reason?: 'CAPACITY_REACHED' | 'SOURCE_IDENTITY_CONFLICT'
  sessions: { id: string; createdAt?: number; updatedAt?: number }[]
  providerVersion?: string
  accountHash?: string
  nextCursor?: string
}
export async function queryCodexArchive(connection: AuthorizedCodexArchiveConnection | undefined, repositoryId: string, root: string, signal: AbortSignal, cursor?: string): Promise<ArchiveObservation> {
  const unavailable: ArchiveObservation = { code: 'ARCHIVE_PROVIDER_UNAVAILABLE', sessions: [] }
  if (!connection || connection.repositoryId !== repositoryId || !connection.accountIdentity || !connection.version || !connection.supports.archived || !connection.supports.cwd) return unavailable
  try {
    const raw = await connection.request('thread/list', { archived: true, cwd: root, limit: 20, ...(cursor ? { cursor } : {}) }, signal)
    if (signal.aborted) return unavailable
    if (Buffer.byteLength(JSON.stringify(raw)) > 128 * 1024) throw new Error('ARCHIVE_RESPONSE_LIMIT')
    const response = z.object({ data: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/), cwd: z.literal(root),
      createdAt: z.number().int().nonnegative().max(253402300799).optional(), updatedAt: z.number().int().nonnegative().max(253402300799).optional() }).passthrough()).max(20), nextCursor: z.string().max(512).nullable().optional() }).passthrough().parse(raw)
    return { code: 'ARCHIVE_OBSERVED', sessions: response.data.map(row => ({ id: row.id, createdAt: row.createdAt, updatedAt: row.updatedAt })),
      accountHash: digest(connection.accountIdentity), providerVersion: connection.version, ...(response.nextCursor ? { nextCursor: response.nextCursor } : {}) }
  } catch { return { code: 'ARCHIVE_PROVIDER_ERROR', sessions: [] } }
}
export function persistArchiveObservation(store: SessionStore, observation: ArchiveObservation, target: SessionTargetSelection, assertCurrent: () => void): void {
  if (observation.code !== 'ARCHIVE_OBSERVED' || !observation.providerVersion || !observation.accountHash) return
  for (const row of observation.sessions) {
    assertCurrent()
    const existing = store.byProvider(row.id, 'codex')
    if (existing && store.associations(existing.id, 100).some(link => link.providerAccountHash && link.providerAccountHash !== observation.accountHash)) throw new Error('SOURCE_IDENTITY_CONFLICT')
    const result = store.ingest({ provider: 'codex', providerSessionId: row.id, providerVersion: observation.providerVersion, agent: 'codex', state: 'UNKNOWN',
      startedAt: row.createdAt === undefined ? undefined : new Date(row.createdAt * 1000).toISOString(), importState: 'METADATA_ONLY', coverage: 'PARTIAL',
      coverageReasons: { TRANSCRIPT_NOT_IMPORTED: 1 }, sourceDigest: digest(JSON.stringify(row)), sourceBytes: 0 }, [], assertCurrent)
    store.recordAssociation({ repositoryId: store.repositoryId, sessionId: result.sessionId, provider: 'codex', providerSessionId: row.id, ...target,
      evidence: 'WORKTREE_VERIFIED', origin: 'CODEX_APP_SERVER', archived: true, providerAccountHash: observation.accountHash }, store.catalogRevision(), assertCurrent)
  }
}
