import type { McpToolDefinition, McpToolResult } from '../mcp/context-navigation-mcp-adapter'
import type { IArtifactReader, ArtifactType, ProducerRole } from './continuum-types'
import { SUPPORTED_ARTIFACT_TYPES, SUPPORTED_PRODUCER_ROLES } from './continuum-types'
import { contextualizeTimestamps } from './continuum-time'

function oauthProtected(
  definition: Omit<McpToolDefinition, 'securitySchemes'>
): McpToolDefinition {
  return { ...definition, securitySchemes: [{ type: 'oauth2', scopes: [] }] }
}

export const LIST_ARTIFACTS_TOOL: McpToolDefinition = oauthProtected({
  name: 'list_artifacts',
  description:
    'List implementation handoffs and artifacts available in the active project. Returns high-density summaries (without raw markdown) ordered newest first. Use when you need to recover recent implementation handoffs, understand prior agent work, or gain historical context without asking the user. Follow up with get_artifact to inspect a specific artifact.',
  inputSchema: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: ['IMPLEMENTATION_HANDOFF'],
        description: 'Filter by artifact type.'
      },
      producerRole: {
        type: 'string',
        enum: ['IMPLEMENTER'],
        description: 'Filter by producer role.'
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        description: 'Maximum number of artifacts to return (1-100). Defaults to 20.'
      }
    },
    additionalProperties: false
  }
})

export const GET_ARTIFACT_TOOL: McpToolDefinition = oauthProtected({
  name: 'get_artifact',
  description:
    'Retrieve the complete content and metadata of a specific artifact by its artifactId, including full raw markdown, git head, and timestamps. Use after identifying a relevant artifact via list_artifacts to deliberately inspect its implementation report or context.',
  inputSchema: {
    type: 'object',
    properties: {
      artifactId: {
        type: 'string',
        minLength: 1,
        description: 'The unique ID of the artifact to retrieve.'
      }
    },
    required: ['artifactId'],
    additionalProperties: false
  }
})

function ok(value: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
}

function err(text: string): McpToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

function parseArgs(args: unknown): Record<string, unknown> | null {
  if (args === undefined || args === null) return {}
  if (typeof args !== 'object' || Array.isArray(args)) return null
  return args as Record<string, unknown>
}

export function executeListArtifacts(
  reader: IArtifactReader,
  args: unknown
): McpToolResult {
  const values = parseArgs(args)
  if (!values) return err('INVALID_ARGUMENT: Expected an arguments object')

  const allowedKeys = new Set(['type', 'producerRole', 'limit'])
  for (const key of Object.keys(values)) {
    if (!allowedKeys.has(key)) {
      return err(`INVALID_ARGUMENT: Unexpected argument "${key}"`)
    }
  }

  let type: ArtifactType | undefined
  if (values.type !== undefined) {
    if (typeof values.type !== 'string' || !SUPPORTED_ARTIFACT_TYPES.has(values.type)) {
      return err(`INVALID_ARGUMENT: Unsupported artifact type "${values.type}"`)
    }
    type = values.type as ArtifactType
  }

  let producerRole: ProducerRole | undefined
  if (values.producerRole !== undefined) {
    if (typeof values.producerRole !== 'string' || !SUPPORTED_PRODUCER_ROLES.has(values.producerRole as ProducerRole)) {
      return err(`INVALID_ARGUMENT: Unsupported producer role "${values.producerRole}"`)
    }
    producerRole = values.producerRole as ProducerRole
  }

  let limit = 20
  if (values.limit !== undefined) {
    const rawLimit = Number(values.limit)
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100) {
      return err('INVALID_ARGUMENT: limit must be an integer between 1 and 100')
    }
    limit = rawLimit
  }

  try {
    const summaries = reader.list({ type, producerRole, limit })
    const compact = summaries.map((s) => {
      const local = contextualizeTimestamps(s.createdAt, s.ingestedAt)
      return {
        artifactId: s.artifactId,
        type: s.type,
        title: s.title,
        producerRole: s.producerRole,
        createdAt: s.createdAt,
        ingestedAt: s.ingestedAt,
        createdAtLocal: local.createdAtLocal,
        ingestedAtLocal: local.ingestedAtLocal,
        timeZone: local.timeZone,
        ...(s.gitHead ? { gitHead: s.gitHead } : {})
      }
    })

    return ok({
      count: compact.length,
      artifacts: compact
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return err(`CONTINUUM_ERROR: ${message}`)
  }
}

export function executeGetArtifact(
  reader: IArtifactReader,
  args: unknown
): McpToolResult {
  const values = parseArgs(args)
  if (!values) return err('INVALID_ARGUMENT: Expected an arguments object')

  if (typeof values.artifactId !== 'string' || values.artifactId.trim().length === 0) {
    return err('INVALID_ARGUMENT: artifactId must be a non-empty string')
  }

  const artifactId = values.artifactId.trim()

  try {
    const artifact = reader.get(artifactId)
    if (!artifact) {
      return err(`ARTIFACT_NOT_FOUND: No artifact found with id "${artifactId}"`)
    }

    const local = contextualizeTimestamps(artifact.createdAt, artifact.ingestedAt)
    return ok({
      artifactId: artifact.artifactId,
      type: artifact.type,
      schemaVersion: artifact.schemaVersion,
      title: artifact.title,
      producerRole: artifact.producerRole,
      createdAt: artifact.createdAt,
      ingestedAt: artifact.ingestedAt,
      createdAtLocal: local.createdAtLocal,
      ingestedAtLocal: local.ingestedAtLocal,
      timeZone: local.timeZone,
      sourceFingerprint: artifact.sourceFingerprint,
      gitHead: artifact.gitHead,
      contentHash: artifact.contentHash,
      rawMarkdown: artifact.rawMarkdown
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return err(`CONTINUUM_ERROR: ${message}`)
  }
}
