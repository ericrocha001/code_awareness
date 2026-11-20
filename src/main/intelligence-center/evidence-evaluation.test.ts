import Database from 'better-sqlite3'
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

function applyQ23Evaluation(input: {
  contract: { id: string; conclusionCriteria: string; indeterminacyCondition: string; action: string }
  catalogVersion: number
  scope: { repositoryId: string; sessionId: string; worktreeId: string; generation: string }
  hookObservation: { eventId: string; event: string; tool?: string; model?: string; context?: unknown }
  toolFailure: { eventId: string; tool?: string; content: string; payloadDigest: string }
  reportedUsageAvailable: boolean
}) {
  const observedBasis = [
    `OBSERVADO: hook ${input.hookObservation.event} (${input.hookObservation.eventId}) para tool=${input.hookObservation.tool ?? 'unknown'} não contém identidade de modelo/effort nem envelope de contexto entregue.`,
    `OBSERVADO: falha literal de ferramenta (${input.toolFailure.eventId}, digest=${input.toolFailure.payloadDigest}) em ${input.toolFailure.tool ?? 'tool'}: ${input.toolFailure.content.slice(0, 120)}`
  ]
  const missingModelOrContext = !input.hookObservation.model || !input.hookObservation.context || !input.reportedUsageAvailable
  return {
    questionId: input.contract.id,
    catalogVersion: input.catalogVersion,
    scope: input.scope,
    conclusion: {
      status: missingModelOrContext ? 'INDETERMINADA' : 'DETERMINADA',
      attribution: missingModelOrContext ? 'INDETERMINADO' : 'COMBINADA',
      summary: 'Observação de hook sem modelo/contexto e falha literal de ferramenta não autorizam atribuição exclusiva ao modelo nem distinção definitiva entre Harness e modelo.'
    },
    observedBasis,
    inferences: [
      'AVALIAÇÃO: ausência de modelo/effort e do contexto efetivamente entregue impede atribuir erro ao modelo por exclusão.'
    ],
    supportingRefs: [input.hookObservation.eventId, input.toolFailure.eventId],
    conflictingRefs: [],
    coverageAndRevisions: {
      nativeHook: 'OBSERVED',
      reportedUsage: input.reportedUsageAvailable ? 'AVAILABLE' : 'UNAVAILABLE'
    },
    determiningGap: 'Ausência de modelo/effort observado e do contexto efetivamente entregue antes da falha.',
    recommendedAction: input.contract.action
  }
}

describe('Intelligence Center — Evidence Evaluation public MCP acceptance', () => {
  it('delivers Q23/Q06 directly via public MCP, drives structural search -> literal deepen, and sustains indeterminacy without LLM or new persistence', async () => {
    const [{ Client }, { StreamableHTTPClientTransport }, { AjvJsonSchemaValidator }] = await Promise.all([
      import('@modelcontextprotocol/sdk/client'),
      import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
      import('@modelcontextprotocol/sdk/validation/ajv')
    ])

    const base = mkdtempSync(join(tmpdir(), 'ic-eval-public-'))
    cleanup.push(() => safeRemove(base))
    const root = join(base, 'repo')
    mkdirSync(join(root, '.git'), { recursive: true })
    writeFileSync(join(root, '.git/HEAD'), 'ref: refs/heads/main\n')

    const repositoryId = 'repo-ic-eval'
    const storePath = sessionStorePath(base, repositoryId)
    const target = { worktreeId: nativeDigest(`wt:${repositoryId}`), generation: nativeDigest(`gen:${repositoryId}`) }
    const profile = join(base, 'codex-profile')
    const accHash = nativeDigest(JSON.stringify(['user-ic', 'acc-ic']))

    const s1Uuid = '01a1e000-0000-7000-8000-000000000201'
    const dayFor = (u: string) => new Date(Number.parseInt(u.replaceAll('-', '').slice(0, 12), 16)).toISOString().slice(0, 10).split('-')
    const sessionDir = join(profile, 'sessions', ...dayFor(s1Uuid))
    mkdirSync(sessionDir, { recursive: true })

    writeFileSync(join(sessionDir, `rollout-2026-11-20T10-00-00-${s1Uuid}.jsonl`), [
      JSON.stringify({
        timestamp: '2026-11-20T10:00:00Z',
        type: 'session_meta',
        payload: { id: s1Uuid, session_id: s1Uuid, account_scoped: true, creator_user_id: 'user-ic', creator_account_id: 'acc-ic', cwd: root, runtime_workspace_roots: [root], cli_version: '0.169.0-alpha.11.1' }
      }),
      JSON.stringify({ timestamp: '2026-11-20T10:00:01Z', type: 'turn_context', payload: { turn_id: 'turn-ic-1', cwd: root } }),
      JSON.stringify({ timestamp: '2026-11-20T10:00:02Z', type: 'response_item', payload: { type: 'function_call', name: 'lint_tool', call_id: 'call-ic-1', arguments: '{"target":"schema"}' } }),
      JSON.stringify({ timestamp: '2026-11-20T10:00:03Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-ic-1', output: 'Exit code: 1\nTOOL_CONTRACT_ERROR: missing required field schemaVersion' } })
    ].join('\n') + '\n')

    const s1Hash = nativeDigest(JSON.stringify([repositoryId, 'codex', s1Uuid]))
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
      invocationId: nativeDigest('inv-ic-shell-1')
    }
    const hookBody = { ...hookFacts, observedAt: '2026-11-20T10:00:02.500Z', eventId: nativeDigest(JSON.stringify(hookFacts)) }
    const hookShell: NativeHookEnvelope = { ...hookBody, digest: nativeDigest(JSON.stringify(hookBody)) }
    seedStore.registry.apply(nativeObservationBatch(hookShell), undefined)
    seedStore.registry.apply({ repositoryId, source: 'NATIVE_HOOK', revision: nativeDigest('ic-hook-obs'), status: 'OBSERVED', edges: [] }, undefined)
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
    })
    const server = createMcpHttpServer(adapter, () => {}, undefined, undefined, () => authority)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())))
    const address = server.address() as { port: number }

    const mcpClient = new Client({ name: 'ic-eval-client', version: '1' })
    cleanup.push(() => mcpClient.close())
    await mcpClient.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)))

    const { tools } = await mcpClient.listTools()
    const ajv = new AjvJsonSchemaValidator()
    const validators = new Map<string, ReturnType<typeof ajv.getValidator>>()
    for (const t of tools) validators.set(t.name, ajv.getValidator(t.inputSchema))

    const contractTool = tools.find(t => t.name === 'get_evidence_evaluation_contract')
    expect(contractTool).toBeDefined()
    expect(contractTool!.annotations?.readOnlyHint).toBe(true)
    expect(contractTool!.inputSchema).not.toHaveProperty('oneOf')

    const mcpCall = async (name: string, args: Record<string, unknown>) => {
      const validate = validators.get(name)!
      const check = validate(args)
      expect(check.valid, `AJV rejected ${name}(${JSON.stringify(args)}): ${check.errorMessage}`).toBe(true)
      const res = await mcpClient.callTool({ name, arguments: args })
      return { isError: !!res.isError, data: JSON.parse((res.content as Array<{ text: string }>)[0].text) }
    }

    // 1. Direct contract lookup by ID (without prior discovery or knowledge of the 29 documents)
    const q23Res = await mcpCall('get_evidence_evaluation_contract', { questionId: 'Q23' })
    expect(q23Res.isError).toBe(false)
    expect(q23Res.data.catalogVersion).toBe(1)
    expect(q23Res.data.contract.id).toBe('Q23')
    expect(q23Res.data.questions).toBeUndefined()
    expect(q23Res.data.acquisition.channels.some((c: { id: string; tools: string[] }) => c.id === 'SESSION_CONTEXT' && c.tools.includes('search_agent_session_evidence'))).toBe(true)
    expect(q23Res.data.evaluationProtocol.steps).toHaveLength(5)

    // Q06 direct lookup works identically and selectively
    const q06Res = await mcpCall('get_evidence_evaluation_contract', { questionId: 'Q06' })
    expect(q06Res.isError).toBe(false)
    expect(q06Res.data.contract.id).toBe('Q06')

    // 2. Index authorized session through public MCP and acquire evidence via structural search -> literal deepen
    const s1Native = { provider: 'codex-native' as const, id: s1Hash, ...target }
    expect((await mcpCall('refresh_agent_sessions', { nativeSession: s1Native, sourceSessionId: s1Uuid })).data.state).toBe('READY')

    const hookSearch = await mcpCall('search_agent_session_evidence', {
      source: 'NATIVE_HOOK',
      hookEvents: ['PreToolUse'],
      tool: 'SHELL',
      limit: 1
    })
    expect(hookSearch.isError).toBe(false)
    expect(hookSearch.data.hits).toHaveLength(1)
    const hookDeepen = await mcpCall(hookSearch.data.hits[0].deepen.tool, hookSearch.data.hits[0].deepen.arguments)
    expect(hookDeepen.isError).toBe(false)
    expect(hookDeepen.data.events).toHaveLength(1)
    const observedHook = hookDeepen.data.events[0]
    expect(observedHook.model).toBeUndefined()
    expect(observedHook.content).toBeUndefined()

    const errSearch = await mcpCall('search_agent_session_evidence', {
      worktreeId: target.worktreeId,
      generation: target.generation,
      types: ['ERROR'],
      isError: true,
      limit: 1
    })
    expect(errSearch.isError).toBe(false)
    expect(errSearch.data.hits).toHaveLength(1)
    const errDeepen = await mcpCall(errSearch.data.hits[0].deepen.tool, errSearch.data.hits[0].deepen.arguments)
    expect(errDeepen.isError).toBe(false)
    expect(errDeepen.data.content).toContain('TOOL_CONTRACT_ERROR')

    // 3. Apply Q23 evaluation criteria on observed evidence (no LLM, no auto-persistence)
    const snapshotCounts = () => {
      const db = new Database(storePath, { readonly: true })
      try {
        return {
          tables: db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all(),
          edges: (db.prepare('SELECT COUNT(*) AS c FROM registry_edges').get() as { c: number }).c,
          nativeEvents: (db.prepare('SELECT COUNT(*) AS c FROM native_reference_events').get() as { c: number }).c
        }
      } finally {
        db.close()
      }
    }
    const before = snapshotCounts()

    const q23SecondRead = await mcpCall('get_evidence_evaluation_contract', { questionId: 'Q23' })
    expect(q23SecondRead.isError).toBe(false)

    const after = snapshotCounts()
    expect(after).toEqual(before)

    const evaluation = applyQ23Evaluation({
      contract: q23Res.data.contract,
      catalogVersion: q23Res.data.catalogVersion,
      scope: { repositoryId, sessionId: s1Uuid, ...target },
      hookObservation: {
        eventId: observedHook.eventId,
        event: observedHook.event ?? 'PreToolUse',
        tool: observedHook.tool,
        model: observedHook.model,
        context: observedHook.content
      },
      toolFailure: {
        eventId: errDeepen.data.eventId,
        tool: errSearch.data.hits[0].tool,
        content: errDeepen.data.content,
        payloadDigest: errDeepen.data.payloadDigest
      },
      reportedUsageAvailable: false
    })

    expect(evaluation.questionId).toBe('Q23')
    expect(evaluation.catalogVersion).toBe(1)
    expect(evaluation.conclusion.status).toBe('INDETERMINADA')
    expect(evaluation.conclusion.attribution).toBe('INDETERMINADO')
    expect(evaluation.conclusion.attribution).not.toBe('MODELO')
    expect(evaluation.supportingRefs).toEqual([hookShell.eventId, errDeepen.data.eventId])
    expect(evaluation.determiningGap).toContain('modelo/effort')
  }, 30_000)
})
