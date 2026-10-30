const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtemp, writeFile, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { runNativeAcceptance } = require('./native-acceptance.cjs')

const command = script => ({ executable: process.execPath, args: ['-e', script], cwd: process.cwd(), timeoutMs: 5000 })
test('preserves compiler success and exposes its immutable typed receipt', async () => {
  const result = await runNativeAcceptance({ prepare: () => command('process.exit(0)'), observe: ({ process }) => {
    assert.equal(process.exitCode, 0); assert.ok(Object.isFrozen(process))
  } })
  assert.deepEqual(result, { state: 'PASS', process: { status: 'EXITED', exitCode: 0, signal: null }, observer: 'PASSED' })
})
test('preserves compiler failure even when the observer also fails', async () => {
  const result = await runNativeAcceptance({ prepare: () => command('process.exit(7)'), observe: () => { throw Error('PRIVATE_OBSERVER_SECRET') } })
  assert.equal(result.state, 'COMPILER_FAILED'); assert.equal(result.process.exitCode, 7); assert.equal(result.observer, 'FAILED')
  assert.ok(!JSON.stringify(result).includes('PRIVATE_OBSERVER_SECRET'))
})
test('distinguishes Harness failure from a successful compiler', async () => {
  const result = await runNativeAcceptance({ prepare: () => command('process.exit(0)'), observe: async () => { throw Error('PRIVATE_PATH') } })
  assert.equal(result.state, 'HARNESS_FAILED'); assert.equal(result.process.exitCode, 0); assert.equal(result.observer, 'FAILED')
})
test('distinguishes timeout after root process closure', async () => {
  const result = await runNativeAcceptance({ prepare: () => ({ ...command('setInterval(()=>{},1000)'), timeoutMs: 100 }) })
  assert.equal(result.state, 'TIMED_OUT'); assert.equal(result.process.status, 'TIMED_OUT')
})
test('distinguishes preparation and spawn errors without running an observer', async () => {
  for (const prepare of [() => { throw Error('PRIVATE_PREPARATION') }, () => ({ ...command(''), executable: join(tmpdir(), 'pvo-nonexistent-executable.exe') })]) {
    const result = await runNativeAcceptance({ prepare, observe: () => { assert.fail('observer must not run') } })
    assert.equal(result.state, 'PREPARATION_FAILED'); assert.equal(result.observer, 'NOT_RUN')
    assert.ok(!JSON.stringify(result).includes('PRIVATE_PREPARATION'))
  }
})
test('reads only a bounded existing Build Store log and keeps it out of the public receipt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pvo-harness-log-'))
  try {
    const buildLog = join(directory, 'build.log'); await writeFile(buildLog, 'PRIVATE_BUILD_LOG'.repeat(100))
    const result = await runNativeAcceptance({ prepare: () => ({ ...command('process.exit(0)'), buildLog }), observe: async ({ readBuildLog }) => {
      const text = await readBuildLog(32); assert.equal(Buffer.byteLength(text), 32)
      await assert.rejects(() => readBuildLog(65537), /BUILD_LOG_UNAVAILABLE/)
    } })
    assert.equal(result.state, 'PASS')
    assert.ok(!JSON.stringify(result).includes(directory)); assert.ok(!JSON.stringify(result).includes('PRIVATE_BUILD_LOG'))
  } finally { await rm(directory, { recursive: true, force: true }) }
})
