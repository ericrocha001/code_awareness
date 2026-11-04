import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { CodexArchiveBridge, probeCodexArchive } from './codex-archive-bridge'
import { CodexStdio, type CodexProfile } from './codex-stdio'
import { queryCodexArchive, type AuthorizedCodexArchiveConnection } from './codex-archive'

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.reverse()) close(); cleanup.length = 0 })
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'codex-bridge-')), directory = join(base, 'profile'); mkdirSync(directory)
  cleanup.push(() => rmSync(base, { recursive: true, force: true }))
  let connection: AuthorizedCodexArchiveConnection | undefined, current = true, identity = 'fixture@example.invalid'
  const request = vi.fn(async (method: string, _params: object, _signal: AbortSignal): Promise<unknown> => method === 'initialize' ? { userAgent: 'codex/0.155.0' } : method === 'account/read' ? { account: { type: 'chatgpt', email: identity } } : { data: [{ id: 'archive-one', cwd: base, createdAt: 1730831111, preview: 'PRIVATE_PREVIEW', name: 'PRIVATE_TITLE' }], nextCursor: null })
  const transport = { request: request as CodexStdio['request'], initialized: vi.fn(), close: vi.fn() }
  const options = { repositoryId: 'repo', root: base, isCurrent: () => current,
    changed: vi.fn((value: AuthorizedCodexArchiveConnection | undefined) => { connection = value }),
    approveProfile: vi.fn(async () => true), approveAccount: vi.fn(async () => true),
    probe: vi.fn(async () => ({ version: '0.155.0', supports: { archived: true, cwd: true, stateDbOnly: true } })), connect: vi.fn(() => transport) }
  const bridge = new CodexArchiveBridge(options); cleanup.push(() => bridge.disable())
  return { base, directory, profile: { executable: process.execPath, directory }, bridge, options, transport, request, connection: () => connection,
    account: (value: string) => { identity = value }, current: (value: boolean) => { current = value } }
}
it('does not inspect profiles, probe or start Codex on construction or denied consent', async () => {
  const f = fixture()
  expect(f.bridge.inspect()).toEqual({ state: 'NOT_CONFIGURED' })
  expect((await queryCodexArchive(f.connection(), 'repo', f.base, new AbortController().signal)).code).toBe('ARCHIVE_PROVIDER_UNAVAILABLE')
  expect(f.options.probe).not.toHaveBeenCalled(); expect(f.options.connect).not.toHaveBeenCalled()
  f.options.approveProfile.mockResolvedValue(false)
  expect(await f.bridge.enable({ executable: 'not-an-executable', directory: 'not-a-profile' })).toEqual({ state: 'UNAUTHORIZED' })
  expect(f.options.probe).not.toHaveBeenCalled()
})
it('uses measured capabilities and initialize/initialized before account confirmation and metadata-only archive query', async () => {
  const f = fixture()
  expect(await f.bridge.enable(f.profile)).toEqual({ state: 'READY', version: '0.155.0' })
  expect(f.options.approveAccount).toHaveBeenCalledWith('chatgpt:fixture@example.invalid')
  expect(f.transport.initialized).toHaveBeenCalledOnce()
  const observation = await queryCodexArchive(f.connection(), 'repo', f.base, new AbortController().signal)
  expect(observation).toMatchObject({ code: 'ARCHIVE_OBSERVED', sessions: [{ id: 'archive-one' }], providerVersion: '0.155.0' })
  expect(JSON.stringify(observation)).not.toMatch(/PRIVATE|example.invalid/)
  expect(f.request.mock.calls.map(call => call[0])).toEqual(['initialize', 'account/read', 'account/read', 'thread/list', 'account/read'])
  expect(f.request.mock.calls.find(call => call[0] === 'thread/list')?.[1]).toEqual({ archived: true, cwd: f.base, limit: 20, useStateDbOnly: true })
  const connection = f.connection()!
  await expect(connection.request('thread/read' as any, { archived: true, cwd: f.base, limit: 20 }, new AbortController().signal)).rejects.toThrow('PROTOCOL_UNSUPPORTED')
})
it('requires separate account approval and closes the transport on denial without listing threads', async () => {
  const f = fixture(); f.options.approveAccount.mockResolvedValue(false)
  expect(await f.bridge.enable(f.profile)).toEqual({ state: 'UNAUTHORIZED' })
  expect(f.transport.close).toHaveBeenCalledOnce()
  expect(f.request.mock.calls.some(call => call[0] === 'thread/list')).toBe(false)
})
it('fails closed for incompatible schema/version and unsafe executable/profile without a remote listener', async () => {
  const f = fixture()
  for (const profile of [{ executable: 'ws://127.0.0.1:4500', directory: f.directory }, { executable: '\\\\host\\codex.exe', directory: f.directory }, { executable: 'codex', directory: f.directory }, { executable: join(f.base, 'missing.exe'), directory: f.directory }]) expect((await f.bridge.enable(profile)).state).toBe('EXECUTABLE_UNAVAILABLE')
  expect(f.options.connect).not.toHaveBeenCalled()
  f.options.probe.mockResolvedValue({ version: '0.155.0', supports: { archived: true, cwd: true, stateDbOnly: false } })
  expect((await f.bridge.enable(f.profile)).state).toBe('PROTOCOL_UNSUPPORTED')
  expect(f.options.connect).not.toHaveBeenCalled()
})
it('invalidates account changes before or after listing instead of leaking or assigning another account', async () => {
  const f = fixture(); await f.bridge.enable(f.profile)
  f.account('another@example.invalid')
  const before = await queryCodexArchive(f.connection(), 'repo', f.base, new AbortController().signal)
  expect(before.sessions).toEqual([]); expect(f.bridge.inspect().state).toBe('ACCOUNT_IDENTITY_UNAVAILABLE')
  expect(f.connection()).toBeUndefined(); expect(f.request.mock.calls.some(call => call[0] === 'thread/list')).toBe(false)
  f.account('fixture@example.invalid'); await f.bridge.enable(f.profile)
  let switched = false
  f.request.mockImplementation(async method => {
    if (method === 'thread/list') { switched = true; return { data: [{ id: 'secret', cwd: f.base }] } }
    return { account: { type: 'chatgpt', email: switched ? 'other@example.invalid' : 'fixture@example.invalid' } }
  })
  const after = await queryCodexArchive(f.connection(), 'repo', f.base, new AbortController().signal)
  expect(after.sessions).toEqual([])
  expect(switched).toBe(true)
})
it('cancels pending enable on project changes and rejects a cwd outside the validated checkout', async () => {
  const f = fixture()
  f.options.approveProfile.mockImplementation(async () => { f.current(false); return true })
  expect((await f.bridge.enable(f.profile)).state).toBe('UNAUTHORIZED')
  expect(f.options.connect).not.toHaveBeenCalled()
  f.current(true); f.options.approveProfile.mockResolvedValue(true); await f.bridge.enable(f.profile)
  await expect(f.connection()!.request('thread/list', { archived: true, cwd: '/foreign', limit: 20 }, new AbortController().signal)).rejects.toThrow('PROTOCOL_UNSUPPORTED')
  f.bridge.disable(); expect(f.connection()).toBeUndefined()
  expect(f.bridge.inspect().state).toBe('NOT_CONFIGURED')
})
it('verifies schema properties from the selected CLI version and cleans only its temporary schema output', async () => {
  const f = fixture(); let temporary = ''
  const command = vi.fn(async (_profile: CodexProfile, args: string[]) => {
    if (args[0] === '--version') return 'codex-cli 0.155.0'
    temporary = args.at(-1)!
    mkdirSync(join(temporary, 'v2'))
    writeFileSync(join(temporary, 'v2/ThreadListParams.json'), JSON.stringify({ properties: { archived: { type: ['boolean', 'null'] }, cwd: { anyOf: [{ type: 'string' }, { type: 'null' }] }, useStateDbOnly: { type: 'boolean' } } }))
    return ''
  })
  expect(await probeCodexArchive(f.profile, f.base, new AbortController().signal, command)).toEqual({ version: '0.155.0', supports: { archived: true, cwd: true, stateDbOnly: true } })
  expect(existsSync(temporary)).toBe(false)
  expect(command.mock.calls.map(call => call[1][0])).toEqual(['--version', 'app-server'])
})
it('ends the owned transport without reading an account if project authority changes during initialization', async () => {
  const f = fixture()
  f.request.mockImplementationOnce(async () => { f.current(false); return { userAgent: 'codex/0.155.0' } })
  expect((await f.bridge.enable(f.profile)).state).toBe('UNAUTHORIZED')
  expect(f.request.mock.calls.map(call => call[0])).toEqual(['initialize'])
  expect(f.transport.close).toHaveBeenCalledOnce(); expect(f.connection()).toBeUndefined()
})
it('binds cwd to the canonical authorized checkout rather than the spelling of its configured path', async () => {
  const f = fixture(); f.options.root = f.base.replace(/\\/g, '/')
  expect((await f.bridge.enable(f.profile)).state).toBe('READY')
  expect((await queryCodexArchive(f.connection(), 'repo', f.base, new AbortController().signal)).code).toBe('ARCHIVE_OBSERVED')
})
function processFixture(mode: string) {
  const base = mkdtempSync(join(tmpdir(), 'codex-stdio-')), script = join(base, 'fixture.cjs')
  writeFileSync(script, `const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const f=JSON.parse(line);if(!f.id)return;if(${JSON.stringify(mode)}==='hang')return;if(${JSON.stringify(mode)}==='oversized'){process.stdout.write('x'.repeat(270000));return}if(${JSON.stringify(mode)}==='approval'){process.stdout.write(JSON.stringify({id:700,method:'item/commandExecution/requestApproval',params:{}})+'\\n');return}process.stdout.write(JSON.stringify({id:f.id,result:{userAgent:'fixture/0.155.0'}})+'\\n')});`)
  const child = spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
  const invalidated = vi.fn(), transport = new CodexStdio(child, invalidated)
  cleanup.push(() => { transport.close(); rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
  return { child, invalidated, transport }
}
it('implements actual stdio framing, bounded backpressure and cancellation without invoking Codex', async () => {
  const f = processFixture('reply'), signal = new AbortController().signal
  expect(await f.transport.request('initialize', {}, signal)).toEqual({ userAgent: 'fixture/0.155.0' })
  await expect(f.transport.request('thread/start' as any, {}, signal)).rejects.toThrow('PROTOCOL_UNSUPPORTED')
  f.transport.close(); expect(f.invalidated).toHaveBeenCalledOnce()
  const hanging = processFixture('hang'), abort = new AbortController()
  const first = hanging.transport.request('initialize', {}, abort.signal)
  await expect(hanging.transport.request('account/read', {}, abort.signal)).rejects.toThrow('BACKPRESSURE')
  abort.abort(); await expect(first).rejects.toThrow('PROVIDER_UNREACHABLE')
  expect(hanging.invalidated).toHaveBeenCalledOnce()
})
it('rejects oversized stdout and server-initiated execution/approval requests', async () => {
  for (const mode of ['oversized', 'approval']) {
    const f = processFixture(mode)
    await expect(f.transport.request('initialize', {}, new AbortController().signal)).rejects.toThrow('PROVIDER_UNREACHABLE')
    expect(f.invalidated).toHaveBeenCalledOnce()
  }
})
