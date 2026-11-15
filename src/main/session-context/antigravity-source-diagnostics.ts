import { lstatSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { assertProfilePath, assertUserOwned } from '../local-mcp-clients/safe-config-file'
import { boundedFile, nativeDigest } from './native-hooks'

export function antigravitySourceDiagnostic(storePath: string, repositoryId: string, nativeHash: string, sourceSessionId: string, assertCurrent: () => void) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(sourceSessionId) ||
    nativeDigest(JSON.stringify([repositoryId, 'antigravity', sourceSessionId])) !== nativeHash) return 'IDENTITY_MISMATCH'
  const directory = dirname(storePath), configPath = join(directory, 'session-context.provider.json')
  let configText: string
  let profile: string
  try {
    assertProfilePath(configPath, directory)
    assertUserOwned(configPath)
    configText = boundedFile(configPath, 65536)
    const config = JSON.parse(configText)
    profile = config?.nativeSources?.antigravityIde?.profile
    if (config?.repositoryId !== repositoryId || typeof profile !== 'string' || !isAbsolute(profile)) return 'PROFILE_UNAVAILABLE'
    assertProfilePath(profile, profile)
    if (!lstatSync(profile).isDirectory()) return 'PROFILE_UNAVAILABLE'
    assertUserOwned(profile)
  } catch { return 'PROFILE_UNAVAILABLE' }
  const path = join(profile, 'brain', sourceSessionId, '.system_generated', 'logs', 'transcript.jsonl')
  let first
  try {
    assertProfilePath(path, profile)
    first = lstatSync(path, { bigint: true })
    if (!first.isFile() || first.nlink !== 1n) return 'SOURCE_NOT_FOUND'
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'SOURCE_NOT_FOUND' : 'PROFILE_UNAVAILABLE'
  }
  assertCurrent()
  try {
    assertProfilePath(path, profile)
    assertProfilePath(configPath, directory)
    const current = lstatSync(path, { bigint: true })
    if (current.ino !== first.ino || current.dev !== first.dev || current.size !== first.size || current.mtimeNs !== first.mtimeNs ||
      current.ctimeNs !== first.ctimeNs || boundedFile(configPath, 65536) !== configText) return 'SOURCE_STALE'
  } catch { return 'SOURCE_STALE' }
  return 'FORMAT_UNSUPPORTED'
}
