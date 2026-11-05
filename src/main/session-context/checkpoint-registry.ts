import type Database from 'better-sqlite3'
import { digest } from './privacy'
import { sessionIdentity, sessionSelector } from './session-identity'

export type EntityKind = 'COMMIT' | 'CHECKPOINT' | 'SESSION' | 'PR' | 'ARTIFACT' | 'PROOF' | 'WORKTREE' | 'EXECUTION'
export interface RegistryEntity { kind: EntityKind; id: string }
export interface RegistryEdge {
  from: RegistryEntity; relation: string; to: RegistryEntity
  evidenceKind: string; evidenceRef: string; digest: string; freshness: string
}
export interface RegistryBatch {
  repositoryId: string; source: string; revision: string; status: string
  cursor?: string; edges: RegistryEdge[]; entities?: RegistryEntity[]
}
export type RegistryReader = (request: { selector?: RegistryEntity; cursors: Record<string, string> }) => Promise<RegistryBatch[]>
type ObservedEdge = RegistryEdge & { sourceSystem: string; sourceRevision: string; observedAt: string; state: string }
export const REGISTRY_SCHEMA = `
 CREATE TABLE IF NOT EXISTS registry_entities(id TEXT PRIMARY KEY, kind TEXT NOT NULL, externalId TEXT NOT NULL, localSessionId TEXT, UNIQUE(kind,externalId));
 CREATE TABLE IF NOT EXISTS registry_edges(id TEXT PRIMARY KEY, source TEXT NOT NULL, sourceRevision TEXT NOT NULL,
   fromId TEXT NOT NULL REFERENCES registry_entities(id), toId TEXT NOT NULL REFERENCES registry_entities(id),
   payload TEXT NOT NULL, integrity TEXT NOT NULL, observedAt TEXT NOT NULL, state TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS registry_from ON registry_edges(fromId,state);
 CREATE INDEX IF NOT EXISTS registry_to ON registry_edges(toId,state);
 CREATE INDEX IF NOT EXISTS registry_source ON registry_edges(source,sourceRevision);
 CREATE TABLE IF NOT EXISTS registry_sources(source TEXT PRIMARY KEY, revision TEXT NOT NULL, cursor TEXT, status TEXT NOT NULL, observedAt TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS checkpoint_registry(checkpointId TEXT NOT NULL, refRevision TEXT NOT NULL, state TEXT NOT NULL, digest TEXT NOT NULL, sessionIds TEXT NOT NULL, integrity TEXT NOT NULL,
   observedAt TEXT NOT NULL, PRIMARY KEY(checkpointId,refRevision));
`
const kinds: EntityKind[] = ['COMMIT', 'CHECKPOINT', 'SESSION', 'PR', 'ARTIFACT', 'PROOF', 'WORKTREE', 'EXECUTION']
export class CheckpointRegistry {
  constructor(private readonly db: Database.Database, readonly repositoryId: string) {}
  directEvidence(entity: RegistryEntity, evidenceKind: string): RegistryEdge[] {
    const key = this.key(entity)
    const rows = this.db.prepare("SELECT payload,integrity FROM registry_edges WHERE (fromId=? OR toId=?) AND state='OBSERVED' ORDER BY id LIMIT 65").all(key, key) as { payload: string; integrity: string }[]
    if (rows.length > 64) throw new Error('REGISTRY_EVIDENCE_LIMIT')
    return rows.map(row => {
      if (digest(row.payload) !== row.integrity) throw new Error('REGISTRY_INTEGRITY_FAILED')
      return JSON.parse(row.payload) as RegistryEdge
    }).filter(edge => edge.evidenceKind === evidenceKind)
  }
  nativeSessions(offset: number, limit: number): { provider: string; providerSessionId: string; agent: string; origin: string; aliasState: string; deepen: object }[] {
    const rows = this.db.prepare("SELECT externalId FROM registry_entities WHERE kind='SESSION' AND externalId LIKE 'codex-native:%' ORDER BY externalId LIMIT ? OFFSET ?").all(limit, offset) as { externalId: string }[]
    return rows.map(row => ({ provider: 'codex-native', providerSessionId: row.externalId.slice(13), agent: 'codex', origin: 'NATIVE_HOOK', aliasState: 'NOT_RECONCILED',
      deepen: { tool: 'discover_execution_context', arguments: { selector: { type: 'SESSION', provider: 'codex-native', id: row.externalId.slice(13) } } } }))
  }
  readSnapshot<T>(read: () => T): T { return this.db.transaction(read).deferred() }
  key(entity: RegistryEntity): string {
    if (!kinds.includes(entity.kind) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,399}$/.test(entity.id)) throw new Error('INVALID_REGISTRY_ENTITY')
    return `${entity.kind}:${this.repositoryId}:${entity.id}`
  }
  sources(): { source: string; revision: string; cursor?: string; status: string; observedAt: string }[] {
    return this.db.prepare('SELECT * FROM registry_sources ORDER BY observedAt DESC,source LIMIT 20').all() as ReturnType<CheckpointRegistry['sources']>
  }
  source(source: string): ReturnType<CheckpointRegistry['sources']>[number] | undefined { return this.db.prepare('SELECT * FROM registry_sources WHERE source=?').get(source) as ReturnType<CheckpointRegistry['source']> }
  cursors(): Record<string, string> { return Object.fromEntries((this.db.prepare('SELECT source,cursor FROM registry_sources WHERE cursor IS NOT NULL ORDER BY observedAt DESC LIMIT 100').all() as { source: string; cursor: string }[]).map(s => [s.source, s.cursor])) }
  applyAll(batches: RegistryBatch[], assertCurrent: () => void): void {
    this.db.transaction(() => {
      for (const batch of batches) this.apply(batch, this.source(batch.source)?.revision, assertCurrent)
      assertCurrent()
    }).immediate()
  }
  apply(batch: RegistryBatch, expectedRevision: string | undefined, assertCurrent: () => void = () => {}): void {
    if (batch.repositoryId !== this.repositoryId) throw new Error('REPOSITORY_MISMATCH')
    if (!/^[A-Za-z0-9:._-]{1,500}$/.test(batch.source) || batch.revision.length > 500 || batch.edges.length > 200 || (batch.entities?.length ?? 0) > 100 || (batch.cursor?.length ?? 0) > 4096) throw new Error('REGISTRY_BATCH_LIMIT')
    this.db.transaction(() => {
      assertCurrent()
      const old = this.db.prepare('SELECT revision FROM registry_sources WHERE source=?').get(batch.source) as { revision: string } | undefined
      if (old?.revision !== expectedRevision) throw new Error('REVISION_CONFLICT')
      const observedAt = new Date().toISOString()
      const entity = (value: RegistryEntity) => {
        const id = this.key(value)
        this.db.prepare('INSERT OR IGNORE INTO registry_entities(id,kind,externalId) VALUES(?,?,?)').run(id, value.kind, value.id)
        return id
      }
      for (const value of batch.entities ?? []) entity(value)
      for (const edge of batch.edges) {
        if (!/^[A-Za-z0-9:_-]{1,100}$/.test(edge.relation) || !/^[A-Z_]{1,80}$/.test(edge.evidenceKind) || edge.evidenceRef.length > 500 || !/^[a-f0-9]{64}$/.test(edge.digest) || !/^[A-Z_]{1,80}$/.test(edge.freshness)) throw new Error('INVALID_REGISTRY_EVIDENCE')
        const from = entity(edge.from), to = entity(edge.to)
        const payload = JSON.stringify(edge), integrity = digest(payload)
        const id = digest(JSON.stringify([this.repositoryId, batch.source, batch.revision, integrity]))
        const existing = this.db.prepare('SELECT payload,integrity FROM registry_edges WHERE id=?').get(id) as { payload: string; integrity: string } | undefined
        if (existing && (existing.payload !== payload || existing.integrity !== integrity)) throw new Error('REGISTRY_INTEGRITY_FAILED')
        this.db.prepare('INSERT OR IGNORE INTO registry_edges VALUES(?,?,?,?,?,?,?,?,?)').run(id, batch.source, batch.revision, from, to, payload, integrity, observedAt, 'OBSERVED')
        this.db.prepare("UPDATE registry_edges SET state='OBSERVED' WHERE id=?").run(id)
      }
      if (batch.status === 'COMPLETE') {
        this.db.prepare('UPDATE registry_edges SET state=? WHERE source=? AND sourceRevision<>? AND state=?').run('SUPERSEDED', batch.source, batch.revision, 'OBSERVED')
      }
      if (batch.status === 'CHECKPOINT_NOT_OBSERVED') this.db.prepare('UPDATE registry_edges SET state=? WHERE source=? AND state=?').run('STALE', batch.source, 'OBSERVED')
      if (batch.status === 'CONFLICT') this.db.prepare('UPDATE registry_edges SET state=? WHERE source=? AND state=?').run('CONFLICT', batch.source, 'OBSERVED')
      if (/^GITHUB:PR:[0-9]+$/.test(batch.source) && ['PARTIAL', 'COMPLETE'].includes(batch.status)) this.db.prepare("UPDATE registry_edges SET state='STALE' WHERE source LIKE ? AND sourceRevision<>? AND state='OBSERVED'").run(batch.source + ':%', batch.revision)
      this.db.prepare(`INSERT INTO registry_sources VALUES(?,?,?,?,?) ON CONFLICT(source) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor,status=excluded.status,observedAt=excluded.observedAt`).run(batch.source, batch.revision, batch.cursor ?? null, batch.status, observedAt)
      assertCurrent()
    }).immediate()
  }
  checkpoint(id: string, revision: string, state: string, hash: string, sessionIds: string[], sessionRefs?: { id: string; agent: string }[]): void {
    this.key({ kind: 'CHECKPOINT', id })
    const payload = JSON.stringify(sessionRefs ? { sessionIds, sessionRefs } : sessionIds), integrity = digest(JSON.stringify([id, revision, state, hash, payload]))
    this.db.prepare('INSERT OR IGNORE INTO checkpoint_registry VALUES(?,?,?,?,?,?,?)').run(id, revision, state, hash, payload, integrity, new Date().toISOString())
  }
  cachedCheckpoint(id: string, revision: string): { state: 'VERIFIED'; reason: string; checkpointId: string; refRevision: string; metadataDigest: string; sessionIds: string[]; sessionRefs?: { id: string; agent: string }[] } | undefined {
    const row = this.db.prepare("SELECT * FROM checkpoint_registry WHERE checkpointId=? AND refRevision=? AND state='VERIFIED'").get(id, revision) as { digest: string; sessionIds: string; integrity: string } | undefined
    if (!row) return
    if (digest(JSON.stringify([id, revision, 'VERIFIED', row.digest, row.sessionIds])) !== row.integrity) throw new Error('REGISTRY_INTEGRITY_FAILED')
    const payload = JSON.parse(row.sessionIds), sessionIds = Array.isArray(payload) ? payload : payload.sessionIds
    if (!Array.isArray(sessionIds) || sessionIds.length > 20 || sessionIds.some(s => typeof s !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(s))) throw new Error('REGISTRY_INTEGRITY_FAILED')
    if (payload.sessionRefs && (!Array.isArray(payload.sessionRefs) || payload.sessionRefs.length > 20 || payload.sessionRefs.some((item: { id: unknown; agent: unknown }) => typeof item.id !== 'string' || !sessionIds.includes(item.id) || typeof item.agent !== 'string' || !/^[a-z][a-z0-9-]{0,79}$/.test(item.agent)))) throw new Error('REGISTRY_INTEGRITY_FAILED')
    return { state: 'VERIFIED', reason: 'VERIFIED', checkpointId: id, refRevision: revision, metadataDigest: row.digest, sessionIds, ...(payload.sessionRefs ? { sessionRefs: payload.sessionRefs } : {}) }
  }
  importedSession(provider: string, providerId: string, sessionId: string, agent?: string): void {
    const entity: RegistryEntity = this.sessionIdentity(sessionId) ?? { kind: 'SESSION', id: sessionIdentity(provider, providerId, agent) }
    this.db.prepare('INSERT INTO registry_entities(id,kind,externalId,localSessionId) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET localSessionId=excluded.localSessionId').run(this.key(entity), entity.kind, entity.id, sessionId)
  }
  evictedSession(id: string): boolean { return !!this.db.prepare("SELECT 1 FROM registry_entities WHERE kind='SESSION' AND localSessionId=? LIMIT 1").get(id) }
  sessionIdentity(id: string): RegistryEntity | undefined {
    const row = this.db.prepare("SELECT externalId FROM registry_entities WHERE kind='SESSION' AND localSessionId=? LIMIT 1").get(id) as { externalId: string } | undefined
    return row ? { kind: 'SESSION', id: row.externalId } : undefined
  }
  visible(entity: RegistryEntity, accountHash?: string): boolean {
    if (entity.kind !== 'SESSION' || !entity.id.startsWith('codex:')) return true
    if (!accountHash) {
      const archived = this.db.prepare("SELECT a.payload,a.integrity FROM sessions s JOIN session_associations a ON a.sessionId=s.id WHERE s.provider='codex' AND s.providerSessionId=? AND s.importState='METADATA_ONLY' AND s.eventCount=0 AND s.payloadBytes=0 AND json_extract(a.payload,'$.origin')='CODEX_APP_SERVER' AND json_extract(a.payload,'$.archived')=1 LIMIT 1").get(entity.id.slice(6)) as { payload: string; integrity: string } | undefined
      if (!archived) return false
      if (digest(archived.payload) !== archived.integrity || JSON.parse(archived.payload).repositoryId !== this.repositoryId) throw new Error('ASSOCIATION_INTEGRITY_ERROR')
      return true
    }
    const row = this.db.prepare("SELECT payload,integrity FROM session_associations WHERE provider='codex' AND providerSessionId=? AND json_extract(payload,'$.providerAccountHash')=? LIMIT 1").get(entity.id.slice(6), accountHash) as { payload: string; integrity: string } | undefined
    if (row && (digest(row.payload) !== row.integrity || JSON.parse(row.payload).repositoryId !== this.repositoryId)) throw new Error('ASSOCIATION_INTEGRITY_ERROR')
    return !!row
  }
  contextGraph(selector: RegistryEntity, accountHash?: string) {
    type Node = { key: string; type: EntityKind; id: string; provider?: string; agent?: string; payloadState?: string; selector?: object; deepen?: { tool: string; arguments: object } }
    type Edge = { id: string; from: string; to: string; relation: string; evidenceKind: string; source: string; state: string; freshness: string; observedAt: string; sourceRevision: string; evidenceRef: string; digest: string }
    const nodes = new Map<string, Node>(), edges = new Map<string, Edge>(), paths: { target: string; edges: string[] }[] = []
    let bounded = false
    const add = (entity: RegistryEntity) => {
      const key = this.key(entity)
      if (nodes.has(key)) return key
      const node: Node = { key, type: entity.kind, id: entity.id }
      if (entity.kind === 'SESSION') {
        const row = this.db.prepare('SELECT localSessionId FROM registry_entities WHERE id=?').get(key) as { localSessionId: string | null } | undefined
        Object.assign(node, sessionSelector(entity.id))
        node.payloadState = !row?.localSessionId ? 'NOT_IMPORTED' : this.db.prepare('SELECT 1 FROM sessions WHERE id=?').get(row.localSessionId) ? 'IMPORTED' : 'SESSION_EVICTED'
        if (row?.localSessionId) node.deepen = { tool: 'inspect_agent_session', arguments: { sessionId: row.localSessionId } }
      } else if (entity.kind === 'ARTIFACT') node.deepen = { tool: 'get_artifact', arguments: { artifactId: entity.id } }
      else if (entity.kind === 'PROOF') node.deepen = { tool: 'get_validation_proof', arguments: { proofId: entity.id } }
      else if (entity.kind === 'CHECKPOINT') node.deepen = { tool: 'inspect_entire_checkpoint', arguments: { checkpointId: entity.id } }
      if (entity.kind !== 'WORKTREE') node.selector = { type: node.type, id: node.id, ...(node.provider ? { provider: node.provider } : {}), ...(node.agent ? { agent: node.agent } : {}) }
      nodes.set(key, node); return key
    }
    if (!this.visible(selector, accountHash) || !this.db.prepare('SELECT 1 FROM registry_entities WHERE id=?').get(this.key(selector))) return { nodes: [], edges: [], paths, bounded }
    const initial = add(selector), visited = new Set([initial]), pending = [{ entity: selector, path: [] as string[] }]
    for (let depth = 0; depth < 4 && pending.length; depth++) {
      const level = pending.splice(0)
      for (const item of level) {
        const key = this.key(item.entity)
        const rows = this.db.prepare("SELECT * FROM registry_edges WHERE fromId=? OR toId=? ORDER BY CASE WHEN state='OBSERVED' THEN 0 ELSE 1 END,id LIMIT 65").all(key, key) as { id: string; payload: string; integrity: string; fromId: string; toId: string; source: string; sourceRevision: string; state: string; observedAt: string }[]
        if (rows.length > 64) bounded = true
        for (const row of rows.slice(0, 64)) {
          if (edges.size >= 96) { bounded = true; break }
          const value = JSON.parse(row.payload) as RegistryEdge
          if (digest(row.payload) !== row.integrity || this.key(value.from) !== row.fromId || this.key(value.to) !== row.toId) throw new Error('REGISTRY_INTEGRITY_FAILED')
          if (!this.visible(value.from, accountHash) || !this.visible(value.to, accountHash)) continue
          if (value.from.kind === 'ARTIFACT' && value.to.kind === 'ARTIFACT' && !['implements', 'resolved-by'].includes(value.relation)) continue
          if (!['CHECKPOINT_VERIFIED', 'CHECKPOINT_SESSION_METADATA', 'GITHUB_COMMIT_LIST', 'CONTINUUM_TYPED_RELATION', 'LEDGER_EVIDENCE_FOR', 'HANDOFF_DECLARED', 'WORKTREE_VERIFIED', 'PROVIDER_OBSERVED', 'NATIVE_HOOK_OBSERVED', 'NATIVE_GIT_CAUSAL', 'NATIVE_GIT_SCOPE', 'NATIVE_GIT_REQUEST'].includes(value.evidenceKind)) continue
          const from = add(value.from), to = add(value.to)
          const state = row.state === 'CONFLICT' ? 'UNKNOWN' : row.state !== 'OBSERVED' || value.freshness === 'SOURCE_STALE' ? 'STALE' : value.evidenceKind === 'HANDOFF_DECLARED' ? 'DECLARED' : ['NATIVE_HOOK_OBSERVED','NATIVE_GIT_REQUEST','NATIVE_GIT_SCOPE'].includes(value.evidenceKind) ? 'OBSERVED' : 'VERIFIED'
          edges.set(row.id, { id: row.id, from, to, relation: value.relation, evidenceKind: value.evidenceKind, source: row.source.split(':')[0], state, freshness: value.freshness, observedAt: row.observedAt, sourceRevision: row.sourceRevision, evidenceRef: value.evidenceRef, digest: value.digest })
          const next = from === key ? value.to : value.from, target = this.key(next)
          if (!visited.has(target)) {
            visited.add(target); const path = [...item.path, row.id]; paths.push({ target, edges: path })
            if (row.state === 'OBSERVED') pending.push({ entity: next, path })
          }
        }
      }
    }
    if (pending.length) bounded = true
    return { nodes: [...nodes.values()], edges: [...edges.values()], paths, bounded }
  }
  map(selector: RegistryEntity, maxEdges = 24) {
    const start = this.key(selector), found = new Map<string, ObservedEdge>(), visited = new Set([start]), frontier = [start]
    let truncated = false
    for (let depth = 0; depth < 6 && frontier.length; depth++) {
      const level = frontier.splice(0)
      for (const node of level) {
        const rows = this.db.prepare('SELECT * FROM registry_edges WHERE fromId=? OR toId=? ORDER BY state,observedAt DESC,id LIMIT ?').all(node, node, maxEdges + 1) as { id: string; payload: string; integrity: string; fromId: string; toId: string; source: string; sourceRevision: string; state: string; observedAt: string }[]
        for (const row of rows) {
          const evidence = JSON.parse(row.payload) as RegistryEdge
          if (digest(row.payload) !== row.integrity || this.key(evidence.from) !== row.fromId || this.key(evidence.to) !== row.toId || !['OBSERVED', 'SUPERSEDED', 'STALE', 'CONFLICT'].includes(row.state)) throw new Error('REGISTRY_INTEGRITY_FAILED')
          if (found.has(row.id)) continue
          if (found.size === maxEdges) { truncated = true; continue }
          found.set(row.id, { ...JSON.parse(row.payload), sourceSystem: row.source, sourceRevision: row.sourceRevision, observedAt: row.observedAt, state: row.state })
          if (row.state !== 'OBSERVED') continue
          for (const id of [row.fromId, row.toId]) if (!visited.has(id)) { visited.add(id); frontier.push(id) }
        }
      }
    }
    return { repositoryId: this.repositoryId, selector, coverage: truncated || frontier.length ? 'PARTIAL' : 'OBSERVED_SNAPSHOT',
      reason: found.size ? 'RELATIONS_OBSERVED' : selector.kind === 'COMMIT' ? 'CHECKPOINT_NOT_OBSERVED' : 'NO_RELATION_OBSERVED',
      edges: [...found.values()], sessions: [...new Set([...found.values()].flatMap(edge => [edge.from, edge.to]).filter(entity => entity.kind === 'SESSION').map(entity => entity.id))].map(id => {
        const entity = this.db.prepare('SELECT localSessionId FROM registry_entities WHERE id=?').get(this.key({ kind: 'SESSION', id })) as { localSessionId: string | null }
        return { providerIdentity: id, ...(entity?.localSessionId ? { sessionId: entity.localSessionId } : {}), payloadState: !entity?.localSessionId ? 'NOT_IMPORTED' : this.db.prepare('SELECT 1 FROM sessions WHERE id=?').get(entity.localSessionId) ? 'IMPORTED' : 'SESSION_EVICTED' }
      }), sources: this.sources(), authorship: 'NOT_INFERRED' }
  }
  legacy(assertCurrent: () => void): void {
    const imported = this.source('IMPORTED_SESSIONS'), sessionAfter = Number(imported?.cursor ?? 0)
    const sessions = this.db.prepare('SELECT rowid AS position,id,provider,providerSessionId,agent FROM sessions WHERE rowid>? ORDER BY rowid LIMIT 20').all(sessionAfter) as { position: number; id: string; provider: string; providerSessionId: string; agent: string }[]
    if (sessions.length) this.db.transaction(() => {
      assertCurrent()
      for (const session of sessions) this.importedSession(session.provider, session.providerSessionId, session.id, session.agent)
      const cursor = String(sessions.at(-1)!.position)
      this.apply({ repositoryId: this.repositoryId, source: 'IMPORTED_SESSIONS', revision: cursor, cursor, status: 'PARTIAL', edges: [] }, imported?.revision, assertCurrent)
    }).immediate()
    const previous = this.source('LEGACY'), after = Number(previous?.cursor ?? 0)
    const rows = this.db.prepare('SELECT rowid AS position,payload,integrity FROM session_associations WHERE rowid>? ORDER BY rowid LIMIT 20').all(after) as { position: number; payload: string; integrity: string }[]
    if (!rows.length) return
    const edges: RegistryEdge[] = []
    for (const row of rows) {
      if (digest(row.payload) !== row.integrity) throw new Error('ASSOCIATION_INTEGRITY_FAILED')
      const a = JSON.parse(row.payload)
      const from: RegistryEntity = this.sessionIdentity(a.sessionId) ?? { kind: 'SESSION', id: `${a.provider}:${a.providerSessionId}` }
      const target: [EntityKind, unknown][] = [['ARTIFACT', a.sourceArtifactId], ['ARTIFACT', a.artifactId], ['COMMIT', a.commitSha], ['PR', a.pullRequest], ['CHECKPOINT', a.checkpointId], ['EXECUTION', a.executionId]]
      for (const [kind, id] of target) if (id) edges.push({ from, relation: 'legacy-association', to: { kind, id: String(id) }, evidenceKind: a.evidence, evidenceRef: a.sourceArtifactId ?? a.checkpointId ?? 'legacy-origin', digest: row.integrity, freshness: 'HISTORICAL' })
    }
    const cursor = String(rows.at(-1)!.position)
    this.apply({ repositoryId: this.repositoryId, source: 'LEGACY', revision: cursor, cursor, status: 'PARTIAL', edges }, previous?.revision, assertCurrent)
  }
}
