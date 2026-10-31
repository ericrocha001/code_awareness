const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
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
buildSync({ entryPoints: [join(root, 'src/main/cli-execution/cli-process-supervisor.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: join(dir, 'supervisor.cjs') })
const { CliProcessSupervisor } = require(join(dir, 'supervisor.cjs'))
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
  const result = await supervisor.launch({ executable: process.execPath, args: ['-e', script], cwd: dir }, { ownerPath: build(false).executable })
  assert.equal(result.status, 'TIMED_OUT')
  assert.deepEqual(result.treeObservation, { activeProcesses: 0, handlesClosed: true })
  const pids = [...supervisor.output.readPage().stdout.matchAll(/PID:(\d+)/g)].map(m => Number(m[1]))
  assert.equal(pids.length, 3)
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  assert.equal(supervisor.isRunning, false)
})
