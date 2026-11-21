import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { authenticatedAgentPrincipal, authorizeArtifactAgent } from '../continuum/agent-authority'
import { ChannelMcpAdapter } from '../mcp/channel-mcp-adapter'
import { createMcpHttpServer } from '../mcp/mcp-http-server'
import type { McpProjectContext } from '../mcp/project-mcp-context'
import { executeSessionTool, type SessionToolName } from './mcp'
import { digest } from './privacy'
import { SessionStore } from './store'

const cleanup: Array<() => void | Promise<void>> = []

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

function safeRemove(dir: string) {
  execFileSync(
    'node',
    ['-e', "require('node:fs').rmSync(process.argv[1], { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })", dir],
    { windowsHide: true }
  )
}

describe('Model Intelligence Q26 semantics, non-truncating aggregation & public MCP HTTP/AJV acceptance', () => {
  it('enforces requested vs reported call authority, sums >200 call_delta rows without truncation, and enforces repo isolation over public MCP HTTP/AJV', async () => {
    const [{ Client }, { StreamableHTTPClientTransport }, { AjvJsonSchemaValidator }] = await Promise.all([
      import('@modelcontextprotocol/sdk/client'),
      import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
      import('@modelcontextprotocol/sdk/validation/ajv')
    ])

    const base = mkdtempSync(join(tmpdir(), 'mi-q26-http-'))
    cleanup.push(() => safeRemove(base))
    const root = join(base, 'repo')
    const storePath = join(base, 'store', 'session-context.sqlite')
    const repoId = 'repo-mi-q26-public'
    mkdirSync(root, { recursive: true })
    mkdirSync(dirname(storePath), { recursive: true })

    const store = new SessionStore(storePath, repoId)

    // (a) Requested-only turn selections (must NOT become OBSERVADO or perCall SUPPORTED)
    const { sessionId: reqSessionId } = store.ingest({
      providerSessionId: 'mi-req-only',
      providerVersion: '0.13.4',
      agent: 'codex',
      state: 'ENDED',
      endedAt: '2026-11-20T15:00:00.000Z',
      coverage: 'PARTIAL',
      importState: 'METADATA_ONLY',
      sourceDigest: digest('mi-req-only'),
      sourceBytes: 0
    }, [])
    store.modelIntelligence.recordFacts(reqSessionId, {
      modelFacts: [
        {
          scope: 'turn', scopeId: 'turn:1', ordinal: 1, sourceSurface: 'codex_native_jsonl',
          sourceVersion: '0.169.0-alpha.11.1', observability: 'requested', provider: 'openai',
          client: 'codex', model: 'gpt-5.4', effort: 'high', coverageStatus: 'COMPLETE'
        },
        {
          scope: 'turn', scopeId: 'turn:2', ordinal: 2, sourceSurface: 'codex_native_jsonl',
          sourceVersion: '0.169.0-alpha.11.1', observability: 'requested', provider: 'openai',
          client: 'codex', model: 'gpt-5.4-mini', effort: 'low', coverageStatus: 'COMPLETE'
        }
      ],
      usageFacts: [
        {
          usageScope: 'session_cumulative', scopeId: 'cum:2', ordinal: 2, sourceSurface: 'codex_native_jsonl',
          sourceVersion: '0.169.0-alpha.11.1', observability: 'reported',
          inputTokens: 200, cacheReadTokens: 0, outputTokens: 50, totalTokens: 250, coverageStatus: 'COMPLETE'
        }
      ]
    })

    // (b) Truly reported per-call observations with explicit IDs & reported switch
    const { sessionId: callSessionId } = store.ingest({
      providerSessionId: 'mi-call-rep',
      providerVersion: '0.13.4',
      agent: 'claude-code',
      state: 'ENDED',
      endedAt: '2026-11-20T16:00:00.000Z',
      coverage: 'COMPLETE',
      importState: 'METADATA_ONLY',
      sourceDigest: digest('mi-call-rep'),
      sourceBytes: 0
    }, [])
    store.modelIntelligence.recordFacts(callSessionId, {
      modelFacts: [
        {
          scope: 'call', scopeId: 'call:10', ordinal: 10, sourceSurface: 'entire_transcript_claude_code',
          sourceVersion: '0.13.4', observability: 'reported', provider: 'anthropic',
          client: 'claude-code', model: 'claude-sonnet-4-6', effort: 'medium', coverageStatus: 'COMPLETE'
        },
        {
          scope: 'call', scopeId: 'call:20', ordinal: 20, sourceSurface: 'entire_transcript_claude_code',
          sourceVersion: '0.13.4', observability: 'reported', provider: 'anthropic',
          client: 'claude-code', model: 'claude-opus-4-6', effort: 'high', coverageStatus: 'COMPLETE'
        }
      ],
      usageFacts: [
        {
          usageScope: 'session_total', scopeId: 'session', ordinal: 1, sourceSurface: 'entire_session_tokens',
          sourceVersion: '0.13.4', observability: 'reported',
          inputTokens: 400, outputTokens: 100, totalTokens: 500, apiCalls: 2, coverageStatus: 'COMPLETE'
        }
      ]
    })

    // (c) 201 call_delta rows with 0, NULL, and row 201 PARTIAL coverage
    const { sessionId: longSessionId } = store.ingest({
      providerSessionId: 'mi-201-deltas',
      providerVersion: '0.13.4',
      agent: 'codex',
      state: 'ENDED',
      endedAt: '2026-11-20T17:00:00.000Z',
      coverage: 'PARTIAL',
      importState: 'METADATA_ONLY',
      sourceDigest: digest('mi-201-deltas'),
      sourceBytes: 0
    }, [])
    const deltas = Array.from({ length: 201 }, (_, idx) => ({
      usageScope: 'call_delta' as const,
      scopeId: `call:${idx + 1}`,
      ordinal: idx + 1,
      sourceSurface: 'codex_native_jsonl' as const,
      sourceVersion: '0.169.0-alpha.11.1',
      observability: 'reported' as const,
      inputTokens: 10,
      outputTokens: 1,
      ...(idx < 200 ? { cacheReadTokens: 0 } : {}),
      totalTokens: 11,
      coverageStatus: (idx === 200 ? 'PARTIAL' : 'COMPLETE') as 'PARTIAL' | 'COMPLETE'
    }))
    store.modelIntelligence.recordFacts(longSessionId, { usageFacts: deltas })
    store.close()

    // (d) Reopen readOnly in authorized repo & verify cross-repo rejection
    expect(() => new SessionStore(storePath, 'wrong-repo-id', true)).toThrow('REPOSITORY_MISMATCH')
    const reopened = new SessionStore(storePath, repoId, true)
    cleanup.push(() => reopened.close())

    const principal = authenticatedAgentPrincipal('MCP', () => true)
    const authority = authorizeArtifactAgent(principal, repoId, () => true)
    const adapter = new ChannelMcpAdapter({
      projectId: repoId,
      repoRoot: root,
      navigation: {} as McpProjectContext['navigation'],
      continuum: { repositoryId: repoId } as never,
      sessionContext: {
        call: (name: string, args: unknown) =>
          executeSessionTool(reopened, {}, name as SessionToolName, args, () => {})
      } as never
    })
    const server = createMcpHttpServer(adapter, () => {}, undefined, undefined, () => authority)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())))
    const address = server.address() as { port: number }

    const mcpClient = new Client({ name: 'mi-q26-client', version: '1' })
    cleanup.push(() => mcpClient.close())
    await mcpClient.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)))

    const { tools } = await mcpClient.listTools()
    const ajv = new AjvJsonSchemaValidator()
    const validators = new Map<string, ReturnType<typeof ajv.getValidator>>()
    for (const t of tools) validators.set(t.name, ajv.getValidator(t.inputSchema))

    const mcpCall = async (name: string, args: Record<string, unknown>) => {
      const check = validators.get(name)!(args)
      expect(check.valid, `AJV rejected ${name}: ${check.errorMessage}`).toBe(true)
      const res = await mcpClient.callTool({ name, arguments: args })
      return { isError: !!res.isError, data: JSON.parse((res.content as Array<{ text: string }>)[0].text) }
    }

    // Verify list_agent_sessions over public HTTP/AJV preserves authority & non-truncation flags
    const listed = await mcpCall('list_agent_sessions', { repositoryId: repoId, limit: 10 })
    expect(listed.isError).toBe(false)
    const reqListEntry = (listed.data.sessions as Array<Record<string, unknown>>).find(s => s.sessionId === reqSessionId)!
    expect(reqListEntry.modelIntelligence).toMatchObject({
      authority: 'REQUESTED_ONLY',
      requestedModels: ['gpt-5.4', 'gpt-5.4-mini']
    })

    // (a) Q26 on requested-only turn selections: perCall MUST be INDETERMINADO, sessionLevelModel MUST be null
    const q26Req = await mcpCall('inspect_intelligence_evidence', {
      repositoryId: repoId,
      questionId: 'Q26',
      target: { sessionId: reqSessionId },
      includeEntireUsage: true
    })
    expect(q26Req.isError).toBe(false)
    expect(q26Req.data.coverage).toEqual({ model: 'PARTIAL', perCall: 'INDETERMINADO' })
    expect(q26Req.data.evidence.supportState).toBe('PARTIAL')
    expect(q26Req.data.evidence.sessionLevelModel).toBeNull()
    expect(q26Req.data.evidence.perCallModels).toBeNull()
    expect(q26Req.data.evidence.effectivePerCallState).toBe('INDETERMINADO')
    expect(q26Req.data.evidence.modelSwitchReported).toBe(false)
    expect(q26Req.data.evidence.requestedChoices).toHaveLength(2)
    expect(q26Req.data.evidence.gaps).toEqual(
      expect.arrayContaining(['PER_CALL_MODEL_INDETERMINADO', 'EFFECTIVE_MODEL_INDETERMINADO', 'EFFORT_REQUESTED_ONLY_UNOBSERVED'])
    )

    // (b) Q26 on truly reported per-call observations: returns exact IDs/models & reported switch
    const q26Call = await mcpCall('inspect_intelligence_evidence', {
      repositoryId: repoId,
      questionId: 'Q26',
      target: { sessionId: callSessionId },
      includeEntireUsage: true
    })
    expect(q26Call.isError).toBe(false)
    expect(q26Call.data.coverage).toEqual({ model: 'SUPPORTED', perCall: 'SUPPORTED' })
    expect(q26Call.data.evidence.supportState).toBe('SUPPORTED')
    expect(q26Call.data.evidence.modelSwitchReported).toBe(true)
    expect(q26Call.data.evidence.perCallModels).toMatchObject([
      { scope: 'call', scopeId: 'call:10', model: 'claude-sonnet-4-6', effort: 'medium', observability: 'REPORTED' },
      { scope: 'call', scopeId: 'call:20', model: 'claude-opus-4-6', effort: 'high', observability: 'REPORTED' }
    ])

    // (c) 201 call_delta rows: full SQL sum (2010, cacheRead 0, apiCalls 201) + PARTIAL coverage (never COMPLETE)
    const inspected201 = await mcpCall('inspect_agent_session', {
      repositoryId: repoId,
      sessionId: longSessionId,
      view: 'FOCAL'
    })
    expect(inspected201.isError).toBe(false)
    expect(inspected201.data.modelIntelligence).toMatchObject({
      totalUsageFacts: 201,
      hasMoreUsageFacts: true,
      coverageStatus: 'PARTIAL',
      primaryUsage: {
        scope: 'call_delta_sum',
        input: 2010,
        output: 201,
        cacheRead: 0,
        total: 2211,
        apiCalls: 201
      }
    })
    const q26Long = await mcpCall('inspect_intelligence_evidence', {
      repositoryId: repoId,
      questionId: 'Q26',
      target: { sessionId: longSessionId },
      includeEntireUsage: true
    })
    expect(q26Long.isError).toBe(false)
    expect(q26Long.data.evidence.reportedUsage.coverage).toBe('PARTIAL')
    expect(q26Long.data.evidence.reportedUsage.metrics.total).toBe(2211)
    expect(q26Long.data.evidence.gaps).toContain('USAGE_COVERAGE_PARTIAL')

    // (d) Cross-repo rejection over MCP
    const crossRepo = await mcpCall('inspect_agent_session', {
      repositoryId: 'wrong-repo-id',
      sessionId: longSessionId,
      view: 'FOCAL'
    })
    expect(crossRepo.isError).toBe(true)
    expect(crossRepo.data.code).toBe('REPOSITORY_NOT_AUTHORIZED')
  })
})
