// @ts-check
const { spawn } = require('node:child_process')
const { lstat, open } = require('node:fs/promises')
const { isAbsolute } = require('node:path')

/** @param {import('./native-acceptance.cjs').NativeAcceptanceCommand} command
 * @returns {Promise<import('./native-acceptance.cjs').NativeProcessReceipt>} */
function execute(command) {
  return new Promise(resolve => {
    let failed = false, timedOut = false
    try {
      const child = spawn(command.executable, [...command.args], { cwd: command.cwd, env: command.env, shell: false, windowsHide: true, stdio: 'ignore' })
      const timer = setTimeout(() => { timedOut = true; child.kill() }, command.timeoutMs)
      child.once('error', () => { failed = true })
      child.once('close', (exitCode, signal) => {
        clearTimeout(timer)
        if (failed) resolve({ status: 'PREPARATION_FAILED', exitCode: null, signal: null })
        else resolve({ status: timedOut ? 'TIMED_OUT' : 'EXITED', exitCode, signal })
      })
    } catch { resolve({ status: 'PREPARATION_FAILED', exitCode: null, signal: null }) }
  })
}

/** @param {string | undefined} file @param {number} maxBytes */
async function readBuildLog(file, maxBytes = 16384) {
  if (!file || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 65536) throw Error('BUILD_LOG_UNAVAILABLE')
  const before = await lstat(file)
  if (!before.isFile() || before.isSymbolicLink()) throw Error('BUILD_LOG_UNAVAILABLE')
  const handle = await open(file, 'r')
  try {
    const actual = await handle.stat()
    if (!actual.isFile() || actual.ino !== before.ino || actual.dev !== before.dev) throw Error('BUILD_LOG_UNAVAILABLE')
    const buffer = Buffer.alloc(maxBytes), { bytesRead } = await handle.read(buffer, 0, buffer.length, Math.max(0, actual.size - maxBytes))
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally { await handle.close() }
}

/** @param {import('./native-acceptance.cjs').NativeAcceptanceInput} input
 * @returns {Promise<import('./native-acceptance.cjs').NativeAcceptanceResult>} */
async function runNativeAcceptance(input) {
  let command
  try {
    command = await input.prepare()
    if (!isAbsolute(command.executable) || !isAbsolute(command.cwd) || !Array.isArray(command.args) || command.args.some(arg => typeof arg !== 'string' || arg.includes('\0')) || !Number.isSafeInteger(command.timeoutMs) || command.timeoutMs < 1 || command.timeoutMs > 2147483647) throw Error('INVALID_PROCESS_INPUT')
  } catch {
    return { state: 'PREPARATION_FAILED', process: Object.freeze({ status: 'PREPARATION_FAILED', exitCode: null, signal: null }), observer: 'NOT_RUN' }
  }
  const process = Object.freeze(await execute(command))
  /** @type {import('./native-acceptance.cjs').NativeAcceptanceResult['observer']} */
  let observer = 'NOT_RUN'
  if (input.observe && process.status !== 'PREPARATION_FAILED') {
    try {
      await input.observe(Object.freeze({ process, readBuildLog: (maxBytes) => readBuildLog(command.buildLog, maxBytes) }))
      observer = 'PASSED'
    } catch { observer = 'FAILED' }
  }
  const state = process.status === 'PREPARATION_FAILED' ? 'PREPARATION_FAILED' : process.status === 'TIMED_OUT' ? 'TIMED_OUT' : process.exitCode !== 0 || process.signal !== null ? 'COMPILER_FAILED' : observer === 'FAILED' ? 'HARNESS_FAILED' : 'PASS'
  return { state, process, observer }
}

module.exports = { runNativeAcceptance }
