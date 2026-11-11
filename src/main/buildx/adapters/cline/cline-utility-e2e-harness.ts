import { execSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { app } from 'electron'
import type { BranchInventory } from '../../../../shared/types/branch-orchestration-types'
import type { ExecutorEvent } from '../../../../shared/types/buildx/execution-types'
import type { CliPolicy } from '../../../../shared/types/cli-policy-types'
import { ChannelMcpAdapter } from '../../../mcp/channel-mcp-adapter'
import { RuntimeIdentityProvider } from '../../../runtime-identity/runtime-identity-provider'
import { captureValidationSource, validationSourceFingerprint } from '../../../validation-execution/validation-source'
import { ValidationLedger } from '../../../validation-ledger/validation-ledger'
import type { GitOperationsPort } from '../../execution/workspace-binding-service'
import { SessionMemoryCentralService } from '../../smc/session-memory-central-service'
import { UnitFlowRuntimeFacade } from '../../unitflow/unitflow-runtime-facade'
import {
  ClineSdkExecutorAdapter,
  createElectronUtilityLauncher,
  probeFreeClineCatalogSelection
} from './cline-sdk-executor-adapter'

interface HarnessPayload {
  readonly mode: 'gates' | 'real-unit'
  readonly workerPath: string
  readonly hardKillWorkerPath?: string
}

function parseMcpResult(res: any): any {
  const txt = res?.content?.[0]?.text
  if (!txt) throw new Error('Empty MCP response')
  const parsed = JSON.parse(txt)
  if (res?.isError) {
    throw new Error(`MCP_ERROR: ${parsed.code ?? 'UNKNOWN'}: ${parsed.message ?? txt}`)
  }
  return parsed
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err: any) {
    return err?.code === 'EPERM'
  }
}

async function waitForAdapterTerminal(
  adapter: ClineSdkExecutorAdapter,
  repositoryId: string,
  sessionId: string,
  attemptId: string,
  timeoutMs = 30_000
) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const obs = await adapter.observeAttempt({ repositoryId, sessionId, attemptId })
    if (obs.phase === 'TERMINAL' || obs.phase === 'TERMINATION_UNCONFIRMED') {
      return obs
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for attempt ${attemptId} terminal state`)
}

function createGitOpsForWorktrees(repoId: string, siblingWorktreeDir: string, branchName: string): GitOperationsPort {
  return {
    getBranchInventory: async (): Promise<BranchInventory> => {
      const source = await captureValidationSource(siblingWorktreeDir, repoId)
      return {
        repositoryId: repoId,
        observedAt: new Date().toISOString(),
        revision: '1',
        source: 'GIT_LOCAL',
        coverage: 'COMPLETE',
        branches: [
          {
            key: branchName,
            repositoryId: repoId,
            name: branchName,
            ref: `refs/heads/${branchName}`,
            namespace: 'LOCAL',
            head: source.head,
            upstream: null,
            generation: source.generation,
            revision: '1',
            creation: { at: new Date().toISOString(), source: 'APP_RECEIPT' },
            lastCommitAt: new Date().toISOString(),
            worktrees: [{ worktreeId: source.worktreeId, generation: source.generation }]
          }
        ],
        worktrees: [
          {
            worktreeId: source.worktreeId,
            generation: source.generation,
            path: siblingWorktreeDir,
            branch: branchName,
            head: source.head,
            detached: false,
            locked: false,
            missing: false,
            prunable: false,
            creation: { at: new Date().toISOString(), quality: 'ESTIMATED', source: 'ADMIN_DIRECTORY_BIRTHTIME' }
          }
        ],
        unassignedWorktrees: []
      }
    },
    getCoordinationSnapshot: async () => ({ reference: false })
  }
}

function createDisposableWorktreeRepo(baseDir: string, seedFileName: string, seedFileContent: string) {
  const mainRepo = path.join(baseDir, 'main')
  const siblingWt = path.join(baseDir, 'sibling')
  fs.mkdirSync(mainRepo, { recursive: true })
  execSync('git init -q -b main', { cwd: mainRepo })
  execSync('git config user.email "u2-cline@test.local"', { cwd: mainRepo })
  execSync('git config user.name "BuildX U2 Test"', { cwd: mainRepo })
  fs.writeFileSync(path.join(mainRepo, 'README.md'), '# U2 Cline Test\n', 'utf8')
  execSync('git add README.md', { cwd: mainRepo })
  execSync('git commit -qm "baseline"', { cwd: mainRepo })
  execSync(`git worktree add -qb feat/u2-work "${siblingWt}"`, { cwd: mainRepo })
  fs.writeFileSync(path.join(siblingWt, seedFileName), seedFileContent, 'utf8')
  execSync(`git add "${seedFileName}"`, { cwd: siblingWt })
  execSync('git commit -qm "seed target file"', { cwd: siblingWt })
  return { mainRepo, siblingWt }
}

function writeMockProvidersSettings(settingsFilePath: string): void {
  fs.mkdirSync(path.dirname(settingsFilePath), { recursive: true })
  const payload = {
    version: 1,
    lastUsedProvider: 'cline',
    modes: {},
    providers: {
      cline: {
        settings: {
          provider: 'cline',
          auth: {
            accessToken: 'workos:mock-e2e-access-token',
            refreshToken: 'workos:mock-e2e-refresh-token',
            expiresAt: Date.now() + 3_600_000,
            accountId: 'usr-e2e-mock-1'
          }
        },
        updatedAt: new Date().toISOString(),
        tokenSource: 'oauth'
      }
    }
  }
  fs.writeFileSync(settingsFilePath, JSON.stringify(payload, null, 2), 'utf8')
}

async function startMockClineServer(options: {
  readonly modelId: string
  readonly onCompletionMode: () => 'edit_and_escape' | 'quota_429' | 'hang_stream'
}) {
  let chatCallIndex = 0
  let transactionEmitted = false
  const openStreams = new Set<http.ServerResponse>()
  const observedRequestModels: string[] = []
  const observedClientHeaders: string[] = []

  const server = http.createServer(async (req, res) => {
    const urlPath = (req.url ?? '/').split('?')[0]

    if (req.method === 'GET' && urlPath === '/api/v1/ai/cline/recommended-models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          recommended: [],
          free: [{ id: options.modelId, name: 'Mock Free Coder', description: '', tags: [] }],
          clinePass: [],
          clineCloud: []
        })
      )
      return
    }

    if (req.method === 'GET' && urlPath === '/api/v1/ai/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          cline: {
            models: {
              [options.modelId]: {
                name: 'Mock Free Coder',
                tool_call: true,
                cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
                modalities: { input: ['text'], output: ['text'] }
              }
            }
          }
        })
      )
      return
    }

    if (req.method === 'GET' && /\/api\/v1\/users\/[^/]+\/balance$/.test(urlPath)) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ success: true, data: { balance: -1200, userId: 'usr-e2e-mock-1' } }))
      return
    }

    if (req.method === 'GET' && /\/api\/v1\/users\/[^/]+\/usages$/.test(urlPath)) {
      res.writeHead(200, { 'content-type': 'application/json' })
      const items = transactionEmitted
        ? [
            {
              id: 'usg-mock-e2e-1',
              aiInferenceProviderName: 'openrouter',
              aiModelName: 'Mock Free Coder',
              aiModelTypeName: 'cline-free',
              promptTokens: 45,
              completionTokens: 10,
              totalTokens: 55,
              creditsUsed: 0,
              costUsd: 810,
              createdAt: new Date().toISOString(),
              generationId: 'gen-1',
              metadata: { additionalProp1: '', additionalProp2: '', additionalProp3: '' },
              organizationId: '',
              userId: 'usr-e2e-mock-1'
            }
          ]
        : []
      res.end(JSON.stringify({ success: true, data: { items } }))
      return
    }

    if (req.method === 'POST' && urlPath === '/api/v1/chat/completions') {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      observedRequestModels.push(String(body.model ?? ''))
      observedClientHeaders.push(String(req.headers['x-client-type'] ?? ''))

      const mode = options.onCompletionMode()

      if (mode === 'quota_429') {
        res.writeHead(429, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'Free model rate limit reached (429)' } }))
        return
      }

      if (mode === 'hang_stream') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache'
        })
        openStreams.add(res)
        res.write(`data: ${JSON.stringify({ id: 'hang-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`)
        res.on('close', () => openStreams.delete(res))
        return
      }

      chatCallIndex++
      transactionEmitted = true
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache'
      })

      if (chatCallIndex === 1) {
        const escapeArgs = JSON.stringify({
          path: '../escaped-outside.txt',
          old_text: null,
          insert_line: 1,
          new_text: 'PWNED'
        })
        const validArgs = JSON.stringify({
          path: 'confined-edit.txt',
          old_text: 'INITIAL_CONTENT',
          new_text: 'EDITED_VIA_CLINE_UTILITY_PROCESS'
        })
        const toolEvents = [
          {
            id: 'chatcmpl-1',
            object: 'chat.completion.chunk',
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  tool_calls: [
                    { index: 0, id: 'call_escape', type: 'function', function: { name: 'editor', arguments: escapeArgs } },
                    { index: 1, id: 'call_confined', type: 'function', function: { name: 'editor', arguments: validArgs } }
                  ]
                },
                finish_reason: null
              }
            ]
          },
          {
            id: 'chatcmpl-1',
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]
          }
        ]
        for (const frame of toolEvents) res.write(`data: ${JSON.stringify(frame)}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }

      // Second turn: confirm tool results included PATH_OUTSIDE_BOUND_WORKTREE for escape attempt
      const msgText = JSON.stringify(body.messages ?? [])
      const escapeWasBlocked = msgText.includes('PATH_OUTSIDE_BOUND_WORKTREE')
      const finalText = escapeWasBlocked ? 'CONFINED_EDIT_AND_BLOCK_VERIFIED' : 'ESCAPE_NOT_BLOCKED'

      const doneEvents = [
        {
          id: 'chatcmpl-2',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { role: 'assistant', content: finalText }, finish_reason: null }]
        },
        {
          id: 'chatcmpl-2',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 45, completion_tokens: 10, total_tokens: 55 }
        }
      ]
      for (const frame of doneEvents) res.write(`data: ${JSON.stringify(frame)}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }

    res.writeHead(404)
    res.end('Not found')
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address() as { port: number }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    observedRequestModels,
    observedClientHeaders,
    resetTurns: () => {
      chatCallIndex = 0
      transactionEmitted = false
    },
    close: async () => {
      for (const s of openStreams) {
        try { s.end() } catch {}
      }
      openStreams.clear()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}

async function runGatesInElectron(payload: HarnessPayload): Promise<any> {
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cline-electron-gates-'))
  const smcDir = path.join(workRoot, 'smc')
  const ledgerDir = path.join(workRoot, 'ledger')
  const stagingDir = path.join(workRoot, 'staging')
  const runtimeStorageDir = path.join(workRoot, 'cline-runtime')
  const settingsFile = path.join(workRoot, 'cline-config', 'settings', 'providers.json')
  writeMockProvidersSettings(settingsFile)

  let mockMode: 'edit_and_escape' | 'quota_429' | 'hang_stream' = 'edit_and_escape'
  const mockServer = await startMockClineServer({
    modelId: 'free/local-mock-coder',
    onCompletionMode: () => mockMode
  })

  const smcService = new SessionMemoryCentralService(smcDir)
  const runtimeIdentity = new RuntimeIdentityProvider({ instanceId: 'u2-electron-test' })
  const ledger = new ValidationLedger(ledgerDir, runtimeIdentity)

  try {
    const repoId = 'e1c8a999-6d73-4f56-83a3-fbcd78c9c19d'
    const repoArea = path.join(workRoot, 'git-a')
    const { siblingWt } = createDisposableWorktreeRepo(repoArea, 'confined-edit.txt', 'INITIAL_CONTENT\n')
    const gitOps = createGitOpsForWorktrees(repoId, siblingWt, 'feat/u2-work')
    const yoloPolicy: CliPolicy = {
      mode: 'AUTONOMOUS_TRUSTED',
      scope: 'REPOSITORY_WORKTREES',
      revision: 'yolo-e2e-1',
      rule: 'local-repository-worktree-trust'
    }

    // Gate 1 & Gate 2 in REAL utilityProcess + REAL @cline/sdk ClineCore
    const probed = await probeFreeClineCatalogSelection({
      workerPath: payload.workerPath,
      apiBaseUrl: mockServer.baseUrl,
      settingsFilePath: settingsFile,
      requireAuth: true
    })
    if (probed.selectedModelId !== 'free/local-mock-coder') {
      throw new Error(`Unexpected probed model: ${probed.selectedModelId}`)
    }

    const adapter = new ClineSdkExecutorAdapter({
      repositoryId: repoId,
      modelId: probed.selectedModelId,
      workerPath: payload.workerPath,
      runtimeStorageBaseDir: runtimeStorageDir,
      apiBaseUrl: mockServer.baseUrl,
      settingsFilePath: settingsFile,
      getPolicy: () => yoloPolicy
    })

    const facade = new UnitFlowRuntimeFacade({
      repositoryId: repoId,
      repoRoot: path.join(repoArea, 'main'),
      smcService,
      gitOperations: gitOps,
      executor: adapter,
      validationLedger: ledger,
      stagingDirectory: stagingDir
    })

    const mcpAdapter = new ChannelMcpAdapter(
      {
        projectId: repoId,
        repoRoot: siblingWt,
        navigation: {
          discoverRepository: async () => ({ directories: [] }),
          getRelationships: async () => ({ files: [] }),
          inspectFiles: async () => ({ files: [] }),
          readCode: async () => [],
          getReferences: async () => ({ targets: [] }),
          getSymbolDependencies: async () => ({ sources: [] }),
          getSymbolHierarchy: async () => ({ targets: [] })
        } as any,
        sessionMemoryCentral: smcService,
        unitflowRuntime: facade
      },
      undefined,
      runtimeIdentity,
      ledger
    )

    const sessionId = randomUUID()
    const planId = randomUUID()
    const unitId = randomUUID()
    const reservationId = randomUUID()
    const attemptId = randomUUID()
    const stageOpId = randomUUID()

    parseMcpResult(await mcpAdapter.callTool('create_buildx_session', { sessionId }))
    const bound = parseMcpResult(
      await mcpAdapter.callTool('bind_unitflow_workspace', {
        sessionId,
        worktreeId: (await gitOps.getBranchInventory()).worktrees[0].worktreeId
      })
    )
    parseMcpResult(
      await mcpAdapter.callTool('prepare_unitflow_plan', {
        sessionId,
        planId,
        title: 'Gate 1-2 Plan',
        objective: 'Verify utilityProcess ClineCore confined editing',
        units: [
          {
            unitId,
            position: 0,
            title: 'Edit confined target',
            objective: 'Edit confined-edit.txt inside worktree only',
            acceptanceCriteria: 'confined-edit.txt edited, escape blocked, proof PASSED'
          }
        ]
      })
    )

    const receivedEvents: ExecutorEvent[] = []
    adapter.subscribe(attemptId, (ev) => receivedEvents.push(ev))

    const started = await facade.startNextUnit(sessionId, planId, {
      reservationId,
      attemptId,
      stageOperationId: stageOpId,
      executorSelection: adapter.identity
    })
    if (started.status !== 'RUNNING') {
      throw new Error(`Expected RUNNING start status, got ${started.status}: ${started.reason}`)
    }

    const obsWaitA = await waitForAdapterTerminal(adapter, repoId, sessionId, attemptId, 25_000)
    const stA = parseMcpResult(await mcpAdapter.callTool('get_unitflow_status', { sessionId }))
    if (obsWaitA.status !== 'SUCCEEDED' || stA.activeAttempt?.status !== 'SUCCEEDED') {
      throw new Error(`Unexpected mock utilityProcess completion: obs=${JSON.stringify(obsWaitA)}, st=${JSON.stringify(stA)}`)
    }

    const settle = parseMcpResult(await mcpAdapter.callTool('settle_unitflow_unit', { sessionId, attemptId }))
    if (settle.attemptStatus !== 'COMPLETED' || settle.unitState !== 'VALIDATING') {
      throw new Error(`Unexpected settle result: ${JSON.stringify(settle)}`)
    }

    const editedText = fs.readFileSync(path.join(siblingWt, 'confined-edit.txt'), 'utf8')
    const escapeExists = fs.existsSync(path.join(repoArea, 'escaped-outside.txt'))
    if (!editedText.includes('EDITED_VIA_CLINE_UTILITY_PROCESS') || escapeExists) {
      throw new Error(`Confinement check failed: edited="${editedText}", escapeExists=${escapeExists}`)
    }
    if (!mockServer.observedClientHeaders.includes('cline-core')) {
      throw new Error(`Missing official x-client-type: cline-core header (observed: ${mockServer.observedClientHeaders.join(',')})`)
    }
    if (mockServer.observedRequestModels.some((m) => m !== 'free/local-mock-coder')) {
      throw new Error(`Unexpected request model: ${mockServer.observedRequestModels.join(',')}`)
    }
    const obsA = await adapter.observeAttempt({ repositoryId: repoId, sessionId, attemptId })
    if (obsA.result?.billing?.classification !== 'ZERO_COST_CONFIRMED' || obsA.termination?.confirmed !== true) {
      throw new Error(`Unexpected observation billing/termination: ${JSON.stringify(obsA)}`)
    }

    // Record real proof tied to current worktree source and accept via ChannelMcpAdapter
    const proofSource = await captureValidationSource(siblingWt, repoId)
    const proof = ledger.recordProof({
      kind: 'TARGETED_TEST',
      producer: 'IMPLEMENTER',
      status: 'PASSED',
      startedAt: new Date(Date.now() - 1000).toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 1000,
      scope: ['buildx/cline-gates'],
      summary: 'utilityProcess confined edit verified',
      sourceFingerprint: validationSourceFingerprint(proofSource),
      commandProfile: { command: 'node --test', cwd: proofSource.cwd, source: proofSource }
    })
    const accepted = parseMcpResult(
      await mcpAdapter.callTool('accept_unitflow_unit', {
        sessionId,
        attemptId,
        operationId: randomUUID(),
        proofIds: [proof.proofId],
        summary: 'Accepted gate 1-2 unit'
      })
    )
    if (accepted.status !== 'ACCEPTED') {
      throw new Error(`Accept failed: ${JSON.stringify(accepted)}`)
    }

    // Scenario B: Quota 429 -> RECONCILING -> reconcile retry
    mockMode = 'quota_429'
    const sessionB = randomUUID()
    const planB = randomUUID()
    const unitB = randomUUID()
    const resB = randomUUID()
    const attemptB = randomUUID()
    parseMcpResult(await mcpAdapter.callTool('create_buildx_session', { sessionId: sessionB }))
    parseMcpResult(await mcpAdapter.callTool('bind_unitflow_workspace', { sessionId: sessionB, worktreeId: bound.worktreeId }))
    parseMcpResult(
      await mcpAdapter.callTool('prepare_unitflow_plan', {
        sessionId: sessionB,
        planId: planB,
        title: 'Quota 429 Plan',
        objective: 'Verify fail and reconcile on 429 quota limit',
        units: [{ unitId: unitB, position: 0, title: 'Unit B', objective: 'Trigger 429', acceptanceCriteria: 'Reconciles' }]
      })
    )
    await facade.startNextUnit(sessionB, planB, {
      reservationId: resB,
      attemptId: attemptB,
      stageOperationId: randomUUID(),
      executorSelection: adapter.identity
    })
    const obsB = await waitForAdapterTerminal(adapter, repoId, sessionB, attemptB, 30_000)
    const stB = parseMcpResult(await mcpAdapter.callTool('get_unitflow_status', { sessionId: sessionB }))
    if (obsB.status !== 'FAILED' || stB.activeAttempt?.status !== 'FAILED') {
      throw new Error(`Expected FAILED status on 429, got obs=${JSON.stringify(obsB)}, st=${JSON.stringify(stB)}`)
    }
    const settleB = parseMcpResult(await mcpAdapter.callTool('settle_unitflow_unit', { sessionId: sessionB, attemptId: attemptB }))
    if (settleB.attemptStatus !== 'FAILED' || settleB.unitState !== 'RECONCILING') {
      throw new Error(`Quota 429 should reach RECONCILING, got: ${JSON.stringify(settleB)}`)
    }
    const reconcileB = parseMcpResult(
      await mcpAdapter.callTool('reconcile_unitflow_unit', {
        sessionId: sessionB,
        attemptId: attemptB,
        operationId: randomUUID(),
        summary: 'Recovered from 429 quota error',
        action: 'RETRY_SAME_UNIT'
      })
    )
    if (reconcileB.status !== 'RETRY_ELIGIBLE') {
      throw new Error(`Reconcile failed: ${JSON.stringify(reconcileB)}`)
    }

    // Scenario C1: Active utilityProcess cancellation + cleanup while HTTP stream hangs
    mockMode = 'hang_stream'
    const sessionC = randomUUID()
    const planC = randomUUID()
    const unitC = randomUUID()
    const resC = randomUUID()
    const attemptC = randomUUID()
    const stageC = randomUUID()
    parseMcpResult(await mcpAdapter.callTool('create_buildx_session', { sessionId: sessionC }))
    parseMcpResult(await mcpAdapter.callTool('bind_unitflow_workspace', { sessionId: sessionC, worktreeId: bound.worktreeId }))
    parseMcpResult(
      await mcpAdapter.callTool('prepare_unitflow_plan', {
        sessionId: sessionC,
        planId: planC,
        title: 'Cancel Hang Plan',
        objective: 'Cancel hung utilityProcess cleanly',
        units: [{ unitId: unitC, position: 0, title: 'Unit C', objective: 'Hang then cancel', acceptanceCriteria: 'Cancelled cleanly' }]
      })
    )
    await facade.startNextUnit(sessionC, planC, {
      reservationId: resC,
      attemptId: attemptC,
      stageOperationId: stageC,
      executorSelection: adapter.identity
    })
    await new Promise((r) => setTimeout(r, 400))
    const cancelRes = await facade.executionService.cancelUnitExecution(repoId, sessionC, attemptC)
    if (cancelRes.status !== 'TERMINAL_OBSERVED') {
      throw new Error(`Cancel failed: ${JSON.stringify(cancelRes)}`)
    }
    const settleC = parseMcpResult(await mcpAdapter.callTool('settle_unitflow_unit', { sessionId: sessionC, attemptId: attemptC }))
    if (settleC.attemptStatus !== 'CANCELLED' || settleC.unitState !== 'RECONCILING') {
      throw new Error(`Cancel settle expected CANCELLED/RECONCILING, got: ${JSON.stringify(settleC)}`)
    }

    // Scenario C2: Unresponsive utilityProcess with real descendant child PID -> process tree termination proof
    let descendantPidKilled = false
    if (payload.hardKillWorkerPath) {
      const hardAdapter = new ClineSdkExecutorAdapter({
        repositoryId: repoId,
        modelId: 'free/local-mock-coder',
        workerPath: payload.hardKillWorkerPath,
        runtimeStorageBaseDir: path.join(workRoot, 'hard-kill-runtime'),
        cancelGraceMs: 200
      })
      let childDescendantPid = 0
      const hardAttemptId = randomUUID()
      hardAdapter.subscribe(hardAttemptId, (ev) => {
        if (ev.kind === 'TOOL_ACTIVITY' && ev.message?.startsWith('descendant_pid:')) {
          childDescendantPid = Number(ev.message.slice('descendant_pid:'.length))
        }
      })
      const hardPrep = await hardAdapter.prepareAttempt({
        repositoryId: repoId,
        sessionId: randomUUID(),
        planId: randomUUID(),
        unitId: randomUUID(),
        attemptId: hardAttemptId,
        worktree: { worktreeId: bound.worktreeId, generation: bound.generation, branch: 'feat/u2-work', path: siblingWt },
        prompt: {
          stageOperationId: randomUUID(),
          promptFilePath: path.join(workRoot, 'hard-prompt.tmp'),
          readPromptText: () => 'Spawn child then hang'
        }
      })
      if (hardPrep.status !== 'READY' || !hardPrep.handle) {
        throw new Error(`Hard prepare failed: ${JSON.stringify(hardPrep)}`)
      }
      await hardAdapter.startAttempt({
        repositoryId: repoId,
        sessionId: randomUUID(),
        attemptId: hardAttemptId,
        handle: hardPrep.handle
      })
      for (let i = 0; i < 40 && childDescendantPid === 0; i++) {
        await new Promise((r) => setTimeout(r, 50))
      }
      if (!childDescendantPid || !isPidAlive(childDescendantPid)) {
        throw new Error(`Descendant process did not start cleanly: pid=${childDescendantPid}`)
      }
      const hardCancel = await hardAdapter.cancelAttempt({
        repositoryId: repoId,
        sessionId: randomUUID(),
        attemptId: hardAttemptId
      })
      if (hardCancel.phase !== 'TERMINAL' || hardCancel.termination?.confirmed !== true) {
        throw new Error(`Hard tree kill failed: ${JSON.stringify(hardCancel)}`)
      }
      if (isPidAlive(childDescendantPid)) {
        try { process.kill(childDescendantPid, 'SIGKILL') } catch {}
        throw new Error(`Descendant PID ${childDescendantPid} survived tree termination!`)
      }
      descendantPidKilled = true
    }

    return {
      success: true,
      mode: 'gates',
      probedModelId: probed.selectedModelId,
      eventsCount: receivedEvents.length,
      eventKinds: [...new Set(receivedEvents.map((e) => e.kind))],
      billing: obsA.result?.billing,
      escapeBlocked: !escapeExists,
      isolatedStorageCleaned: !fs.existsSync(path.join(runtimeStorageDir, attemptId)),
      quotaReconciled: reconcileB.status === 'RETRY_ELIGIBLE',
      hungUtilityCancelled: settleC.attemptStatus === 'CANCELLED',
      descendantPidKilled,
      unitAccepted: accepted.status === 'ACCEPTED'
    }
  } finally {
    await mockServer.close().catch(() => {})
    try { smcService.close() } catch {}
    try { ledger.close() } catch {}
    try { fs.rmSync(workRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch {}
  }
}

async function runRealUnitInElectron(payload: HarnessPayload): Promise<any> {
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cline-electron-real-unit-'))
  const smcDir = path.join(workRoot, 'smc')
  const ledgerDir = path.join(workRoot, 'ledger')
  const stagingDir = path.join(workRoot, 'staging')
  const runtimeStorageDir = path.join(workRoot, 'cline-runtime')

  const smcService = new SessionMemoryCentralService(smcDir)
  const runtimeIdentity = new RuntimeIdentityProvider({ instanceId: 'u2-electron-real-unit' })
  const ledger = new ValidationLedger(ledgerDir, runtimeIdentity)

  try {
    const repoId = 'e1c8a999-6d73-4f56-83a3-fbcd78c9c19d'
    const repoArea = path.join(workRoot, 'git-real')
    const mainRepo = path.join(repoArea, 'main')
    const siblingWt = path.join(repoArea, 'sibling')
    fs.mkdirSync(mainRepo, { recursive: true })
    execSync('git init -q -b main', { cwd: mainRepo })
    execSync('git config user.email "u2-real@test.local"', { cwd: mainRepo })
    execSync('git config user.name "BuildX U2 Real Unit"', { cwd: mainRepo })
    fs.writeFileSync(path.join(mainRepo, 'README.md'), '# BuildX U2 Real Free Unit\n', 'utf8')
    execSync('git add README.md', { cwd: mainRepo })
    execSync('git commit -qm "baseline"', { cwd: mainRepo })
    execSync(`git worktree add -qb feat/u2-real-unit "${siblingWt}"`, { cwd: mainRepo })

    fs.mkdirSync(path.join(siblingWt, 'src'), { recursive: true })
    fs.mkdirSync(path.join(siblingWt, 'test'), { recursive: true })
    fs.writeFileSync(
      path.join(siblingWt, 'src', 'add.cjs'),
      'function add(a, b) {\n  return a - b\n}\nmodule.exports = { add }\n',
      'utf8'
    )
    fs.writeFileSync(
      path.join(siblingWt, 'test', 'add.test.cjs'),
      "const test = require('node:test')\nconst assert = require('node:assert/strict')\nconst { add } = require('../src/add.cjs')\ntest('add sums two numbers', () => { assert.equal(add(2, 3), 5) })\n",
      'utf8'
    )
    execSync('git add src/add.cjs test/add.test.cjs', { cwd: siblingWt })
    execSync('git commit -qm "seed buggy add module and test"', { cwd: siblingWt })

    const gitOps = createGitOpsForWorktrees(repoId, siblingWt, 'feat/u2-real-unit')
    const yoloPolicy: CliPolicy = {
      mode: 'AUTONOMOUS_TRUSTED',
      scope: 'REPOSITORY_WORKTREES',
      revision: 'yolo-real-u2-1',
      rule: 'local-repository-worktree-trust'
    }

    const adapter = await ClineSdkExecutorAdapter.createForLiveFreeAttempt({
      repositoryId: repoId,
      workerPath: payload.workerPath,
      runtimeStorageBaseDir: runtimeStorageDir,
      requireAuth: true,
      timeoutMs: 90_000,
      maxIterations: 8,
      maxTokensPerTurn: 1024,
      temperature: 0,
      getPolicy: () => yoloPolicy,
      launcher: createElectronUtilityLauncher()
    })

    const facade = new UnitFlowRuntimeFacade({
      repositoryId: repoId,
      repoRoot: mainRepo,
      smcService,
      gitOperations: gitOps,
      executor: adapter,
      validationLedger: ledger,
      stagingDirectory: stagingDir
    })

    const mcpAdapter = new ChannelMcpAdapter(
      {
        projectId: repoId,
        repoRoot: siblingWt,
        navigation: {
          discoverRepository: async () => ({ directories: [] }),
          getRelationships: async () => ({ files: [] }),
          inspectFiles: async () => ({ files: [] }),
          readCode: async () => [],
          getReferences: async () => ({ targets: [] }),
          getSymbolDependencies: async () => ({ sources: [] }),
          getSymbolHierarchy: async () => ({ targets: [] })
        } as any,
        sessionMemoryCentral: smcService,
        unitflowRuntime: facade
      },
      undefined,
      runtimeIdentity,
      ledger
    )

    const sessionId = randomUUID()
    const planId = randomUUID()
    const unitId = randomUUID()
    const reservationId = randomUUID()
    const attemptId = randomUUID()
    const stageOpId = randomUUID()

    parseMcpResult(await mcpAdapter.callTool('create_buildx_session', { sessionId }))
    const inv = await gitOps.getBranchInventory()
    parseMcpResult(
      await mcpAdapter.callTool('bind_unitflow_workspace', {
        sessionId,
        worktreeId: inv.worktrees[0].worktreeId
      })
    )
    parseMcpResult(
      await mcpAdapter.callTool('prepare_unitflow_plan', {
        sessionId,
        planId,
        title: 'BuildX U2 Real Free Unit Trial',
        objective: 'Fix src/add.cjs in disposable worktree with Cline FREE SDK',
        units: [
          {
            unitId,
            position: 0,
            title: 'Fix add(a, b) implementation in src/add.cjs',
            objective:
              'Use read_files on src/add.cjs and test/add.test.cjs, then use the editor tool on src/add.cjs ONLY to change `return a - b` to `return a + b`. Do not touch any other file.',
            acceptanceCriteria: 'node --test test/add.test.cjs passes cleanly in the worktree'
          }
        ]
      })
    )

    const events: ExecutorEvent[] = []
    adapter.subscribe(attemptId, (ev) => events.push(ev))

    const started = await facade.startNextUnit(sessionId, planId, {
      reservationId,
      attemptId,
      stageOperationId: stageOpId,
      executorSelection: adapter.identity
    })
    if (started.status !== 'RUNNING') {
      throw new Error(`Expected RUNNING start status in Gate 4, got ${started.status}: ${started.reason}`)
    }

    const obs = await waitForAdapterTerminal(adapter, repoId, sessionId, attemptId, 95_000)
    await mcpAdapter.callTool('get_unitflow_status', { sessionId })
    const settle = parseMcpResult(await mcpAdapter.callTool('settle_unitflow_unit', { sessionId, attemptId }))
    if (settle.attemptStatus !== 'COMPLETED' || settle.unitState !== 'VALIDATING') {
      throw new Error(
        `Real unit did not complete/validate: status=${obs.status}, reason=${obs.reason}, settle=${JSON.stringify(settle)}, billing=${JSON.stringify(obs.result?.billing)}`
      )
    }

    const gitDiff = execSync('git diff', { cwd: siblingWt, encoding: 'utf8' })
    const testRun = spawnSync(process.execPath, ['--test', 'test/add.test.cjs'], {
      cwd: siblingWt,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true
    })
    if (testRun.status !== 0) {
      throw new Error(`Directed worktree test failed after Cline edit (exit=${testRun.status}):\n${testRun.stdout}\n${testRun.stderr}\ndiff:\n${gitDiff}`)
    }
    if (!gitDiff.includes('+  return a + b')) {
      throw new Error(`Expected concrete diff changing return a - b to return a + b, got:\n${gitDiff}`)
    }

    const proofSource = await captureValidationSource(siblingWt, repoId)
    const proof = ledger.recordProof({
      kind: 'TARGETED_TEST',
      producer: 'IMPLEMENTER',
      status: 'PASSED',
      startedAt: new Date(Date.now() - 1000).toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 1000,
      scope: ['src/add.cjs', 'test/add.test.cjs'],
      summary: 'Directed worktree test passed after real Cline FREE SDK edit',
      sourceFingerprint: validationSourceFingerprint(proofSource),
      commandProfile: {
        command: 'node --test test/add.test.cjs',
        cwd: proofSource.cwd,
        source: proofSource
      }
    })
    const freshProof = await ledger.getProofWithFreshness(proof.proofId)
    if (freshProof?.freshness !== 'CURRENT') {
      throw new Error(`Expected CURRENT proof freshness, got ${freshProof?.freshness}`)
    }

    const accepted = parseMcpResult(
      await mcpAdapter.callTool('accept_unitflow_unit', {
        sessionId,
        attemptId,
        operationId: randomUUID(),
        proofIds: [proof.proofId],
        summary: `Cline FREE SDK (${adapter.identity.modelId}) fixed src/add.cjs; directed test PASSED/CURRENT`
      })
    )
    if (accepted.status !== 'ACCEPTED') {
      throw new Error(`Expected ACCEPTED unit, got ${JSON.stringify(accepted)}`)
    }
    const unitStateAfter = smcService.getUnitState(repoId, sessionId, planId, unitId)
    const planAfter = smcService.getPlan(repoId, planId)

    return {
      success: true,
      mode: 'real-unit',
      selection: adapter.identity,
      attemptId,
      sessionId,
      planId,
      unitId,
      proofId: proof.proofId,
      unitAcceptedStatus: accepted.status,
      unitStatus: unitStateAfter?.status,
      planStatus: planAfter?.status,
      nextEligibleUnitId: accepted.nextEligibleUnitId ?? null,
      usage: obs.result?.usage,
      billing: obs.result?.billing,
      termination: obs.termination,
      isolatedStorageCleaned: !fs.existsSync(path.join(runtimeStorageDir, attemptId)),
      eventKinds: [...new Set(events.map((e) => e.kind))],
      gitDiff,
      directedTestExitCode: testRun.status
    }
  } finally {
    try { smcService.close() } catch {}
    try { ledger.close() } catch {}
    try { fs.rmSync(workRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch {}
  }
}

async function boot(): Promise<void> {
  await app.whenReady()
  const payload = await new Promise<HarnessPayload>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('HARNESS_INIT_TIMEOUT')), 10_000)
    process.once('message', (msg) => {
      clearTimeout(timer)
      resolve(msg as HarnessPayload)
    })
  })

  try {
    const output =
      payload.mode === 'real-unit'
        ? await runRealUnitInElectron(payload)
        : await runGatesInElectron(payload)
    process.send?.(output)
  } catch (error) {
    process.send?.({
      success: false,
      error: error instanceof Error ? error.stack ?? error.message : String(error)
    })
  } finally {
    setTimeout(() => app.exit(0), 50).unref()
  }
}

void boot()
