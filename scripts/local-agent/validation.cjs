const fs = require('node:fs')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const { connect } = require('./client.cjs')
const { readDescriptor, publicError } = require('./discovery.cjs')
const { receiptDigest } = require('../../src/shared/validation/test-output-receipt.cjs')

const receiptIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const digestPattern = /^[a-f0-9]{64}$/
const invalid = code => Object.assign(new Error(code), { code })
const transientCodes = new Set(['IPC_TIMEOUT', 'IPC_CLOSED', 'APP_UNAVAILABLE', 'RECEIPT_LOOKUP_UNAVAILABLE'])
const honestCodes = new Set(['AMBIGUOUS', 'SOURCE_CHANGED', 'UNAVAILABLE'])

async function validationConnection(cwd, profile) {
  const descriptor = readDescriptor(profile, { directory: 'local-agent-channel', protocol: 'code-awareness-local/v1' })
  const send = async (action, args) => {
    const start = performance.now()
    try { return await connect(descriptor, { domain: 'validation', action, args }, { timeoutMs: action === 'resolve' ? 2000 : 12000 }) }
    catch (error) { error.operation = action; error.elapsedMs = Math.round(performance.now() - start); throw error }
  }
  const identity = await send('resolve', { cwd })
  const selection = { ...identity, cwd }
  const lookup = (receiptId, digest, association) => send('lookup', { ...selection, receiptId, digest, ...(association ? { association } : {}) })
  const register = async (receiptId, digest, association) => {
    try { return await send('register', { ...selection, receiptId, digest, ...(association ? { association } : {}) }) }
    catch (error) {
      if (error.code !== 'IPC_TIMEOUT' || error.stage !== 'response') throw error
      let recovery
      try {
        recovery = await lookup(receiptId, digest, association)
        if (recovery.state === 'NOT_FOUND') recovery = await lookup(receiptId, digest, association)
      } catch (lookupError) {
        recovery = { state: 'UNAVAILABLE', diagnostic: publicError(lookupError) }
      }
      if (recovery.state === 'PERSISTED') return recovery
      return { state: 'REGISTRATION_PENDING', reason: 'IPC_TIMEOUT', diagnostic: publicError(error), recovery }
    }
  }
  return { identity, snapshot: () => send('snapshot', selection), lookup, register }
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
  if (receipt.id !== id || !digestPattern.test(receipt.digest) || receiptDigest(receipt) !== receipt.digest) {
    throw invalid('INVALID_RECEIPT')
  }
  return { file, receipt }
}

function persistRegistration(file, expected, registration) {
  const current = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (current.id !== expected.id || current.digest !== expected.digest) throw invalid('INVALID_RECEIPT')
  const next = {
    ...current,
    registration: { ...registration, attempts: (current.registration?.attempts || 0) + 1, lastAttemptAt: new Date().toISOString() }
  }
  const temporary = `${file}.${process.pid}.tmp`
  try {
    fs.writeFileSync(temporary, JSON.stringify(next, null, 2), { mode: 0o600, flag: 'wx' })
    fs.renameSync(temporary, file)
  } finally { fs.rmSync(temporary, { force: true }) }
  return next.registration
}

function failureRegistration(error) {
  const diagnostic = publicError(error)
  const code = error.code || diagnostic.code || 'UNAVAILABLE'
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

async function resolveRegistration(connection, receipt, association) {
  const { id, digest } = receipt
  if (identityConflict(receipt, connection)) return { state: 'SOURCE_CHANGED', reason: 'RECEIPT_IDENTITY_MISMATCH' }
  try {
    let result = await connection.lookup(id, digest, association)
    if (result.state === 'NOT_FOUND') result = await connection.lookup(id, digest, association)
    if (result.state === 'PERSISTED') return result
    if (result.state === 'NOT_FOUND') return await connection.register(id, digest, association)
    const reason = result.code || result.state || 'RECEIPT_LOOKUP_UNAVAILABLE'
    return honestCodes.has(result.state) ? { state: result.state, reason } : { state: 'REGISTRATION_PENDING', reason }
  } catch (error) { return failureRegistration(error) }
}

async function reconcileReceipt(id, { cwd, connection, association }) {
  const { file, receipt } = readReceipt(cwd, id)
  if (receipt.registration?.state === 'PERSISTED' && receipt.registration.proofId) {
    return { id, registration: receipt.registration, changed: false }
  }
  const outcome = await resolveRegistration(connection, receipt, association)
  return { id, registration: persistRegistration(file, receipt, outcome), changed: true }
}

function pendingReceiptIds(cwd, { limit = 5, cursor, exclude, scanLimit = 200 } = {}) {
  const root = path.join(cwd, '.code-awareness', 'test-output')
  let entries
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch (error) { if (error.code === 'ENOENT') return { ids: [], pending: 0 }; throw error }
  const candidates = entries
    .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && receiptIdPattern.test(entry.name) && entry.name !== exclude)
    .map(entry => { try { return { id: entry.name, time: fs.statSync(path.join(root, entry.name, 'receipt.json')).mtimeMs } } catch { return null } })
    .filter(Boolean)
    .sort((a, b) => b.time - a.time || a.id.localeCompare(b.id))
    .slice(0, scanLimit)
  const pending = []
  for (const { id } of candidates) {
    try {
      const { receipt } = readReceipt(cwd, id)
      const registration = receipt.registration
      if ((registration?.state === 'REGISTRATION_PENDING' || registration?.state === 'UNAVAILABLE') &&
        registration.reason !== 'REGISTRATION_NOT_REQUESTED') {
        pending.push(id)
      }
    } catch { continue }
  }
  const offset = cursor ? pending.indexOf(cursor) + 1 : 0
  if (cursor && offset === 0) throw invalid('INVALID_CURSOR')
  const slice = pending.slice(offset, offset + limit)
  const remainingAfter = Math.max(0, pending.length - (offset + slice.length))
  return { ids: slice, pending: pending.length - offset, ...(remainingAfter > 0 ? { nextCursor: slice[slice.length - 1] } : {}) }
}

async function reconcileReceipts({ cwd = process.cwd(), profile, id, limit = 5, cursor, association, connection, exclude } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw invalid('INVALID_LIMIT')
  if (id) readReceipt(cwd, id)
  const selected = id ? { ids: [id], pending: 1, nextCursor: null } : pendingReceiptIds(cwd, { limit, cursor, exclude })
  if (!selected.ids.length) return { reconciled: [], remaining: 0 }
  const active = connection || await validationConnection(cwd, profile)
  const reconciled = []
  for (const receiptId of selected.ids) {
    const outcome = await reconcileReceipt(receiptId, { cwd, connection: active, association })
    const reg = outcome.registration
    reconciled.push({
      id: receiptId,
      state: reg.state,
      ...(reg.proofId ? { proofId: reg.proofId, ...(reg.freshness ? { freshness: reg.freshness } : {}), ...(reg.trust ? { trust: reg.trust } : {}), ...(reg.status ? { ledgerStatus: reg.status } : {}) } : {}),
      ...(reg.reason ? { reason: reg.reason } : {})
    })
  }
  const stillPending = reconciled.filter(entry => entry.state === 'REGISTRATION_PENDING' || entry.state === 'UNAVAILABLE').length
  const remaining = id ? (stillPending > 0 ? 1 : 0) : stillPending + Math.max(0, selected.pending - selected.ids.length)
  return { reconciled, remaining, ...(selected.nextCursor ? { nextCursor: selected.nextCursor } : {}) }
}

async function registerReceipt(id, { cwd = process.cwd(), profile, association } = {}) {
  const [outcome] = (await reconcileReceipts({ cwd, profile, id, association })).reconciled
  return outcome
}

module.exports = { validationConnection, registerReceipt, reconcileReceipts, pendingReceiptIds }
