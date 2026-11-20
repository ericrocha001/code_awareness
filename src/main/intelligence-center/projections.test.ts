import { describe, expect, it, vi } from 'vitest'
import { authenticatedAgentPrincipal, authorizeArtifactAgent } from '../continuum/agent-authority'
import { ChannelMcpAdapter } from '../mcp/channel-mcp-adapter'
import type { ChannelUsagePort } from '../mcp/channel-usage-types'
import type { McpToolResult } from '../mcp/mcp-types'
import type { SessionContextPort, SessionToolName } from '../session-context/mcp'
import { INSPECT_INTELLIGENCE_EVIDENCE_TOOL } from './evidence-mcp'
import { inspectIntelligenceEvidence, ProjectionError, type EvidenceProjectionPorts } from './projections'

const okJson = (data: unknown): McpToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data) }] })
const errJson = (data: unknown): McpToolResult => ({ isError: true, content: [{ type: 'text', text: JSON.stringify(data) }] })

const WT = 'a'.repeat(64)
const GEN = 'b'.repeat(64)
const S_HASH = 'c'.repeat(64)
const S_UUID = '01a1e000-0000-7000-8000-000000000301'
const ART_ID = 'artifact-11111111-2222-4333-8444-555555555555'

function makePorts(
  callImpl: (name: SessionToolName, args: unknown, allowMeta?: boolean) => Promise<McpToolResult>,
  overrides: Partial<EvidenceProjectionPorts> = {}
): EvidenceProjectionPorts {
  return {
    repositoryId: 'repo-1',
    sessionContext: { call: callImpl },
    allowArtifactMetadata: true,
    assertSourceAuthorized: () => {},
    assertCurrent: () => {},
    ...overrides
  }
}

async function expectErrorCode(fn: Promise<unknown>, code: string) {
  try {
    await fn
    throw new Error(`Expected ProjectionError(${code})`)
  } catch (err) {
    expect(err).toBeInstanceOf(ProjectionError)
    expect((err as ProjectionError).code).toBe(code)
  }
}

describe('Intelligence projections — contracts, discrimination, cursor & U3 gates', () => {
  it('rejects conflicting targets, invalid params, unsupported questions, and repository mismatches', async () => {
    const call = vi.fn<SessionContextPort['call']>(async () => okJson({}))
    const ports = makePorts(call)

    await expectErrorCode(inspectIntelligenceEvidence({
      questionId: 'Q05',
      target: { sessionId: S_UUID, nativeSession: { provider: 'codex-native', id: S_HASH } }
    }, ports), 'CONFLICTING_TARGET')

    await expectErrorCode(inspectIntelligenceEvidence({
      questionId: 'Q05',
      target: { sourceSessionId: S_UUID }
    }, ports), 'INVALID_ARGUMENT')

    await expectErrorCode(inspectIntelligenceEvidence({
      questionId: 'Q05',
      target: { nativeSession: { provider: 'codex-native', id: S_HASH }, sourceSessionId: S_UUID }
    }, ports), 'ORIGIN_UNVERIFIED')

    await expectErrorCode(inspectIntelligenceEvidence({
      questionId: 'Q05',
      target: { entireSession: { providerSessionId: 'e-1', worktreeId: WT, generation: GEN } }
    }, ports), 'UNSUPPORTED_TARGET_FOR_QUESTION')

    await expectErrorCode(inspectIntelligenceEvidence({
      questionId: 'Q05',
      includeEntireUsage: true,
      target: { sessionId: S_UUID }
    }, ports), 'INVALID_ARGUMENT')

    await expectErrorCode(inspectIntelligenceEvidence({
      questionId: 'Q01',
      target: { sessionId: S_UUID }
    }, ports), 'PROJECTION_UNSUPPORTED')

    await expectErrorCode(inspectIntelligenceEvidence({
      questionId: 'Q99',
      target: { sessionId: S_UUID }
    }, ports), 'CONTRACT_NOT_FOUND')

    await expectErrorCode(inspectIntelligenceEvidence({
      questionId: 'Q05',
      expectedCatalogVersion: 2,
      target: { sessionId: S_UUID }
    }, ports), 'CATALOG_VERSION_CONFLICT')

    await expectErrorCode(inspectIntelligenceEvidence({
      questionId: 'Q05',
      repositoryId: 'other-repo',
      target: { sessionId: S_UUID }
    }, ports), 'REPOSITORY_NOT_AUTHORIZED')

    expect(call).not.toHaveBeenCalled()
  })

  it('distinguishes verified identical call+result digest repetitions from distinct controls and candidate-only observations in Q16/Q09', async () => {
    const events = [
      // Proven identical reread (call1+res1 == call2+res2)
      { eventId: 'e1', ordinal: 1, type: 'TOOL_CALL', tool: 'read_file', turnId: 't1', status: 'SUCCESS', pairing: 'PAIRED', bytes: 20, payloadDigest: 'd-call-same' },
      { eventId: 'e2', ordinal: 2, type: 'TOOL_RESULT', tool: 'read_file', turnId: 't1', status: 'SUCCESS', pairing: 'PAIRED', bytes: 50, payloadDigest: 'd-res-same' },
      { eventId: 'e3', ordinal: 3, type: 'TOOL_CALL', tool: 'read_file', turnId: 't2', status: 'SUCCESS', pairing: 'PAIRED', bytes: 20, payloadDigest: 'd-call-same' },
      { eventId: 'e4', ordinal: 4, type: 'TOOL_RESULT', tool: 'read_file', turnId: 't2', status: 'SUCCESS', pairing: 'PAIRED', bytes: 50, payloadDigest: 'd-res-same' },
      // Distinct control (same tool, different call digest)
      { eventId: 'e5', ordinal: 5, type: 'TOOL_CALL', tool: 'read_file', turnId: 't3', status: 'SUCCESS', pairing: 'PAIRED', bytes: 22, payloadDigest: 'd-call-other' },
      { eventId: 'e6', ordinal: 6, type: 'TOOL_RESULT', tool: 'read_file', turnId: 't3', status: 'SUCCESS', pairing: 'PAIRED', bytes: 60, payloadDigest: 'd-res-other' },
      // Candidate-only (dangling / unpaired tool call without result)
      { eventId: 'e7', ordinal: 7, type: 'TOOL_CALL', tool: 'grep_search', turnId: 't4', status: 'DANGLING', pairing: 'DANGLING', bytes: 15, payloadDigest: 'd-grep-1' },
      { eventId: 'e8', ordinal: 8, type: 'TOOL_CALL', tool: 'grep_search', turnId: 't4', status: 'DANGLING', pairing: 'DANGLING', bytes: 15, payloadDigest: 'd-grep-2' }
    ]

    let currentRev = 7
    const ports = makePorts(async (name) => {
      if (name === 'inspect_agent_session') {
        return okJson({ revision: currentRev, source: 'NATIVE_SOURCE', provider: 'codex-native', contentAvailability: 'READY' })
      }
      if (name === 'list_agent_session_events') {
        return okJson({ events })
      }
      return errJson({ code: 'UNEXPECTED' })
    })

    const page1 = await inspectIntelligenceEvidence({
      questionId: 'Q16',
      limit: 1,
      target: { nativeSession: { provider: 'codex-native', id: S_HASH, worktreeId: WT, generation: GEN }, sourceSessionId: S_UUID }
    }, ports) as any

    expect(page1.provenRepetitionCount).toBe(1)
    expect(page1.candidateCount).toBe(1)
    expect(page1.repetitions).toHaveLength(1)
    expect(page1.repetitions[0].isProvenReread).toBe(true)
    expect(page1.repetitions[0].equivalenceProof).toBe('VERIFIED_CALL_AND_RESULT_DIGEST')
    expect(page1.repetitions[0].count).toBe(2)
    expect(page1.pagination.nextCursor).toBeDefined()

    const page2 = await inspectIntelligenceEvidence({
      questionId: 'Q16',
      limit: 1,
      cursor: page1.pagination.nextCursor,
      target: { nativeSession: { provider: 'codex-native', id: S_HASH, worktreeId: WT, generation: GEN }, sourceSessionId: S_UUID }
    }, ports) as any

    expect(page2.repetitions).toHaveLength(1)
    expect(page2.repetitions[0].isProvenReread).toBe(false)
    expect(page2.repetitions[0].equivalenceProof).toBe('CANDIDATE_TOOL_OR_CALL_ONLY')
    expect(page2.pagination.nextCursor).toBeUndefined()

    // Cursor scope mismatch rejected
    await expectErrorCode(inspectIntelligenceEvidence({
      questionId: 'Q09',
      limit: 1,
      cursor: page1.pagination.nextCursor,
      target: { nativeSession: { provider: 'codex-native', id: S_HASH, worktreeId: WT, generation: GEN }, sourceSessionId: S_UUID }
    }, ports), 'CURSOR_SCOPE_MISMATCH')

    // Drift / revision conflict rejected
    currentRev = 8
    await expectErrorCode(inspectIntelligenceEvidence({
      questionId: 'Q16',
      limit: 1,
      cursor: page1.pagination.nextCursor,
      target: { nativeSession: { provider: 'codex-native', id: S_HASH, worktreeId: WT, generation: GEN }, sourceSessionId: S_UUID }
    }, ports), 'REVISION_CONFLICT')
  })

  it('handles ambiguous and unresolved relations without proximity fallback', async () => {
    const ambiguousPorts = makePorts(async (name) => {
      if (name === 'discover_execution_context') {
        return okJson({
          revision: 'rev-1',
          coverage: { state: 'PARTIAL' },
          sourceCoverage: [],
          nodes: [],
          edges: []
        })
      }
      if (name === 'list_agent_sessions') {
        return okJson({
          sessions: [
            { sessionId: S_UUID, provider: 'entire' },
            { provider: 'codex-native', providerSessionId: S_HASH, worktrees: [{ worktreeId: WT, generation: GEN }] }
          ]
        })
      }
      return okJson({})
    })

    const amb = await inspectIntelligenceEvidence({
      questionId: 'Q05',
      target: { relation: { type: 'ARTIFACT', id: ART_ID } }
    }, ambiguousPorts) as any
    expect(amb.resolution).toBe('AMBIGUOUS')
    expect(amb.candidates).toHaveLength(2)

    const unresolvedPorts = makePorts(async (name) => {
      if (name === 'discover_execution_context') {
        return okJson({ revision: 'rev-2', coverage: { state: 'UNKNOWN' }, sourceCoverage: [], nodes: [], edges: [], discovery: { reason: 'NO_INDEXED_EDGE' } })
      }
      return okJson({ sessions: [] })
    })

    const unres = await inspectIntelligenceEvidence({
      questionId: 'Q05',
      target: { relation: { type: 'ARTIFACT', id: ART_ID } }
    }, unresolvedPorts) as any
    expect(unres.resolution).toBe('UNRESOLVED')
    expect(unres.gaps).toContain('NO_INDEXED_EDGE')
  })

  it('Academy Q20/Q21 refuses OBSERVADO without SkillEvents, labels Artifact declarations DECLARADO, and queries history selectively without academy.list', async () => {
    const historyMock = vi.fn(() => ({ skillId: 'worktree-execution', version: 39, packageHash: 'h-39', origin: 'LOCAL', createdAt: '2026-11-20T00:00:00Z' }))
    const listMock = vi.fn()
    const ports = makePorts(
      async (name) => name === 'discover_execution_context'
        ? okJson({ revision: 'r1', coverage: { state: 'SELECTED_SCOPE' }, sourceCoverage: [], nodes: [], edges: [] })
        : okJson({ sessions: [] }),
      {
        artifactReader: {
          list: vi.fn(),
          get: () => ({
            artifactId: ART_ID,
            revision: 2,
            metadata: { name: 'Handoff', kind: 'IMPLEMENTATION_HANDOFF', skillsUsed: [{ skillId: 'worktree-execution', version: 39, nature: 'used' }] },
            rawMarkdown: '',
            createdAt: '',
            updatedAt: '',
            contentHash: '',
            provenance: {}
          })
        },
        academy: { history: historyMock, list: listMock } as any
      }
    )

    const res = await inspectIntelligenceEvidence({
      questionId: 'Q20',
      target: { relation: { type: 'ARTIFACT', id: ART_ID } }
    }, ports) as any

    expect(res.evidence.supportState).toBe('PARTIAL_PENDING_METADATA')
    expect(res.evidence.skillEvents).toEqual([])
    expect(res.gaps).toContain('USE_NOT_OBSERVED')
    expect(res.evidence.declaredSkills).toEqual([
      { class: 'DECLARADO', sourceArtifactId: ART_ID, sourceRevision: 2, skillId: 'worktree-execution', version: 39, nature: 'used' }
    ])
    expect(res.evidence.historicalVersions).toHaveLength(1)
    expect(historyMock).toHaveBeenCalledWith('worktree-execution', { version: 39 })
    expect(listMock).not.toHaveBeenCalled()
  })

  it('Model Q26 keeps usage opt-in, separates SESSION_LEVEL from PER_CALL, and reports missing metadata honestly', async () => {
    const callSpy = vi.fn<SessionContextPort['call']>(async (name) => {
      if (name === 'inspect_entire_session') {
        return okJson({ source: 'ENTIRE_LIVE', providerSessionId: 'ent-1', model: 'claude-sonnet-4', turns: 3 })
      }
      if (name === 'get_entire_session_usage') {
        return okJson({ dataSource: 'ENTIRE_REPORTED', coverage: 'COMPLETE', billingCoverage: 'UNAVAILABLE', metrics: { input: 100, output: 50, total: 150, apiCalls: 2 } })
      }
      return okJson({})
    })

    const withoutUsage = await inspectIntelligenceEvidence({
      questionId: 'Q26',
      target: { entireSession: { providerSessionId: 'ent-1', worktreeId: WT, generation: GEN } }
    }, makePorts(callSpy)) as any

    expect(withoutUsage.evidence.supportState).toBe('SESSION_LEVEL_ONLY')
    expect(withoutUsage.evidence.sessionLevelModel.model).toBe('claude-sonnet-4')
    expect(withoutUsage.evidence.perCallModels).toBeNull()
    expect(withoutUsage.evidence.usageAcquisition.optedIn).toBe(false)
    expect(callSpy).not.toHaveBeenCalledWith('get_entire_session_usage', expect.anything(), expect.anything())

    const withUsage = await inspectIntelligenceEvidence({
      questionId: 'Q26',
      includeEntireUsage: true,
      target: { entireSession: { providerSessionId: 'ent-1', worktreeId: WT, generation: GEN } }
    }, makePorts(callSpy)) as any

    expect(withUsage.evidence.reportedUsage.dataSource).toBe('ENTIRE_REPORTED')
    expect(withUsage.evidence.reportedUsage.metrics.total).toBe(150)
    expect(withUsage.gaps).toContain('PER_CALL_MODEL_UNAVAILABLE')
    expect(withUsage.gaps).toContain('EFFORT_UNAVAILABLE')

    const noEntire = await inspectIntelligenceEvidence({
      questionId: 'Q26',
      target: { nativeSession: { provider: 'codex-native', id: S_HASH } }
    }, makePorts(async () => okJson({}))) as any
    expect(noEntire.evidence.supportState).toBe('PARTIAL_PENDING_METADATA')
    expect(noEntire.gaps).toContain('ENTIRE_LIVE_SESSION_NOT_LINKED_OR_UNAVAILABLE')
  })

  it('enforces ChannelMcpAdapter repository attribution and sourceSessionId authority guards', async () => {
    const usage: ChannelUsagePort = { complete: vi.fn(), catalog: vi.fn(), query: vi.fn(async () => ({ calls: 0 })) }
    const adapter = new ChannelMcpAdapter({
      projectId: 'p1',
      repoRoot: '/repo',
      navigation: {} as any,
      continuum: { repositoryId: 'repo-auth' } as any,
      sessionContext: {
        call: async (name) => name === 'inspect_agent_session'
          ? okJson({ revision: 1, source: 'NATIVE_SOURCE', provider: 'codex-native', contentAvailability: 'READY' })
          : okJson({ events: [] })
      }
    })
    adapter.setUsage(usage)

    expect(adapter.listTools().some(t => t.name === INSPECT_INTELLIGENCE_EVIDENCE_TOOL.name)).toBe(true)
    expect(adapter.capabilityForTool(INSPECT_INTELLIGENCE_EVIDENCE_TOOL.name)).toBe('Intelligence Center')

    // Unauthenticated caller with sourceSessionId must fail SOURCE_NOT_AUTHORIZED
    const unauth = await adapter.callTool(INSPECT_INTELLIGENCE_EVIDENCE_TOOL.name, {
      questionId: 'Q05',
      target: { nativeSession: { provider: 'codex-native', id: S_HASH, worktreeId: WT, generation: GEN }, sourceSessionId: S_UUID }
    })
    expect(unauth.isError).toBe(true)
    expect(JSON.parse((unauth.content[0] as { text: string }).text).code).toBe('SOURCE_NOT_AUTHORIZED')

    const principal = authenticatedAgentPrincipal('MCP', () => true)
    const authority = authorizeArtifactAgent(principal, 'repo-auth', () => true)
    const authRes = await adapter.callTool(INSPECT_INTELLIGENCE_EVIDENCE_TOOL.name, {
      questionId: 'Q05',
      target: { nativeSession: { provider: 'codex-native', id: S_HASH, worktreeId: WT, generation: GEN }, sourceSessionId: S_UUID }
    }, undefined, authority)
    expect(authRes.isError).toBeUndefined()
    expect(usage.complete).toHaveBeenCalledWith(expect.objectContaining({
      name: 'inspect_intelligence_evidence',
      capability: 'Intelligence Center',
      repositoryId: 'repo-auth',
      status: 'success'
    }))
  })
})
