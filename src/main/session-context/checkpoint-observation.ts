import { createHash } from 'node:crypto'
import type { CommandRunner } from './entire-provider'
import { resolveCheckpointFromCommit, validateCheckpointId } from './checkpoint'
import { entireAgent } from './entire-schema'

export interface CheckpointObservation {
  state: 'VERIFIED' | 'PARTIAL' | 'MISSING' | 'UNAVAILABLE' | 'UNSUPPORTED' | 'PENDING'
  reason: string
  checkpointId?: string
  commitSha?: string
  refRevision?: string
  metadataDigest?: string
  sessionIds: string[]
  sessionRefs?: { id: string; agent: string }[]
}
export async function observeCheckpoint(runner: CommandRunner, root: string, query: { checkpointId?: string; commitSha?: string }, assertActive: () => void): Promise<CheckpointObservation> {
  let checkpointId = query.checkpointId
  const sessionIds: string[] = []
  const sessionRefs: { id: string; agent: string }[] = []
  const read = async (args: string[], limit = 32768) => {
    assertActive()
    const result = await runner('git', ['-c', 'core.fsmonitor=false', ...args], root, limit)
    assertActive()
    if (result.timedOut) throw new Error('PROVIDER_TIMEOUT')
    if (result.limited) throw new Error('CHECKPOINT_METADATA_LIMIT')
    return result
  }
  try {
    if (query.commitSha) {
      const resolved = await resolveCheckpointFromCommit(runner, root, query.commitSha, assertActive)
      if (checkpointId && checkpointId !== resolved.checkpointId) throw new Error('SOURCE_IDENTITY_CONFLICT')
      checkpointId = resolved.checkpointId
    }
    if (!checkpointId) throw new Error('CHECKPOINT_NOT_FOUND')
    validateCheckpointId(checkpointId)
    const ref = 'refs/entire/checkpoints/' + checkpointId.slice(-2) + '/' + checkpointId
    const resolved = await read(['rev-parse', '--verify', '--quiet', ref], 4096)
    const revision = resolved.text.trim()
    if (resolved.code !== 0 || !/^[a-f0-9]{40,64}$/.test(revision)) throw new Error('CHECKPOINT_NOT_FOUND')
    const metadata = await read(['cat-file', '-p', revision + ':metadata.json'])
    if (metadata.code !== 0) throw new Error('CHECKPOINT_METADATA_UNAVAILABLE')
    const top = JSON.parse(metadata.text)
    if (top.cli_version !== '0.12.2') return { state: 'UNSUPPORTED', reason: 'PROVIDER_SCHEMA_UNSUPPORTED', checkpointId, refRevision: revision, sessionIds }
    if (top.checkpoint_id !== undefined && top.checkpoint_id !== checkpointId) throw new Error('SOURCE_IDENTITY_CONFLICT')
    if (!Array.isArray(top.sessions)) throw new Error('CHECKPOINT_METADATA_INVALID')
    const hash = createHash('sha256').update(metadata.text)
    let omitted = 0
    for (let index = 0; index < Math.min(20, top.sessions.length); index++) {
      const item = await read(['cat-file', '-p', revision + ':' + index + '/metadata.json'])
      if (item.code !== 0) { omitted++; continue }
      hash.update(item.text)
      let session
      try { session = JSON.parse(item.text) } catch { omitted++; continue }
      if ((session.cli_version !== undefined && session.cli_version !== '0.12.2') || (session.checkpoint_id !== undefined && session.checkpoint_id !== checkpointId) ||
        typeof session.session_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(session.session_id)) { omitted++; continue }
      let agent: string
      try { agent = entireAgent(session.agent) } catch { omitted++; continue }
      if (sessionRefs.some(item => item.id === session.session_id && item.agent === agent)) { omitted++; continue }
      sessionRefs.push({ id: session.session_id, agent })
      if (!sessionIds.includes(session.session_id)) sessionIds.push(session.session_id)
    }
    const after = await read(['rev-parse', '--verify', '--quiet', ref], 4096)
    if (after.code !== 0 || after.text.trim() !== revision) return { state: 'PENDING', reason: 'CHECKPOINT_REF_CHANGED', checkpointId, sessionIds: [] }
    const partial = omitted > 0 || top.sessions.length > 20 || !sessionIds.length
    return { state: partial ? 'PARTIAL' : 'VERIFIED', reason: partial ? 'CHECKPOINT_METADATA_PARTIAL' : 'VERIFIED', checkpointId, commitSha: query.commitSha,
      refRevision: revision, metadataDigest: hash.digest('hex'), sessionIds, sessionRefs }
  } catch (error) {
    const reason = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'CHECKPOINT_METADATA_INVALID'
    if (['PROJECT_CONTEXT_CHANGED', 'WORKTREE_STALE', 'SESSION_CONTEXT_TIMEOUT'].includes(reason)) throw error
    return { state: reason === 'CHECKPOINT_NOT_FOUND' ? 'MISSING' : 'UNAVAILABLE', reason, checkpointId, commitSha: query.commitSha, sessionIds: [] }
  }
}
