import { expect, it } from 'vitest'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { performance } from 'node:perf_hooks'
import { execFileSync } from 'node:child_process'
import { createTempGitRepo, cleanupTempRepo, gitExec, stageAll, commit } from '../core/git-test-helpers'
import { GitService } from '../core/git-service'
import { GitOperationsService } from '../git-operations/git-operations-service'
import { GitHubGitTransport } from '../github/github-git-transport'
import { WorktreeContractNavigation } from '../core/context/worktree-contract-navigation'
import { SelectiveContractDiscovery } from './structural-discovery'
import { WorkOrchestrationService } from './work-orchestration-service'
import { Workline } from './workline'

it.skipIf(!['before', 'after'].includes(process.env.CA_GIT_ECONOMY_PHASE ?? ''))('profiles equivalent structural discovery, unchanged reconciliation, drift and 101-worktree budgets', async () => {
  const phase = process.env.CA_GIT_ECONOMY_PHASE ?? 'regression'
  const fixtureFile = '.code-awareness/git-economy-fixture.json'
  let root: string, parent: string, roots: string[]
  if (phase === 'after' && existsSync(fixtureFile)) ({ root, parent, roots } = JSON.parse(readFileSync(fixtureFile, 'utf8')))
  else {
    root = await createTempGitRepo(); parent = mkdtempSync(join(tmpdir(), 'git-economy-'))
    writeFileSync(join(root, 'service.ts'), 'export function service(value: number): number { return value + 1 }\n')
    writeFileSync(join(root, 'consumer.ts'), 'import { service } from "./service"\nexport function consume(): number { return service(1) }\n')
    writeFileSync(join(root, 'other.ts'), 'export function service(value: number): number { return value - 1 }\n')
    writeFileSync(join(root, 'control.ts'), 'import { service } from "./other"\nexport function consume(): number { return service(2) }\n')
    await stageAll(root); await commit(root, 'economy base')
    roots = []
    for (const name of ['old-consumer', 'provider', 'control', ...Array.from({ length: 17 }, (_, n) => `quiet-${n}`)]) {
      const target = join(parent, name); await gitExec(root, ['worktree', 'add', '-b', name, target]); roots.push(target)
    }
    writeFileSync(join(roots[1], 'service.ts'), 'export function service(value: string): string { return value + "!" }\n')
    await stageAll(roots[1]); await commit(roots[1], 'changed contract')
    writeFileSync(join(roots[0], 'consumer.ts'), 'import { service } from "./service"\nexport function consume(): number { return service(3) + 2 }\n')
    await stageAll(roots[0])
    writeFileSync(join(roots[0], 'consumer.ts'), 'import { service } from "./service"\nexport function consume(): number { return service(4) + 2 }\n')
    writeFileSync(join(roots[2], 'control.ts'), 'import { service } from "./other"\nexport function consume(): number { return service(5) + 2 }\n')
    writeFileSync(fixtureFile, JSON.stringify({ root, parent, roots }))
  }
  const git = new GitService(), contexts = new AsyncLocalStorage<string>()
  let commands: Array<{ command: string; origin: string; ms: number; bytes: number; failed: boolean }> = []
  const invoke = (git as any).runGitBytes.bind(git)
  ;(git as any).runGitBytes = async (args: string[], ...rest: any[]) => {
    const start = performance.now(), origin = contexts.getStore() ?? 'OTHER'
    const row = { command: args[0] + (args[0] === 'rev-parse' ? ' ' + args.slice(1).filter(a => a.startsWith('--')).join(' ') : ''), origin, ms: 0, bytes: 0, failed: false }
    commands.push(row)
    try { const value = await invoke(args, ...rest); row.bytes = value.length; return value }
    catch (error) { row.failed = true; throw error }
    finally { row.ms = performance.now() - start }
  }
  const wrap = (object: any, name: string, label: string) => {
    const original = object[name].bind(object)
    object[name] = (...args: any[]) => contexts.run([contexts.getStore(), label].filter(Boolean).join('/'), () => original(...args))
  }
  wrap(git, 'captureWorktreeReadSnapshot', 'SNAPSHOT')
  const reader = new GitOperationsService(root, git, new GitHubGitTransport(null, git), { repositoryId: 'economy', isActive: () => true })
  wrap((reader as any).worktrees, 'discover', 'REGISTRY_DISCOVERY')
  wrap((reader as any).worktrees, 'revalidateSelection', 'IDENTITY_REVALIDATION')
  wrap(reader, 'getCoordinationSnapshot', 'OBSERVATION')
  wrap(reader, 'getCoordinationCommitPaths', 'COMMIT_PATHS')
  wrap(reader, 'captureWorktreeStructure', 'STRUCTURE_CAPTURE')
  const measure = async (run: () => Promise<any>) => {
    commands = []
    const start = performance.now(), cpu = process.cpuUsage(), rssBefore = process.memoryUsage().rss
    const result = await run()
    const groups: Record<string, { count: number; ms: number; bytes: number; failures: number }> = {}
    for (const c of commands) {
      const key = `${c.origin} | ${c.command}`, group = groups[key] ??= { count: 0, ms: 0, bytes: 0, failures: 0 }
      group.count++; group.ms += c.ms; group.bytes += c.bytes; group.failures += Number(c.failed)
    }
    return { ms: performance.now() - start, calls: commands.length, cpu: process.cpuUsage(cpu), rssBefore, rssAfter: process.memoryUsage().rss, groups, result }
  }
  const sourceHashes = Object.fromEntries(['src/main/core/git-service.ts', 'src/main/git-operations/git-worktree-registry.ts', 'src/main/git-operations/git-operations-service.ts'].map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]))
  const report: any = { phase, sourceHashes, head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(), gitVersion: execFileSync('git', ['--version'], { encoding: 'utf8', windowsHide: true }).trim(), node: process.version, platform: process.platform, method: 'Same physical fixture; warmed filesystem; sequential observations; two fresh discovery samples; subprocess wall time overlaps, parent CPU only; no cadence waits in native workload', samples: [] }
  try {
    const discovered = (await reader.discoverCoordinationWorktrees()).worktrees
    expect(discovered).toHaveLength(21)
    const reference = discovered.find(w => w.path === root)!, consumer = discovered.find(w => w.path === roots[0])!
    const before = await Promise.all(roots.slice(0, 3).map(path => git.captureWorktreeReadSnapshot(path)))
    let last: SelectiveContractDiscovery
    for (let n = 0; n < 2; n++) {
      last = new SelectiveContractDiscovery(reader, new WorktreeContractNavigation(reader))
      const measured = await measure(async () => {
        for (const record of discovered) await last.observe(record.worktreeId, reference.head!)
        const findings = await last.investigate(1)
        expect(findings).toHaveLength(1)
        expect(findings[0].consumer).toBe(consumer.worktreeId)
        expect(findings[0].evidence[0]).toMatchObject({ symbol: 'service', contractPath: 'service.ts', consumerPath: 'consumer.ts', binding: 'RESOLVED_DIRECT' })
        return { findings, coverage: discovered.length, pending: [...last.pending], stats: { ...last.stats } }
      })
      report.samples.push(measured)
    }
    report.unchanged = await measure(async () => {
      const extractions = last!.stats.extractions
      for (const record of discovered) await last!.observe(record.worktreeId, reference.head!)
      expect(last!.stats.extractions).toBe(extractions)
      return { observations: discovered.length, newExtractions: 0 }
    })
    expect(await Promise.all(roots.slice(0, 3).map(path => git.captureWorktreeReadSnapshot(path)))).toEqual(before)
    report.drift = await measure(async () => {
      writeFileSync(join(roots[0], 'consumer.ts'), 'import { service } from "./service"\nexport function consume(): number { return service(8) + 2 }\n')
      await last!.observe(consumer.worktreeId, reference.head!)
      const navigation = (last as any).navigation, confirm = navigation.confirm.bind(navigation)
      navigation.confirm = (...args: any[]) => { const result = confirm(...args); writeFileSync(join(roots[0], 'consumer.ts'), 'export function consume(): number { return 0 }\n'); return result }
      await expect(last!.investigate(1)).rejects.toThrow('GIT_STATE_CHANGED')
      navigation.confirm = confirm
      return { rejected: 'GIT_STATE_CHANGED', currentFalseAlert: false }
    })
    writeFileSync(join(roots[0], 'consumer.ts'), 'import { service } from "./service"\nexport function consume(): number { return service(4) + 2 }\n')
    report.inventory21 = await measure(() => new WorkOrchestrationService(reader).inventory())
    for (let n = 0; n < 80; n++) await gitExec(root, ['worktree', 'add', '-b', `extra-${n}`, join(parent, `extra-${n}`)])
    report.budget101 = await measure(async () => {
      const orchestration = new WorkOrchestrationService(reader), engine = new SelectiveContractDiscovery(reader, new WorktreeContractNavigation(reader))
      const line = new Workline(() => orchestration.inventory(), engine, () => {})
      line.start(); await line.runOnce(); line.stop()
      const state = line.snapshot(); expect(state.known).toBe(101); expect(state.observed).toBeLessThanOrEqual(2); expect(state.coverage).toBe('PARTIAL')
      return state
    })
    for (let n = 0; n < 80; n++) { await gitExec(root, ['worktree', 'remove', join(parent, `extra-${n}`)]); await gitExec(root, ['branch', '-D', `extra-${n}`]) }
    expect(commands.every(c => !/^(add|commit|checkout|reset|merge|rebase|push|fetch|update-ref)$/.test(c.command))).toBe(true)
    if (phase === 'after') {
      const baseline = JSON.parse(readFileSync('.code-awareness/git-economy-before.json', 'utf8'))
      expect(report.samples.map((sample: any) => sample.result.stats)).toEqual(baseline.samples.map((sample: any) => sample.result.stats))
      const reduction = 1 - report.samples[0].calls / baseline.samples[0].calls
      report.callReduction = reduction
      expect(reduction).toBeGreaterThanOrEqual(0.2)
      expect(report.budget101.result.observed).toBeGreaterThanOrEqual(baseline.budget101.result.observed)
    }
    writeFileSync(`.code-awareness/git-economy-${phase}.json`, JSON.stringify(report, null, 2))
    console.log(JSON.stringify({ phase, detection: report.samples.map((s: any) => ({ ms: s.ms, calls: s.calls })), unchanged: report.unchanged.calls, budget101: report.budget101.calls, reduction: report.callReduction }))
  } finally {
    if (phase !== 'before') { await cleanupTempRepo(root); await cleanupTempRepo(parent) }
  }
}, 600000)
