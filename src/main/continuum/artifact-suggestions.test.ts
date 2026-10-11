import { afterEach, expect, it } from 'vitest'
import { fixture, markdown, withFixtureDatabase } from './continuum-test-fixtures'
import { ContinuumService } from './continuum-service'
import { parseArtifactMarkdown } from './artifact-metadata'
import { countCanonicalTokens } from '../core/tokenizer'

const closes: (() => void)[] = []
afterEach(() => { for (const close of closes.reverse()) close(); closes.length = 0 })
function setup(repositoryId = 'catalog-A') { const f = fixture(repositoryId); closes.push(f.close); return f }
function document(artifactId: string, name: string, description = name, extra = {}) {
  return { artifactId, metadata: { name, description, kind: 'DOCUMENT', ...extra }, rawMarkdown: markdown(name, '', 'Private body must not be acquired') }
}

it('finds nearby Portuguese/English concepts without treating one misleading word as a connection', () => {
  const { store } = setup()
  store.create(document('source', 'Migração SQLite rollback', 'Transações para migracao persistente'))
  store.create(document('nearby', 'Migracao sqlite persistente', 'Rollback de transações'))
  store.create(document('noise', 'SQLite recipes', 'Sourdough dinner cookbook'))
  store.create(document('isolated', 'Jazz harmony', 'Piano acoustic music'))
  const result = store.suggestions({ artifactId: 'source' })
  expect(result.suggestions.map(s => s.targetArtifactId)).toEqual(['nearby'])
  expect(result.suggestions[0]).toMatchObject({ origin: 'SUGGESTED', proposedKind: 'related-to', reasons: expect.arrayContaining([{ signal: 'shared-terms', terms: expect.arrayContaining(['migracao', 'sqlite']) }]) })
  expect(result.ranking).toBe('RELATIVE_EVIDENCE')
  expect(JSON.stringify(result)).not.toMatch(/rawMarkdown|Private body|probability|confidence|contentHash/)
  store.create(document('english', 'Database migration rollback', 'Durable transaction storage'))
  store.create(document('english-nearby', 'Transaction migration rollback', 'Recover database storage'))
  expect(store.suggestions({ artifactId: 'english' }).suggestions.some(s => s.targetArtifactId === 'english-nearby')).toBe(true)
  expect(store.suggestions({ artifactId: 'isolated' }).suggestions).toEqual([])
})

it('explains shared execution/metadata without proposing strong relation kinds or persisting any truth', () => {
  const { store, path } = setup()
  store.create(document('source', 'Alpha', 'Planning', { executionId: 'run', subsystem: 'payments' }))
  store.create(document('target', 'Beta', 'Delivery', { executionId: 'run', subsystem: 'payments' }))
  const before = store.get('source')
  const revision = store.graph().revision
  const result = store.suggestions({ artifactId: 'source' })
  expect(result.suggestions[0]).toMatchObject({ targetArtifactId: 'target', proposedKind: 'related-to', reasons: expect.arrayContaining([{ signal: 'shared-execution', executionId: 'run' }, { signal: 'shared-metadata', key: 'subsystem', value: 'payments' }]) })
  expect(store.get('source')).toEqual(before)
  expect(store.graph().revision).toBe(revision)
  expect(store.graph().edges).toEqual([])
  expect(store.list().artifacts.every(a => a.relationCount === 0)).toBe(true)
  withFixtureDatabase(path, db => expect(db.prepare('SELECT count(*) AS n FROM artifact_revisions').get()).toEqual({ n: 2 }))
})

it('uses graph witnesses, deduplicates signals and excludes direct declared or derived connections in either direction', () => {
  const { store } = setup()
  const hub = 'artifact-11111111-1111-4111-8111-111111111111'
  store.create(document(hub, 'Hub'))
  store.create(document('source', 'Migration database', 'SQLite transaction', { relations: [{ artifactId: hub, kind: 'references' }] }))
  store.create(document('candidate', 'Database migration', 'SQLite transaction', { relations: [{ artifactId: hub, kind: 'validates' }] }))
  store.create(document('already', 'Migration database', 'SQLite transaction', { relations: [{ artifactId: 'source', kind: 'related-to' }] }))
  store.create({ ...document('derived', 'Migration database', 'SQLite transaction'), rawMarkdown: markdown('Derived', '', hub) })
  const result = store.suggestions({ artifactId: 'source' })
  expect(result.suggestions.filter(s => s.targetArtifactId === 'candidate')).toHaveLength(1)
  expect(result.suggestions.find(s => s.targetArtifactId === 'candidate')!.reasons).toContainEqual({ signal: 'shared-neighbor', artifactIds: [hub] })
  expect(result.suggestions.map(s => s.targetArtifactId)).not.toContain('already')
  expect(result.suggestions.map(s => s.targetArtifactId)).not.toContain(hub)
  store.update({ ...document('source', 'Migration database', 'SQLite transaction', { relations: [{ artifactId: 'candidate', kind: 'depends-on' }] }), expectedRevision: 1 })
  expect(store.suggestions({ artifactId: 'source' }).suggestions.map(s => s.targetArtifactId)).not.toContain('candidate')
})

it('promotes a consciously reviewed candidate only through existing CAS, preserving body and history', () => {
  const { service, store, path } = setup()
  const target = service.publish(markdown('SQLite migration rollback'))
  const source = service.publish(markdown('SQLite migration transaction', '', '# Literal ç 日本語\r\n${literal} `code`\r\n'))
  const initial = service.get(source.artifactId)!
  const result = service.suggestions({ artifactId: source.artifactId })
  expect(result.suggestions.some(s => s.targetArtifactId === target.artifactId)).toBe(true)
  const selected = service.get(target.artifactId)!
  expect(selected.metadata.name).toBe('SQLite migration rollback')
  const promoted = initial.rawMarkdown.replace('\n---\n', `\nrelations:\n  - artifactId: ${selected.artifactId}\n    kind: related-to\n---\n`)
  service.update(source.artifactId, initial.revision, promoted)
  expect(parseArtifactMarkdown(service.get(source.artifactId)!.rawMarkdown).body).toBe(parseArtifactMarkdown(initial.rawMarkdown).body)
  expect(service.suggestions({ artifactId: source.artifactId }).suggestions).toEqual([])
  expect(store.graph().edges).toMatchObject([{ nature: 'DECLARED', kind: 'related-to' }])
  expect(() => service.update(source.artifactId, initial.revision, promoted)).toThrow(/REVISION_CONFLICT/)
  withFixtureDatabase(path, db => expect(db.prepare('SELECT count(*) AS n FROM artifact_revisions WHERE artifact_id = ?').get(source.artifactId)).toEqual({ n: 2 }))
})

it('bounds candidate scoring and output over hundreds of candidates with deterministic ranking', () => {
  const { store } = setup()
  store.create(document('source', 'SQLite migration transaction', 'Durable rollback'))
  for (let i = 0; i < 500; i++) store.create(document('candidate-' + i, 'SQLite migration transaction', 'Durable rollback'))
  const started = Date.now()
  const first = store.suggestions({ artifactId: 'source', limit: 3 })
  expect(first.suggestions).toHaveLength(3)
  expect(first.limits).toMatchObject({ candidateLimit: 100, candidatesExamined: 100, topN: 3 })
  expect(first.truncated).toBe(true)
  expect(store.suggestions({ artifactId: 'source', limit: 3 })).toEqual(first)
  expect(JSON.stringify(first).length).toBeLessThan(4000)
  expect(Date.now() - started).toBeLessThan(10000)
  const queryMs = Date.now() - started
  const suggestionTokens = countCanonicalTokens(JSON.stringify(first)).tokenCount
  const manualDiscoveryTokens = countCanonicalTokens(JSON.stringify(store.list({ query: 'SQLite', limit: 100 }))).tokenCount
  expect(suggestionTokens).toBeLessThan(manualDiscoveryTokens)
  console.info(JSON.stringify({ observation: 'synthetic-suggestion-cost', documents: 501, candidatesExamined: first.limits.candidatesExamined, returned: first.suggestions.length, queryMs, suggestionTokens, manualDiscoveryTokens }))
})

it('isolates repositories and rejects stale source/graph revisions or inactive reconciliation results', () => {
  const first = setup(); const second = setup('catalog-B')
  first.store.create(document('source', 'SQLite migration rollback'))
  first.store.create(document('target', 'SQLite migration rollback'))
  second.store.create(document('source', 'SQLite migration rollback'))
  expect(second.store.suggestions({ artifactId: 'source' }).suggestions).toEqual([])
  expect(() => second.store.suggestions({ artifactId: 'target' })).toThrow(/ARTIFACT_NOT_FOUND/)
  const before = first.store.suggestions({ artifactId: 'source' })
  first.store.update({ ...document('source', 'Updated database context'), expectedRevision: 1 })
  expect(() => first.store.suggestions({ artifactId: 'source', expectedSourceRevision: before.sourceRevision })).toThrow(/REVISION_CONFLICT/)
  expect(() => first.store.suggestions({ artifactId: 'source', expectedGraphRevision: before.graphRevision })).toThrow(/GRAPH_REVISION_CONFLICT/)
  let active = true
  const guarded = new ContinuumService(first.store, () => { active = false }, () => active)
  expect(() => guarded.suggestions({ artifactId: 'source' })).toThrow(/REPOSITORY_CONTEXT_CHANGED/)
})

it('marks incomplete projections and surfaces index failure instead of claiming semantic certainty', () => {
  const { store, path } = setup()
  store.create(document('source', 'SQLite migration rollback'))
  store.create(document('target', 'SQLite migration rollback'))
  withFixtureDatabase(path, db => db.prepare('UPDATE artifact_reference_sources SET resolver_version = 0').run(), false)
  expect(store.suggestions({ artifactId: 'source' }).freshness).toBe('BACKFILL_PENDING')
  withFixtureDatabase(path, db => db.exec('DROP TABLE artifact_search'), false)
  expect(() => store.suggestions({ artifactId: 'source' })).toThrow(/artifact_search/)
})

it('rejects malformed queries and ignores non-discriminative metadata and common lexical noise', () => {
  const { store } = setup()
  store.create(document('source', 'Plano de implementação', 'System artifact document', { enabled: true }))
  for (let i = 0; i < 50; i++) store.create(document('generic-' + i, 'Implementation plan', 'Sistema documento', { enabled: true }))
  expect(store.suggestions({ artifactId: 'source' }).suggestions).toEqual([])
  for (const query of [null, [], {}, { artifactId: '' }, { artifactId: 'source', limit: 11 }, { artifactId: 'source', limit: '2' }, { artifactId: 'source', expectedGraphRevision: -1 }, { artifactId: 'source', includeBody: true }]) expect(() => store.suggestions(query as never)).toThrow(/INVALID_ARGUMENT/)
})

it('excludes direct derived links and rejects a source changed during reconciliation before scoring', () => {
  const { store } = setup()
  const sourceId = 'artifact-11111111-1111-4111-8111-111111111111'
  store.create(document(sourceId, 'SQLite migration rollback'))
  store.create({ ...document('linked', 'SQLite migration rollback'), rawMarkdown: markdown('Linked', '', sourceId) })
  expect(store.suggestions({ artifactId: sourceId }).suggestions).toEqual([])
  const previous = store.get(sourceId)!
  const service = new ContinuumService(store, () => { store.update({ ...document(sourceId, 'Changed database migration'), expectedRevision: 1 }) })
  expect(() => service.suggestions({ artifactId: sourceId, expectedSourceRevision: previous.revision })).toThrow(/REVISION_CONFLICT/)
})
