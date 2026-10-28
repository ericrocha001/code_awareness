const { test, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawn } = require('node:child_process')
const { ensureDependencyReadiness, snapshot, inspectInstallation, npmCommand } = require('./dependency-readiness.cjs')
const cleanups = []
afterEach(() => cleanups.splice(0).reverse().forEach(close => close()))
function write(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)) }
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dependency-readiness-'))
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }))
  const manifest = { packageManager: 'npm@10.9.4', dependencies: { alpha: '^1.0.0' } }
  const lock = { lockfileVersion: 3, packages: { '': { dependencies: { ...manifest.dependencies } }, 'node_modules/alpha': { version: '1.2.0', integrity: 'sha512-alpha' } } }
  write(path.join(root, 'package.json'), manifest); write(path.join(root, 'package-lock.json'), lock)
  const install = () => {
    write(path.join(root, 'node_modules/alpha/package.json'), { name: 'alpha', version: '1.2.0', main: 'index.js' })
    write(path.join(root, 'node_modules/alpha/index.js'), 'module.exports = true')
    write(path.join(root, 'node_modules/.package-lock.json'), { packages: { 'node_modules/alpha': lock.packages['node_modules/alpha'] } })
  }
  install()
  return { root, manifest, lock, install, marker: path.join(root, 'node_modules/.code-awareness-readiness.json'), run: options => ensureDependencyReadiness({ root, log: () => {}, ...options }) }
}
test('healthy checkout requires no installer, tree traversal or marker rewrite; a forged marker cannot hide a missing entry', async () => {
  const f = fixture(), before = [fs.readFileSync(path.join(f.root, 'package.json')), fs.readFileSync(path.join(f.root, 'package-lock.json'))]
  let calls = 0
  const install = async () => { calls++; throw Error('must not install') }
  assert.equal((await f.run({ install })).status, 'READY')
  const stamp = fs.statSync(f.marker).mtimeMs
  const readdir = fs.readdirSync
  fs.readdirSync = () => { throw Error('full tree scan forbidden') }
  try { assert.equal((await f.run({ install })).status, 'READY') } finally { fs.readdirSync = readdir }
  assert.equal(fs.statSync(f.marker).mtimeMs, stamp); assert.equal(calls, 0)
  fs.unlinkSync(path.join(f.root, 'node_modules/alpha/index.js'))
  await assert.rejects(f.run({ install }), /DEPENDENCY_SYNC_FAILED/)
  assert.equal(calls, 1)
  assert.deepEqual([fs.readFileSync(path.join(f.root, 'package.json')), fs.readFileSync(path.join(f.root, 'package-lock.json'))], before)
})
test('repairs an absent package, an incompatible direct version and an incomplete installed index', async () => {
  for (const damage of ['missing', 'version', 'index']) {
    const f = fixture()
    if (damage === 'missing') fs.rmSync(path.join(f.root, 'node_modules/alpha'), { recursive: true })
    if (damage === 'version') write(path.join(f.root, 'node_modules/alpha/package.json'), { version: '0.1.0' })
    if (damage === 'index') fs.unlinkSync(path.join(f.root, 'node_modules/.package-lock.json'))
    let calls = 0
    assert.equal((await f.run({ install: async () => { calls++; f.install() } })).status, 'REPAIRED')
    assert.equal(calls, 1); assert.equal((await f.run({ install: async () => { throw Error('unnecessary') } })).status, 'READY')
  }
})
test('blocks manifest/lock mismatch in both directions without installation or readiness receipt', async () => {
  for (const changed of ['version', 'extra', 'unresolved']) {
    const f = fixture()
    if (changed === 'version') f.manifest.dependencies.alpha = '^2.0.0'
    if (changed === 'extra') f.lock.packages[''].dependencies.extra = '1.0.0'
    if (changed === 'unresolved') delete f.lock.packages['node_modules/alpha']
    write(path.join(f.root, 'package.json'), f.manifest); write(path.join(f.root, 'package-lock.json'), f.lock)
    await assert.rejects(f.run({ install: () => { throw Error('installer must not run') } }), /DEPENDENCY_LOCK/)
    assert.equal(fs.existsSync(f.marker), false)
  }
})
test('failed or incomplete installation fails closed and never publishes readiness', async () => {
  for (const succeeds of [true, false]) {
    const f = fixture(); fs.unlinkSync(path.join(f.root, 'node_modules/alpha/index.js'))
    await assert.rejects(f.run({ install: async () => { if (!succeeds) throw Error('offline') } }), succeeds ? /DEPENDENCY_INSTALL_INCOMPLETE/ : /DEPENDENCY_SYNC_FAILED.*offline/)
    assert.equal(fs.existsSync(f.marker), false)
    assert.equal(fs.existsSync(path.join(f.root, '.code-awareness/dependency-readiness.lock')), false)
  }
})
test('rejects node_modules from a different checkout instead of repairing another installation', async () => {
  const f = fixture(), other = fixture()
  fs.rmSync(path.join(f.root, 'node_modules'), { recursive: true })
  fs.symlinkSync(path.join(other.root, 'node_modules'), path.join(f.root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(f.run({ install: () => { throw Error('must not install') } }), /DEPENDENCY_CHECKOUT_ESCAPE/)
})
test('published metadata-only roots use actual SDK and asset subpaths without reinstalling', async () => {
  const f = fixture()
  for (const name of ['@modelcontextprotocol/sdk', '@vscode/codicons']) {
    f.manifest.dependencies[name] = '1.0.0'
    f.lock.packages[''].dependencies[name] = '1.0.0'
    f.lock.packages['node_modules/' + name] = { version: '1.0.0' }
    const directory = path.join(f.root, 'node_modules', name)
    write(path.join(directory, 'package.json'), { version: '1.0.0', main: name.includes('codicons') ? 'missing-index.js' : undefined, exports: name.includes('sdk') ? { '.': './missing-index.js', './server': './server.js' } : undefined })
    for (const entry of name.includes('sdk') ? ['server.js'] : ['dist/codicon.css', 'dist/codicon.ttf']) write(path.join(directory, entry), 'fixture')
  }
  write(path.join(f.root, 'package.json'), f.manifest); write(path.join(f.root, 'package-lock.json'), f.lock)
  write(path.join(f.root, 'node_modules/.package-lock.json'), { packages: Object.fromEntries(Object.entries(f.lock.packages).filter(([key]) => key)) })
  assert.equal((await f.run({ install: () => { throw Error('false positive') } })).status, 'READY')
})
test('selects incremental npm 10 with lockfile use and no-save; no ci or lockfile suppression', () => {
  const f = fixture(), state = snapshot(f.root)
  const directory = path.join(f.root, 'npm')
  const cli = path.join(directory, 'bin/npm-cli.js')
  write(cli, ''); write(path.join(directory, 'package.json'), { version: '10.9.4' })
  const command = npmCommand(state, { npm_execpath: cli })
  assert.ok(command.args.includes('install')); assert.ok(command.args.includes('--no-save')); assert.ok(command.args.includes('--package-lock=true')); assert.ok(command.args.includes('--prefer-offline'))
  assert.ok(!command.args.includes('ci')); assert.ok(!command.args.includes('--package-lock=false'))
  write(path.join(directory, 'package.json'), { version: '12.0.0' })
  assert.ok(npmCommand(state, { npm_execpath: cli }).args.includes('--package=npm@10.9.4'))
})
test('two processes serialize repair and the second observes the installation instead of installing concurrently', async () => {
  const f = fixture(); fs.unlinkSync(path.join(f.root, 'node_modules/alpha/index.js'))
  const worker = path.join(f.root, 'worker.cjs'), log = path.join(f.root, 'installs.log')
  write(worker, `const fs=require('node:fs');require(${JSON.stringify(require.resolve('./dependency-readiness.cjs'))}).ensureDependencyReadiness({root:process.argv[2],log:()=>{},install:async root=>{fs.appendFileSync(${JSON.stringify(log)},'install\\n');await new Promise(r=>setTimeout(r,300));fs.writeFileSync(require('node:path').join(root,'node_modules/alpha/index.js'),'repaired')}}).then(()=>process.exit(0),e=>{console.error(e);process.exit(1)})`)
  const run = () => new Promise((resolve, reject) => { const child = spawn(process.execPath, [worker, f.root], { windowsHide: true, stdio: 'pipe' }); let error = ''; child.stderr.on('data', data => { error += data }); child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(Error(error))) })
  await Promise.all([run(), run()])
  assert.equal(fs.readFileSync(log, 'utf8'), 'install\n')
  assert.equal(inspectInstallation(f.root, snapshot(f.root)).problems.length, 0)
})
test('a held checkout lock blocks repair rather than allowing overlapping installers', async () => {
  const f = fixture(), lock = path.join(f.root, '.code-awareness/dependency-readiness.lock')
  write(lock, { pid: process.pid, token: 'other-initialization' })
  await assert.rejects(f.run({ lockTimeoutMs: 1, install: () => { throw Error('must not install') } }), /DEPENDENCY_LOCK_TIMEOUT/)
  assert.equal(JSON.parse(fs.readFileSync(lock)).token, 'other-initialization')
})
