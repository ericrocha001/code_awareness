import type { McpToolDefinition, McpToolResult } from '../../mcp/channel-mcp-adapter'
import type { RuntimePreviewOperations } from './operations'
const text = { type: 'string', minLength: 1, maxLength: 128 }
const selection = { type: 'object', properties: { repositoryId: text, worktreeId: text, generation: text, profileId: text, fingerprint: { type: 'string', pattern: '^[a-f0-9]{64}$' } }, required: ['repositoryId', 'worktreeId', 'generation', 'profileId', 'fingerprint'], additionalProperties: false }
const session = { sessionId: { type: 'string', format: 'uuid' } }
const definitions = [
  ['prepare_branch_app', 'PREPARE_BRANCH_INTENT', 'Prepare one explicitly selected branch in the single hidden V5 slot under owner-approved repository trust and finite resource policy. Does not grant trust. Expired or invalid slots require new preparation.', { branch: { type: 'string', minLength: 1, maxLength: 512 }, operationId: { type: 'string', format: 'uuid' }, repositoryId: text, expectedHead: { type: 'string', pattern: '^[a-f0-9]{40}$' }, worktreeId: text }, ['branch', 'operationId']],
  ['run_branch_app', 'RUN_BRANCH_INTENT', 'Run an exact local branch through the same host-owned workflow as the UI. Stable operationId recovers this intention; native approval and preflight remain required. No checkout creation, install or fetch.', { branch: { type: 'string', minLength: 1, maxLength: 512 }, operationId: { type: 'string', format: 'uuid' }, repositoryId: text, expectedHead: { type: 'string', pattern: '^[a-f0-9]{40}$' }, worktreeId: text }, ['branch', 'operationId']],
  ['get_runtime_preview_status', 'STATUS', 'Read exactly one operationId OR sessionId as a compact snapshot, without probes or history. READY invites human review and never means feature VALIDATED. UNKNOWN requires explicit reconciliation.', { operationId: { type: 'string', format: 'uuid' }, ...session }, []],
  ['list_runtime_preview_profiles', 'PROFILES', 'List fixed preview profiles and approval revisions for an explicit managed repository.', { repositoryId: text }, ['repositoryId']],
  ['list_runtime_preview_worktrees', 'WORKTREES', 'List managed Worktree identities without activating a project or indexing its code.', { repositoryId: text }, ['repositoryId']],
  ['preflight_runtime_preview', 'PREFLIGHT', 'Read-only compatibility checks; UNKNOWN is never presumed compatible. Reports missing security guarantees and legitimate resolutions.', { selection }, ['selection']],
  ['authorize_runtime_preview_profile', 'AUTHORIZE', 'Request native operator approval of one exact profile revision. Cannot reduce security requirements or launch the application.', { selection }, ['selection']],
  ['start_runtime_preview', 'START', 'Start one approved fixed profile idempotently. Returns pending operationId; consult session list. No commands, cwd or flags accepted.', { selection, operationId: { type: 'string', format: 'uuid' } }, ['selection', 'operationId']],
  ['list_runtime_previews', 'LIST', 'Read bounded operational history without idle probes. Historical receipts are not current app readiness or feature validation.', { repositoryId: text, worktreeId: text, cursor: { type: 'string', format: 'uuid' }, limit: { type: 'integer', minimum: 1, maximum: 20 } }, ['repositoryId']],
  ['inspect_runtime_preview', 'INSPECT', 'Observe one session with current identity, readiness and independent evidence coverage. READY does not mean feature VALIDATED.', session, ['sessionId']],
  ['probe_runtime_preview', 'PROBE', 'Run the fixed coupled READINESS and ATTESTATION probes, both required to preserve endpoint attribution. No partial suite, free URLs, shell or evaluation.', { ...session, probes: { type: 'array', items: { type: 'string', enum: ['READINESS', 'ATTESTATION'] }, minItems: 2, maxItems: 2, uniqueItems: true } }, ['sessionId', 'probes']],
  ['read_runtime_preview_evidence', 'EVIDENCE', 'Read a bounded page of typed source, coverage or runtime facts. Never reads logs, credentials, tokens, paths or arbitrary files.', { ...session, revision: { type: 'integer', minimum: 0, maximum: 255 }, section: { type: 'string', enum: ['COVERAGE', 'SOURCE', 'RUNTIME'] }, offset: { type: 'integer', minimum: 0, maximum: 64 }, limit: { type: 'integer', minimum: 1, maximum: 16 } }, ['sessionId', 'section']],
  ['list_runtime_preview_bindings', 'BINDINGS', 'List certified current Continuum execution bindings for the selected session Worktree. Missing repository context remains explicit.', session, ['sessionId']],
  ['qualify_runtime_preview', 'QUALIFY', 'Link an existing Ledger behavioral proof and certified execution binding. Requires exact checkout/source/session/criterion identity and complete artifact coverage before PASSED.', { ...session, bindingId: text, proofId: text, criterionId: text }, ['sessionId', 'bindingId', 'proofId', 'criterionId']],
  ['stop_runtime_preview', 'STOP', 'Stop only the explicitly identified session. Returns pending completion until convergent process/resource evidence confirms cleanup. No stop-all.', session, ['sessionId']]
] as const
const outputSchema = { type: 'object', properties: { success: { type: 'boolean' }, code: { type: 'string' }, data: { type: 'object', properties: { kind: { type: 'string', enum: ['STATUS', 'PROFILES', 'WORKTREES', 'PREFLIGHT', 'SESSION', 'SESSIONS', 'EVIDENCE', 'BINDINGS', 'QUALIFICATION'] } }, required: ['kind'], additionalProperties: true } }, required: ['success'], additionalProperties: false, oneOf: [{ properties: { success: { const: true } }, required: ['data'] }, { properties: { success: { const: false } }, required: ['code'] }] }
export const RUNTIME_PREVIEW_TOOLS: McpToolDefinition[] = definitions.map(([name, action, description, properties, required]) => ({ name, description, inputSchema: { type: 'object', properties, required: [...required], additionalProperties: false, ...(action === 'STATUS' ? { oneOf: [{ required: ['operationId'], not: { required: ['sessionId'] } }, { required: ['sessionId'], not: { required: ['operationId'] } }] } : {}) }, outputSchema, securitySchemes: [{ type: 'oauth2', scopes: [] }], annotations: { readOnlyHint: ['STATUS', 'PROFILES', 'WORKTREES', 'PREFLIGHT', 'LIST', 'EVIDENCE', 'BINDINGS'].includes(action), destructiveHint: false, idempotentHint: true, openWorldHint: false } }))
export async function executeRuntimePreviewTool(service: RuntimePreviewOperations, name: string, args: unknown, guard: () => void): Promise<McpToolResult> {
  const definition = definitions.find(value => value[0] === name)
  if (!definition || !args || typeof args !== 'object' || Array.isArray(args) || 'action' in args) { const result = { success: false, code: 'INVALID_ARGUMENT' }; return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: true } }
  if (definition[1] === 'RUN_BRANCH_INTENT' || definition[1] === 'PREPARE_BRANCH_INTENT' || definition[1] === 'STATUS') {
    guard()
    const result = definition[1] === 'STATUS' ? await service.getStatus(args) : await service.runBranchApp(args, guard, definition[1] === 'PREPARE_BRANCH_INTENT')
    guard()
    return { content: [], structuredContent: result, ...(result.success ? {} : { isError: true }) }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<{ success: false; code: string }>(resolve => { timer = setTimeout(() => resolve({ success: false, code: 'PREVIEW_REQUEST_IN_PROGRESS' }), 10000) })
  const result = await Promise.race([service.handle({ ...args, action: definition[1] }, guard), timeout]).finally(() => clearTimeout(timer))
  if (result.success && ['START', 'STOP'].includes(definition[1])) {
    const status = await service.getStatus(definition[1] === 'STOP' ? { sessionId: (args as { sessionId: string }).sessionId } : { operationId: (args as { operationId: string }).operationId })
    return { content: [], structuredContent: status, ...(status.success ? {} : { isError: true }) }
  }
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, ...(result.success ? {} : { isError: true }) }
}
