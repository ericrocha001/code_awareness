import { describe, it, expect } from 'vitest'
import {
  GrokExecutorAdapter,
  classifyObservedGrokOutcome
} from './grok-executor-adapter'
import type { CliExecutionPort } from '../../execution/grok-cli-bridge'
import type { UnitExecutorPort } from '../../execution/executor-port'
import type { CliExecutionSnapshot, CliProposal } from '../../../cli-execution/cli-execution-types'
import type { ExecutorEvent, ExecutorRunObservation } from '../../../../shared/types/buildx/execution-types'

function makeProposal(overrides?: Partial<CliProposal>): CliProposal {
  const args = overrides?.command?.args ?? ['--prompt-file', '/tmp/prompt.tmp', '--output-format', 'json', '--no-auto-update']
  return {
    proposalId: 'prop-grok-1',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    repositoryId: 'repo-1',
    repositoryDirectory: '/tmp/wt',
    checkoutFingerprint: 'fp-1',
    command: {
      executable: 'grok',
      originalExecutable: 'grok',
      args,
      originalArgs: args,
      cwd: '/tmp/wt',
      relativeCwd: '.',
      displayCommandLine: `grok ${args.join(' ')}`
    },
    risks: [],
    status: 'PENDING',
    policy: { mode: 'SUPERVISED', scope: 'ACTIVE_CHECKOUT_ONLY', revision: 'sup-1', rule: 'native-command-consent' },
    autoAuthorized: false,
    timeoutProfile: 'BUILDX_AGENTIC_UNIT',
    timeoutMs: 600_000,
    ...overrides
  }
}

function makeSnapshot(overrides?: Partial<CliExecutionSnapshot>): CliExecutionSnapshot {
  return {
    operationId: '11111111-1111-4111-8111-111111111111',
    proposalId: 'prop-grok-1',
    status: 'SUCCEEDED',
    phase: 'TERMINAL',
    command: {
      executable: 'grok',
      originalExecutable: 'grok',
      args: ['--prompt-file', '/tmp/prompt.tmp'],
      originalArgs: ['--prompt-file', '/tmp/prompt.tmp'],
      cwd: '/tmp/wt',
      relativeCwd: '.',
      displayCommandLine: 'grok --prompt-file /tmp/prompt.tmp'
    },
    exitCode: 0,
    stdout: '{"secret":"raw-stdout-should-not-leak"}',
    stderr: 'raw-stderr',
    hasMore: false,
    truncated: false,
    nextCursor: null,
    totalStdoutBytes: 38,
    totalStderrBytes: 10,
    treeObservation: { activeProcesses: 0, handlesClosed: true },
    startedAt: '2026-11-10T00:00:00.000Z',
    finishedAt: '2026-11-10T00:00:02.000Z',
    durationMs: 2000,
    timeoutProfile: 'BUILDX_AGENTIC_UNIT',
    timeoutMs: 600_000,
    origin: 'CLI_EXECUTION_CAPABILITY',
    ...overrides
  }
}

describe('GrokExecutorAdapter & UnitExecutorPort contract', () => {
  it('isola comando Grok privado, deriva --always-approve via YOLO e rejeita divergência de proposta', async () => {
    const prepareCalls: any[] = []
    let policyMode: 'AUTONOMOUS_TRUSTED' | 'SUPERVISED' = 'AUTONOMOUS_TRUSTED'

    const cliPort: CliExecutionPort = {
      isEnabled: () => true,
      getRepositoryId: () => 'repo-1',
      getPolicyForWorktree: async () => ({
        mode: policyMode,
        scope: policyMode === 'AUTONOMOUS_TRUSTED' ? 'REPOSITORY_WORKTREES' : 'ACTIVE_CHECKOUT_ONLY',
        revision: 'rev-1',
        rule: 'test'
      }),
      prepare: async (input) => {
        prepareCalls.push(input)
        return makeProposal({
          command: {
            executable: 'grok',
            originalExecutable: input.executable,
            args: input.args ?? [],
            originalArgs: input.args ?? [],
            cwd: '/tmp/wt',
            relativeCwd: '.',
            displayCommandLine: 'grok'
          },
          policy: {
            mode: policyMode,
            scope: policyMode === 'AUTONOMOUS_TRUSTED' ? 'REPOSITORY_WORKTREES' : 'ACTIVE_CHECKOUT_ONLY',
            revision: 'rev-1',
            rule: 'test'
          },
          autoAuthorized: policyMode === 'AUTONOMOUS_TRUSTED'
        })
      }
    }

    const adapter = new GrokExecutorAdapter(cliPort)
    expect(adapter.identity).toEqual({
      executorId: 'grok-cli',
      providerId: 'xai',
      modelId: null
    })

    const yoloPrep = await adapter.prepareAttempt({
      repositoryId: 'repo-1',
      sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      planId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      unitId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      attemptId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      worktree: { worktreeId: 'wt-1', generation: 'gen-1', branch: 'feat/test' },
      prompt: { stageOperationId: 'st-1', promptFilePath: '/tmp/staged-unit.tmp' }
    })

    expect(yoloPrep.status).toBe('READY')
    expect(yoloPrep.handle?.selection).toEqual(adapter.identity)
    expect(prepareCalls[0].executable).toBe('grok')
    expect(prepareCalls[0].executionProfile).toBe('BUILDX_AGENTIC_UNIT')
    expect(prepareCalls[0].args).toEqual([
      '--prompt-file', '/tmp/staged-unit.tmp',
      '--output-format', 'json',
      '--no-auto-update',
      '--always-approve'
    ])

    policyMode = 'SUPERVISED'
    const supPrep = await adapter.prepareAttempt({
      repositoryId: 'repo-1',
      sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      planId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      unitId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      attemptId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      worktree: { worktreeId: 'wt-1', generation: 'gen-1', branch: 'feat/test' },
      prompt: { stageOperationId: 'st-1', promptFilePath: '/tmp/staged-unit.tmp' },
      allowAlwaysApprove: true
    })
    expect(supPrep.status).toBe('READY')
    expect(prepareCalls[1].args).not.toContain('--always-approve')

    // Tampered proposal executable must fail closed
    const tamperedCli: CliExecutionPort = {
      ...cliPort,
      prepare: async () => makeProposal({
        command: {
          executable: 'bash',
          originalExecutable: 'bash',
          args: ['-c', 'echo pwn'],
          originalArgs: ['-c', 'echo pwn'],
          cwd: '/tmp/wt',
          relativeCwd: '.',
          displayCommandLine: 'bash'
        }
      })
    }
    const tamperedAdapter = new GrokExecutorAdapter(tamperedCli)
    const tamperedPrep = await tamperedAdapter.prepareAttempt({
      repositoryId: 'repo-1',
      sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      planId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      unitId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      attemptId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      worktree: { worktreeId: 'wt-1', generation: 'gen-1', branch: 'feat/test' },
      prompt: { stageOperationId: 'st-1', promptFilePath: '/tmp/staged-unit.tmp' }
    })
    expect(tamperedPrep.status).toBe('UNAVAILABLE')
    expect(tamperedPrep.reason).toBe('PROPOSAL_VALIDATION_FAILED')
  })

  it('mapeia eventos/observações sem vazar stdout/argv e preserva classificação de erros e cancelamento', async () => {
    let snap = makeSnapshot({ status: 'RUNNING', phase: 'RUNNING', exitCode: null, treeObservation: undefined })
    const cancelCalls: string[] = []
    const cliPort: CliExecutionPort = {
      isEnabled: () => true,
      getRepositoryId: () => 'repo-1',
      prepare: async () => makeProposal(),
      start: async () => snap,
      get: async () => snap,
      cancel: async (input) => {
        cancelCalls.push(input.operationId)
        snap = makeSnapshot({
          status: 'CANCELLED',
          phase: 'TERMINAL',
          exitCode: null,
          treeObservation: { activeProcesses: 0, handlesClosed: true }
        })
        return snap
      }
    }

    const adapter = new GrokExecutorAdapter(cliPort)
    const events: ExecutorEvent[] = []
    const attemptId = '11111111-1111-4111-8111-111111111111'
    const unsub = adapter.subscribe(attemptId, (ev) => events.push(ev))

    const prep = await adapter.prepareAttempt({
      repositoryId: 'repo-1',
      sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      planId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      unitId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      attemptId,
      worktree: { worktreeId: 'wt-1', generation: 'gen-1', branch: 'feat/test' },
      prompt: { stageOperationId: 'st-1', promptFilePath: '/tmp/prompt.tmp' }
    })
    const startObs = await adapter.startAttempt({
      repositoryId: 'repo-1',
      sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      attemptId,
      handle: prep.handle!
    })
    expect(startObs.status).toBe('RUNNING')
    expect(JSON.stringify(startObs)).not.toContain('raw-stdout-should-not-leak')
    expect(JSON.stringify(startObs)).not.toContain('--prompt-file')

    const cancelObs = await adapter.cancelAttempt({
      repositoryId: 'repo-1',
      sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      attemptId
    })
    expect(cancelCalls).toEqual([attemptId])
    expect(cancelObs.status).toBe('CANCELLED')
    expect(cancelObs.termination).toEqual({
      confirmed: true,
      activeProcesses: 0,
      handlesClosed: true
    })
    expect(cancelObs.result?.billing).toEqual({ classification: 'UNKNOWN', provenance: 'UNAVAILABLE' })
    expect(cancelObs.result?.usage).toEqual({ provenance: 'UNAVAILABLE' })
    expect(events.map(e => e.kind)).toEqual(['PROGRESS', 'CANCELLED'])

    unsub()

    expect(
      classifyObservedGrokOutcome(makeSnapshot({ status: 'FAILED', exitCode: 1, stderr: 'Error 429: quota exceeded' }))
    ).toBe('GROK_QUOTA_OR_RATE_LIMIT')
    expect(
      classifyObservedGrokOutcome(makeSnapshot({ status: 'TIMED_OUT', stderr: 'Confirmation required: use --always-approve' }))
    ).toBe('APPROVAL_PROMPT_TIMED_OUT')
  })

  it('porta é compatível com adaptador SDK sem argv, stdout ou exitCode', async () => {
    const sdkIdentity = {
      executorId: 'cline-sdk',
      providerId: 'cline',
      modelId: 'cline-free/solar-mini4'
    } as const

    const sdkFake: UnitExecutorPort = {
      identity: sdkIdentity,
      checkAvailability: async () => ({ available: true }),
      prepareAttempt: async (input) => {
        expect(input.prompt.readPromptText?.()).toBe('Implement unit')
        return {
          status: 'READY',
          handle: {
            preparedAttemptId: 'sdk-session-1',
            selection: sdkIdentity
          }
        }
      },
      startAttempt: async (input): Promise<ExecutorRunObservation> => ({
        attemptId: input.attemptId,
        status: 'SUCCEEDED',
        phase: 'TERMINAL',
        selection: sdkIdentity,
        termination: { confirmed: true },
        result: {
          summary: 'OK',
          usage: { inputTokens: 73, outputTokens: 2, totalTokens: 75, provenance: 'EXECUTOR_REPORTED' },
          billing: {
            upstreamCostUsd: 0.00081,
            creditsUsed: 0,
            balanceDelta: 0,
            currency: 'USD',
            classification: 'ZERO_COST_CONFIRMED',
            provenance: 'EXECUTOR_REPORTED'
          },
          externalSessionId: 'cline-task-1',
          provenance: {
            executorId: sdkIdentity.executorId,
            providerId: sdkIdentity.providerId,
            modelId: sdkIdentity.modelId,
            origin: 'CLINE_CORE_SDK'
          }
        }
      }),
      observeAttempt: async (input) => ({
        attemptId: input.attemptId,
        status: 'SUCCEEDED',
        phase: 'TERMINAL',
        selection: sdkIdentity,
        termination: { confirmed: true }
      }),
      cancelAttempt: async (input) => ({
        attemptId: input.attemptId,
        status: 'CANCELLED',
        phase: 'TERMINAL',
        selection: sdkIdentity,
        termination: { confirmed: true }
      })
    }

    const prep = await sdkFake.prepareAttempt({
      repositoryId: 'repo-1',
      sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      planId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      unitId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      attemptId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      worktree: { worktreeId: 'wt-1', generation: 'gen-1', branch: 'feat/test', path: '/tmp/wt' },
      prompt: {
        stageOperationId: 'st-1',
        promptFilePath: '/tmp/prompt.tmp',
        readPromptText: () => 'Implement unit'
      }
    })
    expect(prep.status).toBe('READY')
    const obs = await sdkFake.startAttempt({
      repositoryId: 'repo-1',
      sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      attemptId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      handle: prep.handle!
    })
    expect(obs.exitCode).toBeUndefined()
    expect(obs.termination?.confirmed).toBe(true)
    expect(obs.result?.billing?.classification).toBe('ZERO_COST_CONFIRMED')
  })
})
