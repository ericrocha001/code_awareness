import { createHash } from 'node:crypto'
import { dirname, posix } from 'node:path'
import type { OrchestrationGitReader } from './work-orchestration-service'
import type { WorktreeContractNavigation, ContractCapture, DirectContractInterference } from '../core/context/worktree-contract-navigation'
import type { CoordinationHistory, CoordinationReference, WorklineObservedState } from '../git-operations/git-coordination-evidence'

export interface StructuralFinding {
  provider: string
  consumer: string
  base: string
  providerGeneration: string
  consumerGeneration: string
  providerRevision: string
  consumerRevision: string
  evidence: DirectContractInterference[]
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const snapshotRevision = (s: ContractCapture['snapshot'] | Awaited<ReturnType<OrchestrationGitReader['getCoordinationSnapshot']>>['snapshot']) => hash([s.head, s.branch, s.operation, s.indexRevision, s.worktreeRevision])
const candidates = (provider: ContractCapture, consumer: ContractCapture) => consumer.files.filter(f => f.current && f.changed.size && f.current.importBindings.some(b => {
  if (!/^\.\.?\//.test(b.sourceModule)) return false
  const target = posix.normalize(posix.join(dirname(f.path), b.sourceModule)).replace(/\.[cm]?[jt]sx?$/, '')
  return provider.files.some(p => p.contracts.length && (p.path.replace(/\.[cm]?[jt]sx?$/, '') === target || p.path.replace(/\/index\.[cm]?[jt]sx?$/, '') === target))
})).map(f => f.path)

export class SelectiveContractDiscovery {
  readonly captures = new Map<string, ContractCapture>()
  readonly examinedPairs = new Set<string>()
  readonly pending = new Map<string, string>()
  readonly observedStates = new Map<string, WorklineObservedState>()
  private readonly revisions = new Map<string, string>()
  private epoch = 0
  readonly stats = { observations: 0, captures: 0, extractions: 0, bytes: 0, confirmedPairs: 0 }
  constructor(private readonly git: OrchestrationGitReader, private readonly navigation: Pick<WorktreeContractNavigation, 'inspect' | 'confirm'>, private readonly isCurrent: () => boolean = () => true) {}

  private check(epoch?: number) { if (!this.isCurrent() || epoch !== undefined && this.epoch !== epoch) throw new Error('ORCHESTRATION_PAUSED') }
  invalidate() { this.epoch++; this.revisions.clear(); this.examinedPairs.clear(); this.observedStates.clear() }
  remove(id: string) { this.captures.delete(id); this.revisions.delete(id); this.pending.delete(id); this.observedStates.delete(id) }

  private async capture(worktreeId: string, paths: string[], baseCommit: string) {
    this.check()
    const result = await this.navigation.inspect({ worktreeId, paths, baseCommit })
    this.check()
    this.stats.captures++; this.stats.extractions += result.extractions; this.stats.bytes += result.bytes
    return result
  }

  async observe(worktreeId: string, referenceHead: string, reference?: CoordinationReference) {
    const epoch = this.epoch
    this.check()
    this.stats.observations++
    const observed = await this.git.getCoordinationSnapshot(worktreeId)
    this.check()
    if (!observed.snapshot.head) throw new Error('HEAD_UNAVAILABLE')
    const localRevision = snapshotRevision(observed.snapshot), previous = this.observedStates.get(worktreeId)
    const revision = hash([referenceHead, reference?.worktreeId, reference?.generation, observed.record.generation, localRevision])
    const publish = (history?: CoordinationHistory) => {
      this.check(epoch)
      const sameGeneration = previous?.generation === observed.record.generation && previous.repositoryId === (reference?.repositoryId ?? null)
      this.observedStates.delete(worktreeId)
      this.observedStates.set(worktreeId, { repositoryId: reference?.repositoryId ?? null, generation: observed.record.generation, head: observed.snapshot.head!, localRevision,
        clean: observed.paths.length === 0 && observed.conflictCount === 0 && observed.snapshot.operation === null,
        stable: !!sameGeneration && previous!.localRevision === localRevision, changed: !!sameGeneration && previous!.localRevision !== localRevision,
        history: reference && history && history.repositoryId === reference.repositoryId && history.head === observed.snapshot.head && history.referenceHead === referenceHead &&
          reference.head === referenceHead ? { ...history, reference: { ...reference }, observedAt: new Date().toISOString() } : null })
      while (this.observedStates.size > 256) this.observedStates.delete(this.observedStates.keys().next().value!)
    }
    if (this.revisions.get(worktreeId) === revision) { publish(previous?.history ?? undefined); return false }
    this.captures.delete(worktreeId)
    const commits = await this.git.getCoordinationCommitPaths(referenceHead, observed.snapshot.head)
    this.check(epoch)
    const paths = [...new Set([...commits.right, ...observed.paths])].filter(p => /\.[cm]?[jt]sx?$/.test(p)).sort()
    if (paths.length > 10) { this.pending.set(worktreeId, 'STRUCTURAL_PATH_BUDGET'); this.revisions.set(worktreeId, revision); publish(commits.history); return true }
    if (!paths.length) { this.pending.delete(worktreeId); this.revisions.set(worktreeId, revision); publish(commits.history); return true }
    const capture = await this.capture(worktreeId, paths, commits.base)
    this.check(epoch)
    if (snapshotRevision(capture.snapshot) !== snapshotRevision(observed.snapshot) || capture.generation !== observed.record.generation) throw new Error('GIT_STATE_CHANGED')
    this.captures.set(worktreeId, capture)
    while (this.captures.size > 64 || [...this.captures.values()].reduce((bytes, c) => bytes + c.bytes, 0) > 4 * 1024 * 1024) {
      const oldest = this.captures.keys().next().value!; this.remove(oldest); this.pending.set(oldest, 'CAPTURE_BUDGET')
    }
    this.revisions.set(worktreeId, revision)
    if (capture.files.some(f => f.limitations.length)) this.pending.set(worktreeId, 'STRUCTURAL_SCOPE_PARTIAL')
    else this.pending.delete(worktreeId)
    publish(commits.history)
    return true
  }

  async investigate(maxPairs: number): Promise<StructuralFinding[]> {
    const epoch = this.epoch
    this.check()
    const findings: StructuralFinding[] = []
    let examined = 0
    for (const provider of this.captures.values()) for (const consumer of this.captures.values()) {
      this.check(epoch)
      if (provider.worktreeId === consumer.worktreeId) continue
      const consumerPaths = candidates(provider, consumer)
      if (!consumerPaths.length) continue
      const revision = hash([provider.worktreeId, provider.fingerprint, consumer.worktreeId, consumer.fingerprint])
      if (this.examinedPairs.has(revision)) continue
      if (examined++ >= maxPairs) { this.pending.set(consumer.worktreeId, 'PAIR_BUDGET'); return findings }
      const contractPaths = provider.files.filter(f => f.contracts.length).map(f => f.path)
      const paths = [...new Set([...contractPaths, ...consumerPaths])].sort()
      if (paths.length > 10) { this.pending.set(consumer.worktreeId, 'STRUCTURAL_PATH_BUDGET'); continue }
      const commits = await this.git.getCoordinationCommitPaths(provider.snapshot.head!, consumer.snapshot.head!)
      const left = await this.capture(provider.worktreeId, contractPaths, commits.base)
      const right = await this.capture(consumer.worktreeId, paths, commits.base)
      if (left.generation !== provider.generation || right.generation !== consumer.generation || hash(left.snapshot) !== hash(provider.snapshot) || hash(right.snapshot) !== hash(consumer.snapshot)) throw new Error('GIT_STATE_CHANGED')
      const evidence = this.navigation.confirm(left, right)
      const [leftAfter, rightAfter] = await Promise.all([this.capture(provider.worktreeId, contractPaths, commits.base), this.capture(consumer.worktreeId, paths, commits.base)])
      const currentBase = await this.git.getCoordinationCommitPaths(leftAfter.snapshot.head!, rightAfter.snapshot.head!)
      this.check(epoch)
      if (leftAfter.fingerprint !== left.fingerprint || rightAfter.fingerprint !== right.fingerprint || currentBase.base !== commits.base) throw new Error('GIT_STATE_CHANGED')
      this.examinedPairs.add(revision); this.stats.confirmedPairs++
      if (this.examinedPairs.size > 256) this.examinedPairs.delete(this.examinedPairs.values().next().value!)
      if (evidence.length) findings.push({ provider: provider.worktreeId, consumer: consumer.worktreeId, base: commits.base,
        providerGeneration: left.generation, consumerGeneration: right.generation, providerRevision: left.fingerprint, consumerRevision: right.fingerprint, evidence })
    }
    return findings
  }
}
