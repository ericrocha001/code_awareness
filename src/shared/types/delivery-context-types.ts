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
export interface DeliveryObservation { receiptId: string; operationId: string; operation: 'commit_git_changes' | 'CREATE_PULL_REQUEST'; argumentFingerprint: string; anchor: DeliveryAnchor;
  commitSha?: string; pullRequest?: number; headSha?: string; repository?: string }
export interface DeliveryProjectionPage { observations: DeliveryObservation[]; nextCursor?: string }
export type PrepareDelivery = (request: DeliveryContextRequest) => Promise<DeliveryAnchor>
export type ObserveDelivery = () => Promise<ExecutionBranchSnapshot>

export function sameDeliveryScope(before: DeliveryAnchor, after: DeliveryAnchor): boolean {
  return ['repositoryId','bindingArtifactId','bindingRevision','bindingDigest','planArtifactId','planRevision','planDigest','executionId'].every(key => before[key as keyof DeliveryAnchor] === after[key as keyof DeliveryAnchor]) &&
    ['repositoryId','worktreeId','worktreeGeneration','branchRef','branchGeneration'].every(key => before.snapshot[key as keyof DeliveryAnchor['snapshot']] === after.snapshot[key as keyof DeliveryAnchor['snapshot']])
}
