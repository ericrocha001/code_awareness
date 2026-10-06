import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RepositoryContinuumSession } from './project-continuum-session'
import { ArtifactInbox } from './artifact-inbox'
import { computeContentHash } from './artifact-store'
import { fixture, legacyDatabase, legacyEnvelope, markdown, withFixtureDatabase } from './continuum-test-fixtures'

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.reverse()) close(); cleanup.length = 0 })
describe('Repository coordination, isolation and migration', () => {
  function setup() {
    const f = fixture(); cleanup.push(f.close)
    const rootA = join(f.dir, 'checkout-A'), rootB = join(f.dir, 'checkout-B'), storage = join(f.dir, 'app-storage')
    mkdirSync(rootA); mkdirSync(rootB)
    const identities = new Map([[rootA, 'catalog-A'], [rootB, 'catalog-B']])
    const catalog = { findByPath: (path: string) => { const id = identities.get(path); return id ? { id, localCheckout: { path } } : null } }
    const session = new RepositoryContinuumSession(storage, catalog); cleanup.push(() => session.dispose())
    return { ...f, rootA, rootB, storage, session, identities }
  }
  it('migrates each repository separately with exact Markdown, IDs, timestamps/provenance and idempotence after edit/restart', () => {
    const { session, storage, rootA, rootB } = setup()
    const originalEnvelope = legacyEnvelope(rootA)
    const rawMarkdown = originalEnvelope.rawMarkdown + '\u0007'
    const envelope = { ...originalEnvelope, rawMarkdown, contentHash: computeContentHash(rawMarkdown) }
    const legacyPath = legacyDatabase(storage, rootA, envelope)
    legacyDatabase(storage, rootB, { ...legacyEnvelope(rootB, 'legacy-B'), title: 'Other repository' })
    session.activate(rootA)
    const service = session.getActiveService()!
    const original = service.get(envelope.artifactId)!
    expect(original.metadata).toEqual({ name: envelope.title, kind: envelope.type }); expect(original.revision).toBe(1)
    expect(Buffer.from(original.rawMarkdown)).toEqual(Buffer.from(envelope.rawMarkdown))
    expect(original.createdAt).toBe(envelope.createdAt); expect(original.updatedAt).toBe('2026-09-02T00:00:00.000Z')
    expect(original.provenance).toMatchObject({ gitHead: 'legacy-head', sourceFingerprint: 'legacy-fingerprint', ingestedAt: '2026-09-02T00:00:00.000Z' })
    expect(existsSync(legacyPath)).toBe(true); expect(service.get('legacy-B')).toBeNull()
    expect(() => service.publish(markdown('Invalid new content', '', rawMarkdown))).toThrow(/INVALID_ARGUMENT/)
    service.update(envelope.artifactId, 1, markdown('Enriched', 'status: VALIDATED\n'))
    session.dispose(); session.activate(rootA)
    expect(session.getActiveService()!.get(envelope.artifactId)!.revision).toBe(2)
    expect(session.getActiveService()!.list().artifacts).toHaveLength(1)
    session.activate(rootB)
    expect(session.getActiveService()!.list().artifacts.map(a => a.artifactId)).toEqual(['legacy-B'])
    expect(session.getActiveService()!.get(envelope.artifactId)).toBeNull()
  })
  it('closes old Store on switching and isolates identical metadata, read, edit, relations and cursors in two repositories', () => {
    const { session, rootA, rootB } = setup(); session.activate(rootA)
    const first = session.getActiveService()!; const a = first.publish(markdown('Identical')); first.publish(markdown('Identical'))
    const cursorA = first.list({ limit: 1 }).nextCursor!
    const pathA = session.getActiveSession()!.dbPath
    session.activate(rootB); const second = session.getActiveService()!
    expect(second).not.toBe(first); expect(session.getActiveSession()!.dbPath).not.toBe(pathA)
    expect(() => first.get(a.artifactId)).toThrow(/not open/)
    expect(second.get(a.artifactId)).toBeNull(); expect(second.list().artifacts).toHaveLength(0)
    expect(() => second.update(a.artifactId, 1, markdown('Changed'))).toThrow(/ARTIFACT_NOT_FOUND/)
    expect(() => second.publish(markdown('Invalid', `relations:\n  - artifactId: ${a.artifactId}\n    kind: related-to\n`))).toThrow(/INVALID_RELATION/)
    expect(() => second.list({ limit: 1, cursor: cursorA })).toThrow(/repository/)
    const b = second.publish(markdown('Identical'))
    expect(second.list({ query: 'Identical' }).artifacts.map(a => a.artifactId)).toEqual([b.artifactId])
    session.activate(rootA)
    expect(session.getActiveService()!.list({ query: 'Identical' }).artifacts).toHaveLength(2)
    expect(session.getActiveService()!.get(b.artifactId)).toBeNull()
    session.deactivate(); expect(session.getActiveService()).toBeNull()
    expect(() => session.activate('unknown-path')).toThrow(/REPOSITORY_NOT_FOUND/)
  })
  it('keeps canonical Store identity and history when a checkout moves and the catalog retains RepositoryRecord.id', () => {
    const { session, rootA, identities } = setup(); session.activate(rootA)
    const receipt = session.getActiveService()!.publish(markdown('Move proof')); const path = session.getActiveSession()!.dbPath
    const pending = legacyEnvelope(rootA, 'moved-pending')
    new ArtifactInbox(rootA).write(pending)
    session.deactivate(); const moved = rootA + '-moved'; renameSync(rootA, moved)
    identities.delete(rootA); identities.set(moved, 'catalog-A'); expect(session.activate(moved).ingested).toBe(1)
    expect(session.getActiveSession()!.dbPath).toBe(path)
    expect(session.getActiveService()!.get(receipt.artifactId)!.revision).toBe(1)
    expect(session.getActiveService()!.get('moved-pending')!.rawMarkdown).toBe(pending.rawMarkdown)
  })
  it('accepts pending v1/v2 inbox on activation/read-through and deduplicates a v1 retry already imported from DB', () => {
    const { session, storage, rootA } = setup(); const inbox = new ArtifactInbox(rootA); const envelope = legacyEnvelope(rootA)
    legacyDatabase(storage, rootA, envelope); inbox.write(envelope)
    expect(session.activate(rootA).ingested).toBe(1)
    const service = session.getActiveService()!; const rawMarkdown = markdown('Generic')
    inbox.write({ protocol: 'continuum-artifact/v2', artifactId: 'generic', repositoryKey: envelope.repositoryKey,
      createdAt: envelope.createdAt, rawMarkdown, contentHash: computeContentHash(rawMarkdown) })
    expect(service.list().artifacts).toHaveLength(2); expect(service.get(envelope.artifactId)!.rawMarkdown).toBe(envelope.rawMarkdown)
    expect(inbox.listPending()).toHaveLength(0)
  })
  it('does not overwrite conflicting migration data or mark migration complete, keeping the legacy Store intact', () => {
    const { session, storage, rootA } = setup(); session.activate(rootA)
    const original = session.getActiveService()!.publish(markdown('Existing')); const dbPath = session.getActiveSession()!.dbPath
    session.deactivate(); const legacyPath = legacyDatabase(storage, rootA, legacyEnvelope(rootA, original.artifactId))
    expect(() => session.activate(rootA)).toThrow(/IDENTITY_CONFLICT/)
    expect(session.getActiveService()).toBeNull(); expect(existsSync(legacyPath)).toBe(true)
    withFixtureDatabase(dbPath, db => {
      expect(db.prepare('SELECT count(*) AS n FROM legacy_migrations').get()).toEqual({ n: 0 })
      expect(db.prepare('SELECT raw_markdown FROM artifacts WHERE artifact_id = ?').get(original.artifactId)).toEqual({ raw_markdown: markdown('Existing') })
    })
  })
})
