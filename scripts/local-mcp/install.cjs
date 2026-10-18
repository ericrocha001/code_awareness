const { mkdirSync, copyFileSync, existsSync } = require('node:fs')
const { resolve, join } = require('node:path')
const { stableDestination } = require('../../src/shared/local-mcp-installation.cjs')

function install(destination = process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'CodeAwareness', 'mcp', 'v1')) {
  if (!destination) throw new Error('INSTALL_DESTINATION_REQUIRED')
  const directory = stableDestination(destination)
  const source = resolve(__dirname, '../../out/local-mcp/launcher.cjs')
  if (!existsSync(source)) throw new Error('BUILD_LAUNCHER_FIRST')
  mkdirSync(directory, { recursive: true })
  const launcher = join(directory, 'launcher.cjs')
  copyFileSync(source, launcher)
  const configuration = { command: process.execPath, args: [launcher] }
  return {
    launcher, version: 1,
    codex: `[mcp_servers.code_awareness_local]\ncommand = ${JSON.stringify(configuration.command)}\nargs = ${JSON.stringify(configuration.args)}\n`,
    antigravity: { mcpServers: { 'code-awareness-local': configuration } }
  }
}
if (require.main === module) {
  try {
    if (process.argv.length > 3) throw new Error('INVALID_ARGUMENT')
    process.stdout.write(JSON.stringify(install(process.argv[2]), null, 2) + '\n')
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1 }
}
module.exports = { install, stableDestination }
