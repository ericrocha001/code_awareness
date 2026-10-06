import { readFileSync, writeFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ArtifactInbox } from './artifact-inbox'
import { ArtifactIngestor } from './artifact-ingestor'
import { fixture, legacyEnvelope, markdown } from './continuum-test-fixtures'
import { computeContentHash } from './artifact-store'
import { ContinuumService } from './continuum-service'
const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup) close(); cleanup.length = 0 })
describe('Repository inbox through ContinuumService', () => {
  function setup() { const f = fixture(); cleanup.push(f.close); const inbox = new ArtifactInbox(f.dir); const envelope = legacyEnvelope(f.dir); return { ...f, inbox, envelope, ingestor: new ArtifactIngestor(inbox, f.service, envelope.repositoryKey) } }
  it('acknowledges only committed artifacts, accepts retries after evolution and preserves revision', () => {
    const { inbox, envelope, ingestor, service } = setup(); inbox.write(envelope)
    expect(ingestor.ingestPending()).toMatchObject({ discovered: 1, ingested: 1, rejected: 0 })
    service.update(envelope.artifactId, 1, markdown('Improved')); inbox.write(envelope)
    expect(ingestor.ingestPending().ingested).toBe(1); expect(service.get(envelope.artifactId)!.revision).toBe(2)
    expect(service.list().artifacts).toHaveLength(1)
  })
  it('retains transient failures for retry and rejects tampered, foreign and conflicting envelopes without overwrite', () => {
    const { inbox, envelope, ingestor, service } = setup(); inbox.write(envelope)
    const fail = vi.spyOn(service, 'ingest').mockImplementationOnce(() => { throw new Error('disk unavailable') })
    expect(ingestor.ingestPending().retryableFailures).toBe(1); expect(inbox.listPending()).toHaveLength(1)
    fail.mockRestore(); expect(ingestor.ingestPending().ingested).toBe(1)
    const conflict = '# different'; inbox.write({ ...envelope, rawMarkdown: conflict, contentHash: computeContentHash(conflict) })
    expect(ingestor.ingestPending().failures[0].reason).toMatch(/IDENTITY_CONFLICT/)
    const receipt = inbox.write({ ...envelope, artifactId: 'tampered' }); const modified = JSON.parse(readFileSync(receipt.filePath, 'utf8')); modified.rawMarkdown = 'changed'; writeFileSync(receipt.filePath, JSON.stringify(modified))
    expect(ingestor.ingestPending().rejected).toBe(1)
    inbox.write({ ...envelope, artifactId: 'foreign', repositoryKey: 'other-repository' }); expect(ingestor.ingestPending().failures[0].reason).toMatch(/locator/)
    expect(service.list().artifacts).toHaveLength(1); expect(service.get(envelope.artifactId)!.rawMarkdown).toBe(envelope.rawMarkdown)
  })
  it('rejects malformed frontmatter/graph and accepts arbitrary kinds using the generic envelope', () => {
    const { inbox, envelope, ingestor, service, store } = setup()
    const write = (id: string, rawMarkdown: string) => inbox.write({ protocol: 'continuum-artifact/v2', artifactId: id, repositoryKey: envelope.repositoryKey, createdAt: envelope.createdAt, rawMarkdown, contentHash: computeContentHash(rawMarkdown) })
    write('bad', '# missing frontmatter'); expect(ingestor.ingestPending().rejected).toBe(1)
    write('badgraph', markdown('Bad', 'relations:\n  - artifactId: nonexistent\n    kind: related-to\n')); expect(ingestor.ingestPending().rejected).toBe(1)
    write('generic', markdown('New').replace('DECISION', 'FUTURE_COMMUNICATION')); expect(ingestor.ingestPending().ingested).toBe(1)
    expect(service.get('generic')!.metadata.kind).toBe('FUTURE_COMMUNICATION')
    write('queued-target', markdown('Pending target'))
    const reconciled = new ContinuumService(store, () => ingestor.ingestPending())
    const related = reconciled.publish(markdown('Linked', 'relations:\n  - artifactId: queued-target\n    kind: related-to\n'))
    expect(reconciled.get(related.artifactId)!.metadata.relations).toEqual([{ artifactId: 'queued-target', kind: 'related-to' }])
  })
})
