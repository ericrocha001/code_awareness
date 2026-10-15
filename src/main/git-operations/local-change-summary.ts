import type { LocalChange, LocalChangeSummary } from '../../shared/types/local-change-types'

export function summarizeLocalChanges(changes: LocalChange[]): LocalChangeSummary {
  const categories: LocalChangeSummary['categories'] = { added: 0, modified: 0, deleted: 0, renamed: 0, untracked: 0, conflicted: 0 }
  const unique = new Map(changes.map(change => [change.path, change]))
  for (const change of unique.values()) {
    if (change.conflicted) { categories.conflicted++; continue }
    if (change.untracked) { categories.untracked++; continue }
    const states = `${change.stagedState ?? ''}${change.unstagedState ?? ''}`
    if (/[AC]/.test(states)) categories.added++
    if (/[MT]/.test(states)) categories.modified++
    if (change.deleted) categories.deleted++
    if (/R/.test(states)) categories.renamed++
  }
  return { total: unique.size, categories }
}
