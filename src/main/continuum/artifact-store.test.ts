import { afterEach, describe, expect, it } from 'vitest'
import { ArtifactStore, ArtifactRevisionConflictError, computeContentHash } from './artifact-store'
import { fixture, withFixtureDatabase } from './continuum-test-fixtures'
import type { CreateArtifactInput } from './continuum-types'
const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.reverse()) close(); cleanup.length = 0 })
function setup() { const f = fixture(); cleanup.push(f.close); return f }
function input(artifactId = 'A', overrides: Partial<CreateArtifactInput> = {}): CreateArtifactInput {
  return { artifactId, metadata: { name: 'Decision', description: 'Find the runtime decision', kind: 'DECISION', status: 'BLOCKED', executionId: 'execution-1', future: { level: 2, valid: true } },
    rawMarkdown: '# Decision\r\n\r\nUnicode ç 日本語 🚀 `code` ${literal}\r\n', createdAt: '2026-10-01T00:00:00.000Z', ...overrides }
}
describe('Repository Artifact Store', () => {
  it('discovers open scalar facets from indexes, preserves value types/counts and removes last occurrences after update', () => {
    const { store } = setup()
    const original = store.create(input('A', { metadata: { name: 'A', description: 'A', kind: 'CUSTOM', futureKey: 'blue', count: 4, enabled: false, nullKey: null, arrayKey: ['a'], objectKey: { x: 1 } } }))
    store.create(input('B', { metadata: { ...original.metadata, name: 'B', count: '4' } }))
    const facets = store.facets()
    expect(facets.find(f => f.key === 'futureKey')?.values).toEqual([{ value: 'blue', count: 2 }])
    expect(facets.find(f => f.key === 'count')?.values).toEqual(expect.arrayContaining([{ value: '4', count: 1 }, { value: 4, count: 1 }]))
    expect(facets.find(f => f.key === 'enabled')?.values).toEqual([{ value: false, count: 2 }])
    for (const excluded of ['name', 'description', 'relations', 'nullKey', 'arrayKey', 'objectKey']) expect(facets.map(f => f.key)).not.toContain(excluded)
    expect(store.list({ metadata: { futureKey: 'blue', count: 4 } }).artifacts.map(a => a.artifactId)).toEqual(['A'])
    expect(store.list({ metadata: { futureKey: 'blue', count: '4' } }).artifacts.map(a => a.artifactId)).toEqual(['B'])
    store.update({ artifactId: 'A', expectedRevision: 1, metadata: { name: 'A', description: 'A', kind: 'NEW', brandNew: true }, rawMarkdown: 'Changed' })
    store.update({ artifactId: 'B', expectedRevision: 1, metadata: { name: 'B', description: 'B', kind: 'NEW' }, rawMarkdown: 'Changed' })
    expect(store.facets().map(f => f.key)).toEqual(['brandNew', 'kind'])
  })
  it('persists exact bytes, central/extensible metadata and revision 1 across restart, rejecting a different repository identity', () => {
    const { store, path } = setup(); const created = store.create(input())
    expect(created.revision).toBe(1); expect(created.contentHash).toBe(computeContentHash(created.rawMarkdown))
    store.close(); const reopened = new ArtifactStore(path, 'catalog-A'); cleanup.push(() => reopened.close())
    expect(reopened.get('A')).toEqual(created)
    expect(Buffer.from(reopened.get('A')!.rawMarkdown)).toEqual(Buffer.from(input().rawMarkdown))
    expect(reopened.list({ metadata: { future: { valid: true, level: 2 } } }).artifacts).toHaveLength(1)
    expect(reopened.list({ metadata: { future: { level: 3 } } }).artifacts).toHaveLength(0)
    expect(() => new ArtifactStore(path, 'catalog-B')).toThrow(/REPOSITORY_SCOPE_MISMATCH/)
  })
  it('validates identity, central metadata and integrity without limiting semantic kind', () => {
    const { store } = setup(); store.create(input())
    expect(() => store.create(input())).toThrow(/IDENTITY_CONFLICT/)
    expect(() => store.create(input('bad', { contentHash: 'tampered' }))).toThrow(/INTEGRITY_ERROR/)
    expect(() => store.create(input('bad', { metadata: { name: 'x', kind: 'y' } }))).toThrow(/description/)
    expect(store.create(input('new', { metadata: { name: 'New', description: 'Future communication', kind: 'UNPLANNED_KIND' } })).metadata.kind).toBe('UNPLANNED_KIND')
  })
  it('keeps stable identity/createdAt, increments revision and protects immutable history against stale competing connections', () => {
    const { store, path } = setup(); const original = store.create(input())
    const second = new ArtifactStore(path, 'catalog-A'); cleanup.push(() => second.close())
    const updated = store.update({ artifactId: 'A', expectedRevision: 1, metadata: { ...original.metadata, status: 'VALIDATED' }, rawMarkdown: '# Improved' })
    expect(updated.artifactId).toBe(original.artifactId); expect(updated.createdAt).toBe(original.createdAt)
    expect(updated.updatedAt > original.updatedAt).toBe(true); expect(updated.revision).toBe(2)
    expect(() => second.update({ artifactId: 'A', expectedRevision: 1, metadata: original.metadata, rawMarkdown: 'stale' })).toThrow(ArtifactRevisionConflictError)
    expect(store.get('A')).toEqual(updated)
    withFixtureDatabase(path, db => {
      const revisions = db.prepare('SELECT snapshot_json FROM artifact_revisions ORDER BY revision').all() as { snapshot_json: string }[]
      expect(revisions.map(r => JSON.parse(r.snapshot_json))).toEqual([original, updated])
      expect(() => db.prepare('UPDATE artifact_revisions SET snapshot_json = ?').run('{}')).toThrow(/Immutable/)
    }, false)
  })
  it('rolls back current projection, search/metadata indexes, graph and history when an update fails', () => {
    const { store, path } = setup(); store.create(input('B'))
    const original = store.create(input('A', { metadata: { ...input().metadata, relations: [{ artifactId: 'B', kind: 'implements' }] } }))
    expect(() => store.update({ artifactId: 'A', expectedRevision: 1, rawMarkdown: 'failed', metadata: { ...original.metadata, name: 'Failed name', status: 'BAD', relations: [{ artifactId: 'missing', kind: 'new' }] } })).toThrow(/INVALID_RELATION/)
    expect(store.get('A')).toEqual(original)
    expect(store.list({ relatedToArtifactId: 'B', direction: 'inbound' }).artifacts.map(a => a.artifactId)).toEqual(['A'])
    expect(store.list({ status: 'BAD' }).artifacts).toHaveLength(0); expect(store.list({ query: 'Failed name' }).artifacts).toHaveLength(0)
    withFixtureDatabase(path, db => { expect(db.prepare('SELECT count(*) AS n FROM artifact_revisions WHERE artifact_id = ?').get('A')).toEqual({ n: 1 }) })
  })
  it('navigates only one graph hop, preserves incoming identities during edits, and atomically replaces outgoing edges', () => {
    const { store } = setup(); store.create(input('C'))
    store.create(input('B', { metadata: { ...input().metadata, relations: [{ artifactId: 'C', kind: 'validates' }] } }))
    store.create(input('A', { metadata: { ...input().metadata, relations: [{ artifactId: 'B', kind: 'implements' }] } }))
    const ids = (id: string, direction: 'inbound' | 'outbound' | 'both', relationKind?: string) => store.list({ relatedToArtifactId: id, direction, ...(relationKind ? { relationKind } : {}) }).artifacts.map(a => a.artifactId).sort()
    expect(ids('A', 'outbound')).toEqual(['B']); expect(ids('B', 'inbound')).toEqual(['A']); expect(ids('B', 'outbound')).toEqual(['C'])
    expect(ids('B', 'both')).toEqual(['A', 'C']); expect(ids('B', 'both', 'implements')).toEqual(['A'])
    store.update({ artifactId: 'B', expectedRevision: 1, metadata: { ...input().metadata, status: 'VALIDATED' }, rawMarkdown: 'resolved' })
    expect(ids('B', 'both')).toEqual(['A']); expect(ids('C', 'inbound')).toEqual([])
    expect(() => store.create(input('self', { metadata: { ...input().metadata, relations: [{ artifactId: 'self', kind: 'x' }] } }))).toThrow(/self/)
    expect(store.get('self')).toBeNull()
    expect(() => store.create(input('duplicate', { metadata: { ...input().metadata, relations: [{ artifactId: 'C', kind: 'x' }, { artifactId: 'C', kind: 'x' }] } }))).toThrow(/duplicate/)
  })
  it('bounds discovery independent of 1 KB/100 KB bodies and projects only explicitly requested metadata', () => {
    const { store } = setup(); store.create(input('A', { rawMarkdown: 'x'.repeat(1024) })); store.create(input('B', { rawMarkdown: 'x'.repeat(102400) }))
    const records = store.list().artifacts; const { artifactId: a, ...first } = records[0]; const { artifactId: b, ...second } = records[1]
    expect(first).toEqual(second); expect(JSON.stringify(records[0]).length).toBe(JSON.stringify(records[1]).length)
    expect(JSON.stringify(records)).not.toMatch(/rawMarkdown|contentHash|provenance|future|repositoryKey/)
    expect(store.list({ metadataKeys: ['future'] }).artifacts[0].metadata).toEqual({ future: { level: 2, valid: true } })
    store.update({ artifactId: 'A', expectedRevision: 1, rawMarkdown: 'BODY_A', metadata: { ...input().metadata, relations: [{ artifactId: 'B', kind: 'related-to' }] } })
    expect(JSON.stringify(store.list({ relatedToArtifactId: 'A' }))).not.toContain('rawMarkdown')
    expect(JSON.stringify(store.get('A'))).not.toContain('x'.repeat(1024))
  })
  it('intersects filters, time and execution metadata; deterministically paginates timestamp ties with bounded results', () => {
    const { store } = setup(); for (let i = 0; i < 25; i++) store.create(input(String(i).padStart(2, '0')))
    expect(store.list().artifacts).toHaveLength(20)
    const ids: string[] = []; let cursor: string | undefined
    do {
      const page = store.list({ query: 'runtime', kind: 'DECISION', status: 'BLOCKED', metadata: { executionId: 'execution-1' }, limit: 7, ...(cursor ? { cursor } : {}) })
      ids.push(...page.artifacts.map(a => a.artifactId)); cursor = page.nextCursor
    } while (cursor)
    expect(ids).toHaveLength(25); expect(new Set(ids).size).toBe(25); expect(ids).toEqual([...ids].sort().reverse())
    expect(store.list({ query: 'Unicode' }).artifacts).toHaveLength(0)
    expect(store.list({ updatedAfter: '2026-10-02T00:00:00Z' }).artifacts).toHaveLength(0)
    expect(store.list({ updatedBefore: '2026-10-01T00:00:00Z', limit: 100 }).artifacts).toHaveLength(25)
    expect(() => store.list({ limit: 0 })).toThrow(/limit/); expect(() => store.list({ cursor: 'bad' })).toThrow(/cursor/)
    expect(() => store.list({ kind: 'OTHER', cursor: store.list({ limit: 1 }).nextCursor })).toThrow(/cursor/)
  })
})
