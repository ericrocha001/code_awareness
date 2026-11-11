import type {
  ExecutorBillingRecord,
  ExecutorEvent,
  ExecutorRunStatus,
  ExecutorUsageRecord
} from '../../../../shared/types/buildx/execution-types'

export const DEFAULT_CLINE_EXECUTOR_ID = 'cline-sdk'
export const DEFAULT_CLINE_PROVIDER_ID = 'cline'
export const CLINE_OFFICIAL_API_BASE_URL = 'https://api.cline.bot'
export const CLINE_DEFAULT_TIMEOUT_MS = 120_000
export const CLINE_MAX_TIMEOUT_MS = 600_000

export interface ClineWorkerCleanupReceipt {
  readonly sessionDeleted: boolean
  readonly coreDisposed: boolean
  readonly dirRemoved: boolean
  readonly reason?: string
}

export interface ClineProbeCatalogRequest {
  readonly type: 'probe_free_catalog'
  readonly requestId: string
  readonly requestedModelId?: string | null
  readonly apiBaseUrl?: string
  readonly settingsFilePath?: string
  readonly requireAuth?: boolean
}

export interface ClinePrepareAttemptRequest {
  readonly type: 'prepare_attempt'
  readonly requestId: string
  readonly attemptId: string
  readonly repositoryId: string
  readonly worktreePath: string
  readonly requestedModelId: string
  readonly apiBaseUrl?: string
  readonly settingsFilePath?: string
}

export interface ClineStartAttemptRequest {
  readonly type: 'start_attempt'
  readonly requestId: string
  readonly attemptId: string
  readonly repositoryId: string
  readonly unitflowSessionId: string
  readonly worktreePath: string
  readonly modelId: string
  readonly promptText: string
  readonly allowAutoApprove: boolean
  readonly timeoutMs: number
  readonly isolatedStorageRoot: string
  readonly apiBaseUrl?: string
  readonly settingsFilePath?: string
  readonly captureBilling?: boolean
  readonly maxIterations?: number
  readonly maxTokensPerTurn?: number
  readonly temperature?: number
}

export interface ClineApprovalResponseMessage {
  readonly type: 'approval_response'
  readonly attemptId: string
  readonly toolCallId: string
  readonly approved: boolean
  readonly reason?: string
}

export interface ClineCancelAttemptRequest {
  readonly type: 'cancel_attempt'
  readonly attemptId: string
  readonly reason?: string
}

export type ClineWorkerRequest =
  | ClineProbeCatalogRequest
  | ClinePrepareAttemptRequest
  | ClineStartAttemptRequest
  | ClineApprovalResponseMessage
  | ClineCancelAttemptRequest

export interface ClineWorkerReadyMessage {
  readonly type: 'ready'
}

export interface ClineCatalogResultMessage {
  readonly type: 'catalog_result'
  readonly requestId: string
  readonly ok: boolean
  readonly selectedModelId?: string
  readonly availableFreeModelIds?: readonly string[]
  readonly accountId?: string | null
  readonly errorCode?: string
  readonly errorMessage?: string
}

export interface ClinePrepareResultMessage {
  readonly type: 'prepare_result'
  readonly requestId: string
  readonly ok: boolean
  readonly status: 'READY' | 'REFUSED' | 'UNAVAILABLE'
  readonly modelId?: string
  readonly accountId?: string | null
  readonly reason?: string
  readonly errorMessage?: string
}

export interface ClineAttemptStartedMessage {
  readonly type: 'attempt_started'
  readonly attemptId: string
  readonly clineSessionId: string
  readonly lockedModelId: string
  readonly pid: number
}

export interface ClineExecutorEventMessage {
  readonly type: 'executor_event'
  readonly event: ExecutorEvent
}

export interface ClineApprovalRequestMessage {
  readonly type: 'approval_request'
  readonly attemptId: string
  readonly toolCallId: string
  readonly toolName: string
  readonly targetPath?: string
  readonly summary: string
}

export interface ClineAttemptTerminalMessage {
  readonly type: 'attempt_terminal'
  readonly attemptId: string
  readonly clineSessionId: string
  readonly status: ExecutorRunStatus
  readonly reason?: string
  readonly durationMs: number
  readonly summary?: string | null
  readonly usage?: ExecutorUsageRecord
  readonly billing?: ExecutorBillingRecord
  readonly cleanup: ClineWorkerCleanupReceipt
}

export type ClineWorkerMessage =
  | ClineWorkerReadyMessage
  | ClineCatalogResultMessage
  | ClinePrepareResultMessage
  | ClineAttemptStartedMessage
  | ClineExecutorEventMessage
  | ClineApprovalRequestMessage
  | ClineAttemptTerminalMessage
