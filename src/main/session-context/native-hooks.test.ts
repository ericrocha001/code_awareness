import { afterEach, expect, test } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { nativeDigest, nativeGitIdentity, nativeHookLimits, normalizeNativeHook, parseNativeEnvelope, prepareNativeSpool, spoolNativeHook, type NativeHookBinding } from './native-hooks'
import { composeNativeHooks, disableNativeHooks, installNativeHooks } from './native-hook-installation'

const directories: string[] = []
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'native-hooks-')); directories.push(root)
  mkdirSync(join(root, '.git')); writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/test\n')
  const spool = join(root, 'spool'); prepareNativeSpool(spool)
  const binding: NativeHookBinding = { schema: 1, enabled: true, repositoryId: 'repository', worktreeId: '1'.repeat(64), generation: '2'.repeat(64), ...nativeGitIdentity(root), spool }
  return { root, spool, binding, payload: { session_id: 'session-1', cwd: root, hook_event_name: 'PreToolUse', turn_id: 'turn-1', tool_use_id: 'call-1', tool_name: 'Bash' } }
}
test('keeps only scoped structural evidence and pairs observed pre/post identifiers', () => {
  const f = fixture(), secret = 'PRIVATE_COMMAND_PROMPT_OUTPUT'
  const pre = normalizeNativeHook({ ...f.payload, prompt: secret, tool_input: { command: secret }, tool_response: secret }, f.binding)
  const post = normalizeNativeHook({ ...f.payload, hook_event_name: 'PostToolUse' }, f.binding)
  expect(pre.sessionId).toBe(post.sessionId); expect(pre.invocationId).toBe(post.invocationId)
  expect(pre.eventId).not.toBe(post.eventId)
  expect(JSON.stringify(pre)).not.toContain(secret)
  expect(JSON.stringify(pre)).not.toContain(f.root)
  expect(parseNativeEnvelope(JSON.stringify(pre))).toEqual(pre)
  expect(normalizeNativeHook(f.payload, { ...f.binding, repositoryId: 'other' }).sessionId).not.toBe(pre.sessionId)
})
test('rejects missing invocation identity, changed checkout and forged envelopes', () => {
  const f = fixture()
  expect(() => normalizeNativeHook({ ...f.payload, tool_use_id: undefined }, f.binding)).toThrow('INVOCATION_ID_MISSING')
  expect(() => normalizeNativeHook(f.payload, { ...f.binding, directoryIdentity: '0'.repeat(64) })).toThrow('WORKTREE_MISMATCH')
  expect(() => normalizeNativeHook(f.payload, { ...f.binding, enabled: false })).toThrow('DISABLED')
  const envelope = normalizeNativeHook(f.payload, f.binding)
  expect(() => parseNativeEnvelope(JSON.stringify({ ...envelope, sessionId: '0'.repeat(64) }))).toThrow('ENVELOPE_INTEGRITY')
  expect(() => parseNativeEnvelope(JSON.stringify({ ...envelope, prompt: 'private' }))).toThrow('INVALID_ENVELOPE')
})
test('deduplicates independently of observed time and bounds disk admission', () => {
  const f = fixture(), envelope = normalizeNativeHook(f.payload, f.binding)
  expect(spoolNativeHook(envelope, f.spool)).toBe('WRITTEN')
  expect(spoolNativeHook(normalizeNativeHook(f.payload, f.binding, new Date(0)), f.spool)).toBe('DUPLICATE')
  expect(readdirSync(f.spool)).toHaveLength(1)
  for (let index = 0; index < nativeHookLimits.slots; index++) {
    const file = join(f.spool, `${index}.json`)
    writeFileSync(file, JSON.stringify(envelope))
  }
  const other = normalizeNativeHook({ ...f.payload, tool_use_id: 'call-2' }, f.binding)
  expect(spoolNativeHook(other, f.spool)).toBe('FULL')
  expect(readdirSync(f.spool)).toHaveLength(nativeHookLimits.slots)
  expect(readdirSync(f.spool).every(file => Buffer.byteLength(readFileSync(join(f.spool, file))) < nativeHookLimits.envelopeBytes)).toBe(true)
})
test('command fails open without output for malformed, oversized or disabled input', () => {
  const f = fixture(), file = join(f.root, 'binding.json')
  writeFileSync(file, JSON.stringify(f.binding))
  const command = join(process.cwd(), 'out/session-context/native-hook.cjs')
  for (const input of ['{', 'x'.repeat(nativeHookLimits.inputBytes + 1), JSON.stringify({ ...f.payload, session_id: '../private' })]) {
    expect(execFileSync(process.execPath, [command, file], { input, timeout: 3000, encoding: 'utf8' })).toBe('')
  }
  expect(readdirSync(f.spool)).toEqual(['gap.json'])
  expect(execFileSync(process.execPath, [command, file], { input: JSON.stringify(f.payload), timeout: 3000, encoding: 'utf8' })).toBe('')
  expect(readdirSync(f.spool)).toHaveLength(2)
  const eventFile = readdirSync(f.spool).find(file => file !== 'gap.json')!
  const hash = nativeDigest(readFileSync(join(f.spool, eventFile), 'utf8'))
  writeFileSync(file, JSON.stringify({ ...f.binding, enabled: false }))
  execFileSync(process.execPath, [command, file], { input: JSON.stringify({ ...f.payload, tool_use_id: 'new-call' }), timeout: 3000 })
  expect(readdirSync(f.spool)).toHaveLength(2)
  expect(nativeDigest(readFileSync(join(f.spool, eventFile), 'utf8'))).toBe(hash)
})
test('requires explicit opt-in, preserves Entire handlers and restores exact configuration bytes', () => {
  const f = fixture(), commandPath = join(process.cwd(), 'out/session-context/native-hook.cjs')
  mkdirSync(join(f.root, '.codex'))
  const before = '{ "description": "existing", "hooks": { "SessionStart": [{"matcher":"startup","hooks":[{"type":"command","command":"entire hooks codex session-start","timeout":20}]}] } }\n'
  const config = join(f.root, '.codex/hooks.json'); writeFileSync(config, before)
  const record = { path: f.root, worktreeId: f.binding.worktreeId, generation: f.binding.generation, branch: 'test', head: 'a'.repeat(40), detached: false, locked: false, missing: false, prunable: false }
  expect(() => installNativeHooks({ repositoryId: 'repository', record, commandPath, nodePath: process.execPath, authorized: false })).toThrow('HOOK_AUTHORIZATION_REQUIRED')
  expect(readFileSync(config, 'utf8')).toBe(before)
  expect(installNativeHooks({ repositoryId: 'repository', record, commandPath, nodePath: process.execPath, authorized: true })).toMatchObject({ state: 'CONFIGURED', capture: 'UNOBSERVED' })
  const composed = JSON.parse(readFileSync(config, 'utf8'))
  expect(composed.hooks.SessionStart[0]).toEqual(JSON.parse(before).hooks.SessionStart[0])
  expect(composed.hooks.SessionStart).toHaveLength(2)
  expect(disableNativeHooks(f.root, true)).toEqual({ state: 'DISABLED', restored: true })
  expect(readFileSync(config, 'utf8')).toBe(before)
  expect(composeNativeHooks(composeNativeHooks(before, 'native-command'), 'native-command')).toBe(composeNativeHooks(before, 'native-command'))
})
