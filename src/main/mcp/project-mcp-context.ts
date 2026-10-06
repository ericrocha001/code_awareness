import type { IArtifactReader, IContinuumService } from '../continuum/continuum-types'
import type { ProjectContextNavigation } from '../core/context/project-context-navigation'
import type { DiagnosticSourceAccess } from '../diagnostic-source-access/diagnostic-source-access'
import type { RuntimeRestartController } from '../runtime-restart/runtime-restart-controller'
import type { ValidationExecution } from '../validation-execution/validation-execution'
import type { GitOperationsService } from '../git-operations/git-operations-service'
import type { RepositoryFileIngress } from '../repository-file-ingress/repository-file-ingress'

export interface McpProjectContext {
  projectId: string
  repoRoot: string
  navigation: ProjectContextNavigation
  artifactReader?: IArtifactReader
  continuum?: IContinuumService
  validationExecution?: ValidationExecution
  diagnosticSourceAccess?: DiagnosticSourceAccess
  runtimeRestart?: RuntimeRestartController
  gitOperations?: GitOperationsService
  repositoryFileIngress?: RepositoryFileIngress
}
