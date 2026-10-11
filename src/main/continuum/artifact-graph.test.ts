import { afterEach, expect, it } from 'vitest'
import { ArtifactStore } from './artifact-store'
import { fixture, markdown, withFixtureDatabase } from './continuum-test-fixtures'
import { extractArtifactReferences, REFERENCE_INDEX_VERSION } from './artifact-references'
import { ContinuumService } from './continuum-service'

const A = 'artifact-11111111-1111-4111-8111-111111111111'
const B = 'artifact-22222222-2222-4222-8222-222222222222'
const C = 'artifact-33333333-3333-4333-8333-333333333333'
const closes: (() => void)[] = []
afterEach(() => { for (const close of closes.reverse()) close(); closes.length = 0 })
function setup(repositoryId = 'catalog-A') { const f = fixture(repositoryId); closes.push(f.close); return f }
function input(artifactId: string, body = 'Body', extra = {}) {
  return { artifactId, rawMarkdown: markdown('Document', '', body), metadata: { name: 'Document', description: 'Light document', kind: 'DOCUMENT', ...extra } }
}

it('extracts only exact document references, excluding frontmatter, fenced and indented examples for all line endings', () => {
  for (const newline of ['\n', '\r\n', '\r']) {
    const text = ['\uFEFF---', `description: ${C}`, '---', `See [plan](${B}) and \`${A}\`, ${B}.`, '````ts', C, '```', C, '````', '~~~', C, '~~~', '> ```', '> ' + C, '> ```', '- ```', C, '```', `    ${C}`, `\t${C}`, `x${C} ${C}suffix ${C}-bad ${C}_bad`, 'artifact-not-a-real-id'].join(newline)
    expect(extractArtifactReferences(text)).toEqual([A, B])
  }
})

it('resolves forward references without touching exact Markdown/hash/revision or legacy declared relations', () => {
  const { store, path } = setup()
  const original = store.create(input(A, `See ${B}, ${B}, self ${A}, unknown ${C}`))
  expect(store.graph({ artifactIds: [A] }).edges).toEqual([])
  store.create(input(B))
  const graph = store.graph({ artifactIds: [A], expand: true, direction: 'outbound' })
  expect(graph.nodes.map(n => n.artifactId)).toEqual([A, B])
  expect(graph.edges).toEqual([{ sourceId: A, targetId: B, kind: 'references', nature: 'DERIVED', origin: 'explicit-artifact-reference', sourceRevision: 1, sourceHash: original.contentHash }])
  expect(store.get(A)).toEqual(original)
  expect(store.list({ relatedToArtifactId: B }).artifacts).toEqual([])
  withFixtureDatabase(path, db => {
    expect(db.prepare('SELECT count(*) AS n FROM artifact_relations').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT count(*) AS n FROM artifact_revisions WHERE artifact_id = ?').get(A)).toEqual({ n: 1 })
  })
})

it('preserves provenance and direction, includes isolated nodes and virtual execution membership without false semantics', () => {
  const { store } = setup()
  store.create(input(B, 'Body', { executionId: 'run' }))
  store.create(input(C, 'Isolated', { executionId: 'run' }))
  store.create(input(A, `See ${B}`, { executionId: 'run', relations: [{ artifactId: B, kind: 'implements' }] }))
  const graph = store.graph({ artifactIds: [B], expand: true, direction: 'inbound' })
  expect(graph.edges.map(e => [e.kind, e.nature])).toEqual([['implements', 'DECLARED'], ['references', 'DERIVED']])
  expect(graph.executionGroups).toEqual([{ executionId: 'run', memberIds: [B, A], totalMembers: 3 }])
  expect(store.graph({ artifactIds: [C] }).nodes[0].relationCount).toBe(0)
  expect(store.graph({ artifactIds: [B], expand: true, direction: 'outbound' }).nodes).toHaveLength(1)
  expect(store.graph({ artifactIds: [B], expand: true, relationKind: 'implements' }).edges).toHaveLength(1)
  expect(store.list({ relatedToArtifactId: B, direction: 'inbound' }).artifacts.map(a => a.artifactId)).toEqual([A])
})

it('invalidates changed text, revision guards, rollback and stale CAS across real SQLite connections', () => {
  const { store, path } = setup()
  store.create(input(B))
  const original = store.create(input(A, B))
  const revision = store.graph().revision
  const second = new ArtifactStore(path, 'catalog-A'); closes.push(() => second.close())
  expect(() => store.update({ ...input(A, C, { relations: [{ artifactId: C, kind: 'implements' }] }), expectedRevision: 1 })).toThrow(/INVALID_RELATION/)
  expect(store.graph().revision).toBe(revision)
  expect(store.get(A)).toEqual(original)
  store.update({ ...input(A, 'Removed'), expectedRevision: 1 })
  expect(second.graph().edges).toEqual([])
  expect(() => second.graph({ expectedRevision: revision })).toThrow(/GRAPH_REVISION_CONFLICT/)
  expect(() => second.update({ ...input(A, B), expectedRevision: 1 })).toThrow(/REVISION_CONFLICT/)
  expect(store.graph().edges).toEqual([])
})

it('backfills legacy indexes in capped idempotent batches without adding history or changing artifacts', () => {
  const { store, path } = setup()
  store.importArtifact('transport', input(A, B))
  store.importArtifact('transport', input(B))
  const before = [store.get(A), store.get(B)]
  withFixtureDatabase(path, db => { db.prepare('DELETE FROM artifact_reference_sources').run() }, false)
  expect(store.backfillReferences(1)).toEqual({ processed: 1, pending: true })
  expect(store.backfillReferences(1)).toEqual({ processed: 1, pending: false })
  const revision = store.graph().revision
  expect(store.backfillReferences()).toEqual({ processed: 0, pending: false })
  expect(store.graph().revision).toBe(revision)
  expect(store.graph().edges).toHaveLength(1)
  expect([store.get(A), store.get(B)]).toEqual(before)
  store.close()
  const reopened = new ArtifactStore(path, 'catalog-A'); closes.push(() => reopened.close())
  expect(reopened.graph().edges).toHaveLength(1)
})

it('produces the same graph for reversed creation order and isolates repositories', () => {
  const first = setup(); const second = setup('catalog-B')
  first.store.create(input(A, B)); first.store.create(input(B))
  second.store.create(input(B)); second.store.create(input(A, B))
  expect(first.store.graph().edges).toEqual(second.store.graph().edges)
  const isolated = setup('catalog-C'); isolated.store.create(input(A, B))
  expect(isolated.store.graph().edges).toEqual([])
  expect(() => isolated.store.graph({ artifactIds: [B] })).toThrow(/ARTIFACT_NOT_FOUND/)
})

it('caps synthetic corpus, expansion, edges and groups with lightweight metadata only', () => {
  const { store } = setup()
  store.create(input(A))
  const start = Date.now()
  for (let i = 0; i < 1000; i++) store.create(input('node-' + i, A, { executionId: 'run' }))
  const graph = store.graph({ artifactIds: [A], expand: true, direction: 'inbound', nodeLimit: 20, edgeLimit: 5 })
  expect(graph.nodes).toHaveLength(20)
  expect(graph.edges).toHaveLength(5)
  expect(graph.truncated).toEqual({ nodes: true, edges: true })
  expect(graph.executionGroups[0].totalMembers).toBe(1000)
  expect(JSON.stringify(graph)).not.toMatch(/rawMarkdown|contentHash|Body|data:image/)
  expect(JSON.stringify(graph).length).toBeLessThan(15000)
  expect(Date.now() - start).toBeLessThan(15000)
  expect(store.graph({ kind: 'DOCUMENT', nodeLimit: 2 }).truncated.nodes).toBe(true)
})

it('validates graph query boundaries and rejects service results after context changes', () => {
  const { store } = setup()
  for (const query of [{ nodeLimit: 101 }, { edgeLimit: 501 }, { artifactIds: Array(101).fill(A) }, { expand: 'yes' }, { direction: 'sideways' }, { expectedRevision: -1 }, { artifactIds: [A], kind: 'DOCUMENT' }]) expect(() => store.graph(query as never)).toThrow()
  let active = true
  const service = new ContinuumService(store, () => { active = false }, () => active)
  expect(() => service.graph()).toThrow(/REPOSITORY_CONTEXT_CHANGED/)
})

it('reports partial legacy freshness until bounded backfill has completed and exposes later batches', () => {
  const { store, path } = setup()
  store.create(input(B))
  for (let i = 0; i < 105; i++) store.create(input('legacy-' + i, B))
  withFixtureDatabase(path, db => { db.prepare('DELETE FROM artifact_reference_sources').run() }, false)
  expect(store.graph({ artifactIds: [B] }).freshness).toBe('BACKFILL_PENDING')
  const completed = store.graph({ artifactIds: [B] })
  expect(completed.freshness).toBe('CURRENT')
  expect(completed.nodes[0].incomingDegree).toBe(105)
  expect(store.backfillReferences()).toEqual({ processed: 0, pending: false })
})

it('filters edge direction relative to seeds even when opposite edges share the same neighborhood', () => {
  const { store } = setup()
  store.create(input(A, B)); store.create(input(B, A))
  expect(store.graph({ artifactIds: [A], expand: true, direction: 'outbound' }).edges.map(e => e.sourceId)).toEqual([A])
  expect(store.graph({ artifactIds: [A], expand: true, direction: 'inbound' }).edges.map(e => e.targetId)).toEqual([A])
})

it('migrates an older persisted view atomically, hides stale references and preserves documents across idempotent reopen', () => {
  const { store, path } = setup()
  store.create(input(B))
  store.create(input(A, B, { relations: [{ artifactId: B, kind: 'implements' }] }))
  for (let i = 0; i < 105; i++) store.create(input('legacy-' + i, B))
  const originals = [store.get(A), store.get(B)]
  const previousRevision = store.graph().revision
  store.close()
  withFixtureDatabase(path, db => {
    const view = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'artifact_graph_edges'").get() as { sql: string }
    db.transaction(() => {
      db.exec('DROP VIEW artifact_graph_edges')
      db.exec(view.sql.replace(`s.resolver_version = ${REFERENCE_INDEX_VERSION}`, `s.resolver_version = ${REFERENCE_INDEX_VERSION - 1}`))
      db.prepare('UPDATE artifact_reference_sources SET resolver_version = ?').run(REFERENCE_INDEX_VERSION - 1)
    })()
  }, false)
  const reopened = withFixtureDatabase(path, db => {
    const existingReader = db.prepare("SELECT count(*) AS n FROM artifact_graph_edges WHERE nature = 'DERIVED'")
    expect(existingReader.get()).toEqual({ n: 106 })
    const current = new ArtifactStore(path, 'catalog-A')
    closes.push(() => current.close())
    expect(existingReader.get()).toEqual({ n: 0 })
    return current
  })
  withFixtureDatabase(path, db => {
    expect(db.prepare("SELECT count(*) AS n FROM artifact_graph_edges WHERE nature = 'DERIVED'").get()).toEqual({ n: 0 })
    expect(db.prepare("SELECT count(*) AS n FROM artifact_graph_edges WHERE nature = 'DECLARED'").get()).toEqual({ n: 1 })
    expect((db.prepare('SELECT revision FROM artifact_graph_state').get() as { revision: number }).revision).toBeGreaterThan(previousRevision)
  })
  const partial = reopened.graph({ artifactIds: [A, B] })
  expect(partial.freshness).toBe('BACKFILL_PENDING')
  expect(partial.edges.map(edge => edge.nature)).toEqual(['DECLARED', 'DERIVED'])
  withFixtureDatabase(path, db => {
    expect(db.prepare(`SELECT count(*) AS n FROM artifact_graph_edges e JOIN artifact_reference_sources s ON e.source_id = s.source_id
      WHERE e.nature = 'DERIVED' AND s.resolver_version <> ?`).get(REFERENCE_INDEX_VERSION)).toEqual({ n: 0 })
  })
  const complete = reopened.graph({ artifactIds: [B] })
  expect(complete.freshness).toBe('CURRENT')
  expect(complete.nodes[0].incomingDegree).toBe(107)
  expect([reopened.get(A), reopened.get(B)]).toEqual(originals)
  expect(() => reopened.graph({ expectedRevision: previousRevision })).toThrow(/GRAPH_REVISION_CONFLICT/)
  const stableSchema = withFixtureDatabase(path, db => db.pragma('schema_version', { simple: true }))
  const concurrent = new ArtifactStore(path, 'catalog-A'); closes.push(() => concurrent.close())
  expect(concurrent.graph().revision).toBe(complete.revision)
  expect(reopened.graph().revision).toBe(complete.revision)
  expect(withFixtureDatabase(path, db => db.pragma('schema_version', { simple: true }))).toBe(stableSchema)
  withFixtureDatabase(path, db => {
    expect(db.prepare('SELECT count(*) AS n FROM artifact_revisions').get()).toEqual({ n: 107 })
  })
})

it('rolls back view replacement and graph revision together when schema reconciliation fails', () => {
  const { store, path } = setup()
  store.create(input(B)); store.create(input(A, B))
  const original = store.get(A)
  const revision = store.graph().revision
  store.close()
  const oldDefinition = withFixtureDatabase(path, db => {
    const view = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'artifact_graph_edges'").get() as { sql: string }
    const older = view.sql.replace(`s.resolver_version = ${REFERENCE_INDEX_VERSION}`, `s.resolver_version = ${REFERENCE_INDEX_VERSION - 1}`)
    db.exec('DROP VIEW artifact_graph_edges')
    db.exec(older)
    db.exec("CREATE TRIGGER reject_graph_migration BEFORE UPDATE ON artifact_graph_state BEGIN SELECT RAISE(ABORT, 'migration rejected'); END")
    return older
  }, false)
  expect(() => new ArtifactStore(path, 'catalog-A')).toThrow(/migration rejected/)
  withFixtureDatabase(path, db => {
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'artifact_graph_edges'").get()).toEqual({ sql: oldDefinition })
    expect(db.prepare('SELECT revision FROM artifact_graph_state').get()).toEqual({ revision })
    db.exec('DROP TRIGGER reject_graph_migration')
  }, false)
  const reopened = new ArtifactStore(path, 'catalog-A'); closes.push(() => reopened.close())
  expect(reopened.get(A)).toEqual(original)
  expect(reopened.graph().edges).toHaveLength(1)
})
