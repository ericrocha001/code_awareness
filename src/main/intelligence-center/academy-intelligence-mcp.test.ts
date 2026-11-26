import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import { buildSync } from 'esbuild'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcademyService } from '../academy/academy-service'
import { authenticatedAgentPrincipal, authorizeArtifactAgent } from '../continuum/agent-authority'
import type { IArtifactReader } from '../continuum/continuum-types'
import { ChannelMcpAdapter } from '../mcp/channel-mcp-adapter'
import { createMcpHttpServer } from '../mcp/mcp-http-server'
import type { McpProjectContext } from '../mcp/project-mcp-context'
import { SessionContextClient } from '../session-context/client'
import { stepCodexSourceIndex } from '../session-context/native-codex-source'
import { nativeDigest } from '../session-context/native-hooks'
import { digest } from '../session-context/privacy'
import { SessionStore, sessionStorePath } from '../session-context/store'
import { sourceFingerprint } from '../session-context/target'

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
    const academyDbPath = join(base, 'academy', 'academy.sqlite')
    mkdirSync(join(repoRoot, '.git'), { recursive: true })
    writeFileSync(join(repoRoot, '.git/HEAD'), 'ref: refs/heads/main\n')
    mkdirSync(foreignRoot, { recursive: true })

    const academy = new AcademyService(academyDbPath)
    cleanup.push(() => academy.close())

    const destA = academy.store.upsertDestination(repoRoot, 'Repo A')
    const destForeign = academy.store.upsertDestination(foreignRoot, 'Repo B')
    const repositoryId = destA.id
    const storePath = sessionStorePath(base, repositoryId)
    mkdirSync(dirname(storePath), { recursive: true })

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
    const worktreeId = nativeDigest(`wt:${repositoryId}`)
    const foreignWorktreeId = nativeDigest(`wt:foreign:${repositoryId}`)
    const generation = nativeDigest(`gen:${repositoryId}`)
    const unboundAuthority = authorizeArtifactAgent(principal, repositoryId, () => true)
    const foreignWtAuthority = authorizeArtifactAgent(principal, repositoryId, () => true, foreignWorktreeId)

    const workerPath = join(base, 'session-context-worker.cjs')
    const builtWorker = buildSync({
      entryPoints: ['src/main/session-context/worker.ts'],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      packages: 'external',
      write: false
    }).outputFiles[0].text
    writeFileSync(workerPath, `require = require('node:module').createRequire(${JSON.stringify(join(process.cwd(), 'package.json'))});\n` + builtWorker)

    const fp = sourceFingerprint(repoRoot)
    const resolver = Object.assign(
      async (sel: { worktreeId: string; generation: string }) => {
        if (sel.worktreeId === worktreeId && sel.generation === generation) {
          return { root: repoRoot, fingerprint: fp, validate: async () => {} }
        }
        throw new Error('WORKTREE_NOT_DISCOVERED')
      },
      { discover: async () => [{ worktreeId, generation, root: repoRoot, fingerprint: fp }] }
    )

    const sessionContext = new SessionContextClient(
      base,
      repositoryId,
      repoRoot,
      () => true,
      workerPath,
      resolver as any,
      30_000
    )
    cleanup.push(() => sessionContext.dispose())

    let currentAuthMode: 'bound' | 'unbound' | 'foreign_worktree' = 'bound'

    // Production-equivalent composition: pass SessionContextClient via sessionContext, NEVER inject skillIntelligence directly
    const adapter = new ChannelMcpAdapter(
      {
        projectId: destA.id,
        repoRoot,
        navigation: {} as McpProjectContext['navigation'],
        continuum: { repositoryId, get: artifactReader.get, list: artifactReader.list } as never,
        sessionContext,
        artifactReader,
        skillObserver: (ev) => { store.skillIntelligence.recordSkillEvent(ev) }
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
      () => (
        currentAuthMode === 'bound'
          ? boundAuthority
          : currentAuthMode === 'foreign_worktree'
            ? foreignWtAuthority
            : unboundAuthority
      )
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

    // 10. Negative discriminatives for native events & metadataOnly history (must NEVER become CONTENT_DELIVERED)
    const { sessionId: nativeNegSessionId } = store.ingest({
      providerSessionId: 'native-sess-neg-disc',
      providerVersion: '0.169.0',
      agent: 'codex',
      state: 'ENDED',
      endedAt: '2026-11-23T01:10:00.000Z',
      coverage: 'PARTIAL',
      importState: 'METADATA_ONLY',
      sourceDigest: digest('native-sess-neg-disc'),
      sourceBytes: 0
    }, [])

    const extractedCount = store.skillIntelligence.extractFromNativeEvents(nativeNegSessionId, [
      // (a) Unpaired TOOL_CALL read without TOOL_RESULT -> UNKNOWN attempt, NEVER CONTENT_DELIVERED
      {
        ordinal: 1,
        type: 'TOOL_CALL',
        tool: 'resources/read',
        callId: 'call-unpaired-1',
        content: JSON.stringify({ uri: skillRootUri })
      },
      // (b) metadataOnly get_academy_skill_history -> DISCOVERED_MANIFEST_FETCHED, NEVER CONTENT_DELIVERED
      {
        ordinal: 2,
        type: 'TOOL_CALL',
        tool: 'get_academy_skill_history',
        callId: 'call-hist-meta-1',
        content: JSON.stringify({ skillId, metadataOnly: true })
      },
      {
        ordinal: 3,
        type: 'TOOL_RESULT',
        tool: 'get_academy_skill_history',
        callId: 'call-hist-meta-1',
        content: JSON.stringify({ id: skillId, versions: [{ version: 1, packageHash: v1Hash }] })
      }
    ])
    expect(extractedCount).toBe(2)

    const q20NativeNeg = await mcpCall('inspect_intelligence_evidence', {
      questionId: 'Q20',
      repositoryId,
      target: { sessionId: nativeNegSessionId }
    })
    expect(q20NativeNeg.isError).toBe(false)
    expect(q20NativeNeg.data.evidence.decisionSignal.delivered).toEqual([])
    expect(q20NativeNeg.data.evidence.decisionSignal.attempted).toEqual([
      expect.objectContaining({
        operation: 'resources/read',
        operationStatus: 'UNKNOWN',
        errorCode: 'UNPAIRED_TOOL_CALL'
      })
    ])
    expect(q20NativeNeg.data.evidence.decisionSignal.discovered).toEqual([
      expect.objectContaining({
        skillId,
        operation: 'get_academy_skill_history'
      })
    ])

    // Also verify MCP tools/call get_academy_skill_history with metadataOnly:true is NOT CONTENT_DELIVERED
    const mcpHistMeta = await mcpCall('get_academy_skill_history', { skillId, metadataOnly: true })
    expect(mcpHistMeta.isError).toBe(false)
    const boundAfterHist = store.skillIntelligence.querySkillEvents({ sessionId: boundSessionId, limit: 20 })
    const histEvt = boundAfterHist.events.find(e => e.operation === 'get_academy_skill_history')
    expect(histEvt).toBeDefined()
    expect(histEvt!.observationClass).toBe('DISCOVERED_MANIFEST_FETCHED')

    // 11. Reverse Skill target via real SessionContextClient -> worker -> SessionStore + literal deepen selector execution
    const codexProfile = join(base, 'codex-profile')
    const codexAccHash = nativeDigest(JSON.stringify(['u', 'a']))
    const codexConfigPath = join(dirname(storePath), 'session-context.provider.json')
    writeFileSync(codexConfigPath, JSON.stringify({
      repositoryId,
      nativeSources: { codex: { profile: codexProfile, creatorAccountHash: codexAccHash } }
    }))
    const codexSessionUuid = '01a1e000-0000-7000-8000-000000000203'
    const codexNativeHash = nativeDigest(JSON.stringify([repositoryId, 'codex', codexSessionUuid]))
    const uuidDay = new Date(Number.parseInt(codexSessionUuid.replaceAll('-', '').slice(0, 12), 16))
      .toISOString()
      .slice(0, 10)
      .split('-')
    const rolloutDir = join(codexProfile, 'sessions', ...uuidDay)
    mkdirSync(rolloutDir, { recursive: true })
    const rolloutPath = join(rolloutDir, `rollout-2026-11-26T10-00-00-${codexSessionUuid}.jsonl`)
    writeFileSync(rolloutPath, [
      {
        timestamp: '2026-11-26T10:00:00Z',
        type: 'session_meta',
        payload: {
          id: codexSessionUuid,
          session_id: codexSessionUuid,
          account_scoped: true,
          creator_user_id: 'u',
          creator_account_id: 'a',
          cwd: repoRoot,
          runtime_workspace_roots: [repoRoot],
          cli_version: '0.169.0-alpha.11.1'
        }
      },
      { timestamp: '2026-11-26T10:00:01Z', type: 'turn_context', payload: { turn_id: 'turn-codex-v1', cwd: repoRoot } },
      {
        timestamp: '2026-11-26T10:00:02Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'mcp__code_awareness__get_academy_skill',
          call_id: 'codex-call-v1',
          arguments: JSON.stringify({
            skillId,
            view: 'section',
            version: 1,
            path: 'SKILL.md',
            selector: 'sec-main'
          })
        }
      },
      {
        timestamp: '2026-11-26T10:00:03Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'codex-call-v1',
          output: JSON.stringify({
            structuredContent: {
              skillId,
              scope: 'PROJECT',
              version: 1,
              packageHash: v1Hash,
              path: 'SKILL.md',
              selector: 'sec-main',
              range: { startLine: 1, endLine: 6, startOffset: 0, endOffset: 120 },
              content: SKILL_V1_BODY,
              offset: 0,
              totalCharacters: SKILL_V1_BODY.length,
              nextOffset: null
            }
          })
        }
      }
    ].map(r => JSON.stringify(r)).join('\n') + '\n')

    const indexedCodex = stepCodexSourceIndex({
      refs: store.references.native,
      storePath,
      repositoryId,
      worktreeId,
      generation,
      worktreeRoot: repoRoot,
      nativeHash: codexNativeHash,
      sourceSessionId: codexSessionUuid,
      mode: 'STEP',
      assertCurrent: () => {}
    })
    expect(indexedCodex.status).toBe('READY')

    currentAuthMode = 'bound'
    const q20ReverseV1 = await mcpCall('inspect_intelligence_evidence', {
      questionId: 'Q20',
      repositoryId,
      target: { skill: { skillId, version: 1, packageHash: v1Hash } }
    })
    expect(q20ReverseV1.isError).toBe(false)
    expect(q20ReverseV1.data.gaps).not.toContain('SKILL_INTELLIGENCE_UNAVAILABLE')
    expect(q20ReverseV1.data.evidence.reverseAcquisitions.length).toBeGreaterThanOrEqual(2)
    expect(
      q20ReverseV1.data.evidence.reverseAcquisitions.every(
        (a: any) => a.skillId === skillId && a.version === 1
      )
    ).toBe(true)

    const codexAcq = q20ReverseV1.data.evidence.reverseAcquisitions.find(
      (a: any) => a.sessionWitness?.nativeSessionId === codexNativeHash
    )
    expect(codexAcq).toBeDefined()
    expect(codexAcq.sessionWitness.sourceSessionId).toBe(codexSessionUuid)
    expect(codexAcq.callEventId).toBeTruthy()
    expect(codexAcq.resultEventId).toBeTruthy()
    expect(codexAcq.deepenSession.tool).toBe('inspect_agent_session')
    expect(codexAcq.deepenCallEvent.tool).toBe('list_agent_session_events')
    expect(codexAcq.deepenResultEvent.tool).toBe('list_agent_session_events')

    // Execute returned selectors literally without rewriting tool names/args/revisions
    const deepenedCodexSession = await mcpCall(
      codexAcq.deepenSession.tool,
      codexAcq.deepenSession.arguments
    )
    expect(deepenedCodexSession.isError).toBe(false)
    expect(typeof deepenedCodexSession.data.revision).toBe('number')

    const callList = await mcpCall(
      codexAcq.deepenCallEvent.tool,
      codexAcq.deepenCallEvent.arguments
    )
    expect(callList.isError).toBe(false)
    expect(callList.data.events).toHaveLength(1)
    expect(callList.data.events[0].eventId).toBe(codexAcq.callEventId)
    const readCall = await mcpCall('read_agent_session_event', {
      repositoryId,
      nativeSession: codexAcq.deepenCallEvent.arguments.nativeSession,
      sourceSessionId: codexAcq.deepenCallEvent.arguments.sourceSessionId,
      expectedRevision: callList.data.revision,
      eventId: callList.data.events[0].eventId
    })
    expect(readCall.isError).toBe(false)
    expect(readCall.data.eventId).toBe(codexAcq.callEventId)
    expect(readCall.data.payloadDigest).toBeTruthy()

    const resultList = await mcpCall(
      codexAcq.deepenResultEvent.tool,
      codexAcq.deepenResultEvent.arguments
    )
    expect(resultList.isError).toBe(false)
    expect(resultList.data.events).toHaveLength(1)
    expect(resultList.data.events[0].eventId).toBe(codexAcq.resultEventId)
    const readResult = await mcpCall('read_agent_session_event', {
      repositoryId,
      nativeSession: codexAcq.deepenResultEvent.arguments.nativeSession,
      sourceSessionId: codexAcq.deepenResultEvent.arguments.sourceSessionId,
      expectedRevision: resultList.data.revision,
      eventId: resultList.data.events[0].eventId
    })
    expect(readResult.isError).toBe(false)
    expect(readResult.data.eventId).toBe(codexAcq.resultEventId)
    expect(readResult.data.payloadDigest).toBeTruthy()

    // Execute imported session deepen selector literally & check stale expectedRevision rejection
    const importedAcq = q20ReverseV1.data.evidence.reverseAcquisitions.find(
      (a: any) => a.sessionWitness?.sessionId === boundSessionId
    )
    expect(importedAcq).toBeDefined()
    const deepenedImported = await mcpCall(
      importedAcq.deepenSession.tool,
      importedAcq.deepenSession.arguments
    )
    expect(deepenedImported.isError).toBe(false)
    expect(deepenedImported.data.sessionId).toBe(boundSessionId)
    const staleImportedRead = await mcpCall('read_agent_session_event', {
      repositoryId,
      sessionId: boundSessionId,
      expectedRevision: deepenedImported.data.revision + 99,
      eventId: '00000000-0000-4000-8000-000000000001'
    })
    expect(staleImportedRead.isError).toBe(true)
    expect(staleImportedRead.data.code).toBe('REVISION_CONFLICT')

    // Worktree isolation negative: foreign worktree authority excludes Codex native acquisition from items AND total
    currentAuthMode = 'foreign_worktree'
    const foreignWtRes = await mcpCall('inspect_intelligence_evidence', {
      questionId: 'Q20',
      repositoryId,
      target: { skill: { skillId, version: 1, packageHash: v1Hash } }
    })
    expect(foreignWtRes.isError).toBe(false)
    expect(foreignWtRes.data.pagination.total).toBe(0)
    expect(foreignWtRes.data.evidence.reverseAcquisitions).toHaveLength(0)

    // Revoked Codex grant negative: removes Codex native observations from items AND total while preserving imported
    currentAuthMode = 'bound'
    unlinkSync(codexConfigPath)
    const afterRevoke = await mcpCall('inspect_intelligence_evidence', {
      questionId: 'Q20',
      repositoryId,
      target: { skill: { skillId, version: 1, packageHash: v1Hash } }
    })
    expect(afterRevoke.isError).toBe(false)
    expect(
      afterRevoke.data.evidence.reverseAcquisitions.some(
        (a: any) => a.sessionWitness?.nativeSessionId === codexNativeHash
      )
    ).toBe(false)
    expect(afterRevoke.data.pagination.total).toBeLessThan(q20ReverseV1.data.pagination.total)

    // Empty result for nonexistent skillId with available Store is distinct from SKILL_INTELLIGENCE_UNAVAILABLE
    const emptySkillRes = await mcpCall('inspect_intelligence_evidence', {
      questionId: 'Q20',
      repositoryId,
      target: { skill: { skillId: 'skill-does-not-exist' } }
    })
    expect(emptySkillRes.isError).toBe(false)
    expect(emptySkillRes.data.gaps).not.toContain('SKILL_INTELLIGENCE_UNAVAILABLE')
    expect(emptySkillRes.data.pagination.total).toBe(0)

    // Historical version/hash mismatch on reverse Skill target emits HISTORICAL_VERSION_HASH_MISMATCH
    const q20ReverseMismatch = await mcpCall('inspect_intelligence_evidence', {
      questionId: 'Q20',
      repositoryId,
      target: { skill: { skillId, version: 1, packageHash: 'f'.repeat(64) } }
    })
    expect(q20ReverseMismatch.isError).toBe(false)
    expect(q20ReverseMismatch.data.gaps).toContain('HISTORICAL_VERSION_HASH_MISMATCH')

    // Reject target.skill on non-Q20/Q21, conflicting targets, and ambiguous top-level skillId
    const q05SkillTarget = await mcpCall('inspect_intelligence_evidence', {
      questionId: 'Q05',
      repositoryId,
      target: { skill: { skillId } }
    })
    expect(q05SkillTarget.isError).toBe(true)
    expect(q05SkillTarget.data.code).toBe('UNSUPPORTED_TARGET_FOR_QUESTION')

    const conflictingSkillTarget = await mcpCall('inspect_intelligence_evidence', {
      questionId: 'Q20',
      repositoryId,
      target: { skill: { skillId }, sessionId: boundSessionId }
    })
    expect(conflictingSkillTarget.isError).toBe(true)
    expect(conflictingSkillTarget.data.code).toBe('CONFLICTING_TARGET')

    const ambiguousSkillIdTarget = await mcpCall('inspect_intelligence_evidence', {
      questionId: 'Q20',
      repositoryId,
      skillId,
      target: { skill: { skillId } }
    })
    expect(ambiguousSkillIdTarget.isError).toBe(true)
    expect(ambiguousSkillIdTarget.data.code).toBe('CONFLICTING_TARGET')

    // Q21 separation: session error without linked Skill failure/turn + input.skillId must return INDETERMINADO & CONTEXT_CANDIDATE
    const { sessionId: coexistErrSessionId } = store.ingest({
      providerSessionId: 'native-sess-coexist-err',
      providerVersion: '0.169.0',
      agent: 'codex',
      state: 'ENDED',
      endedAt: '2026-11-23T01:20:00.000Z',
      coverage: 'COMPLETE',
      importState: 'METADATA_ONLY',
      sourceDigest: digest('native-sess-coexist-err'),
      sourceBytes: 0
    }, [])
    const errDb = new Database(storePath)
    errDb.prepare(`
      INSERT INTO events (id, sessionId, ordinal, type, timestamp, tool, success, files, sourcePosition, digest, bytes, omission, sanitized)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'evt-coexist-err-1',
      coexistErrSessionId,
      1,
      'ERROR',
      '2026-11-23T01:20:01.000Z',
      'bash',
      0,
      '[]',
      1,
      digest('Unrelated build error'),
      21,
      null,
      1
    )
    errDb.close()
    const q21CoexistOnly = await mcpCall('inspect_intelligence_evidence', {
      questionId: 'Q21',
      repositoryId,
      skillId,
      target: { sessionId: coexistErrSessionId }
    })
    expect(q21CoexistOnly.isError).toBe(false)
    expect(q21CoexistOnly.data.evidence.q21Diagnosis.conclusionState).toBe('INDETERMINADO')
    expect(q21CoexistOnly.data.evidence.q21Diagnosis.discriminativeGap).toBe('MISSING_LINKED_FAILURE_OR_SKILL')
    expect(q21CoexistOnly.data.evidence.q21Diagnosis.contextCandidateFailures).toEqual([
      expect.objectContaining({ associationClass: 'CONTEXT_CANDIDATE' })
    ])

    // 12. Verify SQLite does NOT persist Skill body
    const rawDb = new Database(storePath, { readonly: true })
    const rows = rawDb.prepare('SELECT * FROM skill_events').all()
    rawDb.close()
    expect(JSON.stringify(rows)).not.toContain('UNIQUE_SECRET_BODY_V1')
    expect(JSON.stringify(rows)).not.toContain('UNIQUE_SECRET_BODY_V2')
    expect(readFileSync(storePath, 'latin1')).not.toContain('UNIQUE_SECRET_BODY_V1')
  }, 30_000)
})
