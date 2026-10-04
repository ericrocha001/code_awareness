import type { McpToolDefinition, McpToolResult } from '../mcp/context-navigation-mcp-adapter'
import type { DiagnosticSourceAccess } from './diagnostic-source-access'

const securitySchemes = [{ type: 'oauth2' as const, scopes: [] as string[] }]
export const DIAGNOSTIC_SOURCE_TOOLS: McpToolDefinition[] = [
  { name: 'diagnostic_list_directory', description: 'Break-glass read-only access: list immediate children of one known directory inside the active repository. Does not use CodeMap or CodeScope readiness.', inputSchema: { type: 'object', properties: { relativePath: { type: 'string', minLength: 1 } }, required: ['relativePath'], additionalProperties: false }, securitySchemes },
  { name: 'diagnostic_read_file', description: 'Break-glass read-only access: read a bounded line range from one known text file inside the active repository.', inputSchema: { type: 'object', properties: { relativePath: { type: 'string', minLength: 1 }, startLine: { type: 'integer', minimum: 1 }, endLine: { type: 'integer', minimum: 1 } }, required: ['relativePath', 'startLine', 'endLine'], additionalProperties: false }, securitySchemes },
  { name: 'diagnostic_find_text', description: 'Break-glass read-only access: find bounded literal text matches in explicitly selected text files. Regex and recursive search are not supported.', inputSchema: { type: 'object', properties: { relativePaths: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, maxItems: 20, uniqueItems: true }, text: { type: 'string', minLength: 1, maxLength: 500 }, maxMatches: { type: 'integer', minimum: 1, maximum: 100 } }, required: ['relativePaths', 'text'], additionalProperties: false }, securitySchemes }
]

function ok(value: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
}

function fail(value: unknown): McpToolResult {
  return { content: [{ type: 'text', text: value instanceof Error ? value.message : String(value) }], isError: true }
}

export async function executeDiagnosticSourceTool(access: DiagnosticSourceAccess, name: string, args: unknown): Promise<McpToolResult> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return fail('INVALID_ARGUMENT: Expected an arguments object')
  const values = args as Record<string, unknown>
  const allowed = name === 'diagnostic_list_directory' ? ['relativePath'] : name === 'diagnostic_read_file' ? ['relativePath', 'startLine', 'endLine'] : ['relativePaths', 'text', 'maxMatches']
  if (Object.keys(values).some((key) => !allowed.includes(key))) return fail('INVALID_ARGUMENT: Unexpected argument')
  try {
    if (name === 'diagnostic_list_directory') {
      if (typeof values.relativePath !== 'string') return fail('INVALID_ARGUMENT: relativePath is required')
      return ok(await access.listDirectory(values.relativePath))
    }
    if (name === 'diagnostic_read_file') {
      if (typeof values.relativePath !== 'string' || typeof values.startLine !== 'number' || typeof values.endLine !== 'number') return fail('INVALID_ARGUMENT: relativePath, startLine, and endLine are required')
      return ok(await access.readFile(values.relativePath, values.startLine, values.endLine))
    }
    if (name === 'diagnostic_find_text') {
      if (!Array.isArray(values.relativePaths) || values.relativePaths.some((value) => typeof value !== 'string') || typeof values.text !== 'string') return fail('INVALID_ARGUMENT: relativePaths and text are required')
      return ok(await access.findText(values.relativePaths as string[], values.text, values.maxMatches as number | undefined))
    }
    return fail(`UNKNOWN_TOOL: ${name}`)
  } catch (error) {
    return fail(error)
  }
}
