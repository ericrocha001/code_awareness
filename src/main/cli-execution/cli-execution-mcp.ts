import type { McpToolDefinition, McpToolResult } from '../mcp/channel-mcp-adapter'
import type { CliExecutionService } from './cli-execution-service'
import { operationalFailure } from '../mcp/operational-guidance'

const securitySchemes = [{ type: 'oauth2' as const, scopes: [] as string[] }]

export const CLI_EXECUTION_TOOLS: McpToolDefinition[] = [
  {
    name: 'prepare_cli_execution',
    description:
      'Prepare general CLI execution without spawning. Default: active checkout under Desktop policy. Optional worktreeId and generation must come from discover_worktrees in this repository; a sibling checkout requires exact-command native approval and never inherits active-checkout autonomy. Never switches project or grants a Git lease. Tools must already be configured in the target.',
    inputSchema: {
      type: 'object',
      properties: {
        worktree: {
          type: 'object',
          properties: {
            worktreeId: { type: 'string', pattern: '^[a-f0-9]{64}$' },
            generation: { type: 'string', pattern: '^[a-f0-9]{64}$' }
          },
          required: ['worktreeId', 'generation'], additionalProperties: false,
          description: 'Previously discovered Worktree in this repository; identity, HEAD and index are pinned until launch.'
        },
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
          description: 'Relative working directory within the selected Worktree, or the active checkout when omitted.'
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
      'Start the exact proposal under host-selected policy. SUPERVISED requests native consent; autonomous modes skip per-command dialogs only when authorized locally. NOT_AUTO_AUTHORIZED requires selecting SUPERVISED in Desktop. Idempotent by proposalId/operationId.',
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

const investigationTool = (name: string, description: string, properties: Record<string, unknown>, required: string[], mutation: boolean): McpToolDefinition => ({
  name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false },
  annotations: { readOnlyHint: !mutation, openWorldHint: mutation, idempotentHint: true, ...(mutation ? { destructiveHint: true } : {}), title: name }, securitySchemes
})
const proposalOperation = { proposalId: { type: 'string', minLength: 1 }, operationId: { type: 'string', minLength: 1, maxLength: 128 } }
const { worktree: _worktree, ...investigationCommandProperties } = CLI_EXECUTION_TOOLS[0].inputSchema.properties as Record<string, unknown>
CLI_EXECUTION_TOOLS.push(
  investigationTool('prepare_cli_investigation', 'Resolve a closed ordered manifest of 2–5 literal commands in the active checkout without spawning. Same host policy as unitary CLI. Limits: 30s/step, 90s total, 64KiB combined output/step and 256KiB total; manifest limited to 6KiB. No dynamic insertion or executable placeholders.',
    { commands: { type: 'array', minItems: 2, maxItems: 5, items: { ...CLI_EXECUTION_TOOLS[0].inputSchema, properties: investigationCommandProperties } } }, ['commands'], false),
  investigationTool('start_cli_investigation', 'Start a prepared manifest sequentially with the shared Windows supervisor. One complete native approval in SUPERVISED, zero in locally authorized autonomous modes. Any failure or authority drift stops remaining steps. Recover lost responses with the same operationId; after restart missing receipts are not recoverable.', proposalOperation, ['proposalId', 'operationId'], true),
  investigationTool('get_cli_investigation', 'Get bounded manifest/step status without stdout/stderr. Supply index and optional cursor to read only that step output, at most 8KiB combined per page. Unknown operation after restart is not recoverable; never automatically replay using a new ID.',
    { operationId: { type: 'string', minLength: 1 }, index: { type: 'integer', minimum: 0, maximum: 4 }, cursor: { type: 'string' } }, ['operationId'], false),
  investigationTool('cancel_cli_investigation', 'Cancel the active manifest and its process tree, prevent all subsequent steps, and return observed status without output. TERMINATION_UNCONFIRMED retains the shared execution slot.',
    { operationId: { type: 'string', minLength: 1 } }, ['operationId'], true)
)

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
    const allowed: Record<string, string[]> = {
      prepare_cli_execution: ['executable', 'args', 'relativeCwd', 'worktree'], start_cli_execution: ['proposalId', 'operationId'],
      get_cli_execution: ['operationId', 'cursor'], cancel_cli_execution: ['operationId'],
      prepare_cli_investigation: ['commands'], start_cli_investigation: ['proposalId', 'operationId'],
      get_cli_investigation: ['operationId', 'index', 'cursor'], cancel_cli_investigation: ['operationId']
    }
    if (allowed[name] && Object.keys(values).some(key => !allowed[name].includes(key))) return error('INVALID_ARGUMENT', 'Unknown argument; autonomy is controlled only in Desktop')
    if (name === 'prepare_cli_investigation') {
      if (!Array.isArray(values.commands) || values.commands.length < 2 || values.commands.length > 5) return error('INVALID_ARGUMENT', 'Expected 2–5 commands')
      const commands: import('./cli-execution-types').PrepareCliExecutionInput[] = []
      for (const value of values.commands) {
        const command = asObject(value)
        if (!command || Object.keys(command).some(key => !['executable', 'args', 'relativeCwd'].includes(key)) ||
          typeof command.executable !== 'string' || !command.executable.trim() ||
          command.args !== undefined && (!Array.isArray(command.args) || command.args.some(arg => typeof arg !== 'string')) ||
          command.relativeCwd !== undefined && typeof command.relativeCwd !== 'string') return error('INVALID_ARGUMENT', 'Invalid literal command')
        commands.push(command as unknown as import('./cli-execution-types').PrepareCliExecutionInput)
      }
      const proposal = await service.prepareInvestigation({ commands })
      return result({ ...proposal, command: undefined })
    }
    if (name === 'start_cli_investigation' || name === 'get_cli_investigation' || name === 'cancel_cli_investigation') {
      if (typeof values.operationId !== 'string' || !values.operationId.trim()) return error('INVALID_ARGUMENT', 'operationId is required')
      if (name === 'start_cli_investigation') {
        if (typeof values.proposalId !== 'string' || !values.proposalId.trim()) return error('INVALID_ARGUMENT', 'proposalId is required')
        return result(service.startInvestigation({ operationId: values.operationId, proposalId: values.proposalId }))
      }
      if (name === 'cancel_cli_investigation') return result(await service.cancelInvestigation({ operationId: values.operationId }))
      if (values.index !== undefined && (typeof values.index !== 'number' || !Number.isInteger(values.index)) || values.cursor !== undefined && typeof values.cursor !== 'string') return error('INVALID_ARGUMENT')
      return result(service.getInvestigation({ operationId: values.operationId, index: values.index as number | undefined, cursor: values.cursor as string | undefined }))
    }
    if (name === 'prepare_cli_execution') {
      const worktree = values.worktree === undefined ? undefined : asObject(values.worktree)
      if (values.worktree !== undefined && (!worktree || Object.keys(worktree).some(key => !['worktreeId', 'generation'].includes(key)) ||
        typeof worktree.worktreeId !== 'string' || !/^[a-f0-9]{64}$/.test(worktree.worktreeId) ||
        typeof worktree.generation !== 'string' || !/^[a-f0-9]{64}$/.test(worktree.generation))) {
        return error('INVALID_ARGUMENT', 'worktree requires discovered worktreeId and generation; paths are not accepted')
      }
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
        ...(worktree ? { worktree: { worktreeId: worktree.worktreeId as string, generation: worktree.generation as string } } : {}),
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
    if (/^(WORKTREE_[A-Z_]+|INVALID_WORKTREE_SELECTOR|GIT_OPERATION_IN_PROGRESS|PROJECT_CONTEXT_CHANGED)$/.test(message)) return error(message)
    const code = message.split(':')[0]
    if (['NOT_AUTO_AUTHORIZED', 'POLICY_CHANGED', 'OPERATION_KIND_CONFLICT', 'INVESTIGATION_COMMAND_LIMIT', 'MANIFEST_SIZE_LIMIT', 'SUMMARY_SIZE_LIMIT', 'INVALID_OUTPUT_INDEX', 'INVALID_OUTPUT_CURSOR', 'OUTPUT_INDEX_REQUIRED'].includes(code)) return error(code, code === 'NOT_AUTO_AUTHORIZED' ? 'Select SUPERVISED locally; no command was executed' : undefined)
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
