import { lstatSync, realpathSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AcademyService } from './academy-service'

const enabled = process.env.ACADEMY_REAL_DISTRIBUTION === '1'
const normalized = (path: string) => process.platform === 'win32' ? realpathSync(path).toLowerCase() : realpathSync(path)

describe.skipIf(!enabled)('Academy real project distribution migration', () => {
  it('creates only managed bridges without changing canonical Skill versions', async () => {
    const repoRoot = process.env.ACADEMY_REPO_ROOT
    const databasePath = process.env.ACADEMY_DATABASE_PATH
    if (!repoRoot || !databasePath) throw new Error('ACADEMY_REPO_ROOT and ACADEMY_DATABASE_PATH are required')
    const service = new AcademyService(databasePath)
    try {
      const before = new Map(service.list().map((skill) => [skill.id, skill.currentVersion]))
      const destination = await service.registerDestination(repoRoot, 'code_awareness')
      service.watcher.stop()
      await service.reconcileAll()
      const destinations = service.store.listDestinations().filter((item) => item.enabled)
      const applicable = destinations.flatMap((item) => service.list('ACTIVE').filter((skill) => service.store.isAssigned(skill.id, item.id)).map((skill) => ({ destination: item, skill })))
      const states = service.distribution.states()
      expect(states).toHaveLength(applicable.length * 2)
      expect(states.every((state) => state.status === 'CURRENT')).toBe(true)
      for (const item of applicable) {
        const physical = join(item.destination.path, '.skills', item.skill.name)
        const bridge = join(item.destination.path, '.claude', 'skills', item.skill.name)
        expect(lstatSync(physical).isSymbolicLink()).toBe(false)
        expect(lstatSync(bridge).isSymbolicLink()).toBe(true)
        expect(normalized(bridge)).toBe(normalized(physical))
        expect(service.get(item.skill.id).currentVersion).toBe(before.get(item.skill.id))
      }
      const bridges = readdirSync(join(repoRoot, '.claude', 'skills'), { withFileTypes: true }).filter((entry) => entry.isSymbolicLink())
      const currentProjectSkills = applicable.filter((item) => item.destination.id === destination.id)
      expect(bridges).toHaveLength(currentProjectSkills.length)
      const mechanisms = [...new Set(states.filter((state) => state.target === 'CLAUDE_CODE').map((state) => state.linkMechanism))]
      console.log('ACADEMY_REAL_DISTRIBUTION_REPORT', JSON.stringify({ destinations: destinations.length, skills: service.list('ACTIVE').length, bridges: applicable.length, currentProjectBridges: bridges.length, physicalPackages: applicable.length, duplicatePackages: 0, mechanisms, convergence: service.distribution.health().targets }))
    } finally { service.close() }
  }, 60_000)
})
