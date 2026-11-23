import type { McpToolDefinition, McpToolResult } from '../mcp/mcp-types'
import {
  inspectIntelligenceEvidence,
  ProjectionError,
  SUPPORTED_PROJECTION_QUESTION_IDS,
  type EvidenceProjectionPorts
} from './projections'

const hex64 = { type: 'string', pattern: '^[a-f0-9]{64}$' }
const uuid = { type: 'string', format: 'uuid' }
const shortId = { type: 'string', minLength: 1, maxLength: 200 }

export const INSPECT_INTELLIGENCE_EVIDENCE_TOOL: McpToolDefinition = {
  name: 'inspect_intelligence_evidence',
  description: 'Read-only on-demand investigative evidence projection for a selected questionId (supported initial subset: Q05, Q19, Q06, Q23, Q09, Q16, Q20, Q21, Q26) and one explicit discriminating target (sessionId, nativeSession, entireSession for Q26, or relation). Composes bounded facts, provenance classes, coverage gaps, and literal deepen selectors from existing authorities without evaluating conclusions, calling another model, scanning the corpus, or modifying stores.',
  inputSchema: {
    type: 'object',
    properties: {
      questionId: {
        type: 'string',
        minLength: 1,
        maxLength: 16,
        description: `Canonical question ID (supported initial projections: ${SUPPORTED_PROJECTION_QUESTION_IDS.join(', ')}).`
      },
      target: {
        type: 'object',
        description: 'Explicit discriminating target. Provide exactly one of sessionId, nativeSession, entireSession (Q26 only), or relation.',
        properties: {
          sessionId: uuid,
          nativeSession: {
            type: 'object',
            properties: {
              provider: { type: 'string', enum: ['codex-native', 'antigravity-native'] },
              id: hex64,
              worktreeId: hex64,
              generation: hex64
            },
            required: ['provider', 'id'],
            additionalProperties: false
          },
          sourceSessionId: {
            ...uuid,
            description: 'Authorized original provider session UUID for literal source events; requires nativeSession with paired worktreeId and generation.'
          },
          entireSession: {
            type: 'object',
            description: 'Live Entire session target (supported for Q26 only).',
            properties: {
              providerSessionId: shortId,
              worktreeId: hex64,
              generation: hex64
            },
            required: ['providerSessionId', 'worktreeId', 'generation'],
            additionalProperties: false
          },
          relation: {
            type: 'object',
            description: 'Explicit engineering relation selector. Resolves candidates without proximity guessing.',
            properties: {
              type: { type: 'string', enum: ['ARTIFACT', 'EXECUTION', 'COMMIT', 'PR', 'CHECKPOINT', 'PROOF'] },
              id: shortId,
              revision: { type: 'integer', minimum: 1 }
            },
            required: ['type', 'id'],
            additionalProperties: false
          }
        },
        additionalProperties: false
      },
      repositoryId: {
        type: 'string',
        minLength: 1,
        maxLength: 160,
        description: 'Optional active repository ID check.'
      },
      expectedCatalogVersion: {
        type: 'integer',
        minimum: 1,
        description: 'Optional expected catalog version (current: 1).'
      },
      expectedRevision: {
        type: 'integer',
        minimum: 1,
        description: 'Optional expected projection revision for CAS drift detection.'
      },
      includeEntireUsage: {
        type: 'boolean',
        default: false,
        description: 'Opt-in for Q26 only to read ENTIRE_REPORTED aggregate session usage.'
      },
      skillId: {
        ...shortId,
        description: 'Optional canonical skillId filter for Q20/Q21 without scanning the catalog.'
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 15,
        default: 10
      },
      cursor: {
        type: 'string',
        maxLength: 512
      }
    },
    required: ['questionId', 'target'],
    additionalProperties: false
  },
  securitySchemes: [{ type: 'oauth2', scopes: [] }],
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  }
}

export async function executeInspectIntelligenceEvidence(
  args: unknown,
  ports: EvidenceProjectionPorts
): Promise<McpToolResult> {
  try {
    const result = await inspectIntelligenceEvidence(args, ports)
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }]
    }
  } catch (error) {
    if (error instanceof ProjectionError) {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: JSON.stringify({ code: error.code, ...(error.details ?? {}) })
        }]
      }
    }
    const code = error instanceof Error && /^[A-Z_]+$/.test(error.message)
      ? error.message
      : 'INTELLIGENCE_PROJECTION_UNAVAILABLE'
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ code }) }]
    }
  }
}
