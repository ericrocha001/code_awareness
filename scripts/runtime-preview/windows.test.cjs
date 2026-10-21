const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { randomUUID, createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const { createInterface } = require('node:readline')
const { build } = require('./build.cjs')
if (process.platform !== 'win32') throw new Error('REAL_WINDOWS_REQUIRED')
const binaries = build(true)
const production = build(false)
const root = path.resolve('.code-awareness/engineering/runtime-preview-u2', randomUUID())
fs.mkdirSync(root, { recursive: true })
console.log(JSON.stringify({ evidenceRoot: root, platform: process.platform, windows: require('node:os').release(), node: process.version }))
const clients = new Set()
const runners = new Set()
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const hash = value => createHash('sha256').update(value).digest('hex')
async function until(fn, limit = 8000) {
  const end = Date.now() + limit
  while (Date.now() < end) { if (await fn()) return; await pause(25) }
  throw new Error('CONDITION_NOT_OBSERVED')
}
class Client {
  constructor(executable = binaries.owner) {
    this.child = spawn(executable, [], { stdio: 'pipe', windowsHide: true, env: { SystemRoot: process.env.SystemRoot } })
    this.pending = new Map(); this.id = 0
    this.closed = new Promise(resolve => this.child.once('close', resolve))
    createInterface({ input: this.child.stdout }).on('line', line => {
      const value = JSON.parse(line); const callback = this.pending.get(value.id)
      if (callback) { this.pending.delete(value.id); callback.resolve(value) }
    })
    this.child.stderr.resume()
    this.child.on('exit', () => { for (const pending of this.pending.values()) pending.reject(new Error('OWNER_LOST')); this.pending.clear() })
    this.child.on('error', error => { for (const pending of this.pending.values()) pending.reject(error) })
    clients.add(this)
  }
  request(action, fields = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('NATIVE_TIMEOUT')) }, 15000)
      this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value) }, reject: error => { clearTimeout(timer); reject(error) } })
      this.child.stdin.write(JSON.stringify({ id, action, ...fields }) + '\n')
    })
  }
  async close() { this.child.stdin.end(); await this.closed; clients.delete(this) }
}
function launch(mode = 'wait', extra = {}) {
  const id = randomUUID(), directory = path.join(root, id)
  fs.mkdirSync(directory)
  return { sessionId: id, operationId: randomUUID(), directory, slotKey: randomUUID(), executable: binaries.fixture, executableHash: hash(fs.readFileSync(binaries.fixture)), cwd: directory,
    args: [mode], spawn: 'JOB_LIST_AT_CREATE', graceful: 'SESSION_EVENT', graceMs: 2000, forceMs: 3000, hostPid: process.pid,
    env: { SystemRoot: process.env.SystemRoot, PREVIEW_SESSION_ID: id, PREVIEW_SESSION_DIRECTORY: directory }, ...extra }
}
const stop = (client, graceful = true, extra = {}) => client.request('stop', { graceMs: 2000, forceMs: 3000, graceful, ...extra })
function assertDrained(value) {
  assert.equal(value.success, true, JSON.stringify(value))
  assert.equal(value.result.activeProcesses, 0)
  assert.equal(value.result.knownHandlesClosed, true)
  assert.equal(value.result.jobClosed, true)
  assert.equal(value.result.eventClosed, true)
}
after(async () => {
  for (const { runner, store } of runners) {
    const id = store.active()
    if (id) await runner.stop(id)
  }
  await Promise.all([...clients].map(client => client.close()))
})

test('Windows at-create ownership, graceful shutdown and idempotent stop; production binary', async () => {
  const client = new Client(production.owner), spec = launch()
  const started = await client.request('start', { launch: spec })
  assert.equal(started.success, true, JSON.stringify(started)); assert.equal(started.result.assignedAtCreation, true)
  assert.equal(started.result.ownerOutsideJob, true)
  await until(() => fs.readdirSync(spec.directory).some(n => n.endsWith('.ready')))
  assertDrained(await stop(client)); assertDrained(await stop(client))
  assert.equal(process.kill(process.pid, 0), true)
  await client.close()
})
for (const mode of ['tree', 'orphan', 'nested', 'ignore', 'listener', 'breakaway']) test('real Windows process mode: ' + mode, async () => {
  const client = new Client(), spec = launch(mode)
  const started = await client.request('start', { launch: spec }); assert.equal(started.success, true, JSON.stringify(started))
  await until(() => fs.readdirSync(spec.directory).filter(n => n.endsWith('.ready')).length >= (['tree', 'orphan', 'nested'].includes(mode) ? 5 : 1))
  const observation = await client.request('inspect')
  assert.equal(observation.success, true)
  if (mode === 'orphan') { await until(async () => (await client.request('inspect')).result.rootSignaled); assert.ok(observation.result.activeProcesses >= 4) }
  if (mode === 'breakaway') assert.equal(fs.readFileSync(path.join(spec.directory, 'breakaway.txt'), 'utf8'), '5')
  let port
  if (mode === 'listener') port = Number(fs.readFileSync(path.join(spec.directory, 'port.txt'), 'utf8'))
  assertDrained(await stop(client, mode !== 'ignore'))
  if (port) await new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(port, '127.0.0.1', () => server.close(resolve)) })
  await client.close()
})
test('retained process handles prohibit drain; release makes independent evidence converge', async () => {
  const client = new Client(), spec = launch('wait', { fault: 'retain-reference' })
  assert.equal((await client.request('start', { launch: spec })).success, true)
  const incomplete = await stop(client, false, { forceMs: 100 })
  assert.equal(incomplete.result.rootSignaled, true); assert.equal(incomplete.result.knownHandlesClosed, false)
  assert.equal(incomplete.result.jobClosed, false)
  await client.request('release-reference'); assertDrained(await stop(client, false)); await client.close()
})
test('incomplete termination stays unresolved, external sibling and host survive', async () => {
  const first = new Client(), other = new Client(), a = launch('listener'), b = launch('listener')
  await first.request('start', { launch: a }); const sibling = await other.request('start', { launch: b }); assert.equal(sibling.success, true)
  await until(() => fs.existsSync(path.join(a.directory, 'port.txt')) && fs.existsSync(path.join(b.directory, 'port.txt')))
  const incomplete = await stop(first, false, { noTerminate: true })
  assert.ok(incomplete.result.activeProcesses > 0); assert.equal(incomplete.result.jobClosed, false)
  assertDrained(await stop(first, false))
  assert.ok((await other.request('inspect')).result.activeProcesses > 0)
  await new Promise((resolve, reject) => {
    const connection = net.createConnection({ host: '127.0.0.1', port: Number(fs.readFileSync(path.join(b.directory, 'port.txt'), 'utf8')) })
    connection.once('error', reject); connection.once('connect', () => { connection.destroy(); resolve() })
  })
  assert.equal(process.kill(process.pid, 0), true)
  assertDrained(await stop(other)); await first.close(); await other.close()
})
for (const fault of ['before-create', 'assignment-failure', 'after-create', 'receipt-after-create']) test('native launch failure: ' + fault, async () => {
  const client = new Client(), spec = launch('wait', { fault })
  const result = await client.request('start', { launch: spec })
  assert.equal(result.success, false)
  assert.ok(result.cleanup, JSON.stringify(result)); assert.equal(result.cleanup.activeProcesses, 0); assert.equal(result.cleanup.jobClosed, true)
  const journal = fs.readFileSync(path.join(spec.directory, 'native.jsonl'), 'utf8')
  if (fault === 'assignment-failure') assert.match(journal, /CREATE_REJECTED/)
  await client.close()
})
test('CreateProcess rejects a pinned non-executable image without a process', async () => {
  const file = path.join(root, 'invalid.exe'); fs.writeFileSync(file, 'not a Windows image')
  const client = new Client(), spec = launch('wait', { executable: file, executableHash: hash(fs.readFileSync(file)) })
  const result = await client.request('start', { launch: spec }); assert.equal(result.success, false); assert.equal(result.code, 'CREATE_PROCESS_FAILED'); assert.ok(result.win32 > 0)
  assert.match(fs.readFileSync(path.join(spec.directory, 'native.jsonl'), 'utf8'), /CREATE_REJECTED/)
  assert.equal(result.cleanup.activeProcesses, 0); await client.close()
})
test('durable receipt failure prevents CreateProcess', async () => {
  const client = new Client(), spec = launch()
  fs.mkdirSync(path.join(spec.directory, 'native.jsonl'))
  assert.equal((await client.request('start', { launch: spec })).success, false)
  assert.equal(fs.readdirSync(spec.directory).some(n => n.endsWith('.ready')), false)
  await client.close()
})
test('named Job collision and occupied native slot never terminate an existing session', async () => {
  const first = new Client(), collision = new Client(), busy = new Client(), spec = launch()
  assert.equal((await first.request('start', { launch: spec })).success, true)
  const collided = await collision.request('start', { launch: { ...launch(), sessionId: spec.sessionId } })
  assert.equal(collided.success, false); assert.equal(collided.win32, 183)
  assert.equal((await busy.request('start', { launch: launch('wait', { slotKey: spec.slotKey }) })).success, false)
  assert.ok((await first.request('inspect')).result.activeProcesses > 0)
  assertDrained(await stop(first)); await first.close(); await collision.close(); await busy.close()
})
for (const fault of ['crash-before-create', 'crash-before-create-receipt', 'running-owner-loss']) test('real supervisor loss: ' + fault, async () => {
  const client = new Client(), observer = new Client(), spec = launch('tree', fault.startsWith('crash-') ? { fault } : {})
  let started
  if (fault.startsWith('crash-')) await assert.rejects(client.request('start', { launch: spec }), /OWNER_LOST/)
  else {
    started = await client.request('start', { launch: spec }); assert.equal(started.success, true)
    await until(() => fs.readdirSync(spec.directory).filter(n => n.endsWith('.ready')).length === 5)
    client.child.kill(); await client.closed
  }
  const journal = fs.readFileSync(path.join(spec.directory, 'native.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(journal.at(-1).phase, fault === 'crash-before-create' ? 'PREPARED' : fault === 'crash-before-create-receipt' ? 'CREATE_REQUESTED' : 'RUNNING')
  await until(async () => {
    const result = await observer.request('reconcile', { sessionId: spec.sessionId, pid: started?.result.pid ?? 0, created: started?.result.created ?? null })
    return result.success && !result.result.jobPresent && result.result.sameProcessAlive !== true
  })
  for (const file of fs.readdirSync(spec.directory).filter(n => n.endsWith('.ready'))) {
    const pid = Number(file.split('.')[0]), created = fs.readFileSync(path.join(spec.directory, file), 'utf8')
    await until(async () => (await observer.request('reconcile', { sessionId: spec.sessionId, pid, created })).result.sameProcessAlive === false)
  }
  const result = await observer.request('reconcile', { sessionId: spec.sessionId, pid: process.pid, created: 'incorrect-creation' })
  assert.equal(result.result.sameProcessAlive, false); assert.equal(result.result.adopted, false); assert.equal(result.result.terminated, false)
  assert.equal(process.kill(process.pid, 0), true)
  await client.close(); await observer.close()
})

require('esbuild').buildSync({ entryPoints: ['src/main/work-orchestration/runtime-preview/runner.ts', 'src/main/work-orchestration/runtime-preview/session-store.ts'], outdir: path.join(root, 'bundle'), platform: 'node', format: 'cjs', bundle: true, logLevel: 'silent' })
const { RuntimePreviewRunner } = require(path.join(root, 'bundle/runner.js'))
const { PreviewSessionStore } = require(path.join(root, 'bundle/session-store.js'))
const fingerprint = value => hash(JSON.stringify(value))
function fixtureRunner({ status = 'SUPPORTED', failGuard = false } = {}) {
  const id = randomUUID(), directory = path.join(root, 'domain-' + id), worktree = path.join(root, 'checkout-' + id)
  fs.mkdirSync(worktree); fs.writeFileSync(path.join(worktree, 'input'), 'controlled')
  const profile = { schemaVersion: 1, repositoryId: 'controlled-repository', profileId: id, revision: 1, command: { executable: binaries.fixture,
    executableHash: hash(fs.readFileSync(binaries.fixture)), args: ['wait'], cwd: '.', inputs: [{ path: 'input', fingerprint: hash('controlled') }] },
    env: {}, resources: [{ name: 'runtime', strategy: 'SESSION_DIRECTORY' }], security: { mode: 'profile_only', requirements: [] },
    shutdown: { spawn: 'JOB_LIST_AT_CREATE', breakaway: false, killOnJobClose: true, graceMs: 1000, forceMs: 2000, graceful: 'SESSION_EVENT' } }
  const selection = { repositoryId: profile.repositoryId, profileId: id, worktreeId: id, generation: 'controlled-generation', fingerprint: fingerprint(profile) }
  const store = new PreviewSessionStore(directory), helper = { executable: production.owner, fingerprint: hash(fs.readFileSync(production.owner)) }
  const authority = { async prepare() { return { profile, worktree, gitFingerprint: 'controlled-fixture-identity', preflight: { status, selection, profileRevision: 1 }, guard: async () => { if (failGuard) throw new Error('GIT_STATE_CHANGED') } } } }
  const fixture = { runner: new RuntimePreviewRunner(store, authority, helper), store, profile, selection, authority, helper, worktree }
  runners.add(fixture)
  return fixture
}
test('typed runner: intent, one active slot, idempotent API, bounded receipt and actual native stop', async () => {
  const fixture = fixtureRunner(), input = { operationId: randomUUID(), selection: fixture.selection }
  const started = await fixture.runner.start(input); assert.equal(started.state, 'RUNNING')
  const replay = await fixture.runner.start(input); assert.equal(replay.sessionId, started.sessionId)
  await assert.rejects(fixture.runner.start({ ...input, operationId: randomUUID() }), /PREVIEW_SESSION_BUSY/)
  await assert.rejects(fixture.runner.start({ ...input, selection: { ...input.selection, generation: 'different' } }), /OPERATION_ID_CONFLICT/)
  assert.equal((await fixture.runner.list()).sessions.length, 1)
  const stopped = await fixture.runner.stop(started.sessionId); assert.equal(stopped.state, 'STOPPED'); assert.equal(stopped.resources, 'RELEASED')
  assert.equal((await fixture.runner.stop(started.sessionId)).revision, stopped.revision)
  assert.equal(fs.existsSync(fixture.store.runtime(started.sessionId)), false)
  assert.equal(stopped.readiness, 'NOT_OBSERVED'); assert.equal(stopped.attestation.loadedCode, 'NOT_OBSERVED')
  const bytes = fs.readdirSync(fixture.store.directory(started.sessionId)).filter(n => n.endsWith('.json')).map(n => fs.readFileSync(path.join(fixture.store.directory(started.sessionId), n), 'utf8')).join('')
  assert.doesNotMatch(bytes, /SystemRoot|executableHash|PREVIEW_SESSION_DIRECTORY/)
  const second = await fixture.runner.start({ ...input, operationId: randomUUID() })
  assert.equal(second.state, 'RUNNING'); assert.notEqual(second.sessionId, started.sessionId)
  assert.equal((await fixture.runner.stop(second.sessionId)).state, 'STOPPED')
  const page = await fixture.runner.list({ limit: 1 }); assert.equal(page.sessions.length, 1); assert.ok(page.nextCursor)
  const last = await fixture.runner.list({ limit: 1, cursor: page.nextCursor }); assert.equal(last.sessions.length, 1); assert.equal(last.nextCursor, null)
})
test('preflight UNKNOWN and changed identity block before reserving or launching', async () => {
  const invalid = fixtureRunner()
  await assert.rejects(invalid.runner.start({ operationId: '-'.repeat(36), selection: invalid.selection }), /INVALID_OPERATION_ID/)
  assert.equal(invalid.store.active(), undefined)
  for (const options of [{ status: 'UNKNOWN' }, { failGuard: true }]) {
    const fixture = fixtureRunner(options)
    await assert.rejects(fixture.runner.start({ operationId: randomUUID(), selection: fixture.selection }), /PREFLIGHT_UNKNOWN|GIT_STATE_CHANGED/)
    assert.equal(fixture.store.list().length, 0)
  }
  const fixture = fixtureRunner()
  await assert.rejects(fixture.runner.start({ operationId: randomUUID(), selection: { ...fixture.selection, repositoryId: 'wrong' } }), /LAUNCH_IDENTITY_MISMATCH/)
})
test('recovery does not adopt or kill live sessions; crash ambiguity retains slot', async () => {
  const fixture = fixtureRunner(), started = await fixture.runner.start({ operationId: randomUUID(), selection: fixture.selection })
  const recovered = new RuntimePreviewRunner(fixture.store, fixture.authority, fixture.helper)
  const unknown = await recovered.inspect(started.sessionId)
  assert.equal(unknown.state, 'OWNERSHIP_UNVERIFIED'); assert.equal(unknown.reconciliation, 'REQUIRED')
  assert.ok((await fixture.runner.inspect(started.sessionId)).process.activeProcesses > 0)
  await assert.rejects(recovered.start({ operationId: randomUUID(), selection: fixture.selection }), /PREVIEW_SESSION_BUSY/)
  assert.equal((await fixture.runner.stop(started.sessionId)).state, 'STOPPED')
})
test('immutable receipts reject tampering and occupied persistent reservation', async () => {
  const fixture = fixtureRunner(), started = await fixture.runner.start({ operationId: randomUUID(), selection: fixture.selection })
  assert.throws(() => fixture.store.append(started), /EEXIST/)
  const second = new RuntimePreviewRunner(new PreviewSessionStore(fixture.store.root), fixture.authority, fixture.helper)
  await assert.rejects(second.start({ operationId: randomUUID(), selection: fixture.selection }), /PREVIEW_SESSION_BUSY/)
  assert.equal((await fixture.runner.stop(started.sessionId)).state, 'STOPPED')
})
test('actual backend crash: EOF closes last owner handle; recovery preserves uncertain ownership', async () => {
  const fixture = fixtureRunner()
  const file = path.join(root, randomUUID() + '.json')
  const input = { operationId: randomUUID(), selection: fixture.selection }
  fs.writeFileSync(file, JSON.stringify({ profile: fixture.profile, worktree: fixture.worktree, store: fixture.store.root, helper: fixture.helper, input }))
  const child = spawn(process.execPath, [path.resolve('scripts/runtime-preview/crash-host.cjs'), path.join(root, 'bundle/runner.js'), path.join(root, 'bundle/session-store.js'), file], { stdio: 'pipe', windowsHide: true })
  let output = ''; child.stdout.on('data', bytes => { output += bytes }); child.stderr.resume()
  const code = await new Promise(resolve => child.once('exit', resolve)); assert.equal(code, 91)
  const { sessionId } = JSON.parse(output)
  const observation = new Client()
  const prior = fixture.store.read(sessionId)
  await until(async () => {
    const value = await observation.request('reconcile', { sessionId, pid: prior.process.pid, created: prior.process.created })
    return !value.result.jobPresent && value.result.sameProcessAlive === false
  })
  const recovered = await fixture.runner.inspect(sessionId)
  assert.equal(recovered.state, 'OWNERSHIP_UNVERIFIED'); assert.equal(recovered.resources, 'UNVERIFIABLE')
  assert.equal(recovered.recoveryObservation.adopted, false); assert.equal(recovered.recoveryObservation.terminated, false)
  assert.equal(fixture.store.active(), sessionId)
  await observation.close()
})
test('DRAINED recovery requires supervisor exit; no adoption of a live owner', async () => {
  const fixture = fixtureRunner(), started = await fixture.runner.start({ operationId: randomUUID(), selection: fixture.selection })
  const native = fixture.runner.owners.get(started.sessionId)
  assert.equal((await native.stop(1000, 2000, true)).jobClosed, true)
  const recovered = new RuntimePreviewRunner(fixture.store, fixture.authority, fixture.helper)
  assert.equal((await recovered.inspect(started.sessionId)).state, 'OWNERSHIP_UNVERIFIED')
  assert.equal(fixture.store.active(), started.sessionId)
  await native.shutdown()
  const final = await recovered.inspect(started.sessionId)
  assert.equal(final.state, 'STOPPED'); assert.equal(final.reconciliation, 'OBSERVED'); assert.equal(fixture.store.active(), undefined)
})
test('final receipt failure never returns STOPPED; native cleanup remains real and recoverable', async () => {
  const fixture = fixtureRunner(), started = await fixture.runner.start({ operationId: randomUUID(), selection: fixture.selection })
  const append = fixture.store.append.bind(fixture.store)
  fixture.store.append = () => { throw new Error('CONTROLLED_STORAGE_FAILURE') }
  const response = await fixture.runner.stop(started.sessionId)
  assert.equal(response.state, 'CLEANUP_INCOMPLETE'); assert.equal(response.persistence, 'UNVERIFIABLE')
  assert.equal(response.reconciliation, 'REQUIRED'); assert.equal(fixture.store.active(), started.sessionId)
  fixture.store.append = append
  const recovered = new RuntimePreviewRunner(fixture.store, fixture.authority, fixture.helper)
  const final = await recovered.inspect(started.sessionId)
  assert.equal(final.state, 'STOPPED'); assert.equal(final.process.activeProcesses, 0); assert.equal(final.resources, 'RELEASED')
})
test('simultaneous independent controllers cannot acquire two persistent active slots', async () => {
  const fixture = fixtureRunner()
  const other = new RuntimePreviewRunner(new PreviewSessionStore(fixture.store.root), fixture.authority, fixture.helper)
  const result = await Promise.allSettled([fixture.runner.start({ operationId: randomUUID(), selection: fixture.selection }), other.start({ operationId: randomUUID(), selection: fixture.selection })])
  assert.equal(result.filter(r => r.status === 'fulfilled' && r.value.state === 'RUNNING').length, 1)
  assert.equal(result.filter(r => r.status === 'rejected').length, 1)
  const winner = result[0].status === 'fulfilled' ? fixture.runner : other
  const id = fixture.store.active()
  assert.equal((await winner.stop(id)).state, 'STOPPED')
})
