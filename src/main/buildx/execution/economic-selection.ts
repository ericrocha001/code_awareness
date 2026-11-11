import type {
  EconomicCandidateCostTier,
  EconomicCandidateProbeInput,
  EconomicCandidateRejection,
  EconomicCandidateSignal,
  EconomicPrivacyMode,
  EconomicSelectableExecutorId,
  EconomicSelectionDecision,
  EconomicSelectionPolicy,
  ExecutorSelection,
  ExecutorWorktreeTarget,
  NormalizedEconomicSelectionPolicy
} from '../../../shared/types/buildx/execution-types'
import {
  PUBLIC_EXECUTOR_IDS,
  normalizeExecutorSelection,
  sanitizeExecutorDiagnostics,
  type EconomicCandidateProvider,
  type PublicExecutorId
} from './executor-port'

export const ECONOMIC_TIE_BREAK_RULE =
  'COST_TIER_VERIFIED_ZERO_BEFORE_UNKNOWN_THEN_EXECUTOR_PROVIDER_MODEL_LEXICAL'

const ALLOWED_POLICY_KEYS = new Set([
  'mode',
  'allowUnknownCostFallback',
  'allowedExecutorIds',
  'privacy'
])

const VALID_PRIVACY_MODES = new Set<EconomicPrivacyMode>(['HOST_POLICY', 'NO_EXTERNAL_CODE'])

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function executorPriority(executorId: string): number {
  if (executorId === 'cline-sdk') return 0
  if (executorId === 'grok-cli') return 1
  return 2
}

function summarizeNoCandidateReason(rejections: readonly EconomicCandidateRejection[]): string {
  if (rejections.length === 0) return 'NO_ECONOMIC_CANDIDATES_CONFIGURED'
  if (rejections.every((r) => r.reason === 'PRIVACY_NO_EXTERNAL_CODE_FORBIDDEN')) {
    return 'PRIVACY_NO_EXTERNAL_CODE_FORBIDDEN'
  }
  if (rejections.every((r) => r.reason === 'UNKNOWN_COST_FALLBACK_DISABLED')) {
    return 'UNKNOWN_COST_FALLBACK_DISABLED'
  }
  if (rejections.length === 1) {
    return sanitizeExecutorDiagnostics(rejections[0].reason)
  }
  const summary = rejections.map((r) => `${r.executorId}:${r.reason}`).join('; ')
  const clean = sanitizeExecutorDiagnostics(summary)
  return clean.length > 320 ? `${clean.slice(0, 317)}...` : `NO_ELIGIBLE_ECONOMIC_CANDIDATE: ${clean}`
}

export function validateEconomicSelectionPolicy(raw: unknown): NormalizedEconomicSelectionPolicy {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('INVALID_ARGUMENT: economicSelection must be a plain object')
  }

  const record = raw as Record<string, unknown>
  const extraKeys = Object.keys(record).filter((key) => !ALLOWED_POLICY_KEYS.has(key))
  if (extraKeys.length > 0) {
    throw new Error(`INVALID_ARGUMENT: unexpected fields on economicSelection (${extraKeys.join(', ')})`)
  }

  if (record.mode !== 'VERIFIED_ZERO_FIRST') {
    throw new Error(
      `INVALID_ARGUMENT: unsupported economicSelection.mode "${String(record.mode ?? '')}"; expected "VERIFIED_ZERO_FIRST"`
    )
  }

  let allowUnknownCostFallback = false
  if (record.allowUnknownCostFallback !== undefined) {
    if (typeof record.allowUnknownCostFallback !== 'boolean') {
      throw new Error('INVALID_ARGUMENT: economicSelection.allowUnknownCostFallback must be a boolean')
    }
    allowUnknownCostFallback = record.allowUnknownCostFallback
  }

  let privacy: EconomicPrivacyMode = 'HOST_POLICY'
  if (record.privacy !== undefined) {
    if (typeof record.privacy !== 'string' || !VALID_PRIVACY_MODES.has(record.privacy as EconomicPrivacyMode)) {
      throw new Error(
        `INVALID_ARGUMENT: unsupported economicSelection.privacy "${String(record.privacy)}"; allowed values are "HOST_POLICY" or "NO_EXTERNAL_CODE"`
      )
    }
    privacy = record.privacy as EconomicPrivacyMode
  }

  let allowedExecutorIds: readonly EconomicSelectableExecutorId[] | null = null
  if (record.allowedExecutorIds !== undefined && record.allowedExecutorIds !== null) {
    if (!Array.isArray(record.allowedExecutorIds) || record.allowedExecutorIds.length === 0) {
      throw new Error('INVALID_ARGUMENT: economicSelection.allowedExecutorIds must be a non-empty array when provided')
    }
    const deduped: EconomicSelectableExecutorId[] = []
    for (const item of record.allowedExecutorIds) {
      if (typeof item !== 'string' || !PUBLIC_EXECUTOR_IDS.includes(item.trim() as PublicExecutorId)) {
        throw new Error(
          `INVALID_ARGUMENT: unsupported executorId "${String(item)}" in economicSelection.allowedExecutorIds`
        )
      }
      const cleanId = item.trim() as EconomicSelectableExecutorId
      if (!deduped.includes(cleanId)) {
        deduped.push(cleanId)
      }
    }
    allowedExecutorIds = Object.freeze(deduped)
  }

  return Object.freeze({
    mode: 'VERIFIED_ZERO_FIRST',
    allowUnknownCostFallback,
    allowedExecutorIds,
    privacy
  })
}

export function economicPoliciesEqual(
  a: EconomicSelectionPolicy | NormalizedEconomicSelectionPolicy,
  b: EconomicSelectionPolicy | NormalizedEconomicSelectionPolicy
): boolean {
  try {
    const normA = validateEconomicSelectionPolicy(a)
    const normB = validateEconomicSelectionPolicy(b)
    if (
      normA.mode !== normB.mode ||
      normA.allowUnknownCostFallback !== normB.allowUnknownCostFallback ||
      normA.privacy !== normB.privacy
    ) {
      return false
    }
    if (normA.allowedExecutorIds === null || normB.allowedExecutorIds === null) {
      return normA.allowedExecutorIds === normB.allowedExecutorIds
    }
    const sortedA = [...normA.allowedExecutorIds].sort()
    const sortedB = [...normB.allowedExecutorIds].sort()
    return (
      sortedA.length === sortedB.length &&
      sortedA.every((id, index) => id === sortedB[index])
    )
  } catch {
    return false
  }
}

interface AcceptedCandidate {
  readonly normalizedSelection: ExecutorSelection
  readonly costTier: 'VERIFIED_ZERO' | 'UNKNOWN'
  readonly quotaStatus: EconomicCandidateSignal['quotaStatus']
  readonly source: string
  readonly probedAt: string
  readonly verifiedZeroModelsCount?: number
}

function evaluateCandidateSignal(
  policy: NormalizedEconomicSelectionPolicy,
  candidate: EconomicCandidateSignal
):
  | { readonly accepted: true; readonly entry: AcceptedCandidate }
  | { readonly accepted: false; readonly rejection: EconomicCandidateRejection } {
  const probedAt = candidate.probedAt || new Date().toISOString()
  const source = sanitizeExecutorDiagnostics(candidate.source || 'UNKNOWN_SOURCE')

  let normalizedSelection: ExecutorSelection
  try {
    normalizedSelection = normalizeExecutorSelection(candidate.selection)
  } catch (err) {
    return {
      accepted: false,
      rejection: {
        executorId: String((candidate.selection as { executorId?: unknown })?.executorId ?? 'unknown'),
        providerId: null,
        modelId: null,
        costTier: candidate.costTier,
        reason: sanitizeExecutorDiagnostics(err instanceof Error ? err.message : String(err)),
        probedAt,
        source
      }
    }
  }

  const reject = (reason: string): { readonly accepted: false; readonly rejection: EconomicCandidateRejection } => ({
    accepted: false,
    rejection: {
      executorId: normalizedSelection.executorId,
      providerId: normalizedSelection.providerId ?? null,
      modelId: normalizedSelection.modelId ?? null,
      costTier: candidate.costTier,
      reason: sanitizeExecutorDiagnostics(reason),
      probedAt,
      source
    }
  })

  if (
    policy.allowedExecutorIds !== null &&
    !policy.allowedExecutorIds.includes(normalizedSelection.executorId as EconomicSelectableExecutorId)
  ) {
    return reject('EXECUTOR_NOT_ALLOWED')
  }

  if (policy.privacy === 'NO_EXTERNAL_CODE' && (candidate.requiresExternalTransfer || !candidate.privacyCompatible)) {
    return reject('PRIVACY_NO_EXTERNAL_CODE_FORBIDDEN')
  }

  if (!candidate.privacyCompatible) {
    return reject(candidate.reason || 'PRIVACY_POLICY_INCOMPATIBLE')
  }

  if (!candidate.hostAuthorized) {
    return reject(candidate.reason || 'HOST_NOT_AUTHORIZED')
  }

  if (!candidate.toolCapable) {
    return reject(candidate.reason || 'TOOL_CAPABILITY_REQUIRED')
  }

  if (candidate.costTier === 'CHARGED') {
    const baseReason = candidate.reason?.trim()
    return reject(
      baseReason && baseReason.includes('CHARGED')
        ? baseReason
        : baseReason
          ? `CHARGED_MODEL_FORBIDDEN: ${baseReason}`
          : 'CHARGED_MODEL_FORBIDDEN'
    )
  }

  if (!candidate.eligible) {
    return reject(candidate.reason || 'EXECUTOR_UNAVAILABLE')
  }

  if (normalizedSelection.executorId === 'cline-sdk' && !normalizedSelection.modelId) {
    return reject('FREE_MODEL_ID_REQUIRED')
  }

  if (candidate.quotaStatus === 'EXHAUSTED') {
    return reject(candidate.reason || 'QUOTA_EXHAUSTED')
  }

  if (candidate.costTier === 'UNKNOWN' && !policy.allowUnknownCostFallback) {
    return reject('UNKNOWN_COST_FALLBACK_DISABLED')
  }

  return {
    accepted: true,
    entry: {
      normalizedSelection: Object.freeze(normalizedSelection),
      costTier: candidate.costTier,
      quotaStatus: candidate.quotaStatus,
      source,
      probedAt,
      ...(candidate.verifiedZeroModels !== undefined
        ? { verifiedZeroModelsCount: candidate.verifiedZeroModels.length }
        : {})
    }
  }
}

function compareAcceptedCandidates(a: AcceptedCandidate, b: AcceptedCandidate): number {
  const tierDiff = (a.costTier === 'VERIFIED_ZERO' ? 0 : 1) - (b.costTier === 'VERIFIED_ZERO' ? 0 : 1)
  if (tierDiff !== 0) return tierDiff

  const execDiff =
    executorPriority(a.normalizedSelection.executorId) -
    executorPriority(b.normalizedSelection.executorId)
  if (execDiff !== 0) return execDiff

  const execLex = compareStrings(a.normalizedSelection.executorId, b.normalizedSelection.executorId)
  if (execLex !== 0) return execLex

  const providerLex = compareStrings(
    a.normalizedSelection.providerId ?? '',
    b.normalizedSelection.providerId ?? ''
  )
  if (providerLex !== 0) return providerLex

  return compareStrings(a.normalizedSelection.modelId ?? '', b.normalizedSelection.modelId ?? '')
}

export function evaluateEconomicCandidates(
  rawPolicy: EconomicSelectionPolicy | NormalizedEconomicSelectionPolicy,
  candidates: readonly EconomicCandidateSignal[],
  options?: {
    readonly nowIso?: string
    readonly preFilterRejections?: readonly EconomicCandidateRejection[]
  }
): EconomicSelectionDecision {
  const policy = validateEconomicSelectionPolicy(rawPolicy)
  const probedAt = options?.nowIso ?? new Date().toISOString()
  const rejections: EconomicCandidateRejection[] = [...(options?.preFilterRejections ?? [])]
  const accepted: AcceptedCandidate[] = []

  for (const candidate of candidates) {
    const verdict = evaluateCandidateSignal(policy, candidate)
    if (verdict.accepted) {
      accepted.push(verdict.entry)
    } else {
      rejections.push(verdict.rejection)
    }
  }

  const candidateCount = (options?.preFilterRejections?.length ?? 0) + candidates.length
  if (accepted.length === 0) {
    return Object.freeze({
      status: 'UNAVAILABLE',
      policy,
      selection: null,
      costTier: null,
      quotaStatus: null,
      reason: summarizeNoCandidateReason(rejections),
      tieBreakRule: ECONOMIC_TIE_BREAK_RULE,
      source: null,
      probedAt,
      candidateCount,
      rejections: Object.freeze(rejections)
    })
  }

  accepted.sort(compareAcceptedCandidates)
  const winner = accepted[0]

  return Object.freeze({
    status: 'SELECTED',
    policy,
    selection: winner.normalizedSelection,
    costTier: winner.costTier,
    quotaStatus: winner.quotaStatus,
    reason:
      winner.costTier === 'VERIFIED_ZERO'
        ? 'SELECTED_VERIFIED_ZERO_COST'
        : 'SELECTED_UNKNOWN_COST_FALLBACK',
    tieBreakRule: ECONOMIC_TIE_BREAK_RULE,
    source: winner.source,
    probedAt: winner.probedAt,
    candidateCount,
    ...(winner.verifiedZeroModelsCount !== undefined
      ? { verifiedZeroModelsCount: winner.verifiedZeroModelsCount }
      : {}),
    rejections: Object.freeze(rejections)
  })
}

export async function selectEconomicExecutor(input: {
  readonly repositoryId: string
  readonly policy: unknown
  readonly providers: readonly EconomicCandidateProvider[]
  readonly requestedModelId?: string | null
  readonly worktree?: ExecutorWorktreeTarget
  readonly nowIso?: string
}): Promise<EconomicSelectionDecision> {
  if (typeof input?.repositoryId !== 'string' || !input.repositoryId.trim()) {
    throw new Error('INVALID_ARGUMENT: repositoryId must be a non-empty string')
  }

  const policy = validateEconomicSelectionPolicy(input.policy)
  const nowIso = input.nowIso ?? new Date().toISOString()
  const preFilterRejections: EconomicCandidateRejection[] = []
  const providersToProbe: EconomicCandidateProvider[] = []

  for (const provider of input.providers) {
    const desc = provider.economicDescriptor
    if (policy.allowedExecutorIds !== null && !policy.allowedExecutorIds.includes(desc.executorId)) {
      preFilterRejections.push({
        executorId: desc.executorId,
        providerId: desc.providerId ?? null,
        modelId: null,
        costTier: 'UNKNOWN',
        reason: 'EXECUTOR_NOT_ALLOWED',
        probedAt: nowIso,
        source: 'ECONOMIC_POLICY_PREFILTER'
      })
      continue
    }

    if (policy.privacy === 'NO_EXTERNAL_CODE' && desc.requiresExternalTransfer) {
      preFilterRejections.push({
        executorId: desc.executorId,
        providerId: desc.providerId ?? null,
        modelId: null,
        costTier: 'UNKNOWN',
        reason: 'PRIVACY_NO_EXTERNAL_CODE_FORBIDDEN',
        probedAt: nowIso,
        source: 'ECONOMIC_POLICY_PREFILTER'
      })
      continue
    }

    providersToProbe.push(provider)
  }

  const probeInput: EconomicCandidateProbeInput = {
    repositoryId: input.repositoryId.trim(),
    ...(input.requestedModelId !== undefined ? { requestedModelId: input.requestedModelId } : {}),
    ...(input.worktree ? { worktree: input.worktree } : {}),
    nowIso
  }

  const signals = await Promise.all(
    providersToProbe.map(async (provider): Promise<EconomicCandidateSignal> => {
      const desc = provider.economicDescriptor
      try {
        return await provider.probeEconomicCandidate(probeInput)
      } catch (err) {
        const reason = sanitizeExecutorDiagnostics(err instanceof Error ? err.message : String(err))
        return {
          selection: {
            executorId: desc.executorId,
            providerId: desc.providerId ?? null,
            modelId: null
          },
          eligible: false,
          hostAuthorized: false,
          toolCapable: false,
          privacyCompatible: policy.privacy !== 'NO_EXTERNAL_CODE' || !desc.requiresExternalTransfer,
          requiresExternalTransfer: desc.requiresExternalTransfer,
          costTier: 'UNKNOWN' as EconomicCandidateCostTier,
          quotaStatus: 'UNKNOWN',
          reason: reason || 'CANDIDATE_PROBE_ERROR',
          source: 'ECONOMIC_CANDIDATE_PROBE',
          probedAt: nowIso
        }
      }
    })
  )

  return evaluateEconomicCandidates(policy, signals, {
    nowIso,
    preFilterRejections
  })
}
