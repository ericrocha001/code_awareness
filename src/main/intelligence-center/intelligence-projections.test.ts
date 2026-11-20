import { execFileSync } from 'node:child_process'
import { buildSync } from 'esbuild'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { authenticatedAgentPrincipal, authorizeArtifactAgent } from '../continuum/agent-authority'
import { ChannelMcpAdapter } from '../mcp/channel-mcp-adapter'
import { createMcpHttpServer } from '../mcp/mcp-http-server'
import type { McpProjectContext } from '../mcp/project-mcp-context'
import { SessionContextClient } from '../session-context/client'
import { nativeObservationBatch } from '../session-context/native-hook-ingestion'
import { nativeDigest, type NativeHookEnvelope } from '../session-context/native-hooks'
import { SessionStore, sessionStorePath } from '../session-context/store'
import { sourceFingerprint } from '../session-context/target'
import { ValidationLedger } from '../validation-ledger/validation-ledger'

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

function makeWorkerBundle(baseDir: string): string {
  const workerPath = join(baseDir, 'worker.cjs')
  const built = buildSync({
    entryPoints: ['src/main/session-context/worker.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
    write: false
  }).outputFiles[0].text
  writeFileSync(workerPath, `require = require('node:module').createRequire(${JSON.stringify(join(process.cwd(), 'package.json'))});\n` + built)
  return workerPath
}

describe('Intelligence Center — Cinco Intelligences public MCP acceptance', () => {
  it('delivers Session/Harness/Context projections over public MCP HTTP/AJV with literal deepen, pagination, relation resolution, and isolation', async () => {
    const [{ Client }, { StreamableHTTPClientTransport }, { AjvJsonSchemaValidator }] = await Promise.all([
      import('@modelcontextprotocol/sdk/client'),
      import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
      import('@modelcontextprotocol/sdk/validation/ajv')
    ])

    const base = mkdtempSync(join(tmpdir(), 'ic-proj-public-'))
    cleanup.push(() => safeRemove(base))
    const root = join(base, 'repo')
    mkdirSync(join(root, '.git'), { recursive: true })
    writeFileSync(join(root, '.git/HEAD'), 'ref: refs/heads/main\n')

    const repositoryId = 'repo-ic-proj'
    const storePath = sessionStorePath(base, repositoryId)
    const target = { worktreeId: nativeDigest(`wt:${repositoryId}`), generation: nativeDigest(`gen:${repositoryId}`) }
    const profile = join(base, 'codex-profile')
    const accHash = nativeDigest(JSON.stringify(['user-proj', 'acc-proj']))

    const s1Uuid = '01a1e000-0000-7000-8000-000000000401'
    const s2UnauthorizedUuid = '01a1e000-0000-7000-8000-000000000402'
    const dayFor = (u: string) => new Date(Number.parseInt(u.replaceAll('-', '').slice(0, 12), 16)).toISOString().slice(0, 10).split('-')
    const dir1 = join(profile, 'sessions', ...dayFor(s1Uuid))
    const dir2 = join(profile, 'sessions', ...dayFor(s2UnauthorizedUuid))
    mkdirSync(dir1, { recursive: true })
    mkdirSync(dir2, { recursive: true })

    writeFileSync(join(dir1, `rollout-2026-11-20T10-00-00-${s1Uuid}.jsonl`), [
      JSON.stringify({
        timestamp: '2026-11-20T10:00:00Z',
        type: 'session_meta',
        payload: { id: s1Uuid, session_id: s1Uuid, account_scoped: true, creator_user_id: 'user-proj', creator_account_id: 'acc-proj', cwd: root, runtime_workspace_roots: [root], cli_version: '0.169.0-alpha.11.1' }
      }),
      JSON.stringify({ timestamp: '2026-11-20T10:00:01Z', type: 'turn_context', payload: { turn_id: 'turn-p1', cwd: root } }),
      // Failure followed by subsequent recovery call for the same tool
      JSON.stringify({ timestamp: '2026-11-20T10:00:02Z', type: 'response_item', payload: { type: 'function_call', name: 'lint_tool', call_id: 'c-fail', arguments: '{"target":"schema"}' } }),
      JSON.stringify({ timestamp: '2026-11-20T10:00:03Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'c-fail', output: 'Exit code: 1\nTOOL_CONTRACT_ERROR: missing field' } }),
      JSON.stringify({ timestamp: '2026-11-20T10:00:04Z', type: 'response_item', payload: { type: 'function_call', name: 'lint_tool', call_id: 'c-ok', arguments: '{"target":"schema"}' } }),
      JSON.stringify({ timestamp: '2026-11-20T10:00:05Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'c-ok', output: 'Lint passed' } }),
      // Identical call+result twice -> proven repetition
      JSON.stringify({ timestamp: '2026-11-20T10:00:06Z', type: 'response_item', payload: { type: 'function_call', name: 'read_tool', call_id: 'c-r1', arguments: '{"file":"a.ts"}' } }),
      JSON.stringify({ timestamp: '2026-11-20T10:00:07Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'c-r1', output: 'file-a-content' } }),
      JSON.stringify({ timestamp: '2026-11-20T10:00:08Z', type: 'response_item', payload: { type: 'function_call', name: 'read_tool', call_id: 'c-r2', arguments: '{"file":"a.ts"}' } }),
      JSON.stringify({ timestamp: '2026-11-20T10:00:09Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'c-r2', output: 'file-a-content' } }),
      // Distinct control (different args & output) -> NOT grouped with a.ts
      JSON.stringify({ timestamp: '2026-11-20T10:00:10Z', type: 'response_item', payload: { type: 'function_call', name: 'read_tool', call_id: 'c-r3', arguments: '{"file":"b.ts"}' } }),
      JSON.stringify({ timestamp: '2026-11-20T10:00:11Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'c-r3', output: 'file-b-content' } })
    ].join('\n') + '\n')

    writeFileSync(join(dir2, `rollout-2026-11-20T11-00-00-${s2UnauthorizedUuid}.jsonl`), [
      JSON.stringify({
        timestamp: '2026-11-20T11:00:00Z',
        type: 'session_meta',
        payload: { id: s2UnauthorizedUuid, session_id: s2UnauthorizedUuid, account_scoped: true, creator_user_id: 'other-user', creator_account_id: 'other-acc', cwd: root, runtime_workspace_roots: [root], cli_version: '0.169.0-alpha.11.1' }
      }),
      JSON.stringify({ timestamp: '2026-11-20T11:00:01Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'FOREIGN_SECRET_TEXT' }] } })
    ].join('\n') + '\n')

    const s1Hash = nativeDigest(JSON.stringify([repositoryId, 'codex', s1Uuid]))
    const s2Hash = nativeDigest(JSON.stringify([repositoryId, 'codex', s2UnauthorizedUuid]))
    const planId = 'artifact-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    const unresolvedPlanId = 'artifact-99999999-9999-4999-8999-999999999999'

    const ledger = new ValidationLedger(join(base, 'ledger.sqlite'))
    cleanup.push(() => ledger.close())
    const proof = ledger.recordProof({
      kind: 'TARGETED_TEST',
      producer: 'TESTER',
      status: 'PASSED',
      startedAt: '2026-11-20T10:00:12Z',
      finishedAt: '2026-11-20T10:00:13Z',
      durationMs: 1000,
      scope: ['src/main/intelligence-center'],
      summary: 'Targeted test passed',
      evidenceFor: [planId]
    })

    const seedStore = new SessionStore(storePath, repositoryId)
    const hookFacts = {
      schema: 1 as const,
      source: 'CODEX_NATIVE_HOOK' as const,
      repositoryId,
      worktreeId: target.worktreeId,
      generation: target.generation,
      sessionId: s1Hash,
      event: 'PreToolUse' as const,
      tool: 'SHELL' as const,
      invocationId: nativeDigest('inv-proj-1')
    }
    const hookBody = { ...hookFacts, observedAt: '2026-11-20T10:00:02.500Z', eventId: nativeDigest(JSON.stringify(hookFacts)) }
    const hookShell: NativeHookEnvelope = { ...hookBody, digest: nativeDigest(JSON.stringify(hookBody)) }
    seedStore.registry.apply(nativeObservationBatch(hookShell), undefined)
    seedStore.registry.apply({ repositoryId, source: 'NATIVE_HOOK', revision: nativeDigest('proj-hook'), status: 'OBSERVED', edges: [] }, undefined)
    seedStore.registry.apply({
      repositoryId,
      source: 'CONTINUUM_TEST_REL',
      revision: '1',
      status: 'COMPLETE',
      edges: [{
        from: { kind: 'SESSION', id: `codex-native:${s1Hash}` },
        relation: 'associated',
        to: { kind: 'ARTIFACT', id: planId },
        evidenceKind: 'HANDOFF_DECLARED',
        evidenceRef: planId,
        digest: nativeDigest(planId),
        freshness: 'OBSERVED_SNAPSHOT'
      }]
    }, undefined)
    seedStore.close()

    writeFileSync(join(dirname(storePath), 'session-context.provider.json'), JSON.stringify({
      repositoryId,
      nativeSources: { codex: { profile, creatorAccountHash: accHash, allowLexicalIndex: true } }
    }))

    const fp = sourceFingerprint(root)
    const resolver = Object.assign(
      async () => ({ root, fingerprint: fp, validate: async () => {} }),
      { discover: async () => [{ ...target, root, fingerprint: fp }] }
    )
    const clientWorker = new SessionContextClient(base, repositoryId, root, () => true, makeWorkerBundle(base), resolver as any, 30_000)
    cleanup.push(() => clientWorker.dispose())

    const principal = authenticatedAgentPrincipal('MCP', () => true)
    const authority = authorizeArtifactAgent(principal, repositoryId, () => true)
    const adapter = new ChannelMcpAdapter({
      projectId: repositoryId,
      repoRoot: root,
      navigation: {} as McpProjectContext['navigation'],
      continuum: { repositoryId } as never,
      sessionContext: { call: (name, args, allowMeta) => clientWorker.call(name, args, allowMeta) }
    }, undefined, undefined, ledger)
    const server = createMcpHttpServer(adapter, () => {}, undefined, undefined, () => authority)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())))
    const address = server.address() as { port: number }

    const mcpClient = new Client({ name: 'ic-proj-client', version: '1' })
    cleanup.push(() => mcpClient.close())
    await mcpClient.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)))

    const { tools } = await mcpClient.listTools()
    const ajv = new AjvJsonSchemaValidator()
    const validators = new Map<string, ReturnType<typeof ajv.getValidator>>()
    for (const t of tools) validators.set(t.name, ajv.getValidator(t.inputSchema))

    const inspectTool = tools.find(t => t.name === 'inspect_intelligence_evidence')
    expect(inspectTool).toBeDefined()
    expect(inspectTool!.annotations?.readOnlyHint).toBe(true)

    const mcpCall = async (name: string, args: Record<string, unknown>) => {
      const validate = validators.get(name)!
      const check = validate(args)
      expect(check.valid, `AJV rejected ${name}(${JSON.stringify(args)}): ${check.errorMessage}`).toBe(true)
      const res = await mcpClient.callTool({ name, arguments: args })
      return { isError: !!res.isError, data: JSON.parse((res.content as Array<{ text: string }>)[0].text) }
    }

    // Index authorized s1; unauthorized s2 is rejected
    const s1Native = { provider: 'codex-native' as const, id: s1Hash, ...target }
    const s2Native = { provider: 'codex-native' as const, id: s2Hash, ...target }
    expect((await mcpCall('refresh_agent_sessions', { nativeSession: s1Native, sourceSessionId: s1Uuid })).data.state).toBe('READY')
    expect((await mcpCall('refresh_agent_sessions', { nativeSession: s2Native, sourceSessionId: s2UnauthorizedUuid })).data.state).toBe('UNAVAILABLE')

    // 1. Session Q05 via relation -> resolves s1, pairs failure, exposes non-causal recovery candidate & bound proof, and literal deepen works
    const q05 = await mcpCall('inspect_intelligence_evidence', {
      questionId: 'Q05',
      target: { relation: { type: 'ARTIFACT', id: planId } }
    })
    expect(q05.isError).toBe(false)
    expect(q05.data.specialization).toBe('SESSION')
    expect(q05.data.items).toHaveLength(1)
    expect(q05.data.items[0].groupingBasis).toBe('QUALIFIED_NATIVE_PAIRING')
    expect(q05.data.items[0].recoveryCandidates[0].provesResolution).toBe(false)
    expect(q05.data.summary.linkedProofs.some((p: { proofId: string }) => p.proofId === proof.proofId)).toBe(true)

    const literalErr = await mcpCall(q05.data.items[0].deepen.tool, q05.data.items[0].deepen.arguments)
    expect(literalErr.isError).toBe(false)
    expect(literalErr.data.content).toContain('TOOL_CONTRACT_ERROR')

    // 2. Harness Q23 via explicit nativeSession + sourceSessionId -> separated components without binary attribution
    const q23 = await mcpCall('inspect_intelligence_evidence', {
      questionId: 'Q23',
      target: { nativeSession: s1Native, sourceSessionId: s1Uuid }
    })
    expect(q23.isError).toBe(false)
    expect(q23.data.specialization).toBe('HARNESS')
    expect(q23.data.evidence.classification).toBeNull()
    expect(q23.data.evidence.components.toolAndContract.status).toBe('OBSERVED')
    expect(q23.data.evidence.components.modelAndEffort.status).toBe('UNAVAILABLE')
    expect(q23.data.evidence.components.skillsLinked.status).toBe('UNAVAILABLE')

    // 3. Context Q16 -> proven repetition for identical read_tool(a.ts), excludes distinct b.ts control; pagination works
    const q16 = await mcpCall('inspect_intelligence_evidence', {
      questionId: 'Q16',
      limit: 1,
      target: { nativeSession: s1Native, sourceSessionId: s1Uuid }
    })
    expect(q16.isError).toBe(false)
    expect(q16.data.provenRepetitionCount).toBe(1)
    expect(q16.data.repetitions).toHaveLength(1)
    expect(q16.data.repetitions[0].isProvenReread).toBe(true)
    expect(q16.data.repetitions[0].tool).toBe('read_tool')
    expect(q16.data.repetitions[0].count).toBe(2)

    // 4. Unresolved relation -> explicit UNRESOLVED without proximity fallback
    const unresolved = await mcpCall('inspect_intelligence_evidence', {
      questionId: 'Q05',
      target: { relation: { type: 'ARTIFACT', id: unresolvedPlanId } }
    })
    expect(unresolved.isError).toBe(false)
    expect(unresolved.data.resolution).toBe('UNRESOLVED')
    expect(unresolved.data.candidates).toEqual([])

    // 5. Unauthorized foreign session s2 -> rejected without leaking identity or text
    const foreign = await mcpCall('inspect_intelligence_evidence', {
      questionId: 'Q05',
      target: { nativeSession: s2Native, sourceSessionId: s2UnauthorizedUuid }
    })
    expect(foreign.isError).toBe(true)
    expect(JSON.stringify(foreign.data)).not.toContain('FOREIGN_SECRET_TEXT')

    // 6. Hook-only observation (no sourceSessionId) -> explicit hook limitation and gap
    const hookOnly = await mcpCall('inspect_intelligence_evidence', {
      questionId: 'Q05',
      target: { nativeSession: s1Native }
    })
    expect(hookOnly.isError).toBe(false)
    expect(hookOnly.data.coverage.source).toBe('NATIVE_HOOK')
    expect(hookOnly.data.items[0].outcomeState).toBe('UNKNOWN_FROM_HOOK_ONLY')
    expect(hookOnly.data.gaps).toContain('SOURCE_SESSION_ID_NOT_PROVIDED')
  }, 30_000)
})
