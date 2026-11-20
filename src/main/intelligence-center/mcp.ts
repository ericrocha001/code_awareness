import { z } from 'zod'
import type { McpToolDefinition, McpToolResult } from '../mcp/mcp-types'
import {
  ACQUISITION_CHANNELS,
  COMMON_EVALUATION_PROTOCOL,
  EVIDENCE_EVALUATION_CATALOG_VERSION,
  EVIDENCE_EVALUATION_CONTRACTS,
  EVIDENCE_EVALUATION_SPECIFICATION,
  INTELLIGENCE_SPECIALIZATIONS,
  getEvidenceEvaluationContractById
} from './catalog'

const contractQuerySchema = z.object({
  questionId: z.string().min(1).max(16).optional(),
  specialization: z.enum(INTELLIGENCE_SPECIALIZATIONS).optional(),
  expectedCatalogVersion: z.number().int().min(1).optional()
}).strict()

export const GET_EVIDENCE_EVALUATION_CONTRACT_TOOL: McpToolDefinition = {
  name: 'get_evidence_evaluation_contract',
  description: 'Read-only lookup of versioned Evidence Evaluation question contracts (Q01-Q29, catalog v1) and the shared assisted evaluation protocol. Supplies evaluation criteria and relevant acquisition channel families only; never evaluates sessions, invokes an LLM, opens stores, or fetches facts automatically. Omit questionId for a compact id/question index (optionally filtered by specialization); provide questionId for the single selected contract.',
  inputSchema: {
    type: 'object',
    properties: {
      questionId: {
        type: 'string',
        minLength: 1,
        maxLength: 16,
        description: 'Canonical question ID (Q01-Q29). Omit to retrieve only catalog version and compact id/question index.'
      },
      specialization: {
        type: 'string',
        enum: [...INTELLIGENCE_SPECIALIZATIONS],
        description: 'Optional Intelligence specialization filter for index discovery, or consistency check when paired with questionId.'
      },
      expectedCatalogVersion: {
        type: 'integer',
        minimum: 1,
        description: 'Optional expected catalog version (current: 1). Returns CATALOG_VERSION_CONFLICT if incompatible.'
      }
    },
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

function errorResult(payload: Record<string, unknown>): McpToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(payload) }]
  }
}

export function executeGetEvidenceEvaluationContract(args: unknown): McpToolResult {
  const parsed = contractQuerySchema.safeParse(args ?? {})
  if (!parsed.success) {
    return errorResult({
      code: 'INVALID_ARGUMENT',
      message: 'Invalid Evidence Evaluation contract query arguments'
    })
  }

  const { questionId, specialization, expectedCatalogVersion } = parsed.data
  if (expectedCatalogVersion !== undefined && expectedCatalogVersion !== EVIDENCE_EVALUATION_CATALOG_VERSION) {
    return errorResult({
      code: 'CATALOG_VERSION_CONFLICT',
      expectedCatalogVersion,
      currentCatalogVersion: EVIDENCE_EVALUATION_CATALOG_VERSION
    })
  }

  if (questionId !== undefined) {
    const selected = getEvidenceEvaluationContractById(questionId)
    if (!selected) {
      return errorResult({
        code: 'CONTRACT_NOT_FOUND',
        questionId,
        catalogVersion: EVIDENCE_EVALUATION_CATALOG_VERSION
      })
    }

    if (specialization !== undefined && !selected.specializations.includes(specialization)) {
      return errorResult({
        code: 'CONTRADICTORY_QUERY',
        questionId: selected.id,
        requestedSpecialization: specialization,
        contractSpecializations: selected.specializations
      })
    }

    const { acquisitionChannels, ...contract } = selected
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          catalogVersion: EVIDENCE_EVALUATION_CATALOG_VERSION,
          specification: EVIDENCE_EVALUATION_SPECIFICATION,
          contract,
          acquisition: {
            channels: acquisitionChannels.map(channelId => ACQUISITION_CHANNELS[channelId]),
            coverageNotice: 'Contract availability does not imply source coverage is READY. Verify channel availability and coverage during acquisition; do not activate unauthorized sources.'
          },
          evaluationProtocol: COMMON_EVALUATION_PROTOCOL
        })
      }]
    }
  }

  const filtered = specialization
    ? EVIDENCE_EVALUATION_CONTRACTS.filter(entry => entry.specializations.includes(specialization))
    : EVIDENCE_EVALUATION_CONTRACTS

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        catalogVersion: EVIDENCE_EVALUATION_CATALOG_VERSION,
        specification: EVIDENCE_EVALUATION_SPECIFICATION,
        ...(specialization ? { specialization } : { specializations: INTELLIGENCE_SPECIALIZATIONS }),
        questions: filtered.map(entry => ({
          id: entry.id,
          question: entry.question,
          specializations: entry.specializations
        }))
      })
    }]
  }
}
