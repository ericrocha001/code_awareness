import { expect, it } from 'vitest'
import { validRemovalRequest } from './worktree-removal-validation'

const context = { projectId: 'a', revision: 1 }
it.each([
  null, {}, { context, operation: { action: 'POLICY', enabled: 'yes' } },
  { context: { ...context, revision: -1 }, operation: { action: 'POLICY' } },
  { context, operation: { action: 'EXECUTE', preparationId: '../escape', operationId: 'remove', consent: {} } },
  { context, operation: { action: 'POLICY', enabled: true, force: true } }
])('rejects malformed or expanded mutation authority', request => expect(validRemovalRequest(request)).toBe(false))
it('accepts policy reads and explicit revocation without inventing credentials', () => {
  expect(validRemovalRequest({ context, operation: { action: 'POLICY' } })).toBe(true)
  expect(validRemovalRequest({ context, operation: { action: 'POLICY', enabled: false } })).toBe(true)
})
