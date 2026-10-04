import { existsSync, mkdirSync, watch, type FSWatcher } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'
import { AcademyStore } from './academy-store'
import { AcademyProjectionService } from './academy-projection-service'
import { hashAcademyPackage } from './academy-package'
import { readSkillDirectory } from './academy-filesystem'

export class AcademyWatcher {
  private readonly watchers = new Map<string, FSWatcher>()
  private readonly timers = new Map<string, NodeJS.Timeout>()

  constructor(private readonly store: AcademyStore, private readonly projections: AcademyProjectionService, private readonly stabilizationMs = 250, private readonly afterProjection?: () => Promise<void>) {}

  start(): void {
    this.stop()
    for (const destination of this.store.listDestinations().filter((item) => item.enabled)) {
      const root = join(destination.path, '.skills')
      try {
        mkdirSync(root, { recursive: true })
        const watcher = watch(root, { recursive: true }, (_event, filename) => {
          if (!filename) return
          const [skillName] = filename.toString().split(/[\\/]/)
          if (skillName) this.schedule(destination.id, root, skillName)
        })
        this.watchers.set(destination.id, watcher)
      } catch (error) {
        this.store.markDestination(destination.id, 'ERROR', error instanceof Error ? error.message : String(error))
      }
    }
  }

  stop(): void {
    for (const watcher of this.watchers.values()) watcher.close()
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.watchers.clear(); this.timers.clear()
  }

  async ingest(destinationId: string, skillName: string): Promise<void> {
    const destination = this.store.listDestinations().find((item) => item.id === destinationId)
    const skill = this.store.findByName(skillName)
    if (!destination || !skill) return
    const directory = join(destination.path, '.skills', skillName)
    if (!existsSync(directory)) {
      this.store.createConflict(skill.id, 'FILESYSTEM', this.store.getProjection(skill.id, destination.id)?.version ?? null, null, 'DELETED', destination.id, directory)
      return
    }
    try {
      const pkg = await readSkillDirectory(directory)
      const hash = hashAcademyPackage(pkg)
      const projection = this.store.getProjection(skill.id, destination.id)
      if (hash === skill.current.packageHash) {
        this.store.setProjection(skill.id, destination.id, skill.currentVersion, hash, skill.name)
        return
      }
      if (!projection || projection.version !== skill.currentVersion) {
        this.store.createConflict(skill.id, 'FILESYSTEM', projection?.version ?? null, pkg, hash, destination.id, directory)
        return
      }
      this.store.update({ skillId: skill.id, expectedVersion: skill.currentVersion, package: pkg, origin: 'FILESYSTEM' })
      await this.projections.reconcileAll()
      await this.afterProjection?.()
    } catch (error) {
      const current = this.store.get(skill.id)
      this.store.createConflict(skill.id, 'FILESYSTEM', this.store.getProjection(skill.id, destination.id)?.version ?? null, null, `INVALID:${error instanceof Error ? error.message : String(error)}`, destination.id, directory)
      if (current.currentVersion !== skill.currentVersion) await this.projections.reconcileAll()
    }
  }

  private schedule(destinationId: string, root: string, skillName: string): void {
    const key = `${destinationId}:${skillName}`
    const previous = this.timers.get(key)
    if (previous) clearTimeout(previous)
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key)
      void this.ingest(destinationId, skillName)
    }, this.stabilizationMs))
  }
}
