import { ContextNavigationError } from '../../shared/types/context-navigation-types'
import type { RelationshipDirection, SymbolHierarchyDirection } from '../../shared/types/context-navigation-types'
import type { ProjectContextNavigation } from '../core/context/project-context-navigation'
import { serializeDiscovery, serializeRelationships, serializeInspectFiles, serializeReadCode, serializeReferences, serializeSymbolDependencies, serializeSymbolHierarchy } from '../core/context/context-navigation-serializer'

import type { McpToolDefinition, McpToolResult, McpOAuthSecurityScheme } from './mcp-types'
import type { WorktreeStructureRequest } from '../git-operations/git-worktree-capture'
import { GitOperationsError } from '../git-operations/git-operations-service'

const references = { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, uniqueItems: true }
const oauthSecuritySchemes: McpOAuthSecurityScheme[] = [{ type: 'oauth2', scopes: [] }]
function protectedTool(definition: Omit<McpToolDefinition, 'securitySchemes'>): McpToolDefinition {
  return { ...definition, securitySchemes: oauthSecuritySchemes }
}
export const CODE_NAVIGATION_MCP_TOOLS: McpToolDefinition[] = [
  protectedTool({
    name: 'inspect_worktree_structure',
    description: 'Compare structures and direct import/export changes in 1–10 explicit paths of a previously discovered worktree. Uses merge-base with the canonical HEAD by default, or an exact baseCommit SHA. Reads at most 1 MiB/file and 4 MiB total. Returns versioned ephemeral locations, confidence limits and paged deltas within 24 KB; no source or canonical CodeTargets. Follow nextCursor with the same arguments, or use existing Git reads for details.',
    inputSchema: { type: 'object', properties: {
      worktreeId: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      paths: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 500 }, minItems: 1, maxItems: 10, uniqueItems: true },
      baseCommit: { type: 'string', pattern: '^(?:[a-f0-9]{40}|[a-f0-9]{64})$' },
      cursor: { type: 'string', pattern: '^[a-f0-9]{64}:[0-9]+$', maxLength: 90 }
    }, required: ['worktreeId', 'paths'], additionalProperties: false }
  }),
  protectedTool({
    name: 'discover_repository',
    description: 'List immediate children of the root or explicitly requested directories. Expand directories progressively.',
    inputSchema: { type: 'object', properties: { relativePaths: references }, additionalProperties: false }
  }),
  protectedTool({
    name: 'get_relationships',
    description: 'List one hop of file imports and importers for the requested files. Defaults to both directions and paths only.',
    inputSchema: {
      type: 'object', properties: { relativePaths: references, direction: { type: 'string', enum: ['in', 'out', 'both'] }, details: { type: 'boolean' } },
      required: ['relativePaths'], additionalProperties: false
    }
  }),
  protectedTool({
    name: 'inspect_files',
    description: 'Show a minimal structural outline and selectable targets for requested files. Optional signatures use indexed metadata only.',
    inputSchema: {
      type: 'object', properties: { relativePaths: references, signatures: { type: 'boolean' } },
      required: ['relativePaths'], additionalProperties: false
    }
  }),
  protectedTool({
    name: 'get_references',
    description: 'Find resolved usages of one or more CodeTargets. Returns the file, line, reference kind, and containing source target when available. Use when you need to know where a specific symbol is used. Results include only references resolved by the CodeMap.',
    inputSchema: { type: 'object', properties: { targetIds: references }, required: ['targetIds'], additionalProperties: false }
  }),
  protectedTool({
    name: 'get_symbol_dependencies',
    description: 'Find symbols directly used by one or more CodeTargets, as resolved by the CodeMap. Returns dependency kind, target CodeTarget, and destination file without reading source.',
    inputSchema: { type: 'object', properties: { sourceTargetIds: references }, required: ['sourceTargetIds'], additionalProperties: false }
  }),
  protectedTool({
    name: 'get_symbol_hierarchy',
    description: 'Find direct inheritance and implementation relationships known to the CodeMap for one or more CodeTargets. Use up for direct bases or implemented contracts, down for direct derived types or implementations, and both for both directions. This does not build a full tree or return transitive relationships.',
    inputSchema: {
      type: 'object', properties: { targetIds: references, direction: { type: 'string', enum: ['up', 'down', 'both'] } },
      required: ['targetIds'], additionalProperties: false
    }
  }),
  protectedTool({
    name: 'read_code',
    description: 'Read only the literal source of explicitly requested targets, in request order.',
    inputSchema: { type: 'object', properties: { targetIds: references }, required: ['targetIds'], additionalProperties: false }
  })
]

function validateArguments(name: string, args: unknown): Record<string, unknown> {
  const tool = CODE_NAVIGATION_MCP_TOOLS.find((entry) => entry.name === name)
  if (!tool) throw new ContextNavigationError('INVALID_ARGUMENT', 'Unknown tool: ' + name)
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new ContextNavigationError('INVALID_ARGUMENT', 'Expected an arguments object')
  const values = args as Record<string, unknown>
  const properties = tool.inputSchema.properties as Record<string, unknown>
  if (Object.keys(values).some((key) => !Object.prototype.hasOwnProperty.call(properties, key))) throw new ContextNavigationError('INVALID_ARGUMENT', 'Unexpected argument')
  for (const key of (tool.inputSchema.required ?? []) as string[]) {
    if (!(key in values)) throw new ContextNavigationError('INVALID_ARGUMENT', 'Missing argument: ' + key)
  }
  for (const [key, value] of Object.entries(values)) {
    if (key === 'worktreeId' || key === 'baseCommit' || key === 'cursor') {
      const schema = properties[key] as { pattern: string; maxLength?: number }
      if (typeof value !== 'string' || !new RegExp(schema.pattern).test(value) || schema.maxLength && value.length > schema.maxLength) throw new ContextNavigationError('INVALID_ARGUMENT', 'Invalid ' + key)
    } else if (key === 'paths') {
      if (!Array.isArray(value) || !value.length || value.length > 10 || value.some(path => typeof path !== 'string' || !path.length || path.length > 500) || new Set(value).size !== value.length) throw new ContextNavigationError('INVALID_ARGUMENT', 'paths must contain 1–10 unique relative paths')
    } else if (key === 'relativePaths' || key === 'targetIds' || key === 'sourceTargetIds') {
      if (!Array.isArray(value) || !value.length || value.some((entry) => typeof entry !== 'string' || !entry.length) || new Set(value).size !== value.length) {
        throw new ContextNavigationError('INVALID_ARGUMENT', key + ' must be a nonempty array of unique strings')
      }
    } else if (key === 'direction') {
      const allowed = (properties[key] as { enum?: unknown[] }).enum
      if (typeof value !== 'string' || !allowed?.includes(value)) throw new ContextNavigationError('INVALID_ARGUMENT', 'Invalid direction')
    } else if (typeof value !== 'boolean') throw new ContextNavigationError('INVALID_ARGUMENT', key + ' must be a boolean')
  }
  return values
}

function success(text: string): McpToolResult {
  return { content: [{ type: 'text', text }] }
}
function failure(error: unknown): McpToolResult {
  const message = error instanceof Error ? error.message : String(error)
  return { content: [{ type: 'text', text: (error instanceof ContextNavigationError ? error.code + ': ' : '') + message }], isError: true }
}

export async function executeCodeNavigationTool(navigation: ProjectContextNavigation, name: string, args: unknown, invocationContext?: import('../core/context/context-navigation-port').NavigationInvocationContext): Promise<McpToolResult> {
    const trace = invocationContext?.trace
    const requestId = invocationContext?.requestId
    const sessionId = invocationContext?.sessionId ?? 'local'
    const context: import('../core/context/context-navigation-port').NavigationInvocationContext | undefined =
      trace && requestId ? { ...invocationContext, requestId, sessionId, trace } : undefined

    const emit = (stage: import('../../shared/types/channel-types').ChannelTraceStage, status: 'started' | 'success' | 'error', error?: string) => {
      if (!context?.trace || !context.requestId) return
      context.trace.record({
        timestamp: new Date().toISOString(),
        requestId: context.requestId,
        sessionId: context.sessionId ?? 'local',
        method: 'tools/call',
        tool: name,
        stage,
        durationMs: 0,
        status,
        ...(error ? { error } : {})
      })
    }

    try {
      emit('codescope-operation-routed', 'started')
      let values: Record<string, unknown>
      try {
        values = validateArguments(name, args ?? {})
        emit('codescope-operation-routed', 'success')
      } catch (validationErr) {
        const code = validationErr instanceof ContextNavigationError ? validationErr.code : 'INVALID_ARGUMENT'
        emit('codescope-operation-routed', 'error', code)
        throw validationErr
      }

      switch (name) {
        case 'inspect_worktree_structure':
          if (!navigation.inspectWorktreeStructure) throw new GitOperationsError('WORKTREE_STRUCTURE_UNAVAILABLE')
          return success(JSON.stringify(await navigation.inspectWorktreeStructure(values as unknown as WorktreeStructureRequest)))
        case 'discover_repository':
          return success(
            serializeDiscovery(
              await (context !== undefined
                ? navigation.discoverRepository(values.relativePaths as string[] | undefined, context)
                : navigation.discoverRepository(values.relativePaths as string[] | undefined))
            )
          )
        case 'get_relationships':
          return success(
            serializeRelationships(
              await (context !== undefined
                ? navigation.getRelationships(
                    values.relativePaths as string[],
                    { direction: values.direction as RelationshipDirection | undefined, details: values.details as boolean | undefined },
                    context
                  )
                : navigation.getRelationships(
                    values.relativePaths as string[],
                    { direction: values.direction as RelationshipDirection | undefined, details: values.details as boolean | undefined }
                  ))
            )
          )
        case 'inspect_files':
          return success(
            serializeInspectFiles(
              await (context !== undefined
                ? navigation.inspectFiles(
                    values.relativePaths as string[],
                    { signatures: values.signatures as boolean | undefined },
                    context
                  )
                : navigation.inspectFiles(
                    values.relativePaths as string[],
                    { signatures: values.signatures as boolean | undefined }
                  ))
            )
          )
        case 'read_code':
          return {
            content: (
              await (context !== undefined
                ? navigation.readCode(values.targetIds as string[], context)
                : navigation.readCode(values.targetIds as string[]))
            ).map((result) => ({ type: 'text', text: serializeReadCode(result) }))
          }
        case 'get_references':
          return success(
            serializeReferences(
              await (context !== undefined
                ? navigation.getReferences(values.targetIds as string[], context)
                : navigation.getReferences(values.targetIds as string[]))
            )
          )
        case 'get_symbol_dependencies':
          return success(
            serializeSymbolDependencies(
              await (context !== undefined
                ? navigation.getSymbolDependencies(values.sourceTargetIds as string[], context)
                : navigation.getSymbolDependencies(values.sourceTargetIds as string[]))
            )
          )
        case 'get_symbol_hierarchy':
          return success(
            serializeSymbolHierarchy(
              await (context !== undefined
                ? navigation.getSymbolHierarchy(
                    values.targetIds as string[],
                    { direction: values.direction as SymbolHierarchyDirection | undefined },
                    context
                  )
                : navigation.getSymbolHierarchy(
                    values.targetIds as string[],
                    { direction: values.direction as SymbolHierarchyDirection | undefined }
                  ))
            )
          )
        default:
          emit('codescope-operation-routed', 'error', 'METHOD_NOT_FOUND')
          return failure(new Error(`Unknown tool: ${name}`))
      }
    } catch (error) {
      if (name === 'inspect_worktree_structure') {
        const code = error instanceof GitOperationsError || error instanceof ContextNavigationError ? error.code : 'WORKTREE_STRUCTURE_FAILED'
        return { content: [{ type: 'text', text: JSON.stringify({ code, valid: false, recommendedAction: code === 'GIT_STATE_CHANGED' ? 'Rediscover and retry the same explicit paths without a stale cursor.' : code.includes('LIMIT') ? 'Select fewer or smaller files; use bounded Git reads for details.' : 'Verify the worktree identity, relative paths and exact commit SHA before retrying.' }) }], isError: true }
      }
      return failure(error)
    }
}
