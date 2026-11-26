import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildSync } from 'esbuild'
import { removeDirectoryForceSync } from '../core/force-remove'
import { GitService } from '../core/git-service'
import { GitWorktreeRegistry } from '../git-operations/git-worktree-registry'
import { sessionTargetResolver, type SessionTargetSelection } from './target'
import { SessionStore, sessionStorePath } from './store'
import { SessionContextClient } from './client'
import { SessionProjectionCoordinator } from './projection-coordinator'
import type { McpMultimodalToolResult } from '../mcp/mcp-types'
import { nativeBindingPath, nativeHookLimits, nativeWorktreeIdentity, normalizeNativeHook, prepareNativeSpool, spoolEventFiles, spoolNativeHook, type NativeHookBinding, type NativeHookProvider } from './native-hooks'
import { RepositoryContinuumSession } from '../continuum/project-continuum-session'
import { ContinuumLocalAdapter } from '../continuum/local-adapter'
import { handoffSessionCoverage } from './handoff'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

const data = (result: McpMultimodalToolResult) => {
  const first = result.content[0]
  if (!first || first.type !== 'text') throw new Error('EXPECTED_TEXT')
  return JSON.parse(first.text)
}

function buildWorkerBundle(base: string): string {
  const output = join(base, 'worker.cjs')
  const code = buildSync({ entryPoints: ['src/main/session-context/worker.ts'], bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false }).outputFiles[0].text
  writeFileSync(output, `require = require('node:module').createRequire(${JSON.stringify(join(process.cwd(), 'package.json'))});\n${code}`)
  return output
}

function createRepo(prefix: string) {
  const base = mkdtempSync(join(tmpdir(), prefix))
  cleanup.push(() => removeDirectoryForceSync(base))
  const main = join(base, 'main'), hooks = join(base, 'empty-hooks')
  mkdirSync(main); mkdirSync(hooks)
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${hooks}`, ...args], { cwd, windowsHide: true, encoding: 'utf8' })
  git(main, 'init', '-q', '-b', 'main')
  git(main, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init')
  return { base, main, git }
}

function writeBinding(root: string, repositoryId: string, selection: SessionTargetSelection, spoolDir: string, provider: NativeHookProvider = 'codex', enabled = true): NativeHookBinding {
  const id = nativeWorktreeIdentity(root)
  prepareNativeSpool(spoolDir)
  const binding: NativeHookBinding = {
    schema: 1,
    provider,
    enabled,
    repositoryId,
    worktreeId: selection.worktreeId,
    generation: selection.generation,
    root: id.root,
    commonDirectory: id.commonDirectory,
    directoryIdentity: id.directoryIdentity,
    spool: spoolDir
  }
  mkdirSync(join(id.root, '.code-awareness/native-hooks', ...(provider === 'antigravity' ? ['antigravity'] : [])), { recursive: true })
  writeFileSync(nativeBindingPath(id.root, provider), JSON.stringify(binding, null, 2))
  return binding
}

function writeCodexHooksConfig(root: string) {
  mkdirSync(join(root, '.codex'), { recursive: true })
  writeFileSync(join(root, '.codex/hooks.json'), JSON.stringify({
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: 'ca-native-hook --provider codex --event SessionStart' }] }],
      PreToolUse: [{ hooks: [{ type: 'command', command: 'ca-native-hook --provider codex --event PreToolUse' }] }],
      PostToolUse: [{ hooks: [{ type: 'command', command: 'ca-native-hook --provider codex --event PostToolUse' }] }],
      SubagentStart: [{ hooks: [{ type: 'command', command: 'ca-native-hook --provider codex --event SubagentStart' }] }],
      SubagentStop: [{ hooks: [{ type: 'command', command: 'ca-native-hook --provider codex --event SubagentStop' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'ca-native-hook --provider codex --event Stop' }] }],
      SessionEnd: [{ hooks: [{ type: 'command', command: 'ca-native-hook --provider codex --event SessionEnd' }] }]
    }
  }))
}

function spoolBatch(binding: NativeHookBinding, sessionId: string, count: number, now = new Date()) {
  const envelopes = []
  for (let i = 0; i < count; i++) {
    const at = new Date(now.getTime() - (count - i) * 1000)
    const provider = binding.provider ?? 'codex'
    const payload = provider === 'antigravity'
      ? { hookEventName: i === 0 ? 'SessionStart' : 'PreInvocation', conversationId: sessionId, workspacePaths: [binding.root], timestamp: at.toISOString() }
      : { hook_event_name: i === 0 ? 'SessionStart' : 'Stop', session_id: sessionId, turn_id: `turn-${i}`, cwd: binding.root, timestamp: at.toISOString() }
    const env = normalizeNativeHook(payload, binding, at)
    spoolNativeHook(env, binding.spool)
    envelopes.push(env)
  }
  return envelopes
}

describe('U2 cooperative draining, cancellation isolation and execution origin preflight', () => {
  it('drains 9 bindings including 301 envelopes cooperatively across reopen, dedup, corrupt/expired/disabled guards, reaching zero idle activity', async () => {
    const { base, main, git } = createRepo('coop-9-')
    const targets: { root: string; branch: string }[] = [{ root: main, branch: 'main' }]
    for (let i = 1; i < 9; i++) {
      const dir = join(base, `wt-${i}`)
      git(main, 'worktree', 'add', '-q', '-b', `wt-${i}`, dir)
      targets.push({ root: dir, branch: `wt-${i}` })
    }
    const registry = new GitWorktreeRegistry(main, new GitService(), { repositoryId: 'repo-u2', isActive: () => true })
    const discovered = await registry.discover()
    const bindings: NativeHookBinding[] = []
    const now = new Date()
    for (let i = 0; i < 9; i++) {
      const rec = discovered.worktrees.find(w => w.branch === targets[i].branch)!
      const sel = { worktreeId: rec.worktreeId, generation: rec.generation }
      const b = writeBinding(targets[i].root, 'repo-u2', sel, join(base, `spools/s-${i}`), 'codex')
      bindings.push(b)
      if (i === 0) {
        const envs = spoolBatch(b, 'sess-301', 301, now)
        // Duplicate envelope attempt should dedup cleanly at spool admission
        expect(spoolNativeHook(envs[0], b.spool)).toBe('DUPLICATE')
      } else if (i === 7) {
        spoolBatch(b, `sess-${i}`, 1, now)
        writeFileSync(join(b.spool, '999.json'), '{bad-json')
      } else if (i === 8) {
        spoolBatch(b, `sess-${i}`, 1, now)
        const expiredAt = new Date(Date.now() - nativeHookLimits.retentionMs - 60_000)
        const env = normalizeNativeHook(
          { hook_event_name: 'SessionStart', session_id: 'sess-expired', cwd: b.root, timestamp: expiredAt.toISOString() },
          b,
          expiredAt
        )
        writeFileSync(join(b.spool, '999.json'), JSON.stringify(env))
      } else {
        spoolBatch(b, `sess-${i}`, 2, now)
      }
    }

    const baseResolver = sessionTargetResolver(registry, () => {})
    let validationChecks = 0
    const spyResolver: typeof baseResolver = Object.assign(
      async (sel: SessionTargetSelection) => {
        validationChecks++
        return baseResolver(sel)
      },
      {
        current: () => baseResolver.current!(),
        discover: () => baseResolver.discover!(),
        discoverMatching: (pred: (p: string) => boolean) => baseResolver.discoverMatching!(pred)
      }
    )

    const worker = buildWorkerBundle(base)
    const storage = join(base, 'storage')
    let client = new SessionContextClient(storage, 'repo-u2', main, () => true, worker, spyResolver, 12_000)
    cleanup.push(() => client.dispose())

    const firstPass = data(await client.call('list_agent_sessions', { source: 'NATIVE_HOOK', worktreeId: bindings[1].worktreeId, generation: bindings[1].generation }))
    expect(firstPass.sessions).toHaveLength(1)
    for (let step = 0; step < 3; step++) {
      await client.reconcileProjection()
    }
    // Mid-run dispose / reopen
    await client.dispose()
    client = new SessionContextClient(storage, 'repo-u2', main, () => true, worker, spyResolver, 12_000)
    cleanup.push(() => client.dispose())

    // Cooperative coordinator drains remaining backlog to convergence while concurrent reads keep succeeding
    let coordTicks = 0
    const coordinator = new SessionProjectionCoordinator(async () => {
      coordTicks++
      return client.reconcileProjection()
    }, () => true)
    cleanup.push(() => coordinator.stop())
    coordinator.request()
    const deadline = Date.now() + 25_000
    while (spoolEventFiles(bindings[0].spool).length > 0 && Date.now() < deadline) {
      const readRes = await client.call('list_agent_sessions', { source: 'NATIVE_HOOK' })
      expect(readRes.isError).not.toBe(true)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    coordinator.stop()
    expect(coordTicks).toBeGreaterThan(0)
    // Drain any final scan state until drainable converges to false
    let drainingDone = false
    let lastBacklog: unknown
    for (let tick = 0; tick < 50; tick++) {
      const res = data(await client.reconcileProjection())
      lastBacklog = res.backlog
      if (!res.backlog?.drainable) { drainingDone = true; break }
    }
    expect(drainingDone, JSON.stringify({ coordTicks, spools: bindings.map(b => spoolEventFiles(b.spool).length), lastBacklog })).toBe(true)
    expect(spoolEventFiles(bindings[0].spool)).toHaveLength(0)
    for (const i of [1, 2, 3, 4, 5, 6, 8]) {
      expect(spoolEventFiles(bindings[i].spool)).toHaveLength(0)
    }
    // Session from 301 envelopes was recorded once (no duplicates)
    const s0List = data(await client.call('list_agent_sessions', { source: 'NATIVE_HOOK', worktreeId: bindings[0].worktreeId, generation: bindings[0].generation }))
    expect(s0List.sessions).toHaveLength(1)

    // After convergence, idle reconcileProjection performs zero worker validation calls
    const checksBeforeIdle = validationChecks
    const idleRes = data(await client.reconcileProjection())
    expect(idleRes.backlog.drainable).toBe(false)
    expect(validationChecks).toBe(checksBeforeIdle)
  }, 150_000)

  it('isolates slow/cancelled maintenance from concurrent interactive reads and recovers on genuine worker termination', async () => {
    const { base, main } = createRepo('cancel-iso-')
    const registry = new GitWorktreeRegistry(main, new GitService(), { repositoryId: 'repo-c', isActive: () => true })
    const resolver = sessionTargetResolver(registry, () => {})
    const worker = buildWorkerBundle(base)
    const storage = join(base, 'storage')
    let blockRegistry = true
    const client = new SessionContextClient(
      storage,
      'repo-c',
      main,
      () => true,
      worker,
      resolver,
      1200,
      undefined,
      async () => {
        if (blockRegistry) await new Promise(resolve => setTimeout(resolve, 4000))
        return []
      }
    )
    cleanup.push(() => client.dispose())

    // Warm worker and record its identity
    await client.call('list_agent_sessions', { source: 'NATIVE_HOOK' })
    const originalWorker = (client as any).generation.worker
    expect(originalWorker.threadId).toBeGreaterThan(0)

    // Launch slow maintenance job alongside concurrent interactive read
    const maintenancePromise = client.reconcileProjection()
    const interactivePromise = client.call('list_agent_sessions', { source: 'NATIVE_HOOK' })
    const interactiveRes = await interactivePromise
    expect(interactiveRes.isError).not.toBe(true)
    const maintRes = data(await maintenancePromise)
    expect(maintRes.code).toBe('SESSION_CONTEXT_TIMEOUT')

    // Worker must NOT have been killed/replaced by slow maintenance cancellation
    expect((client as any).generation.worker).toBe(originalWorker)
    expect(originalWorker.threadId).toBeGreaterThan(0)
    blockRegistry = false

    // Genuine worker termination retires worker and next call recovers on fresh worker
    await originalWorker.terminate()
    const recovered = await client.call('list_agent_sessions', { source: 'NATIVE_HOOK' })
    expect(recovered.isError).not.toBe(true)
    expect((client as any).generation.worker).not.toBe(originalWorker)
    const verifyStore = new SessionStore(sessionStorePath(storage, 'repo-c'), 'repo-c')
    cleanup.push(() => verifyStore.close())
    expect(verifyStore.count()).toBe(0)
    expect(verifyStore.registry.sources().filter(s => s.source === 'NATIVE_HOOK' && s.status === 'COMPLETE')).toEqual([])
  }, 25_000)

  it('detects ORIGIN_MISMATCH vs UNKNOWN vs UNAVAILABLE vs ALIGNED across two worktrees without switching cwd or creating false associations', async () => {
    const { base, main, git } = createRepo('origin-u2-')
    const wtB = join(base, 'wt-b')
    git(main, 'worktree', 'add', '-q', '-b', 'wt-b', wtB)
    writeCodexHooksConfig(main)
    writeCodexHooksConfig(wtB)

    const registry = new GitWorktreeRegistry(main, new GitService(), { repositoryId: 'repo-orig', isActive: () => true })
    const discovered = await registry.discover()
    const recA = discovered.worktrees.find(w => w.branch === 'main')!
    const recB = discovered.worktrees.find(w => w.branch === 'wt-b')!
    const selA = { worktreeId: recA.worktreeId, generation: recA.generation }
    const selB = { worktreeId: recB.worktreeId, generation: recB.generation }

    const spoolA = join(base, 'spools/a')
    const spoolB = join(base, 'spools/b')
    const bA = writeBinding(main, 'repo-orig', selA, spoolA, 'antigravity')
    const bB = writeBinding(wtB, 'repo-orig', selB, spoolB, 'antigravity')

    const resolver = sessionTargetResolver(registry, () => {})
    const worker = buildWorkerBundle(base)
    const storage = join(base, 'storage')
    const client = new SessionContextClient(storage, 'repo-orig', main, () => true, worker, resolver, 8000)
    cleanup.push(() => client.dispose())

    // 1. Before any session on B, preflight NEVER falsely claims ready: true
    const beforeB = data(await client.call('inspect_capture_health', { ...selB, source: 'native', agent: 'antigravity' }))
    expect(beforeB.executionPreflight).toMatchObject({
      captureStatus: 'PENDING_FIRST_SESSION',
      ready: false,
      origin: { state: 'UNKNOWN', observedOnTarget: false }
    })

    // 2. Session originated in A (even if shell cwd executes in B, workspacePaths stays A)
    const cwdBefore = process.cwd()
    const agConvA = '11111111-1111-4111-8111-111111111111'
    spoolBatch(bA, agConvA, 2, new Date())
    expect(process.cwd()).toBe(cwdBefore)

    // Trigger ingestion for A only
    const listA = data(await client.call('list_agent_sessions', { source: 'NATIVE_HOOK', ...selA, agent: 'antigravity' }))
    expect(listA.sessions).toHaveLength(1)
    expect(data(await client.call('list_agent_sessions', { source: 'NATIVE_HOOK', ...selB, agent: 'antigravity' })).sessions).toEqual([])

    // 3. Preflight targeting B with session originated in A reports ORIGIN_MISMATCH
    const mismatchPreflight = data(await client.call('inspect_capture_health', {
      ...selB, source: 'native', agent: 'antigravity', sessionId: agConvA
    }))
    expect(mismatchPreflight.executionPreflight).toMatchObject({
      ready: false,
      origin: {
        state: 'ORIGIN_MISMATCH',
        reason: 'SESSION_ORIGINATED_IN_DIFFERENT_WORKTREE',
        observedOnTarget: false,
        recommendedAction: 'START_FRESH_SESSION_IN_TARGET_WORKTREE'
      }
    })
    expect(mismatchPreflight.executionPreflight.origin.observedWorktrees).toEqual([selA])

    // 4. Adapter bind_execution surfaces sessionPreflight without changing cwd
    const continuum = new RepositoryContinuumSession(join(base, 'continuum'), { findByPath: () => ({ id: 'repo-orig', localCheckout: { path: main } }) })
    continuum.activate(main); cleanup.push(() => continuum.dispose())
    const service = continuum.getActiveService()!
    const planReceipt = service.publish('---\nname: Plan\ndescription: Origin check\nkind: EXECUTABLE_PLAN\ndate: 2026-11-19T00:00:00Z\n---\nBody')
    const plan = service.get(planReceipt.artifactId)!
    const adapter = new ContinuumLocalAdapter(
      continuum,
      (artifact, target) => handoffSessionCoverage(client, artifact, target),
      async target => {
        const res = await client.call('inspect_capture_health', { ...target, source: 'native' })
        return data(res).executionPreflight
      }
    )
    const bound = await adapter.operations.bind_execution.execute(
      { repositoryId: 'repo-orig', worktreeId: selB.worktreeId, worktreeGeneration: selB.generation, sourceArtifactId: plan.artifactId },
      { connected: () => true }
    ) as any
    expect(bound.sessionPreflight).toMatchObject({ worktreeId: selB.worktreeId, ready: false, origin: { observedOnTarget: false } })
    expect(process.cwd()).toBe(cwdBefore)

    // 5. Handoff linking session from A onto target B rejects association cleanly and surfaces originPreflight
    const coverageCheck = await handoffSessionCoverage(client, {
      ...plan,
      metadata: { ...plan.metadata, sessionLinks: [{ sessionId: agConvA }] }
    } as any, selB) as any
    expect(coverageCheck).toMatchObject({ coverage: 'PARTIAL' })
    expect(coverageCheck.receipts?.[0]?.originPreflight?.origin).toMatchObject({ state: 'ORIGIN_MISMATCH', observedWorktrees: [selA] })

    // 6. Fresh session originated in B captures in B automatically and aligns
    const agConvB = '33333333-3333-4333-8333-333333333333'
    spoolBatch(bB, agConvB, 2, new Date())
    const listB = data(await client.call('list_agent_sessions', { source: 'NATIVE_HOOK', ...selB, agent: 'antigravity' }))
    expect(listB.sessions).toHaveLength(1)
    const alignedPreflight = data(await client.call('inspect_capture_health', {
      ...selB, source: 'native', agent: 'antigravity', sessionId: agConvB
    }))
    expect(alignedPreflight.executionPreflight).toMatchObject({
      captureStatus: 'CAPTURE_OBSERVED',
      ready: true,
      origin: { state: 'ALIGNED', observedOnTarget: true, observedWorktrees: [selB] }
    })

    // 7. Disabled binding surfaces UNAVAILABLE (distinct from UNKNOWN)
    writeBinding(wtB, 'repo-orig', selB, spoolB, 'antigravity', false)
    const disabledPreflight = data(await client.call('inspect_capture_health', {
      ...selB, source: 'native', agent: 'antigravity', sessionId: agConvB
    }))
    expect(disabledPreflight.executionPreflight).toMatchObject({
      captureStatus: 'BINDING_DISABLED',
      ready: false
    })
  }, 40_000)
})
