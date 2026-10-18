import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { LocalMcpClientService } from './local-mcp-client-service'
import { InstallationRegistry } from './installation-registry'
import { editEntry } from './config-editors'
import { pluginFiles, pluginName } from './plugin-installation'
import type { LocalMcpInstallationSnapshot } from '../../shared/types/local-mcp-client-types'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); roots.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })); await new Promise(resolve => setImmediate(resolve)) })
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'mcp-restore-')); roots.push(home)
  for (const dir of ['.codex', '.gemini/config', '.cline/data/settings']) mkdirSync(join(home, dir), { recursive: true })
  const sourceBundle = join(home, 'bundle.cjs'); writeFileSync(sourceBundle, 'managed bundle')
  const profile = join(home, 'desktop'); mkdirSync(profile)
  const options = { home, appData: join(home, 'AppData/Roaming'), localAppData: join(home, 'AppData/Local'), sourceBundle, profile,
    command: process.execPath, packaged: false, env: {}, probe: vi.fn(async () => {}) }
  const service = new LocalMcpClientService(options), registry = new InstallationRegistry(home, profile)
  const entry = { command: process.execPath, args: [service.launcher, '--profile', profile] }
  return { home, options, service, registry, entry }
}
async function restore(service: LocalMcpClientService) {
  let finish!: (value: LocalMcpInstallationSnapshot) => void
  const ready = new Promise<LocalMcpInstallationSnapshot>(resolve => { finish = resolve })
  const stop = service.onSnapshotChanged(snapshot => { if (snapshot.restoration !== 'RESTORING') finish(snapshot) })
  const current = await service.snapshot()
  const result = current.restoration === 'RESTORING' ? await ready : current
  stop(); expect(result.restoration).toBe('READY')
  return result
}
function installLegacy(f: ReturnType<typeof fixture>) {
  mkdirSync(dirname(f.service.launcher), { recursive: true }); writeFileSync(f.service.launcher, 'managed bundle')
  writeFileSync(join(f.home, '.codex/config.toml'), editEntry('[mcp_servers.other]\ncommand="keep"\nargs=["PRIVATE_SECRET"]\n', true, 'code_awareness_local', f.entry))
  for (const cline of [false, true]) {
    const root = join(f.home, cline ? '.agents/plugins' : '.gemini/config/plugins', pluginName)
    mkdirSync(root, { recursive: true })
    for (const [name, content] of Object.entries(pluginFiles({ path: join(root, 'plugin.json'), legacy: '', cline }, f.entry))) writeFileSync(join(root, name), content)
  }
}
it('imports managed legacy installations once and restores a new service without profile reads or probes', async () => {
  const f = fixture(); installLegacy(f)
  const inspected = vi.spyOn(f.service as any, 'inspect')
  const initial = await f.service.snapshot()
  expect(initial.restoration).toBe('RESTORING')
  const result = await restore(f.service)
  expect(result.installations.filter(row => row.state === 'CONFIGURED').map(row => row.id)).toEqual(['antigravity', 'cline', 'codex'])
  expect(inspected).toHaveBeenCalledTimes(6)
  expect(f.options.probe).not.toHaveBeenCalled()
  expect(readFileSync(f.registry.path, 'utf8')).not.toContain('PRIVATE_SECRET')
  const restarted = new LocalMcpClientService(f.options), nextInspection = vi.spyOn(restarted as any, 'inspect')
  expect((await restarted.snapshot()).installations).toEqual(result.installations)
  expect((await restarted.snapshot()).restoration).toBe('READY')
  expect(nextInspection).not.toHaveBeenCalled()
  expect(f.options.probe).not.toHaveBeenCalled()
}, 90000)
it('persists an empty migration marker and never fabricates configurations from directories or a launcher', async () => {
  const f = fixture()
  mkdirSync(dirname(f.service.launcher), { recursive: true }); writeFileSync(f.service.launcher, 'bundle only')
  expect((await restore(f.service)).installations).toEqual([])
  expect((await f.registry.read()).record?.migrationCompleted).toBe(true)
  const restarted = new LocalMcpClientService(f.options), inspected = vi.spyOn(restarted as any, 'inspect')
  expect((await restarted.snapshot()).installations).toEqual([])
  expect(inspected).not.toHaveBeenCalled()
}, 60000)
it('does not import foreign entries, duplicate servers or unknown plugins as configured', async () => {
  const f = fixture(); installLegacy(f)
  writeFileSync(join(f.home, '.codex/config.toml'), '[mcp_servers.code_awareness_local]\ncommand="foreign"\nargs=[]\n')
  writeFileSync(join(f.home, '.gemini/config/mcp_config.json'), JSON.stringify({ mcpServers: { [pluginName]: f.entry } }))
  const cline = join(f.home, '.agents/plugins', pluginName, 'mcp.json')
  const original = JSON.parse(readFileSync(cline, 'utf8')); original.mcpServers.other = { type: 'stdio', command: 'foreign' }; writeFileSync(cline, JSON.stringify(original))
  expect((await restore(f.service)).installations.filter(row => row.state === 'CONFIGURED')).toEqual([])
  expect(readFileSync(cline, 'utf8')).toBe(JSON.stringify(original))
  expect(f.options.probe).not.toHaveBeenCalled()
}, 60000)
it('persists confirmed connect/repair/disconnect and leaves other variants intact across service restarts', async () => {
  const f = fixture()
  await f.registry.update([{ id: 'cline-vscode', state: 'CONFIGURED', mechanism: 'CONFIG_FALLBACK', evidence: 'MANAGED_ENTRY', installationEvidence: 'MANAGED_ENTRY' }], true)
  await f.service.snapshot()
  for (const action of ['connect', 'repair', 'disconnect'] as const) {
    const preview = await f.service.preview('codex', action)
    const result = await f.service.apply(preview.token, true, false)
    expect(result.persistence).toBe('SAVED')
    const snapshot = await new LocalMcpClientService(f.options).snapshot()
    expect(snapshot.installations.find(row => row.id === 'codex')?.state).toBe(action === 'disconnect' ? 'REMOVED' : 'CONFIGURED')
    expect(snapshot.installations.find(row => row.id === 'cline-vscode')?.state).toBe('CONFIGURED')
  }
}, 60000)
it('reports persistence failure after a successful client write and reconciles it explicitly', async () => {
  const f = fixture(); await f.registry.update([], true); await f.service.snapshot()
  const preview = await f.service.preview('codex', 'connect')
  const update = vi.spyOn(InstallationRegistry.prototype, 'update').mockRejectedValueOnce(new Error('PERSISTENCE_FAILED'))
  expect(await f.service.apply(preview.token, true, false)).toMatchObject({ configuration: 'INSTALLED', persistence: 'FAILED', diagnostic: 'PERSISTENCE_FAILED' })
  expect(readFileSync(join(f.home, '.codex/config.toml'), 'utf8')).toContain('code_awareness_local')
  expect((await f.service.snapshot()).restoration).toBe('ERROR')
  expect((await new LocalMcpClientService(f.options).snapshot()).installations).toEqual([])
  update.mockRestore()
  await f.service.detect()
  expect((await f.service.snapshot()).installations.find(row => row.id === 'codex')?.state).toBe('CONFIGURED')
}, 90000)
it('retains proof of installation across session/launcher failures and flags actual configuration loss', async () => {
  const f = fixture(); installLegacy(f); await restore(f.service)
  f.options.probe.mockRejectedValueOnce(new Error('MCP_SESSION_INVALIDATED'))
  expect(await f.service.verify('codex')).toMatchObject({ configuration: 'INSTALLED', bootstrap: 'ERROR' })
  expect((await f.service.snapshot()).installations.find(row => row.id === 'codex')?.state).toBe('CONFIGURED')
  rmSync(f.service.launcher)
  expect(await f.service.verify('codex')).toMatchObject({ configuration: 'INSTALLED', diagnostic: 'LAUNCHER_UNAVAILABLE' })
  expect((await f.service.snapshot()).installations.find(row => row.id === 'codex')?.state).toBe('CONFIGURED')
  writeFileSync(join(f.home, '.codex/config.toml'), '# managed entry removed externally\n')
  await f.service.verify('codex')
  expect((await f.service.snapshot()).installations.find(row => row.id === 'codex')).toMatchObject({ state: 'NEEDS_ATTENTION', evidence: 'CONFIG_ABSENT', installationEvidence: 'MANAGED_ENTRY' })
}, 90000)
it('fails explicitly on a corrupt registry without replacing client files or inventing removed state', async () => {
  const f = fixture(); installLegacy(f); await restore(f.service)
  const client = readFileSync(join(f.home, '.codex/config.toml'), 'utf8')
  writeFileSync(f.registry.path, '{corrupted registry')
  expect(await f.service.verify('codex')).toMatchObject({ persistence: 'FAILED', diagnostic: 'PERSISTENCE_FAILED' })
  expect((await f.service.snapshot()).installations.find(row => row.id === 'codex')?.state).toBe('CONFIGURED')
  const restarted = new LocalMcpClientService(f.options), inspected = vi.spyOn(restarted as any, 'inspect')
  expect(await restarted.snapshot()).toMatchObject({ restoration: 'ERROR', diagnostic: 'REGISTRY_INVALID', installations: [] })
  expect(inspected).not.toHaveBeenCalled()
  const preview = await restarted.preview('codex', 'repair')
  await expect(restarted.apply(preview.token, true, false)).rejects.toThrow('REGISTRY_INVALID')
  expect(readFileSync(f.registry.path, 'utf8')).toBe('{corrupted registry')
  expect(readFileSync(join(f.home, '.codex/config.toml'), 'utf8')).toBe(client)
  expect(existsSync(f.registry.path)).toBe(true)
}, 90000)
it('reconciles divergent and unreadable client settings only on explicit diagnosis while preserving other proof', async () => {
  const f = fixture(); installLegacy(f); await restore(f.service)
  const path = join(f.home, '.codex/config.toml')
  writeFileSync(path, '[mcp_servers.code_awareness_local]\ncommand="external"\nargs=[]\n')
  const diagnosed = await f.service.detect()
  expect(diagnosed.find(row => row.id === 'codex')?.configuration).toBe('CONFLICT')
  expect((await f.service.snapshot()).installations.find(row => row.id === 'codex')).toMatchObject({ state: 'NEEDS_ATTENTION', evidence: 'CONFIG_DIVERGENT', installationEvidence: 'MANAGED_ENTRY' })
  writeFileSync(path, '[broken TOML')
  await f.service.detect()
  const snapshot = await f.service.snapshot()
  expect(snapshot.installations.find(row => row.id === 'codex')).toMatchObject({ state: 'NEEDS_ATTENTION', evidence: 'READ_INCONCLUSIVE' })
  expect(snapshot.installations.filter(row => row.state === 'CONFIGURED').map(row => row.id)).toEqual(['antigravity', 'cline'])
  expect(readFileSync(path, 'utf8')).toBe('[broken TOML')
  expect(f.options.probe).not.toHaveBeenCalled()
}, 90000)
