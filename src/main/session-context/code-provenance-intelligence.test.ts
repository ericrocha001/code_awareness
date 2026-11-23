import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { authenticatedAgentPrincipal, authorizeArtifactAgent } from '../continuum/agent-authority'
import { ArtifactStore } from '../continuum/artifact-store'
import { ContinuumService } from '../continuum/continuum-service'
import { GitOperationsService } from '../git-operations/git-operations-service'
import { executeGitOperationsTool } from '../git-operations/git-operations-mcp'
import { GitService } from '../core/git-service'
import { ChannelMcpAdapter } from '../mcp/channel-mcp-adapter'
import { createMcpHttpServer } from '../mcp/mcp-http-server'
import type { McpProjectContext } from '../mcp/project-mcp-context'
import { ValidationLedger } from '../validation-ledger/validation-ledger'
import { antigravityAppTranscriptPath } from './antigravity-app-locator'
import { executeSessionTool, type SessionToolName } from './mcp'
import { nativeObservationBatch } from './native-hook-ingestion'
import { installNativeHooks } from './native-hook-installation'
import { normalizeNativeHook, readNativeBinding } from './native-hooks'
import { digest } from './privacy'
import { registrySources } from './registry-sources'
import { SessionStore, sessionStorePath } from './store'

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

function gitExec(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

describe('Code Provenance Intelligence — U1-U4 integrated MCP HTTP/AJV acceptance', () => {
  it('navigates location -> COMMIT -> selective delivery -> Plan/Handoff/Proof -> literal rationale and back, with negative discriminatives', async () => {
    const [{ Client }, { StreamableHTTPClientTransport }, { AjvJsonSchemaValidator }] = await Promise.all([
      import('@modelcontextprotocol/sdk/client'),
      import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
      import('@modelcontextprotocol/sdk/validation/ajv')
    ])

    const base = mkdtempSync(join(tmpdir(), 'cpi-e2e-'))
    cleanup.push(() => safeRemove(base))
    const repoRoot = join(base, 'repo')
    const continuumDir = join(base, 'continuum')
    const storeBase = join(base, 'store')
    mkdirSync(repoRoot, { recursive: true })
    mkdirSync(continuumDir, { recursive: true })

    // Initialize real Git repository
    gitExec(repoRoot, ['init', '-b', 'main'])
    gitExec(repoRoot, ['config', 'user.email', 'cpi-test@example.com'])
    gitExec(repoRoot, ['config', 'user.name', 'CPI Test'])
    writeFileSync(join(repoRoot, 'src.ts'), 'export const initial = 1\n')
    gitExec(repoRoot, ['add', 'src.ts'])
    gitExec(repoRoot, ['commit', '-m', 'chore: initial commit'])
    const unreceiptedSha = gitExec(repoRoot, ['rev-parse', 'HEAD'])

    // Create feature branch for governed execution
    gitExec(repoRoot, ['checkout', '-b', 'feat/cpi-e2e'])

    const repositoryId = 'repo-cpi-e2e'
    const artifactStore = new ArtifactStore(join(continuumDir, 'continuum.sqlite'), repositoryId)
    cleanup.push(() => artifactStore.close())
    const continuum = new ContinuumService(artifactStore, undefined, () => true)

    const ledger = new ValidationLedger(join(base, 'ledger.sqlite'))
    cleanup.push(() => ledger.close())

    const gitService = new GitService()
    const gitOps = new GitOperationsService(repoRoot, gitService, {} as never, { repositoryId, isActive: () => true })

    const principal = authenticatedAgentPrincipal('MCP', () => true)
    const baseAuthority = authorizeArtifactAgent(principal, repositoryId, () => true)

    // Publish Plan & bind execution
    const executionId = 'exec-cpi-e2e-1'
    const plan = continuum.publish(
      `---\nname: "CPI E2E Plan"\ndescription: "Literal decision rationale for CPI feature."\nkind: EXECUTABLE_PLAN\nstatus: PENDING\nexecutionId: ${executionId}\n---\n\n# CPI E2E Plan\n\n## Decision\nUse selective delivery lookup without draining global backlog.\n`,
      undefined,
      baseAuthority
    )
    const snapshot = await gitOps.deliverySnapshot()
    const binding = await continuum.bindExecutionBranch(
      executionId,
      plan.artifactId,
      () => gitOps.deliverySnapshot()
    )
    const deliveryRequest = {
      bindingArtifactId: binding.artifactId,
      bindingRevision: binding.revision,
      planArtifactId: plan.artifactId,
      planRevision: plan.revision,
      executionId
    }

    const boundAuthority = authorizeArtifactAgent(principal, repositoryId, () => true, snapshot.worktreeId, {
      deliveryContext: deliveryRequest
    })

    // Governed commit via real executeGitOperationsTool with deliveryContext receipt
    writeFileSync(join(repoRoot, 'src.ts'), 'export const initial = 1\nexport const governed = 2\n')
    gitExec(repoRoot, ['add', 'src.ts'])
    const gitState = await gitOps.getState()
    const commitRes = await executeGitOperationsTool(
      gitOps,
      'commit_git_changes',
      {
        operationId: 'op-cpi-commit-1',
        message: 'feat: governed change',
        expectedHead: gitState.head,
        expectedIndexRevision: gitState.indexRevision,
        deliveryContext: deliveryRequest
      },
      request => continuum.prepareDeliveryContext(boundAuthority, request, () => gitOps.deliverySnapshot())
    )
    expect(commitRes.isError).toBeFalsy()
    const governedSha = JSON.parse(commitRes.content[0].text).sha as string

    // Add uncommitted line 3 for negative U1 test
    writeFileSync(join(repoRoot, 'src.ts'), 'export const initial = 1\nexport const governed = 2\nexport const dirty = 3\n')

    // Publish Handoff & record Ledger proof
    const resolvedCtx = await continuum.resolveExecutionContext(boundAuthority, deliveryRequest, () => gitOps.deliverySnapshot())
    const handoff = continuum.publish(
      `---\nname: "CPI E2E Handoff"\ndescription: "Handoff implementing CPI E2E Plan."\nkind: IMPLEMENTATION_HANDOFF\nstatus: COMPLETED\nrelations:\n  - artifactId: ${plan.artifactId}\n    kind: implements\n---\n\n# Handoff\n`,
      undefined,
      boundAuthority,
      resolvedCtx.anchor
    )
    const proof = ledger.recordProof({
      kind: 'TARGETED_TEST',
      producer: 'TESTER',
      status: 'PASSED',
      startedAt: '2026-11-23T12:00:00Z',
      finishedAt: '2026-11-23T12:00:01Z',
      durationMs: 1000,
      scope: ['src.ts'],
      summary: 'Targeted CPI proof passed',
      evidenceFor: [plan.artifactId]
    })

    const storePath = sessionStorePath(storeBase, repositoryId)
    const store = new SessionStore(storePath, repositoryId)
    cleanup.push(() => store.close())

    // Seed authorized Antigravity native session + JSONL transcript linked to executionId
    const convId = '019ba000-0000-7000-8000-000000000099'
    const agProfile = join(base, 'ag-profile')
    const txPath = antigravityAppTranscriptPath(agProfile, convId)
    const literalRationale = 'Literal session rationale: verified selective delivery path and reversible provenance.'
    mkdirSync(dirname(txPath), { recursive: true })
    writeFileSync(txPath, [
      { step_index: 0, type: 'USER_INPUT', source: 'USER', created_at: '2026-11-23T12:00:00Z', content: 'Implement selective delivery lookup' },
      { step_index: 1, type: 'PLANNER_RESPONSE', source: 'MODEL', created_at: '2026-11-23T12:00:05Z', content: literalRationale }
    ].map(record => JSON.stringify(record)).join('\n') + '\n')
    const summariesDb = new Database(join(agProfile, 'conversation_summaries.db'))
    try {
      summariesDb.exec('CREATE TABLE IF NOT EXISTS conversation_summaries (conversation_id TEXT PRIMARY KEY, workspace_uris TEXT, last_modified_time TEXT)')
      summariesDb.prepare('INSERT OR REPLACE INTO conversation_summaries (conversation_id, workspace_uris, last_modified_time) VALUES (?, ?, ?)').run(
        convId,
        JSON.stringify([pathToFileURL(repoRoot).href]),
        '2026-11-23 12:00:05+00:00'
      )
    } finally {
      summariesDb.close()
    }
    const hookCommandPath = join(repoRoot, 'native-hook.cjs')
    writeFileSync(hookCommandPath, '// test hook\n')
    installNativeHooks({
      repositoryId,
      record: { path: repoRoot, worktreeId: snapshot.worktreeId, generation: snapshot.worktreeGeneration, branch: 'feat/cpi-e2e', head: governedSha, detached: false, locked: false, missing: false, prunable: false },
      commandPath: hookCommandPath,
      nodePath: process.execPath,
      provider: 'antigravity',
      authorized: true
    })
    const nativeBinding = { ...readNativeBinding(join(repoRoot, '.code-awareness/native-hooks/antigravity/binding.json')), provider: 'antigravity' as const }
    const capturedSession = normalizeNativeHook(
      { conversationId: convId, workspacePaths: [repoRoot], hookEventName: 'Stop', transcriptPath: txPath },
      nativeBinding,
      new Date('2026-11-23T12:00:05Z'),
      {
        activation: {
          scope: 'CHECKOUT_OBSERVED',
          executionId,
          planArtifactId: plan.artifactId,
          planRevision: plan.revision,
          bindingArtifactId: binding.artifactId,
          bindingRevision: binding.revision,
          activationId: 'act-cpi-e2e-1',
          revision: 1
        }
      }
    )
    store.registry.apply(nativeObservationBatch(capturedSession), undefined)
    const providerConfigPath = join(dirname(storePath), 'session-context.provider.json')
    writeFileSync(providerConfigPath, JSON.stringify({
      repositoryId,
      nativeSources: { antigravityApp: { profile: agProfile, sessionHash: capturedSession.sessionId } }
    }))

    // Simulate global backlog cursor at tail on DELIVERY_CONTINUUM & DELIVERY_GIT
    store.registry.apply({
      repositoryId,
      source: 'DELIVERY_CONTINUUM',
      revision: 'rev-tail',
      cursor: '999999',
      status: 'PARTIAL',
      edges: []
    }, undefined, () => {})

    const reader = registrySources({
      repositoryId,
      root: repoRoot,
      continuum: () => continuum,
      ledger,
      github: {
        commitPullRequests: async () => [],
        getPullRequest: async () => { throw new Error('NOT_USED') },
        pullRequestCommits: async () => ({ commits: [], incomplete: false }) as never
      },
      gitDeliveries: (cursor, filter) => gitOps.deliveryProjectionPage(cursor, filter),
      networkAllowed: () => false,
      assertCurrent: () => {}
    })

    const sessionContext = {
      call: async (name: SessionToolName, args: unknown, allowArtifactMetadata = false) => {
        try {
          return await executeSessionTool(
            store,
            {},
            name,
            args,
            () => {},
            { worktreeId: snapshot.worktreeId, generation: snapshot.worktreeGeneration },
            [],
            undefined,
            repoRoot,
            undefined,
            reader,
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
        projectId: repositoryId,
        repoRoot,
        navigation: {} as McpProjectContext['navigation'],
        continuum,
        sessionContext
      },
      undefined,
      undefined,
      ledger
    )

    const server = createMcpHttpServer(adapter, () => {}, undefined, undefined, () => boundAuthority)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())))
    const address = server.address() as { port: number }

    const client = new Client({ name: 'cpi-e2e-client', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)))
    cleanup.push(() => client.close())

    const { tools } = await client.listTools()
    const ajv = new AjvJsonSchemaValidator()
    const validators = new Map(tools.map(t => [t.name, ajv.getValidator(t.inputSchema as any)]))

    const mcpCall = async (name: string, args: Record<string, unknown>) => {
      const v = validators.get(name)
      if (v) expect(v(args).valid).toBe(true)
      const res = await client.callTool({ name, arguments: args })
      const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}'
      return { isError: res.isError === true, data: JSON.parse(text) }
    }

    // U1 Positive: DETAIL on committed line without checkpoint -> linkStrength: UNKNOWN + gitStatus: COMMIT_OBSERVED + nextStep COMMIT
    const provDetail = await mcpCall('inspect_code_provenance', { file: 'src.ts', startLine: 2, endLine: 2, mode: 'DETAIL' })
    expect(provDetail.isError).toBe(false)
    expect(provDetail.data.linkStrength).toBe('UNKNOWN')
    expect(provDetail.data.checkpointId).toBeNull()
    expect(provDetail.data.gitStatus).toBe('COMMIT_OBSERVED')
    expect(provDetail.data.commit).toBe(governedSha)
    expect(provDetail.data.nextStep).toEqual({
      tool: 'discover_execution_context',
      arguments: { selector: { type: 'COMMIT', id: governedSha } }
    })

    // U1 Negative: uncommitted line has NO nextStep; multi-commit range throws AMBIGUOUS_PROVENANCE_SELECTION
    const provDirty = await mcpCall('inspect_code_provenance', { file: 'src.ts', startLine: 3, endLine: 3, mode: 'DETAIL' })
    expect(provDirty.isError).toBe(false)
    expect(provDirty.data.gitStatus).toBe('UNCOMMITTED')
    expect(provDirty.data.nextStep).toBeUndefined()

    const provAmbiguous = await mcpCall('inspect_code_provenance', { file: 'src.ts', startLine: 1, endLine: 2, mode: 'DETAIL' })
    expect(provAmbiguous.isError).toBe(true)
    expect(provAmbiguous.data.code).toBe('AMBIGUOUS_PROVENANCE_SELECTION')

    // U2 Selective lookup despite DELIVERY_CONTINUUM cursor at 999999
    expect((await gitOps.deliveryProjectionPage(undefined, { commitSha: governedSha })).observations).toHaveLength(1)
    const refreshRes = await mcpCall('refresh_agent_sessions', {
      contextSelector: provDetail.data.nextStep.arguments.selector
    })
    expect(refreshRes.isError).toBe(false)
    expect(refreshRes.data.state).toBe('RECONCILED')
    // Global cursor must NOT be overwritten
    expect(store.registry.source('DELIVERY_CONTINUUM')?.cursor).toBe('999999')

    const discoverAll = async (selector: Record<string, unknown>) => {
      const nodes: any[] = []
      const edges: any[] = []
      let firstPage: any
      let cursor: string | undefined
      for (let page = 0; page < 20; page++) {
        const res = await mcpCall('discover_execution_context', {
          selector,
          mode: 'RELATION_DETAIL',
          ...(cursor ? { cursor } : {})
        })
        expect(res.isError).toBe(false)
        if (!firstPage) firstPage = res
        nodes.push(...res.data.nodes)
        edges.push(...res.data.edges)
        cursor = res.data.nextCursor
        if (!cursor) break
      }
      return { nodes, edges, firstPage }
    }

    // U2 Forward traversal: COMMIT -> EXECUTION -> PLAN/HANDOFF/PROOF
    const { nodes: forwardNodes, firstPage: forward } = await discoverAll(provDetail.data.nextStep.arguments.selector)
    expect(forward.data.authorship).toBe('NOT_INFERRED')
    expect(forwardNodes.some((n: any) => n.type === 'ARTIFACT' && n.id === plan.artifactId)).toBe(true)
    expect(forwardNodes.some((n: any) => n.type === 'ARTIFACT' && n.id === handoff.artifactId)).toBe(true)

    // U2 Reverse traversal: ARTIFACT (Plan) -> COMMIT & PROOF
    await mcpCall('refresh_agent_sessions', {
      contextSelector: { type: 'ARTIFACT', id: plan.artifactId }
    })
    const { nodes: reverseNodes } = await discoverAll({ type: 'ARTIFACT', id: plan.artifactId })
    expect(reverseNodes.some((n: any) => n.type === 'COMMIT' && n.id === governedSha)).toBe(true)
    expect(reverseNodes.some((n: any) => n.type === 'PROOF' && n.id === proof.proofId)).toBe(true)

    // U2 Negative: unreceipted commit remains UNRESOLVED (no synthetic edge)
    const unreceipted = await mcpCall('discover_execution_context', {
      selector: { type: 'COMMIT', id: unreceiptedSha },
      mode: 'RELATION_DETAIL'
    })
    expect(unreceipted.isError).toBe(false)
    expect(unreceipted.data.delivery.state).toBe('UNRESOLVED')
    expect(unreceipted.data.edges).toEqual([])

    // U3 Literal rationale on demand via deepen selector (get_artifact)
    const planNode = forwardNodes.find((n: any) => n.type === 'ARTIFACT' && n.id === plan.artifactId && n.deepen)
    expect(planNode).toBeDefined()
    const literalPlan = await mcpCall(planNode.deepen.tool, planNode.deepen.arguments)
    expect(literalPlan.isError).toBe(false)
    expect(literalPlan.data.rawMarkdown).toContain('Use selective delivery lookup without draining global backlog.')

    // U3/U4 End-to-end: COMMIT -> EXECUTION -> SESSION -> EVENT -> literal content
    const sessionNode = forwardNodes.find((n: any) => n.type === 'SESSION' && n.id === capturedSession.sessionId)
    expect(sessionNode).toBeDefined()
    expect(sessionNode.provider).toBe('antigravity-native')
    expect(sessionNode.deepen?.tool).toBe('inspect_agent_session')

    // Selector emitted by discover_execution_context reaches hook metadata without leaking raw sourceSessionId
    const sessionHookOnly = await mcpCall(sessionNode.deepen.tool, sessionNode.deepen.arguments)
    expect(sessionHookOnly.isError).toBe(false)
    expect(sessionHookOnly.data.contentAvailability).toBe('SOURCE_UNAVAILABLE')

    // Authorized literal selector via list_agent_sessions -> inspect_agent_session -> list_agent_session_events -> read_agent_session_event
    const listedSessions = await mcpCall('list_agent_sessions', {
      worktreeId: snapshot.worktreeId,
      generation: snapshot.worktreeGeneration,
      agent: 'antigravity'
    })
    expect(listedSessions.isError).toBe(false)
    const grantedSession = listedSessions.data.sessions.find((s: any) => s.providerSessionId === sessionNode.id && s.sourceSessionId === convId)
    expect(grantedSession?.deepen?.tool).toBe('inspect_agent_session')

    const inspSession = await mcpCall(grantedSession.deepen.tool, grantedSession.deepen.arguments)
    expect(inspSession.isError).toBe(false)
    expect(inspSession.data.source).toBe('ANTIGRAVITY_APP_LOCAL_TRANSCRIPT_V1')
    expect(inspSession.data.revision).toBeDefined()

    const sessionEvents = await mcpCall(inspSession.data.events.tool, {
      ...inspSession.data.events.arguments,
      types: ['AGENT_UPDATE']
    })
    expect(sessionEvents.isError).toBe(false)
    expect(sessionEvents.data.events).toHaveLength(1)
    const eventReadArgs = {
      ...grantedSession.deepen.arguments,
      expectedRevision: inspSession.data.revision,
      eventId: sessionEvents.data.events[0].eventId
    }

    const literalEvent = await mcpCall('read_agent_session_event', eventReadArgs)
    expect(literalEvent.isError).toBe(false)
    expect(literalEvent.data.content).toBe(literalRationale)
    expect(literalEvent.data.transcriptImported).toBe(false)
    expect(store.count()).toBe(0)

    // Reverse traversal: SESSION -> EXECUTION -> COMMIT (preserving OBSERVED non-causal classification, Q27 INDETERMINADO)
    const { nodes: sessionReverseNodes, edges: sessionReverseEdges, firstPage: sessionReverseFirst } = await discoverAll(sessionNode.selector)
    expect(sessionReverseNodes.some((n: any) => n.type === 'COMMIT' && n.id === governedSha)).toBe(true)
    expect(sessionReverseFirst.data.authorship).toBe('NOT_INFERRED')
    expect(sessionReverseEdges.some((e: any) => e.evidenceKind === 'EXECUTION_CONTEXT_OBSERVED' && e.confidenceClass === 'OBSERVED')).toBe(true)
    expect(sessionReverseEdges.some((e: any) => e.evidenceKind === 'NATIVE_GIT_CAUSAL' || e.confidenceClass === 'VERIFIED_CAUSAL')).toBe(false)

    // Negative discriminative: stale expectedRevision rejects without returning literal content
    const staleEventRead = await mcpCall('read_agent_session_event', {
      ...eventReadArgs,
      expectedRevision: inspSession.data.revision + 1
    })
    expect(staleEventRead.isError).toBe(true)
    expect(staleEventRead.data.code).toBe('REVISION_CONFLICT')
    expect(JSON.stringify(staleEventRead.data)).not.toContain(literalRationale)

    // Negative discriminative: revoking antigravityApp grant stops at SOURCE_UNAVAILABLE without returning literal content
    writeFileSync(providerConfigPath, JSON.stringify({ repositoryId, nativeSources: {} }))
    const revokedInspect = await mcpCall(grantedSession.deepen.tool, grantedSession.deepen.arguments)
    expect(revokedInspect.isError).toBe(false)
    expect(revokedInspect.data.contentAvailability).toBe('SOURCE_UNAVAILABLE')
    expect(revokedInspect.data.sourceDiagnostic).toBe('PROFILE_UNAVAILABLE')
    const revokedRead = await mcpCall('read_agent_session_event', eventReadArgs)
    expect(revokedRead.isError).toBe(true)
    expect(revokedRead.data.code).toBe('SOURCE_UNAVAILABLE')
    expect(JSON.stringify(revokedRead.data)).not.toContain(literalRationale)

    // Cross-repo isolation check
    expect(() => new SessionStore(storePath, 'foreign-repo', true)).toThrow('REPOSITORY_MISMATCH')
  }, 60_000)
})
