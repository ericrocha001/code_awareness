import type { McpToolDefinition, McpToolResult } from '../mcp/context-navigation-mcp-adapter'
import type { RuntimeIdentityProvider } from './runtime-identity-provider'

export const RUNTIME_IDENTITY_MCP_TOOL: McpToolDefinition = {
  name: 'get_runtime_identity',
  description:
    'Inspect the running backend instance identity, process startup timestamp, and filesystem source code freshness. Use to verify if the currently running runtime matches the current source files on disk, identify divergent files, or check whether a restart/reload of the runtime is recommended. Does not trigger CodeMap indexing or snapshots.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false
  },
  securitySchemes: [{ type: 'oauth2', scopes: [] }]
}

export function executeGetRuntimeIdentity(
  provider: RuntimeIdentityProvider,
  args: unknown
): McpToolResult {
  if (args !== undefined && args !== null && (typeof args !== 'object' || Array.isArray(args))) {
    return {
      content: [{ type: 'text', text: 'INVALID_ARGUMENT: Expected an arguments object' }],
      isError: true
    }
  }

  const payload = provider.getIdentityPayload()
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }]
  }
}
