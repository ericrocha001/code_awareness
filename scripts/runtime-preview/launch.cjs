const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawn } = require('node:child_process')
const { configuration, hash } = require('./cooperation.cjs')
const config = configuration()
if (!config) throw new Error('PREVIEW_CONFIGURATION_REQUIRED')
const output = path.join(config.directory, 'compatibility.json')
const timings = []
function finish(stage, startNs) {
  timings.push({ stage, startNs, endNs: process.hrtime.bigint().toString() })
  fs.writeFileSync(path.join(config.directory, 'bootstrap-timing.json'), JSON.stringify(timings))
}
function diagnostic(stream, name) {
  let bytes = 0
  stream.write = (chunk, encoding, callback) => {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : 'utf8')
    if (bytes < 65536) fs.appendFileSync(path.join(config.directory, name), value.subarray(0, 65536 - bytes))
    bytes += value.length
    const done = typeof encoding === 'function' ? encoding : callback
    if (done) done()
    return true
  }
}
diagnostic(process.stdout, 'bootstrap.stdout.log'); diagnostic(process.stderr, 'bootstrap.stderr.log')
function inside(file) {
  const physical = fs.realpathSync(path.resolve(config.worktree, file))
  const scope = path.relative(config.worktree, physical)
  if (scope.startsWith('..') || path.isAbsolute(scope)) throw new Error('PATH_OUTSIDE_WORKTREE')
  return physical
}
async function main() {
  const abiStart = process.hrtime.bigint().toString()
  if (config.kind === 'ELECTRON') {
    const executable = inside(config.runtimeExecutable)
    if (hash(fs.readFileSync(executable)) !== config.runtimeExecutableHash) throw new Error('RUNTIME_EXECUTABLE_CHANGED')
    const script = `const fs=require('fs');for(const name of ${JSON.stringify(config.nativeModules)}){const module=require(name);if(name==='better-sqlite3'){const db=new module(':memory:');db.prepare('select 1').get();db.close()}}fs.writeFileSync(${JSON.stringify(output)},JSON.stringify({runtime:process.versions.electron,abi:process.versions.modules,platform:process.platform,arch:process.arch,modules:${JSON.stringify(config.nativeModules)}}));`
    const probe = spawn(executable, ['-e', script], { cwd: config.packageRoot, shell: false, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore' })
    const exit = await new Promise((resolve, reject) => { probe.once('error', reject); probe.once('exit', resolve) })
    if (exit !== 0) throw new Error('NATIVE_RUNTIME_INCOMPATIBLE')
  } else {
    for (const name of config.nativeModules) require(require.resolve(name, { paths: [config.packageRoot] }))
    fs.writeFileSync(output, JSON.stringify({ runtime: process.versions.node, abi: process.versions.modules, platform: process.platform, arch: process.arch, modules: config.nativeModules }))
  }
  const runtime = JSON.parse(fs.readFileSync(output, 'utf8'))
  if (runtime.runtime !== config.runtimeVersion || runtime.abi !== config.abi || runtime.platform !== 'win32' || runtime.arch !== 'x64') throw new Error('RUNTIME_COMPATIBILITY_MISMATCH')
  finish('abi', abiStart)
  const deadline = Date.now() + 30000
  while (!fs.existsSync(path.join(config.directory, 'permit'))) {
    if (Date.now() > deadline) throw new Error('LAUNCH_PERMIT_TIMEOUT')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  if (config.kind === 'NODE_WEB') {
    const { startCooperativeWeb } = require('./cooperation.cjs')
    startCooperativeWeb(config)
  } else if (config.kind === 'VITE_WEB') {
    const vite = await import(pathToFileURL(path.join(path.dirname(require.resolve('vite/package.json', { paths: [config.packageRoot] })), 'dist/node/index.js')).href)
    const server = await vite.createServer({ configFile: inside(config.configFile), envFile: false, server: { host: '127.0.0.1', port: config.port, strictPort: true } })
    await server.listen()
    process.on('SIGTERM', async () => { await server.close(); process.exit(0) })
  } else {
    const viteStart = process.hrtime.bigint().toString()
    const { createServer } = await import(pathToFileURL(require.resolve('electron-vite', { paths: [config.worktree] })).href)
    await createServer({ configFile: inside(config.configFile), envFile: false }, {})
    finish('vite', viteStart)
  }
}
main().catch(error => {
  fs.writeFileSync(path.join(config.directory, 'bootstrap-failure.json'), JSON.stringify({ reason: /^[A-Z_]+$/.test(error.message) ? error.message : 'BOOTSTRAP_FAILURE' }))
  process.exitCode = 1
})
