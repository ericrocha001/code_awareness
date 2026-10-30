import type { McpToolDefinition, McpToolResult } from '../mcp/channel-mcp-adapter'
import type { CliExecutionService } from './cli-execution-service'
import { operationalFailure } from '../mcp/operational-guidance'

const securitySchemes = [{ type: 'oauth2' as const, scopes: [] as string[] }]

export const CLI_EXECUTION_TOOLS: McpToolDefinition[] = [
  {
    name: 'prepare_cli_execution',
    description:
      'Prepare local CLI execution in the active project checkout without spawning a process. Resolves real executable and working directory, verifies policy, and returns an ephemeral proposalId with security risks.',
    inputSchema: {
      type: 'object',
      properties: {
        executable: {
          type: 'string',
          minLength: 1,
          description: 'Command name (e.g. node, git, npm) or relative path within active checkout.'
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Typed argument vector (argv). Never interpolated into a shell.'
        },
        relativeCwd: {
          type: 'string',
          description: 'Relative working directory within the active repository checkout.'
        }
      },
      required: ['executable'],
      additionalProperties: false
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      title: 'Prepare CLI Execution'
    },
    securitySchemes
  },
  {
    name: 'start_cli_execution',
    description:
      'Request native local human authorization and start the approved CLI proposal in the active checkout. Idempotent by (proposalId, operationId). Returns immediately without blocking MCP during execution.',
    inputSchema: {
      type: 'object',
      properties: {
        proposalId: {
          type: 'string',
          minLength: 1,
          description: 'Proposal identifier returned by prepare_cli_execution.'
        },
        operationId: {
          type: 'string',
          minLength: 1,
          description: 'Idempotency operation identifier for this execution.'
        }
      },
      required: ['proposalId', 'operationId'],
      additionalProperties: false
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: true,
      idempotentHint: true,
      destructiveHint: true,
      title: 'Start CLI Execution'
    },
    securitySchemes
  },
  {
    name: 'get_cli_execution',
    description:
      'Query compact execution status, exit code, and paginated stdout/stderr output using a stable cursor. Does not dump unbounded logs.',
    inputSchema: {
      type: 'object',
      properties: {
        operationId: {
          type: 'string',
          minLength: 1,
          description: 'Operation identifier of the CLI execution.'
        },
        cursor: {
          type: 'string',
          description: 'Pagination offset cursor from a previous call.'
        }
      },
      required: ['operationId'],
      additionalProperties: false
    },
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
      title: 'Get CLI Execution Status and Output'
    },
    securitySchemes
  },
  {
    name: 'cancel_cli_execution',
    description:
      'Idempotently cancel the CLI execution and its process tree in the active repository. Returns the observed execution status.',
    inputSchema: {
      type: 'object',
      properties: {
        operationId: {
          type: 'string',
          minLength: 1,
          description: 'Operation identifier of the CLI execution to cancel.'
        }
      },
      required: ['operationId'],
      additionalProperties: false
    },
    annotations: {
      readOnlyHint: false,
      idempotentHint: true,
      openWorldHint: false,
      title: 'Cancel CLI Execution'
    },
    securitySchemes
  }
]

function result(value: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
}

function error(code: string, message?: string): McpToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ code, ...(message ? { message } : {}) }) }],
    isError: true
  }
}

function asObject(args: unknown): Record<string, unknown> | null {
  return args && typeof args === 'object' && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : null
}

export async function executeCliTool(
  service: CliExecutionService,
  name: string,
  args: unknown
): Promise<McpToolResult> {
  const values = asObject(args)
  if (!values) {
    return error('INVALID_ARGUMENT', 'Expected an arguments object')
  }

  try {
    if (name === 'prepare_cli_execution') {
      if (typeof values.executable !== 'string' || !values.executable.trim()) {
        return error('INVALID_ARGUMENT', 'executable is required')
      }
      if (
        values.args !== undefined &&
        (!Array.isArray(values.args) || values.args.some((a) => typeof a !== 'string'))
      ) {
        return error('INVALID_ARGUMENT', 'args must be an array of strings')
      }
      if (values.relativeCwd !== undefined && typeof values.relativeCwd !== 'string') {
        return error('INVALID_ARGUMENT', 'relativeCwd must be a string')
      }

      const proposal = await service.prepare({
        executable: values.executable,
        args: values.args as string[] | undefined,
        relativeCwd: values.relativeCwd as string | undefined
      })
      return result(proposal)
    }

    if (name === 'start_cli_execution') {
      if (typeof values.proposalId !== 'string' || !values.proposalId.trim()) {
        return error('INVALID_ARGUMENT', 'proposalId is required')
      }
      if (typeof values.operationId !== 'string' || !values.operationId.trim()) {
        return error('INVALID_ARGUMENT', 'operationId is required')
      }

      const snapshot = await service.start({
        proposalId: values.proposalId,
        operationId: values.operationId
      })
      return result(snapshot)
    }

    if (name === 'get_cli_execution') {
      if (typeof values.operationId !== 'string' || !values.operationId.trim()) {
        return error('INVALID_ARGUMENT', 'operationId is required')
      }
      if (values.cursor !== undefined && typeof values.cursor !== 'string') {
        return error('INVALID_ARGUMENT', 'cursor must be a string')
      }

      const snapshot = service.get({
        operationId: values.operationId,
        cursor: values.cursor as string | undefined
      })
      return result(snapshot)
    }

    if (name === 'cancel_cli_execution') {
      if (typeof values.operationId !== 'string' || !values.operationId.trim()) {
        return error('INVALID_ARGUMENT', 'operationId is required')
      }

      const snapshot = await service.cancel({
        operationId: values.operationId
      })
      return result(snapshot)
    }

    return error('UNKNOWN_TOOL', `Unknown tool: ${name}`)
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught)
    if (/CLI_EXECUTION_BUSY/.test(message)) {
      return operationalFailure({
        code: 'CLI_EXECUTION_BUSY',
        activeOperationId: service.getActiveOperationId() ?? undefined,
        retryability: 'SAFE_AFTER_BACKOFF',
        retryAfterMs: 3000,
        recommendedAction: 'FOLLOW_ACTIVE_OPERATION'
      })
    }
    if (/CLI_EXECUTION_DISABLED/.test(message)) {
      return error('CLI_EXECUTION_DISABLED', message)
    }
    if (/OPERATION_ID_CONFLICT/.test(message)) {
      return error('OPERATION_ID_CONFLICT', message)
    }
    if (/PROPOSAL_EXPIRED/.test(message)) {
      return error('PROPOSAL_EXPIRED', message)
    }
    if (/PROPOSAL_ALREADY_CONSUMED/.test(message)) {
      return error('PROPOSAL_ALREADY_CONSUMED', message)
    }
    if (/CHECKOUT_CHANGED/.test(message)) {
      return error('CHECKOUT_CHANGED', message)
    }
    if (/CWD_OUTSIDE_CHECKOUT/.test(message)) {
      return error('CWD_OUTSIDE_CHECKOUT', message)
    }
    if (/ABSOLUTE_CWD_FORBIDDEN/.test(message)) {
      return error('ABSOLUTE_CWD_FORBIDDEN', message)
    }
    if (/EXECUTABLE_NOT_FOUND/.test(message)) {
      return error('EXECUTABLE_NOT_FOUND', message)
    }
    if (/OPERATION_NOT_FOUND/.test(message)) {
      return error('OPERATION_NOT_FOUND', message)
    }
    return error('EXECUTION_ERROR', message)
  }
}
