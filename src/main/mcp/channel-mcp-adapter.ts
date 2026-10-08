import { createHash, randomUUID } from 'node:crypto'
import { ChannelActivityMonitor } from './channel-activity-monitor'
import type { ChannelTraceEvent } from '../../shared/types/channel-types'
import { McpWorkloadGovernor } from './mcp-workload-governor'
import type { GitOperationsService } from '../git-operations/git-operations-service'
import { GIT_OPERATIONS_TOOLS, executeGitOperationsTool } from '../git-operations/git-operations-mcp'
import type { ContextNavigationPort } from '../core/context/context-navigation-port'
import { bindProjectNavigation, type ProjectContextNavigation } from '../core/context/project-context-navigation'
import { CODE_NAVIGATION_MCP_TOOLS, executeCodeNavigationTool } from './code-navigation-mcp'
import type { McpToolDefinition, McpToolResult } from './mcp-types'
export type { McpToolDefinition, McpToolResult, McpOAuthSecurityScheme } from './mcp-types'

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
  executeGetArtifact,
  PUBLISH_ARTIFACT_TOOL,
  UPDATE_ARTIFACT_TOOL,
  executePublishArtifact,
  executeUpdateArtifact
} from '../continuum/continuum-mcp'
import type { IArtifactReader, IContinuumService } from '../continuum/continuum-types'
import type { McpProjectContext } from './project-mcp-context'
import { VALIDATION_EXECUTION_TOOLS, executeValidationTool } from '../validation-execution/validation-execution-mcp'
import type { ValidationExecution } from '../validation-execution/validation-execution'
import { DIAGNOSTIC_SOURCE_TOOLS, executeDiagnosticSourceTool } from '../diagnostic-source-access/diagnostic-source-access-mcp'
import type { DiagnosticSourceAccess } from '../diagnostic-source-access/diagnostic-source-access'
import { REQUEST_RUNTIME_RESTART_TOOL, executeRequestRuntimeRestart } from '../runtime-restart/runtime-restart-mcp'
import type { RuntimeRestartController } from '../runtime-restart/runtime-restart-controller'
import { ACADEMY_MCP_TOOLS, executeAcademyTool } from '../academy/academy-mcp'
import type { AcademyService } from '../academy/academy-service'
import type { RepositoryFileIngress } from '../repository-file-ingress/repository-file-ingress'
import { IMPORT_REPOSITORY_FILE_TOOL, executeImportRepositoryFile } from '../repository-file-ingress/repository-file-ingress-mcp'

function stableDescriptor(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableDescriptor)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, stableDescriptor(entry)]))
  }
  return value
}

export class ChannelMcpAdapter {
  private governor = new McpWorkloadGovernor()
  private activity = new ChannelActivityMonitor()

  setActivityMonitor(activity: ChannelActivityMonitor): void { this.activity = activity }
  getActivityState() { return this.activity.getState() }

  setWorkloadGovernor(governor: McpWorkloadGovernor): void { this.governor = governor }
  private readonly navigation: ProjectContextNavigation
  private readonly systemHealth: SystemHealthCore | undefined
  private readonly runtimeIdentity: RuntimeIdentityProvider | undefined
  private readonly validationLedger: ValidationLedger | undefined
  private readonly artifactReader: IArtifactReader | undefined
  private readonly continuum?: IContinuumService
  private readonly validationExecution: ValidationExecution | undefined
  private readonly diagnosticSourceAccess: DiagnosticSourceAccess | undefined
  private readonly runtimeRestart: RuntimeRestartController | undefined
  private readonly gitOperations: GitOperationsService | undefined
  private readonly academy: AcademyService | undefined
  private readonly repositoryFileIngress?: RepositoryFileIngress

  constructor(
    context: McpProjectContext,
    systemHealth?: SystemHealthCore,
    runtimeIdentity?: RuntimeIdentityProvider,
    validationLedger?: ValidationLedger,
    academy?: AcademyService
  )

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
    navigation: ContextNavigationPort | ProjectContextNavigation | McpProjectContext,
    repoPathOrHealth?: string | SystemHealthCore,
    systemHealthOrIdentity?: SystemHealthCore | RuntimeIdentityProvider,
    runtimeIdentityOrLedger?: RuntimeIdentityProvider | ValidationLedger,
    validationLedgerOrReader?: ValidationLedger | IArtifactReader | AcademyService,
    artifactReader?: IArtifactReader,
    academy?: AcademyService
  ) {
    if ('navigation' in navigation && 'projectId' in navigation) {
      const context = navigation as McpProjectContext
      this.navigation = context.navigation
      this.systemHealth = repoPathOrHealth as SystemHealthCore | undefined
      this.runtimeIdentity = (systemHealthOrIdentity as RuntimeIdentityProvider | undefined) ?? this.systemHealth?.getRuntimeIdentityProvider()
      this.validationLedger = runtimeIdentityOrLedger as ValidationLedger | undefined
      this.continuum = context.continuum
      this.artifactReader = context.continuum ?? context.artifactReader
      this.validationExecution = context.validationExecution
      this.diagnosticSourceAccess = context.diagnosticSourceAccess
      this.runtimeRestart = context.runtimeRestart
      this.gitOperations = context.gitOperations
      this.repositoryFileIngress = context.repositoryFileIngress
      this.academy = (validationLedgerOrReader as AcademyService | undefined) ?? academy
    } else if (typeof repoPathOrHealth === 'string') {
      this.navigation = bindProjectNavigation(navigation as ContextNavigationPort, repoPathOrHealth)
      this.systemHealth = systemHealthOrIdentity as SystemHealthCore | undefined
      this.runtimeIdentity =
        (runtimeIdentityOrLedger as RuntimeIdentityProvider | undefined) ??
        this.systemHealth?.getRuntimeIdentityProvider()
      this.validationLedger = validationLedgerOrReader as ValidationLedger | undefined
      this.artifactReader = artifactReader
      this.validationExecution = undefined
      this.diagnosticSourceAccess = undefined
      this.runtimeRestart = undefined
      this.academy = academy
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
      this.validationExecution = undefined
      this.diagnosticSourceAccess = undefined
      this.runtimeRestart = undefined
      this.academy = academy
    }
  }

  listTools(): McpToolDefinition[] {
    const tools = [
      ...CODE_NAVIGATION_MCP_TOOLS.filter(tool => tool.name !== 'inspect_worktree_structure' || !!this.navigation.inspectWorktreeStructure),
      SYSTEM_HEALTH_MCP_TOOL,
      RUNTIME_IDENTITY_MCP_TOOL,
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
    if (this.continuum) tools.push(PUBLISH_ARTIFACT_TOOL, UPDATE_ARTIFACT_TOOL)
    if (this.validationExecution) tools.push(...VALIDATION_EXECUTION_TOOLS)
    if (this.diagnosticSourceAccess) tools.push(...DIAGNOSTIC_SOURCE_TOOLS)
    if (this.runtimeRestart) tools.push(REQUEST_RUNTIME_RESTART_TOOL)
    if (this.gitOperations) tools.push(...GIT_OPERATIONS_TOOLS)
    if (this.repositoryFileIngress) tools.push(IMPORT_REPOSITORY_FILE_TOOL)
    if (this.academy) tools.push(...ACADEMY_MCP_TOOLS)
    return tools
  }

  getToolCatalogHash(): string {
    const hasher = createHash('sha256')
    for (const tool of [...this.listTools()].sort((a, b) => a.name.localeCompare(b.name))) {
      hasher.update(
        JSON.stringify(stableDescriptor(tool)) + '\n'
      )
    }
    return hasher.digest('hex')
  }

  async callTool(name: string, args: unknown, invocationContext?: import('../core/context/context-navigation-port').NavigationInvocationContext): Promise<McpToolResult> {
    const requestId = invocationContext?.requestId ?? randomUUID()
    const startedAt = performance.now()
    const channelCapability = this.capabilityForTool(name)
    const record = (status: ChannelTraceEvent['status'], error?: string) => this.activity.record({
      timestamp: new Date().toISOString(), requestId, sessionId: invocationContext?.sessionId ?? 'local',
      method: 'tools/call', tool: channelCapability ? name : 'unknown', channelCapability,
      stage: status === 'started' ? 'channel-request-started' : 'channel-request-completed',
      status, durationMs: performance.now() - startedAt, ...(error ? { error } : {})
    })
    record('started')
    let result: McpToolResult
    try {
      result = await this.governor.run(name, args, requestId, invocationContext?.deadlineAtMs, () => this.dispatchTool(name, args, invocationContext))
    } catch (error) {
      record('error', error instanceof Error ? error.name : 'EXECUTION_FAILED')
      throw error
    }
    record(result.isError ? 'error' : 'success', result.isError && result.content.some(entry => /\bREQUEST_TIMEOUT\b/.test(entry.text)) ? 'REQUEST_TIMEOUT' : undefined)
    if (name === 'get_system_health' && !result.isError) {
      const health = JSON.parse(result.content[0].text)
      return { ...result, content: [{ type: 'text', text: JSON.stringify({ ...health, workloadGovernor: this.governor.snapshot(), activeRunId: this.validationExecution?.getActiveRunId() ?? null }) }] }
    }
    return result
  }

  private capabilityForTool(name: string): string | undefined {
    if (name === IMPORT_REPOSITORY_FILE_TOOL.name) return 'Repository File Ingress'
    if (CODE_NAVIGATION_MCP_TOOLS.some(tool => tool.name === name)) return 'Code Navigation'
    if (GIT_OPERATIONS_TOOLS.some(tool => tool.name === name)) return 'Git Operations'
    if (ACADEMY_MCP_TOOLS.some(tool => tool.name === name)) return 'Academy'
    if (VALIDATION_EXECUTION_TOOLS.some(tool => tool.name === name) || [LIST_VALIDATION_PROOFS_TOOL, GET_VALIDATION_PROOF_TOOL, RECORD_VALIDATION_PROOF_TOOL].some(tool => tool.name === name)) return 'Validation'
    if ([LIST_ARTIFACTS_TOOL, GET_ARTIFACT_TOOL, PUBLISH_ARTIFACT_TOOL, UPDATE_ARTIFACT_TOOL].some(tool => tool.name === name)) return 'Continuum'
    if (DIAGNOSTIC_SOURCE_TOOLS.some(tool => tool.name === name)) return 'Diagnostic Source Access'
    if (name === RUNTIME_IDENTITY_MCP_TOOL.name || name === REQUEST_RUNTIME_RESTART_TOOL.name) return 'Runtime Identity/Restart'
    if (name === SYSTEM_HEALTH_MCP_TOOL.name) return 'System Health'
    return undefined
  }

  private async dispatchTool(name: string, args: unknown, invocationContext?: import('../core/context/context-navigation-port').NavigationInvocationContext): Promise<McpToolResult> {
    if (name === IMPORT_REPOSITORY_FILE_TOOL.name) {
      return this.repositoryFileIngress ? executeImportRepositoryFile(this.repositoryFileIngress, args)
        : { content: [{ type: 'text', text: 'REPOSITORY_FILE_INGRESS_UNAVAILABLE' }], isError: true }
    }
    if (GIT_OPERATIONS_TOOLS.some((tool) => tool.name === name)) {
      return this.gitOperations ? executeGitOperationsTool(this.gitOperations, name, args)
        : { content: [{ type: 'text', text: 'GIT_OPERATIONS_UNAVAILABLE' }], isError: true }
    }
    if (ACADEMY_MCP_TOOLS.some((tool) => tool.name === name)) {
      return this.academy
        ? executeAcademyTool(this.academy, name, args)
        : { content: [{ type: 'text', text: 'ACADEMY_UNAVAILABLE' }], isError: true }
    }
    if (VALIDATION_EXECUTION_TOOLS.some((tool) => tool.name === name)) {
      return this.validationExecution
        ? executeValidationTool(this.validationExecution, name, args, invocationContext?.deadlineAtMs)
        : { content: [{ type: 'text', text: 'VALIDATION_EXECUTION_UNAVAILABLE' }], isError: true }
    }

    if (DIAGNOSTIC_SOURCE_TOOLS.some((tool) => tool.name === name)) {
      return this.diagnosticSourceAccess
        ? executeDiagnosticSourceTool(this.diagnosticSourceAccess, name, args)
        : { content: [{ type: 'text', text: 'DIAGNOSTIC_SOURCE_ACCESS_UNAVAILABLE' }], isError: true }
    }

    if (name === 'request_runtime_restart') {
      return this.runtimeRestart
        ? executeRequestRuntimeRestart(this.runtimeRestart, args)
        : { content: [{ type: 'text', text: 'RUNTIME_RESTART_UNAVAILABLE' }], isError: true }
    }

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

    if (name === 'publish_artifact' || name === 'update_artifact') {
      if (!this.continuum) return { content: [{ type: 'text', text: 'CONTINUUM_UNAVAILABLE: repository service is not configured' }], isError: true }
      return name === 'publish_artifact' ? executePublishArtifact(this.continuum, args) : executeUpdateArtifact(this.continuum, args)
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

    return executeCodeNavigationTool(this.navigation, name, args, { ...invocationContext, trace: invocationContext?.trace ?? this.systemHealth?.sink })
  }
}
