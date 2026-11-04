import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const { handlers, choose } = vi.hoisted(() => ({ handlers: new Map<string, Function>(), choose: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, callback: Function) => handlers.set(name, callback) }, dialog: { showOpenDialog: choose } }))
vi.mock('../local-mcp-clients/safe-config-file', async original => ({ ...await original<object>(), assertUserOwnedAsync: vi.fn(async () => {}) }))
import { registerCodexArchiveHandlers } from './codex-archive-handler'
import { candidateView, verifyCodexCandidate } from '../session-context/codex-discovery'
const roots: string[] = []
afterEach(() => { vi.clearAllMocks(); roots.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })) })
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'archive-ipc-')); roots.push(root)
  const executable = join(root, 'codex.exe'), directory = join(root, 'profile'); writeFileSync(executable, 'fixture'); mkdirSync(directory)
  const candidate = await verifyCodexCandidate({ executable, directory })
  const frame = { url: 'file:///app/index.html' }, sender = { mainFrame: frame }, window = { webContents: sender, isDestroyed: () => false }
  const bridge = { inspect: vi.fn(() => ({ state: 'NOT_CONFIGURED' })), disable: vi.fn(), enable: vi.fn(async () => {}) }
  let active: typeof bridge | undefined = bridge
  const discovery = { view: { state: 'ONE_VERIFIED_CANDIDATE' as const, candidates: [candidateView(candidate)] }, candidates: [candidate] }
  const discover = vi.fn(async () => discovery)
  registerCodexArchiveHandlers(() => active as any, () => window as any, frame.url, discover)
  const event = { sender, senderFrame: frame }, call = (name: string, ...args: unknown[]) => handlers.get('codex-archive:' + name)!(event, ...args)
  return { candidate, bridge, discovery, discover, frame, sender, event, call, switchProject: () => { active = undefined } }
}
it('inspects passively, requires the presented candidate and uses zero filesystem dialogs on enable', async () => {
  const f = await fixture()
  await f.call('enable'); expect(f.bridge.enable).not.toHaveBeenCalled()
  expect(await f.call('inspect')).toMatchObject({ discovery: { state: 'ONE_VERIFIED_CANDIDATE', selectedId: f.candidate.id } })
  expect(f.bridge.enable).not.toHaveBeenCalled()
  await f.call('enable')
  expect(f.bridge.enable).toHaveBeenCalledExactlyOnceWith(f.candidate.profile, f.candidate.pin)
  expect(choose).not.toHaveBeenCalled()
})
it('rejects subframes, remote origins, arbitrary paths/commands and unknown candidate ids', async () => {
  const f = await fixture(); await f.call('inspect')
  expect(() => f.call('enable', { executable: 'arbitrary' })).toThrow('UNAUTHORIZED')
  expect(() => handlers.get('codex-archive:enable')!({ sender: {}, senderFrame: f.frame })).toThrow('UNAUTHORIZED')
  expect(() => handlers.get('codex-archive:enable')!({ sender: f.sender, senderFrame: {} })).toThrow('UNAUTHORIZED')
  f.frame.url = 'https://remote.invalid'; expect(() => f.call('enable')).toThrow('UNAUTHORIZED')
  f.frame.url = 'file:///app/index.html'
  expect(() => f.call('select', 'a'.repeat(64))).toThrow('UNAUTHORIZED')
  expect(() => f.call('select', 'C:/codex.exe')).toThrow('UNAUTHORIZED')
})
it('fails closed if the selected executable or candidate inventory changes after presentation', async () => {
  const f = await fixture(); await f.call('inspect')
  writeFileSync(f.candidate.profile.executable, 'tampered')
  expect(await f.call('enable')).toMatchObject({ discovery: { state: 'INVALID', reason: 'CANDIDATE_CHANGED' } })
  expect(f.bridge.enable).not.toHaveBeenCalled()
  const g = await fixture(); await g.call('inspect'); g.discover.mockResolvedValueOnce({ ...g.discovery, candidates: [] })
  expect(await g.call('enable')).toMatchObject({ discovery: { state: 'INVALID' } })
  expect(g.bridge.enable).not.toHaveBeenCalled()
})
it('requires explicit selection for ambiguity and never enables on advanced selection or cancellation', async () => {
  const f = await fixture(); f.discovery.view.state = 'AMBIGUOUS' as any
  await f.call('inspect'); await f.call('enable'); expect(f.bridge.enable).not.toHaveBeenCalled()
  await f.call('select', f.candidate.id); await f.call('enable'); expect(f.bridge.enable).toHaveBeenCalledOnce()
  choose.mockResolvedValueOnce({ canceled: true, filePaths: [] }); await f.call('choose-advanced')
  choose.mockResolvedValueOnce({ canceled: false, filePaths: [f.candidate.profile.executable] }).mockResolvedValueOnce({ canceled: false, filePaths: [f.candidate.profile.directory] })
  expect(await f.call('choose-advanced')).toMatchObject({ discovery: { selectedId: f.candidate.id } })
  expect(f.bridge.enable).toHaveBeenCalledOnce()
})
it('does not connect after the project changes during discovery or native selection', async () => {
  const f = await fixture()
  f.discover.mockImplementation(async () => { f.switchProject(); return f.discovery })
  await expect(f.call('inspect')).rejects.toThrow('PROJECT_CONTEXT_CHANGED')
  expect(f.bridge.enable).not.toHaveBeenCalled()
})
it('revokes a pending click when disconnect occurs before discovery completes', async () => {
  const f = await fixture(); await f.call('inspect')
  let complete!: () => void
  f.discover.mockImplementationOnce(async () => { await new Promise<void>(resolve => { complete = resolve }); return f.discovery })
  const pending = f.call('enable')
  await vi.waitFor(() => expect(complete).toBeTypeOf('function'))
  f.call('disable'); complete(); await pending
  expect(f.bridge.enable).not.toHaveBeenCalled()
})
