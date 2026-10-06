import { createHash } from 'node:crypto'

export const ENVELOPE_PROTOCOL = 'continuum-artifact/v1'
export const GENERIC_ENVELOPE_PROTOCOL = 'continuum-artifact/v2'

export const NON_TEXTUAL_CONTROL_CHAR_REGEX = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/

export function containsNonTextualControlChars(content: string): boolean {
  return NON_TEXTUAL_CONTROL_CHAR_REGEX.test(content)
}

export function computeContentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

export interface ArtifactEnvelope {
  protocol: typeof ENVELOPE_PROTOCOL
  artifactId: string
  type: 'IMPLEMENTATION_HANDOFF'
  schemaVersion: number
  title: string
  producerRole: 'IMPLEMENTER'
  repositoryKey: string
  createdAt: string
  sourceFingerprint: string | null
  gitHead: string | null
  contentHash: string
  rawMarkdown: string
}

export interface EnvelopeValidationError {
  field: string
  reason: string
}
export interface GenericArtifactEnvelope {
  protocol: typeof GENERIC_ENVELOPE_PROTOCOL
  artifactId: string
  repositoryKey: string
  createdAt: string
  contentHash: string
  rawMarkdown: string
}
export type TransportEnvelope = ArtifactEnvelope | GenericArtifactEnvelope

export function validateEnvelope(value: unknown): EnvelopeValidationError[] {
  const errors: EnvelopeValidationError[] = []
  if (typeof value !== 'object' || value === null) {
    return [{ field: 'root', reason: 'must be an object' }]
  }
  const e = value as Record<string, unknown>

  if (e.protocol !== ENVELOPE_PROTOCOL && e.protocol !== GENERIC_ENVELOPE_PROTOCOL) {
    errors.push({ field: 'protocol', reason: `must be "${ENVELOPE_PROTOCOL}"` })
  }
  if (typeof e.artifactId !== 'string' || e.artifactId.trim().length === 0) {
    errors.push({ field: 'artifactId', reason: 'must be a non-empty string' })
  }
  if (e.protocol !== GENERIC_ENVELOPE_PROTOCOL && e.type !== 'IMPLEMENTATION_HANDOFF') {
    errors.push({ field: 'type', reason: 'must be "IMPLEMENTATION_HANDOFF"' })
  }
  if (e.protocol !== GENERIC_ENVELOPE_PROTOCOL && (!Number.isInteger(e.schemaVersion) || (e.schemaVersion as number) < 1)) {
    errors.push({ field: 'schemaVersion', reason: 'must be integer >= 1' })
  }
  if (e.protocol !== GENERIC_ENVELOPE_PROTOCOL && (typeof e.title !== 'string' || e.title.trim().length === 0)) {
    errors.push({ field: 'title', reason: 'must be a non-empty string' })
  }
  if (e.protocol !== GENERIC_ENVELOPE_PROTOCOL && e.producerRole !== 'IMPLEMENTER') {
    errors.push({ field: 'producerRole', reason: 'must be "IMPLEMENTER"' })
  }
  if (typeof e.repositoryKey !== 'string' || e.repositoryKey.trim().length === 0) {
    errors.push({ field: 'repositoryKey', reason: 'must be a non-empty string' })
  }
  if (typeof e.createdAt !== 'string' || e.createdAt.trim().length === 0) {
    errors.push({ field: 'createdAt', reason: 'must be a non-empty string' })
  }
  if (e.protocol !== GENERIC_ENVELOPE_PROTOCOL && e.sourceFingerprint !== null && typeof e.sourceFingerprint !== 'string') {
    errors.push({ field: 'sourceFingerprint', reason: 'must be string or null' })
  }
  if (e.protocol !== GENERIC_ENVELOPE_PROTOCOL && e.gitHead !== null && typeof e.gitHead !== 'string') {
    errors.push({ field: 'gitHead', reason: 'must be string or null' })
  }
  if (typeof e.rawMarkdown !== 'string' || e.rawMarkdown.length === 0) {
    errors.push({ field: 'rawMarkdown', reason: 'must be a non-empty string' })
  } else if (containsNonTextualControlChars(e.rawMarkdown)) {
    errors.push({ field: 'rawMarkdown', reason: 'contains non-textual control characters' })
  }

  // Content hash integrity validation
  if (typeof e.contentHash !== 'string' || !/^[0-9a-f]{64}$/i.test(e.contentHash)) {
    errors.push({ field: 'contentHash', reason: 'must be a 64-character hex string' })
  } else if (typeof e.rawMarkdown === 'string' && e.rawMarkdown.length > 0) {
    const expectedHash = computeContentHash(e.rawMarkdown)
    if (e.contentHash.toLowerCase() !== expectedHash) {
      errors.push({
        field: 'contentHash',
        reason: 'contentHash does not match computed SHA-256 of rawMarkdown'
      })
    }
  }

  return errors
}

export function serializeEnvelope(envelope: TransportEnvelope): string {
  return JSON.stringify(envelope, null, 2)
}

export function deserializeEnvelope(raw: string): TransportEnvelope {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('ENVELOPE_PARSE_ERROR: invalid JSON')
  }
  const errors = validateEnvelope(parsed)
  if (errors.length > 0) {
    const details = errors.map((e) => `${e.field}: ${e.reason}`).join(', ')
    throw new Error(`ENVELOPE_INVALID: ${details}`)
  }
  return parsed as TransportEnvelope
}
