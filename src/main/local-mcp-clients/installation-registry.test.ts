import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { InstallationRegistry } from './installation-registry'
import * as safe from './safe-config-file'
import type { LocalMcpInstallation } from '../../shared/types/local-mcp-client-types'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })) })
const entry = (id: LocalMcpInstallation['id']): LocalMcpInstallation => ({ id, mechanism: 'CONFIG_FALLBACK', state: 'CONFIGURED', evidence: 'MANAGED_ENTRY', installationEvidence: 'MANAGED_ENTRY' })
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'mcp-record-')); roots.push(home)
  const profile = join(home, 'desktop'); mkdirSync(profile)
  return { home, profile, registry: new InstallationRegistry(home, profile) }
}
it('persists a minimal versioned record, preserves unrelated variants and is idempotent', async () => {
  const { home, profile, registry } = fixture()
  await registry.update([entry('codex')], true)
  await new InstallationRegistry(home, profile).update([entry('cline-vscode')], true)
  const original = readFileSync(registry.path, 'utf8')
  const reloaded = new InstallationRegistry(home, profile)
  expect((await reloaded.read()).record!.installations.map(row => row.id)).toEqual(['cline-vscode', 'codex'])
  await reloaded.update([entry('codex')], true)
  expect(readFileSync(registry.path, 'utf8')).toBe(original)
  expect(original).not.toMatch(/clientUse|bootstrap|token|command|args|port|session|path|runtime/i)
}, 20000)
it.each(['{broken', '{"schemaVersion":2,"installations":[]}', '{"schemaVersion":1,"migrationCompleted":true,"installations":[{"id":"codex","state":"CONFIGURED","mechanism":"CONFIG_FALLBACK","evidence":"MANAGED_ENTRY"}]}'])('preserves unreadable or unsupported records instead of replacing them: %s', async content => {
  const { registry } = fixture()
  writeFileSync(registry.path, content)
  await expect(registry.read()).rejects.toThrow(/REGISTRY_/)
  await expect(registry.update([entry('codex')], true)).rejects.toThrow(/REGISTRY_/)
  expect(readFileSync(registry.path, 'utf8')).toBe(content)
}, 15000)
it('rejects destinations outside the authorized user profile', async () => {
  const { home } = fixture()
  await expect(new InstallationRegistry(join(home, 'restricted'), home).read()).rejects.toThrow('REGISTRY_ACCESS_DENIED')
})
it('fails closed on a competing publication and preserves the winning record', async () => {
  const { home, profile, registry } = fixture()
  const actual = safe.writeConfigAsync
  let releaseFirst!: () => void, releaseSecond!: () => void, both!: () => void, calls = 0
  const entered = new Promise<void>(resolve => { both = resolve })
  vi.spyOn(safe, 'writeConfigAsync').mockImplementation(async (...args) => {
    const gate = new Promise<void>(resolve => { if (args[3].includes('"codex"')) releaseFirst = resolve; else releaseSecond = resolve; if (++calls === 2) both() })
    await gate
    return actual(...args)
  })
  const first = registry.update([entry('codex')], true)
  const second = new InstallationRegistry(home, profile).update([entry('cline')], true)
  const settled = Promise.allSettled([first, second])
  await entered; releaseFirst(); await first; releaseSecond()
  const outcomes = await settled
  expect(outcomes[1]).toMatchObject({ status: 'rejected', reason: new Error('REGISTRY_CONFLICT') })
  expect((await registry.read()).record!.installations.map(row => row.id)).toEqual(['codex'])
}, 20000)
