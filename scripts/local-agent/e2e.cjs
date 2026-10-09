const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const { buildSync } = require('esbuild')
const temporary = mkdtempSync(join(tmpdir(), 'local-agent-e2e-'))
const root = resolve(__dirname, '../..')
const worker = join(temporary, 'worker.cjs')
const env = { ...process.env, NODE_PATH: join(root, 'node_modules') }; delete env.ELECTRON_RUN_AS_NODE
try {
  buildSync({ entryPoints: [join(__dirname, 'e2e-worker.ts')], outfile: worker, bundle: true, platform: 'node', alias: { 'better-sqlite3': require.resolve('better-sqlite3'), 'js-yaml': require.resolve('js-yaml') }, external: ['electron', require.resolve('better-sqlite3'), require.resolve('js-yaml')], logLevel: 'silent' })
  const child = spawn(require('electron'), [worker], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  let result, diagnostics = ''
  const timer = setTimeout(() => child.kill(), 180000)
  child.stdout.on('data', chunk => { diagnostics += chunk })
  child.stderr.on('data', chunk => { diagnostics += chunk })
  child.on('message', message => { result = message })
  child.on('error', error => { diagnostics += error.message })
  child.on('exit', code => {
    clearTimeout(timer)
    if (result?.success) {
      const unavailable = spawnSync(process.execPath, [join(__dirname, 'local.cjs'), 'status', '--profile', join(temporary, 'profile')], { encoding: 'utf8', windowsHide: true })
      if (unavailable.status !== 1 || !unavailable.stderr.includes('APP_UNAVAILABLE')) result = { success: false, error: 'Channel survived Electron process exit' }
      else result.proofs.push('Electron exited / channel unavailable')
    }
    console.log(JSON.stringify(result || { success: false, code, diagnostics }))
    if (!result?.success) process.exitCode = 1
    rmSync(temporary, { recursive: true, force: true })
  })
  child.send({ temporary, node: process.execPath, cli: join(__dirname, '../continuum/local.cjs'), channelCli: join(__dirname, 'local.cjs') })
} catch (error) { console.error(String(error)); rmSync(temporary, { recursive: true, force: true }); process.exitCode = 1 }
