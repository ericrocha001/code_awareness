import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import type { PublicationAssociation, PublicationAssociationResult, PublicationReceipt } from '../../shared/types/publication-provenance-types'
const digest = (state: string, payload: string) => createHash('sha256').update(JSON.stringify([state, payload])).digest('hex')
export class PublicationAssociations {
  constructor(private readonly db: Database.Database, private readonly repositoryId: string, private readonly readReceipt: (id: string) => PublicationReceipt | null) {
    db.exec(`CREATE TABLE IF NOT EXISTS publication_associations(receipt_id TEXT PRIMARY KEY REFERENCES publication_receipts(receipt_id),invocation_id TEXT NOT NULL,state TEXT NOT NULL,payload TEXT NOT NULL,integrity TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS publication_invocation ON publication_associations(invocation_id);`)
  }
  record(value: PublicationAssociation): PublicationAssociationResult {
    if (value.repositoryId !== this.repositoryId || Object.keys(value).some(key => !['repositoryId','receiptId','sessionId','invocationId','worktreeId','generation','evidenceDigest'].includes(key)) ||
      !(['sessionId','invocationId','worktreeId','generation','evidenceDigest'] as const).every(key => /^[a-f0-9]{64}$/.test(value[key]))) throw new Error('INVALID_PUBLICATION_ASSOCIATION')
    if (!this.readReceipt(value.receiptId)) throw new Error('PUBLICATION_RECEIPT_NOT_FOUND')
    return this.db.transaction(() => {
      const rows = this.db.prepare('SELECT * FROM publication_associations WHERE receipt_id=? OR invocation_id=?').all(value.receiptId, value.invocationId) as { receipt_id: string; invocation_id: string; state: string; payload: string; integrity: string }[]
      const payload = JSON.stringify(value)
      for (const row of rows) if (digest(row.state, row.payload) !== row.integrity) throw new Error('PUBLICATION_ASSOCIATION_INTEGRITY')
      const conflict = rows.some(row => row.state === 'AMBIGUOUS' || row.payload !== payload)
      if (conflict) for (const row of rows) this.db.prepare("UPDATE publication_associations SET state='AMBIGUOUS',integrity=? WHERE receipt_id=?").run(digest('AMBIGUOUS', row.payload), row.receipt_id)
      const state: PublicationAssociationResult['state'] = conflict ? 'AMBIGUOUS' : 'VERIFIED'
      if (!rows.some(row => row.receipt_id === value.receiptId)) this.db.prepare('INSERT INTO publication_associations VALUES(?,?,?,?,?)').run(value.receiptId, value.invocationId, state, payload, digest(state, payload))
      else if (!conflict && rows.some(row => row.state !== 'VERIFIED')) this.db.prepare("UPDATE publication_associations SET state='VERIFIED',integrity=? WHERE receipt_id=?").run(digest('VERIFIED', payload), value.receiptId)
      return { state, conflictingInvocationIds: conflict ? [...new Set(rows.map(row => row.invocation_id))] : [] }
    }).immediate()
  }
  invalidate(invocationId: string, state: 'UNAVAILABLE' | 'PARTIAL' | 'AMBIGUOUS'): void {
    if (!/^[a-f0-9]{64}$/.test(invocationId) || !['UNAVAILABLE','PARTIAL','AMBIGUOUS'].includes(state)) throw new Error('INVALID_PUBLICATION_ASSOCIATION')
    this.db.transaction(() => {
      const rows = this.db.prepare('SELECT receipt_id,payload,state,integrity FROM publication_associations WHERE invocation_id=?').all(invocationId) as { receipt_id: string; payload: string; state: string; integrity: string }[]
      for (const row of rows) {
        if (row.integrity !== digest(row.state, row.payload)) throw new Error('PUBLICATION_ASSOCIATION_INTEGRITY')
        const next = row.state === 'AMBIGUOUS' ? 'AMBIGUOUS' : state
        this.db.prepare('UPDATE publication_associations SET state=?,integrity=? WHERE receipt_id=?').run(next, digest(next, row.payload), row.receipt_id)
      }
    }).immediate()
  }
  projection(artifactId: string, revision: number): Record<string, string | number> | undefined {
    const row = this.db.prepare(`SELECT a.state,a.payload,a.integrity FROM publication_associations a JOIN publication_receipts r ON a.receipt_id=r.receipt_id WHERE r.artifact_id=? AND r.revision=? LIMIT 1`).get(artifactId, revision) as { state: string; payload: string; integrity: string } | undefined
    if (!row) return
    if (digest(row.state, row.payload) !== row.integrity) throw new Error('PUBLICATION_ASSOCIATION_INTEGRITY')
    const value = JSON.parse(row.payload) as PublicationAssociation
    if (value.repositoryId !== this.repositoryId || !this.readReceipt(value.receiptId)) throw new Error('PUBLICATION_ASSOCIATION_INTEGRITY')
    return { state: row.state, revision, freshness: 'EXACT_REVISION', evidenceKind: 'NATIVE_ARTIFACT_CAUSAL', receiptId: value.receiptId,
      ...(row.state === 'VERIFIED' ? { sessionId: value.sessionId, invocationId: value.invocationId, worktreeId: value.worktreeId, generation: value.generation, evidenceDigest: value.evidenceDigest, coverage: 'COMPLETE' } : { coverage: row.state }) }
  }
}
