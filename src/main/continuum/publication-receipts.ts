import type Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import type { Artifact, PublicationReceipt } from './continuum-types'
import { publicationReceiptDigest } from '../../shared/types/publication-provenance-types'
import { authenticatedSessionWitness, deliveryAnchor, type AuthenticatedSessionWitness, type DeliveryAnchor, type DeliveryObservation, type DeliveryProjectionPage } from '../../shared/types/delivery-context-types'

export interface PublicationReceiptContext {
  deliveryContext?: DeliveryAnchor
  sessionWitness?: AuthenticatedSessionWitness
}

export class PublicationReceipts {
  constructor(private readonly db: Database.Database, private readonly repositoryId: string) {
    db.exec(`CREATE TABLE IF NOT EXISTS publication_receipts(
      receipt_id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL, revision INTEGER NOT NULL,
      action TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(artifact_id,revision,action),
      FOREIGN KEY(artifact_id,revision) REFERENCES artifact_revisions(artifact_id,revision));
      CREATE TRIGGER IF NOT EXISTS publication_receipts_no_update BEFORE UPDATE ON publication_receipts BEGIN SELECT RAISE(ABORT,'Immutable publication receipt'); END;
      CREATE TRIGGER IF NOT EXISTS publication_receipts_no_delete BEFORE DELETE ON publication_receipts BEGIN SELECT RAISE(ABORT,'Immutable publication receipt'); END;`)
  }
  issue(artifact: Artifact, action: PublicationReceipt['action'], requestDigest: string, context?: PublicationReceiptContext): PublicationReceipt {
    if (!/^[a-f0-9]{64}$/.test(requestDigest)) throw new Error('INVALID_PUBLICATION_REQUEST_DIGEST')
    const prior = this.db.prepare('SELECT receipt_id FROM publication_receipts WHERE artifact_id=? AND revision=? AND action=?').get(artifact.artifactId, artifact.revision, action) as { receipt_id: string } | undefined
    if (prior) {
      const receipt = this.read(prior.receipt_id)!
      if (receipt.requestDigest !== requestDigest) throw new Error('PUBLICATION_RECEIPT_CONFLICT')
      return receipt
    }
    const body: Omit<PublicationReceipt, 'digest'> = {
      schemaVersion: 1,
      receiptId: 'publication-' + randomUUID(),
      repositoryId: this.repositoryId,
      artifactId: artifact.artifactId,
      revision: artifact.revision,
      contentHash: artifact.contentHash,
      requestDigest,
      action,
      ...(context?.deliveryContext ? { deliveryContext: context.deliveryContext } : {}),
      ...(context?.sessionWitness ? { sessionWitness: context.sessionWitness } : {})
    }
    const receipt = { ...body, digest: publicationReceiptDigest(body) }
    this.db.prepare('INSERT INTO publication_receipts VALUES(?,?,?,?,?)').run(receipt.receiptId, artifact.artifactId, artifact.revision, action, JSON.stringify(receipt))
    return this.read(receipt.receiptId)!
  }
  read(receiptId: string): PublicationReceipt | null {
    if (!/^publication-[a-f0-9-]{36}$/.test(receiptId)) throw new Error('INVALID_PUBLICATION_RECEIPT')
    const row = this.db.prepare('SELECT payload,artifact_id,revision,action FROM publication_receipts WHERE receipt_id=?').get(receiptId) as { payload: string; artifact_id: string; revision: number; action: string } | undefined
    if (!row) return null
    try {
      const receipt = JSON.parse(row.payload) as PublicationReceipt
      const { digest, ...body } = receipt
      const snapshot = this.db.prepare('SELECT snapshot_json FROM artifact_revisions WHERE artifact_id=? AND revision=?').get(row.artifact_id, row.revision) as { snapshot_json: string }
      const artifact = JSON.parse(snapshot.snapshot_json) as Artifact
      if (receipt.schemaVersion !== 1 || receipt.receiptId !== receiptId || receipt.repositoryId !== this.repositoryId || receipt.artifactId !== row.artifact_id || receipt.revision !== row.revision || receipt.action !== row.action ||
        !['PUBLISH', 'UPDATE'].includes(receipt.action) || !/^[a-f0-9]{64}$/.test(receipt.requestDigest) || digest !== publicationReceiptDigest(body) || artifact.artifactId !== receipt.artifactId || artifact.revision !== receipt.revision || artifact.contentHash !== receipt.contentHash ||
        createHash('sha256').update(artifact.rawMarkdown).digest('hex') !== receipt.contentHash) throw new Error()
      if (receipt.deliveryContext !== undefined && !deliveryAnchor.safeParse(receipt.deliveryContext).success) throw new Error()
      if (receipt.sessionWitness !== undefined && !authenticatedSessionWitness.safeParse(receipt.sessionWitness).success) throw new Error()
      return receipt
    } catch { throw new Error('PUBLICATION_RECEIPT_INTEGRITY') }
  }
  deliveryPage(after?: string, limit = 100): DeliveryProjectionPage {
    const afterRowid = after && /^\d+$/.test(after) ? Number(after) : 0
    const bounded = Math.max(1, Math.min(200, Math.floor(limit)))
    const rows = this.db.prepare('SELECT rowid, receipt_id FROM publication_receipts WHERE rowid > ? ORDER BY rowid ASC LIMIT ?')
      .all(afterRowid, bounded) as Array<{ rowid: number; receipt_id: string }>
    const observations: DeliveryObservation[] = []
    for (const row of rows) {
      const receipt = this.read(row.receipt_id)
      if (!receipt?.deliveryContext || receipt.deliveryContext.repositoryId !== this.repositoryId) continue
      observations.push({
        receiptId: receipt.receiptId,
        operationId: receipt.receiptId,
        operation: receipt.action === 'PUBLISH' ? 'PUBLISH_ARTIFACT' : 'UPDATE_ARTIFACT',
        argumentFingerprint: receipt.requestDigest,
        anchor: receipt.deliveryContext,
        artifactId: receipt.artifactId,
        artifactRevision: receipt.revision
      })
    }
    const nextCursor = rows.length === bounded ? String(rows[rows.length - 1]!.rowid) : undefined
    return { observations, ...(nextCursor ? { nextCursor } : {}) }
  }
}
