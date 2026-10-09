import { join } from 'node:path'
import { AcademyStore } from './academy-store'
import { observeSkillDirectory, observeStableSkillDirectory, removeSkillDirectory, replaceSkillDirectory } from './academy-filesystem'

export class AcademyProjectionService {
  private readonly pending = new Map<string, Promise<unknown>>()
  constructor(private readonly store: AcademyStore) {}

  async exclusive<T>(destinationId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(destinationId) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(action)
    this.pending.set(destinationId, next)
    try { return await next } finally { if (this.pending.get(destinationId) === next) this.pending.delete(destinationId) }
  }

  async reconcileAll(): Promise<void> {
    for (const destination of this.store.listDestinations().filter((item) => item.enabled)) await this.reconcileDestination(destination.id)
  }

  reconcileDestination(destinationId: string): Promise<void> {
    return this.exclusive(destinationId, () => this.reconcileLocked(destinationId))
  }

  private async reconcileLocked(destinationId: string): Promise<void> {
    const destination = this.store.listDestinations().find((item) => item.id === destinationId)
    if (!destination) return
    let blocked = false
    try {
      for (const summary of this.store.list()) {
        const skill = this.store.get(summary.id)
        const projection = this.store.getProjection(skill.id, destination.id)
        const directory = join(destination.path, '.skills', skill.name)
        const shouldExist = destination.enabled && skill.status === 'ACTIVE' && this.store.isAssigned(skill.id, destination.id)
        const paths = projection?.skillName && projection.skillName !== skill.name
          ? [join(destination.path, '.skills', projection.skillName), directory] : [directory]
        let skillBlocked = false
        for (const path of paths) {
          const keep = path === directory && shouldExist
          const disk = await observeSkillDirectory(path)
          if (keep && disk.hash === skill.current.packageHash) {
            this.store.setProjection(skill.id, destination.id, skill.currentVersion, disk.hash, skill.name)
            continue
          }
          if (!keep && disk.hash === 'DELETED') continue
          const own = disk.hash === projection?.packageHash
          const newProjection = disk.hash === 'DELETED' && (!projection || path === directory && projection.skillName !== skill.name)
          if (!own && !newProjection) {
            const stable = await observeStableSkillDirectory(path)
            if (stable?.hash === disk.hash) this.store.createConflict(skill.id, 'FILESYSTEM', projection?.version ?? null, stable.package, stable.hash, destination.id, path)
            skillBlocked = true
            continue
          }
          if (keep) {
            try {
              await replaceSkillDirectory(path, skill.current.package, disk.hash)
              this.store.setProjection(skill.id, destination.id, skill.currentVersion, skill.current.packageHash, skill.name)
            } catch (error: any) {
              if (error.code !== 'PROJECTION_CHANGED') throw error
              const changed = await observeStableSkillDirectory(path)
              if (changed) this.store.createConflict(skill.id, 'FILESYSTEM', projection?.version ?? null, changed.package, changed.hash, destination.id, path)
              skillBlocked = true
            }
          } else {
            if ((await observeSkillDirectory(path)).hash !== disk.hash) { skillBlocked = true; continue }
            await removeSkillDirectory(path)
          }
        }
        if (!shouldExist && !skillBlocked) this.store.removeProjection(skill.id, destination.id)
        blocked ||= skillBlocked
      }
      this.store.markDestination(destination.id, blocked ? 'ERROR' : 'SYNCED', blocked ? 'Synchronization requires conflict review.' : null)
    } catch (error) {
      this.store.markDestination(destination.id, 'ERROR', error instanceof Error ? error.message : String(error))
    }
  }
}
