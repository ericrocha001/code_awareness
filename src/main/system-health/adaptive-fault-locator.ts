import type {
  CanonicalStage,
  DiagnosticFrontier,
  DiagnosticResolution,
  NextBestEvidence,
  ObservabilityGap,
  ObservabilityGapState,
  StageStatus
} from '../../shared/types/system-health-types'

export interface ExecutionCoordinate {
  id: string
  label: string
  kind: 'feature' | 'stage' | 'checkpoint' | 'component'
  parentId?: string
  children?: string[]
}

export type ProgressState = 'ENTERED' | 'COMPLETED' | 'FAILED' | 'OPEN' | 'UNREACHED'

export interface CoordinateProgress {
  coordinate: ExecutionCoordinate
  state: ProgressState
  durationMs?: number | null
  reasonCode?: string | null
}

export interface CausalExecutionGraph {
  coordinates: Map<string, ExecutionCoordinate>
  progress: Map<string, CoordinateProgress>
  rootId: string
}

export interface AdaptiveLocalizationResult {
  deepestProvenProgress: string | null
  diagnosticFrontier: DiagnosticFrontier | null
  diagnosticResolution: DiagnosticResolution
  observabilityGap: ObservabilityGap
  nextBestEvidence: NextBestEvidence | null
}

export function computeLinearAdaptiveLocalization(params: {
  canonicalStage: CanonicalStage
  checkpointNames: readonly string[]
  statuses: Map<string, { status: StageStatus; durationMs?: number | null; reasonCode?: string | null }>
  missingEvidence?: string[]
  availableInstrumentation?: Set<string>
  hasRefinedTarget?: boolean
  customNextBestEvidence?: NextBestEvidence | null
}): AdaptiveLocalizationResult {
  const {
    canonicalStage,
    checkpointNames,
    statuses,
    missingEvidence = [],
    availableInstrumentation = new Set<string>(),
    hasRefinedTarget = false,
    customNextBestEvidence = null
  } = params

  let lastProvenCheckpoint: string | null = null
  let atCheckpoint: string | null = null
  let nextBlockedCheckpoint: string | null = null
  let failedCheckpoint: string | null = null

  for (let i = 0; i < checkpointNames.length; i++) {
    const cp = checkpointNames[i]
    const info = statuses.get(cp)
    const status = info?.status ?? 'UNKNOWN'

    if (status === 'OPERATIONAL') {
      lastProvenCheckpoint = cp
    } else if (status === 'FAILED') {
      failedCheckpoint = cp
      atCheckpoint = cp
      nextBlockedCheckpoint = i + 1 < checkpointNames.length ? checkpointNames[i + 1] : null
      break
    } else if (status === 'UNKNOWN') {
      atCheckpoint = cp
      nextBlockedCheckpoint = i + 1 < checkpointNames.length ? checkpointNames[i + 1] : null
      break
    } else if (status === 'BLOCKED') {
      if (!atCheckpoint) {
        atCheckpoint = cp
      }
      break
    }
  }

  // Deepest proven progress: the furthest checkpoint with confirmed progress
  const deepestProvenProgress = lastProvenCheckpoint ?? (atCheckpoint ? `${canonicalStage}` : null)

  // Diagnostic frontier: boundaries between proven and problem/open
  const precision = failedCheckpoint ? 'EXACT' : 'BOUNDED'
  const targetAt = atCheckpoint ?? canonicalStage
  const diagnosticFrontier: DiagnosticFrontier = {
    lastProven: lastProvenCheckpoint,
    at: targetAt,
    ...(nextBlockedCheckpoint ? { nextBlocked: nextBlockedCheckpoint } : {}),
    precision
  }

  // Diagnostic resolution
  let diagnosticResolution: DiagnosticResolution
  if (hasRefinedTarget && failedCheckpoint) {
    diagnosticResolution = 'COMPONENT'
  } else if (atCheckpoint && checkpointNames.includes(atCheckpoint)) {
    diagnosticResolution = 'CHECKPOINT'
  } else if (canonicalStage) {
    diagnosticResolution = 'STAGE'
  } else {
    diagnosticResolution = 'FEATURE'
  }

  // Observability gap
  let gapState: ObservabilityGapState
  let nextBestEvidence: NextBestEvidence | null = customNextBestEvidence

  if (failedCheckpoint && precision === 'EXACT' && (diagnosticResolution === 'COMPONENT' || hasRefinedTarget)) {
    gapState = 'NONE'
    nextBestEvidence = null
  } else if (missingEvidence.length > 0) {
    const primaryMissing = missingEvidence[0]
    const isInstAvailable = availableInstrumentation.has(primaryMissing)
    gapState = isInstAvailable ? 'EVIDENCE_AVAILABLE' : 'EVIDENCE_MISSING'

    if (!nextBestEvidence) {
      nextBestEvidence = {
        evidenceKey: primaryMissing,
        boundary: `${lastProvenCheckpoint ?? canonicalStage} → ${targetAt}`,
        diagnosticValue: `Distinguishes progress past ${lastProvenCheckpoint ?? canonicalStage} from blockage at ${targetAt}`,
        instrumentationState: isInstAvailable ? 'AVAILABLE' : 'MISSING'
      }
    }
  } else if (precision === 'BOUNDED' && atCheckpoint) {
    // When bounded without explicit missing evidence list, identify the boundary
    gapState = 'EVIDENCE_AVAILABLE'
    if (!nextBestEvidence) {
      nextBestEvidence = {
        evidenceKey: atCheckpoint.toLowerCase().replace(/\s+/g, '-'),
        boundary: `${lastProvenCheckpoint ?? canonicalStage} → ${atCheckpoint}`,
        diagnosticValue: `Observes entry into ${atCheckpoint}`,
        instrumentationState: 'AVAILABLE'
      }
    }
  } else {
    gapState = 'NONE'
    nextBestEvidence = null
  }

  const observabilityGap: ObservabilityGap = {
    state: gapState,
    currentBoundary: `${lastProvenCheckpoint ?? canonicalStage} → ${targetAt}`,
    ...(missingEvidence.length > 0 ? { missingEvidence } : {}),
    instrumentationAvailable: gapState === 'EVIDENCE_AVAILABLE'
  }

  return {
    deepestProvenProgress,
    diagnosticFrontier,
    diagnosticResolution,
    observabilityGap,
    nextBestEvidence
  }
}
