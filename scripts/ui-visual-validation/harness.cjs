const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawn, spawnSync } = require('node:child_process')

async function run({ scenario = 'preflight', timeout = 30000, executable, output } = {}) {
  const projectRoot = path.resolve(__dirname, '../..')
  const runId = `${Date.now()}-${require('node:crypto').randomUUID()}`
  const evidenceDir = path.resolve(output || path.join(projectRoot, '.code-awareness/visual-validation', runId))
  const receipt = { status: 'FAIL', scenario, runId, checks: [], captures: [], evidenceDir }
  let temporary, child, timer
  try {
    if (!/^[a-z0-9-]+$/i.test(scenario)) throw Object.assign(new Error('Scenario must be a filename stem'), { code: 'SCENARIO_INVALID' })
    fs.mkdirSync(evidenceDir, { recursive: true })
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-ui-visual-'))
    const config = { projectRoot, evidenceDir, temporary, scenario: path.resolve(__dirname, 'scenarios', `${scenario}.cjs`) }
    fs.writeFileSync(path.join(temporary, 'config.json'), JSON.stringify(config))
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
    const result = await new Promise((resolve, reject) => {
      child = spawn(executable || require('electron'), [path.join(__dirname, 'worker.cjs'), path.join(temporary, 'config.json')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
      receipt.processId = child.pid
      let log = '', received
      for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { log = (log + data).slice(-16000) })
      child.on('message', message => { received = message })
      child.on('error', error => reject(Object.assign(error, { code: 'ELECTRON_START_FAILED' })))
      child.on('exit', code => {
        try { fs.writeFileSync(path.join(evidenceDir, 'runtime.log'), log) }
        catch (error) { reject(Object.assign(error, { code: 'OUTPUT_UNWRITABLE' })); return }
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
  } catch (error) {
    receipt.status = 'FAIL'; receipt.reason = error.code || 'HARNESS_FAILED'; receipt.message = error.message
  } finally {
    clearTimeout(timer)
    if (child && child.exitCode === null && !child.signalCode && child.pid) await new Promise(resolve => { child.once('exit', resolve); child.kill(); setTimeout(resolve, 3000).unref() })
    if (child?.pid) {
      try { process.kill(child.pid, 0); receipt.status = 'FAIL'; receipt.reason = 'TEARDOWN_FAILED' }
      catch (error) { if (error.code !== 'ESRCH') { receipt.status = 'FAIL'; receipt.reason = 'TEARDOWN_UNVERIFIED' } }
    }
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
if (require.main === module) run({ scenario: process.argv[2] || 'preflight' }).then(receipt => { console.log(JSON.stringify(receipt, null, 2)); process.exitCode = receipt.status === 'PASS' ? 0 : 1 })
