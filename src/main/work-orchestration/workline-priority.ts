import type { ObservableWorktree } from '../../shared/types/work-orchestration-types'
import type { CoordinationReference, WorklineObservedState } from '../git-operations/git-coordination-evidence'

export type WorklinePriorityReason = 'OBSERVED_LOCAL_CHANGE' | 'STRUCTURAL_REVALIDATION' | 'FAIR_RECONCILIATION' | 'INITIAL_CREATION_ESTIMATE' | 'HISTORICAL_DIVERGENCE_TIE' | 'OLDEST_ATTEMPT'
export interface WorklineChoice { record: ObservableWorktree; reason: WorklinePriorityReason }

export function selectWorklineBatch(records: ObservableWorktree[], state: {
  reference: CoordinationReference; facts: ReadonlyMap<string, WorklineObservedState>; attempted: ReadonlyMap<string, number>;
  attemptedRound: ReadonlyMap<string, number>; observed: ReadonlyMap<string, number>; structural: ReadonlySet<string>;
  pending: ReadonlyMap<string, string>; round: number; now: number; inventoryAt: number; cadenceMs: number; budget: number
}): WorklineChoice[] {
  const fair = [...records].sort((a, b) => (state.attempted.get(a.worktreeId) ?? -1) - (state.attempted.get(b.worktreeId) ?? -1) || a.worktreeId.localeCompare(b.worktreeId))
  if (!fair.length) return []
  const known = (r: ObservableWorktree) => {
    const value = state.facts.get(r.worktreeId)
    return value?.generation === r.generation && value.repositoryId === state.reference.repositoryId ? value : undefined
  }
  const history = (r: ObservableWorktree) => {
    const fact = known(r), h = fact?.history
    return fact?.clean && fact.stable && !state.pending.has(r.worktreeId) && h?.head === fact.head && h.reference.head === state.reference.head &&
      h.reference.worktreeId === state.reference.worktreeId && h.reference.generation === state.reference.generation &&
      h.reference.repositoryId === state.reference.repositoryId ? h.relation : null
  }
  let selected = fair.find(r => known(r)?.changed), reason: WorklinePriorityReason = 'OBSERVED_LOCAL_CHANGE'
  if (!selected) { selected = fair.find(r => state.structural.has(r.worktreeId)); reason = 'STRUCTURAL_REVALIDATION' }
  if (!selected) {
    selected = fair.filter(r => !state.observed.has(r.worktreeId) && r.creation?.quality === 'ESTIMATED' && r.creation.at)
      .sort((a, b) => Date.parse(b.creation!.at!) - Date.parse(a.creation!.at!))[0]
    reason = 'INITIAL_CREATION_ESTIMATE'
  }
  if (!selected) {
    selected = fair[0]; reason = 'OLDEST_ATTEMPT'
    if (history(selected) === 'HEAD_INCLUDED') {
      const divergent = fair.find(r => state.attemptedRound.get(r.worktreeId) === state.attemptedRound.get(selected!.worktreeId) && history(r) === 'EXCLUSIVE_COMMITS')
      if (divergent) { selected = divergent; reason = 'HISTORICAL_DIVERGENCE_TIE' }
    }
  }
  const oldest = fair[0], due = state.now - (state.attempted.get(oldest.worktreeId) ?? state.inventoryAt) >= state.cadenceMs * Math.max(4, records.length)
  if (due && state.round % 2 === 0) { selected = oldest; reason = 'FAIR_RECONCILIATION' }
  return [{ record: selected, reason }, ...fair.filter(r => r.worktreeId !== selected!.worktreeId).map(record => ({ record, reason: 'OLDEST_ATTEMPT' as const }))].slice(0, state.budget)
}
