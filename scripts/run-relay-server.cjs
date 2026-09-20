const { spawn } = require('node:child_process')
const { createInterface } = require('node:readline')
const path = require('node:path')

const child = spawn(require('electron'), [require.resolve('vite-node/vite-node.mjs'), path.resolve(__dirname, '../src/main/mcp/relay-server.ts'), ...process.argv.slice(2)], {
  cwd: path.resolve(__dirname, '..'),
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true
})
createInterface({ input: child.stdout }).on('line', (line) => {
  if (line.startsWith('RELAY_OPERATION ')) process.stdout.write(`${line}\n`)
})
child.stderr.resume()
process.stdin.pipe(child.stdin)
child.stdin.on('error', () => {})
child.on('error', () => { console.error('RELAY_LAUNCH_FAILED'); process.exitCode = 1 })
child.on('exit', (code) => { process.stdin.unpipe(child.stdin); process.stdin.pause(); process.exitCode = code ?? 1 })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
