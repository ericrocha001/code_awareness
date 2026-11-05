export type SmcSessionStatus = 'OPEN' | 'CLOSED'

export interface SmcSessionRecord {
  readonly sessionId: string
  readonly repositoryId: string
  readonly status: SmcSessionStatus
  readonly revision: number
  readonly createdAt: string
  readonly updatedAt: string
}

export interface CreateSmcSessionInput {
  readonly sessionId?: string
}

export interface ListSmcSessionsOptions {
  readonly limit?: number
}

// SMC-02: Cumulative Engineering Records

export type SmcEntryKind = 'DECISION' | 'EVIDENCE' | 'RESULT' | 'PENDING' | 'INTERVENTION'

export type SmcEmitterRole = 'HUMAN' | 'AGENT' | 'SYSTEM'

export type SmcReferenceKind = 'COMMIT' | 'PROOF' | 'ARTIFACT' | 'OTHER'

export interface SmcReference {
  readonly kind: SmcReferenceKind
  readonly target: string
}

export interface SmcProvenance {
  readonly role: SmcEmitterRole
  readonly emitterId?: string
}

export interface AppendSmcEntryInput {
  readonly entryId?: string
  readonly kind: SmcEntryKind
  readonly title: string
  readonly body: string
  readonly provenance: SmcProvenance
  readonly references?: readonly SmcReference[]
  readonly supersedesEntryId?: string
}

export interface SmcEntryHeaderRecord {
  readonly entryId: string
  readonly sessionId: string
  readonly repositoryId: string
  readonly kind: SmcEntryKind
  readonly title: string
  readonly provenance: SmcProvenance
  readonly references?: readonly SmcReference[]
  readonly supersedesEntryId?: string
  readonly createdAt: string
}

export interface SmcEntryRecord extends SmcEntryHeaderRecord {
  readonly body: string
}

export interface ListSmcEntriesOptions {
  readonly kind?: SmcEntryKind
  readonly limit?: number
  readonly cursor?: string
  readonly direction?: 'ASC' | 'DESC'
}

export interface SmcEntryPage {
  readonly entries: readonly SmcEntryHeaderRecord[]
  readonly nextCursor?: string
}
