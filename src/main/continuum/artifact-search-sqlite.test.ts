import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArtifactSearchProjection } from './artifact-search-projection'
import { ArtifactStore } from './artifact-store'
import Database from 'better-sqlite3'
import { expect, it, vi } from 'vitest'

it('supports both Continuum search tokenizers in the native SQLite runtime', () => {
  const db = new Database(':memory:')
  try {
    db.exec(`
      CREATE VIRTUAL TABLE lexical USING fts5(body, tokenize='unicode61 remove_diacritics 2');
      CREATE VIRTUAL TABLE literal USING fts5(body, tokenize='trigram');
    `)
    const body = 'informação path/to/file {timeout}'
    db.prepare('INSERT INTO lexical(body) VALUES (?)').run(body)
    db.prepare('INSERT INTO literal(body) VALUES (?)').run(body)

    expect(db.prepare('SELECT body FROM lexical WHERE lexical MATCH ?').get('"informacao"')).toEqual({ body })
    expect(db.prepare('SELECT body FROM literal WHERE literal MATCH ?').get('"h/to/f"')).toEqual({ body })
    expect(db.prepare('SELECT body FROM literal WHERE literal MATCH ?').get('"{timeout}"')).toEqual({ body })
  } finally {
    db.close()
  }
})

it('backfills in resumable batches and keeps updated content pending until projected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'continuum-search-'))
  const path = join(dir, 'artifacts.sqlite')
  let store = new ArtifactStore(path, 'search-repository')
  const db = new Database(path)
  try {
    const projection = new ArtifactSearchProjection(db)
    const content = '# Section\n\nLookup /path/to/file and {}.\n\n| Column |\n| --- |\n| cell |'
    for (let index = 0; index < 6; index++) {
      store.create({ artifactId: 'artifact-' + index, rawMarkdown: content, metadata: { kind: 'NOTE', name: 'Example ' + index, description: 'Example for incremental structural projection' } })
    }
    const states = () => db.prepare('SELECT state FROM artifact_search_projection ORDER BY artifact_id').pluck().all()
    const find = (query: string) => db.prepare(`
      SELECT u.artifact_id FROM artifact_search_literal JOIN artifact_search_units u ON u.id=artifact_search_literal.rowid
      JOIN artifact_search_projection p ON p.artifact_id=u.artifact_id AND p.state='CURRENT'
      WHERE artifact_search_literal MATCH ? ORDER BY u.artifact_id
    `).pluck().all(query)
    expect(states()).toEqual(Array(6).fill('PENDING'))
    expect(projection.backfillBatch()).toBe(true)
    expect(states()).toEqual([...Array(4).fill('CURRENT'), ...Array(2).fill('PENDING')])
    expect(store.get('artifact-5')?.rawMarkdown).toBe(content)
    expect(find('"/path/to/file"')).toHaveLength(4)
    store.close()

    store = new ArtifactStore(path, 'search-repository')
    const resumed = new ArtifactSearchProjection(db)
    expect(resumed.backfillBatch()).toBe(false)
    expect(find('"/path/to/file"')).toHaveLength(6)
    const original = store.get('artifact-0')!
    const rawMarkdown = '# Section\n\nReplacement /new/route.'
    store.update({ artifactId: original.artifactId, expectedRevision: original.revision, rawMarkdown, metadata: original.metadata })
    expect(states()[0]).toBe('PENDING')
    expect(find('"/path/to/file"')).toHaveLength(5)

    db.exec("CREATE TRIGGER test_reject_unit BEFORE INSERT ON artifact_search_units BEGIN SELECT raise(ABORT, 'fixture failure'); END")
    resumed.backfillBatch()
    expect(states()[0]).toBe('FAILED')
    expect(store.get(original.artifactId)?.rawMarkdown).toBe(rawMarkdown)
    expect(find('"/new/route"')).toEqual([])
    db.exec('DROP TRIGGER test_reject_unit')
    store.update({ artifactId: original.artifactId, expectedRevision: original.revision + 1, rawMarkdown, metadata: original.metadata })
    resumed.backfillBatch()
    expect(states()[0]).toBe('CURRENT')
    const short = { query: 'to', mode: 'LITERAL', fields: ['body'] }
    const first = store.searchArtifacts(short)
    expect(first.coverage.state).toBe('PARTIAL')
    expect(first.nextCursor).toBeDefined()
    const last = store.searchArtifacts({ ...short, cursor: first.nextCursor })
    expect(last.coverage.state).toBe('COMPLETE')
    expect([...first.hits, ...last.hits].map(hit => hit.artifactId)).toEqual(['artifact-1', 'artifact-2', 'artifact-3', 'artifact-4', 'artifact-5'])
    expect(find('"/new/route"')).toEqual([original.artifactId])
  } finally {
    db.close()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})


it('rejects a projected revision changed after extraction and before its index transaction', () => {
  const dir = mkdtempSync(join(tmpdir(), 'continuum-projection-race-'))
  const path = join(dir, 'artifacts.sqlite')
  const store = new ArtifactStore(path, 'projection-race')
  const db = new Database(path)
  try {
    const projection = new ArtifactSearchProjection(db)
    const metadata = { kind: 'NOTE', name: 'Race fixture', description: 'Projection must preserve the current revision' }
    const imported = store.importArtifact('fixture-source', { artifactId: 'race', rawMarkdown: 'initial obsolete body', metadata })
    const transact = db.transaction.bind(db)
    const spy = vi.spyOn(db, 'transaction')
    spy.mockImplementationOnce(transact).mockImplementationOnce(callback => {
      store.update({ artifactId: imported.artifactId, expectedRevision: 1, rawMarkdown: 'current body', metadata })
      return transact(callback)
    })
    projection.backfillBatch()
    spy.mockRestore()
    expect(db.prepare('SELECT revision, state FROM artifact_search_projection').get()).toEqual({ revision: 2, state: 'PENDING' })
    expect(db.prepare('SELECT count(*) FROM artifact_search_units').pluck().get()).toBe(0)
    projection.backfillBatch()
    expect(db.prepare('SELECT revision, state FROM artifact_search_projection').get()).toEqual({ revision: 2, state: 'CURRENT' })
    expect(db.prepare("SELECT text FROM artifact_search_units WHERE field='body'").pluck().get()).toBe('current body')
    expect(() => new ArtifactStore(path, 'another-repository')).toThrow(/REPOSITORY_SCOPE_MISMATCH/)
  } finally {
    db.close()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('retrieves original structural evidence, ranks and filters discoveries, and invalidates stale cursors', () => {
  const dir = mkdtempSync(join(tmpdir(), 'continuum-query-'))
  const path = join(dir, 'artifacts.sqlite')
  const store = new ArtifactStore(path, 'query-repository')
  const db = new Database(path)
  try {
    const projection = new ArtifactSearchProjection(db)
    const content = '# Operational history\n\nstructuredContent kept informação under /path/to/file and {}.\n\nSeparate distant tokens.'
    const metadata = { kind: 'NOTE', name: 'Runtime precedent', description: 'Previously observed integration behavior' }
    store.create({ artifactId: 'target', rawMarkdown: content, metadata })
    store.create({ artifactId: 'distractor', rawMarkdown: 'Unrelated information about runtime precedent', metadata })
    store.create({ artifactId: 'other', rawMarkdown: '# structuredContent\n\n/another/path', metadata })
    expect(store.searchArtifacts({ query: 'structuredContent' }).coverage.state).toBe('PARTIAL')
    expect(store.list({ query: 'structuredContent' }).artifacts).toEqual([])
    projection.backfillBatch()
    const judgments = [
      { query: 'structuredContent', fields: ['body'], target: 'target' },
      { query: 'information', fields: ['body'], target: 'distractor' },
      { query: '/another/path', mode: 'LITERAL', target: 'other' }
    ] as const
    const ranks = judgments.map(({ target, ...input }) => store.searchArtifacts(input).hits.findIndex(hit => hit.artifactId === target) + 1)
    expect(ranks.filter(rank => rank > 0).length / judgments.length).toBe(1)
    expect(ranks.reduce((sum, rank) => sum + (rank > 0 ? 1 / rank : 0), 0) / judgments.length).toBe(1)

    const result = store.searchArtifacts({ query: 'structuredContent informacao', fields: ['body'], kind: 'NOTE', includeTokenUsage: true })
    expect(result.coverage.state).toBe('COMPLETE')
    expect(result.hits.map(hit => hit.artifactId)).toEqual(['target'])
    expect(result.tokenUsage?.payloadTokenCount).toBeLessThanOrEqual(1200)
    const hit = result.hits[0]
    expect(hit.explanation).toBeUndefined()
    expect(store.readSection({ artifactId: hit.artifactId, expectedRevision: hit.revision, sectionId: hit.location.sectionId!, blockId: hit.location.blockId! }).content)
      .toBe('structuredContent kept informação under /path/to/file and {}.')
    expect(store.searchArtifacts({ query: 'informacao', mode: 'LITERAL' }).hits).toEqual([])
    expect(store.searchArtifacts({ query: '{}', mode: 'LITERAL' }).hits.map(hit => hit.artifactId)).toEqual(['target'])
    expect(store.searchArtifacts({ query: '/path/to/file', mode: 'LITERAL', explain: true }).hits[0].explanation?.mode).toBe('LITERAL')
    expect(store.searchArtifacts({ query: 'structuredContent kept', mode: 'PHRASE' }).hits[0].artifactId).toBe('target')
    expect(store.searchArtifacts({ query: 'kept informação', mode: 'NEAR', distance: 1 }).hits[0].artifactId).toBe('target')
    expect(store.searchArtifacts({ query: 'quimera informação', mode: 'ANY_TERMS', alternatives: [{ query: 'information' }], fields: ['body'] }).hits.map(hit => hit.artifactId))
      .toEqual(['target', 'distractor'])
    expect(() => store.searchArtifacts({ query: 'structuredContent', tokenBudget: 10 })).toThrow(/BUDGET_TOO_SMALL/)
    const first = store.searchArtifacts({ query: 'structuredContent', limit: 1 })
    expect(first.hits[0].artifactId).toBe('other')
    expect(store.searchArtifacts({ query: 'structuredContent', limit: 1, cursor: first.nextCursor }).hits[0].artifactId).toBe('target')
    store.update({ artifactId: 'target', expectedRevision: 1, rawMarkdown: 'Removed evidence.', metadata })
    expect(() => store.searchArtifacts({ query: 'structuredContent', limit: 1, cursor: first.nextCursor })).toThrow(/SEARCH_CURSOR_STALE/)
  } finally {
    db.close()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
