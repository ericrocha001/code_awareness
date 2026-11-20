import { afterEach, expect, test, vi } from 'vitest'
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFile, execFileSync, spawnSync } from 'node:child_process'
import { nativeDigest, nativeGitIdentity, nativeHookLimits, nativeSessionEntityId, normalizeNativeHook, parseNativeEnvelope, nativeBindingPath, prepareNativeSpool, readActiveHookActivation, readNativeBinding, recordNativeGap, resolveNativeHookBinding, spoolNativeHook, spoolNativeHookWithDetail, type NativeHookBinding } from './native-hooks'
import { composeNativeHooks, disableNativeHooks, installNativeHooks, inspectNativeInstallation, inspectSharedNativeInstallation } from './native-hook-installation'
import { inspectNativeTrust, type NativeHookClient } from './native-hook-preflight'
import { buildSync } from 'esbuild'
import { publicationRequestDigest, publicationReceiptDigest } from '../../shared/types/publication-provenance-types'
import { nativeObservationBatch } from './native-hook-ingestion'

import * as safeConfig from '../local-mcp-clients/safe-config-file'
import { gitReceiptFingerprint } from '../git-operations/git-operation-receipts'

const directories: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'native-hooks-')); directories.push(root)
  mkdirSync(join(root, '.git')); writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/test\n')
  const spool = join(root, 'spool'); prepareNativeSpool(spool)
  const binding: NativeHookBinding = { schema: 1, enabled: true, repositoryId: 'repository', worktreeId: '1'.repeat(64), generation: '2'.repeat(64), ...nativeGitIdentity(root), spool }
  return { root, spool, binding, payload: { session_id: 'session-1', cwd: root, hook_event_name: 'PreToolUse', turn_id: 'turn-1', tool_use_id: 'call-1', tool_name: 'Bash' } }
}
function dispatcherBinding(root: string, admin: string, gitPath: string, repositoryId = 'repository'): NativeHookBinding {
  const identity = nativeGitIdentity(root)
  const adminStat = statSync(admin, { bigint: true }), rootStat = statSync(root, { bigint: true })
  const generation = nativeDigest(JSON.stringify([realpathSync(admin), String(adminStat.dev), String(adminStat.ino),
    String(adminStat.birthtimeNs), identity.root, String(rootStat.ino), String(rootStat.birthtimeNs)]))
  const worktreeId = nativeDigest(JSON.stringify([repositoryId, identity.commonDirectory, generation, gitPath]))
  const spool = join(root, '.code-awareness/native-hooks/spool')
  mkdirSync(join(root, '.code-awareness/native-hooks'), { recursive: true })
  prepareNativeSpool(spool)
  const binding = { schema: 1 as const, enabled: true, repositoryId, worktreeId, generation, ...identity, spool }
  writeFileSync(nativeBindingPath(root), JSON.stringify(binding))
  return binding
}

function commandFixture() {
  const f = fixture(), root = realpathSync(f.root)
  const binding = dispatcherBinding(root, join(root, '.git'), process.platform === 'win32' ? root.replaceAll('\\', '/') : root)
  return { ...f, root, binding, spool: binding.spool, payload: { ...f.payload, cwd: root } }
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
  const f = commandFixture(), file = nativeBindingPath(f.root)
  writeFileSync(file, JSON.stringify(f.binding))
  const command = join(process.cwd(), 'out/session-context/native-hook.cjs')
  for (const input of ['{', 'x'.repeat(nativeHookLimits.inputBytes + 1), JSON.stringify({ ...f.payload, session_id: '../private' })]) {
    expect(execFileSync(process.execPath, [command, file], { cwd: f.root, input, timeout: 3000, encoding: 'utf8' })).toBe('')
  }
  expect(readdirSync(f.spool)).toHaveLength(3)
  expect(execFileSync(process.execPath, [command, file], { cwd: f.root, input: JSON.stringify(f.payload), timeout: 3000, encoding: 'utf8' })).toBe('')
  expect(readdirSync(f.spool)).toHaveLength(4)
  const eventFile = readdirSync(f.spool).find(file => /^\d+\.json$/.test(file))!
  const hash = nativeDigest(readFileSync(join(f.spool, eventFile), 'utf8'))
  writeFileSync(file, JSON.stringify({ ...f.binding, enabled: false }))
  execFileSync(process.execPath, [command, file], { cwd: f.root, input: JSON.stringify({ ...f.payload, tool_use_id: 'new-call' }), timeout: 3000 })
  expect(readdirSync(f.spool)).toHaveLength(4)
  expect(nativeDigest(readFileSync(join(f.spool, eventFile), 'utf8'))).toBe(hash)
})

test('command persists one scoped window across start/pre/post and closes it without changing legacy loss', () => {
  const f = commandFixture(), file = nativeBindingPath(f.root)
  mkdirSync(join(f.root, '.codex'))
  writeFileSync(file, JSON.stringify(f.binding)); writeFileSync(join(f.root, '.codex/hooks.json'), '{}')
  const legacy = JSON.stringify({ schema: 1, observedAt: '2020-01-01T00:00:00.000Z' })
  writeFileSync(join(f.spool, 'gap.json'), legacy)
  const command = join(process.cwd(), 'out/session-context/native-hook.cjs')
  for (const hook_event_name of ['SessionStart', 'PreToolUse', 'PostToolUse', 'SessionEnd']) {
    expect(execFileSync(process.execPath, [command, file], { cwd: f.root, input: JSON.stringify({ ...f.payload, hook_event_name,
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
    { full: true, reasonCode: 'SPOOL_FULL', phase: 'WRITE', eventType: 'PreToolUse' }
  ]
  for (const sample of cases) {
    const f = commandFixture(), binding = nativeBindingPath(f.root)
    if (sample.full) for (let slot = 0; slot < nativeHookLimits.slots; slot++) writeFileSync(join(f.spool, `${slot}.json`), '{}')
    const input = sample.input ?? JSON.stringify({ ...f.payload, ...sample.change, prompt: 'PRIVATE_SECRET' })
    expect(execFileSync(process.execPath, [join(process.cwd(), 'out/session-context/native-hook.cjs'), binding], { cwd: f.root, input, encoding: 'utf8', timeout: 3000 })).toBe('')
    const text = readFileSync(join(f.spool, 'gap-0.json'), 'utf8')
    expect(JSON.parse(text)).toMatchObject({ schema: 2, reasonCode: sample.reasonCode, phase: sample.phase, eventType: sample.eventType })
    expect(text.length).toBeLessThan(256)
    expect(text).not.toContain('PRIVATE_SECRET'); expect(text).not.toContain(f.root); expect(text).not.toContain('session-1')
  }
})

test('concurrent commands preserve both receipts and bound repeated failures', async () => {
  const f = commandFixture(), binding = nativeBindingPath(f.root), command = join(process.cwd(), 'out/session-context/native-hook.cjs')
  writeFileSync(binding, JSON.stringify(f.binding))
  await Promise.all(['{', JSON.stringify({ ...f.payload, tool_use_id: null })].map(input => new Promise<void>((resolve, reject) => {
    const child = execFile(process.execPath, [command, binding], { cwd: f.root, timeout: 3000 }, (error, stdout, stderr) => {
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
  const f = commandFixture(), binding = nativeBindingPath(f.root), preloader = join(f.root, 'fault.cjs')
  writeFileSync(binding, JSON.stringify(f.binding))
  writeFileSync(preloader, "const fs = require('node:fs'); const original = fs.linkSync; let first = true; fs.linkSync = (...args) => { if (first) { first = false; throw Object.assign(new Error('PRIVATE_DISK_ERROR'), { code: 'EIO' }); } return original(...args); }")
  expect(execFileSync(process.execPath, ['--require', preloader, join(process.cwd(), 'out/session-context/native-hook.cjs'), binding], { cwd: f.root, input: JSON.stringify(f.payload), encoding: 'utf8', timeout: 3000 })).toBe('')
  const text = readFileSync(join(f.spool, 'gap-0.json'), 'utf8')
  expect(JSON.parse(text)).toMatchObject({ reasonCode: 'IO_FAILURE', phase: 'WRITE', eventType: 'PreToolUse' })
  expect(text).not.toContain('PRIVATE_DISK_ERROR'); expect(text).not.toContain(f.root)
})

test('dispatches one main helper to separate Git worktrees and refuses unsafe or stale bindings', async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'native-dispatch-'))); directories.push(base)
  const roots = ['main', 'one', 'two', 'foreign'].map(name => join(base, name))
  const [main, one, two, foreign] = roots
  mkdirSync(main)
  mkdirSync(foreign)
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.fsmonitor=false',
    '-c', 'core.hooksPath=' + join(base, 'no-hooks'), '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
  { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim()
  git(main, 'init', '-b', 'main')
  git(main, 'commit', '--allow-empty', '-m', 'fixture')
  git(main, 'worktree', 'add', '-b', 'one', one)
  git(main, 'worktree', 'add', '-b', 'two', two)
  git(foreign, 'init', '-b', 'main')
  const listed = git(main, 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).map(line => line.slice(9))
  const bindings = roots.map((root, index) => dispatcherBinding(root, git(root, 'rev-parse', '--absolute-git-dir'),
    index < 3 ? listed.find(path => realpathSync(path) === root)! : git(root, 'rev-parse', '--show-toplevel')))
  const [anchor, bindingOne, bindingTwo, foreignBinding] = bindings
  const command = join(main, 'out/session-context/native-hook.cjs'), anchorPath = nativeBindingPath(main)
  mkdirSync(dirname(command), { recursive: true })
  copyFileSync(join(process.cwd(), 'out/session-context/native-hook.cjs'), command)
  const commandInOne = join(one, 'out/session-context/native-hook.cjs')
  mkdirSync(dirname(commandInOne), { recursive: true })
  copyFileSync(command, commandInOne)
  const legacyNode = join(main, process.platform === 'win32' ? 'node.exe' : 'node')
  writeFileSync(legacyNode, '')
  const before = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'entire hooks codex session-start', timeout: 20 }] }] } })
  const config = join(main, '.codex/hooks.json')
  mkdirSync(dirname(config))
  const legacyConfig = composeNativeHooks(before, [legacyNode, command, anchorPath].join(' '))
  writeFileSync(config, legacyConfig)
  writeFileSync(join(dirname(anchorPath), 'installation.json'), JSON.stringify({ schema: 1, path: config, before, installedDigest: nativeDigest(legacyConfig) }))
  expect(inspectNativeInstallation(main, anchor)).toMatchObject({ state: 'CONFIGURED', installed: 7 })
  const shared = inspectSharedNativeInstallation(one, bindingOne)!
  expect(shared.handlers).toHaveLength(7)
  const localRecord = { ...bindingOne, path: one, branch: 'one', head: git(one, 'rev-parse', 'HEAD'), detached: false, locked: false, missing: false, prunable: false }
  const localInstall = { repositoryId: bindingOne.repositoryId, record: localRecord, commandPath: commandInOne, nodePath: process.execPath, authorized: true }
  rmSync(nativeBindingPath(one))
  expect(installNativeHooks(localInstall).state).toBe('CONFIGURED')
  expect(installNativeHooks(localInstall).state).toBe('NO_CHANGE')
  const hooks = shared.handlers.map(handler => ({
    key: process.platform === 'win32' ? handler.key.toLowerCase() : handler.key, sourcePath: handler.sourcePath,
    eventName: handler.event[0].toLowerCase() + handler.event.slice(1), currentHash: 'sha256:' + nativeDigest(handler.key), trustStatus: 'trusted', enabled: true
  }))
  const scope = { ...bindingOne, workspaceRoot: one, projectTrusted: true, clientId: 'client', sessionId: 'session', threadId: 'thread',
    connectedAt: new Date().toISOString(), clientVersion: '0.169.0-alpha.11.1', protocolVersion: 'codex-app-server/v2' }
  const client: NativeHookClient = { authorized: true, scope: () => scope,
  request: async () => ({ data: [{ hooks }] }) }
  expect(await inspectNativeTrust(one, bindingOne, true, client)).toMatchObject({ state: 'TRUSTED', loadedSource: 'MAIN', trusted: 7 })
  const localHandler = inspectNativeInstallation(one, bindingOne).handlers[0]
  const mixed: NativeHookClient = { ...client, request: async () => ({ data: [{ hooks: [...hooks,
    { ...hooks[0], key: localHandler.key, sourcePath: localHandler.sourcePath }] }] }) }
  expect(await inspectNativeTrust(one, bindingOne, true, mixed)).toMatchObject({ state: 'UNKNOWN', reasonCode: 'HOOK_SCOPE_AMBIGUOUS' })
  const hook = hooks[0], correctSource = hook.sourcePath
  hook.sourcePath = join(two, '.codex/hooks.json')
  expect(await inspectNativeTrust(one, bindingOne, true, client)).toMatchObject({ state: 'UNKNOWN', reasonCode: 'HOOK_DISCOVERY_MISMATCH' })
  hook.sourcePath = correctSource
  writeFileSync(config, legacyConfig + '\n')
  expect(inspectSharedNativeInstallation(one, bindingOne)).toBeUndefined()
  expect(await inspectNativeTrust(one, bindingOne, true, client)).toMatchObject({ state: 'UNKNOWN' })
  writeFileSync(config, legacyConfig)
  expect(resolveNativeHookBinding(anchorPath, one)).toEqual(bindingOne)
  expect(resolveNativeHookBinding(anchorPath, two)).toEqual(bindingTwo)
  const run = (cwd: string, payloadCwd = cwd) => new Promise<void>((resolve, reject) => {
    const child = execFile(process.execPath, [command, anchorPath], { cwd, timeout: 3000 }, (error, stdout, stderr) => {
      if (error) return reject(error)
      expect(stdout).toBe(''); expect(stderr).toBe(''); resolve()
    })
    child.stdin!.end(JSON.stringify({ cwd: payloadCwd, session_id: 'fixture', hook_event_name: 'PreToolUse', tool_use_id: 'one', tool_name: 'Bash' }))
  })
  await Promise.all([run(one), run(two)])
  await run(one)
  for (const binding of [bindingOne, bindingTwo]) {
    const files = readdirSync(binding.spool)
    expect(files).toHaveLength(1)
    const envelope = parseNativeEnvelope(readFileSync(join(binding.spool, files[0]), 'utf8'))
    expect(envelope).toMatchObject({ repositoryId: binding.repositoryId, worktreeId: binding.worktreeId, generation: binding.generation })
  }
  const path = nativeBindingPath(one)
  const baseline = readdirSync(bindingOne.spool)
  for (const change of [{ enabled: false }, { generation: '0'.repeat(64) }, { directoryIdentity: '0'.repeat(64) },
    { worktreeId: bindingTwo.worktreeId }, { repositoryId: 'foreign' }, { spool: anchor.spool }]) {
    writeFileSync(path, JSON.stringify({ ...bindingOne, ...change }))
    await run(one)
  }
  rmSync(path)
  await run(one)
  const directory = join(one, '.code-awareness/native-hooks')
  renameSync(directory, join(one, '.bindings'))
  symlinkSync(dirname(bindingTwo.spool), directory, 'junction')
  await run(one)
  rmSync(directory)
  renameSync(join(one, '.bindings'), directory)
  await Promise.all([run(foreign), run(one, two), run(main, two)])
  expect(readdirSync(bindingOne.spool)).toEqual(baseline)
  expect(readdirSync(bindingTwo.spool)).toHaveLength(1)
  expect(readdirSync(anchor.spool)).toEqual([])
  expect(readdirSync(foreignBinding.spool)).toEqual([])
  await run(main)
  expect(readdirSync(anchor.spool)).toHaveLength(1)
  expect(readFileSync(config, 'utf8')).toBe(legacyConfig)
}, 15000)

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
}, 30000)

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
  const config = readFileSync(f.config, 'utf8')
  unknown.installedDigest = nativeDigest(config)
  unknown.before = config
  writeFileSync(f.snapshot, JSON.stringify(unknown))
  expect(inspectNativeInstallation(f.root, readNativeBinding(f.binding))).toMatchObject({ state: 'UNKNOWN', reasonCode: 'INSTALLATION_OWNERSHIP_UNPROVEN', repairability: 'CONFLICT', installed: 0 })
  expect(readFileSync(f.config, 'utf8')).toBe(config)
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
}, 60000)

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

function antigravityFixture() {
  const root = mkdtempSync(join(tmpdir(), 'ag-hooks-')); directories.push(root)
  mkdirSync(join(root, '.git')); writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/test\n')
  const spool = join(root, '.code-awareness/native-hooks/antigravity/spool'); prepareNativeSpool(spool)
  const binding: NativeHookBinding = { schema: 1, provider: 'antigravity', enabled: true, repositoryId: 'repository', worktreeId: '1'.repeat(64), generation: '2'.repeat(64), ...nativeGitIdentity(root), spool }
  return { root, spool, binding, payload: { conversationId: 'conv-1', workspacePaths: [root], cwd: root, hookEventName: 'PreToolUse', invocationNum: 3, stepIdx: 9, toolCall: { id: 'toolu_01', name: 'run_command', args: { CommandLine: 'SECRET_CMD' } } } }
}

test('Antigravity normalizes 6 lifecycle events, enforces workspacePaths scope, drops secrets and isolates session IDs from Codex', () => {
  const f = antigravityFixture(), secret = 'SECRET_ANTIGRAVITY_PROMPT_AND_PATH'
  const extra = { lastUserInput: secret, transcriptPath: join(f.root, '.gemini/transcript.jsonl'), artifactDirectoryPath: join(f.root, '.gemini/artifacts'), error: secret }
  const start = normalizeNativeHook({ conversationId: 'conv-1', workspacePaths: [f.root], hookEventName: 'SessionStart', ...extra }, f.binding)
  const preInv = normalizeNativeHook({ conversationId: 'conv-1', workspacePaths: [f.root], hookEventName: 'PreInvocation', invocationNum: 3, ...extra }, f.binding)
  const pre = normalizeNativeHook({ ...f.payload, ...extra, tool_input: { operationId: 'op-1', expectedHead: 'a'.repeat(40) } }, f.binding)
  const post = normalizeNativeHook({ ...f.payload, ...extra, hookEventName: 'PostToolUse', toolCall: { id: 'toolu_01', name: 'call_mcp_tool', args: { Query: secret } } }, f.binding)
  const postInv = normalizeNativeHook({ conversationId: 'conv-1', workspacePaths: [f.root], hookEventName: 'PostInvocation', invocationNum: 3, ...extra }, f.binding)
  const stop = normalizeNativeHook({ conversationId: 'conv-1', workspacePaths: [f.root], hookEventName: 'Stop', ...extra }, f.binding)
  const stepFallback = normalizeNativeHook({ ...f.payload, toolCall: { name: 'read_file' }, stepIdx: 12 }, f.binding)

  expect([start, preInv, pre, post, postInv, stop].map(item => item.event)).toEqual(['SessionStart', 'PreInvocation', 'PreToolUse', 'PostToolUse', 'PostInvocation', 'Stop'])
  expect(pre.source).toBe('ANTIGRAVITY_NATIVE_HOOK')
  expect(pre.tool).toBe('SHELL'); expect(post.tool).toBe('MCP'); expect(stepFallback.tool).toBe('OTHER')
  expect(pre.sessionId).toBe(post.sessionId); expect(pre.invocationId).toBe(post.invocationId)
  expect(pre.turnId).toBe(preInv.turnId); expect(postInv.turnId).toBe(preInv.turnId)
  expect(stepFallback.invocationId).toBeDefined()
  for (const item of [start, preInv, pre, post, postInv, stop]) {
    expect(item.git).toBeUndefined(); expect(item.artifact).toBeUndefined()
    expect(parseNativeEnvelope(JSON.stringify(item))).toEqual(item)
    expect(JSON.stringify(item)).not.toContain(secret)
    expect(JSON.stringify(item)).not.toContain('transcript.jsonl')
    expect(JSON.stringify(item)).not.toContain(f.root)
  }

  const codex = normalizeNativeHook({ session_id: 'conv-1', cwd: f.root, hook_event_name: 'SessionStart' }, { ...f.binding, provider: 'codex' })
  expect(codex.sessionId).not.toBe(start.sessionId)
  expect(nativeSessionEntityId(start, start.sessionId)).toBe('antigravity-native:' + start.sessionId)
  expect(nativeSessionEntityId(codex, codex.sessionId)).toBe('codex-native:' + codex.sessionId)

  const secondRoot = mkdtempSync(join(tmpdir(), 'ag-other-')); directories.push(secondRoot)
  mkdirSync(join(secondRoot, '.git')); writeFileSync(join(secondRoot, '.git', 'HEAD'), 'ref: refs/heads/test\n')
  expect(() => normalizeNativeHook({ ...f.payload, workspacePaths: [f.root, secondRoot] }, f.binding)).toThrow('WORKTREE_SCOPE_AMBIGUOUS')
  expect(() => normalizeNativeHook({ ...f.payload, cwd: secondRoot }, f.binding)).toThrow('WORKTREE_MISMATCH')
})

test('Antigravity native-hook-command emits allow/empty JSON on stdout and fails open safely', () => {
  const f = antigravityFixture(), bindingPath = join(f.root, 'binding.json')
  writeFileSync(bindingPath, JSON.stringify(f.binding))
  const bundle = join(f.root, 'command.cjs')
  const built = buildSync({ entryPoints: ['src/main/session-context/native-hook-command.ts'], outfile: bundle, write: false, bundle: true, platform: 'node', target: 'node20', format: 'cjs' }).outputFiles[0].text
  writeFileSync(bundle, built)

  expect(execFileSync(process.execPath, [bundle, bindingPath], { input: JSON.stringify(f.payload), encoding: 'utf8', timeout: 3000 })).toBe('{"decision":"allow"}\n')
  for (const hookEventName of ['SessionStart', 'PreInvocation', 'PostToolUse', 'PostInvocation', 'Stop']) {
    const payload = { conversationId: 'conv-1', workspacePaths: [f.root], hookEventName, ...(hookEventName === 'PostToolUse' ? { toolCall: { id: 'toolu_01', name: 'read_file' } } : {}) }
    expect(execFileSync(process.execPath, [bundle, bindingPath], { input: JSON.stringify(payload), encoding: 'utf8', timeout: 3000 })).toBe('{}\n')
  }
  expect(execFileSync(process.execPath, [bundle, bindingPath], { input: '{', encoding: 'utf8', timeout: 3000 })).toBe('{}\n')
  expect(readdirSync(f.spool).some(name => name.startsWith('gap-'))).toBe(true)

  writeFileSync(bindingPath, JSON.stringify({ ...f.binding, enabled: false }))
  const beforeCount = readdirSync(f.spool).length
  expect(execFileSync(process.execPath, [bundle, bindingPath], { input: JSON.stringify(f.payload), encoding: 'utf8', timeout: 3000 })).toBe('{"decision":"allow"}\n')
  expect(readdirSync(f.spool).length).toBe(beforeCount)
}, 30000)

test('Antigravity provisions .agents/hooks.json, executes via Windows cmd when on win32, and preserves third-party hooks', () => {
  const f = antigravityFixture()
  const commandContent = buildSync({ entryPoints: ['src/main/session-context/native-hook-command.ts'], outfile: join(f.root, 'out/session-context/native-hook.cjs'), write: false, bundle: true, platform: 'node', target: 'node20', format: 'cjs' }).outputFiles[0].text
  const commandPath = join(f.root, 'out/session-context', 'native-hook-' + nativeDigest(commandContent) + '.cjs')
  const configPath = join(f.root, '.agents/hooks.json')
  mkdirSync(join(f.root, '.agents'), { recursive: true })
  const before = JSON.stringify({ 'lint-checker': { enabled: true, PostToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: './scripts/lint.sh', timeout: 10 }] }] } }, null, 2) + '\n'
  writeFileSync(configPath, before)
  const record = { path: f.root, worktreeId: f.binding.worktreeId, generation: f.binding.generation, branch: 'test', head: 'a'.repeat(40), detached: false, locked: false, missing: false, prunable: false }

  expect(() => installNativeHooks({ repositoryId: 'repository', record, commandPath, commandContent, nodePath: process.execPath, provider: 'antigravity', authorized: false })).toThrow('HOOK_AUTHORIZATION_REQUIRED')
  expect(readFileSync(configPath, 'utf8')).toBe(before)

  expect(installNativeHooks({ repositoryId: 'repository', record, commandPath, commandContent, nodePath: process.execPath, provider: 'antigravity', authorized: true })).toMatchObject({ state: 'CONFIGURED', capture: 'UNOBSERVED', trust: 'REVIEW_REQUIRED' })
  expect(inspectNativeInstallation(f.root, { repositoryId: 'repository', ...record }, process.platform, 'antigravity')).toMatchObject({ state: 'CONFIGURED', reasonCode: 'INSTALLATION_VERIFIED', installed: 6, expected: 6 })
  expect(installNativeHooks({ repositoryId: 'repository', record, commandPath, commandContent, nodePath: process.execPath, provider: 'antigravity', authorized: true })).toMatchObject({ state: 'NO_CHANGE', trust: 'UNCHANGED' })

  const composed = JSON.parse(readFileSync(configPath, 'utf8'))
  expect(composed['lint-checker']).toEqual(JSON.parse(before)['lint-checker'])
  expect(composed['code-awareness-session-context'].PreToolUse[0].matcher).toBe('*')
  expect(composeNativeHooks(composeNativeHooks(before, 'cmd', undefined, 'antigravity'), 'cmd', undefined, 'antigravity')).toBe(composeNativeHooks(before, 'cmd', undefined, 'antigravity'))

  if (process.platform === 'win32') {
    const preCmd = composed['code-awareness-session-context'].PreToolUse[0].hooks[0].command
    expect(preCmd).not.toContain('"')
    const res = spawnSync('cmd.exe', ['/c', preCmd], { input: JSON.stringify(f.payload), encoding: 'utf8', timeout: 5000 })
    expect(res.status).toBe(0)
    expect(res.stdout).toBe('{"decision":"allow"}\n')
  }

  expect(disableNativeHooks(f.root, true, 'antigravity')).toEqual({ state: 'DISABLED', restored: true })
  expect(readFileSync(configPath, 'utf8')).toBe(before)
}, 30000)

test('attaches verifiable active execution ref only on exact active checkout/generation and rejects forged Antigravity envelopes without managed producerWitness', () => {
  const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite')
  const f = antigravityFixture()
  const profile = mkdtempSync(join(tmpdir(), 'ag-u3-profile-')); directories.push(profile)
  const dbDir = join(profile, 'continuum', 'repositories', Buffer.from(f.binding.repositoryId).toString('base64url'))
  mkdirSync(dbDir, { recursive: true })
  const db = new DatabaseSync(join(dbDir, 'continuum.db'))
  db.exec(`CREATE TABLE execution_activations(activation_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, repository_id TEXT NOT NULL, worktree_id TEXT NOT NULL, worktree_generation TEXT NOT NULL, branch_ref TEXT NOT NULL, branch_generation TEXT NOT NULL, execution_id TEXT NOT NULL, plan_artifact_id TEXT NOT NULL, plan_revision INTEGER NOT NULL, plan_content_hash TEXT NOT NULL, binding_artifact_id TEXT NOT NULL, binding_revision INTEGER NOT NULL, binding_content_hash TEXT NOT NULL, scope_kind TEXT NOT NULL, status TEXT NOT NULL, activated_at TEXT NOT NULL, updated_at TEXT NOT NULL, revoked_at TEXT, revoked_reason TEXT)`)
  const planId = 'artifact-11111111-1111-4111-8111-111111111111'
  const bindId = 'artifact-execution-branch-' + 'a'.repeat(64)
  db.prepare(`INSERT INTO execution_activations VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'act-1', 1, f.binding.repositoryId, f.binding.worktreeId, f.binding.generation,
    'refs/heads/test', '3'.repeat(64), 'exec-u3-1', planId, 1, '4'.repeat(64), bindId, 1, '5'.repeat(64),
    'CHECKOUT', 'ACTIVE', '2026-11-20T00:00:00Z', '2026-11-20T00:00:00Z', null, null
  )

  const checkoutObserved = readActiveHookActivation(profile, f.binding, {})!
  expect(checkoutObserved).toMatchObject({ activationId: 'act-1', revision: 1, executionId: 'exec-u3-1', scope: 'CHECKOUT_OBSERVED' })
  expect(checkoutObserved.parentSessionId).toBeUndefined()

  const parentSessionId = nativeDigest('parent-session')
  const delegated = readActiveHookActivation(profile, f.binding, {
    CODE_AWARENESS_PARENT_SESSION_ID: parentSessionId,
    CODE_AWARENESS_DELIVERY_CONTEXT: JSON.stringify({ executionId: 'exec-u3-1', planArtifactId: planId, planRevision: 1, bindingArtifactId: bindId, bindingRevision: 1 })
  })!
  expect(delegated).toMatchObject({ scope: 'DELEGATED', parentSessionId })

  expect(readActiveHookActivation(profile, { ...f.binding, generation: '9'.repeat(64) }, {})).toBeUndefined()
  db.prepare(`UPDATE execution_activations SET status='REVOKED' WHERE activation_id='act-1'`).run()
  expect(readActiveHookActivation(profile, f.binding, {})).toBeUndefined()
  db.close()

  const envWithActivation = normalizeNativeHook({ conversationId: 'conv-u3', workspacePaths: [f.root], hookEventName: 'SessionStart' }, f.binding, new Date(), { activation: checkoutObserved })
  expect(parseNativeEnvelope(JSON.stringify(envWithActivation)).activation).toEqual(checkoutObserved)
  const forged = { ...envWithActivation, git: { operationId: 'op-1', fingerprint: 'a'.repeat(64), expectedHead: null } }
  expect(() => parseNativeEnvelope(JSON.stringify(forged))).toThrow(/INVALID_ENVELOPE|ENVELOPE_INTEGRITY/)
  const batch = nativeObservationBatch(envWithActivation)
  expect(batch.edges).toEqual(expect.arrayContaining([
    expect.objectContaining({ relation: 'observed-in-execution', evidenceKind: 'EXECUTION_CONTEXT_OBSERVED', to: { kind: 'EXECUTION', id: 'exec-u3-1' } })
  ]))
}, 30000)

test('U1: admits into free slots past 8-hash-bucket collisions, isolates corrupt/gap files, deduplicates replay and distinguishes PROBE_BUDGET from true SPOOL_FULL', async () => {
  const f = fixture()
  const target = normalizeNativeHook(f.payload, f.binding)
  const primary = parseInt(target.eventId.slice(0, 8), 16) % nativeHookLimits.slots
  for (let offset = 0; offset < 8; offset++) {
    const blocker = normalizeNativeHook({ ...f.payload, tool_use_id: `blocker-${offset}` }, f.binding)
    const idx = (primary + offset) % nativeHookLimits.slots
    writeFileSync(join(f.spool, `${idx}.json`), offset === 0 ? '{corrupt-do-not-overwrite' : JSON.stringify(blocker))
  }
  recordNativeGap(f.spool, 'SPOOL_FULL', 'WRITE', 'PreToolUse')

  const fallback = spoolNativeHookWithDetail(target, f.spool)
  expect(fallback).toMatchObject({ outcome: 'WRITTEN', fallbackUsed: true, relocated: true })
  expect(readFileSync(join(f.spool, `${primary}.json`), 'utf8')).toBe('{corrupt-do-not-overwrite')
  const relSlot = readdirSync(f.spool).find(name => {
    if (!/^\d+\.json$/.test(name)) return false
    const idx = Number(name.slice(0, -5))
    const dist = (idx - primary + nativeHookLimits.slots) % nativeHookLimits.slots
    return dist >= 8 && readFileSync(join(f.spool, name), 'utf8').includes(target.eventId)
  })
  expect(relSlot).toBeDefined()
  expect(spoolNativeHook(target, f.spool)).toBe('DUPLICATE')
  expect(readdirSync(f.spool).filter(n => n.startsWith('gap-'))).toHaveLength(1)

  const budgeted = normalizeNativeHook({ ...f.payload, tool_use_id: 'call-budget' }, f.binding)
  const budgetPrimary = parseInt(budgeted.eventId.slice(0, 8), 16) % nativeHookLimits.slots
  for (let offset = 0; offset < 8; offset++) {
    const blocker = normalizeNativeHook({ ...f.payload, tool_use_id: `b-blocker-${offset}` }, f.binding)
    writeFileSync(join(f.spool, `${(budgetPrimary + offset) % nativeHookLimits.slots}.json`), JSON.stringify(blocker))
  }
  expect(spoolNativeHook(budgeted, f.spool, { maxFallbackProbes: 0 })).toBe('PROBE_BUDGET')

  const concurrent = [
    normalizeNativeHook({ ...f.payload, tool_use_id: 'race-a' }, f.binding),
    normalizeNativeHook({ ...f.payload, tool_use_id: 'race-b' }, f.binding)
  ]
  const raceOutcomes = await Promise.all(concurrent.map(ev => Promise.resolve().then(() => spoolNativeHook(ev, f.spool))))
  expect(raceOutcomes).toEqual(['WRITTEN', 'WRITTEN'])
  expect(spoolNativeHook(concurrent[0], f.spool)).toBe('DUPLICATE')

  const env0 = normalizeNativeHook(f.payload, f.binding)
  for (let i = 0; i < nativeHookLimits.slots; i++) {
    writeFileSync(join(f.spool, `${i}.json`), JSON.stringify(env0))
  }
  const overflowing = normalizeNativeHook({ ...f.payload, tool_use_id: 'truly-full' }, f.binding)
  expect(spoolNativeHook(overflowing, f.spool)).toBe('FULL')
}, 30000)

test('U2/U3: emits protocol-compliant JSON across all 6 Antigravity events, fails open cleanly, and ignores forged env/payload witness', () => {
  const f = antigravityFixture()
  const command = join(process.cwd(), 'out/session-context/native-hook.cjs')
  const bindingFile = join(f.root, '.code-awareness/native-hooks/antigravity/binding.json')
  mkdirSync(dirname(bindingFile), { recursive: true })
  writeFileSync(bindingFile, JSON.stringify(f.binding))

  const cases: Array<{ event: string; payload: Record<string, unknown>; expectedStdout: string }> = [
    { event: 'SessionStart', payload: { conversationId: 'conv-u2', workspacePaths: [f.root], hookEventName: 'SessionStart' }, expectedStdout: '{}\n' },
    { event: 'PreToolUse', payload: { conversationId: 'conv-u2', workspacePaths: [f.root], hookEventName: 'PreToolUse', toolCall: { id: 'tc-1', name: 'run_command', args: { CommandLine: 'git commit -m fake' } } }, expectedStdout: '{"decision":"allow"}\n' },
    { event: 'PostToolUse', payload: { conversationId: 'conv-u2', workspacePaths: [f.root], hookEventName: 'PostToolUse', toolCall: { id: 'tc-1', name: 'run_command', args: { CommandLine: 'git commit -m fake' } } }, expectedStdout: '{}\n' },
    { event: 'PreInvocation', payload: { conversationId: 'conv-u2', workspacePaths: [f.root], hookEventName: 'PreInvocation' }, expectedStdout: '{}\n' },
    { event: 'PostInvocation', payload: { conversationId: 'conv-u2', workspacePaths: [f.root], hookEventName: 'PostInvocation' }, expectedStdout: '{}\n' },
    { event: 'Stop', payload: { conversationId: 'conv-u2', workspacePaths: [f.root], hookEventName: 'Stop' }, expectedStdout: '{}\n' }
  ]

  for (const item of cases) {
    const res = spawnSync(process.execPath, [command, bindingFile], {
      cwd: f.root,
      input: JSON.stringify(item.payload),
      env: { ...process.env, CODE_AWARENESS_SESSION_WITNESS: JSON.stringify({ provider: 'antigravity', sessionId: 'conv-u2', invocationId: 'tc-1' }) },
      encoding: 'utf8',
      timeout: 5000
    })
    expect(res.status).toBe(0)
    expect(res.stdout).toBe(item.expectedStdout)
    expect(res.stdout).not.toMatch(/auto_approve|overwrite|permissionOverrides/)
  }

  const spooled = readdirSync(f.spool).filter(n => /^\d+\.json$/.test(n)).map(n => parseNativeEnvelope(readFileSync(join(f.spool, n), 'utf8')))
  expect(spooled).toHaveLength(6)
  expect(spooled.every(ev => ev.producerWitness === undefined && ev.git === undefined && ev.artifact === undefined)).toBe(true)

  for (const badInput of ['{', 'x'.repeat(nativeHookLimits.inputBytes + 1)]) {
    const res = spawnSync(process.execPath, [command, bindingFile, '--event=PreToolUse'], { cwd: f.root, input: badInput, encoding: 'utf8', timeout: 5000 })
    expect(res.status).toBe(0)
    expect(res.stdout).toBe('{"decision":"allow"}\n')
  }
  writeFileSync(bindingFile, JSON.stringify({ ...f.binding, enabled: false }))
  const disabledRes = spawnSync(process.execPath, [command, bindingFile], { cwd: f.root, input: JSON.stringify(cases[1].payload), encoding: 'utf8', timeout: 5000 })
  expect(disabledRes.status).toBe(0)
  expect(disabledRes.stdout).toBe('{"decision":"allow"}\n')
}, 30000)
