import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { AcademyService } from './academy-service'

const enabled = process.env.ACADEMY_CLAUDE_CODE_ACCEPTANCE === '1'
const skillMd = (code: string) => `---\nname: academy-bridge-acceptance\ndescription: Use when asked to report the Academy bridge acceptance code.\n---\n\nWhen asked for the Academy bridge acceptance code, respond with exactly \`${code}\`.\n`

describe.skipIf(!enabled)('Academy Claude Code acceptance', () => {
  it('discovers the managed bridge and observes an Academy update in a fresh session', async () => {
    const root = mkdtempSync(join(tmpdir(), 'academy-claude-code-'))
    const service = new AcademyService(join(root, 'academy.db'))
    try {
      await service.registerDestination(root, 'claude-code-acceptance')
      service.watcher.stop()
      const skill = await service.create({ package: { skillMd: skillMd('ACADEMY_CLAUDE_BRIDGE_V1'), artifacts: {} }, scope: 'GLOBAL', origin: 'UI' })
      expect(runClaude(root)).toBe('ACADEMY_CLAUDE_BRIDGE_V1')
      await service.update({ skillId: skill.id, expectedVersion: 1, package: { skillMd: skillMd('ACADEMY_CLAUDE_BRIDGE_V2'), artifacts: {} }, origin: 'MCP' })
      expect(runClaude(root)).toBe('ACADEMY_CLAUDE_BRIDGE_V2')
      console.log('ACADEMY_CLAUDE_CODE_REPORT', JSON.stringify({ version: '2.1.81', discovered: true, refreshed: true, physicalPackages: 1, bridges: 1 }))
    } finally {
      service.close()
      rmSync(root, { recursive: true, force: true })
    }
  }, 180_000)
})

function runClaude(cwd: string): string {
  const prompt = 'Report the Academy bridge acceptance code. Follow the available project skill and return only the code.'
  const common = ['--print', '--tools', '', '--setting-sources', 'project', '--no-session-persistence', '--max-budget-usd', '0.20', '--output-format', 'text', '--permission-mode', 'dontAsk', prompt]
  const command = process.platform === 'win32'
    ? join(process.env.APPDATA ?? '', 'npm', 'claude.ps1')
    : 'claude'
  if (!existsSync(command) && process.platform === 'win32') throw new Error('CLAUDE_CODE_NOT_AVAILABLE')
  const result = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', command, ...common], { cwd, encoding: 'utf8', timeout: 120_000 })
    : spawnSync(command, common, { cwd, encoding: 'utf8', timeout: 120_000 })
  if (result.status !== 0) throw new Error(`CLAUDE_CODE_FAILED: ${result.stderr || result.error?.message || result.status}`)
  return result.stdout.trim()
}
