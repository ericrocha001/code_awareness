import { lstatSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { assertProfilePath } from '../local-mcp-clients/safe-config-file'
import { antigravityAppSessionId } from './antigravity-app-locator'
import {
  readAntigravityAppGrantStatus,
  resolveAntigravityTranscriptCandidate,
  type SourceReadinessReason
} from './native-antigravity-app-source'
import { boundedFile, nativeDigest } from './native-hooks'

export interface SourceDiagnosticResult {
  sourceDiagnostic: string
  readinessReason: SourceReadinessReason
  next?: { action: string; provider: 'antigravityApp' | 'codex'; requires: string[] }
}

export function diagnoseAntigravitySource(
  storePath: string,
  repositoryId: string,
  nativeHash: string,
  sourceSessionId: string,
  assertCurrent: () => void,
  locatorDigest?: string
): SourceDiagnosticResult {
  if (!antigravityAppSessionId.test(sourceSessionId) ||
    nativeDigest(JSON.stringify([repositoryId, 'antigravity', sourceSessionId])) !== nativeHash) {
    return { sourceDiagnostic: 'IDENTITY_MISMATCH', readinessReason: 'IDENTITY_MISMATCH' }
  }
  const grantStatus = readAntigravityAppGrantStatus(storePath, repositoryId, nativeHash)
  if (!grantStatus.configured) {
    return {
      sourceDiagnostic: 'PROFILE_UNAVAILABLE',
      readinessReason: 'GRANT_MISSING',
      next: { action: 'AUTHORIZE_LOCAL_SOURCE_GRANT', provider: 'antigravityApp', requires: ['repositoryId', 'profile', 'sessionHashes'] }
    }
  }
  if (!grantStatus.ok) {
    return {
      sourceDiagnostic: 'PROFILE_UNAVAILABLE',
      readinessReason: 'GRANT_INVALID_OR_REVOKED',
      next: { action: 'AUTHORIZE_LOCAL_SOURCE_GRANT', provider: 'antigravityApp', requires: ['repositoryId', 'profile', 'sessionHashes'] }
    }
  }
  const { configPath, configText, profile } = grantStatus.grant
  const directory = dirname(storePath)
  let candidate: ReturnType<typeof resolveAntigravityTranscriptCandidate>
  try {
    candidate = resolveAntigravityTranscriptCandidate(profile, sourceSessionId, locatorDigest)
  } catch (error) {
    const code = error instanceof Error ? error.message : 'SOURCE_NOT_FOUND'
    if (code === 'IDENTITY_MISMATCH') return { sourceDiagnostic: 'IDENTITY_MISMATCH', readinessReason: 'IDENTITY_MISMATCH' }
    if (code === 'SOURCE_NOT_FOUND') return { sourceDiagnostic: 'SOURCE_NOT_FOUND', readinessReason: 'SOURCE_NOT_FOUND' }
    return { sourceDiagnostic: 'PROFILE_UNAVAILABLE', readinessReason: 'GRANT_INVALID_OR_REVOKED' }
  }

  assertCurrent()
  try {
    assertProfilePath(candidate.path, profile)
    assertProfilePath(configPath, directory)
    const current = lstatSync(candidate.path, { bigint: true })
    if (current.ino !== candidate.stat.ino || current.dev !== candidate.stat.dev || current.size !== candidate.stat.size ||
      current.mtimeNs !== candidate.stat.mtimeNs || current.ctimeNs !== candidate.stat.ctimeNs ||
      boundedFile(configPath, 65536) !== configText) {
      return { sourceDiagnostic: 'SOURCE_STALE', readinessReason: 'SOURCE_STALE' }
    }
  } catch {
    return { sourceDiagnostic: 'SOURCE_STALE', readinessReason: 'SOURCE_STALE' }
  }
  if (candidate.stat.size === 0n) {
    return { sourceDiagnostic: 'FORMAT_UNSUPPORTED', readinessReason: 'SOURCE_FORMAT_UNSUPPORTED' }
  }
  return { sourceDiagnostic: 'FORMAT_UNSUPPORTED', readinessReason: 'SOURCE_FORMAT_UNSUPPORTED' }
}

export function antigravitySourceDiagnostic(
  storePath: string,
  repositoryId: string,
  nativeHash: string,
  sourceSessionId: string,
  assertCurrent: () => void,
  locatorDigest?: string
): string {
  return diagnoseAntigravitySource(storePath, repositoryId, nativeHash, sourceSessionId, assertCurrent, locatorDigest).sourceDiagnostic
}
