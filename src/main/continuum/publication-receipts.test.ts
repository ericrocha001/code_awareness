import { afterEach, expect, it } from 'vitest'
import { fixture, markdown, withFixtureDatabase } from './continuum-test-fixtures'
import { ArtifactStore, computeContentHash } from './artifact-store'
import { ContinuumService } from './continuum-service'
const closes: (() => void)[] = []
afterEach(() => { closes.reverse().forEach(close => close()); closes.length = 0 })
function setup(repo = 'catalog-A') { const f = fixture(repo); closes.push(f.close); return f }
it('issues distinct immutable receipts atomically and recovers exact revision facts after restart and replay', () => {
  const f = setup(), raw = markdown('Receipts')
  const first = f.service.publish(raw), second = f.service.publish(raw)
  const receipt = first.publicationReceipt!
  expect(receipt).toMatchObject({ schemaVersion: 1, repositoryId: 'catalog-A', artifactId: first.artifactId, revision: 1, contentHash: computeContentHash(raw), action: 'PUBLISH' })
  expect(second.publicationReceipt!.receiptId).not.toBe(receipt.receiptId)
  expect(first.replayed).toBe(false)
  expect(f.service.replayPublicationReceipt(receipt.receiptId)).toEqual({ ...first, replayed: true })
  expect(f.service.list().artifacts).toHaveLength(2)
  const updated = f.service.update(first.artifactId, 1, 'New literal body.')
  expect(updated.publicationReceipt).toMatchObject({ artifactId: first.artifactId, revision: 2, action: 'UPDATE' })
  expect(f.service.readPublicationReceipt(receipt.receiptId)).toEqual(receipt)
  expect(() => f.service.replayPublicationReceipt(receipt.receiptId)).toThrow('STALE_PUBLICATION_RECEIPT')
  expect(() => f.service.update(first.artifactId, 1, raw)).toThrow('REVISION_CONFLICT')
  withFixtureDatabase(f.path, db => {
    expect(db.prepare('SELECT count(*) AS n FROM publication_receipts').get()).toEqual({ n: 3 })
    expect(() => db.prepare('UPDATE publication_receipts SET action=? WHERE receipt_id=?').run('UPDATE', receipt.receiptId)).toThrow('Immutable publication receipt')
  }, false)
  const reopened = new ArtifactStore(f.path, 'catalog-A')
  try { expect(new ContinuumService(reopened).readPublicationReceipt(receipt.receiptId)).toEqual(receipt) } finally { reopened.close() }
  expect(setup('catalog-B').service.readPublicationReceipt(receipt.receiptId)).toBeNull()
  expect(f.service.readPublicationReceipt('publication-00000000-0000-0000-0000-000000000000')).toBeNull()
  expect(f.service.get(first.artifactId)!.revision).toBe(2)
})
it('rolls back document, revision and receipt together on invalid relations and detects corrupted receipts', () => {
  const f = setup()
  expect(() => f.service.publish(markdown('Invalid', 'relations: [{artifactId: absent, kind: implements}]\n'))).toThrow('INVALID_RELATION')
  expect(f.service.list().artifacts).toEqual([])
  const published = f.service.publish(markdown())
  withFixtureDatabase(f.path, db => {
    expect(db.prepare('SELECT count(*) AS n FROM publication_receipts').get()).toEqual({ n: 1 })
    db.exec('DROP TRIGGER publication_receipts_no_update')
    db.prepare('UPDATE publication_receipts SET payload=?').run(JSON.stringify({ ...published.publicationReceipt, repositoryId: 'forged' }))
  }, false)
  expect(() => f.service.readPublicationReceipt(published.publicationReceipt!.receiptId)).toThrow('PUBLICATION_RECEIPT_INTEGRITY')
})
