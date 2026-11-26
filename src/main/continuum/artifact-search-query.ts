import type { ListArtifactsFilter } from './continuum-types'

export const SEARCH_MODES = ['ALL_TERMS', 'ANY_TERMS', 'PHRASE', 'NEAR', 'LITERAL'] as const
export const SEARCH_FIELDS = ['title', 'description', 'headings', 'body', 'tags'] as const
export type SearchMode = typeof SEARCH_MODES[number]
export type SearchField = typeof SEARCH_FIELDS[number]
type Filters = Pick<ListArtifactsFilter, 'kind' | 'status' | 'tag' | 'metadata' | 'updatedAfter' | 'updatedBefore'>

interface Expression {
  query: string
  mode?: SearchMode
  distance?: number
  caseSensitive?: boolean
}

export interface ArtifactSearchQuery extends Filters, Expression {
  alternatives?: Expression[]
  fields?: SearchField[]
  blockType?: string
  artifactId?: string
  limit?: number
  tokenBudget?: number
  cursor?: string
  explain?: boolean
  includeTokenUsage?: boolean
}

const expressionKeys = ['query', 'mode', 'distance', 'caseSensitive']
const keys = [...expressionKeys, 'alternatives', 'fields', 'blockType', 'artifactId', 'limit', 'tokenBudget', 'cursor',
  'explain', 'includeTokenUsage', 'kind', 'status', 'tag', 'metadata', 'updatedAfter', 'updatedBefore']

function invalid(key: string): never { throw new Error('INVALID_ARGUMENT: invalid search ' + key) }

function record(value: unknown, allowed?: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('object')
  const result = value as Record<string, unknown>
  if (allowed && Object.keys(result).some(key => !allowed.includes(key))) invalid('property')
  return result
}

function integer(value: unknown, min: number, max: number, key: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max)) invalid(key)
}

function validateExpression(value: Record<string, unknown>): void {
  if (typeof value.query !== 'string' || !value.query.trim() || value.query.length > 512 || value.query.includes('\0')) invalid('query')
  const mode = value.mode ?? 'ALL_TERMS'
  if (!SEARCH_MODES.includes(mode as SearchMode)) invalid('mode')
  if (mode === 'NEAR') {
    if (value.distance === undefined) invalid('distance')
    integer(value.distance, 1, 50, 'distance')
  } else if (value.distance !== undefined) invalid('distance')
  if (value.caseSensitive !== undefined && (mode !== 'LITERAL' || typeof value.caseSensitive !== 'boolean')) invalid('caseSensitive')
}

export function artifactSearchQuery(input: unknown): ArtifactSearchQuery {
  const value = record(input, keys)
  validateExpression(value)
  if (value.alternatives !== undefined) {
    if (!Array.isArray(value.alternatives) || value.alternatives.length > 3) invalid('alternatives')
    for (const alternative of value.alternatives) validateExpression(record(alternative, expressionKeys))
  }
  if (value.fields !== undefined && (!Array.isArray(value.fields) || !value.fields.length || value.fields.length > SEARCH_FIELDS.length ||
    value.fields.some(field => !SEARCH_FIELDS.includes(field)) || new Set(value.fields).size !== value.fields.length)) invalid('fields')
  for (const key of ['blockType', 'artifactId', 'cursor', 'kind', 'status', 'tag', 'updatedBefore', 'updatedAfter']) {
    const field = value[key]
    if (field !== undefined && (typeof field !== 'string' || !field.trim() || field.length > (key === 'cursor' ? 4096 : 512))) invalid(key)
  }
  if (value.blockType !== undefined && Array.isArray(value.fields) && !value.fields.includes('body')) invalid('blockType')
  if (value.metadata !== undefined) record(value.metadata)
  for (const key of ['explain', 'includeTokenUsage']) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') invalid(key)
  }
  integer(value.limit, 1, 20, 'limit')
  integer(value.tokenBudget, 1, 4000, 'tokenBudget')
  return value as unknown as ArtifactSearchQuery
}
