import type { CommandRunner } from './entire-provider'
import type { SessionStore } from './store'
import type { SessionRow } from './types'
import { entireAgent } from './entire-schema'
import { validateCheckpointId } from './checkpoint'

export interface CheckpointTranscriptSource { kind: 'ENTIRE_CHECKPOINT'; checkpointId: string; refRevision: string; sessionIndex: number; blob: string; agent: string; providerSessionId: string }
export async function checkpointTranscriptSource(store: SessionStore, session: SessionRow, runner: CommandRunner, root: string, assertCurrent: () => void): Promise<CheckpointTranscriptSource | undefined> {
  const identity = store.registry.sessionIdentity(session.id)
  if (!identity) return
  const graph = store.registry.contextGraph(identity)
  const ids = new Set(graph.nodes.filter(node => node.type === 'CHECKPOINT').map(node => node.id))
  for (const checkpointId of ids) {
    validateCheckpointId(checkpointId)
    const ref = 'refs/entire/checkpoints/' + checkpointId.slice(-2) + '/' + checkpointId
    const read = async (args: string[], limit = 32768) => {
      assertCurrent()
      const result = await runner('git', ['-c', 'core.fsmonitor=false', '--no-replace-objects', ...args], root, limit)
      assertCurrent()
      if (result.code !== 0 || result.limited) throw new Error('SOURCE_UNAVAILABLE')
      return result.text.trim()
    }
    const revision = await read(['rev-parse', '--verify', ref], 4096)
    if (!/^[a-f0-9]{40,64}$/.test(revision)) throw new Error('SOURCE_IDENTITY_CONFLICT')
    const top = JSON.parse(await read(['cat-file', '-p', revision + ':metadata.json']))
    if (top.cli_version !== '0.12.2' || top.checkpoint_id !== checkpointId || !Array.isArray(top.sessions)) throw new Error('PROVIDER_SCHEMA_UNSUPPORTED')
    for (let index = 0; index < top.sessions.length; index++) {
      const metadata = JSON.parse(await read(['cat-file', '-p', `${revision}:${index}/metadata.json`]))
      if (metadata.session_id !== session.providerSessionId || entireAgent(metadata.agent) !== session.agent) continue
      if (metadata.cli_version !== '0.12.2' || metadata.checkpoint_id !== checkpointId) throw new Error('SOURCE_IDENTITY_CONFLICT')
      const blob = await read(['rev-parse', '--verify', `${revision}:${index}/full.jsonl`], 4096)
      if (!/^[a-f0-9]{40,64}$/.test(blob) || await read(['cat-file', '-t', blob], 4096) !== 'blob') throw new Error('SOURCE_IDENTITY_CONFLICT')
      if (await read(['rev-parse', '--verify', ref], 4096) !== revision) throw new Error('SOURCE_REVISION_CHANGED')
      return { kind: 'ENTIRE_CHECKPOINT', checkpointId, refRevision: revision, sessionIndex: index, blob, agent: session.agent, providerSessionId: session.providerSessionId }
    }
  }
}
