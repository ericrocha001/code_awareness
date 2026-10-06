import type { McpToolDefinition, McpToolResult } from '../mcp/channel-mcp-adapter'
import type { RuntimeRestartController } from './runtime-restart-controller'

export const REQUEST_RUNTIME_RESTART_TOOL: McpToolDefinition = {
  name: 'request_runtime_restart',
  description: 'Request a controlled development-runtime restart when Runtime Identity recommends it. The response is completed before graceful shutdown begins; reconnecting requires the user to run Atualizar ações manually.',
  inputSchema: { type: 'object', properties: { expectedInstanceId: { type: 'string', minLength: 1 } }, required: ['expectedInstanceId'], additionalProperties: false },
  securitySchemes: [{ type: 'oauth2', scopes: [] }]
}

export async function executeRequestRuntimeRestart(controller: RuntimeRestartController, args: unknown): Promise<McpToolResult> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { content: [{ type: 'text', text: 'INVALID_ARGUMENT: Expected an arguments object' }], isError: true }
  const values = args as Record<string, unknown>
  if (Object.keys(values).some((key) => key !== 'expectedInstanceId') || typeof values.expectedInstanceId !== 'string' || !values.expectedInstanceId) {
    return { content: [{ type: 'text', text: 'INVALID_ARGUMENT: expectedInstanceId is required' }], isError: true }
  }
  const outcome = await controller.request(values.expectedInstanceId)
  const { postResponse, ...payload } = outcome
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], ...(postResponse ? { postResponse } : {}) }
}
