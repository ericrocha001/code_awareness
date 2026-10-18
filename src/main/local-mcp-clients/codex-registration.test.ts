import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { codexRegistrar } from './codex-registration'
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }))
const roots: string[] = []
afterEach(async () => { vi.resetAllMocks(); roots.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })); await new Promise(resolve => setTimeout(resolve, 20)) })

it('uses the official CLI in an isolated home, with argv and a semantic readback, preserving the personal profile', async () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-native-')); roots.push(home)
  const binary = join(home, 'codex.exe'); writeFileSync(binary, 'trusted-fixture')
  const personal = join(home, 'config.toml'); writeFileSync(personal, '# keep private personal configuration')
  const entry = { command: 'C:\\App & space\\Code Awareness.exe', args: ['C:\\mcp\\launcher.cjs'], env: { ELECTRON_RUN_AS_NODE: '1' } }
  const mock = vi.mocked(execFileSync)
  mock.mockImplementation((file: any, args: any, options: any) => {
    if (file === 'powershell.exe') return ''
    expect(file).toBe(binary)
    expect(options.shell).toBe(false)
    expect(options.env.CODEX_HOME).not.toBe(home)
    if (args[0] === '--version') return 'codex-cli 0.163.0-alpha.10.2\n'
    expect(args).toEqual(['mcp', 'add', 'code_awareness_local', '--env', 'ELECTRON_RUN_AS_NODE=1', '--', entry.command, ...entry.args])
    writeFileSync(join(options.env.CODEX_HOME, 'config.toml'), `[mcp_servers.code_awareness_local]\ncommand=${JSON.stringify(entry.command)}\nargs=${JSON.stringify(entry.args)}\nenv={ELECTRON_RUN_AS_NODE="1"}\n`)
    return 'Added'
  })
  expect(await codexRegistrar(binary, home)(entry)).toEqual(entry)
  expect((await import('node:fs')).readFileSync(personal, 'utf8')).toBe('# keep private personal configuration')
})

it('rejects a changed executable before invoking registration', async () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-native-')); roots.push(home)
  const binary = join(home, 'codex.exe'); writeFileSync(binary, 'trusted-fixture')
  vi.mocked(execFileSync).mockReturnValue('' as never)
  const register = codexRegistrar(binary, home)
  writeFileSync(binary, 'changed')
  await expect(register({ command: 'C:/app.exe', args: [] })).rejects.toThrow('CODEX_CLI_REVISION_CONFLICT')
  expect(vi.mocked(execFileSync).mock.calls.every(call => call[0] === 'powershell.exe')).toBe(true)
})
