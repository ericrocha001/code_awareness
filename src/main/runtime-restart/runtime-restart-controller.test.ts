import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeIdentityProvider } from '../runtime-identity/runtime-identity-provider'
import { executeRequestRuntimeRestart } from './runtime-restart-mcp'
import { RuntimeRestartController, type RestartSupervisorClient } from './runtime-restart-controller'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

function identity(mode: 'development' | 'production', changed: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'runtime-restart-'))
  roots.push(root)
  writeFileSync(join(root, 'package.json'), '{"version":1}')
  const provider = new RuntimeIdentityProvider({ rootDir: root, includedDirectories: [], includedRootFiles: ['package.json'], mode })
  if (changed) writeFileSync(join(root, 'package.json'), '{"version":2}')
  return provider
}

describe('RuntimeRestartController', () => {
  it('rejects production, instance mismatch, fresh source, and absent supervisor explicitly', async () => {
    const available = { prepare: vi.fn(async () => ({ commit: vi.fn(async () => {}) })) }
    const production = identity('production', true)
    expect((await new RuntimeRestartController(production, available, vi.fn()).request(production.getInstanceId())).status).toBe('UNSUPPORTED')
    const changed = identity('development', true)
    expect((await new RuntimeRestartController(changed, available, vi.fn()).request('wrong')).status).toBe('INSTANCE_MISMATCH')
    const fresh = identity('development', false)
    expect((await new RuntimeRestartController(fresh, available, vi.fn()).request(fresh.getInstanceId())).status).toBe('RESTART_NOT_REQUIRED')
    const absent: RestartSupervisorClient = { prepare: async () => null }
    expect((await new RuntimeRestartController(changed, absent, vi.fn()).request(changed.getInstanceId())).status).toBe('UNSUPPORTED')
  })

  it('schedules once and performs supervisor commit plus graceful shutdown only after post-response', async () => {
    const provider = identity('development', true)
    const events: string[] = []
    const supervisor: RestartSupervisorClient = { prepare: async () => ({ commit: async () => { events.push('commit') } }) }
    const controller = new RuntimeRestartController(provider, supervisor, () => events.push('shutdown'))
    const scheduled = await controller.request(provider.getInstanceId())
    expect(scheduled.status).toBe('SCHEDULED')
    expect(events).toEqual([])
    expect((await controller.request(provider.getInstanceId())).status).toBe('RESTART_ALREADY_SCHEDULED')
    await scheduled.postResponse?.()
    expect(events).toEqual(['commit', 'shutdown'])
  })

  it('publishes the manual Atualizar ações contract without exposing process controls', async () => {
    const provider = identity('development', true)
    const controller = new RuntimeRestartController(provider, { prepare: async () => ({ commit: async () => {} }) }, vi.fn())
    const result = await executeRequestRuntimeRestart(controller, { expectedInstanceId: provider.getInstanceId() })
    expect(result.content[0].text).toContain('Atualizar ações')
    expect(result.content[0].text).not.toMatch(/pid|executable|force/i)
    expect(result.postResponse).toBeTypeOf('function')
  })
})
