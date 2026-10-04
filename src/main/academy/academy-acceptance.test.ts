import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { AcademyService } from './academy-service'
import { executeAcademyTool } from './academy-mcp'

const roots: string[] = []
const root = () => { const value = mkdtempSync(join(tmpdir(), 'academy-acceptance-')); roots.push(value); return value }
const md = (name: string, body: string) => `---\nname: ${name}\ndescription: ${name} acceptance\n---\n\n${body}\n`
afterEach(() => { for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true }) })

describe('Academy multi-agent acceptance', () => {
  it('serializes UI, filesystem, MCP, import and conflict resolution through one canonical history', async () => {
    const data = root(); const repoA = root(); const repoB = root()
    const service = new AcademyService(join(data, 'academy.db'))
    try {
      const a = await service.registerDestination(repoA, 'A')
      await service.registerDestination(repoB, 'B')
      const created = await service.create({ package: { skillMd: md('shared', '# UI v1'), artifacts: {} }, scope: 'GLOBAL', origin: 'UI' })
      writeFileSync(join(repoA, '.skills/shared/SKILL.md'), md('shared', '# filesystem v2'), 'utf8')
      await service.watcher.ingest(a.id, 'shared')
      expect(readFileSync(join(repoB, '.skills/shared/SKILL.md'), 'utf8')).toContain('# filesystem v2')

      const mcp = await executeAcademyTool(service, 'update_academy_skill', { skillId: created.id, expectedVersion: 2, package: { skillMd: md('shared', '# MCP v3'), artifacts: { 'guide.md': 'MCP artifact' } } })
      expect(mcp.isError).toBeUndefined()
      expect(readFileSync(join(repoA, '.skills/shared/guide.md'), 'utf8')).toBe('MCP artifact')

      service.store.update({ skillId: created.id, expectedVersion: 3, package: { skillMd: md('shared', '# competing v4'), artifacts: {} }, origin: 'UI' })
      writeFileSync(join(repoA, '.skills/shared/SKILL.md'), md('shared', '# stale local'), 'utf8')
      rmSync(join(repoA, '.skills/shared/guide.md'))
      await service.watcher.ingest(a.id, 'shared')
      const conflict = service.store.listConflicts()[0]
      expect(conflict.baseVersion).toBe(3)
      expect(service.get(created.id).currentVersion).toBe(4)
      await service.resolveConflict(conflict.id, 'DIVERGENT')
      expect(service.get(created.id).currentVersion).toBe(5)

      const importedDirectory = join(repoA, '.skills/imported')
      mkdirSync(importedDirectory, { recursive: true })
      writeFileSync(join(importedDirectory, 'SKILL.md'), md('imported', '# imported'), 'utf8')
      const imported = await service.import(join(repoA, '.skills'), a.id)
      expect(imported.find((item) => item.name === 'imported')?.result).toBe('IMPORTED')
      expect(service.history(created.id).map((item) => item.origin)).toEqual(['FILESYSTEM', 'UI', 'MCP', 'FILESYSTEM', 'UI'])
      expect(readFileSync(join(repoB, '.skills/imported/SKILL.md'), 'utf8')).toContain('# imported')
    } finally { service.close() }
  })
})
