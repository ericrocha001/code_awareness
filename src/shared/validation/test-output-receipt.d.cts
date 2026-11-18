export type AcceptancePinStatus = 'VERIFIED' | 'MISMATCH' | 'UNVERIFIED'
export type AcceptanceSourceKind = 'PROVIDER_PIN_AND_CLI_VERSION' | 'PROVIDER_PIN_CONFIG' | 'UNAVAILABLE'
export type AcceptanceOutcome =
  | 'VERIFIED'
  | 'VERSION_MISMATCH'
  | 'PIN_MISMATCH'
  | 'SOURCE_UNAVAILABLE'
  | 'SKIPPED'
  | 'ERROR'
  | 'INCOMPLETE'
export type AcceptanceSourceIdentity = 'BEFORE_AFTER_CAPTURED' | 'SOURCE_CHANGED_DURING_RUN' | 'SOURCE_UNAVAILABLE'
export type AcceptanceCoverage = 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE'

export interface ProviderAcceptanceSummary {
  id: string
  provider: string
  version: string | null
  sha256: string | null
  pin: AcceptancePinStatus
  source: AcceptanceSourceKind
  outcome: AcceptanceOutcome
  sourceIdentity: AcceptanceSourceIdentity
  coverage?: AcceptanceCoverage
  sessions?: number
  usageCoverage?: AcceptanceCoverage
  transcriptImported: false
  code?: string
  reason?: string
}

export interface AcceptanceEvaluation {
  sufficient: boolean
  reason?: string
  acceptance: ProviderAcceptanceSummary
}

export function receiptDigest(receipt: Record<string, unknown>): string
export function sameValidationSource(before: unknown, after: unknown): boolean
export function sourceIdentityFromLedger(ledger?: { before?: unknown; after?: unknown } | null): AcceptanceSourceIdentity
export function evaluateAcceptanceSummary(
  raw: unknown,
  ledger?: { before?: unknown; after?: unknown } | null
): AcceptanceEvaluation
export function recordTestAcceptance(summary: unknown, targetFile?: string): boolean
export function readRecordedAcceptance(targetFile?: string): { present: boolean; raw?: unknown }
