import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { absent, physical } from './files'

export async function dependencyClosure(modules: string, roots: string[]) {
  const selected = new Set<string>(), pending = roots.map(name => ({ parent: '', name, optional: false }))
  while (pending.length) {
    const { parent, name, optional } = pending.pop()!
    if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) throw Error('BUILD_DEPENDENCY_INCOMPATIBLE')
    let candidate = parent ? parent + '/node_modules/' + name : name
    let pkg: { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string>; peerDependenciesMeta?: Record<string, { optional?: boolean }> } | undefined
    for (;;) {
      try { await physical(join(modules, candidate)); pkg = JSON.parse(await readFile(join(modules, candidate, 'package.json'), 'utf8')); break }
      catch (error) {
        if (!absent(error)) throw error
        const offset = candidate.lastIndexOf('/node_modules/')
        if (offset < 0) break
        const ancestor = candidate.slice(0, offset), higher = ancestor.lastIndexOf('/node_modules/')
        candidate = higher < 0 ? name : ancestor.slice(0, higher) + '/node_modules/' + name
      }
    }
    if (!pkg) { if (optional) continue; throw Error('BUILD_DEPENDENCY_MISSING') }
    if (selected.has(candidate)) continue
    selected.add(candidate)
    const names = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})])
    for (const dependency of names) pending.push({ parent: candidate, name: dependency, optional: dependency in (pkg.optionalDependencies ?? {}) || pkg.peerDependenciesMeta?.[dependency]?.optional === true })
  }
  return selected
}
export function packageInput(path: string, packages: Set<string>) {
  if (path === 'electron/dist' || path.startsWith('electron/dist/') || path.split('/').some(p => ['.bin', '.cache', '.env', '.npmrc', '.code-awareness-readiness.json'].includes(p)) || /\.(obj|pdb|ilk|lib|tlog|log)$/i.test(path)) return false
  return [...packages].some(pkg => pkg === path || pkg.startsWith(path + '/') || path.startsWith(pkg + '/') && !path.slice(pkg.length + 1).split('/').includes('node_modules'))
}
