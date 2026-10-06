import type { McpToolDefinition, McpToolResult } from '../mcp/mcp-types'
import { RepositoryFileIngressError, type RepositoryFileDescriptor, type RepositoryFileIngress } from './repository-file-ingress'

export const IMPORT_REPOSITORY_FILE_TOOL: McpToolDefinition = {
  name: 'import_repository_file',
  description: 'Create a new file supplied by the host inside the active repository. Downloads HTTPS bytes by streaming, up to 32 MiB. destinationPath is explicit and repository-relative. Create-only: existing destinations conflict and remain untouched. Does not stage or commit. Returns only normalized path, byte size and SHA-256.',
  inputSchema: {
    type: 'object',
    properties: {
      file: {
        type: 'object',
        properties: {
          download_url: { type: 'string', minLength: 1 },
          file_id: { type: 'string', minLength: 1 },
          mime_type: { type: 'string' },
          file_name: { type: 'string' }
        },
        required: ['download_url', 'file_id'],
        additionalProperties: false
      },
      destinationPath: { type: 'string', minLength: 1 }
    },
    required: ['file', 'destinationPath'],
    additionalProperties: false
  },
  securitySchemes: [{ type: 'oauth2', scopes: [] }],
  _meta: { 'openai/fileParams': ['file'] },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
}

export async function executeImportRepositoryFile(ingress: RepositoryFileIngress, args: unknown): Promise<McpToolResult> {
  const fail = (code: string): McpToolResult => ({ content: [{ type: 'text', text: code }], isError: true })
  if (!args || typeof args !== 'object' || Array.isArray(args)) return fail('INVALID_ARGUMENT')
  const values = args as Record<string, unknown>
  if (Object.keys(values).some(key => !['file', 'destinationPath'].includes(key)) || typeof values.destinationPath !== 'string') return fail('INVALID_ARGUMENT')
  try {
    const receipt = await ingress.importFile(values.file as RepositoryFileDescriptor, values.destinationPath)
    return { content: [{ type: 'text', text: JSON.stringify(receipt) }] }
  } catch (error) {
    return fail(error instanceof RepositoryFileIngressError ? error.code : 'IMPORT_FAILED')
  }
}
