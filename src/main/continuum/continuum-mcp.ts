import type { McpToolDefinition, McpToolResult } from '../mcp/context-navigation-mcp-adapter'
import type { IArtifactReader, IContinuumService, ListArtifactsFilter } from './continuum-types'
const string = { type: 'string', minLength: 1 }
function tool(name: string, description: string, properties: Record<string, unknown>, required: string[] = []): McpToolDefinition {
  return { name, description, securitySchemes: [{ type: 'oauth2', scopes: [] }], inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false } }
}
export const LIST_ARTIFACTS_TOOL = tool('list_artifacts', 'Discover only the active repository Continuum through intersecting metadata filters and a bounded cursor page. Returns small discovery records, never Markdown or expanded relations. Navigate one graph hop, select deliberately, then get_artifact.', {
  query: string, kind: string, status: string,
  metadata: { type: 'object', additionalProperties: true, description: 'Exact equality filters for extensible metadata, including canonical executionId when available.' },
  metadataKeys: { type: 'array', items: string, maxItems: 20, uniqueItems: true, description: 'Only these additional metadata keys are projected.' },
  relatedToArtifactId: string, direction: { type: 'string', enum: ['inbound', 'outbound', 'both'] }, relationKind: string,
  updatedAfter: { ...string, format: 'date-time' }, updatedBefore: { ...string, format: 'date-time' },
  limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 }, cursor: string
})
export const GET_ARTIFACT_TOOL = tool('get_artifact', 'Read one explicitly selected Artifact in the active repository, including current revision, metadata and exact Markdown. Relations are identity hints and never expand related content.', { artifactId: string }, ['artifactId'])
export const PUBLISH_ARTIFACT_TOOL = tool('publish_artifact', 'Publish durable Markdown with YAML frontmatter name, description and open kind to the active repository Continuum. Returns a compact receipt without content. Another repository requires switching the active context.', { rawMarkdown: string }, ['rawMarkdown'])
export const UPDATE_ARTIFACT_TOOL = tool('update_artifact', 'Replace an Artifact within the active repository atomically while preserving artifactId and history. Requires expectedRevision from get_artifact; revision conflict requires rereading. Replaces Markdown, metadata and relations together.', { artifactId: string, expectedRevision: { type: 'integer', minimum: 1 }, rawMarkdown: string }, ['artifactId', 'expectedRevision', 'rawMarkdown'])

function ok(value: unknown): McpToolResult { return { content: [{ type: 'text', text: JSON.stringify(value) }] } }
function failure(error: unknown): McpToolResult { return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true } }
function argsFor(definition: McpToolDefinition, args: unknown): Record<string, unknown> {
  const value = args ?? {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_ARGUMENT: arguments must be an object')
  const values = value as Record<string, unknown>
  const schema = definition.inputSchema as { properties: Record<string, { type: string; enum?: string[] }>; required?: string[] }
  for (const key of schema.required ?? []) if (!(key in values)) throw new Error('INVALID_ARGUMENT: ' + key + ' is required')
  for (const [key, item] of Object.entries(values)) {
    const property = schema.properties[key]
    if (!property) throw new Error('INVALID_ARGUMENT: unexpected ' + key)
    if (property.type === 'string' && (typeof item !== 'string' || !item.trim())) throw new Error('INVALID_ARGUMENT: ' + key + ' must be a non-empty string')
    if (property.enum && !property.enum.includes(item as string)) throw new Error('INVALID_ARGUMENT: invalid ' + key)
    if (property.type === 'integer' && (typeof item !== 'number' || !Number.isInteger(item) || item < 1 || (key === 'limit' && item > 100))) throw new Error('INVALID_ARGUMENT: invalid ' + key)
    if (property.type === 'object' && (!item || typeof item !== 'object' || Array.isArray(item))) throw new Error('INVALID_ARGUMENT: ' + key + ' must be an object')
    if (property.type === 'array' && (!Array.isArray(item) || item.length > 20 || new Set(item).size !== item.length || item.some(v => typeof v !== 'string' || !v.trim() || ['__proto__', 'constructor', 'prototype'].includes(v)))) throw new Error('INVALID_ARGUMENT: invalid ' + key)
  }
  return values
}
export function executeListArtifacts(reader: IArtifactReader, args: unknown): McpToolResult {
  try { const page = reader.list(argsFor(LIST_ARTIFACTS_TOOL, args) as ListArtifactsFilter); return ok({ count: page.artifacts.length, ...page }) } catch (error) { return failure(error) }
}
export function executeGetArtifact(reader: IArtifactReader, args: unknown): McpToolResult {
  try {
    const { artifactId } = argsFor(GET_ARTIFACT_TOOL, args); const artifact = reader.get(artifactId as string)
    if (!artifact) throw new Error('ARTIFACT_NOT_FOUND: ' + artifactId)
    const { contentHash, provenance, ...current } = artifact
    return ok(current)
  } catch (error) { return failure(error) }
}
export function executePublishArtifact(service: IContinuumService, args: unknown): McpToolResult {
  try { const { rawMarkdown } = argsFor(PUBLISH_ARTIFACT_TOOL, args); return ok(service.publish(rawMarkdown as string)) } catch (error) { return failure(error) }
}
export function executeUpdateArtifact(service: IContinuumService, args: unknown): McpToolResult {
  try {
    const values = argsFor(UPDATE_ARTIFACT_TOOL, args)
    return ok(service.update(values.artifactId as string, values.expectedRevision as number, values.rawMarkdown as string))
  } catch (error) { return failure(error) }
}
