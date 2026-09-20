import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

const supportedProtocolVersions = new Set(['2025-06-18', '2025-03-26', '2024-11-05'])
const defaultProtocolVersion = '2025-06-18'

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result }
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

function writeJson(response, statusCode, body) {
  const payload = JSON.stringify(body)
  response.writeHead(statusCode, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload)
  })
  response.end(payload)
}

async function readJson(request) {
  const chunks = []
  let size = 0

  for await (const chunk of request) {
    size += chunk.length
    if (size > 64 * 1024) throw new Error('Request body is too large')
    chunks.push(chunk)
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function handleRequest(message) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return jsonRpcError(message?.id, -32600, 'Invalid Request')
  }

  if (message.id === undefined) return null

  if (message.method === 'initialize') {
    const requestedVersion = message.params?.protocolVersion
    return jsonRpcResult(message.id, {
      protocolVersion: supportedProtocolVersions.has(requestedVersion)
        ? requestedVersion
        : defaultProtocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'code-awareness-connectivity-spike', version: '0.1.0' }
    })
  }

  if (message.method === 'tools/list') {
    return jsonRpcResult(message.id, {
      tools: [
        {
          name: 'ping',
          description: 'Check whether Code Awareness is reachable.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false }
        }
      ]
    })
  }

  if (message.method === 'tools/call') {
    if (message.params?.name !== 'ping') {
      return jsonRpcError(message.id, -32602, 'Unknown tool')
    }

    return jsonRpcResult(message.id, {
      content: [{ type: 'text', text: 'Code Awareness reachable' }]
    })
  }

  return jsonRpcError(message.id, -32601, 'Method not found')
}

export function createMcpPingServer({ log = console.log } = {}) {
  return createServer(async (request, response) => {
    const startedAt = performance.now()
    let method = 'unknown'
    let args = null
    let responseSize = 0
    let success = false

    try {
      if (request.url !== '/mcp' || request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' })
        response.end()
        return
      }

      const message = await readJson(request)
      method = message.method ?? 'unknown'
      args = message.params ?? null
      const result = handleRequest(message)

      if (result === null) {
        response.writeHead(202)
        response.end()
        success = true
        return
      }

      responseSize = Buffer.byteLength(JSON.stringify(result))
      success = !result.error
      writeJson(response, 200, result)
    } catch (error) {
      const result = jsonRpcError(null, -32700, error instanceof Error ? error.message : 'Parse error')
      responseSize = Buffer.byteLength(JSON.stringify(result))
      writeJson(response, 400, result)
    } finally {
      log(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          tool: method,
          args,
          durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
          responseSize,
          success
        })
      )
    }
  })
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.CODE_AWARENESS_MCP_PORT ?? 8765)
  const server = createMcpPingServer()
  server.listen(port, '127.0.0.1', () => {
    console.log(`Code Awareness MCP connectivity spike listening on http://127.0.0.1:${port}/mcp`)
  })
}
