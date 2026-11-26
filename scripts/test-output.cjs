const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const readline = require('node:readline')
const { spawn, spawnSync } = require('node:child_process')
const { receiptDigest, evaluateAcceptanceSummary, readRecordedAcceptance } = require('../src/shared/validation/test-output-receipt.cjs')
const { validationConnection, registerReceipt, reconcileReceipts, pendingReceiptIds, sendRegistration } = require('./local-agent/validation.cjs')
const { publicError } = require('./local-agent/discovery.cjs')

const root = path.resolve(__dirname, '..')
const evidenceRoot = path.join(root, '.code-awareness', 'test-output')
const limits = { success: 900, failure: 3500 }
const tapFields = ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo', 'duration_ms']
const nodeOptionsWithValue = new Set([
  '-C', '--conditions', '-r', '--require', '--import', '-e', '--eval', '-p', '--print',
  '--env-file', '--env-file-if-exists', '--input-type', '--loader', '--experimental-loader',
  ...['concurrency', 'coverage-branches', 'coverage-functions', 'coverage-lines',
    'coverage-exclude', 'coverage-include', 'global-setup', 'isolation', 'name-pattern',
    'random-seed', 'reporter', 'reporter-destination', 'rerun-failures', 'shard',
    'skip-pattern', 'timeout'].map(name => `--test-${name}`),
  '--experimental-test-isolation'
])

function isNativeNodeTest(command, args) {
  if (!/(?:^|[/\\])node(?:\.exe)?$/i.test(command) && command !== process.execPath) return false
  let enabled = false
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--' || arg === '-' || !arg.startsWith('-')) break
    const option = arg.split('=', 1)[0]
    if (option === '--test') enabled = true
    else if (option === '--no-test') enabled = false
    else if (nodeOptionsWithValue.has(arg)) index++
  }
  return enabled
}

function parseTestCounts(summary) {
  const match = summary.match(/^(.+?)\s+\((\d+)\)$/)
  if (!match) return null
  const counts = { passed: 0, failed: 0, skipped: 0, todo: 0 }
  const seen = new Set()
  for (const part of match[1].split('|')) {
    const entry = part.trim().match(/^(\d+) (passed|failed|skipped|todo)$/)
    if (!entry || seen.has(entry[2])) return null
    seen.add(entry[2]); counts[entry[2]] = Number(entry[1])
  }
  const total = Number(match[2])
  if (![total, ...Object.values(counts)].every(Number.isSafeInteger) || Object.values(counts).reduce((a, b) => a + b, 0) !== total) return null
  return { ...counts, total, executed: counts.passed + counts.failed }
}

function testEvidence(expected, summaries, processState, tapSummary) {
  if (!expected) return { state: 'NOT_APPLICABLE' }
  const tapCounts = tapSummary && parseTestCounts(tapSummary)
  if (processState === 'FAIL' && tapSummary) {
    if (tapCounts?.failed > 0) return { state: 'FAILED', runs: [tapCounts] }
  }
  if (processState !== 'PASS') return { state: 'UNKNOWN', reason: 'Process did not complete successfully.' }
  const runs = summaries.map(parseTestCounts)
  if (tapSummary) runs.push(tapCounts)
  if (!runs.length || runs.some(counts => counts === null)) return { state: 'UNKNOWN', reason: 'Reliable test counts unavailable.' }
  if (runs.some(counts => counts.failed > 0)) return { state: 'FAILED', runs }
  if (runs.some(counts => counts.executed === 0)) return { state: 'INSUFFICIENT', runs, reason: 'A test run executed zero tests.' }
  return { state: 'SUFFICIENT', runs }
}

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
  if (receipt.processState) summary.processState = receipt.processState
  if (receipt.validation) {
    summary.validation = { state: receipt.validation.state }
    if (receipt.validation.runs) summary.validation.executed = receipt.validation.runs.reduce((sum, counts) => sum + counts.executed, 0)
  }
  if (receipt.counts) summary.counts = receipt.counts
  if (receipt.state !== 'PASS') summary.diagnostic = bounded(receipt.diagnostic || 'See full logs.', 2100)
  if (receipt.cleanupWarning) summary.cleanupWarning = receipt.cleanupWarning
  if (receipt.acceptance) summary.acceptance = receipt.acceptance
  if (receipt.registration) {
    const { intent: _intent, ...registration } = receipt.registration
    summary.registration = registration
  }
  if (receipt.state === 'PASS' && receipt.registration && !['PERSISTED'].includes(receipt.registration.state) && receipt.registration.reason !== 'REGISTRATION_NOT_REQUESTED') summary.evidenceStatus = 'TESTE LOCAL APROVADO / REGISTRO PENDENTE'
  if (receipt.reconciliation?.reconciled.length) summary.reconciled = receipt.reconciliation.reconciled.map(({ id, state, proofId }) => ({ id, state, ...(proofId ? { proofId } : {}) }))
  if (receipt.reconciliation?.remaining) summary.pendingRegistrations = receipt.reconciliation.remaining
  if (receipt.ledgerDiagnostics?.length) summary.ledgerDiagnostics = receipt.ledgerDiagnostics.slice(0, 3)
  summary.logs = 'Full stdout/stderr and receipt in evidence; inspect for selective expansion.'
  let output = JSON.stringify(summary)
  while (Buffer.byteLength(output) > budget && summary.diagnostic?.length > 40) {
    summary.diagnostic = bounded(summary.diagnostic, Math.floor(Buffer.byteLength(summary.diagnostic) * 0.8))
    output = JSON.stringify(summary)
  }
  if (Buffer.byteLength(output) > budget) { delete summary.counts; summary.command = bounded(summary.command, 40); output = JSON.stringify(summary) }
  if (Buffer.byteLength(output) > budget) { delete summary.logs; output = JSON.stringify(summary) }
  if (Buffer.byteLength(output) > budget && summary.processState === summary.state) { delete summary.processState; output = JSON.stringify(summary) }
  if (Buffer.byteLength(output) > budget && summary.acceptance) { delete summary.ledgerDiagnostics; delete summary.evidenceStatus; output = JSON.stringify(summary) }
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
  const directory = path.join(options.evidenceRoot || path.join(options.cwd || root, '.code-awareness', 'test-output'), id)
  protectDirectory(directory)
  const files = ['stdout.log', 'stderr.log'].map(name => fs.openSync(path.join(directory, name), 'wx', 0o600))
  const nativeNodeTest = isNativeNodeTest(command, args)
  const expectTests = nativeNodeTest || options.expectTests || [command, ...args].some(value => /(?:^|[/\\])(?:vitest(?:\.mjs|[/\\]dist[/\\]cli\.js)?|run-vitest-electron\.cjs)$/.test(value))
  const testSummaries = []
  const tapCounts = {}
  let tapPrefix
  let tapStream
  let tapIndex = 0
  let invalidTap = false
  const receipt = { version: 1, id, command: [command, ...args], cwd: fs.realpathSync(options.cwd || root), directory, startedAt: new Date(started).toISOString(), state: 'RUNNING', pid: null }
  let connection, registrationDiagnostic
  const diagnostics = []
  let before = null
  let deliveryContext = options.deliveryContext !== undefined
    ? parseDeliveryContextInput(options.deliveryContext)
    : parseDeliveryContextInput(process.env.CODE_AWARENESS_DELIVERY_CONTEXT)
  const association = options.association || { kind: process.env.CODE_AWARENESS_VALIDATION_KIND || 'TARGETED_TEST', scope: ['checkout'],
    evidenceFor: process.env.CODE_AWARENESS_VALIDATION_EVIDENCE_FOR ? JSON.parse(process.env.CODE_AWARENESS_VALIDATION_EVIDENCE_FOR) : [] }
  const resolveExecution = options.resolveExecutionContext === true || process.env.CODE_AWARENESS_RESOLVE_EXECUTION === '1'
  const workValidationAuthorized = Boolean(
    deliveryContext ||
    options.authorizeWorkValidation === true ||
    process.env.CODE_AWARENESS_VALIDATION_AUTHORIZE_PLAN === '1' ||
    association.evidenceFor?.length
  )
  const requestedRegistration = Boolean(options.association || process.env.CODE_AWARENESS_VALIDATION_EVIDENCE_FOR || deliveryContext || resolveExecution || workValidationAuthorized)
  const shouldCaptureSource = !options.evidenceRoot && options.register !== false && (expectTests || requestedRegistration)
  receipt.ledger = { association, identity: null, before: null, after: null, ...(deliveryContext ? { deliveryContext } : {}), ...(workValidationAuthorized ? { workValidationAuthorized: true } : {}) }
  receipt.ledgerDiagnostics = diagnostics
  const receiptPath = path.join(directory, 'receipt.json')
  const save = () => fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2), { mode: 0o600 })
  save()
  if (shouldCaptureSource) {
    try {
      connection = await validationConnection(path.resolve(options.cwd || root), options.profile)
      if (!deliveryContext && resolveExecution && connection.identity?.repositoryId && connection.identity?.worktreeId) {
        try {
          const { connect: connectChannel } = require('./local-agent/client.cjs')
          const { readDescriptor } = require('./local-agent/discovery.cjs')
          const descriptor = readDescriptor(options.profile, { directory: 'local-agent-channel', protocol: 'code-awareness-local/v1' })
          const active = await connectChannel(descriptor, {
            domain: 'continuum',
            action: 'get_execution_context',
            args: { repositoryId: connection.identity.repositoryId, worktreeId: connection.identity.worktreeId }
          }, { timeoutMs: 2000 })
          if (active?.deliveryContext) deliveryContext = active.deliveryContext
        } catch (error) { diagnostics.push(publicError(error)) }
      }
      before = await connection.snapshot()
    } catch (error) { registrationDiagnostic = publicError(error); diagnostics.push(registrationDiagnostic) }
    receipt.ledger = { association, identity: connection?.identity || null, before, after: null, ...(deliveryContext ? { deliveryContext } : {}), ...(workValidationAuthorized ? { workValidationAuthorized: true } : {}) }
    save()
  }
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
  const acceptancePath = path.join(directory, 'acceptance.json')
  const propagatedEnv = (deliveryContext || resolveExecution) ? {
    ...(deliveryContext ? { CODE_AWARENESS_DELIVERY_CONTEXT: JSON.stringify(deliveryContext) } : {}),
    ...(connection?.identity?.worktreeId && !process.env.CODE_AWARENESS_WORKTREE_ID && !options.env?.CODE_AWARENESS_WORKTREE_ID ? { CODE_AWARENESS_WORKTREE_ID: connection.identity.worktreeId } : {})
  } : {}
  try {
    child = spawn(command, args, {
      cwd: receipt.cwd, env: { ...process.env, ...propagatedEnv, ...options.env, CODE_AWARENESS_TEST_CAPTURE: '1', CODE_AWARENESS_TEST_ACCEPTANCE_FILE: acceptancePath },
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
      let truncated = false
      const line = (raw, complete) => {
        const uncolored = raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
        const text = uncolored.trim()
        const tap = uncolored.match(/^(#|ℹ) (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)(?:\s+(.*))?$/)
        if (tap) {
          const [, prefix, field, value] = tap
          tapPrefix ??= prefix
          tapStream ??= fd
          const validValue = field === 'duration_ms'
            ? /^\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value))
            : /^\d+$/.test(value) && Number.isSafeInteger(Number(value))
          if (!complete || prefix !== tapPrefix || fd !== tapStream || field !== tapFields[tapIndex] || !validValue) {
            invalidTap = true
          } else {
            tapCounts[field] = Number(value)
            tapIndex++
          }
        } else if (fd === tapStream && tapIndex < tapFields.length) {
          invalidTap = true
        }
        if (!text) return
        tail.push(bounded(text, 300)); if (tail.length > 6) tail.shift()
        if (/FAIL|Error|Assertion|expected|received|❯|×|not ok|at .*:\d+/i.test(text) && !seen.has(text)) {
          if (diagnostic.length < 16) { diagnostic.push(bounded(text, 300)); seen.add(text) }
        }
        const match = text.match(/^\s*(Tests|Test Files)\s+(.+)$/)
        if (match) { receipt.counts ||= {}; receipt.counts[match[1]] = bounded(match[2], 100) }
        if (match?.[1] === 'Tests') testSummaries.push(match[2])
      }
      stream.on('data', chunk => {
        try {
          let offset = 0
          while (offset < chunk.length) offset += fs.writeSync(fd, chunk, offset, chunk.length - offset)
        } catch (error) { reject(error); stop(child); return }
        pending += decoder.write(chunk)
        const lines = pending.split(/\r?\n/)
        pending = lines.pop()
        for (const value of lines) {
          line(value, !truncated)
          truncated = false
        }
        if (pending.length > 4096) {
          line(pending.slice(0, 4096), false)
          pending = pending.slice(-4096)
          truncated = true
        }
      })
      stream.on('error', reject)
      stream.on('end', () => {
        pending += decoder.end()
        if (pending) line(pending, false)
        resolve()
      })
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
  receipt.finishedAt = new Date().toISOString()
  receipt.processState = receipt.state
  const tapSummary = !invalidTap && tapIndex === tapFields.length && tapCounts.cancelled === 0
    ? `${tapCounts.pass} passed | ${tapCounts.fail} failed | ${tapCounts.skipped} skipped | ${tapCounts.todo} todo (${tapCounts.tests})`
    : null
  receipt.validation = testEvidence(expectTests || testSummaries.length > 0 || tapSummary,
    nativeNodeTest ? [] : testSummaries, receipt.processState, tapSummary)
  if (receipt.processState === 'PASS' && !['SUFFICIENT', 'NOT_APPLICABLE'].includes(receipt.validation.state)) {
    receipt.state = receipt.validation.state === 'FAILED' ? 'FAIL' : receipt.validation.state
    receipt.diagnostic = receipt.validation.reason || 'Test summary reports failures.'
  }
  if (connection) {
    try { receipt.ledger.after = await connection.snapshot() }
    catch (error) { const diagnostic = publicError(error); registrationDiagnostic ??= diagnostic; diagnostics.push(diagnostic) }
  }
  const recordedAcceptance = options.acceptance !== undefined
    ? { present: true, raw: options.acceptance }
    : readRecordedAcceptance(acceptancePath)
  if (recordedAcceptance.present) {
    const evaluation = evaluateAcceptanceSummary(recordedAcceptance.raw, receipt.ledger)
    receipt.acceptance = evaluation.acceptance
    if (!evaluation.sufficient && receipt.processState === 'PASS' && ['SUFFICIENT', 'NOT_APPLICABLE'].includes(receipt.validation.state)) {
      receipt.validation = { ...receipt.validation, state: 'INSUFFICIENT', reason: evaluation.reason }
      receipt.state = 'INSUFFICIENT'
      receipt.diagnostic = evaluation.reason
    }
  }
  receipt.digest = receiptDigest(receipt)
  receipt.registration = {
    state: 'REGISTRATION_PENDING',
    reason: requestedRegistration ? registrationDiagnostic?.code || 'APP_UNAVAILABLE' : 'REGISTRATION_NOT_REQUESTED',
    ...(registrationDiagnostic ? { diagnostic: registrationDiagnostic } : {})
  }
  save()
  if (connection && requestedRegistration) {
    try { receipt.registration = await sendRegistration(receipt.cwd, connection, receipt, deliveryContext ? { deliveryContext } : {}) }
    catch (error) {
      const diagnostic = publicError(error)
      receipt.registration = { state: 'REGISTRATION_PENDING', reason: diagnostic.code, diagnostic }
    }
    if (receipt.registration.state === 'PERSISTED') {
      try { receipt.reconciliation = await reconcileReceipts({ cwd: path.resolve(options.cwd || root), connection, exclude: id, limit: 3, scanLimit: 200 }) } catch (error) { diagnostics.push(publicError(error)) }
    } else {
      try {
        const pending = pendingReceiptIds(path.resolve(options.cwd || root), { limit: 1, exclude: id, scanLimit: 200 }).pending
        if (pending > 0) receipt.reconciliation = { reconciled: [], remaining: pending }
      } catch { }
    }
  } else if (requestedRegistration) {
    try {
      const pending = pendingReceiptIds(path.resolve(options.cwd || root), { limit: 1, exclude: id, scanLimit: 200 }).pending
      if (pending > 0) receipt.reconciliation = { reconciled: [], remaining: pending }
    } catch { }
  }
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

async function runSequence(phases, options = {}) {
  if (!Array.isArray(phases) || phases.length === 0) throw new Error('Sequence requires at least one phase')
  const started = Date.now()
  const results = []
  let state = 'PASS'
  let exitCode = 0
  let failedPhaseIndex = null

  for (let index = 0; index < phases.length; index++) {
    if (options.signal?.aborted) {
      state = 'CANCELLED'
      exitCode = 1
      failedPhaseIndex = index
      break
    }
    const phase = phases[index]
    if (!phase?.command) throw new Error(`Sequence phase ${index} requires a command`)
    let phaseTimeoutMs = phase.timeoutMs
    if (options.timeoutMs !== undefined) {
      const remainingMs = options.timeoutMs - (Date.now() - started)
      if (remainingMs <= 0) {
        state = 'TIMEOUT'
        exitCode = null
        failedPhaseIndex = index
        break
      }
      phaseTimeoutMs = phaseTimeoutMs !== undefined ? Math.min(phaseTimeoutMs, remainingMs) : remainingMs
    }
    const receipt = await run(phase.command, phase.args || [], {
      cwd: phase.cwd ?? options.cwd,
      evidenceRoot: phase.evidenceRoot ?? options.evidenceRoot,
      expectTests: phase.expectTests ?? options.expectTests,
      association: phase.association ?? options.association,
      deliveryContext: phase.deliveryContext ?? options.deliveryContext,
      profile: phase.profile ?? options.profile,
      register: phase.register ?? options.register,
      env: options.env || phase.env ? { ...options.env, ...phase.env } : undefined,
      signal: options.signal,
      timeoutMs: phaseTimeoutMs
    })
    results.push(receipt)
    if (receipt.state !== 'PASS') {
      state = receipt.state
      exitCode = receipt.exitCode === undefined ? 1 : receipt.exitCode
      failedPhaseIndex = index
      break
    }
  }

  return {
    version: 1,
    state,
    exitCode,
    durationMs: Date.now() - started,
    completedPhases: results.length,
    totalPhases: phases.length,
    failedPhaseIndex,
    phases: results
  }
}

function projectSequence(sequence) {
  return JSON.stringify({
    state: sequence.state,
    exitCode: sequence.exitCode,
    durationMs: sequence.durationMs,
    completedPhases: sequence.completedPhases,
    totalPhases: sequence.totalPhases,
    failedPhaseIndex: sequence.failedPhaseIndex,
    phases: sequence.phases.map(receipt => JSON.parse(project(receipt)))
  })
}

function splitSequenceArgs(args) {
  const groups = [[]]
  for (const token of args) {
    if (token === '---') { groups.push([]); continue }
    groups[groups.length - 1].push(token)
  }
  return groups.map((group, index) => {
    const command = group.shift()
    if (!command) throw new Error(`Sequence phase ${index} requires a command`)
    const [executable, parameters] = resolveCommand(command, group)
    return { command: executable, args: parameters }
  })
}

function parseDeliveryContextInput(raw) {
  if (raw === undefined || raw === null || raw === '') return undefined
  let parsed = raw
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw) } catch { throw Object.assign(new Error('DELIVERY_CONTEXT_INVALID'), { code: 'DELIVERY_CONTEXT_INVALID' }) }
  }
  const failCtx = () => { throw Object.assign(new Error('DELIVERY_CONTEXT_INVALID'), { code: 'DELIVERY_CONTEXT_INVALID' }) }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) failCtx()
  const keys = Object.keys(parsed)
  if (keys.length !== 5 || ['bindingArtifactId', 'bindingRevision', 'planArtifactId', 'planRevision', 'executionId'].some(k => !Object.hasOwn(parsed, k))) failCtx()
  if (typeof parsed.bindingArtifactId !== 'string' || !/^artifact-execution-branch-[a-f0-9]{64}$/.test(parsed.bindingArtifactId)) failCtx()
  if (!Number.isInteger(parsed.bindingRevision) || parsed.bindingRevision < 1) failCtx()
  if (typeof parsed.planArtifactId !== 'string' || !/^artifact-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(parsed.planArtifactId)) failCtx()
  if (!Number.isInteger(parsed.planRevision) || parsed.planRevision < 1) failCtx()
  if (typeof parsed.executionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(parsed.executionId)) failCtx()
  return parsed
}

function parseRunOptions(args, allowHuman = true) {
  let human = false; let timeoutMs; let expectTests = false; let association; let profile; let deliveryContext
  while (args.length && args[0] !== '--') {
    const flag = args.shift()
    if (allowHuman && flag === '--human') human = true
    else if (flag === '--expect-tests') expectTests = true
    else if (flag === '--association') association = JSON.parse(args.shift())
    else if (flag === '--delivery-context') deliveryContext = parseDeliveryContextInput(args.shift())
    else if (flag === '--profile') profile = args.shift()
    else if (flag === '--timeout-ms') { timeoutMs = Number(args.shift()); if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid timeout') }
    else throw new Error('Invalid run option')
  }
  if (args.shift() !== '--') throw new Error('Options must be terminated by --')
  return { human, timeoutMs, expectTests, association, deliveryContext, profile }
}

async function cli() {
  const args = process.argv.slice(2)
  const action = args.shift()
  if (action === 'register') {
    const id = args.shift(); let association; let profile; let deliveryContext
    while (args.length) {
      const flag = args.shift(), value = args.shift()
      if (value === undefined) throw new Error('Invalid registration option')
      if (flag === '--association') association = JSON.parse(value)
      else if (flag === '--delivery-context') deliveryContext = parseDeliveryContextInput(value)
      else if (flag === '--profile') profile = value
      else throw new Error('Invalid registration option')
    }
    console.log(JSON.stringify(await registerReceipt(id, { cwd: root, profile, association, deliveryContext }))); return
  }
  if (action === 'reconcile') {
    let id, limit, cursor, profile, association, deliveryContext
    while (args.length) {
      const flag = args.shift(), value = args.shift()
      if (value === undefined) throw new Error('Invalid reconcile option')
      if (flag === '--receipt') id = value
      else if (flag === '--limit') limit = Number(value)
      else if (flag === '--cursor') cursor = value
      else if (flag === '--profile') profile = value
      else if (flag === '--association') association = JSON.parse(value)
      else if (flag === '--delivery-context') deliveryContext = parseDeliveryContextInput(value)
      else throw new Error('Invalid reconcile option')
    }
    console.log(JSON.stringify(await reconcileReceipts({ cwd: root, profile, id, ...(association ? { association } : {}), ...(deliveryContext ? { deliveryContext } : {}), ...(limit === undefined ? {} : { limit }), ...(cursor ? { cursor } : {}) }))); return
  }
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
  if (action === 'sequence') {
    const { timeoutMs, expectTests, association, deliveryContext, profile } = parseRunOptions(args, false)
    const phases = splitSequenceArgs(args)
    const sequence = await runSequence(phases, { timeoutMs, expectTests, association, deliveryContext, profile })
    console.log(projectSequence(sequence))
    process.exitCode = sequence.state === 'PASS' ? 0 : sequence.exitCode || 1
    return
  }
  if (action !== 'run') throw new Error('Use run [--human] [--expect-tests] [--timeout-ms N] -- command args; sequence [--expect-tests] [--timeout-ms N] -- cmd1 --- cmd2; inspect id; reconcile [--receipt id] [--limit N]; clean id')
  const { human, timeoutMs, expectTests, association, deliveryContext, profile } = parseRunOptions(args, true)
  const command = args.shift()
  if (!command) throw new Error('Command required')
  const [executable, parameters] = resolveCommand(command, args)
  if (human || process.env.CODE_AWARENESS_TEST_CAPTURE === '1') {
    const result = spawnSync(executable, parameters, { cwd: root, env: { ...process.env, CODE_AWARENESS_TEST_CAPTURE: '1' }, stdio: 'inherit', timeout: timeoutMs })
    process.exitCode = result.status === null ? 1 : result.status
    if (result.error) console.error(result.error.message)
    return
  }
  const receipt = await run(executable, parameters, { timeoutMs, expectTests, association, deliveryContext, profile })
  console.log(project(receipt))
  process.exitCode = receipt.state === 'PASS' ? 0 : receipt.exitCode || 1
}

if (require.main === module) cli().catch(error => { console.error(bounded(error.message, 500)); process.exitCode = 1 })
module.exports = { run, runSequence, project, projectSequence, inspect, observe, limits, resolveCommand, protectDirectory }
