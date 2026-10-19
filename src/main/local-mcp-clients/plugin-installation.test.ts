import { afterEach, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { applyFiles, pluginFiles, pluginName, preparePlugin } from './plugin-installation'
import { revision } from './safe-config-file'

const homes: string[] = []
afterEach(async () => { homes.splice(0).forEach(home => rmSync(home, { recursive: true, force: true })); await new Promise(resolve => setTimeout(resolve, 20)) })
function fixture(cline: boolean) {
  const home = mkdtempSync(join(tmpdir(), 'plugin-migration-')); homes.push(home)
  const target = { path: join(home, 'plugins', pluginName, 'plugin.json'), legacy: join(home, 'legacy.json'), cline }
  const entry = { command: process.execPath, args: [join(home, 'launcher.cjs'), '--profile', join(home, 'desktop')] }
  writeFileSync(target.legacy, JSON.stringify({ mcpServers: { [pluginName]: entry, other: { command: 'keep', env: { TOKEN: 'private' } } }, keep: true }))
  return { home, target, entry }
}

it.each([false, true])('migrates without a second exposure, is idempotent and reverses only owned files (Cline=%s)', cline => {
  const { home, target, entry } = fixture(cline)
  const plan = preparePlugin(target, entry, home, false)
  expect(plan.migration).toBe(true)
  let exposedTwice = false
  const observe = () => {
    const legacy = JSON.parse(readFileSync(target.legacy, 'utf8')).mcpServers[pluginName]
    exposedTwice ||= !!legacy && existsSync(target.path)
  }
  applyFiles(plan.steps, home, observe); observe()
  expect(exposedTwice).toBe(false)
  expect(JSON.parse(readFileSync(target.legacy, 'utf8'))).toEqual({ mcpServers: { other: { command: 'keep', env: { TOKEN: 'private' } } }, keep: true })
  const repeated = preparePlugin(target, entry, home, false)
  expect(repeated).toMatchObject({ changes: false, migration: false, configured: true, steps: [] })
  applyFiles(preparePlugin(target, entry, home, true).steps, home)
  expect(existsSync(target.path)).toBe(false)
  expect(JSON.parse(readFileSync(target.legacy, 'utf8')).mcpServers.other.env.TOKEN).toBe('private')
}, 120000)

it('rolls back the migration when final manifest publication fails', () => {
  const { home, target, entry } = fixture(true)
  const before = readFileSync(target.legacy, 'utf8')
  const plan = preparePlugin(target, entry, home, false)
  let visits = 0
  expect(() => applyFiles(plan.steps, home, path => { if (path === target.path && ++visits === 2) throw new Error('INJECTED_PUBLICATION_FAILURE') })).toThrow('INJECTED_PUBLICATION_FAILURE')
  expect(readFileSync(target.legacy, 'utf8')).toBe(before)
  expect(existsSync(target.path)).toBe(false)
  expect(existsSync(join(dirname(target.path), 'mcp.json'))).toBe(false)
}, 120000)

it('fails closed on unknown legacy entries, foreign plugin files and concurrent changes', () => {
  const { home, target, entry } = fixture(false)
  const plan = preparePlugin(target, entry, home, false)
  writeFileSync(target.legacy, '{"mcpServers":{"code-awareness-local":{"command":"manual","args":[]}}}')
  expect(() => applyFiles(plan.steps, home)).toThrow('CONFIG_REVISION_CONFLICT')
  expect(existsSync(target.path)).toBe(false)
  expect(() => preparePlugin(target, entry, home, false)).toThrow('LEGACY_ENTRY_OWNERSHIP_UNVERIFIED')
  mkdirSync(dirname(target.path), { recursive: true }); writeFileSync(join(dirname(target.path), 'foreign.txt'), 'keep')
  expect(() => preparePlugin(target, entry, home, true)).toThrow('PLUGIN_OWNERSHIP_UNVERIFIED')
  expect(readFileSync(join(dirname(target.path), 'foreign.txt'), 'utf8')).toBe('keep')
}, 60000)

it('stops rollback at a concurrent plugin edit instead of restoring a duplicate legacy entry', () => {
  const { home, target, entry } = fixture(false)
  const plan = preparePlugin(target, entry, home, false)
  let visits = 0
  expect(() => applyFiles(plan.steps, home, path => {
    if (path === target.path && ++visits === 2) {
      writeFileSync(join(dirname(target.path), 'mcp_config.json'), 'concurrent content')
      throw new Error('INJECTED_FAILURE')
    }
  })).toThrow('INSTALLATION_RECOVERY_REQUIRED')
  expect(existsSync(target.path)).toBe(false)
  // The legacy restore can precede the component rollback only while no manifest is exposed.
  expect(JSON.parse(readFileSync(target.legacy, 'utf8')).mcpServers.other.command).toBe('keep')
  expect(readFileSync(join(dirname(target.path), 'mcp_config.json'), 'utf8')).toBe('concurrent content')
}, 120000)

it('emits the two distinct public schemas and a fixed, ASCII Cline executable shim', () => {
  const { target, entry } = fixture(true)
  const files = pluginFiles(target, entry)
  expect(JSON.parse(files['plugin.json'])).toEqual({ $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name: pluginName })
  expect(JSON.parse(files['mcp.json'])).toMatchObject({ $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json', mcpServers: { [pluginName]: { type: 'stdio', command: './launch.cmd', args: [] } } })
  expect(files['launch.cmd']).not.toContain('%*')
  expect(files['launch.cmd']).not.toContain(entry.command)
  expect(pluginFiles({ ...target, cline: false }, entry)).toHaveProperty('mcp_config.json')
  expect(() => pluginFiles(target, { ...entry, args: ['x" & bad'] })).toThrow('INVALID_LAUNCHER_PATH')
})

it('does not restore the legacy server across an uncertain final manifest publication', () => {
  const { home, target, entry } = fixture(false)
  const plan = preparePlugin(target, entry, home, false)
  let visits = 0
  expect(() => applyFiles(plan.steps, home, path => {
    if (path === target.path && ++visits === 2) {
      writeFileSync(target.path, '{"name":"concurrent-plugin"}')
      throw new Error('UNCERTAIN_MANIFEST')
    }
  })).toThrow('INSTALLATION_RECOVERY_REQUIRED')
  expect(JSON.parse(readFileSync(target.legacy, 'utf8')).mcpServers[pluginName]).toBeUndefined()
  expect(readFileSync(target.path, 'utf8')).toBe('{"name":"concurrent-plugin"}')
}, 60000)

it('passes spaces, Unicode, percent and metacharacters literally through the Windows shim', () => {
  if (process.platform !== 'win32') throw new Error('WINDOWS_REQUIRED')
  const { home, target } = fixture(true)
  const launcher = join(home, 'ação %PATH% !x! & (literal).cjs')
  const profile = join(home, 'perfil %CD% ! & (literal)')
  writeFileSync(launcher, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))')
  const files = pluginFiles(target, { command: process.execPath, args: [launcher, '--profile', profile] })
  const script = join(home, 'launch.cmd'); writeFileSync(script, files['launch.cmd'])
  const entry = JSON.parse(files['mcp.json']).mcpServers[pluginName]
  const result = execFileSync(join(process.env.SystemRoot!, 'System32', 'cmd.exe'), ['/d', '/c', script], {
    encoding: 'utf8', windowsHide: true, timeout: 10000, env: { ...process.env, ...entry.env, ERRORLEVEL: '0 & echo INJECTION_DETECTED' }
  })
  expect(JSON.parse(result)).toEqual(['--profile', profile])
  expect(revision(script).content).toBe(files['launch.cmd'])
  writeFileSync(launcher, 'process.exit(42)')
  try {
    execFileSync(join(process.env.SystemRoot!, 'System32', 'cmd.exe'), ['/d', '/c', script], {
      windowsHide: true, timeout: 10000, env: { ...process.env, ...entry.env, ERRORLEVEL: '0 & echo INJECTION_DETECTED' }, stdio: 'pipe'
    })
    throw new Error('EXPECTED_EXIT_42')
  } catch (error) { expect((error as { status: number }).status).toBe(42) }
})
