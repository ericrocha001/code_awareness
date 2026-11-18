const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawn, spawnSync } = require('node:child_process')
const { createServer } = require('node:net')
const { randomUUID } = require('node:crypto')
const fs = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const { build } = require('./build.cjs')
const { buildSync } = require('esbuild')
const root = join(__dirname, '../..')
const dir = fs.mkdtempSync(join(tmpdir(), 'ca-cli-u1-'))
const binary = build(true).executable
const productionBinary = build(false).executable
buildSync({ entryPoints: [join(root, 'src/main/cli-execution/cli-process-supervisor.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: join(dir, 'supervisor.cjs') })
const { CliProcessSupervisor } = require(join(dir, 'supervisor.cjs'))
async function until(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(predicate(), true)
}
function probeNative(pipeName, ...pids) {
  const res = spawnSync(binary, ['--probe', pipeName, ...pids.map(String)], { encoding: 'utf8', windowsHide: true })
  assert.equal(res.status, 1)
  return JSON.parse(res.stdout.trim())
}
function owner(launch, handle, executable = binary) {
  return new Promise((resolve, reject) => {
    const name = 'ca-cli-test-' + randomUUID(), events = [], server = createServer()
    let child, control, stdout = '', stderr = '', pending = ''
    const deadline = setTimeout(() => { child?.kill(); control?.destroy(); server.close(); reject(new Error('TEST_TIMEOUT')) }, 8000)
    server.on('connection', socket => {
      control = socket
      socket.setEncoding('utf8')
      socket.on('data', text => {
        pending += text
        let i
        while ((i = pending.indexOf('\n')) >= 0) {
          const value = JSON.parse(pending.slice(0, i)); pending = pending.slice(i + 1)
          events.push(value)
          if (value.phase === 'READY') socket.write(JSON.stringify(launch) + '\n')
          else handle(value, socket, events, child, () => stdout)
        }
      })
    })
    server.listen('\\\\.\\pipe\\' + name, () => {
      child = spawn(executable, [name], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout.on('data', bytes => { stdout += bytes })
      child.stderr.on('data', bytes => { stderr += bytes })
      child.on('error', reject)
      child.on('close', () => { clearTimeout(deadline); control?.destroy(); server.close(); resolve({ events, stdout, stderr }) })
    })
  })
}
test('Windows U1: Job creation/assignment failures execute zero target instructions', async () => {
  for (const fault of ['job', 'assignment']) {
    const sentinel = join(dir, fault)
    const result = await owner({ executable: process.execPath, cwd: dir, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(sentinel)},'unsafe')`], fault }, value => assert.equal(value.phase, 'TERMINAL'))
      .catch(error => { throw error })
    assert.equal(fs.existsSync(sentinel), false)
    assert.equal(result.events.some(e => e.phase === 'RUNNING'), false)
    assert.equal(result.events.at(-1).phase, 'TERMINAL')
  }
})
test('Windows U1: suspended owner contains three generations and terminal receipt proves empty job', async () => {
  const grand = 'setInterval(()=>{},1000)'
  const child = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grand)}],{stdio:'inherit'});setInterval(()=>{},1000)`
  const script = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'inherit'});setInterval(()=>{},1000)`
  let observedThree = false
  const result = await owner({ executable: process.execPath, cwd: dir, args: ['-e', script] }, (value, socket) => {
    if (value.phase === 'OWNED') { assert.equal(value.suspended, true); assert.equal(value.assignedAtCreation, true); socket.write('resume\n') }
    if (value.phase === 'OBSERVATION') {
      if (value.activeProcesses >= 3) observedThree = true
      setTimeout(() => socket.write(observedThree ? 'terminate\n' : 'inspect\n'), 25)
    }
  })
  assert.equal(observedThree, true)
  assert.deepEqual(result.events.at(-1), { phase: 'TERMINAL', version: 1, activeProcesses: 0, handlesClosed: true, exitCode: 1 })
})
test('Windows U1: missing helper fails before effects; segregated output capped; target exitCode preserved', async () => {
  const supervisor = new CliProcessSupervisor()
  const command = { executable: process.execPath, args: ['-e', 'process.stdout.write("x".repeat(10000));process.stderr.write("stderr");process.exitCode=7'], cwd: dir }
  await assert.rejects(supervisor.launch(command, { ownerPath: join(dir, 'missing.exe') }).then(res => { if (res.status === 'FAILED') throw new Error(res.diagnostic) }), /NATIVE_OWNER_UNAVAILABLE/)
  const result = await supervisor.launch(command, { ownerPath: build(false).executable, maxOutputBytes: 1024 })
  assert.equal(result.exitCode, 7)
  assert.equal(supervisor.output.readPage().stdout.length, 1024)
  assert.equal(supervisor.output.readPage().stderr, 'stderr')
  assert.equal(supervisor.output.isTruncated(), true)
  assert.equal(supervisor.isRunning, false)
})

test('Windows U1: packaged resource resolves offline and rejects tampering without invoking a compiler', () => {
  const selected = build(false)
  const resources = join(dir, 'resources'), target = join(resources, 'cli-execution')
  fs.mkdirSync(target, { recursive: true })
  fs.copyFileSync(selected.executable, join(target, 'cli-job-owner.exe'))
  fs.copyFileSync(selected.receipt, join(target, 'receipt.json'))
  buildSync({ entryPoints: [join(root, 'src/main/cli-execution/windows/cli-job-owner-locator.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: join(dir, 'locator.cjs') })
  const { locateCliJobOwner } = require(join(dir, 'locator.cjs'))
  const originalPath = process.env.PATH
  process.env.PATH = ''
  try {
    assert.equal(locateCliJobOwner(root, resources), join(target, 'cli-job-owner.exe'))
    fs.appendFileSync(join(target, 'cli-job-owner.exe'), 'tampered')
    assert.throws(() => locateCliJobOwner(root, resources), /NATIVE_OWNERSHIP_UNAVAILABLE_OR_INVALID/)
  } finally { process.env.PATH = originalPath }
})
test('Windows U1: killing owner closes job for all generations', async () => {
  const leaf = `console.log('PID:'+process.pid);setInterval(()=>{},1000)`
  const middle = `console.log('PID:'+process.pid);require('child_process').spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{stdio:'inherit'});setInterval(()=>{},1000)`
  const script = `console.log('PID:'+process.pid);require('child_process').spawn(process.execPath,['-e',${JSON.stringify(middle)}],{stdio:'inherit'});setInterval(()=>{},1000)`
  const result = await owner({ executable: process.execPath, cwd: dir, args: ['-e', script] }, (value, socket, events, process, output) => {
    if (value.phase === 'OWNED') socket.write('resume\n')
    if (value.phase === 'OBSERVATION') {
      if (value.activeProcesses >= 3 && [...output().matchAll(/PID:(\d+)/g)].length === 3) process.kill()
      else setTimeout(() => socket.write('inspect\n'), 20)
    }
  })
  const pids = [...result.stdout.matchAll(/PID:(\d+)/g)].map(m => Number(m[1]))
  assert.equal(pids.length, 3)
  await new Promise(resolve => setTimeout(resolve, 100))
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
})

test('Windows U2: timeout includes child and grandchild and releases slot only with empty-job receipt', async () => {
  const leaf = `console.log('PID:'+process.pid);setInterval(()=>{},1000)`
  const middle = `console.log('PID:'+process.pid);require('child_process').spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{stdio:'inherit'});setInterval(()=>{},1000)`
  const script = `console.log('PID:'+process.pid);require('child_process').spawn(process.execPath,['-e',${JSON.stringify(middle)}],{stdio:'inherit'});setInterval(()=>{},1000)`
  const supervisor = new CliProcessSupervisor(2500)
  const result = await supervisor.launch({ executable: process.execPath, args: ['-e', script], cwd: dir }, { ownerPath: productionBinary })
  assert.equal(result.status, 'TIMED_OUT')
  assert.deepEqual(result.treeObservation, { activeProcesses: 0, handlesClosed: true })
  const pids = [...supervisor.output.readPage().stdout.matchAll(/PID:(\d+)/g)].map(m => Number(m[1]))
  assert.equal(pids.length, 3)
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  assert.equal(supervisor.isRunning, false)
})

test('Windows U3-P1: pre-create handshake timeout releases slot only when owner exits with 204 pre-create proof', async () => {
  const sentinel = join(dir, 'precreate-must-not-run')
  const supervisor = new CliProcessSupervisor()
  let reconciled = null
  const result = await supervisor.launch(
    { executable: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(sentinel)}, 'unsafe')`, '--', '--ca-cli-test-fault=precreate-delay'], cwd: dir },
    { ownerPath: binary, handshakeTimeoutMs: 600, onTerminationConfirmed: r => { reconciled = r } }
  )
  assert.equal(result.status, 'FAILED')
  assert.equal(result.diagnostic, 'TERMINATION_UNCONFIRMED:NATIVE_HANDSHAKE_TIMEOUT')
  assert.equal(supervisor.phase, 'TERMINATION_UNCONFIRMED')
  assert.equal(supervisor.isRunning, true)
  assert.equal(supervisor.isAwaitingTerminationConfirmation, true)
  assert.throws(() => supervisor.launch({ executable: process.execPath, args: ['-v'], cwd: dir }, { ownerPath: binary }), /SUPERVISOR_BUSY/)
  await until(() => supervisor.phase === 'TERMINAL', 3000)
  assert.equal(supervisor.isRunning, false)
  assert.equal(supervisor.isAwaitingTerminationConfirmation, false)
  assert.deepEqual(reconciled, {
    status: 'FAILED',
    phase: 'TERMINAL',
    confirmationKind: 'PRE_CREATE_CONFIRMED',
    initialCause: 'NATIVE_HANDSHAKE_TIMEOUT',
    diagnostic: 'NATIVE_HANDSHAKE_TIMEOUT:RECOVERED_PRE_CREATE_CONFIRMED',
    durationMs: reconciled.durationMs,
    treeObservation: { activeProcesses: 0, handlesClosed: true }
  })
  assert.equal(fs.existsSync(sentinel), false)

  const unconfirmed = new CliProcessSupervisor()
  const badResult = await unconfirmed.launch(
    { executable: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(sentinel)}, 'unsafe')`, '--', '--ca-cli-test-fault=precreate-unconfirmed'], cwd: dir },
    { ownerPath: binary, handshakeTimeoutMs: 600 }
  )
  assert.equal(badResult.status, 'FAILED')
  assert.equal(unconfirmed.phase, 'TERMINATION_UNCONFIRMED')
  await new Promise(resolve => setTimeout(resolve, 600))
  assert.equal(unconfirmed.phase, 'TERMINATION_UNCONFIRMED')
  assert.equal(unconfirmed.isRunning, true)
  assert.equal(unconfirmed.isAwaitingTerminationConfirmation, false)
  assert.throws(() => unconfirmed.launch({ executable: process.execPath, args: ['-v'], cwd: dir }, { ownerPath: binary }), /SUPERVISOR_BUSY/)
  assert.equal(fs.existsSync(sentinel), false)
})

test('Windows U3-P2: pipe loss and dropped TERMINAL after process creation preserve FAILED and recover slot once via verified 205 proof + native probe', async () => {
  const leaf = `console.log('PID:'+process.pid);setInterval(()=>{},1000)`
  const middle = `console.log('PID:'+process.pid);require('child_process').spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{stdio:'inherit'});setInterval(()=>{},1000)`
  const script = `console.log('PID:'+process.pid);require('child_process').spawn(process.execPath,['-e',${JSON.stringify(middle)}],{stdio:'inherit'});setInterval(()=>{},1000)`
  const supervisor = new CliProcessSupervisor()
  let reconciled = null
  const completion = supervisor.launch(
    { executable: process.execPath, args: ['-e', script, '--', '--ca-cli-test-fault=postcreate-drain-delay'], cwd: dir },
    { ownerPath: binary, handshakeTimeoutMs: 2000, drainTimeoutMs: 100, onTerminationConfirmed: r => { reconciled = r } }
  )
  await until(() => supervisor.phase === 'RUNNING' && [...supervisor.output.readPage().stdout.matchAll(/PID:(\d+)/g)].length === 3)
  const pipeName = supervisor.activePipeName
  const pids = [...supervisor.output.readPage().stdout.matchAll(/PID:(\d+)/g)].map(m => Number(m[1]))
  const activeProbe = probeNative(pipeName, ...pids)
  assert.equal(activeProbe.jobPresent, true)
  assert.ok(activeProbe.activeProcesses >= 3)
  assert.equal(activeProbe.alivePids.length, 3)

  supervisor.control.destroy()
  const initialResult = await completion
  assert.equal(initialResult.status, 'FAILED')
  assert.equal(initialResult.exitCode, undefined)
  assert.equal(initialResult.diagnostic, 'TERMINATION_UNCONFIRMED:CONTROL_LOST')
  assert.equal(supervisor.phase, 'TERMINATION_UNCONFIRMED')
  assert.equal(supervisor.isRunning, true)
  assert.equal(supervisor.isAwaitingTerminationConfirmation, true)

  await until(() => supervisor.phase === 'TERMINAL', 3000)
  assert.equal(supervisor.isRunning, false)
  assert.equal(supervisor.status, 'FAILED')
  assert.equal(reconciled.status, 'FAILED')
  assert.equal(reconciled.confirmationKind, 'CLEANUP_CONFIRMED')
  assert.equal(reconciled.diagnostic, 'CONTROL_LOST:RECOVERED_CLEANUP_CONFIRMED')
  assert.deepEqual(reconciled.treeObservation, { activeProcesses: 0, handlesClosed: true })

  const drainedProbe = probeNative(pipeName, ...pids)
  assert.equal(drainedProbe.jobPresent, false)
  assert.deepEqual(drainedProbe.alivePids, [])

  const healthy = await supervisor.launch(
    { executable: process.execPath, args: ['-e', 'process.exit(9)'], cwd: dir },
    { ownerPath: productionBinary }
  )
  assert.equal(healthy.status, 'FAILED')
  assert.equal(healthy.exitCode, 9)
  assert.equal(supervisor.isRunning, false)

  const droppedSupervisor = new CliProcessSupervisor()
  const dropped = await droppedSupervisor.launch(
    { executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)', '--', '--ca-cli-test-fault=drop-terminal'], cwd: dir },
    { ownerPath: binary, timeoutMs: 300, drainTimeoutMs: 1000 }
  )
  assert.equal(dropped.status, 'FAILED')
  assert.equal(dropped.exitCode, undefined)
  assert.match(dropped.diagnostic, /^(CONTROL_LOST|OWNER_LOST):RECOVERED_CLEANUP_CONFIRMED$/)
  assert.deepEqual(dropped.treeObservation, { activeProcesses: 0, handlesClosed: true })
  assert.equal(droppedSupervisor.phase, 'TERMINAL')
  assert.equal(droppedSupervisor.isRunning, false)
})

test('Windows U3-P3: unconfirmed loss (killed owner, outdated helper, unknown exit, active job, handle close failure) retains quarantine', async () => {
  const killedSupervisor = new CliProcessSupervisor()
  const killedCompletion = killedSupervisor.launch(
    { executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd: dir },
    { ownerPath: binary }
  )
  await until(() => killedSupervisor.phase === 'RUNNING')
  const killedPipe = killedSupervisor.activePipeName
  killedSupervisor.owner.kill()
  const killedResult = await killedCompletion
  assert.equal(killedResult.status, 'FAILED')
  assert.match(killedResult.diagnostic, /^TERMINATION_UNCONFIRMED:/)
  assert.equal(killedSupervisor.phase, 'TERMINATION_UNCONFIRMED')
  assert.equal(killedSupervisor.isRunning, true)
  assert.equal(killedSupervisor.isAwaitingTerminationConfirmation, false)
  assert.throws(() => killedSupervisor.launch({ executable: process.execPath, args: ['-v'], cwd: dir }, { ownerPath: binary }), /SUPERVISOR_BUSY/)
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(probeNative(killedPipe).jobPresent, false)

  const outdatedDir = join(dir, 'outdated-helper')
  fs.mkdirSync(outdatedDir, { recursive: true })
  const outdatedExe = join(outdatedDir, 'cli-job-owner.exe')
  fs.copyFileSync(binary, outdatedExe)
  const outdatedReceipt = JSON.parse(fs.readFileSync(join(root, 'out/cli-execution/test/receipt.json'), 'utf8'))
  delete outdatedReceipt.contract
  fs.writeFileSync(join(outdatedDir, 'receipt.json'), JSON.stringify(outdatedReceipt, null, 2))
  const outdatedSupervisor = new CliProcessSupervisor()
  const outdatedCompletion = outdatedSupervisor.launch(
    { executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd: dir },
    { ownerPath: outdatedExe, drainTimeoutMs: 100 }
  )
  await until(() => outdatedSupervisor.phase === 'RUNNING')
  outdatedSupervisor.control.destroy()
  const outdatedResult = await outdatedCompletion
  assert.equal(outdatedResult.status, 'FAILED')
  assert.equal(outdatedSupervisor.phase, 'TERMINATION_UNCONFIRMED')
  assert.equal(outdatedSupervisor.isRunning, true)
  assert.equal(outdatedSupervisor.isAwaitingTerminationConfirmation, false)
  assert.throws(() => outdatedSupervisor.launch({ executable: process.execPath, args: ['-v'], cwd: dir }, { ownerPath: outdatedExe }), /SUPERVISOR_BUSY/)

  for (const fault of ['unknown-exit', 'active-job', 'handle-close']) {
    const faultSupervisor = new CliProcessSupervisor()
    const faultCompletion = faultSupervisor.launch(
      { executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)', '--', `--ca-cli-test-fault=${fault}`], cwd: dir },
      { ownerPath: binary, drainTimeoutMs: 100 }
    )
    await until(() => faultSupervisor.phase === 'RUNNING')
    faultSupervisor.control.destroy()
    const faultResult = await faultCompletion
    assert.equal(faultResult.status, 'FAILED')
    await new Promise(resolve => setTimeout(resolve, 250))
    assert.equal(faultSupervisor.phase, 'TERMINATION_UNCONFIRMED', `Expected quarantine for ${fault}`)
    assert.equal(faultSupervisor.isRunning, true, `Expected busy slot for ${fault}`)
    assert.equal(faultSupervisor.isAwaitingTerminationConfirmation, false)
    assert.throws(() => faultSupervisor.launch({ executable: process.execPath, args: ['-v'], cwd: dir }, { ownerPath: binary }), /SUPERVISOR_BUSY/)
  }
})
