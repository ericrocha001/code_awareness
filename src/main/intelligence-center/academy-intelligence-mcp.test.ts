import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcademyService } from '../academy/academy-service'
import { authenticatedAgentPrincipal, authorizeArtifactAgent } from '../continuum/agent-authority'
import type { IArtifactReader } from '../continuum/continuum-types'
import { ChannelMcpAdapter } from '../mcp/channel-mcp-adapter'
import { createMcpHttpServer } from '../mcp/mcp-http-server'
import type { McpProjectContext } from '../mcp/project-mcp-context'
import { executeSessionTool, type SessionToolName } from '../session-context/mcp'
import { digest } from '../session-context/privacy'
import { SessionStore } from '../session-context/store'

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

async function legacyRpc(
  endpoint: string,
  id: number,
  method: string,
  params?: unknown,
  headers: Record<string, string> = {}
) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
  })
  return (await response.json()) as { result?: any; error?: any }
}

describe('Academy Intelligence Q20/Q21 — typed Skill events, historical fidelity & public MCP HTTP/AJV acceptance', () => {
  it('covers positive Q20 lifecycle, negative discriminatives, Q21 non-mutating diagnosis, cursor/revision & SQLite body-absence', async () => {
    const [{ Client }, { StreamableHTTPClientTransport }, { AjvJsonSchemaValidator }] = await Promise.all([
      import('@modelcontextprotocol/sdk/client'),
      import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
      import('@modelcontextprotocol/sdk/validation/ajv')
    ])

    const base = mkdtempSync(join(tmpdir(), 'academy-intel-u3-'))
    cleanup.push(() => safeRemove(base))
    const repoRoot = join(base, 'repo-a')
    const foreignRoot = join(base, 'repo-b')
    const storePath = join(base, 'store', 'session-context.sqlite')
    const academyDbPath = join(base, 'academy', 'academy.sqlite')
    mkdirSync(repoRoot, { recursive: true })
    mkdirSync(foreignRoot, { recursive: true })
    mkdirSync(dirname(storePath), { recursive: true })

    const academy = new AcademyService(academyDbPath)
    cleanup.push(() => academy.close())

    const destA = academy.store.upsertDestination(repoRoot, 'Repo A')
    const destForeign = academy.store.upsertDestination(foreignRoot, 'Repo B')
    const repositoryId = destA.id

    const SKILL_V1_BODY = '---\nname: deploy-guard\ndescription: Guard deployments safely.\n---\n\n# Deploy Guard v1\n\nUNIQUE_SECRET_BODY_V1_DO_NOT_PERSIST_IN_SQLITE\n'
    const SKILL_V2_BODY = '---\nname: deploy-guard\ndescription: Guard deployments safely with preflight.\n---\n\n# Deploy Guard v2\n\nUNIQUE_SECRET_BODY_V2_WITH_PREFLIGHT\n'
    const FOREIGN_BODY = '---\nname: foreign-deploy-guard\ndescription: Foreign skill.\n---\n\n# Foreign Deploy Guard\n'

    // Create Skill S@v1 in PROJECT destA
    const createdSkill = await academy.create({
      scope: 'PROJECT',
      projectIds: [destA.id],
      origin: 'LOCAL_CLI',
      package: { skillMd: SKILL_V1_BODY, artifacts: {} }
    })
    const skillId = createdSkill.id
    const v1Hash = createdSkill.current.packageHash

    // Homonymous Skill in foreign scope destForeign
    const foreignSkill = await academy.create({
      scope: 'PROJECT',
      projectIds: [destForeign.id],
      origin: 'LOCAL_CLI',
      package: { skillMd: FOREIGN_BODY, artifacts: {} }
    })

    const store = new SessionStore(storePath, repositoryId)
    cleanup.push(() => store.close())

    // Ingest a bound session (metadata-only, no event body persisted) with partial coverage
    const { sessionId: boundSessionId } = store.ingest({
      providerSessionId: 'native-sess-1',
      providerVersion: '0.169.0',
      agent: 'codex',
      state: 'ENDED',
      endedAt: '2026-11-23T01:00:00.000Z',
      coverage: 'PARTIAL',
      importState: 'METADATA_ONLY',
      sourceDigest: digest('native-sess-1'),
      sourceBytes: 0
    }, [])

    // Unrelated session with no failure & no skill (for Q21 missing-link negative)
    const { sessionId: emptySessionId } = store.ingest({
      providerSessionId: 'native-sess-empty',
      providerVersion: '0.169.0',
      agent: 'codex',
      state: 'ENDED',
      endedAt: '2026-11-23T01:05:00.000Z',
      coverage: 'PARTIAL',
      importState: 'METADATA_ONLY',
      sourceDigest: digest('native-sess-empty'),
      sourceBytes: 0
    }, [])

    const handoffId = 'artifact-11111111-2222-4333-8444-555555555555'
    const artifactReader: IArtifactReader = {
      list: vi.fn(() => ({ items: [], total: 0 })) as never,
      get: (id: string) => id === handoffId ? ({
        artifactId: handoffId,
        revision: 1,
        metadata: {
          name: 'Handoff',
          kind: 'IMPLEMENTATION_HANDOFF',
          // Handoff declares S@v2 (unverified declaration, must remain DECLARADO)
          skillsUsed: [{ skillId, version: 2, nature: 'used' }]
        },
        rawMarkdown: '',
        createdAt: '',
        updatedAt: '',
        contentHash: '',
        provenance: {}
      }) as never : null
    }

    const planId = 'artifact-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    const executionId = 'exec-u3-bound-1'
    const principal = authenticatedAgentPrincipal('MCP', () => true)
    const boundAuthority = authorizeArtifactAgent(principal, repositoryId, () => true, undefined, {
      deliveryContext: {
        bindingArtifactId: `artifact-execution-branch-${'a'.repeat(64)}`,
        bindingRevision: 1,
        planArtifactId: planId,
        planRevision: 1,
        executionId
      },
      sessionWitness: {
        provider: 'codex',
        sessionId: boundSessionId
      }
    })
    const unboundAuthority = authorizeArtifactAgent(principal, repositoryId, () => true)

    let currentAuthMode: 'bound' | 'unbound' = 'bound'
    const sessionContext = {
      call: async (name: SessionToolName, args: unknown, allowArtifactMetadata = false) => {
        try {
          return await executeSessionTool(
            store,
            {},
            name,
            args,
            () => {},
            undefined,
            [],
            undefined,
            repoRoot,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            allowArtifactMetadata
          )
        } catch (err) {
          return {
            isError: true,
            content: [{ type: 'text', text: JSON.stringify({ code: err instanceof Error ? err.message : 'ERROR' }) }]
          }
        }
      }
    } as McpProjectContext['sessionContext']

    const adapter = new ChannelMcpAdapter(
      {
        projectId: destA.id,
        repoRoot,
        navigation: {} as McpProjectContext['navigation'],
        continuum: { repositoryId, get: artifactReader.get, list: artifactReader.list } as never,
        sessionContext,
        artifactReader,
        skillObserver: (ev) => { store.skillIntelligence.recordSkillEvent(ev) },
        skillIntelligence: store.skillIntelligence
      },
      undefined,
      undefined,
      undefined,
      academy
    )

    const server = createMcpHttpServer(
      adapter,
      () => {},
      undefined,
      undefined,
      () => (currentAuthMode === 'bound' ? boundAuthority : unboundAuthority)
    )
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())))
    const address = server.address() as { port: number }
    const mcpEndpoint = `http://127.0.0.1:${address.port}/mcp`
    const skillRootUri = `skill://project/${destA.id}/${skillId}/deploy-guard/SKILL.md`

    // 1. Positive route (a): bound skills/get (DISCOVERED_MANIFEST_FETCHED) + resources/read (CONTENT_DELIVERED) at v1
    currentAuthMode = 'bound'
    const getRes = await legacyRpc(mcpEndpoint, 1, 'skills/get', { uri: skillRootUri })
    expect(getRes.error).toBeUndefined()
    const readRes = await legacyRpc(mcpEndpoint, 2, 'resources/read', { uri: skillRootUri })
    expect(readRes.error).toBeUndefined()
    expect(readRes.result.contents[0].text).toContain('UNIQUE_SECRET_BODY_V1')

    // 2. Negative: refused/unauthorized foreign skill read + missing resource on skillId -> ATTEMPT_FAILED_OR_REFUSED (never CONTENT_DELIVERED)
    const foreignUri = `skill://project/${destForeign.id}/${foreignSkill.id}/foreign-deploy-guard/SKILL.md`
    const refusedRead = await legacyRpc(mcpEndpoint, 3, 'resources/read', { uri: foreignUri })
    expect(refusedRead.error).toBeDefined()
    const failedResourceRead = await legacyRpc(mcpEndpoint, 30, 'resources/read', { uri: `skill://project/${destA.id}/${skillId}/deploy-guard/nonexistent.md` })
    expect(failedResourceRead.error).toBeDefined()

    // 3. Negative: unbound read (no sessionWitness/executionId) -> recorded as UNBOUND, never attributed to boundSessionId
    currentAuthMode = 'unbound'
    const unboundRead = await legacyRpc(mcpEndpoint, 4, 'resources/read', { uri: skillRootUri })
    expect(unboundRead.error).toBeUndefined()

    // 4. Update Skill S to v2 AFTER v1 was delivered (tests historical fidelity: v1 must NOT become v2!)
    await academy.update({
      skillId,
      expectedVersion: 1,
      origin: 'LOCAL_CLI',
      package: { skillMd: SKILL_V2_BODY, artifacts: {} }
    })

    // 5. Dedup / replay idempotency check in SkillIntelligenceStore
    const replay = store.skillIntelligence.recordSkillEvent({
      sessionId: boundSessionId,
      executionId,
      observationClass: 'CONTENT_DELIVERED',
      skillId,
      skillScope: 'PROJECT',
      destinationId: destA.id,
      version: 1,
      versionStatus: 'EXACT',
      packageHash: v1Hash,
      resourceUri: skillRootUri,
      sourceSurface: 'academy_mcp_skills',
      sourceContract: 'io.modelcontextprotocol/skills@2026-07-28',
      originalEventId: 'fixed-replay-id',
      operation: 'resources/read',
      operationStatus: 'SUCCESS',
      sessionBindingState: 'BOUND_BY_WITNESS',
      bindingAuthority: 'session_witness'
    })
    const replay2 = store.skillIntelligence.recordSkillEvent({
      sessionId: boundSessionId,
      executionId,
      observationClass: 'CONTENT_DELIVERED',
      skillId,
      skillScope: 'PROJECT',
      destinationId: destA.id,
      version: 1,
      versionStatus: 'EXACT',
      packageHash: v1Hash,
      resourceUri: skillRootUri,
      sourceSurface: 'academy_mcp_skills',
      sourceContract: 'io.modelcontextprotocol/skills@2026-07-28',
      originalEventId: 'fixed-replay-id',
      operation: 'resources/read',
      operationStatus: 'SUCCESS',
      sessionBindingState: 'BOUND_BY_WITNESS',
      bindingAuthority: 'session_witness'
    })
    expect(replay.inserted).toBe(true)
    expect(replay2.inserted).toBe(false)
    expect(replay2.eventId).toBe(replay.eventId)

    // Connect public MCP SDK client with AJV validation
    currentAuthMode = 'bound'
    const client = new Client({ name: 'u3-test-client', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(mcpEndpoint))
    await client.connect(transport)
    cleanup.push(() => client.close())

    const { tools } = await client.listTools()
    const ajv = new AjvJsonSchemaValidator()
    const inspectTool = tools.find(t => t.name === 'inspect_intelligence_evidence')
    expect(inspectTool).toBeDefined()
    const validateArgs = ajv.getValidator(inspectTool!.inputSchema as any)

    const mcpCall = async (name: string, args: Record<string, unknown>) => {
      if (name === 'inspect_intelligence_evidence') {
        expect(validateArgs(args).valid).toBe(true)
      }
      const res = await client.callTool({ name, arguments: args })
      const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}'
      return { isError: res.isError === true, data: JSON.parse(text) }
    }

    // 6. Q20 positive retrieval + pagination + direct skillId entry
    const q20Page1 = await mcpCall('inspect_intelligence_evidence', {
      questionId: 'Q20',
      repositoryId,
      skillId,
      target: { sessionId: boundSessionId },
      limit: 2
    })
    expect(q20Page1.isError).toBe(false)
    expect(q20Page1.data.specialization).toBe('ACADEMY')
    expect(q20Page1.data.evidence.supportState).toBe('PARTIAL_OBSERVED')
    expect(q20Page1.data.pagination.hasMore).toBe(true)
    expect(q20Page1.data.deepen?.tool).toBe('inspect_intelligence_evidence')
    expect(q20Page1.data.evidence.decisionSignal.delivered.some((d: any) => d.skillId === skillId && d.version === 1 && d.packageHash === v1Hash)).toBe(true)
    expect(q20Page1.data.evidence.decisionSignal.discovered.some((d: any) => d.skillId === skillId && d.version === 1)).toBe(true)
    expect(q20Page1.data.evidence.decisionSignal.distributed.some((d: any) => d.skillId === skillId && d.version === 1 && d.packageHash === v1Hash)).toBe(true)
    expect(q20Page1.data.evidence.decisionSignal.unboundDeliveriesCount).toBe(1)
    // Historical fidelity: Academy.history v1 is read even though v2 is current!
    expect(q20Page1.data.evidence.historicalVersions.some((h: any) => h.skillId === skillId && h.version === 1 && h.packageHash === v1Hash)).toBe(true)
    // Omission rule: never IGNORED or SKILL_NOT_USED
    expect(q20Page1.data.gaps).not.toContain('IGNORED')
    expect(q20Page1.data.gaps).not.toContain('SKILL_NOT_USED')
    expect(q20Page1.data.gaps).toContain('CONTEXT_DELIVERY_ENVELOPE_UNAVAILABLE')

    // Follow deepen cursor to page 2
    const q20Page2 = await mcpCall('inspect_intelligence_evidence', q20Page1.data.deepen.arguments)
    expect(q20Page2.isError).toBe(false)
    expect(q20Page2.data.pagination.offset).toBe(2)

    // Revision conflict check
    const conflict = await mcpCall('inspect_intelligence_evidence', {
      questionId: 'Q20',
      repositoryId,
      target: { sessionId: boundSessionId },
      expectedRevision: q20Page1.data.revision + 999
    })
    expect(conflict.isError).toBe(true)
    expect(conflict.data.code).toBe('REVISION_CONFLICT')

    // 7. Negative: Handoff artifact that only declares S@v2 -> DECLARADO, never OBSERVADO
    const q20DeclaredOnly = await mcpCall('inspect_intelligence_evidence', {
      questionId: 'Q20',
      repositoryId,
      target: { relation: { type: 'ARTIFACT', id: handoffId } }
    })
    expect(q20DeclaredOnly.isError).toBe(false)
    expect(q20DeclaredOnly.data.evidence.supportState).toBe('PARTIAL_PENDING_METADATA')
    expect(q20DeclaredOnly.data.evidence.decisionSignal.attributedToSession).toBe(false)
    expect(q20DeclaredOnly.data.evidence.declaredSkills).toEqual([
      expect.objectContaining({ class: 'DECLARADO', skillId, version: 2 })
    ])
    expect(q20DeclaredOnly.data.evidence.decisionSignal.delivered).toEqual([])

    // 8. Q21: failure + historical v1 + candidate delta v2 (no Academy mutation!)
    const q21Res = await mcpCall('inspect_intelligence_evidence', {
      questionId: 'Q21',
      repositoryId,
      skillId,
      target: { sessionId: boundSessionId }
    })
    expect(q21Res.isError).toBe(false)
    expect(q21Res.data.evidence.q21Diagnosis.canonicalMutationApplied).toBe(false)
    expect(q21Res.data.evidence.q21Diagnosis.associatedFailures.length).toBeGreaterThan(0)
    expect(q21Res.data.evidence.q21Diagnosis.candidateDeltas).toEqual([
      expect.objectContaining({
        skillId,
        baseVersion: 1,
        targetVersion: 2,
        deepen: {
          tool: 'get_academy_change_diff',
          arguments: { skillId, baseVersion: 1, targetVersion: 2 }
        }
      })
    ])
    expect(q21Res.data.evidence.q21Diagnosis.discriminativeGap).toBe('PREVENTION_NOT_PROVEN_WITHOUT_COUNTERFACTUAL_EVAL')
    expect(academy.get(skillId).currentVersion).toBe(2)

    // 9. Q21 negative: session without linked failure + skill returns objective gap
    const q21Missing = await mcpCall('inspect_intelligence_evidence', {
      questionId: 'Q21',
      repositoryId,
      target: { sessionId: emptySessionId }
    })
    expect(q21Missing.isError).toBe(false)
    expect(q21Missing.data.evidence.q21Diagnosis.discriminativeGap).toBe('MISSING_LINKED_FAILURE_OR_SKILL')

    // 10. Verify SQLite does NOT persist Skill body
    const rawDb = new Database(storePath, { readonly: true })
    const rows = rawDb.prepare('SELECT * FROM skill_events').all()
    rawDb.close()
    expect(JSON.stringify(rows)).not.toContain('UNIQUE_SECRET_BODY_V1')
    expect(JSON.stringify(rows)).not.toContain('UNIQUE_SECRET_BODY_V2')
    expect(readFileSync(storePath, 'latin1')).not.toContain('UNIQUE_SECRET_BODY_V1')
  })
})
