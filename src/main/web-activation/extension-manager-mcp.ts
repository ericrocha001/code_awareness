import type { McpToolDefinition, McpToolResult } from '../mcp/mcp-types'
import type { ExtensionManagerService } from './extension-manager-service'
import type { ExtensionOperationAction, StartExtensionOperationInput } from './extension-manager-types'

const ALLOWED_START_KEYS = new Set([
  'action',
  'operationId',
  'expectedSourceHead',
  'targetBuildId',
  'allowDirtyWorktree'
])

export const GET_WEB_EXTENSION_STATUS_TOOL: McpToolDefinition = {
  name: 'get_web_extension_status',
  description:
    'Inspect the enrolled local Chrome development web-activation extension status, active operation, last valid build, and latest runtime attestation.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false
  },
  securitySchemes: [{ type: 'oauth2', scopes: [] }]
}

export const START_WEB_EXTENSION_OPERATION_TOOL: McpToolDefinition = {
  name: 'start_web_extension_operation',
  description:
    'Start an extension lifecycle operation for the enrolled Chrome development web-activation extension (BUILD isolated staging artifacts, RELOAD runtime, or UPDATE transactional build+swap+reload+attestation).',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['BUILD', 'RELOAD', 'UPDATE'],
        description: 'Lifecycle action to start.'
      },
      operationId: {
        type: 'string',
        minLength: 1,
        description: 'Optional idempotency identifier.'
      },
      expectedSourceHead: {
        type: 'string',
        minLength: 1,
        description: 'Optional expected Git HEAD commit SHA in the canonical checkout.'
      },
      targetBuildId: {
        type: 'string',
        minLength: 1,
        description: 'Optional target buildId for RELOAD operations.'
      },
      allowDirtyWorktree: {
        type: 'boolean',
        description: 'Explicit opt-in to allow building when the source checkout has uncommitted edits.'
      }
    },
    required: ['action'],
    additionalProperties: false
  },
  securitySchemes: [{ type: 'oauth2', scopes: [] }]
}

export const GET_WEB_EXTENSION_OPERATION_TOOL: McpToolDefinition = {
  name: 'get_web_extension_operation',
  description:
    'Poll status and convergence details for a previously started web extension lifecycle operation.',
  inputSchema: {
    type: 'object',
    properties: {
      operationId: {
        type: 'string',
        minLength: 1
      }
    },
    required: ['operationId'],
    additionalProperties: false
  },
  securitySchemes: [{ type: 'oauth2', scopes: [] }]
}

export const WEB_EXTENSION_MANAGER_TOOLS: readonly McpToolDefinition[] = [
  GET_WEB_EXTENSION_STATUS_TOOL,
  START_WEB_EXTENSION_OPERATION_TOOL,
  GET_WEB_EXTENSION_OPERATION_TOOL
]

function jsonResult(payload: unknown, isError = false): McpToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {})
  }
}

export async function executeWebExtensionManagerTool(
  service: ExtensionManagerService | undefined,
  name: string,
  args: unknown
): Promise<McpToolResult> {
  if (!service) {
    return jsonResult({ code: 'WEB_EXTENSION_MANAGER_UNAVAILABLE', message: 'Extension Manager service is not configured' }, true)
  }

  const values =
    args === undefined || args === null
      ? {}
      : typeof args === 'object' && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : null

  if (!values) {
    return jsonResult({ code: 'INVALID_ARGUMENT', message: 'Expected an arguments object' }, true)
  }

  if (name === GET_WEB_EXTENSION_STATUS_TOOL.name) {
    if (Object.keys(values).length > 0) {
      return jsonResult({ code: 'INVALID_ARGUMENT', message: 'get_web_extension_status takes no arguments' }, true)
    }
    return jsonResult(service.getStatus())
  }

  if (name === START_WEB_EXTENSION_OPERATION_TOOL.name) {
    if (Object.keys(values).some((key) => !ALLOWED_START_KEYS.has(key))) {
      return jsonResult({ code: 'INVALID_ARGUMENT', message: 'Unsupported parameter in start_web_extension_operation' }, true)
    }
    const action = values.action
    if (action !== 'BUILD' && action !== 'RELOAD' && action !== 'UPDATE') {
      return jsonResult({ code: 'INVALID_ARGUMENT', message: 'action must be BUILD, RELOAD, or UPDATE' }, true)
    }
    if (values.operationId !== undefined && (typeof values.operationId !== 'string' || !values.operationId.trim())) {
      return jsonResult({ code: 'INVALID_ARGUMENT', message: 'operationId must be a non-empty string' }, true)
    }
    if (
      values.expectedSourceHead !== undefined &&
      (typeof values.expectedSourceHead !== 'string' || !values.expectedSourceHead.trim())
    ) {
      return jsonResult({ code: 'INVALID_ARGUMENT', message: 'expectedSourceHead must be a non-empty string' }, true)
    }
    if (values.targetBuildId !== undefined && (typeof values.targetBuildId !== 'string' || !values.targetBuildId.trim())) {
      return jsonResult({ code: 'INVALID_ARGUMENT', message: 'targetBuildId must be a non-empty string' }, true)
    }
    if (values.allowDirtyWorktree !== undefined && typeof values.allowDirtyWorktree !== 'boolean') {
      return jsonResult({ code: 'INVALID_ARGUMENT', message: 'allowDirtyWorktree must be boolean' }, true)
    }

    const input: StartExtensionOperationInput = {
      action: action as ExtensionOperationAction,
      ...(typeof values.operationId === 'string' ? { operationId: values.operationId } : {}),
      ...(typeof values.expectedSourceHead === 'string' ? { expectedSourceHead: values.expectedSourceHead } : {}),
      ...(typeof values.targetBuildId === 'string' ? { targetBuildId: values.targetBuildId } : {}),
      ...(typeof values.allowDirtyWorktree === 'boolean' ? { allowDirtyWorktree: values.allowDirtyWorktree } : {})
    }
    const outcome = await service.startOperation(input)
    return jsonResult(outcome, !outcome.accepted)
  }

  if (name === GET_WEB_EXTENSION_OPERATION_TOOL.name) {
    if (
      Object.keys(values).some((key) => key !== 'operationId') ||
      typeof values.operationId !== 'string' ||
      !values.operationId.trim()
    ) {
      return jsonResult({ code: 'INVALID_ARGUMENT', message: 'operationId is required' }, true)
    }
    const operation = service.getOperation(values.operationId)
    if (!operation) {
      return jsonResult({ code: 'OPERATION_NOT_FOUND', operationId: values.operationId.trim() }, true)
    }
    return jsonResult({ found: true, operation })
  }

  return jsonResult({ code: 'INVALID_ARGUMENT', message: `Unknown tool: ${name}` }, true)
}
