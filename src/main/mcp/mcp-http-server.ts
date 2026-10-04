import { createServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { ContextNavigationMcpAdapter } from './context-navigation-mcp-adapter'
import type { CodeScopeTraceEvent, CodeScopeTraceSink } from './code-scope-health'

const supportedProtocolVersions = new Set(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'])
const defaultProtocolVersion = '2025-11-25'

export interface McpOperationalLogEntry {
  timestamp: string
  requestId: string
  sessionId: string
  method: string
  tool: string
  stage: CodeScopeTraceEvent['stage']
  durationMs: number
  responseSize: number
  success: boolean
  status: CodeScopeTraceEvent['status']
  error?: string
}

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
  log: (entry: McpOperationalLogEntry) => void = console.log,
  trace?: CodeScopeTraceSink
): Server {
  return createServer(async (request, response) => {
    const startedAt = performance.now()
    const requestId = request.headers['x-code-awareness-request-id'] ?? randomUUID()
    const sessionId = request.headers['x-code-awareness-session-id'] ?? 'local'
    const correlationId = Array.isArray(requestId) ? requestId[0] : requestId
    const relaySessionId = Array.isArray(sessionId) ? sessionId[0] : sessionId
    let method = 'unknown'
    let tool = 'unknown'
    let responseSize = 0
    let success = false
    let responseSent = false
    let failure = 'MCP_REQUEST_FAILED'
    const emit = (stage: CodeScopeTraceEvent['stage'], status: CodeScopeTraceEvent['status'], errorCode?: string): void => {
      const entry: McpOperationalLogEntry = {
        timestamp: new Date().toISOString(),
        requestId: correlationId,
        sessionId: relaySessionId,
        method,
        tool,
        stage,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        responseSize,
        success: status === 'success',
        status,
        ...(errorCode ? { error: errorCode } : {})
      }
      log(entry)
      trace?.record(entry)
    }

    try {
      if (request.url !== '/mcp' || request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' })
        response.end()
        return
      }

      const message = await readJson(request)
      const rawMethod = message.method
      method = typeof rawMethod === 'string' ? rawMethod : 'unknown'
      const id = message.id
      const params = message.params as Record<string, unknown> | undefined
      tool = method === 'tools/call' && typeof params?.name === 'string' ? params.name : method
      emit('mcp-request-started', 'started')
      emit('mcp-request-received', 'started')

      if (message.jsonrpc !== '2.0' || typeof rawMethod !== 'string') {
        failure = 'INVALID_REQUEST'
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
      emit('mcp-dispatch-started', 'started')
      if (method === 'initialize') {
        const requestedVersion = params?.protocolVersion
        rpcResult = {
          protocolVersion: typeof requestedVersion === 'string' && supportedProtocolVersions.has(requestedVersion)
            ? requestedVersion
            : defaultProtocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'code-awareness-context-navigation', version: '1.0.0' }
        }
      } else if (method === 'tools/list') {
        rpcResult = { tools: adapter.listTools() }
      } else if (method === 'tools/call' && typeof params?.name === 'string') {
        emit('codescope-request-started', 'started')
        emit('codescope-handler-started', 'started')
        const toolResult = await adapter.callTool(params.name, params.arguments, { requestId: correlationId, sessionId: relaySessionId, trace })
        const { postResponse, ...publicResult } = toolResult
        rpcResult = publicResult
        emit('codescope-response-produced', 'success')
        emit('codescope-handler-completed', 'success')
        if (postResponse) {
          emit('mcp-response-produced', 'success')
          const finished = new Promise<void>((resolve) => response.once('finish', resolve))
          responseSize = writeJson(response, 200, result(id, rpcResult))
          success = true
          await finished
          emit('mcp-response-sent', 'success')
          responseSent = true
          try {
            await postResponse()
          } catch {
            log({
              timestamp: new Date().toISOString(), requestId: correlationId, sessionId: relaySessionId,
              method, tool, stage: 'mcp-response-sent', durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
              responseSize, success: false, status: 'error', error: 'POST_RESPONSE_ACTION_FAILED'
            })
          }
          return
        }
      } else {
        failure = 'METHOD_NOT_FOUND'
        responseSize = writeJson(response, 200, error(id, -32601, 'Method not found'))
        return
      }

      emit('mcp-response-produced', 'success')
      responseSize = writeJson(response, 200, result(id, rpcResult))
      success = true
    } catch (caught) {
      failure = caught instanceof Error ? caught.name : 'PARSE_ERROR'
      responseSize = writeJson(
        response,
        400,
        error(null, -32700, caught instanceof Error ? caught.message : 'Parse error')
      )
    } finally {
      if (!responseSent) emit('mcp-response-sent', success ? 'success' : 'error', success ? undefined : failure)
    }
  })
}
