import type { McpToolDefinition, McpToolResult } from '../mcp/mcp-types'
import { resolveEffectiveDeliveryContext } from '../../shared/types/delivery-context-types'
import type { AgentAuthority } from '../continuum/agent-authority'
import type { GitOperationsService } from '../git-operations/git-operations-service'
import { editWorktreeText } from './worktree-text-editing'

const nonEmptyString = { type: 'string', minLength: 1 }
const hex64 = { type: 'string', pattern: '^[a-f0-9]{64}$' }
const expectedHead = { type: ['string', 'null'], pattern: '^[a-f0-9]{40,64}$' }
const snapshot = {
  type: 'object',
  properties: {
    branch: { type: ['string', 'null'] },
    head: expectedHead,
    indexRevision: hex64,
    worktreeRevision: hex64,
    operation: { type: ['string', 'null'] }
  },
  required: ['branch', 'head', 'indexRevision', 'worktreeRevision', 'operation'],
  additionalProperties: false
}

const editChange = {
  type: 'object',
  properties: {
    operation: { type: 'string', enum: ['EDIT'] },
    path: nonEmptyString,
    expectedSha256: hex64,
    replacements: {
      type: 'array',
      minItems: 1,
      maxItems: 32,
      items: {
        type: 'object',
        properties: {
          oldText: { type: 'string', minLength: 1 },
          newText: { type: 'string' }
        },
        required: ['oldText', 'newText'],
        additionalProperties: false
      }
    }
  },
  required: ['operation', 'path', 'expectedSha256', 'replacements'],
  additionalProperties: false
}

const createChange = {
  type: 'object',
  properties: {
    operation: { type: 'string', enum: ['CREATE'] },
    path: nonEmptyString,
    text: { type: 'string' }
  },
  required: ['operation', 'path', 'text'],
  additionalProperties: false
}

export const WORKTREE_TEXT_EDITING_TOOLS: McpToolDefinition[] = [
  {
    name: 'edit_worktree_text',
    description: 'Autonomously edit existing UTF-8 source files and/or exclusively create new source files (1–16 distinct paths, aggregate payload <= 1 MiB) inside an eligible implementation worktree without manual approval or handoff. Use read_worktree_file for literal fileRevision (expectedSha256) and inspect_worktree for snapshot/generation. Coordinates automatically via the worktree transaction lock and refuses if an incompatible worktree ownership grant or Git operation is active. Preflight validates all items before any write; file commits are per-file and batches interrupted mid-flight return PARTIAL or UNKNOWN without blind rollback. Reuse the same operationId for replay/recovery. Does not stage, commit, delete, rename, handle binaries, or write AGENTS.md/ARCHITECT.md/protected paths. Returns focal unified diff <= 8 KiB; use get_worktree_diff for cumulative diffs.',
    inputSchema: {
      type: 'object',
      properties: {
        worktreeId: hex64,
        generation: hex64,
        leaseId: nonEmptyString,
        leaseCredential: hex64,
        operationId: { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$' },
        snapshot,
        intent: {
          type: 'object',
          properties: {
            description: { type: 'string', minLength: 1, maxLength: 1000 }
          },
          required: ['description'],
          additionalProperties: false
        },
        changes: {
          type: 'array',
          minItems: 1,
          maxItems: 16,
          items: { oneOf: [editChange, createChange] }
        }
      },
      required: ['worktreeId', 'generation', 'operationId', 'snapshot', 'intent', 'changes'],
      additionalProperties: false
    },
    securitySchemes: [{ type: 'oauth2', scopes: [] }],
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }
]

export async function executeWorktreeTextEditing(
  service: GitOperationsService,
  args: unknown,
  authority?: AgentAuthority
): Promise<McpToolResult> {
  const values = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {}
  const resolved = resolveEffectiveDeliveryContext(undefined, authority?.deliveryContext, authority?.deliveryContextError)
  if (!resolved.ok || (authority?.worktreeId && typeof values.worktreeId === 'string' && authority.worktreeId !== values.worktreeId)) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ code: 'DELIVERY_CONTEXT_INVALID', ...(!resolved.ok ? { reason: resolved.reason } : { reason: 'WORKTREE_SCOPE_CONFLICT' }) }) }],
      isError: true
    }
  }
  if (authority && (!authority.isActive() || !authority.principal.isActive())) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ code: 'AGENT_UNAUTHORIZED' }) }],
      isError: true
    }
  }
  return editWorktreeText(service, args, {
    ...(authority?.sessionWitness ? { sessionWitness: authority.sessionWitness } : {}),
    ...(authority ? {
      authority: {
        repositoryId: authority.repositoryId,
        transport: authority.principal.transport,
        ...(authority.worktreeId ? { worktreeId: authority.worktreeId } : {}),
        ...(authority.deliveryContext ? { deliveryContext: authority.deliveryContext } : {}),
        isActive: () => authority.isActive() && authority.principal.isActive()
      }
    } : {})
  })
}
