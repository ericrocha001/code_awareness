const fs = require('node:fs')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const { connect } = require('./client.cjs')
const { readDescriptor, publicError } = require('./discovery.cjs')

const receiptIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const digestPattern = /^[a-f0-9]{64}$/

async function validationConnection(cwd, profile) {
  const descriptor = readDescriptor(profile, { directory: 'local-agent-channel', protocol: 'code-awareness-local/v1' })
  const send = async (action, args, onSnapshotDiagnostic) => {
    const start = performance.now()
    try { return await connect(descriptor, { domain: 'validation', action, args }, { timeoutMs: action === 'resolve' ? 2000 : 12000, onSnapshotDiagnostic }) }
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
  return { identity, snapshot: onDiagnostic => send('snapshot', selection, onDiagnostic), lookup, register }
}

async function registerReceipt(id, { cwd = process.cwd(), profile, association } = {}) {
  if (!receiptIdPattern.test(id)) throw new Error('INVALID_RECEIPT_ID')
  const connection = await validationConnection(cwd, profile)
  const file = path.join(cwd, '.code-awareness', 'test-output', id, 'receipt.json')
  let directory = cwd
  for (const segment of ['.code-awareness', 'test-output', id]) {
    directory = path.join(directory, segment)
    const stat = fs.lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Object.assign(new Error('INVALID_RECEIPT_PATH'), { code: 'INVALID_RECEIPT_PATH' })
  }
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) throw Object.assign(new Error('INVALID_RECEIPT_PATH'), { code: 'INVALID_RECEIPT_PATH' })
  const { digest } = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!digestPattern.test(digest)) throw Object.assign(new Error('INVALID_RECEIPT'), { code: 'INVALID_RECEIPT' })
  let result = await connection.lookup(id, digest, association)
  if (result.state === 'NOT_FOUND') result = await connection.lookup(id, digest, association)
  if (result.state === 'PERSISTED') return result
  if (result.state === 'NOT_FOUND') return connection.register(id, digest, association)
  const code = result.code || 'RECEIPT_LOOKUP_UNAVAILABLE'
  throw Object.assign(new Error(code), { code, stage: 'response', reason: 'SERVER_REJECTED', operation: 'lookup' })
}
module.exports = { validationConnection, registerReceipt }
