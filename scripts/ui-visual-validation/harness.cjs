const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawn, spawnSync } = require('node:child_process')
const { runId: createRunId, isStem } = require('./evidence.cjs')

async function run({ scenario = 'preflight', timeout = 30000, executable, output, comparison } = {}) {
  const projectRoot = path.resolve(__dirname, '../..')
  const runId = createRunId()
  const evidenceDir = path.resolve(output || path.join(projectRoot, '.code-awareness/visual-validation', runId))
  const receipt = { status: 'FAIL', scenario, runId, checks: [], captures: [], evidenceDir }
  let temporary, child, timer
  const logFiles = []
  try {
    if (!isStem(scenario)) throw Object.assign(new Error('Scenario must be a filename stem'), { code: 'SCENARIO_INVALID' })
    if (comparison && (!isStem(comparison.capture) || comparison.approvedReference !== true || !comparison.reference)) throw Object.assign(new Error('Select an approved reference and named capture'), { code: 'COMPARISON_ARGUMENT_INVALID' })
    if (comparison || scenario === 'codemap-convergence') {
      const git = args => { const result = spawnSync('git', args, { cwd: projectRoot, windowsHide: true, encoding: 'utf8' }); return result.status === 0 ? result.stdout.trim() : null }
      receipt.source = { observedAt: new Date().toISOString(), observation: 'SCENARIO_START', checkout: projectRoot, head: git(['rev-parse', 'HEAD']), branch: git(['branch', '--show-current']), changes: git(['-c', 'core.fsmonitor=false', 'status', '--porcelain']) }
    }
    require('../test-output.cjs').protectDirectory(evidenceDir)
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > (scenario === 'codemap-convergence' ? 600000 : 120000)) throw Object.assign(new Error('Scenario timeout must be 1–120000 ms'), { code: 'TIMEOUT_INVALID' })
    for (const name of ['runtime.log', 'runtime.stdout.log', 'runtime.stderr.log']) logFiles.push(fs.openSync(path.join(evidenceDir, name), 'wx', 0o600))
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-ui-visual-'))
    const config = { projectRoot, evidenceDir, temporary, scenario: path.resolve(__dirname, 'scenarios', `${scenario}.cjs`) }
    fs.writeFileSync(path.join(temporary, 'config.json'), JSON.stringify(config))
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
    const result = await new Promise((resolve, reject) => {
      child = spawn(executable || require('electron'), [path.join(__dirname, 'worker.cjs'), path.join(temporary, 'config.json')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
      receipt.processId = child.pid
      let received
      for (const [index, stream] of [child.stdout, child.stderr].entries()) stream.on('data', data => {
        try {
          for (const fd of [logFiles[0], logFiles[index + 1]]) {
            let offset = 0
            while (offset < data.length) offset += fs.writeSync(fd, data, offset, data.length - offset)
          }
        } catch (error) { child.kill(); reject(Object.assign(error, { code: 'OUTPUT_UNWRITABLE' })) }
      })
      child.on('message', message => { received = message })
      child.on('error', error => reject(Object.assign(error, { code: 'ELECTRON_START_FAILED' })))
      child.on('close', code => {
        if (received) resolve(received)
        else reject(Object.assign(new Error(`Electron exited ${code}`), { code: 'ELECTRON_EXIT_WITHOUT_RECEIPT' }))
      })
      timer = setTimeout(() => {
        if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
        else child.kill('SIGKILL')
        reject(Object.assign(new Error('Scenario deadline exceeded'), { code: 'HARNESS_TIMEOUT' }))
      }, timeout)
    })
    Object.assign(receipt, result)
    if (receipt.status === 'PASS' && !receipt.captures.length) throw Object.assign(new Error('Scenario produced no captures'), { code: 'CAPTURE_MISSING' })
    for (const capture of receipt.captures) {
      const bytes = fs.readFileSync(capture.path)
      if (bytes.length < 100 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || bytes.readUInt32BE(16) !== capture.dimensions.width || bytes.readUInt32BE(20) !== capture.dimensions.height) throw Object.assign(new Error('Invalid PNG'), { code: 'CAPTURE_INVALID' })
    }
    if (comparison) {
      const image = receipt.captures.find(capture => capture.name === comparison.capture)
      receipt.comparison = image && receipt.status === 'PASS'
        ? await require('./compare.cjs').compare({ reference: comparison.reference, actual: image.path, approvedReference: comparison.approvedReference, mode: comparison.mode, metadata: comparison.metadata, capture: { image, receipt }, parent: evidenceDir })
        : { state: 'ERROR', error: { code: 'CAPTURE_UNAVAILABLE', message: 'Named capture from a successful scenario is required' } }
    }
  } catch (error) {
    receipt.status = 'FAIL'; receipt.reason = error.code || 'HARNESS_FAILED'; receipt.message = error.message
  } finally {
    clearTimeout(timer)
    if (child && child.exitCode === null && !child.signalCode && child.pid) await new Promise(resolve => { child.once('close', resolve); child.kill(); setTimeout(resolve, 3000).unref() })
    if (child?.pid) {
      try { process.kill(child.pid, 0); receipt.status = 'FAIL'; receipt.reason = 'TEARDOWN_FAILED' }
      catch (error) { if (error.code !== 'ESRCH') { receipt.status = 'FAIL'; receipt.reason = 'TEARDOWN_UNVERIFIED' } }
    }
    for (const fd of logFiles) fs.closeSync(fd)
    if (temporary && !['TEARDOWN_FAILED', 'TEARDOWN_UNVERIFIED'].includes(receipt.reason)) {
      try { fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); receipt.cleanup = 'PASS' }
      catch (error) { receipt.status = 'FAIL'; receipt.reason = 'CLEANUP_FAILED'; receipt.message = error.message }
    }
    else if (temporary) receipt.cleanup = 'FAIL'
    try { fs.writeFileSync(path.join(evidenceDir, 'receipt.json'), JSON.stringify(receipt, null, 2)) }
    catch (error) { receipt.status = 'FAIL'; receipt.reason = 'OUTPUT_UNWRITABLE'; receipt.message = error.message }
  }
  return receipt
}
module.exports = { run }
if (require.main === module) {
  Promise.resolve().then(() => {
    const args = process.argv.slice(3)
    const timeoutIndex = args.indexOf('--timeout-ms')
    let timeout
    if (timeoutIndex >= 0) {
      timeout = Number(args[timeoutIndex + 1])
      args.splice(timeoutIndex, 2)
    }
    return run({ scenario: process.argv[2] || 'preflight', ...(timeout !== undefined ? { timeout } : {}), ...(args.length ? { comparison: require('./compare.cjs').parseArguments(args, true) } : {}) })
  }).then(receipt => { console.log(JSON.stringify(receipt, null, 2)); process.exitCode = receipt.status === 'PASS' && (!receipt.comparison || receipt.comparison.state === 'READY_FOR_REVIEW') ? 0 : 1 })
    .catch(error => { console.error(JSON.stringify({ status: 'FAIL', reason: error.code || 'ARGUMENT_INVALID', message: error.message })); process.exitCode = 1 })
}
