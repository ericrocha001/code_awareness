import type { McpTextContent, McpToolDefinition, McpToolResult } from '../mcp/mcp-types'
import type { SessionMemoryCentralService } from './session-memory-central-service'
import type { SmcEntryKind } from '../../shared/types/session-memory-central-types'

export const MAX_BUILDX_ENTRY_BYTES = 1024 * 1024 // 1 MiB

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = []
): McpToolDefinition {
  return {
    name,
    description,
    securitySchemes: [{ type: 'oauth2', scopes: [] }],
    annotations: {
      readOnlyHint: true
    },
    inputSchema: {
      type: 'object',
      properties,
      ...(required.length ? { required } : {}),
      additionalProperties: false
    }
  }
}

export const LIST_BUILDX_SESSIONS_TOOL = tool(
  'list_buildx_sessions',
  'Discover compact engineering sessions in the active authorized repository. Returns only metadata (sessionId, status, revision, createdAt, updatedAt). Does not return entries, bodies, transcripts or code. Navigate session identity before exploring cumulative memory.',
  {
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      default: 50,
      description: 'Maximum number of sessions to return (bounded 1-100).'
    }
  }
)

export const LIST_BUILDX_SESSION_ENTRIES_TOOL = tool(
  'list_buildx_session_entries',
  'List compact cumulative engineering memory headers for a specific engineering session in the active authorized repository. Projects only metadata headers, kind, provenance and references. Never returns entry body. Use get_buildx_session_entry to selectively read the literal body of a chosen entry.',
  {
    sessionId: {
      type: 'string',
      minLength: 1,
      description: 'The stable UUID of the engineering session.'
    },
    kind: {
      type: 'string',
      enum: ['DECISION', 'EVIDENCE', 'RESULT', 'PENDING', 'INTERVENTION'],
      description: 'Optional entry kind filter.'
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      default: 50,
      description: 'Maximum number of entries to return (bounded 1-100).'
    },
    cursor: {
      type: 'string',
      description: 'Stable pagination cursor returned by a previous list call.'
    }
  },
  ['sessionId']
)

export const GET_BUILDX_SESSION_ENTRY_TOOL = tool(
  'get_buildx_session_entry',
  'Read the exact literal body and metadata of one cumulative engineering record in the active authorized repository by sessionId and entryId. Does not return neighboring entries or expand external references. Fails closed if the record exceeds Channel limits.',
  {
    sessionId: {
      type: 'string',
      minLength: 1,
      description: 'The stable UUID of the engineering session.'
    },
    entryId: {
      type: 'string',
      minLength: 1,
      description: 'The stable UUID of the entry to read.'
    }
  },
  ['sessionId', 'entryId']
)

export const BUILDX_SMC_TOOLS: readonly McpToolDefinition[] = Object.freeze([
  LIST_BUILDX_SESSIONS_TOOL,
  LIST_BUILDX_SESSION_ENTRIES_TOOL,
  GET_BUILDX_SESSION_ENTRY_TOOL
])

export interface ExecuteBuildxSmcOptions {
  assertActiveProject?: () => void
  maxResponseBytes?: number
}

function ok(payload: unknown): McpToolResult<McpTextContent> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }]
  }
}

function failure(code: string, message: string): McpToolResult<McpTextContent> {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ code, message }) }]
  }
}

export function executeBuildxSmcTool(
  service: SessionMemoryCentralService,
  repositoryId: string,
  name: string,
  args: unknown,
  options?: ExecuteBuildxSmcOptions
): McpToolResult<McpTextContent> {
  try {
    options?.assertActiveProject?.()
  } catch {
    return failure('PROJECT_CONTEXT_CHANGED', 'Active repository project context changed or was invalidated')
  }

  if (!repositoryId || typeof repositoryId !== 'string' || !repositoryId.trim()) {
    return failure('REPOSITORY_CONTEXT_REQUIRED', 'A valid active repositoryId is required and cannot be omitted')
  }

  const validRepoId = repositoryId.trim()
  const rawArgs = args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {}

  try {
    switch (name) {
      case 'list_buildx_sessions': {
        const rawLimit = rawArgs.limit
        let limit: number | undefined
        if (rawLimit !== undefined) {
          if (typeof rawLimit !== 'number' || !Number.isInteger(rawLimit) || rawLimit < 1) {
            return failure('INVALID_ARGUMENT', 'limit must be a positive integer')
          }
          limit = Math.min(rawLimit, 100)
        }
        const sessions = service.listSessions(validRepoId, { limit })
        return ok({ sessions })
      }

      case 'list_buildx_session_entries': {
        const sessionId = rawArgs.sessionId
        if (typeof sessionId !== 'string' || !UUID_REGEX.test(sessionId.trim())) {
          return failure('INVALID_ARGUMENT', 'sessionId must be a valid UUID')
        }
        const cleanSessionId = sessionId.trim().toLowerCase()

        const session = service.getSession(validRepoId, cleanSessionId)
        if (!session) {
          return failure('SESSION_NOT_FOUND', 'Session was not found in the active repository')
        }

        const rawKind = rawArgs.kind
        let kind: SmcEntryKind | undefined
        if (rawKind !== undefined) {
          if (typeof rawKind !== 'string' || !['DECISION', 'EVIDENCE', 'RESULT', 'PENDING', 'INTERVENTION'].includes(rawKind)) {
            return failure('INVALID_ARGUMENT', `Invalid kind filter: "${String(rawKind)}"`)
          }
          kind = rawKind as SmcEntryKind
        }

        const rawLimit = rawArgs.limit
        let limit: number | undefined
        if (rawLimit !== undefined) {
          if (typeof rawLimit !== 'number' || !Number.isInteger(rawLimit) || rawLimit < 1) {
            return failure('INVALID_ARGUMENT', 'limit must be a positive integer')
          }
          limit = Math.min(rawLimit, 100)
        }

        const cursor = typeof rawArgs.cursor === 'string' && rawArgs.cursor.trim() ? rawArgs.cursor.trim() : undefined

        const result = service.listEntries(validRepoId, cleanSessionId, { kind, limit, cursor })
        return ok(result)
      }

      case 'get_buildx_session_entry': {
        const sessionId = rawArgs.sessionId
        if (typeof sessionId !== 'string' || !UUID_REGEX.test(sessionId.trim())) {
          return failure('INVALID_ARGUMENT', 'sessionId must be a valid UUID')
        }
        const cleanSessionId = sessionId.trim().toLowerCase()

        const entryId = rawArgs.entryId
        if (typeof entryId !== 'string' || !UUID_REGEX.test(entryId.trim())) {
          return failure('INVALID_ARGUMENT', 'entryId must be a valid UUID')
        }
        const cleanEntryId = entryId.trim().toLowerCase()

        const session = service.getSession(validRepoId, cleanSessionId)
        if (!session) {
          return failure('SESSION_NOT_FOUND', 'Session was not found in the active repository')
        }

        const record = service.getEntry(validRepoId, cleanSessionId, cleanEntryId)
        if (!record) {
          return failure('ENTRY_NOT_FOUND', 'Entry was not found in the specified session')
        }

        const maxBytes = options?.maxResponseBytes ?? MAX_BUILDX_ENTRY_BYTES
        const serialized = JSON.stringify(record)
        if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
          return failure('RESPONSE_LIMIT_REACHED', 'Entry size exceeds maximum Channel response budget')
        }

        return ok(record)
      }

      default:
        return failure('UNKNOWN_TOOL', `Unknown BuildX SMC tool: "${name}"`)
    }
  } catch (error: any) {
    return failure(error?.code ?? 'EXECUTION_FAILED', error?.message ?? String(error))
  }
}
