import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { AcademyStore } from './academy-store'
import { hashAcademyPackage } from './academy-package'
import { readSkillDirectory, removeSkillDirectory, writeSkillDirectory } from './academy-filesystem'

export class AcademyProjectionService {
  constructor(private readonly store: AcademyStore) {}

  async reconcileAll(): Promise<void> {
    for (const destination of this.store.listDestinations().filter((item) => item.enabled)) await this.reconcileDestination(destination.id)
  }

  async reconcileDestination(destinationId: string): Promise<void> {
    const destination = this.store.listDestinations().find((item) => item.id === destinationId)
    if (!destination) return
    try {
      for (const skill of this.store.list()) {
        const projection = this.store.getProjection(skill.id, destination.id)
        const directory = join(destination.path, '.skills', skill.name)
        const previousDirectory = projection?.skillName && projection.skillName !== skill.name ? join(destination.path, '.skills', projection.skillName) : null
        if (previousDirectory && existsSync(previousDirectory)) {
          try {
            if (hashAcademyPackage(await readSkillDirectory(previousDirectory)) === projection.packageHash) await removeSkillDirectory(previousDirectory)
            else {
              const divergent = await readSkillDirectory(previousDirectory)
              this.store.createConflict(skill.id, 'FILESYSTEM', projection.version, divergent, hashAcademyPackage(divergent), destination.id, previousDirectory)
            }
          } catch {}
        }
        const shouldExist = destination.enabled && skill.status === 'ACTIVE' && this.store.isAssigned(skill.id, destination.id)
        if (!shouldExist) {
          if (projection && existsSync(directory)) {
            try {
              const diskHash = hashAcademyPackage(await readSkillDirectory(directory))
              if (diskHash !== projection.packageHash) {
                this.store.createConflict(skill.id, 'FILESYSTEM', projection.version, await readSkillDirectory(directory), diskHash, destination.id, directory)
                continue
              }
            } catch {}
            await removeSkillDirectory(directory)
          }
          this.store.removeProjection(skill.id, destination.id)
          continue
        }
        const detail = this.store.get(skill.id)
        if (projection?.version === detail.currentVersion && projection.packageHash === detail.current.packageHash && existsSync(directory)) {
          try { if (hashAcademyPackage(await readSkillDirectory(directory)) === detail.current.packageHash) continue } catch {}
        }
        await writeSkillDirectory(directory, detail.current.package)
        this.store.setProjection(skill.id, destination.id, detail.currentVersion, detail.current.packageHash, detail.name)
      }
      this.store.markDestination(destination.id, 'SYNCED', null)
    } catch (error) {
      this.store.markDestination(destination.id, 'ERROR', error instanceof Error ? error.message : String(error))
    }
  }
}
