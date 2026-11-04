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
