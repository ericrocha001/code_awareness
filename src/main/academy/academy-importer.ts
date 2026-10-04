import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { AcademyImportItem, AcademySkillScope } from '../../shared/types/academy-types'
import { hashAcademyPackage, parseSkillMetadata } from './academy-package'
import { readSkillDirectory } from './academy-filesystem'
import { AcademyStore } from './academy-store'

interface Analysis { directory: string; name: string | null; package?: Awaited<ReturnType<typeof readSkillDirectory>>; error?: string }

export class AcademyImporter {
  constructor(private readonly store: AcademyStore) {}

  async analyze(skillsRoot: string): Promise<Analysis[]> {
    const entries = await readdir(skillsRoot, { withFileTypes: true })
    const results: Analysis[] = []
    for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const directory = join(skillsRoot, entry.name)
      try {
        const pkg = await readSkillDirectory(directory)
        results.push({ directory, name: parseSkillMetadata(pkg.skillMd).name, package: pkg })
      } catch (error) {
        results.push({ directory, name: null, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return results
  }

  async import(skillsRoot: string, scope: AcademySkillScope = 'GLOBAL', projectIds: string[] = []): Promise<AcademyImportItem[]> {
    const analyses = await this.analyze(skillsRoot)
    const results: AcademyImportItem[] = []
    const seenNames = new Set<string>()
    for (const analysis of analyses) {
      if (!analysis.package || !analysis.name) {
        results.push({ directory: analysis.directory, name: analysis.name, result: 'INVALID', error: analysis.error })
        continue
      }
      if (seenNames.has(analysis.name.toLowerCase())) {
        results.push({ directory: analysis.directory, name: analysis.name, result: 'DUPLICATE', error: `Duplicate skill name in import batch: ${analysis.name}` })
        continue
      }
      seenNames.add(analysis.name.toLowerCase())
      const existing = this.store.findByName(analysis.name)
      if (!existing) {
        const created = this.store.create({ package: analysis.package, scope, projectIds, origin: 'IMPORT' })
        results.push({ directory: analysis.directory, name: analysis.name, result: 'IMPORTED', skillId: created.id })
        continue
      }
      const hash = hashAcademyPackage(analysis.package)
      if (hash === existing.current.packageHash) {
        results.push({ directory: analysis.directory, name: analysis.name, result: 'UNCHANGED', skillId: existing.id })
      } else {
        this.store.createConflict(existing.id, 'IMPORT', null, analysis.package, hash, projectIds[0] ?? null, analysis.directory)
        results.push({ directory: analysis.directory, name: analysis.name, result: 'CONFLICT', skillId: existing.id })
      }
    }
    return results
  }
}
