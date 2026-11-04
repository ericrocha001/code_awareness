import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverCodexArchive, verifyCodexCandidate } from './codex-discovery'
import { assertUserOwnedAsync } from '../local-mcp-clients/safe-config-file'
vi.mock('../local-mcp-clients/safe-config-file', async original => ({ ...await original<object>(), assertUserOwnedAsync: vi.fn(async () => {}) }))
const roots: string[] = []
afterEach(() => { vi.clearAllMocks(); roots.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })) })
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'codex-discovery-')); roots.push(home)
  const env = { LOCALAPPDATA: join(home, 'local'), APPDATA: join(home, 'roaming') }, directory = join(home, '.codex')
  mkdirSync(directory)
  const binary = (version: string) => { const executable = join(env.LOCALAPPDATA, 'OpenAI/Codex/bin', version, 'codex.exe'); mkdirSync(join(executable, '..'), { recursive: true }); writeFileSync(executable, 'not-executed'); return executable }
  return { home, env, directory, binary }
}
it('discovers one known local installation and default profile without executing Codex or inspecting private content', async () => {
  const f = fixture(), executable = f.binary('v1')
  const result = await discoverCodexArchive(f.env, f.home)
  expect(result.view.state).toBe('ONE_VERIFIED_CANDIDATE')
  expect(result.candidates[0].profile).toEqual({ executable, directory: f.directory })
  expect(JSON.stringify(result)).not.toMatch(/auth.json|transcript|token/)
})
it('uses explicit CODEX_HOME, refuses missing explicit profiles and never falls back to another account', async () => {
  const f = fixture(); f.binary('v1')
  const directory = join(f.home, 'custom'); mkdirSync(directory)
  expect((await discoverCodexArchive({ ...f.env, CODEX_HOME: directory }, f.home)).candidates[0].profile.directory).toBe(directory)
  expect((await discoverCodexArchive({ ...f.env, CODEX_HOME: join(f.home, 'missing') }, f.home)).view).toMatchObject({ state: 'INVALID', reason: 'PROFILE_MISSING' })
  expect((await discoverCodexArchive({ ...f.env, CODEX_HOME: '' }, f.home)).view.state).toBe('INVALID')
})
it('does not pick the newest installation when multiple candidates are plausible', async () => {
  const f = fixture(); f.binary('v1'); f.binary('v2')
  expect((await discoverCodexArchive(f.env, f.home)).view).toMatchObject({ state: 'AMBIGUOUS', candidates: [{}, {}] })
})
it('resolves a bounded official npm package to its native binary, never a shell shim or PATH command', async () => {
  const f = fixture(), pkg = join(f.env.APPDATA, 'npm/node_modules/@openai/codex')
  const triple = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc'
  const executable = join(pkg, 'vendor', triple, 'codex/codex.exe')
  mkdirSync(join(executable, '..'), { recursive: true }); writeFileSync(executable, 'fixture')
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@openai/codex' }))
  writeFileSync(join(f.env.APPDATA, 'npm/codex.cmd'), 'never run')
  expect((await discoverCodexArchive({ ...f.env, PATH: '/untrusted' }, f.home)).candidates[0].profile.executable).toBe(executable)
})
it('fails closed for links, remote paths, shims, other owners and mutated candidate identities', async () => {
  const f = fixture(), executable = f.binary('v1'), profile = { executable, directory: f.directory }
  const before = await verifyCodexCandidate(profile)
  writeFileSync(executable, 'mutated executable')
  expect((await verifyCodexCandidate(profile)).pin).not.toBe(before.pin)
  for (const executable of ['\\\\host\\codex.exe', 'codex.cmd', join(f.home, 'codex.ps1')]) await expect(verifyCodexCandidate({ ...profile, executable })).rejects.toThrow()
  vi.mocked(assertUserOwnedAsync).mockRejectedValueOnce(new Error('OTHER_OWNER'))
  expect((await discoverCodexArchive(f.env, f.home)).view.state).toBe('INVALID')
  const link = join(f.home, 'linked-profile'); symlinkSync(f.directory, link, 'junction')
  expect((await discoverCodexArchive({ ...f.env, CODEX_HOME: link }, f.home)).view.state).toBe('INVALID')
})
