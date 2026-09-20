import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMcpPingServer } from './ping-server.mjs'

const logs = []
const server = createMcpPingServer({ log: (entry) => logs.push(JSON.parse(entry)) })
let endpoint

beforeAll(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  endpoint = `http://127.0.0.1:${server.address().port}/mcp`
})

afterAll(async () => {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  )
})

async function send(message) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json'
    },
    body: JSON.stringify(message)
  })
  return { response, body: await response.json() }
}

describe('MCP ping server', () => {
  it('completes the MCP handshake and exposes only ping', async () => {
    const initialized = await send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {} }
    })
    expect(initialized.response.status).toBe(200)
    expect(initialized.body.result.protocolVersion).toBe('2025-06-18')

    const listed = await send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    expect(listed.body.result.tools.map((tool) => tool.name)).toEqual(['ping'])

    const called = await send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'ping', arguments: {} }
    })
    expect(called.body.result.content[0].text).toBe('Code Awareness reachable')
    expect(logs.at(-1).tool).toBe('tools/call')
    expect(logs.at(-1).success).toBe(true)
    expect(logs.at(-1).responseSize).toBeGreaterThan(0)
  })

  it('rejects every tool other than ping', async () => {
    const called = await send({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'read_code', arguments: {} }
    })
    expect(called.body.error.code).toBe(-32602)
  })
})
