export function decideAcademyReconciliation(baseline: string | null, remote: string, canonical: string, remoteExists: boolean): 'CONVERGED' | 'PUBLISH' | 'CONFLICT' {
  if (remote === canonical) return 'CONVERGED'
  if (remote === baseline || (!remoteExists && baseline === null)) return 'PUBLISH'
  return 'CONFLICT'
}

export function managedConflictPaths(remote: string, canonical: string): string[] {
  const entries = (tree: string) => new Map(tree.split('\0').filter(Boolean).map(entry => {
    const separator = entry.indexOf('\t')
    return [entry.slice(separator + 1), entry.slice(0, separator)]
  }))
  const left = entries(remote), right = entries(canonical)
  return [...new Set([...left.keys(), ...right.keys()])].filter(path => left.get(path) !== right.get(path)).sort()
}
