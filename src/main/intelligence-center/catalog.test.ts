import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { ChannelMcpAdapter } from '../mcp/channel-mcp-adapter'
import { textContent } from '../mcp/mcp-test-content'
import type { McpMultimodalToolResult } from '../mcp/mcp-types'
import type { ChannelUsagePort } from '../mcp/channel-usage-types'
import {
  ACQUISITION_CHANNELS,
  COMMON_EVALUATION_PROTOCOL,
  EVIDENCE_EVALUATION_CATALOG_VERSION,
  EVIDENCE_EVALUATION_CONTRACTS,
  EVIDENCE_EVALUATION_SPECIFICATION,
  INTELLIGENCE_SPECIALIZATIONS
} from './catalog'
import { GET_EVIDENCE_EVALUATION_CONTRACT_TOOL, executeGetEvidenceEvaluationContract } from './mcp'

const SPEC_REV3_Q01_TO_Q29_SHA256 = 'f9ee944e52c820cc8b74e4bb001c784d8b0deb15f7521a4c852000e4d08cf217'
const decode = (result: McpMultimodalToolResult) => JSON.parse(textContent(result.content[0]))

describe('Evidence Evaluation catalog and static contract lookup', () => {
  it('preserves Q01-Q29 catalog v1 verbatim against Living Artifact rev3 with immutable entries', () => {
    expect(EVIDENCE_EVALUATION_CATALOG_VERSION).toBe(1)
    expect(EVIDENCE_EVALUATION_SPECIFICATION).toEqual({
      artifactId: 'artifact-3fdc4491-97c0-48f4-ad45-6a3707859b12',
      revision: 3
    })
    expect(Object.isFrozen(EVIDENCE_EVALUATION_CONTRACTS)).toBe(true)
    expect(Object.isFrozen(COMMON_EVALUATION_PROTOCOL)).toBe(true)
    expect(Object.isFrozen(ACQUISITION_CHANNELS)).toBe(true)
    expect(EVIDENCE_EVALUATION_CONTRACTS).toHaveLength(29)

    const expectedIds = Array.from({ length: 29 }, (_, idx) => `Q${String(idx + 1).padStart(2, '0')}`)
    expect(EVIDENCE_EVALUATION_CONTRACTS.map(c => c.id)).toEqual(expectedIds)

    const specDigest = createHash('sha256')
      .update(JSON.stringify(EVIDENCE_EVALUATION_CONTRACTS.map(c => ({
        id: c.id,
        question: c.question,
        requiredEvidence: c.requiredEvidence,
        conclusionCriteria: c.conclusionCriteria,
        indeterminacyCondition: c.indeterminacyCondition,
        action: c.action
      }))))
      .digest('hex')
    expect(specDigest).toBe(SPEC_REV3_Q01_TO_Q29_SHA256)

    for (const specialization of INTELLIGENCE_SPECIALIZATIONS) {
      expect(EVIDENCE_EVALUATION_CONTRACTS.some(c => c.specializations.includes(specialization))).toBe(true)
    }
    for (const contract of EVIDENCE_EVALUATION_CONTRACTS) {
      expect(Object.isFrozen(contract)).toBe(true)
      expect(contract.specializations.length).toBeGreaterThan(0)
      expect(contract.acquisitionChannels.length).toBeGreaterThan(0)
      for (const ch of contract.acquisitionChannels) {
        expect(ACQUISITION_CHANNELS[ch]).toBeDefined()
      }
    }
  })

  it('returns compact index without loading contracts/protocol when questionId is omitted, and filters by specialization', () => {
    const allIndex = decode(executeGetEvidenceEvaluationContract({}))
    expect(allIndex.catalogVersion).toBe(1)
    expect(allIndex.specification).toEqual(EVIDENCE_EVALUATION_SPECIFICATION)
    expect(allIndex.specializations).toEqual(INTELLIGENCE_SPECIALIZATIONS)
    expect(allIndex.questions).toHaveLength(29)
    expect(allIndex.evaluationProtocol).toBeUndefined()
    expect(allIndex.acquisition).toBeUndefined()
    for (const item of allIndex.questions) {
      expect(Object.keys(item).sort()).toEqual(['id', 'question', 'specializations'])
    }

    const academyIndex = decode(executeGetEvidenceEvaluationContract({ specialization: 'ACADEMY' }))
    expect(academyIndex.specialization).toBe('ACADEMY')
    expect(academyIndex.questions.map((q: { id: string }) => q.id)).toEqual(['Q20', 'Q21', 'Q22'])
  })

  it('returns only the selected contract, relevant channel families, and shared evaluation protocol on direct questionId lookup', () => {
    const res = executeGetEvidenceEvaluationContract({ questionId: 'Q23', expectedCatalogVersion: 1 })
    expect(res.isError).toBeUndefined()
    const payload = decode(res)
    expect(payload.catalogVersion).toBe(1)
    expect(payload.contract.id).toBe('Q23')
    expect(payload.contract.conclusionCriteria).toContain('HARNESS, MODELO, COMBINADA, OUTRA ou INDETERMINADO')
    expect(payload.contract.indeterminacyCondition).toContain('não forçar atribuição binária')
    expect(payload.acquisition.channels.map((c: { id: string }) => c.id)).toEqual([
      'SESSION_CONTEXT',
      'REPORTED_USAGE',
      'ACADEMY',
      'CONTINUUM'
    ])
    expect(payload.acquisition.coverageNotice).toContain('does not imply source coverage is READY')
    expect(payload.evaluationProtocol.evaluatorRole).toBe('INVESTIGATING_AGENT')
    expect(payload.evaluationProtocol.steps).toHaveLength(5)
    expect(payload.evaluationProtocol.outputStructure.evidenceClasses).toEqual([
      'OBSERVADO',
      'DERIVADO',
      'AVALIAÇÃO',
      'HIPÓTESE'
    ])
    expect(payload.questions).toBeUndefined()
  })

  it('refuses incompatible catalog versions, invalid IDs, contradictory filters, and unexpected arguments without fallback', () => {
    const conflict = executeGetEvidenceEvaluationContract({ questionId: 'Q23', expectedCatalogVersion: 2 })
    expect(conflict.isError).toBe(true)
    expect(decode(conflict)).toMatchObject({
      code: 'CATALOG_VERSION_CONFLICT',
      expectedCatalogVersion: 2,
      currentCatalogVersion: 1
    })

    for (const badId of ['Q00', 'Q30', 'Q99', 'q23', 'unknown']) {
      const notFound = executeGetEvidenceEvaluationContract({ questionId: badId })
      expect(notFound.isError).toBe(true)
      expect(decode(notFound)).toMatchObject({ code: 'CONTRACT_NOT_FOUND', questionId: badId })
    }

    const contradictory = executeGetEvidenceEvaluationContract({ questionId: 'Q01', specialization: 'ACADEMY' })
    expect(contradictory.isError).toBe(true)
    expect(decode(contradictory)).toMatchObject({
      code: 'CONTRADICTORY_QUERY',
      questionId: 'Q01',
      requestedSpecialization: 'ACADEMY'
    })

    const badArg = executeGetEvidenceEvaluationContract({ extra: true })
    expect(badArg.isError).toBe(true)
    expect(decode(badArg).code).toBe('INVALID_ARGUMENT')
  })

  it('is repository-independent, requires no active Store/SessionContext, and keeps usage attribution global', async () => {
    const usage: ChannelUsagePort = { complete: vi.fn(), catalog: vi.fn(), query: vi.fn(async () => ({ calls: 0 })) }
    const sessionContextCall = vi.fn()
    const academyStub = { listSkills: vi.fn() } as any

    const globalOnly = ChannelMcpAdapter.createGlobalOnly(academyStub)
    expect(globalOnly.listTools().some(t => t.name === GET_EVIDENCE_EVALUATION_CONTRACT_TOOL.name)).toBe(true)
    expect(globalOnly.capabilityForTool(GET_EVIDENCE_EVALUATION_CONTRACT_TOOL.name)).toBe('Intelligence Center')

    const globalResult = await globalOnly.callTool(GET_EVIDENCE_EVALUATION_CONTRACT_TOOL.name, { questionId: 'Q06' })
    expect(globalResult.isError).toBeUndefined()
    expect(decode(globalResult).contract.id).toBe('Q06')

    const scopedAdapter = new ChannelMcpAdapter({
      projectId: 'proj-alpha',
      repoRoot: '/tmp/proj-alpha',
      navigation: {} as any,
      continuum: { repositoryId: 'repo-alpha' } as any,
      sessionContext: { call: sessionContextCall }
    })
    scopedAdapter.setUsage(usage)
    const scopedResult = await scopedAdapter.callTool(GET_EVIDENCE_EVALUATION_CONTRACT_TOOL.name, { questionId: 'Q23' })
    expect(scopedResult.isError).toBeUndefined()
    expect(sessionContextCall).not.toHaveBeenCalled()
    expect(usage.complete).toHaveBeenCalledWith(expect.objectContaining({
      name: 'get_evidence_evaluation_contract',
      capability: 'Intelligence Center',
      repositoryId: null,
      status: 'success'
    }))
  })
})
