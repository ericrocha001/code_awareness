import type { AcademyDistributionHealth, AcademyDistributionState, AcademyDistributionTarget, AcademySkillDetail } from '../../../shared/types/academy-types'
import type { AcademyStore } from '../academy-store'
import { ClaudeCodeDistributionAdapter } from './claude-code-distribution-adapter'
import { AntigravityDistributionAdapter } from './antigravity-distribution-adapter'
import type { AcademyDistributionAdapter, AcademyDistributionAdapterResult } from './distribution-adapter'
import { FilesystemNativeDistributionAdapter } from './filesystem-native-distribution-adapter'

const CONSUMERS: AcademyDistributionTarget[] = ['CLAUDE_CODE', 'ANTIGRAVITY']
const TARGETS: AcademyDistributionTarget[] = ['FILESYSTEM_NATIVE', ...CONSUMERS]

export class AcademyDistributionService {
  private readonly adapters: Map<AcademyDistributionTarget, AcademyDistributionAdapter>

  constructor(private readonly store: AcademyStore, adapters?: AcademyDistributionAdapter[]) {
    this.adapters = new Map((adapters ?? [new FilesystemNativeDistributionAdapter(store), new ClaudeCodeDistributionAdapter(), new AntigravityDistributionAdapter()]).map((adapter) => [adapter.target, adapter]))
  }

  async reconcileAll(): Promise<void> {
    for (const destination of this.store.listDestinations()) {
      if (this.store.isClosed) return
      await this.reconcileDestination(destination.id)
    }
  }

  async reconcileDestination(destinationId: string): Promise<void> {
    if (this.store.isClosed) return
    const destination = this.store.listDestinations().find((item) => item.id === destinationId)
    if (!destination) return
    for (const summary of this.store.list()) {
      if (this.store.isClosed) return
      const skill = this.store.get(summary.id)
      const applicable = destination.enabled && skill.status === 'ACTIVE' && this.store.isAssigned(skill.id, destination.id)
      if (!applicable) {
        for (const target of TARGETS) {
          if (this.store.isClosed) return
          await this.remove(skill, destination.id, target)
        }
        continue
      }

      const filesystem = await this.run('FILESYSTEM_NATIVE', 'reconcile', skill, destination.id)
      if (this.store.isClosed) return
      if (filesystem.status !== 'CURRENT') {
        for (const target of CONSUMERS) {
          if (this.store.isClosed) return
          this.persist(skill, destination.id, target, {
            status: filesystem.status === 'ERROR' ? 'ERROR' : filesystem.status,
            distributedVersion: filesystem.distributedVersion,
            distributedHash: filesystem.distributedHash,
            errorCode: 'FILESYSTEM_NOT_CURRENT', errorMessage: 'Skill bridge distribution waits for the .skills projection to converge.',
            exposureName: skill.name, linkMechanism: null
          })
        }
        continue
      }
      for (const target of CONSUMERS) {
        if (this.store.isClosed) return
        await this.run(target, 'reconcile', skill, destination.id)
      }
    }
  }

  async verifyAll(): Promise<void> {
    if (this.store.isClosed) return
    for (const destination of this.store.listDestinations().filter((item) => item.enabled)) {
      if (this.store.isClosed) return
      for (const summary of this.store.list('ACTIVE')) {
        if (this.store.isClosed) return
        const skill = this.store.get(summary.id)
        if (!this.store.isAssigned(skill.id, destination.id)) continue
        const filesystem = await this.run('FILESYSTEM_NATIVE', 'inspect', skill, destination.id)
        if (this.store.isClosed) return
        for (const target of CONSUMERS) {
          if (this.store.isClosed) return
          if (filesystem.status === 'CURRENT') await this.run(target, 'inspect', skill, destination.id)
          else this.persist(skill, destination.id, target, { ...filesystem, errorCode: 'FILESYSTEM_NOT_CURRENT', errorMessage: 'Skill bridge distribution waits for the .skills projection to converge.', exposureName: skill.name, linkMechanism: null })
        }
      }
    }
  }

  states(skillId?: string): AcademyDistributionState[] {
    if (this.store.isClosed) return []
    return this.store.listDistributionStates(skillId)
  }

  health(): AcademyDistributionHealth {
    if (this.store.isClosed) {
      return {
        targets: TARGETS.map((target) => ({
          target, convergence: 'DEGRADED',
          current: 0, pending: 0, drifted: 0, missing: 0, error: 0,
          lastReconciledAt: null
        }))
      }
    }
    const states = this.store.listDistributionStates()
    return { targets: TARGETS.map((target) => {
      const values = states.filter((state) => state.target === target)
      const count = (status: AcademyDistributionState['status']) => values.filter((state) => state.status === status).length
      const dates = values.map((state) => state.checkedAt).sort()
      return {
        target, convergence: values.every((state) => state.status === 'CURRENT') ? 'CONVERGED' : 'DEGRADED',
        current: count('CURRENT'), pending: count('PENDING'), drifted: count('DRIFTED'), missing: count('MISSING'), error: count('ERROR'),
        lastReconciledAt: dates.at(-1) ?? null
      }
    }) }
  }

  private async run(target: AcademyDistributionTarget, operation: 'inspect' | 'reconcile', skill: AcademySkillDetail, destinationId: string): Promise<AcademyDistributionAdapterResult> {
    if (this.store.isClosed) {
      return { status: 'PENDING', distributedVersion: null, distributedHash: null, errorCode: null, errorMessage: null, exposureName: skill.name, linkMechanism: null }
    }
    const destination = this.store.listDestinations().find((item) => item.id === destinationId)!
    const previous = this.store.getDistributionState(skill.id, destinationId, target)
    const adapter = this.adapters.get(target)!
    let result: AcademyDistributionAdapterResult
    try {
      result = await adapter[operation]({ destination, skill, previous })
    } catch (error) {
      result = { status: 'ERROR', distributedVersion: null, distributedHash: null, errorCode: 'DISTRIBUTION_ERROR', errorMessage: error instanceof Error ? error.message : String(error), exposureName: previous?.exposureName ?? skill.name, linkMechanism: previous?.linkMechanism ?? null }
    }
    if (this.store.isClosed) {
      return { status: 'PENDING', distributedVersion: result.distributedVersion, distributedHash: result.distributedHash, errorCode: null, errorMessage: null, exposureName: result.exposureName, linkMechanism: result.linkMechanism }
    }
    const latest = this.store.get(skill.id)
    if (latest.currentVersion !== skill.currentVersion || latest.current.packageHash !== skill.current.packageHash) {
      return { status: 'PENDING', distributedVersion: result.distributedVersion, distributedHash: result.distributedHash, errorCode: null, errorMessage: null, exposureName: result.exposureName, linkMechanism: result.linkMechanism }
    }
    this.persist(skill, destinationId, target, result)
    return result
  }

  private async remove(skill: AcademySkillDetail, destinationId: string, target: AcademyDistributionTarget): Promise<void> {
    if (this.store.isClosed) return
    const previous = this.store.getDistributionState(skill.id, destinationId, target)
    if (!previous) return
    const destination = this.store.listDestinations().find((item) => item.id === destinationId)!
    const result = await this.adapters.get(target)!.remove({ destination, skill, previous })
    if (this.store.isClosed) return
    if (result) this.persist(skill, destinationId, target, result)
    else this.store.removeDistributionState(skill.id, destinationId, target)
  }

  private persist(skill: AcademySkillDetail, destinationId: string, target: AcademyDistributionTarget, result: AcademyDistributionAdapterResult): void {
    if (this.store.isClosed) return
    this.store.setDistributionState({ skillId: skill.id, destinationId, target, canonicalVersion: skill.currentVersion, canonicalHash: skill.current.packageHash, ...result })
  }
}
