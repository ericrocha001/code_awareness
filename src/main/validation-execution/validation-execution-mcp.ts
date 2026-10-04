import type { McpToolDefinition, McpToolResult } from '../mcp/context-navigation-mcp-adapter'
import type { ProofProducer } from '../validation-ledger/validation-ledger-types'
import type { ValidationExecution } from './validation-execution'

const securitySchemes = [{ type: 'oauth2' as const, scopes: [] as string[] }]
export const VALIDATION_EXECUTION_TOOLS: McpToolDefinition[] = [
  { name: 'list_validation_profiles', description: 'List the fixed validation profiles that may be executed for the active repository.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, securitySchemes },
  { name: 'start_validation', description: 'Start one authorized validation profile asynchronously. Commands, executables, cwd, and free-form flags are not accepted.', inputSchema: { type: 'object', properties: { profileId: { type: 'string', minLength: 1 }, targets: { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true }, producer: { type: 'string', enum: ['IMPLEMENTER', 'ARCHITECT', 'USER', 'SYSTEM', 'TESTER'] }, evidenceFor: { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true } }, required: ['profileId', 'producer'], additionalProperties: false }, securitySchemes },
  { name: 'get_validation_run', description: 'Get the current state or normalized terminal result for a validation run.', inputSchema: { type: 'object', properties: { runId: { type: 'string', minLength: 1 } }, required: ['runId'], additionalProperties: false }, securitySchemes }
]

function result(value: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
}

function error(code: string): McpToolResult {
  return { content: [{ type: 'text', text: code }], isError: true }
}

function object(args: unknown): Record<string, unknown> | null {
  return args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : null
}

export function executeValidationTool(execution: ValidationExecution, name: string, args: unknown): McpToolResult {
  const values = object(args)
  if (!values) return error('INVALID_ARGUMENT: Expected an arguments object')
  const allowed = name === 'start_validation' ? ['profileId', 'targets', 'producer', 'evidenceFor'] : name === 'get_validation_run' ? ['runId'] : []
  if (Object.keys(values).some((key) => !allowed.includes(key))) return error('INVALID_ARGUMENT: Unexpected argument')
  try {
    if (name === 'list_validation_profiles') {
      return result({ profiles: execution.listProfiles().map(({ script: _script, timeoutMs: _timeout, scope: _scope, ...profile }) => profile) })
    }
    if (name === 'start_validation') {
      if (typeof values.profileId !== 'string' || typeof values.producer !== 'string') return error('INVALID_ARGUMENT: profileId and producer are required')
      if (values.targets !== undefined && (!Array.isArray(values.targets) || values.targets.some((value) => typeof value !== 'string'))) return error('INVALID_ARGUMENT: targets must be strings')
      if (values.evidenceFor !== undefined && (!Array.isArray(values.evidenceFor) || values.evidenceFor.some((value) => typeof value !== 'string'))) return error('INVALID_ARGUMENT: evidenceFor must be strings')
      const producer = values.producer as ProofProducer
      if (!['IMPLEMENTER', 'ARCHITECT', 'USER', 'SYSTEM', 'TESTER'].includes(producer)) return error('INVALID_ARGUMENT: Unknown producer')
      const run = execution.start({ profileId: values.profileId, targets: values.targets as string[] | undefined, producer, evidenceFor: values.evidenceFor as string[] | undefined })
      return result({ runId: run.runId, status: run.status })
    }
    if (name === 'get_validation_run') {
      if (typeof values.runId !== 'string') return error('INVALID_ARGUMENT: runId is required')
      const run = execution.get(values.runId)
      return run ? result(run) : error(`VALIDATION_RUN_NOT_FOUND: ${values.runId}`)
    }
    return error(`UNKNOWN_TOOL: ${name}`)
  } catch (caught) {
    return error(caught instanceof Error ? caught.message : String(caught))
  }
}
