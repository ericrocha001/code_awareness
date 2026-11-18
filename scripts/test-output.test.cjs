const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
delete process.env.CODE_AWARENESS_VALIDATION_EVIDENCE_FOR
delete process.env.CODE_AWARENESS_VALIDATION_KIND
const { run, runSequence, project, projectSequence, inspect, observe, limits } = require('./test-output.cjs')

test('noisy success preserves bytes, reduces presentation by at least 80%, and never invents counts', async () => {
  const receipt = await run(process.execPath, ['-e', "process.stdout.write('noise '.repeat(50000));process.stderr.write('last error stream\\n')"])
  const full = fs.readFileSync(path.join(receipt.directory, 'stdout.log'))
  const summary = project(receipt)
  assert.equal(full.length, 300000)
  assert.equal(receipt.state, 'PASS')
  assert.equal(receipt.exitCode, 0)
  assert.equal(receipt.counts, undefined)
  assert.equal(receipt.processState, 'PASS')
  assert.equal(receipt.validation.state, 'NOT_APPLICABLE')
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

test('test evidence distinguishes skipped, executed, unknown and failed summaries without losing logs', async () => {
  const cases = [
    ['Tests  3 skipped (3)', 'INSUFFICIENT'],
    ['Tests  0 passed (0)', 'INSUFFICIENT'],
    ['Tests  2 passed | 1 skipped | 1 todo (4)', 'SUFFICIENT'],
    ['Tests  2 failed (2)', 'FAILED'],
    ['Tests  unknown', 'UNKNOWN'],
    ['Tests  2 passed (3)', 'UNKNOWN'],
    ['Tests  1 passed | 1 passed (2)', 'UNKNOWN'],
    ['Test Files  2 passed (2)', 'UNKNOWN'],
    ['Tests  1 passed (1)\nTests  2 skipped (2)', 'INSUFFICIENT'],
    ['Tests  1 passed (1)\nTests  unknown', 'UNKNOWN'],
    ['no summary', 'UNKNOWN']
  ]
  for (const [output, expected] of cases) {
    const source = `const s=${JSON.stringify(output)};process.stdout.write(s.slice(0,3));setTimeout(()=>process.stdout.write(s.slice(3)),20)`
    const receipt = await run(process.execPath, ['-e', source], { expectTests: true, register: false })
    assert.equal(receipt.exitCode, 0)
    assert.equal(receipt.processState, 'PASS')
    assert.equal(receipt.validation.state, expected, output)
    assert.equal(receipt.state, expected === 'SUFFICIENT' ? 'PASS' : expected === 'FAILED' ? 'FAIL' : expected)
    assert.equal(fs.readFileSync(path.join(receipt.directory, 'stdout.log'), 'utf8'), output)
    assert.equal(JSON.parse(project(receipt)).validation.state, expected)
    assert.equal((await observe(receipt.id)).state, receipt.state)
    assert.equal(JSON.parse(fs.readFileSync(path.join(receipt.directory, 'receipt.json'), 'utf8')).validation.state, expected)
  }
})

test('Vitest summaries activate the evidence gate through composed commands', async () => {
  const receipt = await run(process.execPath, ['-e', "console.error('\\x1b[33mTests  1 skipped (1)\\x1b[0m')"])
  assert.equal(receipt.state, 'INSUFFICIENT')
  assert.equal(receipt.validation.state, 'INSUFFICIENT')
})

test('native Node TAP and spec reporters prove pass, failure, zero tests and unexecuted tests', async t => {
  const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'test-output-native-'))
  t.after(() => fs.rmSync(fixtures, { recursive: true, force: true }))
  const cases = [
    { name: 'pass', source: "test('passes', () => {})", state: 'PASS', validation: 'SUFFICIENT',
      processState: 'PASS', exitCode: 0, counts: [1, 0, 0, 0, 1, 1] },
    { name: 'fail', source: "test('fails', () => { throw new Error('fixture failure') })", state: 'FAIL',
      validation: 'FAILED', processState: 'FAIL', exitCode: 1, counts: [0, 1, 0, 0, 1, 1] },
    { name: 'zero', source: "test('filtered', () => {})", state: 'INSUFFICIENT', validation: 'INSUFFICIENT',
      processState: 'PASS', exitCode: 0, counts: [0, 0, 0, 0, 0, 0],
      flags: ['--test-isolation=none', '--test-name-pattern=never'] },
    { name: 'skip-todo', source: "test('skip', { skip: true }, () => {}); test('todo', { todo: true }, () => {})",
      state: 'INSUFFICIENT', validation: 'INSUFFICIENT', processState: 'PASS', exitCode: 0, counts: [0, 0, 1, 1, 2, 0],
      reporter: 'spec', flags: ['--test-reporter-destination=stderr'] },
    { name: 'no-summary', source: "test('passes without a summary', () => {})", state: 'UNKNOWN',
      validation: 'UNKNOWN', processState: 'PASS', exitCode: 0, reporter: 'dot' }
  ]
  for (const fixture of cases) {
    const file = path.join(fixtures, `${fixture.name}.cjs`)
    fs.writeFileSync(file, `const { test } = require('node:test'); ${fixture.source}`)
    const reporter = fixture.reporter || 'tap'
    const receipt = await run(process.execPath, [
      '--test', `--test-reporter=${reporter}`, ...(fixture.flags || []), file
    ], { env: { NODE_TEST_CONTEXT: undefined }, register: false })
    assert.equal(receipt.state, fixture.state, fixture.name)
    assert.equal(receipt.validation.state, fixture.validation, fixture.name)
    assert.equal(receipt.processState, fixture.processState)
    assert.equal(receipt.exitCode, fixture.exitCode)
    const compact = JSON.parse(project(receipt))
    assert.equal(compact.validation.state, fixture.validation)
    assert.equal(compact.state, fixture.state)
    assert.equal(compact.processState, fixture.processState)
    assert.equal(compact.exitCode, fixture.exitCode)
    if (fixture.counts) {
      const [passed, failed, skipped, todo, total, executed] = fixture.counts
      assert.deepEqual(receipt.validation.runs, [{ passed, failed, skipped, todo, total, executed }])
      assert.equal(compact.validation.executed, executed)
    }
    const stream = reporter === 'spec' ? 'stderr' : 'stdout'
    const log = fs.readFileSync(path.join(receipt.directory, `${stream}.log`), 'utf8')
    if (reporter === 'dot') assert.match(log, /\./)
    else assert.match(log, /duration_ms \d/)
    if (fixture.name === 'fail') assert.match(log, /fixture failure/)
    assert.equal(JSON.parse(fs.readFileSync(path.join(receipt.directory, 'receipt.json'), 'utf8')).digest, receipt.digest)
  }
})

test('native Node intent requires one complete, consistent summary on one stream', async t => {
  const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'test-output-summary-'))
  t.after(() => fs.rmSync(fixtures, { recursive: true, force: true }))
  const testFile = path.join(fixtures, 'pass.cjs')
  const reporter = path.join(fixtures, 'reporter.mjs')
  fs.writeFileSync(testFile, "require('node:test')('passes', () => {})")
  const summary = '# tests 1\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 1.5\n'
  const cases = [
    { name: 'fragmented lines with stderr noise', stdout: summary, stderr: 'erro diagnóstico\n', state: 'PASS' },
    { name: 'missing final line', stdout: summary.split('# duration_ms')[0] },
    { name: 'truncated final line', stdout: summary.slice(0, -1) },
    { name: 'duplicate count', stdout: summary.replace('# pass 1\n', '# pass 1\n# pass 1\n') },
    { name: 'two rounds', stdout: summary.repeat(2) },
    { name: 'inconsistent counts', stdout: summary.replace('# pass 1', '# pass 2') },
    { name: 'split across streams', stdout: summary.slice(0, 7), stderr: summary.slice(7) },
    { name: 'different reporter formats', stdout: summary.replace('# fail', 'ℹ fail') },
    { name: 'Vitest text cannot substitute for native summary', stdout: 'Tests  1 passed (1)\n' }
  ]
  for (const { name, stdout, stderr = '', state = 'UNKNOWN' } of cases) {
    fs.writeFileSync(reporter, `export default async function* (events) {
      for await (const event of events) {}
      const stderr = Buffer.from(${JSON.stringify(stderr)})
      process.stderr.write(stderr.subarray(0, 10))
      yield ${JSON.stringify(stdout.slice(0, 7))}
      await new Promise(resolve => setTimeout(resolve, 20))
      process.stderr.write(stderr.subarray(10))
      yield ${JSON.stringify(stdout.slice(7))}
    }`)
    const receipt = await run(process.execPath, ['--test=true', `--test-reporter=${pathToFileURL(reporter).href}`, testFile], {
      env: { NODE_TEST_CONTEXT: undefined },
      register: false
    })
    const validation = state === 'PASS' ? 'SUFFICIENT' : 'UNKNOWN'
    assert.equal(receipt.state, state, name)
    assert.equal(receipt.processState, 'PASS', name)
    assert.equal(receipt.exitCode, 0, name)
    assert.equal(receipt.validation.state, validation, name)
    assert.equal(JSON.parse(project(receipt)).validation.state, validation, name)
    assert.equal(fs.readFileSync(path.join(receipt.directory, 'stdout.log'), 'utf8'), stdout)
    assert.equal(fs.readFileSync(path.join(receipt.directory, 'stderr.log'), 'utf8'), stderr)
  }
})

test('a script argument named --test does not imply native Node test intent', async () => {
  const receipt = await run(process.execPath, ['-e', "console.log('test argument')", '--', '--test'])
  assert.equal(receipt.state, 'PASS')
  assert.equal(receipt.processState, 'PASS')
  assert.equal(receipt.exitCode, 0)
  assert.equal(receipt.validation.state, 'NOT_APPLICABLE')
})

test('CLI makes insufficient and unknown evidence nonzero while preserving process exit', () => {
  const { spawnSync } = require('node:child_process')
  for (const output of ['Tests  1 skipped (1)', 'unknown summary', 'Tests  1 passed (1)']) {
    const result = spawnSync(process.execPath, [path.join(__dirname, 'test-output.cjs'), 'run', '--expect-tests', '--', 'node', '-e', `console.log(${JSON.stringify(output)})`], { encoding: 'utf8', env: { ...process.env, CODE_AWARENESS_TEST_CAPTURE: '' } })
    assert.equal(result.status, output.includes('passed') ? 0 : 1, result.stderr)
    const receipt = JSON.parse(result.stdout)
    assert.equal(receipt.exitCode, 0)
    assert.equal(receipt.processState, 'PASS')
  }
})

test('direct Vitest invocation without summaries remains unknown', async () => {
  const directory = path.resolve(__dirname, '../.code-awareness/capability-proof')
  fs.mkdirSync(directory, { recursive: true })
  const fixture = path.join(directory, 'vitest.mjs')
  fs.writeFileSync(fixture, 'console.log("unrecognized reporter output")')
  const receipt = await run(process.execPath, [fixture, 'run'])
  assert.equal(receipt.processState, 'PASS')
  assert.equal(receipt.state, 'UNKNOWN')
  assert.equal(receipt.validation.state, 'UNKNOWN')
})

function diagnosticRunner(connection, extraValidation = {}) {
  const { createRequire } = require('node:module'), { runInNewContext } = require('node:vm')
  const filename = path.join(__dirname, 'test-output.cjs'), localRequire = createRequire(filename), module = { exports: {} }
  const mockedRequire = name => name === './local-agent/validation.cjs' ? { validationConnection: connection, ...extraValidation } : localRequire(name)
  runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, require: mockedRequire, __dirname, process, Buffer, setTimeout, clearTimeout, console }, { filename })
  return module.exports
}

test('receipt and compact output retain discovery and register diagnostics without retry or secrets', async () => {
  const association = { kind: 'TARGETED_TEST', scope: ['fixture'], evidenceFor: ['plan-fixture'] }
  for (const diagnostic of [
    { code: 'APP_UNAVAILABLE', stage: 'descriptor', reason: 'DESCRIPTOR_NOT_FOUND' },
    { code: 'APP_UNAVAILABLE', stage: 'connect', reason: 'ACCESS_DENIED' },
    { code: 'IPC_TIMEOUT', stage: 'connect', reason: 'TIMEOUT', operation: 'status' },
    { code: 'IPC_TIMEOUT', stage: 'response', reason: 'TIMEOUT', operation: 'status' },
    { code: 'WORKTREE_UNLINKED', stage: 'worktree', reason: 'IDENTITY_UNAVAILABLE', operation: 'worktree' }
  ]) {
    let attempts = 0
    const api = diagnosticRunner(async () => { attempts++; throw Object.assign(new Error('private-pipe private-token'), diagnostic, { endpoint: 'private-pipe', token: 'private-token' }) })
    const receipt = await api.run(process.execPath, ['-e', ''], { association })
    assert.equal(receipt.state, 'PASS'); assert.equal(attempts, 1)
    const summary = JSON.parse(api.project(receipt))
    assert.deepEqual(summary.registration.diagnostic, diagnostic)
    assert.equal(JSON.stringify(receipt).includes('private-token'), false)
    assert.ok(Buffer.byteLength(api.project(receipt)) <= limits.success)
  }
  for (const code of ['IPC_TIMEOUT', 'REGISTRATION_REJECTED']) {
    let attempts = 0, snapshots = 0
    const api = diagnosticRunner(async () => ({ identity: { repositoryId: 'fixture' }, snapshot: async () => { if (++snapshots === 1) throw Object.assign(new Error(), { code: 'IPC_TIMEOUT', stage: 'response', reason: 'TIMEOUT', operation: 'snapshot' }); return {} },
      register: async id => { attempts++; assert.match(id, /^[a-f0-9-]{36}$/); throw Object.assign(new Error('private-token'), { code, stage: 'response', reason: code === 'IPC_TIMEOUT' ? 'TIMEOUT' : 'SERVER_REJECTED', operation: 'register' }) } }))
    const receipt = await api.run(process.execPath, ['-e', ''], { association })
    const summary = JSON.parse(api.project(receipt))
    assert.equal(summary.registration.reason, code); assert.equal(summary.registration.diagnostic.operation, 'register')
    assert.equal(summary.ledgerDiagnostics[0].operation, 'snapshot'); assert.equal(attempts, 1)
    assert.equal(JSON.stringify(receipt).includes('private-token'), false)
    assert.equal(fs.existsSync(path.join(receipt.directory, 'receipt.json')), true)
  }
})

test('runSequence executes phases strictly sequentially, preserves per-phase receipts, and stops on first failure', async t => {
  const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'test-output-seq-'))
  t.after(() => fs.rmSync(fixtures, { recursive: true, force: true }))
  const traceFile = path.join(fixtures, 'trace.log')
  const phaseScript = (name, exitCode = 0) => [
    '-e',
    `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(traceFile)}, ${JSON.stringify(name)} + ':start\\n');setTimeout(()=>{fs.appendFileSync(${JSON.stringify(traceFile)}, ${JSON.stringify(name)} + ':end\\n');process.exit(${exitCode})},30)`
  ]

  const passed = await runSequence([
    { command: process.execPath, args: phaseScript('p1') },
    { command: process.execPath, args: phaseScript('p2') }
  ])
  assert.equal(passed.state, 'PASS')
  assert.equal(passed.exitCode, 0)
  assert.equal(passed.completedPhases, 2)
  assert.equal(passed.failedPhaseIndex, null)
  assert.equal(fs.readFileSync(traceFile, 'utf8'), 'p1:start\np1:end\np2:start\np2:end\n')
  for (const receipt of passed.phases) {
    assert.equal(fs.existsSync(path.join(receipt.directory, 'receipt.json')), true)
  }
  const compact = JSON.parse(projectSequence(passed))
  assert.equal(compact.phases.length, 2)
  assert.notEqual(compact.phases[0].id, compact.phases[1].id)

  fs.writeFileSync(traceFile, '')
  const failed = await runSequence([
    { command: process.execPath, args: phaseScript('first-pass', 0) },
    { command: process.execPath, args: phaseScript('second-fail', 7) },
    { command: process.execPath, args: phaseScript('third-skipped', 0) }
  ])
  assert.equal(failed.state, 'FAIL')
  assert.equal(failed.exitCode, 7)
  assert.equal(failed.completedPhases, 2)
  assert.equal(failed.totalPhases, 3)
  assert.equal(failed.failedPhaseIndex, 1)
  assert.equal(fs.readFileSync(traceFile, 'utf8'), 'first-pass:start\nfirst-pass:end\nsecond-fail:start\nsecond-fail:end\n')
})

test('runSequence propagates overall timeout and abort signal cleanly across phases', async t => {
  const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'test-output-seq-abort-'))
  t.after(() => fs.rmSync(fixtures, { recursive: true, force: true }))
  const marker = path.join(fixtures, 'second-ran')

  const timedOut = await runSequence([
    { command: process.execPath, args: ['-e', 'setTimeout(()=>{}, 5000)'] },
    { command: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'yes')`] }
  ], { timeoutMs: 120 })
  assert.equal(timedOut.state, 'TIMEOUT')
  assert.equal(timedOut.completedPhases, 1)
  assert.equal(timedOut.failedPhaseIndex, 0)
  assert.equal(fs.existsSync(marker), false)

  const controller = new AbortController()
  setTimeout(() => controller.abort(), 80)
  const cancelled = await runSequence([
    { command: process.execPath, args: ['-e', 'setTimeout(()=>{}, 5000)'] },
    { command: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'yes')`] }
  ], { signal: controller.signal })
  assert.equal(cancelled.state, 'CANCELLED')
  assert.equal(cancelled.completedPhases, 1)
  assert.equal(fs.existsSync(marker), false)

  const { spawnSync } = require('node:child_process')
  const cliResult = spawnSync(process.execPath, [
    path.join(__dirname, 'test-output.cjs'), 'sequence', '--',
    'node', '-e', "console.log('phase1')",
    '---',
    'node', '-e', "console.log('phase2')"
  ], { encoding: 'utf8', env: { ...process.env, CODE_AWARENESS_TEST_CAPTURE: '' } })
  assert.equal(cliResult.status, 0, cliResult.stderr)
  const cliSummary = JSON.parse(cliResult.stdout)
  assert.equal(cliSummary.state, 'PASS')
  assert.equal(cliSummary.completedPhases, 2)
})

test('U1 captures before/after source identity for recognized test runs without association, skips IPC for guards/opt-out, and preserves honest failure diagnostics', async t => {
  const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'test-output-u1-'))
  t.after(() => fs.rmSync(fixtures, { recursive: true, force: true }))
  const vitestStub = path.join(fixtures, 'vitest.mjs')
  const electronStub = path.join(fixtures, 'run-vitest-electron.cjs')
  const nodeTestStub = path.join(fixtures, 'fixture.test.cjs')
  const guardStub = path.join(fixtures, 'test-runtime-policy.cjs')
  fs.writeFileSync(vitestStub, "console.log('Tests  1 passed (1)')\n")
  fs.writeFileSync(electronStub, "console.log('Tests  1 passed (1)')\n")
  fs.writeFileSync(nodeTestStub, "require('node:test')('ok', () => {})\n")
  fs.writeFileSync(guardStub, "console.log('Policy PASS')\n")
  const makeHarness = ({ beforeSnap = { version: 1, head: 'a'.repeat(40) }, afterSnap = { version: 1, head: 'a'.repeat(40) }, failResolve, failBefore, failAfter } = {}) => {
    const calls = []
    let reconciles = 0
    const api = diagnosticRunner(async cwd => {
      calls.push(['resolve', cwd])
      if (failResolve) throw failResolve
      let snap = 0
      return {
        identity: { repositoryId: 'repo-1', worktreeId: 'w'.repeat(64), generation: 'g'.repeat(64) },
        snapshot: async () => {
          snap++
          calls.push([snap === 1 ? 'before' : 'after'])
          if (snap === 1 && failBefore) throw failBefore
          if (snap === 2 && failAfter) throw failAfter
          return snap === 1 ? beforeSnap : afterSnap
        },
        register: async (id, digest) => { calls.push(['register', id, digest]); return { state: 'PERSISTED', proofId: 'proof-1' } }
      }
    }, {
      reconcileReceipts: async () => { reconciles++; return { reconciled: [], remaining: 0 } },
      pendingReceiptIds: () => ({ ids: [], pending: 0 })
    })
    return { calls, getReconciles: () => reconciles, api }
  }

  for (const [label, command, args, opts] of [
    ['expectTests', process.execPath, ['-e', "console.log('Tests  1 passed (1)')"], { expectTests: true }],
    ['vitest', process.execPath, [vitestStub, 'run'], {}],
    ['run-vitest-electron', process.execPath, [electronStub, 'run'], {}],
    ['native-node-test', process.execPath, ['--test', '--test-reporter=tap', nodeTestStub], { env: { NODE_TEST_CONTEXT: undefined } }]
  ]) {
    const h = makeHarness()
    const receipt = await h.api.run(command, args, { ...opts, cwd: fixtures })
    assert.equal(receipt.state, 'PASS', label)
    assert.deepEqual(h.calls.map(c => c[0]), ['resolve', 'before', 'after'], label)
    assert.equal(h.getReconciles(), 0, label)
    assert.equal(receipt.ledger.identity.repositoryId, 'repo-1', label)
    assert.deepEqual(receipt.ledger.before, { version: 1, head: 'a'.repeat(40) }, label)
    assert.deepEqual(receipt.ledger.after, { version: 1, head: 'a'.repeat(40) }, label)
    assert.deepEqual(JSON.parse(JSON.stringify(receipt.ledger.association.evidenceFor)), [], label)
    assert.equal(receipt.registration.state, 'REGISTRATION_PENDING', label)
    assert.equal(receipt.registration.reason, 'REGISTRATION_NOT_REQUESTED', label)
    assert.equal(JSON.parse(h.api.project(receipt)).evidenceStatus, undefined, label)
  }

  const associated = makeHarness()
  const assocReceipt = await associated.api.run(process.execPath, ['-e', "console.log('Tests  1 passed (1)')"], {
    cwd: fixtures,
    association: { kind: 'TARGETED_TEST', scope: ['fixture'], evidenceFor: ['plan-1'] }
  })
  assert.deepEqual(JSON.parse(JSON.stringify(associated.calls.map(c => c[0]))), ['resolve', 'before', 'after', 'register'])
  assert.equal(associated.getReconciles(), 1)
  assert.equal(assocReceipt.registration.state, 'PERSISTED')

  for (const [label, command, args, opts] of [
    ['guard', process.execPath, [guardStub], {}],
    ['typecheck-unassociated', process.execPath, [guardStub], {}],
    ['register-false', process.execPath, ['-e', "console.log('Tests  1 passed (1)')"], { expectTests: true, register: false }],
    ['evidence-root', process.execPath, ['-e', "console.log('Tests  1 passed (1)')"], { expectTests: true, evidenceRoot: fixtures }]
  ]) {
    const h = makeHarness()
    const receipt = await h.api.run(command, args, { cwd: fixtures, ...opts })
    assert.equal(h.calls.length, 0, label)
    assert.equal(receipt.ledger.identity, null, label)
    assert.equal(receipt.ledger.before, null, label)
    assert.equal(receipt.ledger.after, null, label)
  }

  const resolveFail = makeHarness({ failResolve: Object.assign(new Error('unavailable'), { code: 'APP_UNAVAILABLE', stage: 'descriptor', reason: 'DESCRIPTOR_NOT_FOUND' }) })
  const resolveReceipt = await resolveFail.api.run(process.execPath, ['-e', "console.log('Tests  1 passed (1)')"], { cwd: fixtures, expectTests: true })
  assert.equal(resolveReceipt.state, 'PASS')
  assert.equal(resolveReceipt.ledger.identity, null)
  assert.equal(resolveReceipt.ledger.before, null)
  assert.equal(resolveReceipt.ledger.after, null)
  assert.equal(resolveReceipt.registration.reason, 'REGISTRATION_NOT_REQUESTED')
  assert.equal(resolveReceipt.registration.diagnostic.code, 'APP_UNAVAILABLE')
  assert.deepEqual(resolveFail.calls.map(c => c[0]), ['resolve'])

  const beforeFail = makeHarness({ failBefore: Object.assign(new Error('timeout'), { code: 'IPC_TIMEOUT', stage: 'response', reason: 'TIMEOUT', operation: 'snapshot' }) })
  const beforeReceipt = await beforeFail.api.run(process.execPath, ['-e', "console.log('Tests  1 passed (1)')"], { cwd: fixtures, expectTests: true })
  assert.equal(beforeReceipt.state, 'PASS')
  assert.equal(beforeReceipt.ledger.before, null)
  assert.deepEqual(beforeReceipt.ledger.after, { version: 1, head: 'a'.repeat(40) })
  assert.equal(beforeReceipt.ledgerDiagnostics[0].operation, 'snapshot')
})

test('U2 persists bounded redacted acceptance summaries without console output and rejects incomplete or leaky summaries', async t => {
  const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'test-output-u2-'))
  t.after(() => fs.rmSync(fixtures, { recursive: true, force: true }))
  const receiptHelper = path.join(__dirname, '../src/shared/validation/test-output-receipt.cjs')
  const { evaluateAcceptanceSummary, receiptDigest } = require(receiptHelper)

  const h = diagnosticRunner(async () => ({
    identity: { repositoryId: 'repo-1', worktreeId: 'w'.repeat(64), generation: 'g'.repeat(64) },
    snapshot: async () => ({ version: 1, head: 'a'.repeat(40) }),
    register: async () => { throw new Error('should not register') }
  }), {
    reconcileReceipts: async () => ({ reconciled: [], remaining: 0 }),
    pendingReceiptIds: () => ({ ids: [], pending: 0 })
  })

  const validSummary = {
    id: 'ENTIRE_LIVE_CHANNEL',
    provider: 'entire',
    version: '0.13.4',
    sha256: 'c'.repeat(64),
    pin: 'VERIFIED',
    source: 'PROVIDER_PIN_AND_CLI_VERSION',
    outcome: 'VERIFIED',
    coverage: 'COMPLETE',
    sessions: 2,
    usageCoverage: 'COMPLETE',
    transcriptImported: false
  }
  const quietScript = `require(${JSON.stringify(receiptHelper)}).recordTestAcceptance(${JSON.stringify(validSummary)});process.stdout.write('Tests  1 passed (1)\\n')`
  const quietReceipt = await h.run(process.execPath, ['-e', quietScript], { cwd: fixtures, expectTests: true })
  assert.equal(quietReceipt.state, 'PASS')
  assert.equal(quietReceipt.acceptance.outcome, 'VERIFIED')
  assert.equal(quietReceipt.acceptance.version, '0.13.4')
  assert.equal(quietReceipt.acceptance.sourceIdentity, 'BEFORE_AFTER_CAPTURED')
  assert.equal(fs.existsSync(path.join(quietReceipt.directory, 'acceptance.json')), false)
  const stored = JSON.parse(fs.readFileSync(path.join(quietReceipt.directory, 'receipt.json'), 'utf8'))
  assert.equal(receiptDigest(stored), stored.digest)
  const projectedText = h.project(quietReceipt)
  assert.ok(Buffer.byteLength(projectedText) <= limits.success)
  const projected = JSON.parse(projectedText)
  assert.equal(projected.acceptance.version, '0.13.4')
  assert.equal(projected.acceptance.sourceIdentity, 'BEFORE_AFTER_CAPTURED')

  const missingVersion = await h.run(process.execPath, ['-e', `require(${JSON.stringify(receiptHelper)}).recordTestAcceptance(${JSON.stringify({ ...validSummary, version: null })});console.log('Tests  1 passed (1)')`], { cwd: fixtures, expectTests: true })
  assert.equal(missingVersion.state, 'INSUFFICIENT')
  assert.equal(missingVersion.validation.state, 'INSUFFICIENT')
  assert.equal(missingVersion.acceptance.outcome, 'INCOMPLETE')

  const skippedCase = await h.run(process.execPath, ['-e', `require(${JSON.stringify(receiptHelper)}).recordTestAcceptance(${JSON.stringify({ ...validSummary, version: null, sha256: null, pin: 'UNVERIFIED', source: 'UNAVAILABLE', outcome: 'SKIPPED', code: 'ACCEPTANCE_SKIPPED' })});console.log('Tests  1 passed (1)')`], { cwd: fixtures, expectTests: true })
  assert.equal(skippedCase.state, 'INSUFFICIENT')
  assert.equal(skippedCase.acceptance.outcome, 'SKIPPED')

  const leakyFile = path.join(fixtures, 'leaky.cjs')
  fs.writeFileSync(leakyFile, `require(${JSON.stringify(receiptHelper)}).recordTestAcceptance(${JSON.stringify({ ...validSummary, transcriptImported: true, secretEnv: 'SECRET_ENV_LEAK', transcript: 'PRIVATE_TRANSCRIPT' })});console.log('Tests  1 passed (1)')\n`)
  const leakyReceipt = await h.run(process.execPath, [leakyFile], { cwd: fixtures, expectTests: true })
  assert.equal(leakyReceipt.state, 'INSUFFICIENT')
  assert.equal(leakyReceipt.acceptance.outcome, 'INCOMPLETE')
  assert.equal(leakyReceipt.acceptance.reason, 'ACCEPTANCE_SCHEMA_INVALID')
  assert.equal(JSON.stringify(leakyReceipt).includes('SECRET_ENV_LEAK'), false)
  assert.equal(JSON.stringify(leakyReceipt).includes('PRIVATE_TRANSCRIPT'), false)
  assert.equal(h.project(leakyReceipt).includes('SECRET_ENV_LEAK'), false)

  const badEval = evaluateAcceptanceSummary({ id: 'ENTIRE_LIVE_CHANNEL', provider: 'entire', version: '../bad/path', sha256: 'd'.repeat(64), pin: 'VERIFIED', source: 'PROVIDER_PIN_AND_CLI_VERSION', outcome: 'VERIFIED', transcriptImported: false }, { before: { a: 1 }, after: { a: 1 } })
  assert.equal(badEval.sufficient, false)
  assert.equal(badEval.acceptance.reason, 'ACCEPTANCE_SCHEMA_INVALID')
  assert.equal(badEval.acceptance.sourceIdentity, 'BEFORE_AFTER_CAPTURED')
})
