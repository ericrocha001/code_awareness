const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js')
const { Server } = require('@modelcontextprotocol/sdk/server/index.js')
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js')
const { ResultSchema, McpError, ErrorCode } = require('@modelcontextprotocol/sdk/types.js')
const { discover, sameBinding, fail } = require('./bootstrap.cjs')
const { connect: connectChannel } = require('../local-agent/client.cjs')
const { readDescriptor, publicError } = require('../local-agent/discovery.cjs')

async function resolveCheckoutScope({ profile, cwd = process.cwd(), timeoutMs = 3000 } = {}) {
  const channel = { directory: 'local-agent-channel', protocol: 'code-awareness-local/v1' }
  const descriptor = readDescriptor(profile, channel)
  const connectTimeout = Math.max(500, Math.min(timeoutMs, 3000))
  const status = await connectChannel(descriptor, { domain: 'continuum', action: 'status', args: {} }, { timeoutMs: connectTimeout })
  if (!status?.repository?.repositoryId || !Array.isArray(status.worktrees)) return { status: 'UNAVAILABLE' }
  const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value
  let realCwd = cwd
  try { realCwd = fs.realpathSync(cwd) } catch {}
  let worktree = status.worktrees.find(w => {
    try { return normalize(fs.realpathSync(w.path)) === normalize(realCwd) } catch { return false }
  })
  if (!worktree) {
    let root = realCwd
    try { root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', windowsHide: true, timeout: 1500, stdio: ['ignore', 'pipe', 'pipe'] }).trim() || realCwd } catch {}
    let realRoot = root
    try { realRoot = fs.realpathSync(root) } catch {}
    worktree = status.worktrees.find(w => {
      try { return normalize(fs.realpathSync(w.path)) === normalize(realRoot) } catch { return false }
    })
  }
  if (!worktree) return { status: 'UNMANAGED' }
  const active = await connectChannel(descriptor, {
    domain: 'continuum',
    action: 'get_execution_context',
    args: { repositoryId: status.repository.repositoryId, worktreeId: worktree.worktreeId }
  }, { timeoutMs: connectTimeout })
  return {
    status: 'OK',
    worktreeId: worktree.worktreeId,
    deliveryContext: active?.deliveryContext ?? null
  }
}

async function start({
  profile,
  projectId,
  cwd = process.cwd(),
  deliveryContext = process.env.CODE_AWARENESS_DELIVERY_CONTEXT,
  worktreeId = process.env.CODE_AWARENESS_WORKTREE_ID,
  sessionWitness = process.env.CODE_AWARENESS_SESSION_WITNESS,
  input = process.stdin,
  output = process.stdout,
  timeoutMs = 25000
} = {}) {
  const binding = await discover(profile, projectId)
  let invalidated = false
  const pinnedDelivery = typeof deliveryContext === 'string' && deliveryContext.trim() ? deliveryContext.trim() : undefined
  const pinnedWorktree = typeof worktreeId === 'string' && worktreeId.trim() ? worktreeId.trim() : undefined
  const headers = {
    'x-code-awareness-instance': binding.instanceId,
    'x-code-awareness-project': binding.projectId,
    'x-code-awareness-binding': binding.bindingId
  }
  if (pinnedDelivery) headers['x-code-awareness-delivery-context'] = pinnedDelivery
  if (pinnedWorktree) headers['x-code-awareness-worktree'] = pinnedWorktree
  if (typeof sessionWitness === 'string' && sessionWitness.trim()) headers['x-code-awareness-session-witness'] = sessionWitness.trim()
  let continuumUnavailable = false
  let lastRefreshAt = 0
  let resolvedWorktreeId = pinnedWorktree
  let resolvedDeliveryJson = pinnedDelivery
  const refreshScope = async (force = false) => {
    if (pinnedDelivery || continuumUnavailable) return
    const now = Date.now()
    if (!force && now - lastRefreshAt < 500) return
    try {
      const scope = await resolveCheckoutScope({ profile, cwd, timeoutMs: Math.min(timeoutMs, 3000) })
      if (scope.status === 'OK') {
        resolvedWorktreeId = pinnedWorktree ?? scope.worktreeId
        resolvedDeliveryJson = scope.deliveryContext ? JSON.stringify(scope.deliveryContext) : undefined
        lastRefreshAt = Date.now()
      } else if (scope.status === 'UNMANAGED') {
        resolvedWorktreeId = pinnedWorktree
        resolvedDeliveryJson = undefined
        lastRefreshAt = Date.now()
      }
    } catch (error) {
      if (['UNKNOWN_DOMAIN', 'METHOD_NOT_FOUND', 'APP_UNAVAILABLE'].includes(error?.code)) continuumUnavailable = true
    }
  }
  await refreshScope(true)
  if (resolvedDeliveryJson) headers['x-code-awareness-delivery-context'] = resolvedDeliveryJson
  if (resolvedWorktreeId) headers['x-code-awareness-worktree'] = resolvedWorktreeId
  const client = new Client({ name: 'code-awareness-local-bootstrap', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(binding.endpoint), {
    reconnectionOptions: { maxRetries: 0 },
    requestInit: { headers },
    fetch: async (url, init) => {
      if (String(url) !== binding.endpoint || invalidated) fail('MCP_SESSION_INVALIDATED')
      const merged = new Headers(headers)
      if (init?.headers) new Headers(init.headers).forEach((value, key) => merged.set(key, value))
      if (resolvedDeliveryJson) merged.set('x-code-awareness-delivery-context', resolvedDeliveryJson)
      else if (!pinnedDelivery) merged.delete('x-code-awareness-delivery-context')
      if (resolvedWorktreeId) merged.set('x-code-awareness-worktree', resolvedWorktreeId)
      else if (!pinnedWorktree) merged.delete('x-code-awareness-worktree')
      return fetch(url, { ...init, headers: merged, redirect: 'error', signal: AbortSignal.any([
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
      await refreshScope(false)
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
