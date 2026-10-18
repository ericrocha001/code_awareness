const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js')
const { isAbsolute } = require('node:path')

async function verifyElectronRuntime(executable, launcher, profile) {
  if (![executable, launcher, profile].every(isAbsolute)) throw new Error('ABSOLUTE_PATH_REQUIRED')
  const client = new Client({ name: 'code-awareness-node-independent-proof', version: '1' })
  const transport = new StdioClientTransport({ command: executable, args: [launcher, '--profile', profile],
    env: { ...process.env, PATH: '', ELECTRON_RUN_AS_NODE: '1' }, stderr: 'pipe' })
  let errorCode = null
  transport.stderr?.on('data', chunk => { errorCode = /[A-Z][A-Z_]{5,}/.exec(String(chunk))?.[0] ?? errorCode })
  try {
    await client.connect(transport, { timeout: 15000 })
    const identity = await client.callTool({ name: 'get_runtime_identity', arguments: {} }, undefined, { timeout: 15000 })
    const git = await client.callTool({ name: 'get_git_state', arguments: {} }, undefined, { timeout: 15000 })
    if (identity.isError || git.isError) throw new Error('READ_ONLY_SMOKE_FAILED')
    const decode = result => JSON.parse(result.content.find(item => item.type === 'text').text)
    const runtime = decode(identity)
    return { status: 'PASS', globalNodeOnPath: false, executable, launcher, instanceId: runtime.runtime.instanceId,
      sourceOrigin: runtime.sourceOrigin, freshness: runtime.freshness, git: decode(git), nativeClientAcceptance: false }
  } catch (error) { throw new Error(errorCode ?? error.message) }
  finally { await client.close() }
}
if (require.main === module) verifyElectronRuntime(...process.argv.slice(2)).then(result => {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
}).catch(error => { process.stderr.write(JSON.stringify({ status: 'FAIL', code: error.message }) + '\n'); process.exitCode = 1 })
module.exports = { verifyElectronRuntime }
