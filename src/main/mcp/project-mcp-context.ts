import type { IArtifactReader, IContinuumService } from '../continuum/continuum-types'
import type { ProjectContextNavigation } from '../core/context/project-context-navigation'
import type { DiagnosticSourceAccess } from '../diagnostic-source-access/diagnostic-source-access'
import type { RuntimeRestartController } from '../runtime-restart/runtime-restart-controller'
import type { ValidationExecution } from '../validation-execution/validation-execution'
import type { GitOperationsService } from '../git-operations/git-operations-service'
import type { GitHubIntegrationService } from '../github/github-integration-service'
import type { RepositoryFileIngress } from '../repository-file-ingress/repository-file-ingress'
import type { RepositoryFileEditing } from '../repository-file-ingress/repository-file-editing'
import type { IVisualContinuumService } from '../continuum/continuum-types'
import type { CliExecutionService } from '../cli-execution/cli-execution-service'

export interface McpProjectContext {
  sessionContext?: import('../session-context/mcp').SessionContextPort
  executionClosure?: import('./execution-closure').ClosureContext
  projectId: string
  repoRoot: string
  navigation: ProjectContextNavigation
  artifactReader?: IArtifactReader
  continuum?: IContinuumService
  visualContinuum?: IVisualContinuumService
  validationExecution?: ValidationExecution
  cliExecution?: CliExecutionService
  diagnosticSourceAccess?: DiagnosticSourceAccess
  runtimeRestart?: RuntimeRestartController
  gitOperations?: GitOperationsService
  githubIntegration?: GitHubIntegrationService
  githubPrIsActive?: () => boolean
  repositoryFileIngress?: RepositoryFileIngress
  repositoryFileEditing?: RepositoryFileEditing
  runtimePreview?: { service: import('../work-orchestration/runtime-preview/operations').RuntimePreviewOperations; isCurrent: () => boolean }
}
