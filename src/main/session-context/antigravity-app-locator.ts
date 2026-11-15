import { createHash } from 'node:crypto'
import { basename, dirname, isAbsolute, join, normalize } from 'node:path'

export const antigravityAppSessionId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/
const filename = 'transcript_full.jsonl'

export function antigravityAppTranscriptPath(profile: string, id: string): string {
  return join(profile, 'brain', id, '.system_generated', 'logs', filename)
}

export function antigravityAppLocatorDigest(id: string, locator: unknown): string | undefined {
  if (!antigravityAppSessionId.test(id) || typeof locator !== 'string' || locator.length > 4096 ||
    !isAbsolute(locator) || locator.split(/[\\/]/).some(part => part === '..' || part === '.')) return
  const path = normalize(locator)
  const canonical = process.platform === 'win32' ? path.toLowerCase() : path
  let profile = canonical
  for (let depth = 0; depth < 5; depth++) profile = dirname(profile)
  if (basename(profile) !== 'antigravity' || basename(dirname(profile)) !== '.gemini' ||
    canonical !== antigravityAppTranscriptPath(profile, id)) return
  return createHash('sha256').update(canonical).digest('hex')
}
