const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js')
const { Server } = require('@modelcontextprotocol/sdk/server/index.js')
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js')
const { ResultSchema, McpError, ErrorCode } = require('@modelcontextprotocol/sdk/types.js')
const { discover, sameBinding, fail } = require('./bootstrap.cjs')
const { publicError } = require('../local-agent/discovery.cjs')

async function start({ profile, projectId, input = process.stdin, output = process.stdout, timeoutMs = 25000 } = {}) {
  const binding = await discover(profile, projectId)
  let invalidated = false
  const client = new Client({ name: 'code-awareness-local-bootstrap', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(binding.endpoint), {
    reconnectionOptions: { maxRetries: 0 },
    requestInit: { headers: {
      'x-code-awareness-instance': binding.instanceId,
      'x-code-awareness-project': binding.projectId,
      'x-code-awareness-binding': binding.bindingId
    } },
    fetch: async (url, init) => {
      if (String(url) !== binding.endpoint || invalidated) fail('MCP_SESSION_INVALIDATED')
      return fetch(url, { ...init, redirect: 'error', signal: AbortSignal.any([
        ...(init?.signal ? [init.signal] : []), AbortSignal.timeout(timeoutMs)
      ]) })
    }
  })
  const close = async () => { invalidated = true; await client.close() }
  try {
    await client.connect(transport, { timeout: timeoutMs })
    const identity = await client.callTool({ name: 'get_runtime_identity', arguments: {} }, undefined, { timeout: timeoutMs })
    let payload
    try { payload = JSON.parse(identity.content.find(item => item.type === 'text').text) } catch { fail('MCP_IDENTITY_INVALID') }
    if (identity.isError || payload.runtime?.instanceId !== binding.instanceId) fail('MCP_INSTANCE_MISMATCH')
    const server = new Server(client.getServerVersion(), { capabilities: client.getServerCapabilities() })
    async function check() {
      try {
        if (invalidated || !sameBinding(binding, await discover(profile, binding.projectId))) fail('MCP_SESSION_INVALIDATED')
      } catch {
        invalidated = true
        throw new McpError(ErrorCode.InternalError, 'MCP_SESSION_INVALIDATED: reconnect the client')
      }
    }
    server.fallbackRequestHandler = async (request, extra) => {
      await check()
      try { return await client.request(request, ResultSchema, { timeout: timeoutMs, signal: extra.signal }) }
      catch (error) {
        if (error instanceof McpError && error.code <= -32600) throw error
        invalidated = true
        if (error instanceof McpError) throw error
        throw new McpError(ErrorCode.InternalError, 'MCP_BACKEND_UNAVAILABLE: reconnect the client')
      }
    }
    server.fallbackNotificationHandler = async notification => {
      await check()
      await client.notification(notification)
    }
    client.fallbackNotificationHandler = async notification => {
      await check()
      await server.notification(notification)
    }
    server.onclose = () => { void close() }
    server.onerror = () => process.stderr.write('MCP_PROTOCOL_ERROR\n')
    await server.connect(new StdioServerTransport(input, output))
    input.once('end', () => { void server.close() })
    return { server, client, binding, close: async () => { await server.close(); await close() } }
  } catch (error) { await close(); throw error }
}

async function main(args = process.argv.slice(2)) {
  const options = {}
  for (let index = 0; index < args.length; index += 2) {
    if (!['--profile', '--project'].includes(args[index]) || !args[index + 1] || options[args[index]]) fail('INVALID_ARGUMENT')
    options[args[index]] = args[index + 1]
  }
  return start({ profile: options['--profile'], projectId: options['--project'] })
}
if (require.main === module) main().catch(error => {
  process.stderr.write(JSON.stringify({ error: publicError(error) }) + '\n')
  process.exitCode = 1
})
module.exports = { start, main }
