/**
 * Harness de instrumentação para a cadeia de sincronização do CodeMap.
 *
 * Conta eventos por fase para provas determinísticas em testes. O harness
 * é puramente aditivo — não altera comportamento funcional.
 */

export interface SyncHarnessCounters {
  observations: number
  accepted: number
  rejected: number
  stabilizationAttempts: number
  verificationAttempts: number
  reindexAttempts: number
}

export type SyncHarnessEvent =
  | 'observed'
  | 'accepted'
  | 'rejected'
  | 'stabilization'
  | 'verification'
  | 'reindex'

export class SyncHarness {
  private readonly counts: SyncHarnessCounters = {
    observations: 0,
    accepted: 0,
    rejected: 0,
    stabilizationAttempts: 0,
    verificationAttempts: 0,
    reindexAttempts: 0
  }

  record(event: SyncHarnessEvent): void {
    switch (event) {
      case 'observed':
        this.counts.observations++
        break
      case 'accepted':
        this.counts.accepted++
        break
      case 'rejected':
        this.counts.rejected++
        break
      case 'stabilization':
        this.counts.stabilizationAttempts++
        break
      case 'verification':
        this.counts.verificationAttempts++
        break
      case 'reindex':
        this.counts.reindexAttempts++
        break
    }
  }

  snapshot(): Readonly<SyncHarnessCounters> {
    return { ...this.counts }
  }

  reset(): void {
    this.counts.observations = 0
    this.counts.accepted = 0
    this.counts.rejected = 0
    this.counts.stabilizationAttempts = 0
    this.counts.verificationAttempts = 0
    this.counts.reindexAttempts = 0
  }
}
