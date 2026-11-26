const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { isDeepStrictEqual } = require('node:util')
const { lock } = require('proper-lockfile')
const { performance } = require('node:perf_hooks')
const { connect } = require('./client.cjs')
const { readDescriptor, publicError } = require('./discovery.cjs')
const { receiptDigest } = require('../../src/shared/validation/test-output-receipt.cjs')

const receiptIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const digestPattern = /^[a-f0-9]{64}$/
const invalid = code => Object.assign(new Error(code), { code })
const transientCodes = new Set(['IPC_TIMEOUT', 'IPC_CLOSED', 'APP_UNAVAILABLE', 'RECEIPT_LOOKUP_UNAVAILABLE'])
const honestCodes = new Set(['AMBIGUOUS', 'SOURCE_CHANGED', 'UNAVAILABLE'])
const uncertainResponseCodes = new Set(['IPC_TIMEOUT', 'IPC_CLOSED', 'IPC_PROTOCOL_ERROR', 'RESPONSE_TOO_LARGE', 'APP_UNAVAILABLE'])
const equalIntent = (left, right) => isDeepStrictEqual(left, right, { skipPrototype: true })

async function validationConnection(cwd, profile) {
  const descriptor = readDescriptor(profile, { directory: 'local-agent-channel', protocol: 'code-awareness-local/v1' })
  const send = async (action, args, onSnapshotDiagnostic) => {
    const start = performance.now()
    try { return await connect(descriptor, { domain: 'validation', action, args }, { timeoutMs: action === 'resolve' ? 2000 : 12000, onSnapshotDiagnostic }) }
    catch (error) { error.operation = action; error.elapsedMs = Math.round(performance.now() - start); throw error }
  }
  const identity = await send('resolve', { cwd })
  const selection = { ...identity, cwd }
  const lookup = (receiptId, digest, association, deliveryContext) => send('lookup', { ...selection, receiptId, digest, ...(association ? { association } : {}), ...(deliveryContext ? { deliveryContext } : {}) })
  const register = async (receiptId, digest, association, deliveryContext, requireUnmanaged) => {
    try { return await send('register', { ...selection, receiptId, digest, ...(association ? { association } : {}), ...(deliveryContext ? { deliveryContext } : {}), ...(requireUnmanaged ? { requireUnmanaged: true } : {}) }) }
    catch (error) {
      if (error.stage !== 'response' || error.reason === 'SERVER_REJECTED' ||
        !uncertainResponseCodes.has(error.code)) throw error
      let recovery
      try {
        recovery = await lookup(receiptId, digest, association, deliveryContext)
        if (recovery.state === 'NOT_FOUND') recovery = await lookup(receiptId, digest, association, deliveryContext)
      } catch (lookupError) {
        recovery = { state: 'UNAVAILABLE', diagnostic: publicError(lookupError) }
      }
      if (recovery.state === 'PERSISTED') return recovery
      if (recovery.state === 'AMBIGUOUS' || recovery.state === 'SOURCE_CHANGED') return lookupFailure(recovery)
      return { state: 'REGISTRATION_PENDING', reason: error.code, diagnostic: publicError(error), recovery }
    }
  }
  return { identity, snapshot: onDiagnostic => send('snapshot', selection, onDiagnostic), lookup, register }
}

function receiptFile(cwd, id) {
  if (!receiptIdPattern.test(id)) throw invalid('INVALID_RECEIPT_ID')
  let directory = fs.realpathSync(cwd)
  for (const segment of ['.code-awareness', 'test-output', id]) {
    directory = path.join(directory, segment)
    const stat = fs.lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || path.resolve(fs.realpathSync(directory)) !== path.resolve(directory)) {
      throw invalid('INVALID_RECEIPT_PATH')
    }
  }
  const file = path.join(directory, 'receipt.json')
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024 || path.resolve(fs.realpathSync(file)) !== path.resolve(file)) {
    throw invalid('INVALID_RECEIPT_PATH')
  }
  return file
}

function readReceipt(cwd, id) {
  const file = receiptFile(cwd, id)
  const receipt = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (receipt.id !== id || !digestPattern.test(receipt.digest)) throw invalid('INVALID_RECEIPT')
  if (receiptDigest(receipt) !== receipt.digest) throw invalid('RECEIPT_INTEGRITY_ERROR')
  return { file, receipt }
}

async function persistRegistration(cwd, id, digest, registration, intent) {
  const file = receiptFile(cwd, id)
  const release = await lock(file, { retries: { retries: 5, minTimeout: 10, maxTimeout: 100 } })
  try {
    const stat = fs.statSync(file)
    const { receipt: current } = readReceipt(cwd, id)
    if (current.digest !== digest) throw invalid('RECEIPT_CHANGED')
    const previous = current.registration
    if (previous?.intent && intent && !equalIntent(previous.intent, intent)) throw invalid('RECEIPT_IDENTITY_CONFLICT')
    if (previous?.state === 'PERSISTED') return previous
    const savedIntent = previous?.intent ?? intent
    const next = { ...current, registration: { ...registration, ...(savedIntent ? { intent: savedIntent } : {}),
      attempts: (previous?.attempts || 0) + (registration.state === 'REGISTERING' ? 0 : 1), lastAttemptAt: new Date().toISOString() } }
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      fs.writeFileSync(temporary, JSON.stringify(next, null, 2), { mode: 0o600, flag: 'wx' })
      // Reconciliation cursors use the original receipt mtime.
      fs.utimesSync(temporary, stat.atime, stat.mtime)
      fs.renameSync(temporary, file)
    } finally { fs.rmSync(temporary, { force: true }) }
    return next.registration
  } finally { await release() }
}

function failureRegistration(error) {
  const diagnostic = publicError(error)
  const code = error.code || diagnostic.code || 'UNAVAILABLE'
  if (code === 'REGISTRATION_TARGET_UNCONFIRMED' || code === 'ELOCKED') return { state: 'REGISTRATION_PENDING', reason: code, diagnostic }
  if (transientCodes.has(code)) return { state: 'REGISTRATION_PENDING', reason: code, diagnostic }
  if (honestCodes.has(code)) return { state: code, reason: code, diagnostic }
  return { state: 'REGISTRATION_REJECTED', reason: code, diagnostic }
}

function identityConflict(receipt, connection) {
  const recorded = receipt.ledger?.identity
  const current = connection.identity
  if (!recorded || !current) return false
  return recorded.repositoryId !== current.repositoryId ||
    recorded.worktreeId !== current.worktreeId ||
    recorded.generation !== current.generation
}

function registrationIntent(receipt, association, deliveryContext) {
  if ((receipt.ledger?.association?.evidenceFor?.length && association && !equalIntent(association, receipt.ledger.association)) ||
    (receipt.ledger?.deliveryContext && deliveryContext && !equalIntent(deliveryContext, receipt.ledger.deliveryContext))) throw invalid('RECEIPT_ASSOCIATION_CONFLICT')
  const previous = receipt.registration?.intent
  if (previous && ((association && !equalIntent(association, previous.association)) ||
    (deliveryContext && !equalIntent(deliveryContext, previous.deliveryContext)))) throw invalid('RECEIPT_IDENTITY_CONFLICT')
  return previous ?? {
    ...(association ? { association } : {}),
    ...((deliveryContext ?? receipt.ledger?.deliveryContext) ? { deliveryContext: deliveryContext ?? receipt.ledger.deliveryContext } : {})
  }
}

function lookupFailure(result) {
  const reason = result.code || result.state || 'RECEIPT_LOOKUP_UNAVAILABLE'
  return { state: honestCodes.has(result.state) ? result.state : 'REGISTRATION_PENDING', reason, recovery: result }
}

async function sendRegistration(cwd, connection, receipt, intent) {
  const { id, digest } = receipt
  const recorded = await persistRegistration(cwd, id, digest, { state: 'REGISTERING' }, intent)
  if (recorded.state === 'PERSISTED') return recorded
  let outcome
  try { outcome = await connection.register(id, digest, intent.association, intent.deliveryContext, intent.requireUnmanaged) }
  catch (error) { outcome = failureRegistration(error) }
  return persistRegistration(cwd, id, digest, outcome, intent)
}

async function resolveRegistration(cwd, connection, receipt, association, deliveryContext) {
  const { id, digest } = receipt
  const intent = registrationIntent(receipt, association, deliveryContext)
  if (identityConflict(receipt, connection)) return { state: 'SOURCE_CHANGED', reason: 'RECEIPT_IDENTITY_MISMATCH' }
  try {
    let result = await connection.lookup(id, digest, intent.association, intent.deliveryContext)
    if (result.state === 'NOT_FOUND') result = await connection.lookup(id, digest, intent.association, intent.deliveryContext)
    if (result.state === 'PERSISTED') return result
    if (result.state !== 'NOT_FOUND') return lookupFailure(result)
    if (receipt.registration?.state === 'PERSISTED') return { state: 'SOURCE_CHANGED', reason: 'RECEIPT_PROOF_UNAVAILABLE', recovery: result }
    const previous = receipt.registration
    const uncertain = previous?.state === 'REGISTERING' || previous?.reason === 'REGISTRATION_TARGET_UNCONFIRMED' ||
      (uncertainResponseCodes.has(previous?.reason) && (previous?.diagnostic?.stage === 'response' || previous?.recovery ||
        (!previous?.diagnostic && previous?.reason !== 'APP_UNAVAILABLE')))
    if (previous?.intent && !intent.deliveryContext && !intent.requireUnmanaged) {
      return { state: 'REGISTRATION_PENDING', reason: 'REGISTRATION_TARGET_UNCONFIRMED', recovery: result }
    }
    const legacyUncertain = uncertain && !previous?.intent
    if (legacyUncertain && !receipt.ledger?.deliveryContext) {
      if (intent.deliveryContext || receipt.ledger?.workValidationAuthorized) return { state: 'REGISTRATION_PENDING', reason: 'REGISTRATION_TARGET_UNCONFIRMED', recovery: result }
      intent.requireUnmanaged = true
    }
    return { saved: await sendRegistration(cwd, connection, receipt, intent) }
  } catch (error) { return failureRegistration(error) }
}

async function reconcileReceipt(id, { cwd, connection, association, deliveryContext }) {
  const { receipt } = readReceipt(cwd, id)
  const outcome = await resolveRegistration(cwd, connection, receipt, association, deliveryContext)
  const intent = outcome.state === 'PERSISTED' ? registrationIntent(receipt, association, deliveryContext) : undefined
  if (receipt.registration?.state === 'PERSISTED') return { id, registration: outcome, changed: false }
  return { id, registration: outcome.saved ?? await persistRegistration(cwd, id, receipt.digest, outcome, intent), changed: true }
}

function pendingReceiptIds(cwd, { limit = 5, cursor, exclude, scanLimit } = {}) {
  if (cursor && !receiptIdPattern.test(cursor)) throw invalid('INVALID_CURSOR')
  const root = path.join(cwd, '.code-awareness', 'test-output')
  let entries
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch (error) { if (error.code === 'ENOENT') return { ids: [], pending: 0 }; throw error }
  const candidates = entries
    .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && receiptIdPattern.test(entry.name) && entry.name !== exclude)
    .map(entry => { try { return { id: entry.name, time: Math.floor(fs.statSync(path.join(root, entry.name, 'receipt.json')).mtimeMs) } } catch { return null } })
    .filter(Boolean)
    .sort((a, b) => b.time - a.time || a.id.localeCompare(b.id))
  const startIndex = cursor ? candidates.findIndex(entry => entry.id === cursor) + 1 : 0
  if (cursor && startIndex === 0) throw invalid('INVALID_CURSOR')
  const budget = scanLimit ?? 200
  const maxBudget = scanLimit === undefined ? 1000 : budget
  const slice = []
  let extraPending = 0
  let i = startIndex
  for (; i < candidates.length; i++) {
    const scanned = i - startIndex
    if (scanned >= maxBudget) break
    if (scanned >= budget && (slice.length >= limit || (slice.length > 0 && extraPending > 0))) break
    try {
      const { receipt } = readReceipt(cwd, candidates[i].id)
      const registration = receipt.registration
      if ((registration?.state === 'REGISTRATION_PENDING' || registration?.state === 'UNAVAILABLE' || registration?.state === 'REGISTERING') &&
        registration.reason !== 'REGISTRATION_NOT_REQUESTED') {
        if (slice.length < limit) slice.push(candidates[i].id)
        else extraPending++
      }
    } catch { continue }
  }
  const partialCoverage = i < candidates.length
  const nextCursor = extraPending > 0 ? slice[slice.length - 1] : partialCoverage ? candidates[i - 1]?.id : undefined
  return { ids: slice, pending: slice.length + extraPending, ...(nextCursor ? { nextCursor } : {}), ...(partialCoverage ? { partialCoverage: true } : {}) }
}

async function reconcileReceipts({ cwd = process.cwd(), profile, id, limit = 5, cursor, scanLimit, association, deliveryContext, connection, exclude } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw invalid('INVALID_LIMIT')
  if (scanLimit !== undefined && (!Number.isSafeInteger(scanLimit) || scanLimit < 1)) throw invalid('INVALID_LIMIT')
  if (id) readReceipt(cwd, id)
  const selected = id ? { ids: [id], pending: 1 } : pendingReceiptIds(cwd, { limit, cursor, exclude, scanLimit })
  const tail = { ...(selected.nextCursor ? { nextCursor: selected.nextCursor } : {}), ...(selected.partialCoverage ? { partialCoverage: true } : {}) }
  if (!selected.ids.length) return { reconciled: [], remaining: 0, ...tail }
  const active = connection || await validationConnection(cwd, profile)
  const reconciled = []
  for (const receiptId of selected.ids) {
    let reg
    try { reg = (await reconcileReceipt(receiptId, { cwd, connection: active, association, deliveryContext })).registration }
    catch (error) {
      reg = ['RECEIPT_IDENTITY_CONFLICT', 'RECEIPT_ASSOCIATION_CONFLICT'].includes(error.code)
        ? { state: 'AMBIGUOUS', reason: error.code }
        : failureRegistration(error)
    }
    reconciled.push({
      id: receiptId,
      state: reg.state,
      ...(reg.proofId ? { proofId: reg.proofId, ...(reg.freshness ? { freshness: reg.freshness } : {}), ...(reg.trust ? { trust: reg.trust } : {}), ...(reg.status ? { ledgerStatus: reg.status } : {}) } : {}),
      ...(reg.reason ? { reason: reg.reason } : {})
    })
  }
  const stillPending = reconciled.filter(entry => entry.state === 'REGISTRATION_PENDING' || entry.state === 'UNAVAILABLE').length
  const remaining = id ? (stillPending > 0 ? 1 : 0) : stillPending + Math.max(0, selected.pending - selected.ids.length)
  return { reconciled, remaining, ...tail }
}

async function registerReceipt(id, { cwd = process.cwd(), profile, association, deliveryContext } = {}) {
  const { receipt } = readReceipt(cwd, id)
  const connection = await validationConnection(cwd, profile)
  if (identityConflict(receipt, connection)) throw invalid('RECEIPT_IDENTITY_MISMATCH')
  const outcome = await resolveRegistration(cwd, connection, receipt, association, deliveryContext)
  const intent = outcome.state === 'PERSISTED' ? registrationIntent(receipt, association, deliveryContext) : undefined
  const result = receipt.registration?.state === 'PERSISTED' ? outcome : outcome.saved ?? await persistRegistration(cwd, id, receipt.digest, outcome, intent)
  if (result.state === 'PERSISTED' || result.state === 'REGISTRATION_PENDING') {
    const { intent: _intent, attempts: _attempts, lastAttemptAt: _lastAttemptAt, ...summary } = result
    return { receiptId: id, ...summary }
  }
  const code = result.reason || 'RECEIPT_LOOKUP_UNAVAILABLE'
  throw Object.assign(new Error(code), { code, stage: 'response', reason: 'SERVER_REJECTED', operation: 'lookup' })
}

module.exports = { validationConnection, registerReceipt, reconcileReceipts, pendingReceiptIds, sendRegistration }
