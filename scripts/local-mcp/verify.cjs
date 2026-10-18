const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js')
const { publicError } = require('../local-agent/discovery.cjs')

async function verify(launcher, args = []) {
  if (!launcher) throw Object.assign(new Error(), { code: 'LAUNCHER_REQUIRED' })
  const client = new Client({ name: 'code-awareness-local-verification', version: '1' })
  const transport = new StdioClientTransport({ command: process.execPath, args: [launcher, ...args], stderr: 'inherit' })
  try {
    await client.connect(transport)
    const catalog = await client.listTools()
    const identity = await client.callTool({ name: 'get_runtime_identity', arguments: {} })
    const git = await client.callTool({ name: 'get_git_state', arguments: {} })
    if (identity.isError || git.isError) throw Object.assign(new Error(), { code: 'READ_ONLY_SMOKE_FAILED' })
    const payload = JSON.parse(identity.content.find(item => item.type === 'text').text)
    return { status: 'PASS', tools: catalog.tools.length, instanceId: payload.runtime.instanceId,
      sourceOrigin: payload.sourceOrigin, git: JSON.parse(git.content.find(item => item.type === 'text').text) }
  } finally { await client.close() }
}
if (require.main === module) verify(process.argv[2], process.argv.slice(3)).then(result => {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
}).catch(error => { process.stderr.write(JSON.stringify({ error: publicError(error) }) + '\n'); process.exitCode = 1 })
module.exports = { verify }
