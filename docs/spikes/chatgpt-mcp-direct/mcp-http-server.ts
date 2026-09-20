import { createServer, type Server } from 'node:http'
import type { ContextNavigationMcpAdapter } from './context-navigation-mcp'

const supportedProtocolVersions = new Set(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'])
const defaultProtocolVersion = '2025-11-25'

function result(id: unknown, value: unknown) {
  return { jsonrpc: '2.0', id, result: value }
}

function error(id: unknown, code: number, message: string) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

async function readJson(request: AsyncIterable<Uint8Array>): Promise<Record<string, unknown>> {
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 64 * 1024) throw new Error('Request body is too large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function writeJson(response: import('node:http').ServerResponse, status: number, body: unknown): number {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload)
  })
  response.end(payload)
  return Buffer.byteLength(payload)
}

export function createMcpHttpServer(
  adapter: ContextNavigationMcpAdapter,
  log: (entry: string) => void = console.log
): Server {
  return createServer(async (request, response) => {
    const startedAt = performance.now()
    let tool = 'unknown'
    let args: unknown = null
    let responseSize = 0
    let success = false

    try {
      if (request.url !== '/mcp' || request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' })
        response.end()
        return
      }

      const message = await readJson(request)
      const method = message.method
      const id = message.id
      const params = message.params as Record<string, unknown> | undefined
      tool = method === 'tools/call' && typeof params?.name === 'string' ? params.name : String(method ?? 'unknown')
      args = method === 'tools/call' ? params?.arguments ?? null : null

      if (message.jsonrpc !== '2.0' || typeof method !== 'string') {
        responseSize = writeJson(response, 400, error(id, -32600, 'Invalid Request'))
        return
      }

      if (id === undefined) {
        response.writeHead(202)
        response.end()
        success = true
        return
      }

      let rpcResult: unknown
      if (method === 'initialize') {
        const requestedVersion = params?.protocolVersion
        rpcResult = {
          protocolVersion: typeof requestedVersion === 'string' && supportedProtocolVersions.has(requestedVersion)
            ? requestedVersion
            : defaultProtocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'code-awareness-context-navigation-spike', version: '0.2.0' }
        }
      } else if (method === 'tools/list') {
        rpcResult = { tools: adapter.listTools() }
      } else if (method === 'tools/call' && typeof params?.name === 'string') {
        rpcResult = await adapter.callTool(params.name, params.arguments)
      } else {
        responseSize = writeJson(response, 200, error(id, -32601, 'Method not found'))
        return
      }

      responseSize = writeJson(response, 200, result(id, rpcResult))
      success = !(rpcResult && typeof rpcResult === 'object' && 'isError' in rpcResult)
    } catch (caught) {
      responseSize = writeJson(
        response,
        400,
        error(null, -32700, caught instanceof Error ? caught.message : 'Parse error')
      )
    } finally {
      log(JSON.stringify({
        timestamp: new Date().toISOString(),
        tool,
        args,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        responseSize,
        success
      }))
    }
  })
}
