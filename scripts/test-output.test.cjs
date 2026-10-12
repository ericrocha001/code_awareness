const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { run, project, inspect, observe, limits } = require('./test-output.cjs')

test('noisy success preserves bytes, reduces presentation by at least 80%, and never invents counts', async () => {
  const receipt = await run(process.execPath, ['-e', "process.stdout.write('noise '.repeat(50000));process.stderr.write('last error stream\\n')"])
  const full = fs.readFileSync(path.join(receipt.directory, 'stdout.log'))
  const summary = project(receipt)
  assert.equal(full.length, 300000)
  assert.equal(receipt.state, 'PASS')
  assert.equal(receipt.exitCode, 0)
  assert.equal(receipt.counts, undefined)
  assert.ok(Buffer.byteLength(summary) <= limits.success)
  assert.ok(Buffer.byteLength(summary) / full.length < 0.2)
  console.log(JSON.stringify({ measurement: 'UTF-8 bytes', raw: full.length, presented: Buffer.byteLength(summary), reduction: 1 - Buffer.byteLength(summary) / full.length }))
})

test('native failure preserves stack, causal test, exit and selective expansion', async () => {
  const receipt = await run(process.execPath, ['-e', "process.stdout.write('noise '.repeat(50000));console.error('FAIL causal test');console.error('FAIL causal test');throw new Error('native failure detail')"])
  assert.equal(receipt.state, 'FAIL')
  assert.equal(receipt.exitCode, 1)
  assert.match(receipt.diagnostic, /native failure detail/)
  assert.match(receipt.diagnostic, /FAIL causal test/)
  assert.equal(receipt.diagnostic.split('\n').filter(line => line === 'FAIL causal test').length, 1)
  assert.ok(Buffer.byteLength(project(receipt)) <= limits.failure)
  const full = fs.statSync(path.join(receipt.directory, 'stdout.log')).size + fs.statSync(path.join(receipt.directory, 'stderr.log')).size
  assert.ok(Buffer.byteLength(project(receipt)) / full < 0.2)
  console.log(JSON.stringify({ measurement: 'failure UTF-8 bytes', raw: full, presented: Buffer.byteLength(project(receipt)), reduction: 1 - Buffer.byteLength(project(receipt)) / full }))
  const expanded = await inspect(receipt.id, { pattern: 'native failure detail' })
  assert.ok(expanded.matches.some(line => line.includes('Error: native failure detail')))
  assert.match(fs.readFileSync(path.join(receipt.directory, 'stderr.log'), 'utf8'), /at /)
})

test('concurrent executions have separate logs and observation binds exact identity', async () => {
  const receipts = await Promise.all(['one', 'two'].map(marker => run(process.execPath, ['-e', `console.log('${marker}')`])))
  assert.notEqual(receipts[0].id, receipts[1].id)
  receipts.forEach((receipt, i) => assert.equal(fs.readFileSync(path.join(receipt.directory, 'stdout.log'), 'utf8').trim(), ['one', 'two'][i]))
  assert.equal(await observe(receipts[0].id, { afterState: 'PASS' }), null)
  assert.equal((await observe(receipts[1].id)).id, receipts[1].id)
})

test('long quiet process emits no snapshots; event observation waits for terminal failure', async () => {
  const pending = run(process.execPath, ['-e', "setTimeout(()=>{console.error('Error: delayed failure');process.exit(7)},700)"])
  const root = path.resolve(__dirname, '../.code-awareness/test-output')
  const current = fs.readdirSync(root).map(id => {
    try { return JSON.parse(fs.readFileSync(path.join(root, id, 'receipt.json'), 'utf8')) } catch { return null }
  }).find(receipt => receipt?.state === 'RUNNING' && receipt.command.join(' ').includes('delayed failure'))
  assert.ok(current)
  const observed = observe(current.id)
  const [receipt, transition] = await Promise.all([pending, observed])
  assert.equal(transition.id, receipt.id)
  assert.equal(transition.exitCode, 7)
  assert.equal(transition.state, 'FAIL')
  assert.equal(await observe(receipt.id, { afterState: 'FAIL' }), null)
})

test('launch, timeout and cancellation never become success', async () => {
  const launch = await run(path.join(__dirname, 'missing-executable'), [])
  assert.equal(launch.state, 'LAUNCH_ERROR')
  const timeout = await run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 80 })
  assert.equal(timeout.state, 'TIMEOUT')
  const controller = new AbortController()
  const pending = run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal })
  controller.abort()
  const cancelled = await pending
  assert.equal(cancelled.state, 'CANCELLED')
})

test('flaky first attempt is not retried; a new hypothesis gets a new receipt', async () => {
  const first = await run(process.execPath, ['-e', 'process.exit(3)'])
  assert.equal(first.exitCode, 3)
  const hypothesis = await run(process.execPath, ['-e', "if(process.env.FIXTURE_READY!=='yes')process.exit(3)"], { env: { FIXTURE_READY: 'yes' } })
  assert.equal(hypothesis.state, 'PASS')
  assert.notEqual(first.id, hypothesis.id)
  assert.equal((await observe(first.id)).exitCode, 3)
})

test('escaped diagnostics remain a parseable bounded receipt', () => {
  const receipt = { id: 'fixture', command: ['node', '\\"'.repeat(200)], directory: __dirname, state: 'FAIL', exitCode: 2, durationMs: 1, diagnostic: '\\"\n'.repeat(5000) }
  const output = project(receipt)
  assert.equal(JSON.parse(output).exitCode, 2)
  assert.ok(Buffer.byteLength(output) <= limits.failure)
})

test('deadline terminates descendant processes and records verified tree cleanup', async () => {
  const receipt = await run(process.execPath, ['-e', "const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log('DESCENDANT='+c.pid);setInterval(()=>{},1000)"], { timeoutMs: 700 })
  assert.equal(receipt.state, 'TIMEOUT')
  assert.equal(receipt.cleanupWarning, undefined)
  const pid = Number(fs.readFileSync(path.join(receipt.directory, 'stdout.log'), 'utf8').match(/DESCENDANT=(\d+)/)[1])
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
})
