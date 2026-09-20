import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { build } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'

test('Worker, SQLite Durable Object and D1 preserve isolation, correlation and zero-content persistence', async () => {
  const bundle = await build({ entryPoints: ['testing/cloud-test-worker.ts'], bundle: true, format: 'esm', platform: 'browser', external: ['cloudflare:workers'], write: false })
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-09-11', durableObjects: { RELAY: { className: 'InstallationRelay', useSQLite: true } }, d1Databases: ['REGISTRY'] }))
  const sockets = []
  try {
    const db = await mf.getD1Database('REGISTRY')
    const s1 = await readFile('migrations/0001_installations.sql', 'utf8')
    const s2 = await readFile('migrations/0002_enrollment.sql', 'utf8')
    const s3 = await readFile('migrations/0003_external_identities.sql', 'utf8')
    for (const statement of (s1 + '\n' + s2 + '\n' + s3).split(';').map((value) => value.trim()).filter(Boolean)) await db.prepare(statement).run()
    const id = randomUUID(), credential = 'x'.repeat(43)
    const canonicalUserA = 'canonical-user-a'
    const nowIso = new Date().toISOString()
    await db.prepare('INSERT INTO users VALUES (?, ?)').bind(canonicalUserA, nowIso).run()
    await db.prepare('INSERT INTO external_identities VALUES (?, ?, ?, ?)').bind('https://test.cloudflareaccess.com', 'user-a', canonicalUserA, nowIso).run()
    await db.prepare('INSERT INTO installations VALUES (?, ?, ?, ?, ?, ?)').bind(id, canonicalUserA, createHash('sha256').update(credential).digest('hex'), nowIso, null, 'ACTIVE').run()
    async function connect(secret = credential) {
      const response = await mf.dispatchFetch(`http://localhost/relay/${id}`, { headers: { Upgrade: 'websocket' } })
      assert.equal(response.status, 101)
      const socket = response.webSocket
      socket.accept()
      sockets.push(socket)
      const ready = new Promise((resolve) => socket.addEventListener('message', (event) => resolve(JSON.parse(event.data)), { once: true }))
      socket.send(JSON.stringify({ protocol: 'relay/v1', type: 'hello', installationId: id, credential: secret, capabilities: ['mcp-http'] }))
      return { socket, ready: await ready }
    }
    const denied = await connect('z'.repeat(43))
    assert.equal(denied.ready.code, 'INVALID_CREDENTIAL')
    const first = await connect()
    assert.equal(first.ready.type, 'ready')
    const before = await db.prepare('SELECT * FROM installations').all()
    const requests = []
    first.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.type !== 'invoke') return
      requests.push(message)
      const input = JSON.parse(message.body)
      setTimeout(() => first.socket.send(JSON.stringify({ protocol: 'relay/v1', type: 'result', connectionId: message.connectionId, requestId: message.requestId, response: { status: 200, contentType: 'application/json', body: JSON.stringify({ id: input.id, result: input.marker }) } })), (3 - input.order) * 10)
    })
    const call = (assertion, body = '{}') => mf.dispatchFetch('http://localhost/mcp', { method: 'POST', headers: { ...(assertion ? { 'Cf-Access-Jwt-Assertion': assertion } : {}), 'content-type': 'application/json', 'x-code-awareness-installation': id }, body })
    assert.equal((await call()).status, 403)
    assert.equal((await call('invalid')).status, 403)
    assert.equal((await call('user-b')).status, 403)
    const results = await Promise.all([0, 1, 2].map(async (order) => {
      const response = await call('user-a', JSON.stringify({ id: 1, order, marker: `SOURCE_SENTINEL_${order}_Ω` }))
      assert.equal(response.status, 200)
      return response.json()
    }))
    assert.deepEqual(results.map((result) => result.result), [0, 1, 2].map((order) => `SOURCE_SENTINEL_${order}_Ω`))
    assert.equal(new Set(requests.map((request) => request.requestId)).size, 3)
    assert.deepEqual((await db.prepare('SELECT * FROM installations').all()).results, before.results)
    const columns = await db.prepare('PRAGMA table_info(installations)').all()
    assert.deepEqual(columns.results.map((column) => column.name), ['id', 'owner_user_id', 'credential_hash', 'created_at', 'last_seen_at', 'status'])
    const second = await connect()
    assert.notEqual(second.ready.connectionId, first.ready.connectionId)
    await db.prepare("UPDATE installations SET status = 'REVOKED' WHERE id = ?").bind(id).run()
    assert.equal((await call('user-a')).status, 403)
    const revoked = await connect()
    assert.equal(revoked.ready.code, 'INVALID_CREDENTIAL')
  } finally {
    for (const socket of sockets) { try { socket.close() } catch {} }
    await mf.dispose()
  }
})


