const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { receiptDigest } = require('../../src/shared/validation/test-output-receipt.cjs')
const { reconcileReceipts, registerReceipt, pendingReceiptIds } = require('./validation.cjs')

function workspace(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-'))
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }))
  return cwd
}

function writeReceipt(cwd, registration, extra = {}, mtimeMs) {
  const id = randomUUID()
  const directory = path.join(cwd, '.code-awareness', 'test-output', id)
  fs.mkdirSync(directory, { recursive: true })
  const receipt = { version: 1, id, command: ['node', 'x'], state: 'PASS', exitCode: 0, ...extra }
  receipt.digest = receiptDigest(receipt)
  receipt.registration = registration
  fs.writeFileSync(path.join(directory, 'stdout.log'), 'full log')
  const file = path.join(directory, 'receipt.json')
  fs.writeFileSync(file, JSON.stringify(receipt, null, 2))
  if (mtimeMs !== undefined) { const at = new Date(mtimeMs); fs.utimesSync(file, at, at) }
  return { id, directory, file, digest: receipt.digest }
}

const pendingTimeout = { state: 'REGISTRATION_PENDING', reason: 'IPC_TIMEOUT' }
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'))

function ledger() {
  const proofs = new Map(), calls = []
  const connection = {
    calls,
    proofs,
    commit(id, digest) { if (!proofs.has(`${id}:${digest}`)) proofs.set(`${id}:${digest}`, { proofId: `proof-${proofs.size + 1}`, freshness: 'UNVERIFIABLE' }) },
    lookup: async (id, digest) => { calls.push('lookup'); const proof = proofs.get(`${id}:${digest}`); return proof ? { state: 'PERSISTED', ...proof } : { state: 'NOT_FOUND' } },
    register: async (id, digest) => { calls.push('register'); connection.commit(id, digest); return { state: 'PERSISTED', ...proofs.get(`${id}:${digest}`) } }
  }
  return connection
}

test('timeout after Ledger commit reconciles by lookup without a second proof or write', async t => {
  const cwd = workspace(t), receipt = writeReceipt(cwd, pendingTimeout), connection = ledger()
  connection.commit(receipt.id, receipt.digest)
  const result = await reconcileReceipts({ cwd, connection })
  assert.deepEqual(result.reconciled.map(entry => [entry.id, entry.state, entry.proofId]), [[receipt.id, 'PERSISTED', 'proof-1']])
  assert.equal(connection.calls.includes('register'), false)
  assert.equal(connection.proofs.size, 1)
  const saved = read(receipt.file)
  assert.equal(saved.registration.state, 'PERSISTED')
  assert.equal(saved.digest, receipt.digest)
  assert.equal(receiptDigest(saved), receipt.digest)
  const replay = await reconcileReceipts({ cwd, connection })
  assert.deepEqual(replay, { reconciled: [], remaining: 0 })
})

test('failure before commit registers exactly once after restart and keeps the logs', async t => {
  const cwd = workspace(t), receipt = writeReceipt(cwd, pendingTimeout), connection = ledger()
  const unavailable = { ...connection, lookup: async () => { throw Object.assign(new Error('APP_UNAVAILABLE'), { code: 'APP_UNAVAILABLE' }) } }
  const first = await reconcileReceipts({ cwd, connection: unavailable })
  assert.equal(first.reconciled[0].state, 'REGISTRATION_PENDING')
  assert.equal(first.reconciled[0].reason, 'APP_UNAVAILABLE')
  assert.equal(first.remaining, 1)
  assert.equal(fs.readFileSync(path.join(receipt.directory, 'stdout.log'), 'utf8'), 'full log')
  const second = await reconcileReceipts({ cwd, connection })
  assert.equal(second.reconciled[0].state, 'PERSISTED')
  assert.equal(connection.proofs.size, 1)
  assert.equal(connection.calls.filter(call => call === 'register').length, 1)
  assert.equal(read(receipt.file).registration.attempts, 2)
})

test('persistent response timeout during register stays pending and recoverable', async t => {
  const cwd = workspace(t), receipt = writeReceipt(cwd, pendingTimeout), connection = ledger()
  const timing = { ...connection, register: async () => ({ state: 'REGISTRATION_PENDING', reason: 'IPC_TIMEOUT', recovery: { state: 'NOT_FOUND' } }) }
  const result = await reconcileReceipts({ cwd, connection: timing })
  assert.equal(result.reconciled[0].state, 'REGISTRATION_PENDING')
  assert.equal(read(receipt.file).registration.recovery.state, 'NOT_FOUND')
  assert.equal(pendingReceiptIds(cwd).ids[0], receipt.id)
})

test('SOURCE_CHANGED and server rejections are never promoted nor retried in batches', async t => {
  const cwd = workspace(t), changed = writeReceipt(cwd, pendingTimeout), rejected = writeReceipt(cwd, pendingTimeout), connection = ledger()
  const failing = { ...connection, lookup: async id => { throw Object.assign(new Error('x'), { code: id === changed.id ? 'SOURCE_CHANGED' : 'RECEIPT_IDENTITY_MISMATCH' }) } }
  const result = await reconcileReceipts({ cwd, connection: failing })
  const states = Object.fromEntries(result.reconciled.map(entry => [entry.id, entry.state]))
  assert.deepEqual(states, { [changed.id]: 'SOURCE_CHANGED', [rejected.id]: 'REGISTRATION_REJECTED' })
  assert.equal(connection.proofs.size, 0)
  assert.deepEqual(pendingReceiptIds(cwd), { ids: [], pending: 0 })
})

test('discovery selects only requested pending receipts, honors the batch limit and reports the remainder', async t => {
  const cwd = workspace(t), connection = ledger()
  const pending = [writeReceipt(cwd, pendingTimeout), writeReceipt(cwd, pendingTimeout), writeReceipt(cwd, pendingTimeout)]
  writeReceipt(cwd, { state: 'REGISTRATION_PENDING', reason: 'REGISTRATION_NOT_REQUESTED' })
  writeReceipt(cwd, { state: 'PERSISTED', proofId: 'proof-X' })
  const result = await reconcileReceipts({ cwd, connection, limit: 2 })
  assert.equal(result.reconciled.length, 2)
  assert.equal(result.remaining, 1)
  assert.equal(connection.proofs.size, 2)
  assert.ok(result.reconciled.every(entry => pending.some(receipt => receipt.id === entry.id)))
  await assert.rejects(reconcileReceipts({ cwd, connection, limit: 0 }), { code: 'INVALID_LIMIT' })
})

test('explicit receipt reconciliation refuses tampered identity, traversal and symlinks', async t => {
  const cwd = workspace(t), receipt = writeReceipt(cwd, pendingTimeout), connection = ledger()
  const stored = read(receipt.file)
  fs.writeFileSync(receipt.file, JSON.stringify({ ...stored, id: randomUUID() }))
  await assert.rejects(reconcileReceipts({ cwd, connection, id: receipt.id }), { code: 'INVALID_RECEIPT' })
  await assert.rejects(registerReceipt('../escape', { cwd }), { code: 'INVALID_RECEIPT_ID' })
  const link = randomUUID(), outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'))
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }))
  try { fs.symlinkSync(outside, path.join(cwd, '.code-awareness', 'test-output', link), 'junction') } catch { return }
  await assert.rejects(reconcileReceipts({ cwd, connection, id: link }), { code: 'INVALID_RECEIPT_PATH' })
  assert.equal(connection.calls.length, 0)
})

test('cursor pagination reconciles all pending pages after prior pages persist without INVALID_CURSOR, duplicates or omissions', async t => {
  const cwd = workspace(t), connection = ledger(), base = 1790000000000
  const pending = [0, 1, 2].map(offset => writeReceipt(cwd, pendingTimeout, {}, base + offset * 1000))
  const page1 = await reconcileReceipts({ cwd, connection, limit: 2 })
  assert.equal(page1.reconciled.length, 2)
  assert.equal(page1.remaining, 1)
  assert.ok(page1.nextCursor)
  const page2 = await reconcileReceipts({ cwd, connection, limit: 2, cursor: page1.nextCursor })
  assert.equal(page2.reconciled.length, 1)
  assert.equal(page2.remaining, 0)
  assert.equal(page2.nextCursor, undefined)
  const processed = [...page1.reconciled, ...page2.reconciled].map(entry => entry.id)
  assert.equal(new Set(processed).size, 3)
  assert.deepEqual(new Set(processed), new Set(pending.map(item => item.id)))
  assert.equal(connection.proofs.size, 3)
  assert.deepEqual(pendingReceiptIds(cwd), { ids: [], pending: 0 })
})

test('bounded scan reports partialCoverage under scanLimit and reaches older pending receipts behind >200 healthy ones', async t => {
  const base = 1790000000000
  const cwdWindow = workspace(t), connWindow = ledger()
  const oldWindow = writeReceipt(cwdWindow, pendingTimeout, {}, base)
  for (let i = 1; i <= 205; i++) writeReceipt(cwdWindow, { state: 'PERSISTED', proofId: `proof-w-${i}` }, {}, base + i * 1000)
  const firstWindow = await reconcileReceipts({ cwd: cwdWindow, connection: connWindow, limit: 2, scanLimit: 200 })
  assert.deepEqual(firstWindow.reconciled, [])
  assert.equal(firstWindow.partialCoverage, true)
  assert.ok(firstWindow.nextCursor)
  const secondWindow = await reconcileReceipts({ cwd: cwdWindow, connection: connWindow, limit: 2, scanLimit: 200, cursor: firstWindow.nextCursor })
  assert.deepEqual(secondWindow.reconciled.map(entry => [entry.id, entry.state]), [[oldWindow.id, 'PERSISTED']])
  assert.equal(secondWindow.remaining, 0)
  assert.equal(secondWindow.partialCoverage, undefined)
  assert.equal(fs.readFileSync(path.join(oldWindow.directory, 'stdout.log'), 'utf8'), 'full log')

  const cwdMulti = workspace(t), connMulti = ledger()
  const oldMulti = writeReceipt(cwdMulti, pendingTimeout, {}, base)
  for (let i = 1; i <= 205; i++) writeReceipt(cwdMulti, { state: 'PERSISTED', proofId: `proof-m-${i}` }, {}, base + i * 1000)
  const found = await reconcileReceipts({ cwd: cwdMulti, connection: connMulti })
  assert.deepEqual(found.reconciled.map(entry => [entry.id, entry.state]), [[oldMulti.id, 'PERSISTED']])
  assert.equal(found.remaining, 0)
  assert.equal(connMulti.proofs.size, 1)
})
