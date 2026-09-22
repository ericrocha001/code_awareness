import { createHash } from 'node:crypto'

export function deriveRepositoryKey(repoRoot: string): string {
  const normalized = repoRoot.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return createHash('sha256').update(normalized).digest('hex').substring(0, 32)
}
