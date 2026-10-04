import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcademyService } from './academy-service'

const roots: string[] = []
const root = () => { const value = mkdtempSync(join(tmpdir(), 'academy-windows-distribution-')); roots.push(value); return value }
const md = (body: string) => `---\nname: windows-shared\ndescription: Windows shared distribution\n---\n\n${body}\n`
const normalized = (path: string) => process.platform === 'win32' ? realpathSync(path).toLowerCase() : realpathSync(path)
afterEach(() => { for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true }) })

describe('Academy real filesystem distribution acceptance', () => {
  it('shares one package bidirectionally through the Windows-capable Claude bridge', async () => {
    const data = root(); const repo = root(); const service = new AcademyService(join(data, 'academy.db'))
    try {
      const destination = await service.registerDestination(repo, 'windows-project')
      const skill = await service.create({ package: { skillMd: md('# Academy v1'), artifacts: {} }, scope: 'GLOBAL', origin: 'UI' })
      const physical = join(repo, '.skills/windows-shared')
      const bridge = join(repo, '.claude/skills/windows-shared')
      expect(lstatSync(bridge).isSymbolicLink()).toBe(true)
      expect(normalized(bridge)).toBe(normalized(physical))
      writeFileSync(join(bridge, 'SKILL.md'), md('# Claude filesystem v2'), 'utf8')
      await vi.waitFor(() => expect(service.get(skill.id).currentVersion).toBe(2), { timeout: 5_000, interval: 100 })
      expect(service.get(skill.id).current.origin).toBe('FILESYSTEM')
      expect(readFileSync(join(physical, 'SKILL.md'), 'utf8')).toContain('# Claude filesystem v2')
      await service.update({ skillId: skill.id, expectedVersion: 2, package: { skillMd: md('# Academy MCP v3'), artifacts: {} }, origin: 'MCP' })
      expect(readFileSync(join(bridge, 'SKILL.md'), 'utf8')).toContain('# Academy MCP v3')
      expect(normalized(bridge)).toBe(normalized(physical))
      const state = service.store.getDistributionState(skill.id, destination.id, 'CLAUDE_CODE')!
      expect(state.status).toBe('CURRENT')
      console.log('ACADEMY_WINDOWS_DISTRIBUTION_REPORT', JSON.stringify({ mechanism: state.linkMechanism, bridges: 1, physicalPackages: 1, canonicalVersion: service.get(skill.id).currentVersion }))
    } finally { service.close() }
  })
})
