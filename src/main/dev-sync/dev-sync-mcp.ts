import type { AgentAuthority } from '../continuum/agent-authority'
import type { McpToolDefinition, McpToolResult } from '../mcp/channel-mcp-adapter'
import type { DevSyncService } from './dev-sync-service'

export const REQUEST_DEV_SYNC_TOOL: McpToolDefinition = {
  name: 'request_dev_sync',
  description: 'Request automated git fetch, fast-forward pull and complete development runtime renewal for the Code Awareness development checkout. Validates clean worktree, upstream tracking and supervisor authorization before scheduling restart.',
  inputSchema: {
    type: 'object',
    properties: {
      operationId: {
        type: 'string',
        minLength: 1,
        description: 'Unique idempotent operation identifier.'
      },
      expectedInstanceId: {
        type: 'string',
        minLength: 1,
        description: 'Instance identifier obtained from get_runtime_identity.'
      },
      expectedIntegratedCommit: {
        type: 'string',
        minLength: 7,
        maxLength: 40,
        description: 'Optional integrated commit SHA to verify reachability in upstream after fetch.'
      }
    },
    required: ['operationId', 'expectedInstanceId'],
    additionalProperties: false
  },
  securitySchemes: [{ type: 'oauth2', scopes: [] }]
}

export async function executeRequestDevSync(
  service: DevSyncService,
  args: unknown,
  authority?: AgentAuthority,
  targetRepositoryId?: string
): Promise<McpToolResult> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { content: [{ type: 'text', text: 'INVALID_ARGUMENT: Expected an arguments object' }], isError: true }
  }

  const values = args as Record<string, unknown>
  const allowedKeys = new Set(['operationId', 'expectedInstanceId', 'expectedIntegratedCommit'])
  for (const key of Object.keys(values)) {
    if (!allowedKeys.has(key)) {
      return { content: [{ type: 'text', text: `INVALID_ARGUMENT: Unknown argument '${key}'` }], isError: true }
    }
  }

  if (typeof values.operationId !== 'string' || !values.operationId) {
    return { content: [{ type: 'text', text: 'INVALID_ARGUMENT: operationId is required' }], isError: true }
  }

  if (typeof values.expectedInstanceId !== 'string' || !values.expectedInstanceId) {
    return { content: [{ type: 'text', text: 'INVALID_ARGUMENT: expectedInstanceId is required' }], isError: true }
  }

  if (values.expectedIntegratedCommit !== undefined) {
    if (typeof values.expectedIntegratedCommit !== 'string' || !/^[0-9a-fA-F]{7,40}$/.test(values.expectedIntegratedCommit)) {
      return { content: [{ type: 'text', text: 'INVALID_ARGUMENT: expectedIntegratedCommit must be a valid git commit SHA' }], isError: true }
    }
  }

  // Verificar autorização do agente
  if (!authority || (typeof authority.isActive === 'function' && !authority.isActive())) {
    return { content: [{ type: 'text', text: 'AGENT_UNAUTHORIZED: Missing active agent authority for DevSync' }], isError: true }
  }

  if (targetRepositoryId && authority.repositoryId !== targetRepositoryId) {
    return {
      content: [{ type: 'text', text: `REPOSITORY_MISMATCH: DevSync requires an authorized context matching repository '${targetRepositoryId}', found '${authority.repositoryId}'` }],
      isError: true
    }
  }

  const outcome = await service.executeDevSync({
    operationId: values.operationId,
    expectedInstanceId: values.expectedInstanceId,
    expectedIntegratedCommit: values.expectedIntegratedCommit as string | undefined,
    caller: 'MCP'
  })

  const { postResponse, ...payload } = outcome
  const isError = outcome.status !== 'SCHEDULED' && outcome.status !== 'ALREADY_CURRENT' && outcome.status !== 'COMPLETED'

  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    ...(postResponse ? { postResponse } : {}),
    ...(isError ? { isError: true as const } : {})
  }
}
