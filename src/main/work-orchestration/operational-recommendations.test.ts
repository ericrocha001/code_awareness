import { expect, it } from 'vitest'
import { recommendOperation, type RecommendationContext } from './operational-recommendations'
import type { StructuralAlert } from '../../shared/types/work-orchestration-attention-types'
const alert: StructuralAlert = { repositoryId: 'repo', id: 'alert', category: 'POTENTIAL_STRUCTURAL_INTERFERENCE', state: 'CURRENT', provider: 'a', consumer: 'b', providerGeneration: 'ga', consumerGeneration: 'gb', providerRevision: 'ra', consumerRevision: 'rb', base: 'base', verifiedAt: '2026-10-14T00:00:00Z', evidence: [{ symbol: 'Foo', contractPath: 'foo.ts', consumerPath: 'consumer.ts', contractLine: 1, consumerLine: 3, signature: 'new', previousSignature: 'old', binding: 'RESOLVED_DIRECT' }] }
const context: RecommendationContext = { repositoryId: 'repo', available: true, participants: new Map([['a', { generation: 'ga', revision: 'ra' }], ['b', { generation: 'gb', revision: 'rb' }]]) }
it('distinguishes a compatibility decision from revalidating old evidence, without an analysis dependency', () => {
  expect(recommendOperation(alert, context)).toMatchObject({ action: 'REVIEW_CONTRACT_COMPATIBILITY', reason: 'DIRECT_CONTRACT_CONSUMER', symbols: ['Foo'], repositoryId: 'repo', alertId: 'alert' })
  expect(recommendOperation({ ...alert, state: 'STALE' }, context)?.action).toBe('REVALIDATE_EVIDENCE')
  expect(recommendOperation(alert, { ...context, available: false })?.action).toBe('REVALIDATE_EVIDENCE')
})
it('fails closed for unsupported, incomplete, unobserved and mismatched evidence', () => {
  for (const input of [{ ...alert, evidence: [] }, { ...alert, category: 'FUTURE' as any }, { ...alert, evidence: [{ ...alert.evidence[0], binding: 'UNKNOWN' as any }] }, { ...alert, consumerGeneration: 'changed' }, { ...alert, providerRevision: 'changed' }]) expect(recommendOperation(input, context)?.action).toBe('REVALIDATE_EVIDENCE')
  expect(recommendOperation(alert, { ...context, participants: new Map() })?.action).toBe('REVALIDATE_EVIDENCE')
  expect(recommendOperation(alert, { ...context, repositoryId: null })).toBeUndefined()
  expect(recommendOperation(alert, { ...context, repositoryId: 'other' })).toBeUndefined()
  expect(recommendOperation({ ...alert, providerGeneration: '' }, context)).toBeUndefined()
})
it('combines multiple symbols into one bounded decision without duplicating evidence', () => {
  const recommendation = recommendOperation({ ...alert, evidence: ['Foo', 'Foo', 'Bar', 'Baz'].map(symbol => ({ ...alert.evidence[0], symbol })) }, context)
  expect(recommendation).toMatchObject({ symbols: ['Foo', 'Bar'], symbolCount: 3, action: 'REVIEW_CONTRACT_COMPATIBILITY' })
})
