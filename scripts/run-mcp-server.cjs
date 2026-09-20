const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

const projectRoot = path.resolve(__dirname, '..')
const electronPath = require('electron')
const viteNodeCli = require.resolve('vite-node/vite-node.mjs', { paths: [projectRoot] })
const serverPath = path.join(projectRoot, 'src', 'main', 'mcp', 'server.ts')

if (!fs.existsSync(serverPath)) throw new Error(`MCP server entrypoint not found: ${serverPath}`)

const child = spawn(electronPath, [viteNodeCli, serverPath, ...process.argv.slice(2)], {
  cwd: projectRoot,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: 'inherit'
})

child.on('error', (error) => {
  console.error(error.message)
  process.exit(1)
})
child.on('exit', (code) => process.exit(code ?? 1))

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal))
}
