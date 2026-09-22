import type { IArtifactStore } from './continuum-types'
import type { ArtifactInbox } from './artifact-inbox'
import { deserializeEnvelope } from './artifact-envelope'
import { ArtifactIdentityConflictError, ArtifactContentIntegrityError } from './artifact-store'

export type IngestionOutcome = 'INGESTED' | 'REJECTED' | 'RETRYABLE_FAILURE'

export interface IngestionFailureDetail {
  filename: string
  outcome: Exclude<IngestionOutcome, 'INGESTED'>
  reason: string
}

export interface IngestionReport {
  discovered: number
  ingested: number
  rejected: number
  retryableFailures: number
  failures: IngestionFailureDetail[]
}

export class ArtifactIngestor {
  private readonly inbox: ArtifactInbox
  private readonly store: IArtifactStore

  constructor(inbox: ArtifactInbox, store: IArtifactStore) {
    this.inbox = inbox
    this.store = store
  }

  ingestPending(): IngestionReport {
    const pending = this.inbox.listPending()
    const report: IngestionReport = {
      discovered: pending.length,
      ingested: 0,
      rejected: 0,
      retryableFailures: 0,
      failures: []
    }

    for (const item of pending) {
      let rawContent: string
      let envelope: ReturnType<typeof deserializeEnvelope>

      // 1. Read and parse envelope — parse failure is permanent
      try {
        rawContent = this.inbox.read(item)
        envelope = deserializeEnvelope(rawContent)
      } catch (err) {
        this.inbox.reject(item)
        report.rejected++
        report.failures.push({
          filename: item.filename,
          outcome: 'REJECTED',
          reason: err instanceof Error ? err.message : String(err)
        })
        continue
      }

      // 2. Persist into store
      try {
        this.store.append({
          artifactId: envelope.artifactId,
          type: envelope.type,
          schemaVersion: envelope.schemaVersion,
          title: envelope.title,
          producerRole: envelope.producerRole,
          repositoryKey: envelope.repositoryKey,
          createdAt: envelope.createdAt,
          sourceFingerprint: envelope.sourceFingerprint,
          gitHead: envelope.gitHead,
          contentHash: envelope.contentHash,
          rawMarkdown: envelope.rawMarkdown
        })
      } catch (err) {
        // Identity conflict or content integrity failure is a permanent data error: reject.
        if (err instanceof ArtifactIdentityConflictError || err instanceof ArtifactContentIntegrityError) {
          this.inbox.reject(item)
          report.rejected++
          report.failures.push({
            filename: item.filename,
            outcome: 'REJECTED',
            reason: err.message
          })
          continue
        }
        // All other errors are treated as transient infrastructure failures.
        report.retryableFailures++
        report.failures.push({
          filename: item.filename,
          outcome: 'RETRYABLE_FAILURE',
          reason: err instanceof Error ? err.message : String(err)
        })
        continue
      }

      // 3. Only acknowledge after confirmed persistence
      this.inbox.acknowledge(item)
      report.ingested++
    }

    return report
  }
}
