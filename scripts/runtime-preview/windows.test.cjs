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
assert.notEqual(production.owner, binaries.owner)
assert.equal(production.fingerprint, createHash('sha256').update(fs.readFileSync(production.owner)).digest('hex'))
assert.equal(binaries.fingerprint, createHash('sha256').update(fs.readFileSync(binaries.owner)).digest('hex'))
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
  const ownPort = Number(fs.readFileSync(path.join(a.directory, 'port.txt'), 'utf8')), foreignPort = Number(fs.readFileSync(path.join(b.directory, 'port.txt'), 'utf8'))
  const owned = await first.request('endpoint', { port: ownPort }), foreign = await first.request('endpoint', { port: foreignPort })
  assert.equal(owned.result.listeners.length, 1); assert.equal(owned.result.listeners[0].member, true)
  assert.equal(foreign.result.listeners.length, 1); assert.equal(foreign.result.listeners[0].member, false)
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
function fixtureRunner({ status = 'SUPPORTED', failGuard = false, mode = 'wait', electron = false } = {}) {
  const id = randomUUID(), directory = fs.mkdtempSync(path.join(root, 'd-')), worktree = fs.mkdtempSync(path.join(root, 'c-'))
  fs.writeFileSync(path.join(worktree, 'input'), 'controlled')
  const profile = { schemaVersion: 1, repositoryId: 'controlled-repository', profileId: id, revision: 1, command: { executable: binaries.fixture,
    executableHash: hash(fs.readFileSync(binaries.fixture)), args: [mode], cwd: '.', inputs: [{ path: 'input', fingerprint: hash('controlled') }] },
    env: {}, resources: [{ name: 'runtime', strategy: 'SESSION_DIRECTORY' }], security: { mode: 'profile_only', requirements: [] },
    shutdown: { spawn: 'JOB_LIST_AT_CREATE', breakaway: false, killOnJobClose: true, graceMs: 1000, forceMs: 2000, graceful: 'SESSION_EVENT' } }
  if (electron) {
    const script = `const {app,BrowserWindow}=require('electron');const fs=require('fs'),path=require('path'),root=process.env.PREVIEW_SESSION_DIRECTORY;for(const key of ['appData','userData','sessionData','home','temp']){const p=path.join(root,key);fs.mkdirSync(p,{recursive:true});app.setPath(key,p)}app.setName('controlled-preview-exit');app.enableSandbox();app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});await w.loadURL('data:text/html,<h1>Controlled termination acceptance</h1>');fs.writeFileSync(path.join(root,'electron.ready'),String(process.pid));setInterval(()=>{if(fs.existsSync(path.join(root,'exit-request')))app.exit(23)},50)});`
    fs.writeFileSync(path.join(worktree, 'electron.cjs'), script)
    profile.command.executable = require('electron'); profile.command.executableHash = hash(fs.readFileSync(profile.command.executable))
    profile.command.args = [path.join(worktree, 'electron.cjs')]
  }
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
  assert.equal(final.state, 'FAILED'); assert.equal(final.failure, 'UNEXPECTED_PROCESS_EXIT'); assert.equal(final.reconciliation, 'OBSERVED'); assert.equal(fixture.store.active(), undefined)
})
test('final receipt failure never returns STOPPED; native cleanup remains real and recoverable', async () => {
  const fixture = fixtureRunner(), started = await fixture.runner.start({ operationId: randomUUID(), selection: fixture.selection })
  const append = fixture.store.append.bind(fixture.store)
  fixture.store.append = record => { if (record.state === 'STOPPED') throw new Error('CONTROLLED_STORAGE_FAILURE'); append(record) }
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

test('launch cleanup failure stays structured; missing native launch receipt remains inconclusive', async () => {
  const fixture = fixtureRunner(), release = fixture.store.releaseResources.bind(fixture.store), prepare = fixture.authority.prepare.bind(fixture.authority)
  let checks = 0
  fixture.authority.prepare = async () => ({ ...await prepare(), guard: async () => { if (++checks === 2) throw new Error('GIT_STATE_CHANGED') } })
  fixture.store.releaseResources = () => { throw new Error('CONTROLLED_RESOURCE_LOCK') }
  const failed = await fixture.runner.start({ operationId: randomUUID(), selection: fixture.selection })
  assert.equal(failed.state, 'CLEANUP_INCOMPLETE'); assert.equal(failed.failure, 'RESOURCE_RELEASE_UNVERIFIED')
  assert.equal(failed.resources, 'UNVERIFIABLE'); assert.equal(fixture.store.active(), failed.sessionId)
  fixture.store.releaseResources = release
  const recovered = new RuntimePreviewRunner(fixture.store, fixture.authority, fixture.helper)
  const final = await recovered.inspect(failed.sessionId)
  assert.equal(final.state, 'OWNERSHIP_UNVERIFIED'); assert.equal(final.resources, 'UNVERIFIABLE'); assert.equal(fixture.store.active(), failed.sessionId)
})

test('recovery never reports STOPPED while runtime directories remain unresolved', async () => {
  const fixture = fixtureRunner(), started = await fixture.runner.start({ operationId: randomUUID(), selection: fixture.selection })
  const native = fixture.runner.owners.get(started.sessionId)
  await native.stop(1000, 2000, true); await native.shutdown()
  const release = fixture.store.releaseResources.bind(fixture.store)
  fixture.store.releaseResources = () => { throw new Error('CONTROLLED_RESOURCE_LOCK') }
  const recovered = new RuntimePreviewRunner(fixture.store, fixture.authority, fixture.helper)
  const incomplete = await recovered.inspect(started.sessionId)
  assert.equal(incomplete.state, 'CLEANUP_INCOMPLETE'); assert.equal(incomplete.failure, 'RESOURCE_RELEASE_UNVERIFIED')
  fixture.store.releaseResources = release
  assert.equal((await recovered.inspect(started.sessionId)).state, 'FAILED')
})

test('retired caller context after native creation drains the owned process before launch acknowledgement', async () => {
  const fixture = fixtureRunner(); let guards = 0
  const record = await fixture.runner.start({ operationId: randomUUID(), selection: fixture.selection, guard: () => { if (++guards === 3) throw new Error('PROJECT_CONTEXT_CHANGED') } })
  assert.equal(record.state, 'FAILED'); assert.equal(record.failure, 'PROJECT_CONTEXT_CHANGED')
  assert.equal(record.termination.kind, 'STARTUP_FAILURE'); assert.equal(record.termination.reasonCode, 'PROJECT_CONTEXT_CHANGED')
  assert.equal(record.resources, 'RELEASED'); assert.equal(record.process.activeProcesses, 0)
  assert.equal(record.process.rootSignaled, true); assert.equal(fixture.store.active(), undefined)
})

for (const code of [0, 37, 259]) test('unsolicited real Windows exit preserves literal code ' + code + ' through cleanup and recovery', async () => {
  const fixture = fixtureRunner({ mode: 'exit:' + code }), operationId = randomUUID()
  const started = await fixture.runner.start({ operationId, selection: fixture.selection })
  await until(async () => (await fixture.runner.inspect(started.sessionId)).state === 'FAILED')
  const failed = fixture.store.read(started.sessionId)
  assert.equal(failed.failure, 'UNEXPECTED_PROCESS_EXIT'); assert.equal(failed.resources, 'RELEASED')
  assert.equal(failed.stopIntent, undefined); assert.equal(failed.termination.kind, 'UNEXPECTED_EXIT')
  assert.equal(failed.termination.rootExit.code, code); assert.equal(failed.termination.rootExit.status, 'KNOWN')
  assert.equal(failed.termination.supervisor.status, 'RESPONDING')
  assert.equal(fs.existsSync(fixture.store.runtime(started.sessionId)), false)
  const journal = fixture.store.nativeJournal(started.sessionId)
  assert.equal(journal.find(e => e.phase === 'ROOT_EXITED').evidence.rootExit.code, code)
  const recovered = new RuntimePreviewRunner(new PreviewSessionStore(fixture.store.root), fixture.authority, fixture.helper)
  assert.deepEqual(await recovered.inspect(started.sessionId), failed)
  assert.deepEqual(await recovered.stop(started.sessionId), failed)
  assert.deepEqual(await recovered.start({ operationId, selection: fixture.selection }), failed)
})

test('a late STOP cannot convert an already exited root or its descendants into an operator stop', async () => {
  const fixture = fixtureRunner({ mode: 'orphan' }), started = await fixture.runner.start({ operationId: randomUUID(), selection: fixture.selection })
  await until(async () => (await fixture.runner.owners.get(started.sessionId).inspect()).rootSignaled)
  const result = await fixture.runner.stop(started.sessionId)
  assert.equal(result.state, 'FAILED'); assert.equal(result.termination.kind, 'UNEXPECTED_EXIT')
  assert.ok(result.termination.process.activeProcesses > 0); assert.equal(result.process.activeProcesses, 0)
  assert.equal(result.resources, 'RELEASED'); assert.equal(result.stopIntent, undefined)
})

test('durable stop intent and termination evidence precede native stop and directory deletion', async () => {
  const fixture = fixtureRunner(), started = await fixture.runner.start({ operationId: randomUUID(), selection: fixture.selection })
  const owner = fixture.runner.owners.get(started.sessionId), stop = owner.stop.bind(owner), release = fixture.store.releaseResources.bind(fixture.store)
  owner.stop = async (...args) => { assert.ok(new PreviewSessionStore(fixture.store.root).read(started.sessionId).stopIntent); return stop(...args) }
  fixture.store.releaseResources = id => { const record = new PreviewSessionStore(fixture.store.root).read(id); assert.equal(record.termination.kind, 'STOP_REQUESTED'); assert.equal(record.termination.rootExit.status, 'KNOWN'); assert.ok(record.termination.supervisorExit); release(id) }
  const result = await fixture.runner.stop(started.sessionId)
  assert.equal(result.state, 'STOPPED'); assert.equal(result.resources, 'RELEASED'); assert.equal(result.failure, null)
})

test('failed intent persistence never sends the native stop command', async () => {
  const fixture = fixtureRunner(), started = await fixture.runner.start({ operationId: randomUUID(), selection: fixture.selection })
  const owner = fixture.runner.owners.get(started.sessionId), append = fixture.store.append.bind(fixture.store), stop = owner.stop.bind(owner)
  let commands = 0; owner.stop = async (...args) => { commands++; return stop(...args) }
  fixture.store.append = () => { throw Error('CONTROLLED_STORAGE_FAILURE') }
  assert.equal((await fixture.runner.stop(started.sessionId)).state, 'CLEANUP_INCOMPLETE'); assert.equal(commands, 0)
  assert.ok((await owner.inspect()).activeProcesses > 0)
  fixture.store.append = append
  assert.equal((await fixture.runner.stop(started.sessionId)).state, 'STOPPED')
})

test('unexpected-exit diagnostic persistence failure prevents resource deletion until a safe retry', async () => {
  const fixture = fixtureRunner({ mode: 'exit:37' }), started = await fixture.runner.start({ operationId: randomUUID(), selection: fixture.selection })
  await until(async () => (await fixture.runner.owners.get(started.sessionId).inspect()).rootSignaled)
  const append = fixture.store.append.bind(fixture.store), release = fixture.store.releaseResources.bind(fixture.store)
  let deleted = false
  fixture.store.releaseResources = id => { deleted = true; release(id) }
  fixture.store.append = value => { if (value.termination) throw Error('CONTROLLED_DIAGNOSTIC_STORAGE_FAILURE'); append(value) }
  const incomplete = await fixture.runner.inspect(started.sessionId)
  assert.equal(incomplete.state, 'CLEANUP_INCOMPLETE'); assert.equal(deleted, false)
  assert.equal(fs.existsSync(fixture.store.runtime(started.sessionId)), true)
  fixture.store.append = append
  const final = await fixture.runner.inspect(started.sessionId)
  assert.equal(final.state, 'FAILED'); assert.equal(final.resources, 'RELEASED'); assert.equal(final.termination.rootExit.code, 37)
})

test('native unavailable exit status remains UNKNOWN rather than inferring a crash', async () => {
  const client = new Client(), spec = launch('exit:37', { fault: 'exit-code-unavailable' })
  assert.equal((await client.request('start', { launch: spec })).success, true)
  let observed
  await until(async () => { observed = await client.request('inspect'); return observed.result.rootSignaled })
  assert.equal(observed.result.rootExit.status, 'UNKNOWN'); assert.equal(observed.result.rootExit.code, null)
  assert.equal(observed.result.rootExit.reasonCode, 'EXIT_CODE_UNAVAILABLE')
  assertDrained(await stop(client)); await client.close()
})

for (const unexpected of [true, false]) test('real Electron under production Job owner: ' + (unexpected ? 'unrequested app exit' : 'explicit runner stop'), async () => {
  const fixture = fixtureRunner({ electron: true }), started = await fixture.runner.start({ operationId: randomUUID(), selection: fixture.selection })
  await until(() => fs.existsSync(path.join(fixture.store.runtime(started.sessionId), 'electron.ready')), 20000)
  const members = await fixture.runner.owners.get(started.sessionId).processes()
  assert.ok(members.processes.length >= 2, 'actual Chromium descendants required')
  let result
  if (unexpected) {
    fs.writeFileSync(path.join(fixture.store.runtime(started.sessionId), 'exit-request'), '')
    await until(async () => { result = await fixture.runner.inspect(started.sessionId); return result.state === 'FAILED' })
    assert.equal(result.termination.rootExit.code, 23); assert.equal(result.failure, 'UNEXPECTED_PROCESS_EXIT')
  } else { result = await fixture.runner.stop(started.sessionId); assert.equal(result.state, 'STOPPED'); assert.equal(result.termination.kind, 'STOP_REQUESTED') }
  assert.equal(result.resources, 'RELEASED'); assert.equal(result.process.activeProcesses, 0); assert.equal(result.process.knownHandlesClosed, true)
  assert.ok(result.termination.supervisorExit)
  assert.equal(process.kill(process.pid, 0), true)
  fs.writeFileSync(path.join(root, 'electron-' + unexpected + '.json'), JSON.stringify({ sessionId: result.sessionId, members, result }, null, 2))
})
