import type { RuntimePreviewStatus } from '../../../shared/types/runtime-preview-operations'
import type { PreviewSessionRecord, PreviewIntentReceipt } from './session-store'

export function previewStatus(receipt?: PreviewIntentReceipt, record?: PreviewSessionRecord, options: { pending?: boolean; stopping?: boolean; owned?: boolean; operationId?: string; sessionId?: string } = {}): RuntimePreviewStatus {
  const status: RuntimePreviewStatus = {
    kind: 'STATUS', operationId: record?.operationId ?? receipt?.operationId ?? options.operationId ?? null,
    sessionId: record?.sessionId ?? receipt?.sessionId ?? options.sessionId ?? null,
    revision: `${receipt?.revision ?? 0}:${record?.revision ?? 0}:${options.pending ? 1 : 0}:${options.stopping ? 1 : 0}:${options.owned ? 1 : 0}:${receipt?.head ? 1 : 0}`,
    phase: receipt?.phase ?? 'UNKNOWN', ready: false,
    repositoryId: record?.selection.repositoryId ?? receipt?.repositoryId ?? null,
    branch: record?.sourceSnapshot?.branch ?? receipt?.branch ?? null, head: record?.sourceSnapshot?.head ?? receipt?.head ?? null,
    worktreeId: record?.selection.worktreeId ?? receipt?.worktreeId ?? null, reasonCode: receipt?.reasonCode ?? null,
    recommendedAction: 'INSPECT_ERROR', resourcesReleased: null, activeProcesses: null, handlesClosed: null,
    observedAt: record?.at ?? receipt?.at ?? null
  }
  if (!record) {
    if (receipt?.revision === 0) {
      status.phase = options.pending ? 'PREPARING' : 'UNKNOWN'
      status.reasonCode = options.pending ? null : 'OPERATION_INTERRUPTED'
    } else if (!receipt) {
      status.phase = options.pending ? 'PREPARING' : 'UNKNOWN'
      status.reasonCode = options.pending ? null : 'PREVIEW_IDENTITY_NOT_FOUND'
    }
  } else {
    const process = record.process
    status.activeProcesses = process?.activeProcesses ?? null
    status.handlesClosed = process ? process.knownHandlesClosed && process.jobClosed && process.eventClosed : null
    status.resourcesReleased = record.resources === 'RELEASED' && status.activeProcesses === 0 && status.handlesClosed === true
    status.reasonCode = record.failure
    status.phase = ['PREPARING', 'RUNNING', 'STOPPING', 'STOPPED', 'FAILED'].includes(record.state) ? record.state as RuntimePreviewStatus['phase'] : 'UNKNOWN'
    if (record.persistence !== 'PERSISTED' || record.reconciliation === 'REQUIRED' || ['STOPPED', 'FAILED'].includes(record.state) && !status.resourcesReleased) {
      status.phase = 'UNKNOWN'; status.reasonCode ??= 'RUNTIME_EVIDENCE_UNVERIFIABLE'
    } else if (!['STOPPED', 'FAILED'].includes(record.state) && !options.owned && !options.pending) {
      status.phase = 'UNKNOWN'; status.reasonCode ??= 'RUNTIME_RECONCILIATION_REQUIRED'
    }
    if (options.stopping) status.phase = 'STOPPING'
    status.ready = status.phase === 'RUNNING' && options.owned === true && record.readiness === 'READY' && record.liveness === 'VERIFIED' &&
      record.attestation.loadedCode === 'VERIFIED' &&
      record.coverage.some(c => c.stage === 'TARGET_CHECKOUT' && c.status === 'VERIFIED') && record.coverage.some(c => c.stage === 'ENDPOINT' && c.status === 'VERIFIED')
  }
  status.recommendedAction = status.ready ? 'ASK_HUMAN_REVIEW' : ['PENDING', 'PREPARING', 'STOPPING'].includes(status.phase) ? 'WAIT' :
    status.phase === 'STOPPED' ? 'NONE' : status.reasonCode === 'PROFILE_APPROVAL_REQUIRED' ? 'REQUEST_NATIVE_APPROVAL' :
      status.reasonCode === 'PREVIEW_SESSION_ACTIVE' ? 'STOP' : 'INSPECT_ERROR'
  return status
}
