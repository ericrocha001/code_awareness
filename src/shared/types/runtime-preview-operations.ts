import type { PreviewSelection, PreviewPreflight, PreviewProfileSummary } from './runtime-preview-types'
import type { BranchWorktree } from './branch-orchestration-types'
export type PreviewCoverageStatus = 'VERIFIED' | 'UNVERIFIABLE' | 'NOT_OBSERVED' | 'STALE'
export interface PreviewCoverage {
  stage: 'TARGET_CHECKOUT' | 'ENDPOINT' | 'SERVED_ARTIFACT' | 'LOADED_COMPONENT' | 'BEHAVIOR'
  component: 'TARGET' | 'PROCESS' | 'WEB' | 'ELECTRON_MAIN' | 'ELECTRON_PRELOAD' | 'ELECTRON_RENDERER'
  status: PreviewCoverageStatus; fingerprint: string | null; evidenceRef: string | null; at: string; reasonCode: string
}
export interface PreviewValidationLink { bindingId: string; executionId: string; criterionId: string; proofId: string; evidenceRevision: number; sourceFingerprint?: string }
export interface PreviewQualification extends PreviewValidationLink {
  status: 'PASSED' | 'FAILED' | 'INCONCLUSIVE'; reasons: string[]; observedStatus: string; at: string; evidenceAt: string | null; scope: string[]
}
export interface PreviewSessionView {
  sessionId: string; operationId: string; selection: PreviewSelection; revision: number; profileRevision: number
  state: 'PREPARING' | 'RUNNING' | 'STOPPING' | 'STOPPED' | 'FAILED' | 'CLEANUP_INCOMPLETE' | 'OWNERSHIP_UNVERIFIED'
  readiness: 'NOT_OBSERVED' | 'READY' | 'NOT_READY' | 'UNVERIFIABLE'; liveness: 'NOT_OBSERVED' | 'VERIFIED' | 'UNVERIFIABLE'
  observation: 'CURRENT' | 'HISTORICAL' | 'IN_PROGRESS' | 'UNVERIFIABLE'
  resources: 'RESERVED' | 'RELEASED' | 'UNVERIFIABLE'; failure: string | null; at: string; startedAt: string; endedAt: string | null
  source: PreviewPreflight['snapshot'] | null; coverage: PreviewCoverage[]
  qualifications: PreviewQualification[]; endpoint: string | null
  process: { rootExited: boolean; activeProcesses: number; handlesClosed: boolean; assignedAtCreation: boolean } | null
  termination?: { kind: 'STOP_REQUESTED' | 'UNEXPECTED_EXIT' | 'STARTUP_FAILURE' | 'UNKNOWN'; reasonCode: string;
    rootExit: { status: 'KNOWN' | 'UNKNOWN'; code: number | null; reasonCode: string; observedAt: string | null } }
}
export type RuntimePreviewRequest =
  | { action: 'RUN_BRANCH_APP'; repositoryId: string; ref: string; revision: string; operationId: string; worktree?: { worktreeId: string; generation: string } }
  | { action: 'PROFILES' | 'WORKTREES'; repositoryId: string }
  | { action: 'PREFLIGHT' | 'AUTHORIZE'; selection: PreviewSelection }
  | { action: 'START'; selection: PreviewSelection; operationId: string }
  | { action: 'LIST'; repositoryId: string; worktreeId?: string; cursor?: string; limit?: number }
  | { action: 'INSPECT' | 'STOP' | 'BINDINGS'; sessionId: string }
  | { action: 'PROBE'; sessionId: string; probes: Array<'READINESS' | 'ATTESTATION'> }
  | { action: 'EVIDENCE'; sessionId: string; revision?: number; section: 'COVERAGE' | 'SOURCE' | 'RUNTIME'; offset?: number; limit?: number }
  | { action: 'QUALIFY'; sessionId: string; bindingId: string; criterionId: string; proofId: string }
export type RuntimePreviewData =
  | { kind: 'BRANCH_APP'; reasonCode: string; message: string; candidates?: BranchWorktree[]; preflight?: PreviewPreflight; activeSession?: PreviewSessionView }
  | { kind: 'PROFILES'; profiles: PreviewProfileSummary[] }
  | { kind: 'WORKTREES'; repositoryId: string; worktrees: BranchWorktree[] }
  | { kind: 'PREFLIGHT'; preflight: PreviewPreflight; startAllowed: boolean }
  | { kind: 'SESSION'; session: PreviewSessionView | null; operationId?: string; pending: boolean }
  | { kind: 'SESSIONS'; sessions: PreviewSessionView[]; nextCursor: string | null; pendingOperationId: string | null; lastOperation: { operationId: string; code: string | null; result?: RuntimePreviewResult } | null }
  | { kind: 'EVIDENCE'; sessionId: string; revision: number; section: 'COVERAGE' | 'SOURCE' | 'RUNTIME'; entries: unknown[]; nextOffset: number | null }
  | { kind: 'BINDINGS'; bindings: Array<{ bindingId: string; executionId: string }>; reason: string | null }
  | { kind: 'QUALIFICATION'; session: PreviewSessionView; qualification: PreviewQualification }
export type RuntimePreviewResult = { success: true; data: RuntimePreviewData } | { success: false; code: string }
