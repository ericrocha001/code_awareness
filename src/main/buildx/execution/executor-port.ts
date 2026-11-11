import type {
  CancelExecutorAttemptInput,
  ExecutorAvailabilityResult,
  ExecutorEvent,
  ExecutorPreparationResult,
  ExecutorRunObservation,
  ExecutorSelection,
  ExecutorTerminationConfirmation,
  ObserveExecutorAttemptInput,
  PrepareExecutorAttemptInput,
  StartExecutorAttemptInput
} from '../../../shared/types/buildx/execution-types'

export interface UnitExecutorPort {
  readonly identity: ExecutorSelection
  checkAvailability(repositoryId: string): Promise<ExecutorAvailabilityResult> | ExecutorAvailabilityResult
  prepareAttempt(input: PrepareExecutorAttemptInput): Promise<ExecutorPreparationResult> | ExecutorPreparationResult
  startAttempt(input: StartExecutorAttemptInput): Promise<ExecutorRunObservation> | ExecutorRunObservation
  observeAttempt(input: ObserveExecutorAttemptInput): Promise<ExecutorRunObservation> | ExecutorRunObservation
  cancelAttempt(input: CancelExecutorAttemptInput): Promise<ExecutorRunObservation> | ExecutorRunObservation
  confirmTermination?(input: ObserveExecutorAttemptInput): Promise<ExecutorTerminationConfirmation> | ExecutorTerminationConfirmation
  subscribe?(attemptId: string, listener: (event: ExecutorEvent) => void): () => void
}

export type UnitExecutorResolver = (
  repositoryId: string,
  selection?: ExecutorSelection
) => Promise<UnitExecutorPort | null> | UnitExecutorPort | null

export function normalizeExecutorSelection(selection: ExecutorSelection): ExecutorSelection {
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) {
    throw new Error('INVALID_EXECUTOR_SELECTION: executorSelection must be an object')
  }
  if (typeof selection.executorId !== 'string' || !selection.executorId.trim()) {
    throw new Error('INVALID_EXECUTOR_SELECTION: executorId must be a non-empty string')
  }

  let providerId: string | null = null
  if (selection.providerId !== undefined && selection.providerId !== null) {
    if (typeof selection.providerId !== 'string' || !selection.providerId.trim()) {
      throw new Error('INVALID_EXECUTOR_SELECTION: providerId must be a non-empty string when provided')
    }
    providerId = selection.providerId.trim()
  }

  let modelId: string | null = null
  if (selection.modelId !== undefined && selection.modelId !== null) {
    if (typeof selection.modelId !== 'string' || !selection.modelId.trim()) {
      throw new Error('INVALID_EXECUTOR_SELECTION: modelId must be a non-empty string when provided')
    }
    modelId = selection.modelId.trim()
  }

  return {
    executorId: selection.executorId.trim(),
    providerId,
    modelId
  }
}

export function isValidExecutorSelection(selection: unknown): selection is ExecutorSelection {
  try {
    normalizeExecutorSelection(selection as ExecutorSelection)
    return true
  } catch {
    return false
  }
}

export function executorSelectionsEqual(a: ExecutorSelection, b: ExecutorSelection): boolean {
  try {
    const normA = normalizeExecutorSelection(a)
    const normB = normalizeExecutorSelection(b)
    return (
      normA.executorId === normB.executorId &&
      (normA.providerId ?? null) === (normB.providerId ?? null) &&
      (normA.modelId ?? null) === (normB.modelId ?? null)
    )
  } catch {
    return false
  }
}

export function formatExecutorSelection(selection: ExecutorSelection): string {
  return `executorId=${selection.executorId}, providerId=${selection.providerId ?? 'null'}, modelId=${selection.modelId ?? 'null'}`
}
