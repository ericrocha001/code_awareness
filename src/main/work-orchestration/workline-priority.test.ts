import { expect, it } from 'vitest'
import { selectWorklineBatch } from './workline-priority'
import type { ObservableWorktree } from '../../shared/types/work-orchestration-types'
import type { CoordinationReference, WorklineObservedState } from '../git-operations/git-coordination-evidence'

const reference: CoordinationReference = { repositoryId: 'repo', worktreeId: 'ref', generation: 'rg', head: 'f'.repeat(40) }
const record = (id: string): ObservableWorktree => ({ worktreeId: id, generation: 'g', path: '/r/' + id, branch: id, head: 'a'.repeat(40), detached: false, locked: false, missing: false, prunable: false, reference: false, snapshot: null, observation: 'NOT_OBSERVED', reason: null, stagedCount: null, unstagedCount: null, untrackedCount: null, conflictCount: null })
const fact = (relation: 'HEAD_INCLUDED' | 'EXCLUSIVE_COMMITS'): WorklineObservedState => ({ repositoryId: 'repo', generation: 'g', head: 'a'.repeat(40), localRevision: 'local', clean: true, stable: true, changed: false,
  history: { repositoryId: 'repo', referenceHead: reference.head, head: 'a'.repeat(40), base: 'a'.repeat(40), relation, provenance: 'EXACT_MERGE_BASE', reference, observedAt: 'now' } })
function fixture() {
  const records = ['a', 'b', 'c', 'd'].map(record)
  const state = { reference, facts: new Map([['a', fact('HEAD_INCLUDED')], ['b', fact('EXCLUSIVE_COMMITS')]]), attempted: new Map(records.map((r, n) => [r.worktreeId, 1001 + n])),
    attemptedRound: new Map(records.map(r => [r.worktreeId, 1])), observed: new Map(records.map(r => [r.worktreeId, 1000])), structural: new Set<string>(), pending: new Map<string, string>(), round: 2, now: 2000, inventoryAt: 1000, cadenceMs: 30000, budget: 2 }
  return { records, state }
}
it('changes only a qualified historical tie and preserves the oldest fair slot', () => {
  const { records, state } = fixture()
  const result = selectWorklineBatch(records, state)
  expect(result.map(r => [r.record.worktreeId, r.reason])).toEqual([['b', 'HISTORICAL_DIVERGENCE_TIE'], ['a', 'OLDEST_ATTEMPT']])
  state.attemptedRound.set('b', 2); state.attempted.set('b', 2100)
  expect(selectWorklineBatch(records, state)[0].record.worktreeId).toBe('a')
})
it('prioritizes observed local change and recognized structural candidates, never unseen changes', () => {
  const { records, state } = fixture()
  expect(selectWorklineBatch(records, state)[0].record.worktreeId).toBe('b')
  state.structural.add('d')
  expect(selectWorklineBatch(records, state)[0]).toMatchObject({ record: { worktreeId: 'd' }, reason: 'STRUCTURAL_REVALIDATION' })
  state.facts.set('c', { ...fact('HEAD_INCLUDED'), changed: true, clean: false, stable: false })
  expect(selectWorklineBatch(records, state)[0]).toMatchObject({ record: { worktreeId: 'c' }, reason: 'OBSERVED_LOCAL_CHANGE' })
  state.facts.get('c')!.changed = false
  expect(selectWorklineBatch(records, state)[0].record.worktreeId).toBe('d')
})
it('falls back for initial, dirty, generation/repository/reference drift and unknown history', () => {
  for (const corrupt of [(f: WorklineObservedState) => { f.stable = false }, (f: WorklineObservedState) => { f.clean = false }, (f: WorklineObservedState) => { f.generation = 'recreated' },
    (f: WorklineObservedState) => { f.repositoryId = 'other' }, (f: WorklineObservedState) => { f.history = null },
    (f: WorklineObservedState) => { f.history = { ...f.history!, reference: { ...reference, head: '0'.repeat(40) } } },
    (f: WorklineObservedState) => { f.history = { ...f.history!, reference: { ...reference, generation: 'new-generation' } } }]) {
    const { records, state } = fixture(); corrupt(state.facts.get('a')!)
    expect(selectWorklineBatch(records, state)[0].record.worktreeId).toBe('a')
  }
})
it('prevents pending pairs and many divergent branches from monopolizing slow cycles', () => {
  for (const count of [21, 101]) {
    const records = Array.from({ length: count }, (_, i) => record(String(i).padStart(3, '0')))
    const { state } = fixture(); state.facts.clear(); state.attempted.clear(); state.attemptedRound.clear(); state.observed.clear(); state.inventoryAt = 1000
    state.structural.add('000'); state.pending.set('000', 'PAIR_BUDGET')
    for (let round = 1; round <= count * 4; round++) {
      state.round = round; state.now = 1000 + round * state.cadenceMs
      const selected = selectWorklineBatch(records, state)[0].record.worktreeId
      state.attempted.set(selected, state.now); state.attemptedRound.set(selected, round); state.observed.set(selected, state.now)
      state.facts.set(selected, fact('EXCLUSIVE_COMMITS'))
    }
    expect(state.observed.size).toBe(count)
  }
})
