import { z } from 'zod'
import type { ExecutionBranchSnapshot } from './execution-branch-types'
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/)
export const deliveryContextRequest = z.object({
  bindingArtifactId: z.string().regex(/^artifact-execution-branch-[a-f0-9]{64}$/), bindingRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  planArtifactId: z.string().regex(/^artifact-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/), planRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), executionId: identifier
}).strict()
export type DeliveryContextRequest = z.infer<typeof deliveryContextRequest>
export const DELIVERY_CONTEXT_SCHEMA = { type: 'object', properties: {
  bindingArtifactId: { type: 'string', pattern: '^artifact-execution-branch-[a-f0-9]{64}$' }, bindingRevision: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
  planArtifactId: { type: 'string', pattern: '^artifact-[a-f0-9-]{36}$' }, planRevision: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, executionId: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$' }
}, required: ['bindingArtifactId', 'bindingRevision', 'planArtifactId', 'planRevision', 'executionId'], additionalProperties: false }
const snapshot = z.object({ repositoryId: identifier, branchRef: z.string().startsWith('refs/heads/').max(512), branchGeneration: hash, branchRevision: hash,
  head: z.string().regex(/^[a-f0-9]{40,64}$/), worktreeId: hash, worktreeGeneration: hash, fingerprint: hash }).strict()
export const deliveryAnchor = deliveryContextRequest.extend({ schemaVersion: z.literal(1), repositoryId: identifier, planDigest: hash, bindingDigest: hash, snapshot,
  classification: z.literal('AUTHENTICATED_EXECUTION_CONTEXT') }).strict()
export type DeliveryAnchor = z.infer<typeof deliveryAnchor>
export const authenticatedSessionWitness = z.object({
  provider: z.enum(['codex', 'antigravity', 'unknown']),
  sessionId: z.string().min(1).max(200).optional(),
  invocationId: z.string().min(1).max(200).optional(),
  principalId: identifier.optional(),
  channelId: identifier.optional()
}).strict()
export type AuthenticatedSessionWitness = z.infer<typeof authenticatedSessionWitness>
export interface DeliveryObservation { receiptId: string; operationId: string; operation: 'commit_git_changes' | 'mutate_worktree' | 'merge_git_branch' | 'revert_git_commit' | 'CREATE_PULL_REQUEST' | 'PUBLISH_ARTIFACT' | 'UPDATE_ARTIFACT' | 'VALIDATION_PROOF'; argumentFingerprint: string; anchor: DeliveryAnchor;
  commitSha?: string; pullRequest?: number; headSha?: string; repository?: string; artifactId?: string; artifactRevision?: number; proofId?: string }
export interface DeliveryProjectionPage { observations: DeliveryObservation[]; nextCursor?: string }
export type PrepareDelivery = (request: DeliveryContextRequest) => Promise<DeliveryAnchor>
export type ObserveDelivery = () => Promise<ExecutionBranchSnapshot>

export type ResolvedDeliveryContext =
  | { ok: true; request?: DeliveryContextRequest }
  | { ok: false; code: 'DELIVERY_CONTEXT_INVALID'; reason: string }

export function sameDeliveryRequest(a: DeliveryContextRequest, b: DeliveryContextRequest): boolean {
  return a.bindingArtifactId === b.bindingArtifactId &&
    a.bindingRevision === b.bindingRevision &&
    a.planArtifactId === b.planArtifactId &&
    a.planRevision === b.planRevision &&
    a.executionId === b.executionId
}

export function resolveEffectiveDeliveryContext(
  explicit?: unknown,
  authorityContext?: DeliveryContextRequest,
  authorityError?: string
): ResolvedDeliveryContext {
  if (authorityError) {
    return { ok: false, code: 'DELIVERY_CONTEXT_INVALID', reason: authorityError }
  }
  if (explicit !== undefined) {
    const parsed = deliveryContextRequest.safeParse(explicit)
    if (!parsed.success) {
      return { ok: false, code: 'DELIVERY_CONTEXT_INVALID', reason: 'DELIVERY_CONTEXT_MALFORMED' }
    }
    if (authorityContext && !sameDeliveryRequest(parsed.data, authorityContext)) {
      return { ok: false, code: 'DELIVERY_CONTEXT_INVALID', reason: 'DELIVERY_CONTEXT_CONFLICT' }
    }
    return { ok: true, request: parsed.data }
  }
  if (authorityContext !== undefined) {
    const parsed = deliveryContextRequest.safeParse(authorityContext)
    if (!parsed.success) {
      return { ok: false, code: 'DELIVERY_CONTEXT_INVALID', reason: 'DELIVERY_CONTEXT_MALFORMED' }
    }
    return { ok: true, request: parsed.data }
  }
  return { ok: true, request: undefined }
}

export type ExecutionActivationStatus = 'ACTIVE' | 'REVOKED' | 'CLOSED'
export type ExecutionActivationScopeKind = 'CHECKOUT' | 'REMOTE_DELEGATED'

export interface ExecutionActivationRecord {
  activationId: string
  revision: number
  repositoryId: string
  worktreeId: string
  worktreeGeneration: string
  branchRef: string
  branchGeneration: string
  executionId: string
  planArtifactId: string
  planRevision: number
  planContentHash: string
  bindingArtifactId: string
  bindingRevision: number
  bindingContentHash: string
  scopeKind: ExecutionActivationScopeKind
  status: ExecutionActivationStatus
  activatedAt: string
  updatedAt: string
  revokedAt?: string
  revokedReason?: string
}

export interface ExecutionIdentityRecord {
  executionId: string
  source: 'PLAN_METADATA' | 'BACKEND_ASSIGNED'
  assignedRevision: number
  createdAt: string
}

export function sameDeliveryScope(before: DeliveryAnchor, after: DeliveryAnchor): boolean {
  return ['repositoryId','bindingArtifactId','bindingRevision','bindingDigest','planArtifactId','planRevision','planDigest','executionId'].every(key => before[key as keyof DeliveryAnchor] === after[key as keyof DeliveryAnchor]) &&
    ['repositoryId','worktreeId','worktreeGeneration','branchRef','branchGeneration'].every(key => before.snapshot[key as keyof DeliveryAnchor['snapshot']] === after.snapshot[key as keyof DeliveryAnchor['snapshot']])
}
