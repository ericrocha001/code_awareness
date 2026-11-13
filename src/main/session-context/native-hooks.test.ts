import { afterEach, expect, test, vi } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile, execFileSync } from 'node:child_process'
import { nativeDigest, nativeGitIdentity, nativeHookLimits, normalizeNativeHook, parseNativeEnvelope, prepareNativeSpool, recordNativeGap, spoolNativeHook, type NativeHookBinding } from './native-hooks'
import { composeNativeHooks, disableNativeHooks, installNativeHooks, inspectNativeInstallation } from './native-hook-installation'
import { publicationRequestDigest, publicationReceiptDigest } from '../../shared/types/publication-provenance-types'
import { nativeObservationBatch } from './native-hook-ingestion'

import * as safeConfig from '../local-mcp-clients/safe-config-file'
import { gitReceiptFingerprint } from '../git-operations/git-operation-receipts'

const directories: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })
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

test('captures allowlisted publication receipts with positive structured success and no private payload bytes', () => {
  const f = fixture(), secret = 'PRIVATE_DOCUMENT_' + 'x'.repeat(20000)
  const input = { rawMarkdown: secret, kind: 'INVESTIGATION' }
  const requestDigest = publicationRequestDigest('PUBLISH', input)
  const body = { schemaVersion: 1 as const, receiptId: 'publication-11111111-1111-4111-8111-111111111111', repositoryId: f.binding.repositoryId,
    artifactId: 'artifact-11111111-1111-4111-8111-111111111111', revision: 1, contentHash: nativeDigest(secret), requestDigest, action: 'PUBLISH' as const }
  const receipt = { ...body, digest: publicationReceiptDigest(body) }
  const response = { success: true, artifactId: body.artifactId, revision: 1, publicationReceipt: receipt, replayed: false }
  const payload = { ...f.payload, tool_name: 'mcp__code_awareness_local__publish_artifact', tool_input: input }
  const pre = normalizeNativeHook(payload, f.binding)
  const post = normalizeNativeHook({ ...payload, hook_event_name: 'PostToolUse', tool_response: { content: [{ type: 'text', text: JSON.stringify(response) }], private: secret } }, f.binding)
  expect(pre.artifact).toMatchObject({ category: 'ARTIFACT_PUBLISH', requestDigest, outcome: 'UNKNOWN' })
  expect(post.artifact).toMatchObject({ outcome: 'SUCCESS', receipt: { receiptId: receipt.receiptId, replayed: false } })
  for (const event of [pre, post]) {
    expect(parseNativeEnvelope(JSON.stringify(event))).toEqual(event)
    expect(JSON.stringify(event)).not.toContain('PRIVATE_DOCUMENT')
    expect(JSON.stringify(event)).not.toContain(f.root)
    expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThan(nativeHookLimits.envelopeBytes)
    expect(spoolNativeHook(event, f.spool)).toBe('WRITTEN')
    const batch = nativeObservationBatch(event)
    expect(batch.edges.every(edge => edge.evidenceRef.length <= 500)).toBe(true)
    expect(JSON.stringify(batch)).not.toContain('PRIVATE_DOCUMENT')
  }
  for (const tool_response of [{}, { isError: false }, { content: [{ type: 'text', text: JSON.stringify({ artifactId: body.artifactId }) }] },
    { structuredContent: { ...response, success: undefined } }, { structuredContent: { ...response, publicationReceipt: { ...receipt, digest: '0'.repeat(64) } } }]) {
    expect(normalizeNativeHook({ ...payload, hook_event_name: 'PostToolUse', tool_response }, f.binding).artifact).toMatchObject({ outcome: 'UNKNOWN' })
  }
  expect(normalizeNativeHook({ ...payload, hook_event_name: 'PostToolUse', tool_response: { isError: true } }, f.binding).artifact?.outcome).toBe('FAILURE')
  expect(normalizeNativeHook({ ...payload, tool_name: 'mcp__untrusted__publish_artifact' }, f.binding).artifact).toBeUndefined()
  expect(normalizeNativeHook({ ...payload, tool_name: 'Bash' }, f.binding).artifact).toBeUndefined()
  expect(normalizeNativeHook({ ...payload, session_id: 'another-session' }, f.binding).invocationId).not.toBe(pre.invocationId)
  expect(normalizeNativeHook({ ...payload, agent_id: 'another-agent' }, f.binding).eventId).not.toBe(pre.eventId)
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
  expect(readdirSync(f.spool)).toHaveLength(3)
  expect(execFileSync(process.execPath, [command, file], { input: JSON.stringify(f.payload), timeout: 3000, encoding: 'utf8' })).toBe('')
  expect(readdirSync(f.spool)).toHaveLength(4)
  const eventFile = readdirSync(f.spool).find(file => /^\d+\.json$/.test(file))!
  const hash = nativeDigest(readFileSync(join(f.spool, eventFile), 'utf8'))
  writeFileSync(file, JSON.stringify({ ...f.binding, enabled: false }))
  execFileSync(process.execPath, [command, file], { input: JSON.stringify({ ...f.payload, tool_use_id: 'new-call' }), timeout: 3000 })
  expect(readdirSync(f.spool)).toHaveLength(4)
  expect(nativeDigest(readFileSync(join(f.spool, eventFile), 'utf8'))).toBe(hash)
})

test('command persists one scoped window across start/pre/post and closes it without changing legacy loss', () => {
  const f = fixture(), directory = join(f.root, '.code-awareness/native-hooks'), file = join(directory, 'binding.json')
  mkdirSync(directory, { recursive: true }); mkdirSync(join(f.root, '.codex'))
  writeFileSync(file, JSON.stringify(f.binding)); writeFileSync(join(f.root, '.codex/hooks.json'), '{}')
  const legacy = JSON.stringify({ schema: 1, observedAt: '2020-01-01T00:00:00.000Z' })
  writeFileSync(join(f.spool, 'gap.json'), legacy)
  const command = join(process.cwd(), 'out/session-context/native-hook.cjs')
  for (const hook_event_name of ['SessionStart', 'PreToolUse', 'PostToolUse', 'SessionEnd']) {
    expect(execFileSync(process.execPath, [command, file], { input: JSON.stringify({ ...f.payload, hook_event_name,
      ...(hook_event_name === 'SessionStart' || hook_event_name === 'SessionEnd' ? { tool_use_id: undefined } : {}) }), encoding: 'utf8', timeout: 3000 })).toBe('')
  }
  const events = readdirSync(f.spool).filter(name => /^\d+\.json$/.test(name)).map(name => parseNativeEnvelope(readFileSync(join(f.spool, name), 'utf8')))
  expect(events).toHaveLength(4)
  expect(events.every(event => event.capture?.epoch === events[0].capture?.epoch && event.capture?.configuration === events[0].capture?.configuration)).toBe(true)
  expect(events[0].capture).toBeDefined()
  expect(readdirSync(f.spool).some(name => name.startsWith('window-'))).toBe(false)
  expect(readFileSync(join(f.spool, 'gap.json'), 'utf8')).toBe(legacy)
})

test('command emits bounded typed diagnostics without payloads at each failing boundary', () => {
  const cases = [
    { input: '{PRIVATE_SECRET', reasonCode: 'JSON_SYNTAX', phase: 'PARSE', eventType: 'UNKNOWN' },
    { input: '[]', reasonCode: 'JSON_STRUCTURE', phase: 'NORMALIZE', eventType: 'UNKNOWN' },
    { change: { hook_event_name: 'PRIVATE_SECRET' }, reasonCode: 'EVENT_UNSUPPORTED', phase: 'NORMALIZE', eventType: 'UNKNOWN' },
    { change: { session_id: null }, reasonCode: 'REQUIRED_ID_MISSING', phase: 'NORMALIZE', eventType: 'PreToolUse' },
    { change: { session_id: '../PRIVATE_SECRET' }, reasonCode: 'INVALID_ID', phase: 'NORMALIZE', eventType: 'PreToolUse' },
    { change: { tool_use_id: null }, reasonCode: 'INVOCATION_ID_MISSING', phase: 'NORMALIZE', eventType: 'PreToolUse' },
    { mismatch: true, reasonCode: 'WORKTREE_MISMATCH', phase: 'NORMALIZE', eventType: 'PreToolUse' },
    { full: true, reasonCode: 'SPOOL_FULL', phase: 'WRITE', eventType: 'PreToolUse' }
  ]
  for (const sample of cases) {
    const f = fixture(), binding = join(f.root, 'binding.json')
    writeFileSync(binding, JSON.stringify({ ...f.binding, ...(sample.mismatch ? { directoryIdentity: '0'.repeat(64) } : {}) }))
    if (sample.full) for (let slot = 0; slot < nativeHookLimits.slots; slot++) writeFileSync(join(f.spool, `${slot}.json`), '{}')
    const input = sample.input ?? JSON.stringify({ ...f.payload, ...sample.change, prompt: 'PRIVATE_SECRET' })
    expect(execFileSync(process.execPath, [join(process.cwd(), 'out/session-context/native-hook.cjs'), binding], { input, encoding: 'utf8', timeout: 3000 })).toBe('')
    const text = readFileSync(join(f.spool, 'gap-0.json'), 'utf8')
    expect(JSON.parse(text)).toMatchObject({ schema: 2, reasonCode: sample.reasonCode, phase: sample.phase, eventType: sample.eventType })
    expect(text.length).toBeLessThan(256)
    expect(text).not.toContain('PRIVATE_SECRET'); expect(text).not.toContain(f.root); expect(text).not.toContain('session-1')
  }
})

test('concurrent commands preserve both receipts and bound repeated failures', async () => {
  const f = fixture(), binding = join(f.root, 'binding.json'), command = join(process.cwd(), 'out/session-context/native-hook.cjs')
  writeFileSync(binding, JSON.stringify(f.binding))
  await Promise.all(['{', JSON.stringify({ ...f.payload, tool_use_id: null })].map(input => new Promise<void>((resolve, reject) => {
    const child = execFile(process.execPath, [command, binding], { timeout: 3000 }, (error, stdout, stderr) => {
      if (error) return reject(error)
      expect(stdout).toBe(''); expect(stderr).toBe(''); resolve()
    })
    child.stdin!.end(input)
  })))
  expect(readdirSync(f.spool)).toHaveLength(2)
  expect(readdirSync(f.spool).map(name => JSON.parse(readFileSync(join(f.spool, name), 'utf8')).reasonCode).sort()).toEqual(['INVOCATION_ID_MISSING', 'JSON_SYNTAX'])
  const first = readFileSync(join(f.spool, 'gap-0.json'), 'utf8')
  for (let index = 0; index < 100; index++) recordNativeGap(f.spool, 'INPUT_LIMIT')
  expect(readdirSync(f.spool)).toHaveLength(33)
  expect(readFileSync(join(f.spool, 'gap-0.json'), 'utf8')).toBe(first)
  expect(JSON.parse(readFileSync(join(f.spool, 'gap-overflow.json'), 'utf8')).reasonCode).toBe('DIAGNOSTIC_LIMIT')
})

test('command classifies a spool I/O failure without recording the system error message', () => {
  const f = fixture(), binding = join(f.root, 'binding.json'), preloader = join(f.root, 'fault.cjs')
  writeFileSync(binding, JSON.stringify(f.binding))
  writeFileSync(preloader, "const fs = require('node:fs'); const original = fs.linkSync; let first = true; fs.linkSync = (...args) => { if (first) { first = false; throw Object.assign(new Error('PRIVATE_DISK_ERROR'), { code: 'EIO' }); } return original(...args); }")
  expect(execFileSync(process.execPath, ['--require', preloader, join(process.cwd(), 'out/session-context/native-hook.cjs'), binding], { input: JSON.stringify(f.payload), encoding: 'utf8', timeout: 3000 })).toBe('')
  const text = readFileSync(join(f.spool, 'gap-0.json'), 'utf8')
  expect(JSON.parse(text)).toMatchObject({ reasonCode: 'IO_FAILURE', phase: 'WRITE', eventType: 'PreToolUse' })
  expect(text).not.toContain('PRIVATE_DISK_ERROR'); expect(text).not.toContain(f.root)
})
test('requires explicit opt-in, preserves Entire handlers and restores exact configuration bytes', () => {
  const f = fixture(), commandPath = join(process.cwd(), 'out/session-context/native-hook.cjs')
  mkdirSync(join(f.root, '.codex'))
  const before = '{ "description": "existing", "hooks": { "SessionStart": [{"matcher":"startup","hooks":[{"type":"command","command":"entire hooks codex session-start","timeout":20}]}] } }\n'
  const config = join(f.root, '.codex/hooks.json'); writeFileSync(config, before)
  const record = { path: f.root, worktreeId: f.binding.worktreeId, generation: f.binding.generation, branch: 'test', head: 'a'.repeat(40), detached: false, locked: false, missing: false, prunable: false }
  expect(() => installNativeHooks({ repositoryId: 'repository', record, commandPath, nodePath: process.execPath, authorized: false })).toThrow('HOOK_AUTHORIZATION_REQUIRED')
  expect(() => installNativeHooks({ repositoryId: 'repository', record, commandPath, nodePath: process.execPath, authorized: true, gitCommitTool: 'untrusted_commit_tool' })).toThrow('INVALID_BINDING')
  expect(readFileSync(config, 'utf8')).toBe(before)
  expect(installNativeHooks({ repositoryId: 'repository', record, commandPath, nodePath: process.execPath, authorized: true })).toMatchObject({ state: 'CONFIGURED', capture: 'UNOBSERVED' })
  const composed = JSON.parse(readFileSync(config, 'utf8'))
  expect(composed.hooks.SessionStart[0]).toEqual(JSON.parse(before).hooks.SessionStart[0])
  expect(composed.hooks.SessionStart).toHaveLength(2)
  expect(composed.hooks.SessionStart[1].hooks[0].commandWindows).toBe('& ' + [process.execPath, commandPath, join(f.root, '.code-awareness/native-hooks/binding.json')].map(path => "'" + path.replaceAll("'", "''") + "'").join(' '))
  expect(disableNativeHooks(f.root, true)).toEqual({ state: 'DISABLED', restored: true })
  expect(readFileSync(config, 'utf8')).toBe(before)
  expect(composeNativeHooks(composeNativeHooks(before, 'native-command'), 'native-command')).toBe(composeNativeHooks(before, 'native-command'))
})

function installationFixture() {
  const f = fixture(), commandPath = join(f.root, 'command.cjs'); writeFileSync(commandPath, '')
  const record = { path: f.root, worktreeId: f.binding.worktreeId, generation: f.binding.generation, branch: 'test', head: 'a'.repeat(40), detached: false, locked: false, missing: false, prunable: false }
  const options = { repositoryId: 'repository', record, commandPath, nodePath: process.execPath, authorized: true }
  const config = join(f.root, '.codex/hooks.json'), snapshot = join(f.root, '.code-awareness/native-hooks/installation.json'), binding = join(f.root, '.code-awareness/native-hooks/binding.json')
  return { ...f, options, config, snapshot, binding, install: () => installNativeHooks(options) }
}
test('U1 exact reinstall is NO_CHANGE across restart and retains bytes, file identities and trust', () => {
  const f = installationFixture(); f.install()
  const paths = [f.config, f.snapshot, f.binding], before = paths.map(path => [readFileSync(path, 'utf8'), statSync(path).ino, statSync(path).mtimeMs])
  expect(f.install()).toMatchObject({ state: 'NO_CHANGE', trust: 'UNCHANGED' })
  expect(installNativeHooks(JSON.parse(JSON.stringify(f.options)))).toMatchObject({ state: 'NO_CHANGE' })
  expect(paths.map(path => [readFileSync(path, 'utf8'), statSync(path).ino, statSync(path).mtimeMs])).toEqual(before)
}, 30000)
test('U1 repair and disable preserve third parties added after original snapshot', () => {
  const f = installationFixture(); f.install(); const original = JSON.parse(readFileSync(f.snapshot, 'utf8')).before
  const value = JSON.parse(readFileSync(f.config, 'utf8')), third = { matcher: 'third-party', hooks: [{ type: 'command', command: 'third-party', commandWindows: 'third-party-windows', timeout: 20 }] }
  value.hooks.Stop = [third]; writeFileSync(f.config, JSON.stringify(value))
  expect(inspectNativeInstallation(f.root, { repositoryId: 'repository', ...f.options.record })).toMatchObject({ repairability: 'REPAIRABLE', installed: 6 })
  expect(f.install()).toMatchObject({ state: 'CONFIGURED', trust: 'REVIEW_REQUIRED' })
  expect(JSON.parse(readFileSync(f.snapshot, 'utf8')).before).toBe(original)
  expect(disableNativeHooks(f.root, true)).toMatchObject({ state: 'DISABLED', restored: false })
  const disabled = JSON.parse(readFileSync(f.config, 'utf8'))
  expect(disabled.hooks.Stop).toEqual([third]); expect(JSON.stringify(disabled)).not.toContain(f.options.commandPath.replaceAll('\\', '\\\\'))
  const bytes = readFileSync(f.config, 'utf8'); disableNativeHooks(f.root, true); expect(readFileSync(f.config, 'utf8')).toBe(bytes)
}, 30000)
test('U1 interrupted command upgrade retains previous ownership and repairs without duplicate handlers', () => {
  const f = installationFixture(); f.install(); const prior = readFileSync(f.config, 'utf8'), original = JSON.parse(readFileSync(f.snapshot, 'utf8')).before
  const next = join(f.root, 'next.cjs'); writeFileSync(next, ''); const options = { ...f.options, commandPath: next }
  const write = safeConfig.writeConfig; let injected = false
  const spy = vi.spyOn(safeConfig, 'writeConfig').mockImplementation((path, profile, revision, content, callback) => {
    if (path === f.config && !injected) { injected = true; const value = JSON.parse(prior); value.description = 'concurrent third party'; writeFileSync(path, JSON.stringify(value)) }
    return write(path, profile, revision, content, callback)
  })
  expect(() => installNativeHooks(options)).toThrow('CONFIG_REVISION_CONFLICT'); spy.mockRestore()
  expect(JSON.parse(readFileSync(f.snapshot, 'utf8')).previousOwned).toBeDefined()
  expect(installNativeHooks(options)).toMatchObject({ state: 'CONFIGURED' })
  const value = JSON.parse(readFileSync(f.config, 'utf8')); expect(value.description).toBe('concurrent third party')
  for (const groups of Object.values(value.hooks) as any[]) { expect(groups).toHaveLength(1); expect(groups[0].hooks).toHaveLength(1); expect(groups[0].hooks[0].command).toContain(next) }
  expect(JSON.parse(readFileSync(f.snapshot, 'utf8')).before).toBe(original)
  disableNativeHooks(f.root, true); expect(JSON.parse(readFileSync(f.config, 'utf8')).description).toBe('concurrent third party')
}, 30000)
test('U1 rejects unsafe ancestors before any spool or snapshot write outside selected checkout', () => {
  for (const name of ['.code-awareness', '.codex']) {
    const f = installationFixture(), external = mkdtempSync(join(tmpdir(), 'native-external-')); directories.unshift(external)
    writeFileSync(join(external, 'sentinel'), 'unchanged'); symlinkSync(external, join(f.root, name), 'junction')
    expect(() => f.install()).toThrow(/LINK|UNSAFE/)
    expect(readdirSync(external)).toEqual(['sentinel']); expect(readFileSync(join(external, 'sentinel'), 'utf8')).toBe('unchanged')
    expect(existsSync(f.snapshot)).toBe(false)
  }
})
test('U1 malformed JSON, stale generation and conflicting owned command remain unchanged', () => {
  const f = installationFixture(); f.install(); const installed = readFileSync(f.config, 'utf8')
  expect(() => installNativeHooks({ ...f.options, record: { ...f.options.record, generation: '3'.repeat(64) } })).toThrow('WORKTREE_STALE')
  writeFileSync(f.config, '{'); expect(() => f.install()).toThrow(); expect(readFileSync(f.config, 'utf8')).toBe('{')
  const value = JSON.parse(installed); value.hooks.Stop[0].hooks[0].commandWindows = 'changed'; writeFileSync(f.config, JSON.stringify(value)); const before = readFileSync(f.config, 'utf8')
  expect(() => f.install()).toThrow('NATIVE_HANDLER_CONFLICT'); expect(() => disableNativeHooks(f.root, true)).toThrow('NATIVE_HANDLER_CONFLICT'); expect(readFileSync(f.config, 'utf8')).toBe(before)
}, 30000)
test('U3 optional delivery context is structurally strict and fingerprints every actual argument', () => {
  const f = fixture(), binding = { ...f.binding, gitCommitTool: 'mcp__code_awareness_local__commit_git_changes' }
  const args = { message: 'private message', expectedHead: 'a'.repeat(40), expectedIndexRevision: 'b'.repeat(64) }
  const deliveryContext = { bindingArtifactId: 'artifact-execution-branch-' + 'c'.repeat(64), bindingRevision: 1, planArtifactId: 'artifact-11111111-1111-4111-8111-111111111111', planRevision: 2, executionId: 'execution-1' }
  const event = (input: unknown) => normalizeNativeHook({ ...f.payload, tool_name: binding.gitCommitTool, tool_input: { operationId: 'operation-1', ...input as object } }, binding)
  expect(event(args).git?.fingerprint).toBe(gitReceiptFingerprint('commit_git_changes', args))
  const extended = { ...args, deliveryContext }; const observed = event(extended)
  expect(observed.git?.fingerprint).toBe(gitReceiptFingerprint('commit_git_changes', extended)); expect(observed.git?.fingerprint).not.toBe(event(args).git?.fingerprint)
  expect(JSON.stringify(observed)).not.toContain('private message'); expect(JSON.stringify(observed)).not.toContain(deliveryContext.bindingArtifactId)
  for (const context of [{ ...deliveryContext, extra: true }, { ...deliveryContext, planRevision: 0 }, { ...deliveryContext, planArtifactId: 'other' }, { ...deliveryContext, planArtifactId: 'artifact-AAAAAAAA-1111-4111-8111-111111111111' }, { ...deliveryContext, bindingRevision: Number.MAX_SAFE_INTEGER + 1 }]) expect(event({ ...args, deliveryContext: context }).git).toBeUndefined()
})

test('U1 legacy v1 ownership is reconstructed only from exact composition and keeps original snapshot', () => {
  const f = installationFixture(); f.install()
  const current = JSON.parse(readFileSync(f.snapshot, 'utf8')), legacy = { schema: 1, path: current.path, before: current.before, installedDigest: current.installedDigest }
  writeFileSync(f.snapshot, JSON.stringify(legacy)); const before = readFileSync(f.snapshot, 'utf8')
  expect(f.install()).toMatchObject({ state: 'NO_CHANGE', trust: 'UNCHANGED' }); expect(readFileSync(f.snapshot, 'utf8')).toBe(before)
  const value = JSON.parse(readFileSync(f.config, 'utf8')); delete value.hooks.Stop; writeFileSync(f.config, JSON.stringify(value))
  expect(f.install()).toMatchObject({ state: 'CONFIGURED' }); expect(JSON.parse(readFileSync(f.snapshot, 'utf8')).before).toBe(legacy.before)
  const unknown = JSON.parse(readFileSync(f.snapshot, 'utf8')); unknown.schema = 1; unknown.installedDigest = '0'.repeat(64); writeFileSync(f.snapshot, JSON.stringify(unknown))
  expect(() => f.install()).toThrow('INSTALLATION_OWNERSHIP_UNPROVEN')
}, 30000)

test('U1 rejects oversized config before creating the spool or installation journal', () => {
  const f = installationFixture(), before = JSON.stringify({ description: 'x'.repeat(65536) })
  mkdirSync(join(f.root, '.codex')); writeFileSync(f.config, before)
  expect(() => f.install()).toThrow('HOOK_CONFIG_LIMIT')
  expect(readFileSync(f.config, 'utf8')).toBe(before)
  expect(existsSync(join(f.root, '.code-awareness'))).toBe(false)
})

test('U1 repairs external binding drift from the journal and re-enables a disabled checkout safely', () => {
  const f = installationFixture(), tool = 'mcp__code_awareness_local__commit_git_changes'
  installNativeHooks({ ...f.options, gitCommitTool: tool })
  const binding = JSON.parse(readFileSync(f.binding, 'utf8'))
  writeFileSync(f.binding, JSON.stringify({ ...binding, gitCommitTool: 'mcp__other__commit_git_changes' }))
  expect(inspectNativeInstallation(f.root, { repositoryId: 'repository', ...f.options.record })).toMatchObject({ reasonCode: 'HOOK_BINDING_DRIFT', repairability: 'REPAIRABLE', installed: 7 })
  expect(f.install()).toMatchObject({ state: 'CONFIGURED' })
  expect(JSON.parse(readFileSync(f.binding, 'utf8'))).toEqual(binding)
  expect(disableNativeHooks(f.root, true)).toMatchObject({ restored: true }); expect(existsSync(f.config)).toBe(false)
  expect(f.install()).toMatchObject({ state: 'CONFIGURED' })
  expect(JSON.parse(readFileSync(f.binding, 'utf8'))).toEqual(binding)
  expect(f.install()).toMatchObject({ state: 'NO_CHANGE' })
  expect(disableNativeHooks(f.root, true)).toMatchObject({ restored: true }); expect(existsSync(f.config)).toBe(false)
}, 30000)

test('U1 publishes a new command only after preflight and detects immutable bundle tampering', () => {
  const f = installationFixture(), commandContent = 'process.exitCode = 0\n'
  const commandPath = join(f.root, 'out/session-context', 'native-hook-' + nativeDigest(commandContent) + '.cjs')
  const options = { ...f.options, commandPath, commandContent }
  expect(() => installNativeHooks({ ...options, authorized: false })).toThrow('HOOK_AUTHORIZATION_REQUIRED')
  expect(existsSync(commandPath)).toBe(false)
  mkdirSync(join(f.root, '.codex')); writeFileSync(f.config, '{')
  expect(() => installNativeHooks(options)).toThrow(); expect(existsSync(commandPath)).toBe(false)
  writeFileSync(f.config, '{}')
  expect(installNativeHooks(options)).toMatchObject({ state: 'CONFIGURED', trust: 'REVIEW_REQUIRED' })
  const original = statSync(commandPath); expect(readFileSync(commandPath, 'utf8')).toBe(commandContent)
  expect(installNativeHooks(options)).toMatchObject({ state: 'NO_CHANGE', trust: 'UNCHANGED' })
  expect(statSync(commandPath).mtimeMs).toBe(original.mtimeMs)
  writeFileSync(commandPath, 'tampered')
  expect(() => installNativeHooks(options)).toThrow('HOOK_COMMAND_DIGEST_MISMATCH')
  expect(inspectNativeInstallation(f.root, { repositoryId: 'repository', ...f.options.record })).toMatchObject({ reasonCode: 'HOOK_COMMAND_DIGEST_MISMATCH' })
}, 30000)
