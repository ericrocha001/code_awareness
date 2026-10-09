import type { McpToolDefinition, McpToolResult } from '../mcp/mcp-types'
import { RepositoryFileEditingError, type RepositoryFileEditing, type FileMutationIntent } from './repository-file-editing'
import type { RepositoryFileDescriptor } from './repository-file-ingress'
import { IMPORT_REPOSITORY_FILE_TOOL } from './repository-file-ingress-mcp'

const intent = {
  type: 'object', properties: { description: { type: 'string', minLength: 1, maxLength: 1000 }, explicitUserAuthorization: { type: 'boolean', description: 'Set true only for this exact change explicitly requested by the human user. Required for AGENTS.md and ARCHITECT.md.' } },
  required: ['description'], additionalProperties: false
}
const destination = { type: 'string', minLength: 1 }
const expectedSha256 = { type: 'string', pattern: '^[a-f0-9]{64}$' }
const securitySchemes = IMPORT_REPOSITORY_FILE_TOOL.securitySchemes

export const REPOSITORY_FILE_EDITING_TOOLS: McpToolDefinition[] = [
  {
    name: 'inspect_repository_file', description: 'Inspect one explicit file in the active checkout. Returns literal byte SHA-256 and size, without content by default. includeContent returns UTF-8 text up to 1 MiB. Use this revision before editing or replacing; reconcile a lost write response by inspecting again. Managed paths, secrets and links are refused.',
    inputSchema: { type: 'object', properties: { path: destination, includeContent: { type: 'boolean' } }, required: ['path'], additionalProperties: false },
    securitySchemes, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'edit_repository_text', description: 'Edit an existing checkout UTF-8 file with 1–32 exact literal substitutions against one snapshot. Each oldText must occur exactly once and ranges must not overlap. expectedSha256 is mandatory. Preserves all other bytes. Explicit human authorization is required for agent kernels. No regex, shell, Git stage or commit. Cooperative writers serialize; external writers can still race. Returns a compact confirmed receipt; inspect before retrying a lost result.',
    inputSchema: { type: 'object', properties: { destinationPath: destination, expectedSha256, intent, replacements: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'object', properties: { oldText: { type: 'string', minLength: 1 }, newText: { type: 'string' } }, required: ['oldText', 'newText'], additionalProperties: false } } }, required: ['destinationPath', 'expectedSha256', 'intent', 'replacements'], additionalProperties: false },
    securitySchemes, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  },
  {
    name: 'replace_repository_file', description: 'Replace one existing active-checkout file, guarded by its literal expectedSha256. Supply exactly one of UTF-8 text (1 MiB) or host-authorized file bytes (32 MiB). No create/upsert or Git operations. Kernel changes require explicit human authorization for this exact change. Windows replacement preserves ACLs. External uncooperative writers may race; inspect and reconcile after a lost result before retrying. Returns only a confirmed write receipt.',
    inputSchema: { type: 'object', properties: { destinationPath: destination, expectedSha256, intent, text: { type: 'string' }, file: (IMPORT_REPOSITORY_FILE_TOOL.inputSchema.properties as Record<string, unknown>).file }, required: ['destinationPath', 'expectedSha256', 'intent'], oneOf: [{ required: ['text'], not: { required: ['file'] } }, { required: ['file'], not: { required: ['text'] } }], additionalProperties: false },
    securitySchemes, _meta: { 'openai/fileParams': ['file'] }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  }
]

export async function executeRepositoryFileEditing(service: RepositoryFileEditing, name: string, args: unknown): Promise<McpToolResult> {
  const fail = (code: string): McpToolResult => ({ content: [{ type: 'text', text: code }], isError: true })
  if (!args || typeof args !== 'object' || Array.isArray(args)) return fail('INVALID_ARGUMENT')
  const values = args as Record<string, unknown>
  const allowed = name === 'inspect_repository_file' ? ['path', 'includeContent'] : name === 'edit_repository_text' ? ['destinationPath', 'expectedSha256', 'intent', 'replacements'] : ['destinationPath', 'expectedSha256', 'intent', 'text', 'file']
  if (!REPOSITORY_FILE_EDITING_TOOLS.some(tool => tool.name === name) || Object.keys(values).some(key => !allowed.includes(key))) return fail('INVALID_ARGUMENT')
  try {
    let result: unknown
    if (name === 'inspect_repository_file') {
      if (typeof values.path !== 'string' || values.includeContent !== undefined && typeof values.includeContent !== 'boolean') return fail('INVALID_ARGUMENT')
      result = await service.inspectFile(values.path, values.includeContent as boolean | undefined)
    } else {
      if (typeof values.destinationPath !== 'string') return fail('INVALID_ARGUMENT')
      if (typeof values.expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(values.expectedSha256)) return fail('FILE_REVISION_CONFLICT')
      if (!values.intent || typeof values.intent !== 'object' || Array.isArray(values.intent)) return fail('INVALID_ARGUMENT')
      const authorization = values.intent as Record<string, unknown>
      if (Object.keys(authorization).some(key => !['description', 'explicitUserAuthorization'].includes(key)) || authorization.explicitUserAuthorization !== undefined && typeof authorization.explicitUserAuthorization !== 'boolean') return fail('INVALID_ARGUMENT')
      if (name === 'edit_repository_text') result = await service.editText(values.destinationPath, values.expectedSha256, values.replacements as Array<{ oldText: string; newText: string }>, values.intent as FileMutationIntent)
      else {
        if ('text' in values && typeof values.text !== 'string') return fail('INVALID_ARGUMENT')
        result = await service.replaceFile(values.destinationPath, values.expectedSha256, { text: values.text as string | undefined, file: values.file as RepositoryFileDescriptor | undefined }, values.intent as FileMutationIntent)
      }
    }
    return { content: [{ type: 'text', text: JSON.stringify(result) }] }
  } catch (error) { return fail(error instanceof RepositoryFileEditingError ? error.code : 'WRITE_FAILED') }
}
