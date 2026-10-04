import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AcademyService } from './academy-service'
import { hashAcademyPackage } from './academy-package'
import { readSkillDirectory } from './academy-filesystem'

const enabled = process.env.ACADEMY_REAL_MIGRATION === '1'

describe.skipIf(!enabled)('Academy real catalog migration', () => {
  it('imports the current repository catalog without semantic changes and hands it to managed projection', async () => {
    const repoRoot = process.env.ACADEMY_REPO_ROOT
    const databasePath = process.env.ACADEMY_DATABASE_PATH
    if (!repoRoot || !databasePath) throw new Error('ACADEMY_REPO_ROOT and ACADEMY_DATABASE_PATH are required')
    const service = new AcademyService(databasePath)
    try {
      const destination = await service.registerDestination(repoRoot, 'code_awareness')
      const sourceRoot = join(repoRoot, '.skills')
      const analysis = await service.importer.analyze(sourceRoot)
      const expected = new Map(analysis.filter((item) => item.package && item.name).map((item) => [item.name!, hashAcademyPackage(item.package!)]))
      const result = await service.import(sourceRoot, destination.id)
      const invalid = result.filter((item) => item.result === 'INVALID')
      const conflicts = result.filter((item) => item.result === 'CONFLICT')
      expect(invalid.map((item) => item.directory.replaceAll('\\', '/'))).toEqual(expect.arrayContaining([expect.stringContaining('/openai-skill-compatibility')]))
      expect(conflicts).toEqual([])
      expect(service.list('ACTIVE')).toHaveLength(expected.size)
      for (const [name, sourceHash] of expected) {
        const canonical = service.store.findByName(name)!
        expect(canonical.current.packageHash).toBe(sourceHash)
        expect(hashAcademyPackage(await readSkillDirectory(join(repoRoot, '.skills', name)))).toBe(sourceHash)
      }
      console.log('ACADEMY_MIGRATION_REPORT', JSON.stringify({ validSkills: expected.size, invalid: invalid.length, conflicts: conflicts.length, imported: result.filter((item) => item.result === 'IMPORTED').length, unchanged: result.filter((item) => item.result === 'UNCHANGED').length }))
    } finally {
      service.close()
    }
  })
})
