export interface LocalAgentDiagnostic {
  code: string
  stage?: string
  reason?: string
  operation?: string
  elapsedMs?: number
  connectMs?: number
  snapshotPhase?: string
  snapshotTimings?: Record<string, number>
}
export function safeDiagnostic(error: unknown, fallback?: string): LocalAgentDiagnostic
