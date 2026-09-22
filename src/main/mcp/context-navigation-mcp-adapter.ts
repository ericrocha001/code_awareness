import { ContextNavigationError } from '../../shared/types/context-navigation-types'
import type { RelationshipDirection, SymbolHierarchyDirection } from '../../shared/types/context-navigation-types'
import type { ContextNavigationPort } from '../core/context/context-navigation-port'
import { bindProjectNavigation, type ProjectContextNavigation } from '../core/context/project-context-navigation'
import { serializeDiscovery, serializeRelationships, serializeInspectFiles, serializeReadCode, serializeReferences, serializeSymbolDependencies, serializeSymbolHierarchy } from '../core/context/context-navigation-serializer'

export interface McpOAuthSecurityScheme {
  type: 'oauth2'
  scopes: string[]
}

export interface McpToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  securitySchemes: McpOAuthSecurityScheme[]
}
export interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: true
}
const references = { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, uniqueItems: true }
const oauthSecuritySchemes: McpOAuthSecurityScheme[] = [{ type: 'oauth2', scopes: [] }]
function protectedTool(definition: Omit<McpToolDefinition, 'securitySchemes'>): McpToolDefinition {
  return { ...definition, securitySchemes: oauthSecuritySchemes }
}
export const contextNavigationMcpTools: McpToolDefinition[] = [
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
  const tool = contextNavigationMcpTools.find((entry) => entry.name === name)
  if (!tool) throw new ContextNavigationError('INVALID_ARGUMENT', 'Unknown tool: ' + name)
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new ContextNavigationError('INVALID_ARGUMENT', 'Expected an arguments object')
  const values = args as Record<string, unknown>
  const properties = tool.inputSchema.properties as Record<string, unknown>
  if (Object.keys(values).some((key) => !Object.prototype.hasOwnProperty.call(properties, key))) throw new ContextNavigationError('INVALID_ARGUMENT', 'Unexpected argument')
  for (const key of (tool.inputSchema.required ?? []) as string[]) {
    if (!(key in values)) throw new ContextNavigationError('INVALID_ARGUMENT', 'Missing argument: ' + key)
  }
  for (const [key, value] of Object.entries(values)) {
    if (key === 'relativePaths' || key === 'targetIds' || key === 'sourceTargetIds') {
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

import { SYSTEM_HEALTH_MCP_TOOL, executeGetSystemHealth } from '../system-health/system-health-mcp'
import { SystemHealthCore } from '../system-health/system-health-core'
import { RUNTIME_IDENTITY_MCP_TOOL, executeGetRuntimeIdentity } from '../runtime-identity/runtime-identity-mcp'
import { RuntimeIdentityProvider } from '../runtime-identity/runtime-identity-provider'
import {
  LIST_VALIDATION_PROOFS_TOOL,
  GET_VALIDATION_PROOF_TOOL,
  RECORD_VALIDATION_PROOF_TOOL,
  executeListValidationProofs,
  executeGetValidationProof,
  executeRecordValidationProof
} from '../validation-ledger/validation-ledger-mcp'
import type { ValidationLedger } from '../validation-ledger/validation-ledger'
import {
  LIST_ARTIFACTS_TOOL,
  GET_ARTIFACT_TOOL,
  executeListArtifacts,
  executeGetArtifact
} from '../continuum/continuum-mcp'
import type { IArtifactReader } from '../continuum/continuum-types'

export class ContextNavigationMcpAdapter {
  private readonly navigation: ProjectContextNavigation
  private readonly systemHealth: SystemHealthCore | undefined
  private readonly runtimeIdentity: RuntimeIdentityProvider | undefined
  private readonly validationLedger: ValidationLedger | undefined
  private readonly artifactReader: IArtifactReader | undefined

  constructor(
    navigation: ProjectContextNavigation,
    systemHealth?: SystemHealthCore,
    runtimeIdentity?: RuntimeIdentityProvider,
    validationLedger?: ValidationLedger,
    artifactReader?: IArtifactReader
  )
  constructor(
    navigation: ContextNavigationPort,
    repoPath: string,
    systemHealth?: SystemHealthCore,
    runtimeIdentity?: RuntimeIdentityProvider,
    validationLedger?: ValidationLedger,
    artifactReader?: IArtifactReader
  )
  constructor(
    navigation: ContextNavigationPort | ProjectContextNavigation,
    repoPathOrHealth?: string | SystemHealthCore,
    systemHealthOrIdentity?: SystemHealthCore | RuntimeIdentityProvider,
    runtimeIdentityOrLedger?: RuntimeIdentityProvider | ValidationLedger,
    validationLedgerOrReader?: ValidationLedger | IArtifactReader,
    artifactReader?: IArtifactReader
  ) {
    if (typeof repoPathOrHealth === 'string') {
      this.navigation = bindProjectNavigation(navigation as ContextNavigationPort, repoPathOrHealth)
      this.systemHealth = systemHealthOrIdentity as SystemHealthCore | undefined
      this.runtimeIdentity =
        (runtimeIdentityOrLedger as RuntimeIdentityProvider | undefined) ??
        this.systemHealth?.getRuntimeIdentityProvider()
      this.validationLedger = validationLedgerOrReader as ValidationLedger | undefined
      this.artifactReader = artifactReader
    } else {
      this.navigation = navigation as ProjectContextNavigation
      this.systemHealth = repoPathOrHealth as SystemHealthCore | undefined
      this.runtimeIdentity =
        (systemHealthOrIdentity as RuntimeIdentityProvider | undefined) ??
        this.systemHealth?.getRuntimeIdentityProvider()
      this.validationLedger =
        runtimeIdentityOrLedger as ValidationLedger | undefined
      this.artifactReader =
        (validationLedgerOrReader as IArtifactReader | undefined) ?? artifactReader
    }
  }

  listTools(): McpToolDefinition[] {
    const tools = [
      ...contextNavigationMcpTools,
      SYSTEM_HEALTH_MCP_TOOL,
      RUNTIME_IDENTITY_MCP_TOOL
    ]
    if (this.validationLedger) {
      tools.push(
        LIST_VALIDATION_PROOFS_TOOL,
        GET_VALIDATION_PROOF_TOOL,
        RECORD_VALIDATION_PROOF_TOOL
      )
    }
    if (this.artifactReader) {
      tools.push(
        LIST_ARTIFACTS_TOOL,
        GET_ARTIFACT_TOOL
      )
    }
    return tools
  }

  async callTool(name: string, args: unknown, invocationContext?: import('../core/context/context-navigation-port').NavigationInvocationContext): Promise<McpToolResult> {
    if (name === 'list_artifacts') {
      if (!this.artifactReader) {
        return { content: [{ type: 'text', text: 'CONTINUUM_UNAVAILABLE: No artifact reader configured for active project' }], isError: true }
      }
      return executeListArtifacts(this.artifactReader, args)
    }

    if (name === 'get_artifact') {
      if (!this.artifactReader) {
        return { content: [{ type: 'text', text: 'CONTINUUM_UNAVAILABLE: No artifact reader configured for active project' }], isError: true }
      }
      return executeGetArtifact(this.artifactReader, args)
    }

    if (name === 'get_runtime_identity') {
      const provider =
        this.runtimeIdentity ??
        this.systemHealth?.getRuntimeIdentityProvider() ??
        new RuntimeIdentityProvider()
      return executeGetRuntimeIdentity(provider, args)
    }

    if (name === 'get_system_health') {
      const core = this.systemHealth ?? new SystemHealthCore()
      return executeGetSystemHealth(core, args)
    }

    if (name === 'list_validation_proofs') {
      if (!this.validationLedger) {
        return { content: [{ type: 'text', text: 'LEDGER_UNAVAILABLE: No validation ledger configured' }], isError: true }
      }
      return executeListValidationProofs(this.validationLedger, args)
    }

    if (name === 'get_validation_proof') {
      if (!this.validationLedger) {
        return { content: [{ type: 'text', text: 'LEDGER_UNAVAILABLE: No validation ledger configured' }], isError: true }
      }
      return executeGetValidationProof(this.validationLedger, args)
    }

    if (name === 'record_validation_proof') {
      if (!this.validationLedger) {
        return { content: [{ type: 'text', text: 'LEDGER_UNAVAILABLE: No validation ledger configured' }], isError: true }
      }
      return executeRecordValidationProof(this.validationLedger, args)
    }

    const trace = invocationContext?.trace ?? this.systemHealth?.sink
    const requestId = invocationContext?.requestId
    const sessionId = invocationContext?.sessionId ?? 'local'
    const context: import('../core/context/context-navigation-port').NavigationInvocationContext | undefined =
      trace && requestId ? { requestId, sessionId, trace } : undefined

    const emit = (stage: import('./code-scope-health').CodeScopeTraceStage, status: 'started' | 'success' | 'error', error?: string) => {
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
        case 'discover_repository':
          return success(
            serializeDiscovery(
              await (context !== undefined
                ? this.navigation.discoverRepository(values.relativePaths as string[] | undefined, context)
                : this.navigation.discoverRepository(values.relativePaths as string[] | undefined))
            )
          )
        case 'get_relationships':
          return success(
            serializeRelationships(
              await (context !== undefined
                ? this.navigation.getRelationships(
                    values.relativePaths as string[],
                    { direction: values.direction as RelationshipDirection | undefined, details: values.details as boolean | undefined },
                    context
                  )
                : this.navigation.getRelationships(
                    values.relativePaths as string[],
                    { direction: values.direction as RelationshipDirection | undefined, details: values.details as boolean | undefined }
                  ))
            )
          )
        case 'inspect_files':
          return success(
            serializeInspectFiles(
              await (context !== undefined
                ? this.navigation.inspectFiles(
                    values.relativePaths as string[],
                    { signatures: values.signatures as boolean | undefined },
                    context
                  )
                : this.navigation.inspectFiles(
                    values.relativePaths as string[],
                    { signatures: values.signatures as boolean | undefined }
                  ))
            )
          )
        case 'read_code':
          return {
            content: (
              await (context !== undefined
                ? this.navigation.readCode(values.targetIds as string[], context)
                : this.navigation.readCode(values.targetIds as string[]))
            ).map((result) => ({ type: 'text', text: serializeReadCode(result) }))
          }
        case 'get_references':
          return success(
            serializeReferences(
              await (context !== undefined
                ? this.navigation.getReferences(values.targetIds as string[], context)
                : this.navigation.getReferences(values.targetIds as string[]))
            )
          )
        case 'get_symbol_dependencies':
          return success(
            serializeSymbolDependencies(
              await (context !== undefined
                ? this.navigation.getSymbolDependencies(values.sourceTargetIds as string[], context)
                : this.navigation.getSymbolDependencies(values.sourceTargetIds as string[]))
            )
          )
        case 'get_symbol_hierarchy':
          return success(
            serializeSymbolHierarchy(
              await (context !== undefined
                ? this.navigation.getSymbolHierarchy(
                    values.targetIds as string[],
                    { direction: values.direction as SymbolHierarchyDirection | undefined },
                    context
                  )
                : this.navigation.getSymbolHierarchy(
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
      return failure(error)
    }
  }
}
