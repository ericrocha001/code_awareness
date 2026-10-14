import { expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createTempGitRepo, cleanupTempRepo, gitExec, stageAll, commit } from '../core/git-test-helpers'
import { GitService } from '../core/git-service'
import { GitOperationsService } from '../git-operations/git-operations-service'
import { GitHubGitTransport } from '../github/github-git-transport'
import { WorktreeContractNavigation } from '../core/context/worktree-contract-navigation'
import { SelectiveContractDiscovery } from '../work-orchestration/structural-discovery'
import { Workline } from './workline'
import { WorkOrchestrationService } from './work-orchestration-service'
import type { WorktreeStructureCapture } from '../git-operations/git-worktree-capture'
import { createHash } from 'node:crypto'

it('resolves modified consumer scopes for public interface and class member signatures', async () => {
  for (const kind of ['interface', 'class']) {
    const before = kind === 'interface' ? 'export interface Service { run(value: number): number }\n' : 'export class Service { run(value: number): number { return value } private hidden() { return 1 } }\n'
    const after = before.replace('value: number', 'value: string')
    const use = 'import { Service } from "./service"\nexport function consume(service: Service): number { return service.run(1) + 1 }\n'
    const text = (content: string) => ({ content, bytes: Buffer.byteLength(content), hash: createHash('sha256').update(content).digest('hex') })
    const capture = (id: string): WorktreeStructureCapture => ({ repositoryId: 'gate', worktreeId: id, generation: 'g', canonicalHead: 'a'.repeat(40), baseCommit: 'a'.repeat(40), baseSelection: 'EXPLICIT', fingerprint: id,
      snapshot: { head: 'a'.repeat(40), branch: id, operation: null, status: '', indexRevision: 'index', worktreeRevision: 'worktree' },
      state: { dirty: true, staged: false, untracked: false, conflicted: false },
      files: id === 'a' ? [{ path: 'service.ts', committedStatus: null, base: text(before), current: text(after) }] :
        [{ path: 'service.ts', committedStatus: null, base: text(before), current: text(before) }, { path: 'consumer.ts', committedStatus: null, base: text(use), current: text(use.replace('+ 1', '+ 2')) }] })
    const navigation = new WorktreeContractNavigation({ captureWorktreeStructure: async (request, project) => project(capture(request.worktreeId)) })
    const a = await navigation.inspect({ worktreeId: 'a', paths: ['service.ts'] }), b = await navigation.inspect({ worktreeId: 'b', paths: ['service.ts', 'consumer.ts'] })
    writeFileSync('.code-awareness/evolution2-public-contract-diagnostic.json', JSON.stringify({ kind, contracts: a.files[0].contracts, limits: a.files[0].limitations, elements: b.files.map(f => ({ path: f.path, changed: [...f.changed], elements: f.current?.elements.map(e => ({ id: e.id, kind: e.kind, name: e.name, signature: e.declarationSignature, parent: e.parentElementId, visibility: e.visibility })), bindings: f.current?.importBindings, references: f.current?.symbolReferences })) }, null, 2))
    expect(navigation.confirm(a, b)).toMatchObject([{ symbol: 'Service', contractPath: 'service.ts', consumerPath: 'consumer.ts', binding: 'RESOLVED_DIRECT' }])
    if (kind === 'class') {
      const original = capture('a'); original.files[0].current = text(before.replace('return 1', 'return 2'))
      const internal = new WorktreeContractNavigation({ captureWorktreeStructure: async (_request, project) => project(original) })
      expect((await internal.inspect({ worktreeId: 'a', paths: ['service.ts'] })).files[0].contracts).toEqual([])
    }
  }
})
it('discovers a changed direct contract without selecting pairs and rejects unrelated symbols', async () => {
  const root = await createTempGitRepo(), parent = mkdtempSync(join(tmpdir(), 'contract-gate-'))
  try {
    writeFileSync(join(root, 'service.ts'), 'export function service(value: number): number { return value + 1 }\n')
    writeFileSync(join(root, 'consumer.ts'), 'import { service } from "./service"\nexport function consume(): number { return service(1) }\n')
    writeFileSync(join(root, 'other.ts'), 'export function service(value: number): number { return value - 1 }\n')
    writeFileSync(join(root, 'control.ts'), 'import { service } from "./other"\nexport function consume(): number { return service(2) }\n')
    await stageAll(root); await commit(root, 'base')
    const roots: string[] = []
    for (const name of ['a', 'b', 'c']) { const target = join(parent, name); await gitExec(root, ['worktree', 'add', '-b', name, target]); roots.push(target) }
    writeFileSync(join(roots[0], 'service.ts'), 'export function service(value: string): string { return value + "!" }\n'); await stageAll(roots[0]); await commit(roots[0], 'contract')
    writeFileSync(join(roots[1], 'consumer.ts'), 'import { service } from "./service"\nexport function consume(): number { return service(3) + 2 }\n')
    writeFileSync(join(roots[2], 'control.ts'), 'import { service } from "./other"\nexport function consume(): number { return service(4) + 2 }\n')
    const git = new GitService()
    let calls = 0
    const original = (git as any).runGitBytes.bind(git)
    ;(git as any).runGitBytes = (...args: any[]) => { calls++; return original(...args) }
    const reader = new GitOperationsService(root, git, new GitHubGitTransport(null, git), { repositoryId: 'gate', isActive: () => true })
    const discovered = (await reader.discoverCoordinationWorktrees()).worktrees
    const reference = discovered.find(w => w.path === root)!
    const engine = new SelectiveContractDiscovery(reader, new WorktreeContractNavigation(reader))
    const before = await Promise.all(roots.map(p => git.captureWorktreeReadSnapshot(p)))
    const started = performance.now(), cpu = process.cpuUsage()
    for (const worktree of discovered) await engine.observe(worktree.worktreeId, reference.head!)
    const found = await engine.investigate(3)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ provider: discovered.find(w => w.branch === 'a')!.worktreeId, consumer: discovered.find(w => w.branch === 'b')!.worktreeId,
      evidence: [{ contractPath: 'service.ts', consumerPath: 'consumer.ts', symbol: 'service', binding: 'RESOLVED_DIRECT' }] })
    expect(await Promise.all(roots.map(p => git.captureWorktreeReadSnapshot(p)))).toEqual(before)
    const evidence: any = { outcome: 'PASS', elapsedMs: performance.now() - started, cpu: process.cpuUsage(cpu), stats: { ...engine.stats }, gitCalls: calls, alerts: found, controls: [] }
    const a = discovered.find(w => w.branch === 'a')!.worktreeId, b = discovered.find(w => w.branch === 'b')!.worktreeId, c = discovered.find(w => w.branch === 'c')!.worktreeId
    writeFileSync(join(roots[2], 'control.ts'), 'import { service } from "./service"\nexport function consume(service: (n: number) => number): number { return service(8) }\n')
    await engine.observe(c, reference.head!); expect(await engine.investigate(3)).toEqual([]); evidence.controls.push('SHADOW_REJECTED')
    writeFileSync(join(roots[2], 'control.ts'), 'import { service } from "./barrel"\nexport function consume(): number { return service(8) }\n')
    writeFileSync(join(roots[2], 'barrel.ts'), 'export { service } from "./service"\n')
    await engine.observe(c, reference.head!); expect(await engine.investigate(3)).toEqual([]); evidence.controls.push('REEXPORT_NOT_PROOF')
    writeFileSync(join(roots[2], 'control.ts'), 'import { service } from "./service"\nexport function consume( { return service(8)\n')
    await engine.observe(c, reference.head!); expect(await engine.investigate(3)).toEqual([]); expect(engine.pending.has(c)).toBe(true); evidence.controls.push('PARTIAL_PARSE_REJECTED')
    writeFileSync(join(roots[1], 'consumer.ts'), 'import { service } from "./service"\nexport function consume(): number { return service(4) + 2 }\n'); await engine.observe(b, reference.head!)
    const confirmation = (engine as any).navigation.confirm.bind((engine as any).navigation)
    ;(engine as any).navigation.confirm = (...args: any[]) => { const answer = confirmation(...args); writeFileSync(join(roots[1], 'consumer.ts'), 'export function consume(): number { return 0 }\n'); return answer }
    await expect(engine.investigate(3)).rejects.toThrow('GIT_STATE_CHANGED'); (engine as any).navigation.confirm = confirmation; evidence.controls.push('DRIFT_REJECTED')
    writeFileSync(join(roots[0], 'service.ts'), 'export function service(value: number): number { return value + 42 }\n'); await engine.observe(a, reference.head!)
    expect(engine.captures.get(a)!.files[0].contracts).toEqual([]); expect(await engine.investigate(3)).toEqual([]); evidence.controls.push('INTERNAL_IMPLEMENTATION_NOT_CONTRACT')
    await gitExec(roots[0], ['mv', 'service.ts', 'moved.ts']); await engine.observe(a, reference.head!)
    expect(engine.captures.get(a)!.files.some(f => f.limitations.includes('RENAME_REQUIRES_REFINED_SCOPE'))).toBe(true); expect(await engine.investigate(3)).toEqual([]); evidence.controls.push('RENAME_PARTIAL')
    await gitExec(roots[0], ['mv', 'moved.ts', 'service.ts'])
    writeFileSync(join(roots[0], 'service.ts'), 'export function service(value: string): string { return value + "!" }\n')
    writeFileSync(join(roots[1], 'consumer.ts'), 'import { service } from "./service"\nexport function consume(): number { return service(5) + 2 }\n')
    for (let n = 0; n < 17; n++) await gitExec(root, ['worktree', 'add', '-b', 'quiet-' + n, join(parent, 'quiet-' + n)])
    const large = (await reader.discoverCoordinationWorktrees()).worktrees
    const largeEngine = new SelectiveContractDiscovery(reader, new WorktreeContractNavigation(reader)), largeStart = performance.now(), largeCalls = calls
    for (const w of large) await largeEngine.observe(w.worktreeId, reference.head!)
    expect(await largeEngine.investigate(1)).toHaveLength(1)
    evidence.large = { worktrees: large.length, ms: performance.now() - largeStart, gitCalls: calls - largeCalls, stats: { ...largeEngine.stats }, naivePairs: large.length * (large.length - 1) / 2 }
    const extractions = largeEngine.stats.extractions
    for (const w of large) await largeEngine.observe(w.worktreeId, reference.head!)
    expect(largeEngine.stats.extractions).toBe(extractions); evidence.controls.push('UNCHANGED_RECONCILIATION_ZERO_EXTRACTIONS')
    for (let n = 0; n < 80; n++) await gitExec(root, ['worktree', 'add', '-b', 'extra-' + n, join(parent, 'extra-' + n)])
    const budgetEngine = new SelectiveContractDiscovery(reader, new WorktreeContractNavigation(reader)), orchestration = new WorkOrchestrationService(reader)
    const line = new Workline(() => orchestration.inventory(), budgetEngine, () => {})
    const budgetStarted = performance.now(), budgetCalls = calls
    line.start(); await line.runOnce(); line.stop()
    const state = line.snapshot()
    expect(state.known).toBe(101); expect(state.observed).toBeLessThanOrEqual(2); expect(state.coverage).toBe('PARTIAL')
    expect(budgetEngine.stats.confirmedPairs).toBeLessThanOrEqual(1)
    evidence.budget101 = { ms: performance.now() - budgetStarted, gitCalls: calls - budgetCalls, known: state.known, observed: state.observed, pending: state.pending.length, stats: state.stats, cadenceMs: state.cadenceMs, rss: process.memoryUsage().rss }
    writeFileSync('.code-awareness/evolution2-gate-evidence.json', JSON.stringify(evidence, null, 2))
    console.log(JSON.stringify({ outcome: evidence.outcome, ms: evidence.elapsedMs, stats: evidence.stats }))
  } finally { await cleanupTempRepo(root); await cleanupTempRepo(parent) }
}, 420000)
