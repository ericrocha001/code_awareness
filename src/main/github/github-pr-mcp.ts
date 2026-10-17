import type { McpToolDefinition, McpToolResult } from '../mcp/mcp-types'
import type { GitHubIntegrationService } from './github-integration-service'
import type { PullRequestExecutionContext } from './github-pull-requests'
import { validateBranch, validateCreatePullRequest } from './github-pull-requests'
import { PullRequestError, type CreatePullRequestInput, type PullRequestQuery } from '../../shared/types/github-pr-types'
import { toGitHubIntegrationError } from './github-errors'

const branch = { type: 'string', minLength: 1, maxLength: 255 }
function tool(name: string, description: string, properties: Record<string, unknown>, required: string[] = []): McpToolDefinition {
  return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false }, securitySchemes: [{ type: 'oauth2', scopes: [] }], annotations: { readOnlyHint: name !== 'create_pull_request', idempotentHint: true, openWorldHint: true } }
}

export const GITHUB_PR_TOOLS = [
  tool('get_pull_request_access', 'Inspect GitHub REST configuration, repository access and available PR operations. Credentials stay in Desktop; gh login is independent. Configure/connect/install through Desktop when required.', {}),
  tool('list_pull_requests', 'List a bounded page of GitHub PR summaries for the selected repository. Set state=all to include closed and merged PRs. Cursor is a page number; preserve filters.', { state: { enum: ['open', 'closed', 'all'] }, headBranch: branch, baseBranch: branch, cursor: { type: 'string', pattern: '^[1-9][0-9]{0,4}$' }, pageSize: { type: 'integer', minimum: 1, maximum: 100 } }),
  tool('get_pull_request', 'Read one real GitHub PR of the selected repository, including source/destination SHAs, state, URL and point-in-time mergeability. Does not authorize merge.', { prNumber: { type: 'integer', minimum: 1 } }, ['prNumber']),
  tool('create_pull_request', 'Create a non-draft GitHub PR after explicit native Desktop approval for repository, head/base and published expectedHeadSha. Reuse operationId after timeout; OUTCOME_UNKNOWN forbids automatic new POST. Closed/merged PRs require human decision. Never pushes or merges Git. CLI/plugin/MCP are alternative authorized channels; within MCP prefer equivalent local transport when available.', {
    headBranch: branch, baseBranch: branch, expectedHeadSha: { type: 'string', pattern: '^[a-f0-9]{40}$' }, title: { type: 'string', minLength: 1, maxLength: 256 }, body: { type: 'string', minLength: 1, maxLength: 60000 }, operationId: { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$' }, worktreeId: { type: 'string', pattern: '^[a-f0-9]{64}$' }
  }, ['headBranch', 'baseBranch', 'expectedHeadSha', 'title', 'body', 'operationId'])
]

export async function executeGitHubPrTool(service: GitHubIntegrationService, repoPath: string, name: string, args: unknown, execution: PullRequestExecutionContext): Promise<McpToolResult> {
  try {
    const definition = GITHUB_PR_TOOLS.find(tool => tool.name === name)
    if (!definition || !args || typeof args !== 'object' || Array.isArray(args)) throw new PullRequestError('INVALID_ARGUMENT')
    const values = args as Record<string, unknown>
    const allowed = definition.inputSchema.properties as Record<string, unknown>
    if (Object.keys(values).some(key => !Object.hasOwn(allowed, key)) || (definition.inputSchema.required as string[]).some(key => !Object.hasOwn(values, key))) throw new PullRequestError('INVALID_ARGUMENT')
    let result: unknown
    if (name === 'get_pull_request_access') result = await service.getPullRequestAccess(repoPath)
    else if (name === 'get_pull_request') {
      if (!Number.isSafeInteger(values.prNumber) || (values.prNumber as number) <= 0) throw new PullRequestError('INVALID_ARGUMENT')
      result = await service.getPullRequest(repoPath, values.prNumber as number)
    } else if (name === 'list_pull_requests') {
      for (const key of ['headBranch', 'baseBranch']) if (values[key] !== undefined) validateBranch(values[key])
      if ((values.state !== undefined && !['open', 'closed', 'all'].includes(values.state as string)) || (values.pageSize !== undefined && (!Number.isInteger(values.pageSize) || (values.pageSize as number) < 1 || (values.pageSize as number) > 100)) || (values.cursor !== undefined && (typeof values.cursor !== 'string' || !/^[1-9][0-9]{0,4}$/.test(values.cursor) || Number(values.cursor) > 10000))) throw new PullRequestError('INVALID_ARGUMENT')
      result = await service.listPullRequests(repoPath, values as PullRequestQuery)
    } else {
      validateCreatePullRequest(values as unknown as CreatePullRequestInput)
      result = await service.createPullRequest(repoPath, values as unknown as CreatePullRequestInput, execution)
    }
    return { content: [{ type: 'text', text: JSON.stringify(result) }] }
  } catch (error) {
    const code = error instanceof PullRequestError ? error.code : toGitHubIntegrationError(error).code
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code, ...(typeof (args as any)?.operationId === 'string' ? { operationId: (args as any).operationId } : {}), ...(code === 'OUTCOME_UNKNOWN' ? { retryability: 'SAME_OPERATION_ID_RECONCILE_ONLY', automaticPostAllowed: false } : {}) }) }] }
  }
}
