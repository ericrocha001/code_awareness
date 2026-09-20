import type { DiagnosticTrace } from './diagnostic-trace'
import type { SystemHealthState } from '../../shared/types/system-health-types'
import { CANONICAL_PIPELINE } from './canonical-pipeline'

export function generateDiagnosticReport(state: SystemHealthState): string {
  const lines: string[] = []
  lines.push('System Health Diagnostic v1')
  lines.push(`Feature: CodeScope`)
  lines.push(`State: ${state.status}`)

  const subject = state.lastFailure ?? state.lastFunctionalProof
  if (subject && 'operation' in subject) {
    lines.push(`Operation: ${subject.operation}`)
    lines.push(`Trace: ${subject.traceId}`)
  }

  if (state.lastFunctionalProof) {
    lines.push(`Last functional proof: ${state.lastFunctionalProof.at} (${state.lastFunctionalProof.operation}, ${state.lastFunctionalProof.durationMs}ms)`)
  } else {
    lines.push('Last functional proof: none')
  }

  if (state.stale) lines.push('Evidence: STALE (reconnect or restart occurred)')
  lines.push('')

  if (state.lastFailure) {
    const f = state.lastFailure
    lines.push(`First failed boundary: ${f.firstFailedBoundary ?? 'unknown'}`)
    if (f.reasonCode) lines.push(`Reason: ${f.reasonCode}`)
    if (f.lastSuccessfulStage) lines.push(`Last successful stage: ${f.lastSuccessfulStage}`)
    lines.push('')
    lines.push('Pipeline:')
    for (const stage of f.stages) {
      const duration = stage.durationMs !== null ? ` — ${stage.durationMs}ms` : ''
      const reason = stage.reasonCode ? ` — ${stage.reasonCode}` : ''
      lines.push(`  ${stage.stage} — ${stage.status}${duration}${reason}`)
    }
  } else if (state.lastFunctionalProof) {
    lines.push('Pipeline: all stages operational (last functional proof)')
    for (const stage of CANONICAL_PIPELINE) {
      lines.push(`  ${stage} — OPERATIONAL`)
    }
  } else {
    lines.push('Pipeline: no evidence')
  }

  return lines.join('\n')
}

export function generateDiagnosticReportFromTrace(trace: DiagnosticTrace): string {
  const lines: string[] = []
  lines.push('System Health Diagnostic v1')
  lines.push('Feature: CodeScope')
  lines.push(`State: ${trace.success ? 'OPERATIONAL' : 'DEGRADED'}`)
  lines.push(`Operation: ${trace.operation}`)
  lines.push(`Trace: ${trace.traceId}`)
  lines.push(`At: ${trace.completedAt}`)
  lines.push(`Duration: ${trace.durationMs}ms`)
  lines.push('')
  if (trace.firstFailedBoundary) {
    lines.push(`First failed boundary: ${trace.firstFailedBoundary}`)
    if (trace.reasonCode) lines.push(`Reason: ${trace.reasonCode}`)
    if (trace.lastSuccessfulStage) lines.push(`Last successful stage: ${trace.lastSuccessfulStage}`)
    lines.push('')
  }
  lines.push('Pipeline:')
  for (const stage of trace.stages) {
    const duration = stage.durationMs !== null ? ` — ${stage.durationMs}ms` : ''
    const reason = stage.reasonCode ? ` — ${stage.reasonCode}` : ''
    lines.push(`  ${stage.stage} — ${stage.status}${duration}${reason}`)
  }
  return lines.join('\n')
}
