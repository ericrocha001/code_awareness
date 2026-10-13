import type { GitHubIntegrationService } from './github-integration-service'
import type { McpToolDefinition, McpToolResult } from '../mcp/mcp-types'

export const INSPECT_PULL_REQUEST_MERGEABILITY_TOOL: McpToolDefinition = {
  name: 'inspect_pull_request_mergeability',
  description: 'Read GitHub REST mergeability for one PR of the active repository. UNKNOWN permits a later requery. Graph mergeability does not authorize merge or prove reviews, checks or policies.',
  inputSchema: { type: 'object', properties: { prNumber: { type: 'integer', minimum: 1 } }, required: ['prNumber'], additionalProperties: false },
  securitySchemes: [{ type: 'oauth2', scopes: [] }]
}

export async function executeInspectPullRequestMergeability(service: GitHubIntegrationService, repoPath: string, args: unknown): Promise<McpToolResult> {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length !== 1 || !('prNumber' in args) || !Number.isSafeInteger(args.prNumber) || (args.prNumber as number) <= 0) {
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'INVALID_ARGUMENT' }) }] }
  }
  const result = await service.inspectPullRequestMergeability(repoPath, args.prNumber as number)
  return { content: [{ type: 'text', text: JSON.stringify(result) }] }
}
