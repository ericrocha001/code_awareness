const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const readline = require('node:readline')
const { spawn, spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const evidenceRoot = path.join(root, '.code-awareness', 'test-output')
const limits = { success: 900, failure: 3500 }

function bounded(value, bytes) {
  let result = String(value)
  if (Buffer.byteLength(result) <= bytes) return result
  result = Buffer.from(result).subarray(0, Math.max(0, bytes - 4)).toString('utf8').replace(/\uFFFD$/, '')
  return result + '…'
}

function protectDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') { fs.chmodSync(directory, 0o700); return }
  const owner = os.userInfo().username
  const acl = spawnSync('icacls', [directory, '/inheritance:r', '/grant:r', `${owner}:(OI)(CI)F`], { windowsHide: true, stdio: 'ignore' })
  if (acl.error || acl.status !== 0) throw new Error('Cannot protect test evidence directory ACL')
}

function project(receipt) {
  const budget = receipt.state === 'PASS' ? limits.success : limits.failure
  const summary = {
    id: receipt.id, state: receipt.state, exitCode: receipt.exitCode,
    signal: receipt.signal, durationMs: receipt.durationMs,
    command: bounded(receipt.command.join(' '), 150),
    evidence: receipt.directory
  }
  if (receipt.counts) summary.counts = receipt.counts
  if (receipt.state !== 'PASS') summary.diagnostic = bounded(receipt.diagnostic || 'See full logs.', 2100)
  if (receipt.cleanupWarning) summary.cleanupWarning = receipt.cleanupWarning
  summary.logs = 'Full stdout/stderr and receipt in evidence; inspect for selective expansion.'
  let output = JSON.stringify(summary)
  while (Buffer.byteLength(output) > budget && summary.diagnostic?.length > 40) {
    summary.diagnostic = bounded(summary.diagnostic, Math.floor(Buffer.byteLength(summary.diagnostic) * 0.8))
    output = JSON.stringify(summary)
  }
  if (Buffer.byteLength(output) > budget) { delete summary.counts; summary.command = bounded(summary.command, 40); output = JSON.stringify(summary) }
  return output
}

function stop(child) {
  if (!child.pid) return
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    if (result.error || result.status !== 0) {
      child.kill('SIGKILL')
      return 'Process root terminated; taskkill could not confirm tree termination'
    }
  } else {
    try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
  }
}

async function run(command, args = [], options = {}) {
  const started = Date.now()
  const id = crypto.randomUUID()
  const directory = path.join(options.evidenceRoot || evidenceRoot, id)
  protectDirectory(directory)
  const files = ['stdout.log', 'stderr.log'].map(name => fs.openSync(path.join(directory, name), 'wx', 0o600))
  const receipt = { id, command: [command, ...args], cwd: options.cwd || root, directory, startedAt: new Date(started).toISOString(), state: 'RUNNING', pid: null }
  const receiptPath = path.join(directory, 'receipt.json')
  const save = () => fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2), { mode: 0o600 })
  save()
  let child
  let timer
  let diagnostic = []
  let tail = []
  const seen = new Set()
  const abort = signal => {
    if (receipt.state !== 'RUNNING') return
    receipt.state = signal === 'TIMEOUT' ? 'TIMEOUT' : 'CANCELLED'
    receipt.signal = signal
    receipt.cleanupWarning = stop(child)
  }
  const onInt = () => abort('SIGINT')
  const onTerm = () => abort('SIGTERM')
  const onAbort = () => abort('ABORT')
  try {
    child = spawn(command, args, {
      cwd: receipt.cwd, env: { ...process.env, ...options.env, CODE_AWARENESS_TEST_CAPTURE: '1' },
      windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe']
    })
    receipt.pid = child.pid || null
    save()
    process.on('SIGINT', onInt)
    process.on('SIGTERM', onTerm)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) onAbort()
    if (options.timeoutMs) timer = setTimeout(() => abort('TIMEOUT'), options.timeoutMs)
    const consume = (stream, fd) => new Promise((resolve, reject) => {
      let pending = ''
      const decoder = new (require('node:string_decoder').StringDecoder)('utf8')
      const line = raw => {
        const text = raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim()
        if (!text) return
        tail.push(bounded(text, 300)); if (tail.length > 6) tail.shift()
        if (/FAIL|Error|Assertion|expected|received|❯|×|not ok|at .*:\d+/i.test(text) && !seen.has(text)) {
          if (diagnostic.length < 16) { diagnostic.push(bounded(text, 300)); seen.add(text) }
        }
        const match = text.match(/^\s*(Tests|Test Files)\s+(.+)$/)
        if (match) { receipt.counts ||= {}; receipt.counts[match[1]] = bounded(match[2], 100) }
      }
      stream.on('data', chunk => {
        try {
          let offset = 0
          while (offset < chunk.length) offset += fs.writeSync(fd, chunk, offset, chunk.length - offset)
        } catch (error) { reject(error); stop(child); return }
        pending += decoder.write(chunk)
        const lines = pending.split(/\r?\n/)
        pending = lines.pop()
        for (const value of lines) line(value)
        if (pending.length > 4096) { line(pending.slice(0, 4096)); pending = pending.slice(-4096) }
      })
      stream.on('error', reject)
      stream.on('end', () => { line(pending + decoder.end()); resolve() })
    })
    let launchError
    child.on('error', error => { launchError = error.message })
    const completion = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })))
    const captured = Promise.all([consume(child.stdout, files[0]), consume(child.stderr, files[1])])
    const [{ code, signal }] = await Promise.all([completion, captured])
    receipt.exitCode = code
    receipt.signal ||= signal
    if (receipt.state === 'RUNNING') receipt.state = launchError ? 'LAUNCH_ERROR' : code === 0 && !signal ? 'PASS' : 'FAIL'
    receipt.diagnostic = launchError || (diagnostic.length ? diagnostic : tail).join('\n')
  } catch (error) {
    receipt.state = 'CAPTURE_ERROR'
    receipt.exitCode = null
    receipt.diagnostic = error.message
    if (child) stop(child)
  } finally {
    clearTimeout(timer)
    process.removeListener('SIGINT', onInt)
    process.removeListener('SIGTERM', onTerm)
    options.signal?.removeEventListener('abort', onAbort)
    for (const fd of files) fs.closeSync(fd)
  }
  receipt.durationMs = Date.now() - started
  save()
  return receipt
}

function resolveCommand(command, args) {
  if (command === 'node') return [process.execPath, args]
  if (command === 'electron') return [require('electron'), args]
  if (command === 'npm') {
    const cli = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
    if (!fs.existsSync(cli)) throw new Error('npm CLI unavailable; invoke through npm run test:agent')
    return [process.execPath, [cli, ...args]]
  }
  return [command, args]
}

async function inspect(id, { stream = 'stderr', pattern, from = 1, lines = 12 } = {}) {
  if (!/^[0-9a-f-]{36}$/.test(id) || !['stdout', 'stderr'].includes(stream)) throw new Error('Invalid evidence selection')
  if (!Number.isInteger(from) || from < 1 || !Number.isInteger(lines) || lines < 1 || lines > 30) throw new Error('Select 1-30 lines and a positive start')
  const file = path.join(evidenceRoot, id, `${stream}.log`)
  const input = fs.createReadStream(file)
  const reader = readline.createInterface({ input, crlfDelay: Infinity })
  let number = 0
  const matches = []
  let bytes = 0
  try {
    for await (const line of reader) {
      number++
      if (number < from || (pattern && !line.includes(pattern))) continue
      const text = bounded(`${number}: ${line}`, 300)
      if (bytes + Buffer.byteLength(text) > 2800 || matches.length === lines) break
      matches.push(text); bytes += Buffer.byteLength(text)
    }
  } finally { reader.close(); input.destroy() }
  return { id, stream, matches, fullLog: file, bounded: true }
}

async function observe(id, { afterState, timeoutMs = 30000, signal } = {}) {
  if (!/^[0-9a-f-]{36}$/.test(id) || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid observation')
  const directory = path.join(evidenceRoot, id)
  const file = path.join(directory, 'receipt.json')
  return new Promise((resolve, reject) => {
    let watcher
    const finish = value => { clearTimeout(timer); watcher?.close(); signal?.removeEventListener('abort', cancel); resolve(value) }
    const check = () => {
      let receipt
      try { receipt = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (error) { if (error instanceof SyntaxError) return; reject(error); finish(null); return }
      if (receipt.id !== id) { reject(new Error('Evidence identity changed')); finish(null); return }
      if (receipt.state !== 'RUNNING') finish(receipt.state === afterState ? null : receipt)
    }
    const cancel = () => finish(null)
    const timer = setTimeout(() => finish({ id, state: 'OBSERVATION_TIMEOUT', evidence: directory }), timeoutMs)
    try { watcher = fs.watch(directory, check); signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel(); else check() }
    catch (error) { reject(error); finish(null) }
  })
}

async function cli() {
  const args = process.argv.slice(2)
  const action = args.shift()
  if (action === 'observe') {
    const id = args.shift(); let afterState
    if (args.length) { if (args.shift() !== '--after-state') throw new Error('Invalid observation option'); afterState = args.shift() }
    if (args.length) throw new Error('Invalid observation option')
    const receipt = await observe(id, { afterState })
    if (receipt) {
      console.log(receipt.state === 'OBSERVATION_TIMEOUT' ? JSON.stringify(receipt) : project(receipt))
      process.exitCode = receipt.state === 'PASS' ? 0 : receipt.exitCode || 1
    }
    return
  }
  if (action === 'inspect') {
    const id = args.shift(); const options = {}
    while (args.length) {
      const flag = args.shift(); const value = args.shift()
      if (!['--stream', '--pattern', '--from', '--lines'].includes(flag) || value === undefined) throw new Error('Invalid inspection option')
      options[flag.slice(2)] = ['--from', '--lines'].includes(flag) ? Number(value) : value
    }
    console.log(JSON.stringify(await inspect(id, options))); return
  }
  if (action === 'clean') {
    const id = args.shift()
    if (!/^[0-9a-f-]{36}$/.test(id) || args.length) throw new Error('Clean requires one explicit completed execution id')
    const directory = path.join(evidenceRoot, id)
    const receipt = JSON.parse(fs.readFileSync(path.join(directory, 'receipt.json'), 'utf8'))
    if (receipt.state === 'RUNNING') throw new Error('Cannot clean running evidence')
    fs.rmSync(directory, { recursive: true }); console.log(JSON.stringify({ removed: id })); return
  }
  if (action !== 'run') throw new Error('Use run [--human] [--timeout-ms N] -- command args; inspect id; clean id')
  let human = false; let timeoutMs
  while (args[0] !== '--') {
    const flag = args.shift()
    if (flag === '--human') human = true
    else if (flag === '--timeout-ms') { timeoutMs = Number(args.shift()); if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid timeout') }
    else throw new Error('Invalid run option')
  }
  args.shift()
  const command = args.shift()
  if (!command) throw new Error('Command required')
  const [executable, parameters] = resolveCommand(command, args)
  if (human || process.env.CODE_AWARENESS_TEST_CAPTURE === '1') {
    const result = spawnSync(executable, parameters, { cwd: root, env: { ...process.env, CODE_AWARENESS_TEST_CAPTURE: '1' }, stdio: 'inherit', timeout: timeoutMs })
    process.exitCode = result.status === null ? 1 : result.status
    if (result.error) console.error(result.error.message)
    return
  }
  const receipt = await run(executable, parameters, { timeoutMs })
  console.log(project(receipt))
  process.exitCode = receipt.state === 'PASS' ? 0 : receipt.exitCode || 1
}

if (require.main === module) cli().catch(error => { console.error(bounded(error.message, 500)); process.exitCode = 1 })
module.exports = { run, project, inspect, observe, limits, resolveCommand, protectDirectory }
