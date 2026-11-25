import type { DeliveryContextRequest } from '../../shared/types/delivery-context-types'
import { CONTINUUM_AGENT_TOOLS, executeContinuumAgent, supportsContinuumAgent } from '../continuum/continuum-agent'
import { executeAgentUpdateArtifact } from '../continuum/continuum-mcp'
import { assertArtifactAgent, type AgentAuthority } from '../continuum/agent-authority'
import { ASSESS_EXECUTION_CLOSURE_TOOL, executeAssessExecutionClosure, type ClosureContext } from './execution-closure'
import { createHash, randomUUID } from 'node:crypto'
import { INSPECT_PULL_REQUEST_MERGEABILITY_TOOL, executeInspectPullRequestMergeability } from '../github/github-mergeability-mcp'
import { GITHUB_PR_TOOLS, executeGitHubPrTool } from '../github/github-pr-mcp'
import { ChannelActivityMonitor } from './channel-activity-monitor'
import { GET_CHANNEL_USAGE_TOOL, executeGetChannelUsage } from './channel-usage-mcp'
import { GET_EVIDENCE_EVALUATION_CONTRACT_TOOL, executeGetEvidenceEvaluationContract } from '../intelligence-center/mcp'
import { INSPECT_INTELLIGENCE_EVIDENCE_TOOL, executeInspectIntelligenceEvidence } from '../intelligence-center/evidence-mcp'
import type { ChannelUsagePort } from './channel-usage-types'
import type { ChannelTraceEvent } from '../../shared/types/channel-types'
import { McpWorkloadGovernor } from './mcp-workload-governor'
import type { GitOperationsService } from '../git-operations/git-operations-service'
import { GIT_OPERATIONS_TOOLS, executeGitOperationsTool } from '../git-operations/git-operations-mcp'
import { WORKTREE_TEXT_EDITING_TOOLS, executeWorktreeTextEditing } from '../code-editing/worktree-text-editing-mcp'
import type { ContextNavigationPort } from '../core/context/context-navigation-port'
import { bindProjectNavigation, type ProjectContextNavigation } from '../core/context/project-context-navigation'
import { CODE_NAVIGATION_MCP_TOOLS, executeCodeNavigationTool } from './code-navigation-mcp'
import type { McpToolDefinition, McpMultimodalToolResult as McpToolResult } from './mcp-types'
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
import { GET_VISUAL_ARTIFACT_TOOL, PUBLISH_VISUAL_ARTIFACT_TOOL, executeGetVisualArtifact, executePublishVisualArtifact, INSPECT_ARTIFACT_STRUCTURE_TOOL, READ_ARTIFACT_SECTION_TOOL, executeArtifactNavigation, WORKTREE_EXECUTION_TOOLS, executeWorktreeExecutionTool } from '../continuum/continuum-mcp'
import type { IVisualContinuumService } from '../continuum/continuum-types'
import type { IArtifactReader, IContinuumService } from '../continuum/continuum-types'
import type { McpProjectContext } from './project-mcp-context'
import { VALIDATION_EXECUTION_TOOLS, executeValidationTool } from '../validation-execution/validation-execution-mcp'
import type { ValidationExecution } from '../validation-execution/validation-execution'
import { DIAGNOSTIC_SOURCE_TOOLS, executeDiagnosticSourceTool } from '../diagnostic-source-access/diagnostic-source-access-mcp'
import type { DiagnosticSourceAccess } from '../diagnostic-source-access/diagnostic-source-access'
import { REQUEST_RUNTIME_RESTART_TOOL, executeRequestRuntimeRestart } from '../runtime-restart/runtime-restart-mcp'
import type { RuntimeRestartController } from '../runtime-restart/runtime-restart-controller'
import { REQUEST_DEV_UPDATE_TOOL, executeRequestDevUpdate } from '../dev-update/dev-update-mcp'
import type { DevUpdateService } from '../dev-update/dev-update-service'
import { ACADEMY_MCP_TOOLS, executeAcademyTool } from '../academy/academy-mcp'
import {
  AcademyMcpSkillsProvider,
  type AcademySkillMcpObservation,
  McpProtocolError,
  type McpResourceReadResult,
  type McpResourcesListResult,
  type McpSkillGetResult,
  type McpSkillsListResult
} from '../academy/academy-mcp-skills'
import type { AcademyService } from '../academy/academy-service'
import type { RepositoryFileIngress } from '../repository-file-ingress/repository-file-ingress'
import { IMPORT_REPOSITORY_FILE_TOOL, executeImportRepositoryFile } from '../repository-file-ingress/repository-file-ingress-mcp'
import type { RepositoryFileEditing } from '../repository-file-ingress/repository-file-editing'
import { REPOSITORY_FILE_EDITING_TOOLS, executeRepositoryFileEditing } from '../repository-file-ingress/repository-file-editing-mcp'
import { RUNTIME_PREVIEW_TOOLS, executeRuntimePreviewTool } from '../work-orchestration/runtime-preview/mcp'
import { assertValidSessionRepositoryId, nativeLiteralTarget, SESSION_CONTEXT_TOOLS, scopedSessionReadTools, type SessionToolName } from '../session-context/mcp'
import { CLI_EXECUTION_TOOLS, executeCliTool } from '../cli-execution/cli-execution-mcp'
import type { CliExecutionService } from '../cli-execution/cli-execution-service'
import { BUILDX_SMC_TOOLS, executeBuildxSmcTool } from '../buildx/smc/session-memory-central-mcp'
import type { SessionMemoryCentralService } from '../buildx/smc/session-memory-central-service'
import { BUILDX_UNITFLOW_TOOLS, executeBuildxUnitflowTool } from '../buildx/unitflow/unitflow-mcp'
import type { UnitFlowRuntimeFacade } from '../buildx/unitflow/unitflow-runtime-facade'
import { WEB_EXTENSION_MANAGER_TOOLS, executeWebExtensionManagerTool } from '../web-activation/extension-manager-mcp'
import type { ExtensionManagerService } from '../web-activation/extension-manager-service'

const literalReadTools = new Set(['read_artifact_section', 'read_worktree_file', 'read_agent_session_event'])
const literalReadOutputSchema = {
  type: 'object', properties: { content: { type: 'string', description: 'Literal source text selected by this read.' } },
  required: ['content'], additionalProperties: true
}

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
  private usage?: ChannelUsagePort
  private repositoryId: string | null = null
  private catalogSignature?: string
  private readonly owners = new Map<string, string | undefined>()

  setUsage(usage: ChannelUsagePort): void {
    this.usage = usage
    this.catalogSignature = undefined
    this.listTools()
  }

  stopUsage(): void {
    try { this.usage?.catalog({ at: Date.now(), repositoryId: this.repositoryId, tools: [] }) } catch {}
    this.usage = undefined
  }

  setActivityMonitor(activity: ChannelActivityMonitor): void { this.activity = activity }
  getActivityState() { return this.activity.getState() }

  setWorkloadGovernor(governor: McpWorkloadGovernor): void { this.governor = governor }
  private readonly navigation: ProjectContextNavigation
  private readonly systemHealth: SystemHealthCore | undefined
  private readonly runtimeIdentity: RuntimeIdentityProvider | undefined
  private readonly validationLedger: ValidationLedger | undefined
  private readonly artifactReader: IArtifactReader | undefined
  private readonly continuum?: IContinuumService
  private readonly executionClosure?: ClosureContext
  private readonly visualContinuum?: IVisualContinuumService
  private readonly validationExecution: ValidationExecution | undefined
  private readonly diagnosticSourceAccess: DiagnosticSourceAccess | undefined
  private readonly runtimeRestart: RuntimeRestartController | undefined
  private readonly devUpdateService: DevUpdateService | undefined
  private readonly gitOperations: GitOperationsService | undefined
  private readonly githubContext?: Pick<McpProjectContext, 'githubIntegration' | 'repoRoot' | 'githubPrIsActive'>
  private readonly academy: AcademyService | undefined
  private readonly repositoryFileIngress?: RepositoryFileIngress
  private readonly repositoryFileEditing?: RepositoryFileEditing
  private readonly runtimePreview?: McpProjectContext['runtimePreview']
  private readonly sessionContext?: McpProjectContext['sessionContext']
  private readonly skillObserver?: McpProjectContext['skillObserver']
  private readonly skillIntelligence?: McpProjectContext['skillIntelligence']
  private readonly readSessionRepository?: McpProjectContext['readSessionRepository']
  private readonly cliExecution?: CliExecutionService
  private readonly sessionMemoryCentral?: SessionMemoryCentralService
  private readonly unitflowRuntime?: UnitFlowRuntimeFacade
  private readonly webExtensionManager?: ExtensionManagerService
  private readonly projectId?: string
  private readonly repoRoot?: string
  private readonly codeNavigationAvailable: boolean
  private readonly academySkills?: AcademyMcpSkillsProvider
  private readonly assertActiveProject?: () => void

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
      this.repositoryId = context.continuum?.repositoryId ?? null
      this.navigation = context.navigation
      this.systemHealth = repoPathOrHealth as SystemHealthCore | undefined
      this.runtimeIdentity = (systemHealthOrIdentity as RuntimeIdentityProvider | undefined) ?? this.systemHealth?.getRuntimeIdentityProvider()
      this.validationLedger = runtimeIdentityOrLedger as ValidationLedger | undefined
      this.continuum = context.continuum
      this.executionClosure = context.executionClosure
      this.visualContinuum = context.visualContinuum
      this.artifactReader = context.continuum ?? context.artifactReader
      this.validationExecution = context.validationExecution
      this.diagnosticSourceAccess = context.diagnosticSourceAccess
      this.runtimeRestart = context.runtimeRestart
      this.devUpdateService = context.devUpdateService
      this.gitOperations = context.gitOperations
      this.githubContext = { githubIntegration: context.githubIntegration, repoRoot: context.repoRoot, githubPrIsActive: context.githubPrIsActive }
      this.repositoryFileIngress = context.repositoryFileIngress
      this.repositoryFileEditing = context.repositoryFileEditing
      this.runtimePreview = context.runtimePreview
      this.sessionContext = context.sessionContext
      this.skillObserver = context.skillObserver
      this.skillIntelligence = context.skillIntelligence
      this.readSessionRepository = context.readSessionRepository
      this.cliExecution = context.cliExecution
      this.sessionMemoryCentral = context.sessionMemoryCentral
      this.unitflowRuntime = context.unitflowRuntime
      this.webExtensionManager = context.webExtensionManager
      this.projectId = context.projectId
      this.repoRoot = context.repoRoot
      this.codeNavigationAvailable = Boolean(context.projectId || context.repoRoot)
      this.assertActiveProject = context.assertActiveProject
      this.academy = (validationLedgerOrReader as AcademyService | undefined) ?? academy
    } else if (typeof repoPathOrHealth === 'string') {
      this.navigation = bindProjectNavigation(navigation as ContextNavigationPort, repoPathOrHealth)
      this.repoRoot = repoPathOrHealth
      this.codeNavigationAvailable = true
      this.systemHealth = systemHealthOrIdentity as SystemHealthCore | undefined
      this.runtimeIdentity =
        (runtimeIdentityOrLedger as RuntimeIdentityProvider | undefined) ??
        this.systemHealth?.getRuntimeIdentityProvider()
      this.validationLedger = validationLedgerOrReader as ValidationLedger | undefined
      this.artifactReader = artifactReader
      this.validationExecution = undefined
      this.diagnosticSourceAccess = undefined
      this.runtimeRestart = undefined
      this.devUpdateService = undefined
      this.academy = academy
    } else {
      this.navigation = navigation as ProjectContextNavigation
      this.codeNavigationAvailable = true
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
      this.devUpdateService = undefined
      this.academy = academy
    }
    this.academySkills = this.academy
      ? new AcademyMcpSkillsProvider(this.academy, { projectId: this.projectId ?? null, repoRoot: this.repoRoot ?? null })
      : undefined
  }

  static createGlobalOnly(
    academy: AcademyService,
    systemHealth?: SystemHealthCore,
    runtimeIdentity?: RuntimeIdentityProvider,
    validationLedger?: ValidationLedger
  ): ChannelMcpAdapter {
    const unavailable = async () => {
      throw new Error('PROJECT_UNAVAILABLE: No active project selected')
    }
    const navigation = {
      discoverRepository: unavailable,
      getRelationships: unavailable,
      inspectFiles: unavailable,
      getReferences: unavailable,
      getSymbolDependencies: unavailable,
      getSymbolHierarchy: unavailable,
      readCode: unavailable
    } as unknown as ProjectContextNavigation
    return new ChannelMcpAdapter(
      { projectId: '', repoRoot: '', navigation },
      systemHealth,
      runtimeIdentity,
      validationLedger,
      academy
    )
  }

  hasSkillsExtension(): boolean {
    return Boolean(this.academySkills)
  }

  private resolveSkillBinding(authority?: AgentAuthority) {
    if (!authority) {
      return { sessionBindingState: 'UNBOUND' as const, bindingAuthority: null, sessionId: null, executionId: null, worktreeId: null }
    }
    try {
      assertArtifactAgent(authority, this.repositoryId ?? '')
    } catch {
      return { sessionBindingState: 'UNBOUND' as const, bindingAuthority: null, sessionId: null, executionId: null, worktreeId: null }
    }
    const executionId = authority.deliveryContext?.executionId ?? null
    const sessionId = authority.sessionWitness?.sessionId ?? null
    if (!executionId && !sessionId) {
      return { sessionBindingState: 'UNBOUND' as const, bindingAuthority: null, sessionId: null, executionId: null, worktreeId: null }
    }
    return {
      sessionBindingState: 'BOUND_BY_WITNESS' as const,
      bindingAuthority: authority.sessionWitness ? 'session_witness' : 'delivery_context',
      sessionId,
      executionId,
      worktreeId: authority.worktreeId ?? null
    }
  }

  private emitSkillMcpObservation(
    obs: AcademySkillMcpObservation,
    invocationContext?: import('../core/context/context-navigation-port').NavigationInvocationContext,
    authority?: AgentAuthority
  ): void {
    if (!this.skillObserver) return
    const binding = this.resolveSkillBinding(authority)
    const observationClass =
      obs.status !== 'SUCCESS'
        ? 'ATTEMPT_FAILED_OR_REFUSED'
        : obs.operation === 'resources/read'
          ? 'CONTENT_DELIVERED'
          : 'DISCOVERED_MANIFEST_FETCHED'
    try {
      this.skillObserver({
        sessionId: binding.sessionId,
        executionId: binding.executionId,
        worktreeId: binding.worktreeId,
        observationClass,
        skillId: obs.skillId ?? null,
        skillName: obs.skillName ?? null,
        skillScope: obs.scope ?? 'UNKNOWN',
        destinationId: obs.destinationId ?? null,
        version: obs.version ?? null,
        versionStatus: typeof obs.version === 'number' ? 'EXACT' : 'VERSION_UNKNOWN',
        packageHash: obs.packageHash ?? null,
        resourceUri: obs.resourceUri ?? null,
        resourcePath: obs.resourcePath ?? null,
        resourceDigest: obs.resourceDigest ?? null,
        sourceSurface: 'academy_mcp_skills',
        sourceContract: 'io.modelcontextprotocol/skills@2026-07-28',
        originalEventId: invocationContext?.requestId ?? null,
        operation: obs.operation,
        operationStatus: obs.status,
        errorCode: obs.errorCode ?? null,
        sessionBindingState: binding.sessionBindingState,
        bindingAuthority: binding.bindingAuthority
      })
    } catch {}
  }

  private observeAcademyToolResult(
    name: string,
    args: unknown,
    toolResult: McpToolResult,
    requestId?: string,
    authority?: AgentAuthority
  ): void {
    if (!this.skillObserver) return
    const binding = this.resolveSkillBinding(authority)
    const argObj = args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : undefined
    let parsed: Record<string, unknown> | undefined
    const first = toolResult.content[0]
    if (first?.type === 'text') {
      try {
        const raw = JSON.parse(first.text)
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) parsed = raw as Record<string, unknown>
      } catch {}
    }
    const skillId =
      typeof parsed?.id === 'string' ? parsed.id :
      typeof argObj?.skillId === 'string' ? argObj.skillId :
      null
    const versionRaw = parsed?.currentVersion ?? parsed?.version ?? argObj?.version
    const version = typeof versionRaw === 'number' && Number.isSafeInteger(versionRaw) && versionRaw >= 1 ? versionRaw : null
    const currentObj = parsed?.current && typeof parsed.current === 'object' ? (parsed.current as Record<string, unknown>) : undefined
    const packageHash =
      typeof parsed?.packageHash === 'string' ? parsed.packageHash :
      typeof currentObj?.packageHash === 'string' ? currentObj.packageHash :
      null
    const scope = parsed?.scope === 'GLOBAL' || parsed?.scope === 'PROJECT' ? parsed.scope : 'UNKNOWN'
    const isErr = toolResult.isError === true
    const isHistoryMetadataOnly =
      name === 'get_academy_skill_history' &&
      (argObj?.metadataOnly === true || !(parsed?.package && typeof parsed.package === 'object'))
    const observationClass = isErr
      ? 'ATTEMPT_FAILED_OR_REFUSED'
      : name === 'list_academy_skills' || isHistoryMetadataOnly
        ? 'DISCOVERED_MANIFEST_FETCHED'
        : 'CONTENT_DELIVERED'
    try {
      this.skillObserver({
        sessionId: binding.sessionId,
        executionId: binding.executionId,
        worktreeId: binding.worktreeId,
        observationClass,
        skillId,
        skillScope: scope,
        version,
        versionStatus: version !== null ? 'EXACT' : 'VERSION_UNKNOWN',
        packageHash,
        sourceSurface: 'academy_mcp_tool',
        sourceContract: 'academy-mcp/v1',
        originalEventId: requestId ?? null,
        operation: name,
        operationStatus: isErr ? 'FAILURE' : 'SUCCESS',
        errorCode: isErr && typeof parsed?.code === 'string' ? parsed.code : null,
        sessionBindingState: binding.sessionBindingState,
        bindingAuthority: binding.bindingAuthority
      })
    } catch {}
  }

  listSkills(
    params?: { cursor?: string },
    invocationContext?: import('../core/context/context-navigation-port').NavigationInvocationContext,
    authority?: AgentAuthority
  ): McpSkillsListResult {
    if (!this.academySkills) throw new McpProtocolError(-32601, 'Skills extension unavailable')
    return this.academySkills.listSkills(params, undefined, obs => this.emitSkillMcpObservation(obs, invocationContext, authority))
  }

  getSkill(
    params: { uri: string },
    invocationContext?: import('../core/context/context-navigation-port').NavigationInvocationContext,
    authority?: AgentAuthority
  ): McpSkillGetResult {
    if (!this.academySkills) throw new McpProtocolError(-32601, 'Skills extension unavailable')
    return this.academySkills.getSkill(params, undefined, obs => this.emitSkillMcpObservation(obs, invocationContext, authority))
  }

  readResource(
    params: { uri: string },
    invocationContext?: import('../core/context/context-navigation-port').NavigationInvocationContext,
    authority?: AgentAuthority
  ): McpResourceReadResult {
    if (!this.academySkills) throw new McpProtocolError(-32601, 'Resources unavailable')
    return this.academySkills.readSkillResource(params, undefined, obs => this.emitSkillMcpObservation(obs, invocationContext, authority))
  }

  listResources(
    params?: { cursor?: string },
    invocationContext?: import('../core/context/context-navigation-port').NavigationInvocationContext,
    authority?: AgentAuthority
  ): McpResourcesListResult {
    if (!this.academySkills) {
      return { resultType: 'complete', resources: [], ttlMs: 30_000, cacheScope: 'private' }
    }
    return this.academySkills.listSkillResources(params, undefined, obs => this.emitSkillMcpObservation(obs, invocationContext, authority))
  }

  listTools(): McpToolDefinition[] {
    const navigationTools = this.codeNavigationAvailable
      ? CODE_NAVIGATION_MCP_TOOLS.filter(tool => tool.name !== 'inspect_worktree_structure' || !!this.navigation.inspectWorktreeStructure)
      : []
    const tools = [
      ...navigationTools,
      SYSTEM_HEALTH_MCP_TOOL,
      RUNTIME_IDENTITY_MCP_TOOL,
      GET_CHANNEL_USAGE_TOOL,
      GET_EVIDENCE_EVALUATION_CONTRACT_TOOL,
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
    if (this.continuum?.bootstrapExecution && this.gitOperations) tools.push(...WORKTREE_EXECUTION_TOOLS)
    if (this.executionClosure && this.artifactReader) tools.push(ASSESS_EXECUTION_CLOSURE_TOOL)
    if (supportsContinuumAgent(this.continuum)) tools.push(...CONTINUUM_AGENT_TOOLS)
    if (this.continuum && 'inspectStructure' in this.continuum && 'readSection' in this.continuum) tools.push(INSPECT_ARTIFACT_STRUCTURE_TOOL, READ_ARTIFACT_SECTION_TOOL)
    if (this.visualContinuum) tools.push(PUBLISH_VISUAL_ARTIFACT_TOOL, GET_VISUAL_ARTIFACT_TOOL)
    if (this.validationExecution) tools.push(...VALIDATION_EXECUTION_TOOLS)
    if (this.runtimePreview) tools.push(...RUNTIME_PREVIEW_TOOLS)
    if (this.sessionContext) tools.push(...SESSION_CONTEXT_TOOLS, INSPECT_INTELLIGENCE_EVIDENCE_TOOL)
    if (this.diagnosticSourceAccess) tools.push(...DIAGNOSTIC_SOURCE_TOOLS)
    if (this.runtimeRestart) tools.push(REQUEST_RUNTIME_RESTART_TOOL)
    if (this.devUpdateService) tools.push(REQUEST_DEV_UPDATE_TOOL)
    if (this.gitOperations) tools.push(...GIT_OPERATIONS_TOOLS, ...WORKTREE_TEXT_EDITING_TOOLS)
    if (this.githubContext?.githubIntegration) tools.push(INSPECT_PULL_REQUEST_MERGEABILITY_TOOL)
    if (this.githubContext?.githubIntegration) tools.push(...GITHUB_PR_TOOLS.filter(tool => tool.name === 'create_pull_request' ? this.githubContext!.githubIntegration!.canCreatePullRequests?.() && !!this.githubContext!.githubPrIsActive : ['merge_pull_request', 'close_pull_request'].includes(tool.name) ? this.githubContext!.githubIntegration!.canIntegratePullRequests?.() && !!this.githubContext!.githubPrIsActive : true))
    if (this.repositoryFileIngress) tools.push(IMPORT_REPOSITORY_FILE_TOOL)
    if (this.repositoryFileEditing) tools.push(...REPOSITORY_FILE_EDITING_TOOLS)
    if (this.academy) tools.push(...ACADEMY_MCP_TOOLS)
    if (this.cliExecution) tools.push(...CLI_EXECUTION_TOOLS)
    if (this.sessionMemoryCentral && this.projectId) tools.push(...BUILDX_SMC_TOOLS)
    if (this.unitflowRuntime && this.projectId) tools.push(...BUILDX_UNITFLOW_TOOLS)
    if (this.webExtensionManager) tools.push(...WEB_EXTENSION_MANAGER_TOOLS)
    if (this.usage) {
      const inventory = tools.map(tool => ({ name: tool.name, capability: this.capabilityForTool(tool.name) ?? 'unclassified', instrumental: tool.name === GET_CHANNEL_USAGE_TOOL.name })).sort((a, b) => a.name < b.name ? -1 : 1)
      const signature = JSON.stringify(inventory)
      if (signature !== this.catalogSignature) {
        try { this.usage.catalog({ at: Date.now(), repositoryId: this.repositoryId, tools: inventory }); this.catalogSignature = signature } catch {}
      }
    }
    return tools.map(tool => literalReadTools.has(tool.name) ? { ...tool, outputSchema: literalReadOutputSchema } : tool)
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

  async callTool(name: string, args: unknown, invocationContext?: import('../core/context/context-navigation-port').NavigationInvocationContext, authority?: import('../continuum/agent-authority').AgentAuthority): Promise<McpToolResult> {
    const requestId = invocationContext?.requestId ?? randomUUID()
    const startedAt = performance.now()
    const channelCapability = this.capabilityForTool(name)
    const usage = this.usage
    const repositoryId = ['Channel', 'System Health', 'Runtime Identity/Restart', 'Academy'].includes(channelCapability ?? '') || name === GET_EVIDENCE_EVALUATION_CONTRACT_TOOL.name ? null : this.repositoryId
    let completed = false
    const record = (status: ChannelTraceEvent['status'], error?: string) => {
      if (status !== 'started' && !completed) {
        completed = true
        try { usage?.complete({ name: name.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 128), capability: channelCapability ?? 'unclassified', instrumental: name === GET_CHANNEL_USAGE_TOOL.name,
          repositoryId, at: Date.now(), durationMs: Math.max(0, performance.now() - startedAt), status: status === 'success' ? 'success' : error === 'REQUEST_TIMEOUT' ? 'timeout' : 'error' }) } catch {}
      }
      this.activity.record({
        timestamp: new Date().toISOString(), requestId, sessionId: invocationContext?.sessionId ?? 'local',
        method: 'tools/call', tool: channelCapability ? name : 'unknown', channelCapability,
        stage: status === 'started' ? 'channel-request-started' : 'channel-request-completed',
        status, durationMs: performance.now() - startedAt, ...(error ? { error } : {})
      })
    }
    record('started')
    let result: McpToolResult
    try {
      result = await this.governor.run(name, args, requestId, invocationContext?.deadlineAtMs, () => this.dispatchTool(name, args, invocationContext, authority))
    } catch (error) {
      record('error', error instanceof Error ? error.name : 'EXECUTION_FAILED')
      throw error
    }
    let prError: string | undefined
    if (result.isError && GITHUB_PR_TOOLS.some(tool => tool.name === name)) {
      const content = result.content.find(entry => entry.type === 'text')
      if (content?.type === 'text') {
        try { const code = JSON.parse(content.text).code; if (typeof code === 'string' && /^[A-Z_]{1,64}$/.test(code)) prError = code } catch {}
      }
    }
    record(result.isError ? 'error' : 'success', prError ?? (result.isError && result.content.some(entry => entry.type === 'text' && /\bREQUEST_TIMEOUT\b/.test(entry.text)) ? 'REQUEST_TIMEOUT' : undefined))
    if (name === 'get_system_health' && !result.isError) {
      const first = result.content[0]
      if (first.type !== 'text') throw new Error('INVALID_HEALTH_CONTENT')
      const health = JSON.parse(first.text)
      return { ...result, content: [{ type: 'text', text: JSON.stringify({ ...health, workloadGovernor: this.governor.snapshot(), activeRunId: this.validationExecution?.getActiveRunId() ?? null }) }] }
    }
    if ((literalReadTools.has(name) || name === 'inspect_entire_checkpoint') && !result.isError && result.content.length === 1 && result.content[0].type === 'text') {
      const data: unknown = JSON.parse(result.content[0].text)
      if (data && typeof data === 'object' && !Array.isArray(data) && typeof (data as Record<string, unknown>).content === 'string') {
        return { ...result, structuredContent: data as Record<string, unknown> }
      }
    }
    return result
  }

  capabilityForTool(name: string): string | undefined {
    if (this.owners.has(name)) return this.owners.get(name)
    const owner = this.classifyTool(name)
    if (this.owners.size < 2048) this.owners.set(name, owner)
    return owner
  }

  private classifyTool(name: string): string | undefined {
    if (name === GET_CHANNEL_USAGE_TOOL.name) return 'Channel'
    if (name === GET_EVIDENCE_EVALUATION_CONTRACT_TOOL.name || name === INSPECT_INTELLIGENCE_EVIDENCE_TOOL.name) return 'Intelligence Center'
    if (CLI_EXECUTION_TOOLS.some(tool => tool.name === name)) return 'CLI Execution'
    if (BUILDX_SMC_TOOLS.some(tool => tool.name === name) || BUILDX_UNITFLOW_TOOLS.some(tool => tool.name === name)) return 'BuildX'
    if (SESSION_CONTEXT_TOOLS.some(tool => tool.name === name)) return 'Session Context'
    if (RUNTIME_PREVIEW_TOOLS.some(tool => tool.name === name)) return 'Work Orchestration'
    if (REPOSITORY_FILE_EDITING_TOOLS.some(tool => tool.name === name)) return 'Repository File Editing'
    if (name === IMPORT_REPOSITORY_FILE_TOOL.name) return 'Repository File Ingress'
    if (CODE_NAVIGATION_MCP_TOOLS.some(tool => tool.name === name)) return 'Code Navigation'
    if (WORKTREE_TEXT_EDITING_TOOLS.some(tool => tool.name === name)) return 'Code Editing'
    if (GIT_OPERATIONS_TOOLS.some(tool => tool.name === name) || GITHUB_PR_TOOLS.some(tool => tool.name === name) || name === INSPECT_PULL_REQUEST_MERGEABILITY_TOOL.name) return 'Git Operations'
    if (ACADEMY_MCP_TOOLS.some(tool => tool.name === name)) return 'Academy'
    if (VALIDATION_EXECUTION_TOOLS.some(tool => tool.name === name) || [LIST_VALIDATION_PROOFS_TOOL, GET_VALIDATION_PROOF_TOOL, RECORD_VALIDATION_PROOF_TOOL].some(tool => tool.name === name)) return 'Validation'
    if ([ASSESS_EXECUTION_CLOSURE_TOOL, ...CONTINUUM_AGENT_TOOLS, ...WORKTREE_EXECUTION_TOOLS, LIST_ARTIFACTS_TOOL, GET_ARTIFACT_TOOL, PUBLISH_ARTIFACT_TOOL, UPDATE_ARTIFACT_TOOL, PUBLISH_VISUAL_ARTIFACT_TOOL, GET_VISUAL_ARTIFACT_TOOL, INSPECT_ARTIFACT_STRUCTURE_TOOL, READ_ARTIFACT_SECTION_TOOL].some(tool => tool.name === name)) return 'Continuum'
    if (DIAGNOSTIC_SOURCE_TOOLS.some(tool => tool.name === name)) return 'Diagnostic Source Access'
    if (name === RUNTIME_IDENTITY_MCP_TOOL.name || name === REQUEST_RUNTIME_RESTART_TOOL.name || name === REQUEST_DEV_UPDATE_TOOL.name) return 'Runtime Identity/Restart'
    if (WEB_EXTENSION_MANAGER_TOOLS.some(tool => tool.name === name)) return 'Web Extension Manager'
    if (name === SYSTEM_HEALTH_MCP_TOOL.name) return 'System Health'
    return undefined
  }

  private async prepareDelivery(authority: AgentAuthority | undefined, request?: DeliveryContextRequest, worktreeId?: string, options?: { optional?: boolean }): Promise<import('../../shared/types/delivery-context-types').DeliveryAnchor | undefined> {
    if (authority?.deliveryContextError) throw new Error('DELIVERY_CONTEXT_INVALID')
    if (authority?.worktreeId && worktreeId && authority.worktreeId !== worktreeId) throw new Error('DELIVERY_CONTEXT_CONFLICT')
    const targetWorktreeId = worktreeId ?? authority?.worktreeId
    if (!this.continuum || !this.gitOperations) {
      if (options?.optional && !request) return undefined
      throw new Error('DELIVERY_CONTEXT_INVALID')
    }
    const observe = () => this.gitOperations!.deliverySnapshot(targetWorktreeId)
    if (this.continuum.resolveExecutionContext) {
      const resolved = await this.continuum.resolveExecutionContext(authority, request, observe, { ...(targetWorktreeId ? { worktreeId: targetWorktreeId } : {}) })
      if (!resolved.anchor && !options?.optional) throw new Error('DELIVERY_CONTEXT_MISSING')
      return resolved.anchor
    }
    if (!request) {
      if (options?.optional) return undefined
      throw new Error('DELIVERY_CONTEXT_INVALID')
    }
    if (!this.continuum.prepareDeliveryContext) throw new Error('DELIVERY_CONTEXT_INVALID')
    return this.continuum.prepareDeliveryContext(authority, request, observe)
  }
  private async dispatchTool(name: string, args: unknown, invocationContext?: import('../core/context/context-navigation-port').NavigationInvocationContext, authority?: import('../continuum/agent-authority').AgentAuthority): Promise<McpToolResult> {
    if (name === GET_CHANNEL_USAGE_TOOL.name) return executeGetChannelUsage(this.usage, args, this.repositoryId)
    if (name === GET_EVIDENCE_EVALUATION_CONTRACT_TOOL.name) return executeGetEvidenceEvaluationContract(args)
    if (name === INSPECT_INTELLIGENCE_EVIDENCE_TOOL.name) {
      if (!this.sessionContext) return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'SESSION_CONTEXT_UNAVAILABLE' }) }] }
      let allowArtifactMetadata = false
      try {
        assertArtifactAgent(authority, this.repositoryId ?? '')
        allowArtifactMetadata = true
      } catch {
        allowArtifactMetadata = false
      }
      return executeInspectIntelligenceEvidence(args, {
        repositoryId: this.repositoryId,
        sessionContext: this.sessionContext,
        artifactReader: this.artifactReader,
        validationLedger: this.validationLedger,
        academy: this.academy,
        skillIntelligence: this.skillIntelligence,
        allowArtifactMetadata,
        assertSourceAuthorized: (worktreeId?: string) => {
          try {
            assertArtifactAgent(authority, this.repositoryId ?? '')
          } catch {
            throw new Error('SOURCE_NOT_AUTHORIZED')
          }
          if (authority?.worktreeId && worktreeId !== authority.worktreeId) {
            throw new Error('SOURCE_NOT_AUTHORIZED')
          }
        },
        assertCurrent: () => this.assertActiveProject?.()
      })
    }
    if (BUILDX_SMC_TOOLS.some(tool => tool.name === name)) {
      if (!this.sessionMemoryCentral || !this.projectId) {
        return { content: [{ type: 'text', text: JSON.stringify({ code: 'BUILDX_SMC_UNAVAILABLE', message: 'Session Memory Central is not available for active project' }) }], isError: true }
      }
      return executeBuildxSmcTool(this.sessionMemoryCentral, this.projectId, name, args, {
        assertActiveProject: this.assertActiveProject
      })
    }
    if (BUILDX_UNITFLOW_TOOLS.some(tool => tool.name === name)) {
      if (!this.unitflowRuntime || !this.projectId) {
        return { content: [{ type: 'text', text: JSON.stringify({ code: 'BUILDX_UNITFLOW_UNAVAILABLE', message: 'UnitFlow runtime is not available for active project' }) }], isError: true }
      }
      return executeBuildxUnitflowTool(this.unitflowRuntime, this.projectId, name, args, {
        assertActiveProject: this.assertActiveProject
      })
    }
    if (CLI_EXECUTION_TOOLS.some(tool => tool.name === name)) return this.cliExecution ? executeCliTool(this.cliExecution, name, args) : { content: [{ type: 'text', text: JSON.stringify({ code: 'CLI_EXECUTION_UNAVAILABLE' }) }], isError: true }
    if (SESSION_CONTEXT_TOOLS.some(tool => tool.name === name)) {
      if (!this.sessionContext) return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'SESSION_CONTEXT_UNAVAILABLE' }) }] }
      if (scopedSessionReadTools.has(name) && args && typeof args === 'object' && 'repositoryId' in args) {
        const { repositoryId, ...selected } = args
        try { assertValidSessionRepositoryId(repositoryId) }
        catch { return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'INVALID_ARGUMENT' }) }] } }
        if (repositoryId !== this.repositoryId) {
          try {
            assertArtifactAgent(authority, this.repositoryId ?? '')
            if (!this.readSessionRepository) throw new Error('REPOSITORY_NOT_AUTHORIZED')
            const result = await this.readSessionRepository(repositoryId, name as SessionToolName, selected, authority)
            assertArtifactAgent(authority, this.repositoryId ?? '')
            return result
          } catch { return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'REPOSITORY_NOT_AUTHORIZED' }) }] } }
        }
        args = selected
      }
      if (args && typeof args === 'object' && ('sourceSessionId' in args || name === 'list_agent_session_events' && 'query' in args)) {
        try {
          assertArtifactAgent(authority, this.repositoryId ?? '')
          if (authority.worktreeId && nativeLiteralTarget(name as SessionToolName, args)?.worktreeId !== authority.worktreeId) {
            throw new Error('SOURCE_NOT_AUTHORIZED')
          }
          const result = await this.sessionContext.call(name as SessionToolName, args)
          assertArtifactAgent(authority, this.repositoryId ?? '')
          return result
        } catch { return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'SOURCE_NOT_AUTHORIZED' }) }] } }
      }
      if (name === 'discover_execution_context') {
        try { assertArtifactAgent(authority, this.repositoryId ?? '') }
        catch { return this.sessionContext.call(name, args) }
        const result = await this.sessionContext.call(name, args, true)
        try { assertArtifactAgent(authority, this.repositoryId ?? '') }
        catch { return { isError: true, content: [{ type: 'text', text: '{"code":"SOURCE_NOT_AUTHORIZED"}' }] } }
        return result
      }
      return this.sessionContext.call(name as SessionToolName, args)
    }
    if (name === ASSESS_EXECUTION_CLOSURE_TOOL.name) {
      if (!this.executionClosure || !this.artifactReader) return { isError: true, content: [{ type: 'text', text: 'CLOSURE_UNAVAILABLE' }] }
      return executeAssessExecutionClosure({ ...this.executionClosure, reader: this.artifactReader, ledger: this.validationLedger,
        ...(this.githubContext?.githubIntegration ? { github: (prNumber: number) => this.githubContext!.githubIntegration!.getPullRequest(this.githubContext!.repoRoot, prNumber) } : {}) }, args)
    }
    if (RUNTIME_PREVIEW_TOOLS.some(tool => tool.name === name)) return this.runtimePreview ? executeRuntimePreviewTool(this.runtimePreview.service, name, args, () => { if (!this.runtimePreview?.isCurrent()) throw new Error('PROJECT_CONTEXT_CHANGED') }) : { content: [{ type: 'text', text: JSON.stringify({ success: false, code: 'PREVIEW_UNAVAILABLE' }) }], isError: true }
    if (GITHUB_PR_TOOLS.some(tool => tool.name === name) && this.githubContext?.githubIntegration) {
      return executeGitHubPrTool(this.githubContext.githubIntegration, this.githubContext.repoRoot, name, args, {
        prepareDelivery: async (request, worktreeId) => {
          const anchor = await this.prepareDelivery(authority, request, worktreeId ?? authority?.worktreeId, { optional: false })
          if (!anchor) throw new Error('DELIVERY_CONTEXT_MISSING')
          return anchor
        },
        resolveDelivery: (request, worktreeId) => this.prepareDelivery(authority, request, worktreeId ?? authority?.worktreeId, { optional: true }),
        defaultDeliveryContext: authority?.deliveryContext,
        deliveryContextError: authority?.deliveryContextError,
        defaultWorktreeId: authority?.worktreeId,
        isActive: this.githubContext.githubPrIsActive ?? (() => false),
        inspectWorktree: this.gitOperations ? id => this.gitOperations!.inspectWorktree(id) : undefined,
        resolveAutonomousLine: this.gitOperations ? criteria => this.gitOperations!.resolveAutonomousPrLine(criteria) : undefined,
        ...(authority?.sessionWitness ? { sessionWitness: authority.sessionWitness } : {}),
        ...(invocationContext?.deadlineAtMs !== undefined ? { deadlineAtMs: invocationContext.deadlineAtMs } : {}),
        ...(authority ? {
          authority: {
            repositoryId: authority.repositoryId,
            transport: authority.principal.transport,
            ...(authority.worktreeId ? { worktreeId: authority.worktreeId } : {}),
            ...(authority.deliveryContext ? { deliveryContext: authority.deliveryContext } : {}),
            isActive: () => authority.isActive() && authority.principal.isActive()
          }
        } : {})
      })
    }
    if (name === 'get_visual_artifact' || name === 'publish_visual_artifact') {
      if (!this.visualContinuum) return { content: [{ type: 'text', text: 'CONTINUUM_UNAVAILABLE' }], isError: true }
      return name === 'get_visual_artifact' ? executeGetVisualArtifact(this.visualContinuum, args) : executePublishVisualArtifact(this.visualContinuum, args, { timeoutMs: Math.max(1, Math.min(10_000, (invocationContext?.deadlineAtMs ?? Date.now() + 15_000) - Date.now() - 5500)) })
    }
    if (REPOSITORY_FILE_EDITING_TOOLS.some(tool => tool.name === name)) {
      return this.repositoryFileEditing ? executeRepositoryFileEditing(this.repositoryFileEditing, name, args)
        : { content: [{ type: 'text', text: 'REPOSITORY_FILE_EDITING_UNAVAILABLE' }], isError: true }
    }
    if (name === IMPORT_REPOSITORY_FILE_TOOL.name) {
      return this.repositoryFileIngress ? executeImportRepositoryFile(this.repositoryFileIngress, args)
        : { content: [{ type: 'text', text: 'REPOSITORY_FILE_INGRESS_UNAVAILABLE' }], isError: true }
    }
    if (WORKTREE_TEXT_EDITING_TOOLS.some(tool => tool.name === name)) {
      return this.gitOperations
        ? executeWorktreeTextEditing(this.gitOperations, args, authority, invocationContext?.deadlineAtMs)
        : { content: [{ type: 'text', text: 'GIT_OPERATIONS_UNAVAILABLE' }], isError: true }
    }
    if (GIT_OPERATIONS_TOOLS.some((tool) => tool.name === name)) {
      return this.gitOperations ? executeGitOperationsTool(
        this.gitOperations,
        name,
        args,
        async (request, worktreeId) => {
          const anchor = await this.prepareDelivery(authority, request, worktreeId, { optional: false })
          if (!anchor) throw new Error('DELIVERY_CONTEXT_MISSING')
          return anchor
        },
        authority,
        worktreeId => this.prepareDelivery(authority, undefined, worktreeId, { optional: true }),
        invocationContext?.deadlineAtMs
      )
        : { content: [{ type: 'text', text: 'GIT_OPERATIONS_UNAVAILABLE' }], isError: true }
    }
    if (name === INSPECT_PULL_REQUEST_MERGEABILITY_TOOL.name && this.githubContext?.githubIntegration) {
      return executeInspectPullRequestMergeability(this.githubContext.githubIntegration, this.githubContext.repoRoot, args)
    }
    if (ACADEMY_MCP_TOOLS.some((tool) => tool.name === name)) {
      if (!this.academy) return { content: [{ type: 'text', text: 'ACADEMY_UNAVAILABLE' }], isError: true }
      const toolResult = await executeAcademyTool(this.academy, name, args)
      if (this.skillObserver && (name === 'list_academy_skills' || name === 'get_academy_skill' || name === 'get_academy_skill_history')) {
        this.observeAcademyToolResult(name, args, toolResult, invocationContext?.requestId, authority)
      }
      return toolResult
    }
    if (VALIDATION_EXECUTION_TOOLS.some((tool) => tool.name === name)) {
      return this.validationExecution
        ? executeValidationTool(this.validationExecution, name, args, invocationContext?.deadlineAtMs, async (request, worktreeId) => {
            const anchor = await this.prepareDelivery(authority, request, worktreeId, { optional: false })
            if (!anchor) throw new Error('DELIVERY_CONTEXT_MISSING')
            return anchor
          }, authority)
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

    if (name === 'request_dev_update') {
      return this.devUpdateService
        ? executeRequestDevUpdate(this.devUpdateService, args, authority, this.repositoryId ?? undefined)
        : { content: [{ type: 'text', text: 'DEV_UPDATE_UNAVAILABLE' }], isError: true }
    }

    if (WEB_EXTENSION_MANAGER_TOOLS.some(tool => tool.name === name)) {
      return executeWebExtensionManagerTool(this.webExtensionManager, name, args)
    }

    if (WORKTREE_EXECUTION_TOOLS.some(tool => tool.name === name)) {
      if (!this.continuum) return { content: [{ type: 'text', text: 'CONTINUUM_UNAVAILABLE' }], isError: true }
      return executeWorktreeExecutionTool(this.continuum, this.gitOperations, name, args, authority)
    }
    if (CONTINUUM_AGENT_TOOLS.some(tool => tool.name === name)) {
      if (!supportsContinuumAgent(this.continuum)) return { content: [{ type: 'text', text: 'CONTINUUM_UNAVAILABLE' }], isError: true }
      const observeDelivery = this.gitOperations ? () => this.gitOperations!.deliverySnapshot(authority?.worktreeId) : undefined
      try { return { content: [{ type: 'text', text: JSON.stringify(await executeContinuumAgent(this.continuum, name, args, undefined, authority, observeDelivery)) }] } }
      catch (error) { return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true } }
    }
    if (name === 'inspect_artifact_structure' || name === 'read_artifact_section') {
      if (!this.continuum || !('inspectStructure' in this.continuum) || !('readSection' in this.continuum)) return { content: [{ type: 'text', text: 'CONTINUUM_UNAVAILABLE' }], isError: true }
      return executeArtifactNavigation(this.continuum as IContinuumService & import('../continuum/continuum-types').IArtifactStructureReader, name, args)
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
      if (name === 'publish_artifact') {
        try {
          assertArtifactAgent(authority, this.continuum.repositoryId ?? '')
          if (authority.deliveryContextError) throw new Error('DELIVERY_CONTEXT_INVALID')
          let anchor: import('../../shared/types/delivery-context-types').DeliveryAnchor | undefined
          if (this.continuum.resolveExecutionContext) {
            const observe = this.gitOperations ? () => this.gitOperations!.deliverySnapshot(authority.worktreeId) : undefined
            anchor = (await this.continuum.resolveExecutionContext(authority, authority.deliveryContext, observe)).anchor
          } else if (authority.deliveryContext) {
            anchor = await this.prepareDelivery(authority, authority.deliveryContext, authority.worktreeId)
          }
          return executePublishArtifact(this.continuum, args, authority, anchor)
        }
        catch (error) { return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] } }
      }
      const observeDelivery = this.gitOperations ? () => this.gitOperations!.deliverySnapshot(authority?.worktreeId) : undefined
      return executeAgentUpdateArtifact(this.continuum, args, authority, observeDelivery)
    }

    if (name === 'get_runtime_identity') {
      const provider =
        this.runtimeIdentity ??
        this.systemHealth?.getRuntimeIdentityProvider() ??
        new RuntimeIdentityProvider()
      return executeGetRuntimeIdentity(provider, args)
    }

    if (name === 'get_system_health') {
      if (args && typeof args === 'object' && !Array.isArray(args) && (args as Record<string, unknown>).feature === 'session_context') {
        const { feature: _feature, refresh, ...query } = args as Record<string, unknown>
        if (refresh !== undefined && typeof refresh !== 'boolean' ||
          query.source !== undefined && query.source !== 'native' && query.source !== 'entire' ||
          Object.keys(query).some(key => !['source', 'worktreeId', 'generation', 'cycleId', 'commitSha', 'agent', 'inspectNativeTrust', 'sessionId', 'executionId'].includes(key))) return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'INVALID_ARGUMENT' }) }] }
        return this.sessionContext ? this.sessionContext.call('inspect_capture_health', { source: 'native', ...query, trigger: refresh ? 'RECHECK' : 'INSPECT' }) : { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'SESSION_CONTEXT_UNAVAILABLE' }) }] }
      }
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
      try {
        if (authority?.deliveryContextError) throw new Error('DELIVERY_CONTEXT_INVALID')
        const anchor = authority?.deliveryContext ? await this.prepareDelivery(authority, authority.deliveryContext, authority.worktreeId) : undefined
        return executeRecordValidationProof(this.validationLedger, args, authority, anchor)
      } catch (error) {
        return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true }
      }
    }

    if (!this.codeNavigationAvailable) {
      return { content: [{ type: 'text', text: 'PROJECT_UNAVAILABLE: No active project selected' }], isError: true }
    }
    return executeCodeNavigationTool(this.navigation, name, args, { ...invocationContext, trace: invocationContext?.trace ?? this.systemHealth?.sink })
  }
}
