import type { RemovalRequest } from '../../shared/types/worktree-removal-types'

const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value)
const keys = (value: Record<string, any>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key))
const text = (value: unknown, max = 4096): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0')
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)

export function validRemovalRequest(value: unknown): value is RemovalRequest {
  if (!object(value) || !keys(value, ['context', 'operation']) || !object(value.context) || !keys(value.context, ['projectId', 'revision']) || !text(value.context.projectId, 256) || !Number.isSafeInteger(value.context.revision) || value.context.revision < 0 || !object(value.operation)) return false
  const op = value.operation
  if (op.action === 'RECOVER') return keys(op, ['action', 'worktreeId', 'generation']) && hash(op.worktreeId) && hash(op.generation)
  if (op.action === 'POLICY') return keys(op, ['action', 'enabled']) && (op.enabled === undefined || typeof op.enabled === 'boolean')
  if (op.action === 'PREPARE') {
    if (!keys(op, ['action', 'worktreeId', 'generation', 'intent', 'prNumber']) || !hash(op.worktreeId) || !hash(op.generation) || !object(op.intent) || op.prNumber !== undefined && (!Number.isSafeInteger(op.prNumber) || op.prNumber <= 0)) return false
    const intent = op.intent
    if (!keys(intent, ['mode', 'delivery', 'noPullRequestConfirmed', 'abandonmentReason']) || !['INTEGRATED', 'ABANDONED'].includes(intent.mode) || typeof intent.noPullRequestConfirmed !== 'boolean' || typeof intent.abandonmentReason !== 'string' || intent.abandonmentReason.length > 4096) return false
    if (intent.delivery === null) return true
    const d = intent.delivery
    return object(d) && keys(d, ['repositoryId', 'repository', 'prNumber', 'prId', 'sourceRepositoryId', 'sourceBranch', 'head', 'targetBranch']) &&
      [d.repositoryId, d.repository, d.prId, d.sourceRepositoryId, d.sourceBranch, d.targetBranch].every(item => text(item, 256)) &&
      Number.isSafeInteger(d.prNumber) && d.prNumber > 0 && typeof d.head === 'string' && /^[a-f0-9]{40,64}$/.test(d.head)
  }
  if (!text(op.preparationId, 36) || !/^[a-f0-9-]{36}$/.test(op.preparationId)) return false
  if (op.action === 'CANCEL') return keys(op, ['action', 'preparationId'])
  if (op.action !== 'ENROLL' && (!text(op.operationId, 100) || !/^[A-Za-z0-9_-]+$/.test(op.operationId))) return false
  if (op.action === 'RECONCILE') return keys(op, ['action', 'preparationId', 'operationId'])
  if (!['EXECUTE', 'ENROLL'].includes(op.action) || !keys(op, op.action === 'ENROLL' ? ['action', 'preparationId', 'consent'] : ['action', 'preparationId', 'operationId', 'consent']) || !object(op.consent)) return false
  const c = op.consent
  return keys(c, ['fingerprint', 'exactPath', 'ownerReleased', 'operatorIsOwner', 'noKnownWriter', 'discardPaths']) && hash(c.fingerprint) && text(c.exactPath) &&
    [c.ownerReleased, c.operatorIsOwner, c.noKnownWriter].every(flag => typeof flag === 'boolean') && Array.isArray(c.discardPaths) && c.discardPaths.length <= 100000 && c.discardPaths.every((path: unknown) => text(path))
}
