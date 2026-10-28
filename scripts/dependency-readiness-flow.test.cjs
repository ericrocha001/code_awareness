const { test, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawn, spawnSync } = require('node:child_process')
const vm = require('node:vm')
const { npmCommand, snapshot } = require('./dependency-readiness.cjs')
const cleanups = []
afterEach(() => cleanups.splice(0).reverse().forEach(close => close()))
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'readiness-flow-'))
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }))
  const gate = require.resolve('./dependency-readiness.cjs').replace(/\\/g, '/')
  const manifest = { packageManager: 'npm@10.9.4', dependencies: { 'readiness-test-fixture': '1.0.0' }, scripts: { predev: `node "${gate}" && node stages.cjs doctor`, dev: 'node stages.cjs runtime', prebuild: `node "${gate}" && node stages.cjs doctor`, build: 'node stages.cjs build' } }
  const lock = { lockfileVersion: 3, packages: { '': { dependencies: manifest.dependencies }, 'node_modules/readiness-test-fixture': { version: '1.0.0' } } }
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest)); fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify(lock))
  fs.writeFileSync(path.join(root, 'stages.cjs'), "require('node:fs').appendFileSync('stages.log',process.argv[2]+'\\n')")
  const directory = path.join(root, 'node_modules/readiness-test-fixture'); fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ version: '1.0.0', main: 'index.js' })); fs.writeFileSync(path.join(directory, 'index.js'), '')
  fs.writeFileSync(path.join(root, 'node_modules/.package-lock.json'), JSON.stringify({ packages: { 'node_modules/readiness-test-fixture': { version: '1.0.0' } } }))
  const cli = npmCommand(snapshot(root), process.env).args[0]
  const run = command => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, '--ignore-scripts=false', 'run', command], { cwd: root, windowsHide: true, env: { ...process.env, npm_config_ignore_scripts: 'false', npm_config_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false' }, stdio: 'pipe' })
    let output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { output += bytes })
    child.on('error', reject); child.on('close', code => resolve({ code, output }))
  })
  return { root, run, directory }
}
test('normal npm lifecycle runs the gate once, then native validation, then dev/build', async () => {
  const f = fixture()
  for (const command of ['dev', 'build']) {
    const result = await f.run(command)
    assert.equal(result.code, 0, result.output)
    assert.equal((result.output.match(/\[Dependency Readiness\] READY/g) ?? []).length, 1)
    assert.equal((result.output.match(/SYNC_REQUIRED/g) ?? []).length, 0)
  }
  assert.equal(fs.readFileSync(path.join(f.root, 'stages.log'), 'utf8'), 'doctor\nruntime\ndoctor\nbuild\n')
})
test('an unsuccessful real npm synchronization prevents both native validation and runtime entry', async () => {
  const f = fixture()
  fs.unlinkSync(path.join(f.directory, 'index.js'))
  const before = ['package.json', 'package-lock.json'].map(file => fs.readFileSync(path.join(f.root, file), 'utf8'))
  const result = await f.run('dev')
  assert.notEqual(result.code, 0)
  assert.match(result.output, /DEPENDENCY_SYNC_FAILED|DEPENDENCY_INSTALL_INCOMPLETE/)
  assert.equal(fs.existsSync(path.join(f.root, 'stages.log')), false)
  assert.deepEqual(['package.json', 'package-lock.json'].map(file => fs.readFileSync(path.join(f.root, file), 'utf8')), before)
})
test('production hooks preserve native validation while guarding dev and all normal build entrypoints', () => {
  const scripts = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'))).scripts
  for (const name of ['predev', 'prebuild']) assert.equal(scripts[name], 'node scripts/dependency-readiness.cjs && npm run native:doctor')
  assert.equal(scripts.dev, 'node scripts/dev-supervisor.cjs')
  assert.equal(scripts['native:validate'], 'npm run build')
  assert.ok(scripts.build.startsWith('node scripts/dependency-readiness.cjs --build-fallback && electron-vite build'))
  assert.equal(scripts.postinstall, 'npm run native:prepare && npm run native:doctor')
})
test('direct or ignored-hook supervisor startup blocks on failed readiness before creating a runtime', () => {
  const source = fs.readFileSync(path.join(__dirname, 'dev-supervisor.cjs'), 'utf8')
  for (const env of [{}, { npm_lifecycle_event: 'dev', npm_config_ignore_scripts: 'true' }]) {
    const invocations = []; let started = false
    assert.throws(() => vm.runInNewContext(source, {
      __dirname, process: { platform: 'linux', execPath: process.execPath, env, exit: code => { throw Error('EXIT_' + code) } }, console: { error() {} },
      require: name => name === 'node:path' ? path : name === 'node:child_process' ? { spawnSync: (_executable, args) => { invocations.push(args); return { status: 1 } } } : { createDevSupervisor: () => { started = true } }
    }), /EXIT_1/)
    assert.equal(invocations.length, 1); assert.match(invocations[0][0], /dependency-readiness.cjs$/); assert.equal(started, false)
  }
})
test('build fallback performs no duplicate verification when the prebuild lifecycle already ran', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'readiness-fallback-'))
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }))
  const result = spawnSync(process.execPath, [require.resolve('./dependency-readiness.cjs'), '--build-fallback'], { cwd: root, windowsHide: true, env: { ...process.env, npm_lifecycle_event: 'build', npm_config_ignore_scripts: 'false' }, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '')
  assert.deepEqual(fs.readdirSync(root), [])
})
