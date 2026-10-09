import { mkdirSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { AcademyStore } from './academy-store'
import { AcademyProjectionService } from './academy-projection-service'
import { observeStableSkillDirectory } from './academy-filesystem'

export class AcademyWatcher {
  private readonly watchers = new Map<string, FSWatcher>()
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private stopped = true

  constructor(private readonly store: AcademyStore, private readonly projections: AcademyProjectionService, private readonly stabilizationMs = 250) {}

  start(): void {
    this.stop()
    this.stopped = false
    for (const destination of this.store.listDestinations().filter((item) => item.enabled)) {
      const root = join(destination.path, '.skills')
      try {
        mkdirSync(root, { recursive: true })
        this.watchers.set(destination.id, watch(root, { recursive: true }, (_event, filename) => {
          const [skillName] = filename?.toString().split(/[\\/]/) ?? []
          if (skillName && !skillName.startsWith('.academy-')) this.schedule(destination.id, skillName)
        }))
      } catch (error) {
        this.store.markDestination(destination.id, 'ERROR', String(error))
      }
    }
  }

  stop(): void {
    this.stopped = true
    for (const watcher of this.watchers.values()) watcher.close()
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.watchers.clear(); this.timers.clear()
  }

  ingest(destinationId: string, skillName: string): Promise<void> {
    return this.projections.exclusive(destinationId, async () => {
      if (this.stopped) return
      const destination = this.store.listDestinations().find((item) => item.id === destinationId)
      const skill = this.store.findByName(skillName)
      if (!destination?.enabled || !skill || skill.status !== 'ACTIVE' || !this.store.isAssigned(skill.id, destinationId)) return
      const directory = join(destination.path, '.skills', skillName)
      const disk = await observeStableSkillDirectory(directory, this.stabilizationMs)
      if (!disk || this.stopped) return
      const current = this.store.get(skill.id)
      const projection = this.store.getProjection(skill.id, destination.id)
      if (disk.hash === current.current.packageHash) {
        this.store.setProjection(skill.id, destination.id, current.currentVersion, disk.hash, current.name)
        return
      }
      if (disk.hash === projection?.packageHash) return
      this.store.createConflict(skill.id, 'FILESYSTEM', projection?.version ?? null, disk.package, disk.hash, destination.id, directory)
    })
  }

  private schedule(destinationId: string, skillName: string): void {
    const key = `${destinationId}:${skillName}`
    const previous = this.timers.get(key)
    if (previous) clearTimeout(previous)
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key)
      void this.ingest(destinationId, skillName).catch((error) => {
        if (!this.stopped) this.store.markDestination(destinationId, 'ERROR', String(error))
      })
    }, this.stabilizationMs))
  }
}
