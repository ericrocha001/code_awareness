import { load, dump, JSON_SCHEMA } from 'js-yaml'
import type { ArtifactMetadata, ArtifactRelation, MetadataValue } from './continuum-types'

export function canonicalJson(value: MetadataValue): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}'
  return JSON.stringify(value)
}

export function normalizeMetadataValue(value: unknown, ancestors = new Set<object>(), depth = 0): MetadataValue {
  if (depth > 20) throw new Error('INVALID_ARGUMENT: metadata nesting exceeds 20 levels')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'object' || value === null || ancestors.has(value)) throw new Error('INVALID_ARGUMENT: metadata requires finite JSON values without cycles')
  ancestors.add(value)
  try {
    if (Array.isArray(value)) return value.map(item => normalizeMetadataValue(item, ancestors, depth + 1))
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('INVALID_ARGUMENT: metadata requires plain mappings')
    const result: Record<string, MetadataValue> = Object.create(null)
    for (const [key, item] of Object.entries(value)) {
      if (!key.trim() || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('INVALID_ARGUMENT: unsafe or empty metadata key')
      result[key] = normalizeMetadataValue(item, ancestors, depth + 1)
    }
    return result
  } finally { ancestors.delete(value) }
}

export function validateMetadata(value: unknown, legacy = false): ArtifactMetadata {
  const normalized = normalizeMetadataValue(value)
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) throw new Error('INVALID_ARGUMENT: frontmatter must be a mapping')
  for (const key of ['name', 'kind', ...(legacy ? [] : ['description'])]) {
    if (typeof normalized[key] !== 'string' || !normalized[key].trim()) throw new Error(`INVALID_ARGUMENT: ${key} must be a non-empty string`)
  }
  for (const key of ['description', 'status']) {
    if (normalized[key] !== undefined && (typeof normalized[key] !== 'string' || !(normalized[key] as string).trim())) throw new Error(`INVALID_ARGUMENT: ${key} must be a non-empty string`)
  }
  if (normalized.relations !== undefined) {
    if (!Array.isArray(normalized.relations)) throw new Error('INVALID_ARGUMENT: relations must be an array')
    const seen = new Set<string>()
    normalized.relations = normalized.relations.map(relation => {
      if (!relation || typeof relation !== 'object' || Array.isArray(relation) ||
        Object.keys(relation).some(key => !['artifactId', 'kind'].includes(key)) ||
        typeof relation.artifactId !== 'string' || !relation.artifactId.trim() ||
        typeof relation.kind !== 'string' || !relation.kind.trim()) throw new Error('INVALID_ARGUMENT: relation requires artifactId and kind')
      const key = JSON.stringify([relation.artifactId, relation.kind])
      if (seen.has(key)) throw new Error('INVALID_RELATION: duplicate relation')
      seen.add(key)
      return { artifactId: relation.artifactId, kind: relation.kind }
    })
  }
  return normalized as ArtifactMetadata
}

export function validateMarkdown(rawMarkdown: string): void {
  if (typeof rawMarkdown !== 'string' || !rawMarkdown.trim() || /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(rawMarkdown)) throw new Error('INVALID_ARGUMENT: Markdown must be non-empty text')
}

export function parseArtifactMarkdown(rawMarkdown: string, legacy = false): { metadata: ArtifactMetadata; body: string } {
  validateMarkdown(rawMarkdown)
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(rawMarkdown)
  if (!match) throw new Error('INVALID_ARGUMENT: YAML frontmatter is required')
  let metadata: unknown
  try { metadata = load(match[1], { schema: JSON_SCHEMA }) } catch (error) { throw new Error(`INVALID_ARGUMENT: invalid YAML: ${(error as Error).message}`) }
  const body = rawMarkdown.slice(match[0].length)
  if (!body.trim()) throw new Error('INVALID_ARGUMENT: Markdown body must not be empty')
  return { metadata: validateMetadata(metadata, legacy), body }
}
export function relationsOf(metadata: ArtifactMetadata): ArtifactRelation[] { return metadata.relations ?? [] }

export function visualMarkdown(name: string, description: string, context: string, relations: unknown = []): string {
  const rawMarkdown = `---\n${dump({ name, description, kind: 'VISUAL_REFERENCE', date: new Date().toISOString(), relations }, { lineWidth: -1 })}---\n${context}`
  parseArtifactMarkdown(rawMarkdown)
  return rawMarkdown
}
