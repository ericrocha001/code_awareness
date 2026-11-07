import type { AcademyPackage } from '../../../shared/types/academy-types'
import { normalizeAcademyPackage } from '../academy-package'

export function mergeAcademyPackages(base: AcademyPackage, local: AcademyPackage, remote: AcademyPackage): AcademyPackage | null {
  const files = (pkg: AcademyPackage): Record<string, string> => ({ ...pkg.artifacts, 'SKILL.md': pkg.skillMd })
  const before = files(base), left = files(local), right = files(remote), merged: Record<string, string> = {}
  for (const path of new Set([...Object.keys(before), ...Object.keys(left), ...Object.keys(right)])) {
    if (left[path] !== right[path] && left[path] !== before[path] && right[path] !== before[path]) return null
    const value = left[path] === before[path] ? right[path] : left[path]
    if (value !== undefined) merged[path] = value
  }
  const { 'SKILL.md': skillMd, ...artifacts } = merged
  try { return normalizeAcademyPackage({ skillMd, artifacts }) } catch { return null }
}

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
