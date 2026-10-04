import type { AcademyDistributionHealth, AcademyDistributionState, AcademyDistributionTarget, AcademySkillDetail } from '../../../shared/types/academy-types'
import type { AcademyStore } from '../academy-store'
import { ClaudeCodeDistributionAdapter } from './claude-code-distribution-adapter'
import type { AcademyDistributionAdapter, AcademyDistributionAdapterResult } from './distribution-adapter'
import { FilesystemNativeDistributionAdapter } from './filesystem-native-distribution-adapter'

const TARGETS: AcademyDistributionTarget[] = ['FILESYSTEM_NATIVE', 'CLAUDE_CODE']

export class AcademyDistributionService {
  private readonly adapters: Map<AcademyDistributionTarget, AcademyDistributionAdapter>

  constructor(private readonly store: AcademyStore, adapters?: AcademyDistributionAdapter[]) {
    this.adapters = new Map((adapters ?? [new FilesystemNativeDistributionAdapter(store), new ClaudeCodeDistributionAdapter()]).map((adapter) => [adapter.target, adapter]))
  }

  async reconcileAll(): Promise<void> {
    for (const destination of this.store.listDestinations()) await this.reconcileDestination(destination.id)
  }

  async reconcileDestination(destinationId: string): Promise<void> {
    const destination = this.store.listDestinations().find((item) => item.id === destinationId)
    if (!destination) return
    for (const summary of this.store.list()) {
      const skill = this.store.get(summary.id)
      const applicable = destination.enabled && skill.status === 'ACTIVE' && this.store.isAssigned(skill.id, destination.id)
      if (!applicable) {
        for (const target of TARGETS) await this.remove(skill, destination.id, target)
        continue
      }

      const filesystem = await this.run('FILESYSTEM_NATIVE', 'reconcile', skill, destination.id)
      if (filesystem.status !== 'CURRENT') {
        this.persist(skill, destination.id, 'CLAUDE_CODE', {
          status: filesystem.status === 'ERROR' ? 'ERROR' : filesystem.status,
          distributedVersion: filesystem.distributedVersion,
          distributedHash: filesystem.distributedHash,
          errorCode: 'FILESYSTEM_NOT_CURRENT', errorMessage: 'Claude Code distribution waits for the .skills projection to converge.',
          exposureName: skill.name, linkMechanism: null
        })
        continue
      }
      await this.run('CLAUDE_CODE', 'reconcile', skill, destination.id)
    }
  }

  async verifyAll(): Promise<void> {
    for (const destination of this.store.listDestinations().filter((item) => item.enabled)) {
      for (const summary of this.store.list('ACTIVE')) {
        const skill = this.store.get(summary.id)
        if (!this.store.isAssigned(skill.id, destination.id)) continue
        const filesystem = await this.run('FILESYSTEM_NATIVE', 'inspect', skill, destination.id)
        if (filesystem.status === 'CURRENT') await this.run('CLAUDE_CODE', 'inspect', skill, destination.id)
        else this.persist(skill, destination.id, 'CLAUDE_CODE', { ...filesystem, errorCode: 'FILESYSTEM_NOT_CURRENT', errorMessage: 'Claude Code distribution waits for the .skills projection to converge.', exposureName: skill.name, linkMechanism: null })
      }
    }
  }

  states(skillId?: string): AcademyDistributionState[] { return this.store.listDistributionStates(skillId) }

  health(): AcademyDistributionHealth {
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
    const destination = this.store.listDestinations().find((item) => item.id === destinationId)!
    const previous = this.store.getDistributionState(skill.id, destinationId, target)
    const adapter = this.adapters.get(target)!
    let result: AcademyDistributionAdapterResult
    try { result = await adapter[operation]({ destination, skill, previous }) } catch (error) {
      result = { status: 'ERROR', distributedVersion: null, distributedHash: null, errorCode: 'DISTRIBUTION_ERROR', errorMessage: error instanceof Error ? error.message : String(error), exposureName: previous?.exposureName ?? skill.name, linkMechanism: previous?.linkMechanism ?? null }
    }
    this.persist(skill, destinationId, target, result)
    return result
  }

  private async remove(skill: AcademySkillDetail, destinationId: string, target: AcademyDistributionTarget): Promise<void> {
    const previous = this.store.getDistributionState(skill.id, destinationId, target)
    if (!previous) return
    const destination = this.store.listDestinations().find((item) => item.id === destinationId)!
    const result = await this.adapters.get(target)!.remove({ destination, skill, previous })
    if (result) this.persist(skill, destinationId, target, result)
    else this.store.removeDistributionState(skill.id, destinationId, target)
  }

  private persist(skill: AcademySkillDetail, destinationId: string, target: AcademyDistributionTarget, result: AcademyDistributionAdapterResult): void {
    this.store.setDistributionState({ skillId: skill.id, destinationId, target, canonicalVersion: skill.currentVersion, canonicalHash: skill.current.packageHash, ...result })
  }
}
