import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, join, parse, resolve } from 'node:path'
import type { RemovalContent } from '../../shared/types/worktree-removal-types'

export function assertRemovalPath(path: string): void {
  let cursor = resolve(path)
  while (cursor !== parse(cursor).root) {
    if (lstatSync(cursor).isSymbolicLink()) throw new Error('REMOVAL_LINK_NOT_ALLOWED')
    cursor = dirname(cursor)
  }
  if (resolve(realpathSync(path)).toLowerCase() !== resolve(path).toLowerCase()) throw new Error('REMOVAL_PATH_CHANGED')
}

export function inventoryRemovalContent(root: string, tracked: string[], ignored: string[]) {
  assertRemovalPath(root)
  const trackedSet = new Set(tracked), ignoredSet = new Set(ignored)
  const content: RemovalContent[] = []
  let total = 0
  const walk = (directory: string, prefix: string) => {
    for (const name of readdirSync(directory).sort()) {
      const path = prefix ? `${prefix}/${name}` : name
      if (!prefix && name === '.git') {
        if (lstatSync(join(directory, name)).isSymbolicLink()) throw new Error('REMOVAL_LINK_NOT_ALLOWED')
        continue
      }
      if (name.toLowerCase() === '.git') throw new Error('REMOVAL_NESTED_REPOSITORY')
      const full = join(directory, name), stat = lstatSync(full)
      if (stat.isSymbolicLink()) throw new Error('REMOVAL_LINK_NOT_ALLOWED')
      if (stat.isDirectory()) { walk(full, path); continue }
      if (!stat.isFile()) throw new Error('REMOVAL_CONTENT_UNSUPPORTED')
      total += stat.size
      if (content.length >= 100000 || total > 512 * 1024 * 1024 || stat.size > 32 * 1024 * 1024) throw new Error('REMOVAL_INVENTORY_LIMIT')
      const bytes = readFileSync(full)
      content.push({ path, kind: trackedSet.has(path) ? 'TRACKED' : ignoredSet.has(path) ? 'IGNORED' : 'UNTRACKED',
        sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length })
    }
  }
  walk(root, '')
  return content
}
