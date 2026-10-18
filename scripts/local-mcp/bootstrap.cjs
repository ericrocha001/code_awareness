const { readDescriptor } = require('../local-agent/discovery.cjs')
const { connect } = require('../local-agent/client.cjs')
const channel = { directory: 'local-agent-channel', protocol: 'code-awareness-local/v1' }
const fail = code => { throw Object.assign(new Error(code), { code }) }

function validateEndpoint(value, expectedProject) {
  if (value?.status !== 'RUNNING') fail('MCP_UNAVAILABLE')
  if (value.protocol !== 'code-awareness-mcp-bootstrap/v1') fail('MCP_PROTOCOL_INCOMPATIBLE')
  if (!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/mcp$/.test(value.endpoint) || Number(new URL(value.endpoint).port) > 65535) fail('MCP_ENDPOINT_INVALID')
  for (const key of ['projectId', 'instanceId', 'bindingId']) {
    if (typeof value[key] !== 'string' || !value[key] || value[key].length > 256 || /[\r\n]/.test(value[key])) fail('MCP_IDENTITY_INVALID')
  }
  const age = Date.now() - Date.parse(value.observedAt)
  if (!Number.isFinite(age) || age < -5000 || age > 15000) fail('MCP_DISCOVERY_STALE')
  if (expectedProject && value.projectId !== expectedProject) fail('MCP_PROJECT_MISMATCH')
  return value
}

async function discover(profile, expectedProject) {
  const descriptor = readDescriptor(profile, channel)
  let endpoint
  try { endpoint = await connect(descriptor, { domain: 'channel', action: 'mcp_endpoint', args: {} }) }
  catch (error) {
    if (error.code === 'METHOD_NOT_FOUND') fail('MCP_BOOTSTRAP_RUNTIME_UPDATE_REQUIRED')
    throw error
  }
  return validateEndpoint(endpoint, expectedProject)
}

function sameBinding(a, b) {
  return ['endpoint', 'instanceId', 'projectId', 'bindingId'].every(key => a[key] === b[key])
}

module.exports = { discover, validateEndpoint, sameBinding, fail }
