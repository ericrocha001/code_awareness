const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { createRequire } = require('node:module')
const { runInNewContext } = require('node:vm')

const filename = join(__dirname, 'native-hooks.cjs')
const source = readFileSync(filename, 'utf8')
const localRequire = createRequire(filename)
const root = process.cwd()
const binary = join(root, 'codex.exe')

function run(args, { version = '0.166.0-alpha.6', replaced = false } = {}) {
  let selections = 0
  const installed = [], inspected = [], output = [], executables = []
  const overrides = {
    'node:child_process': { execFileSync(exe, argv) {
      if (exe === process.execPath) {
        selections++
        return JSON.stringify({ available: true, repository: { repositoryId: 'repo' }, worktrees: [
          { path: root, worktreeId: 'selected', generation: replaced && selections > 1 ? 'changed' : 'original' }
        ] })
      }
      if (exe === 'git') return argv[0] === 'symbolic-ref' ? 'feature' : 'a'.repeat(40)
      executables.push(exe)
      return 'codex-cli ' + version
    } },
    'node:fs': { existsSync: () => false, lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false }), realpathSync: path => path },
    esbuild: { buildSync: () => ({ outputFiles: [{ text: 'module.exports = fixture' }] }) }
  }
  const api = {
    inspectNativeInstallation: (_root, _target, _platform, provider = 'codex') => { inspected.push(provider); return { state: 'MISSING', handlers: [] } },
    installNativeHooks: input => { installed.push(input); return { state: 'CONFIGURED' } }
  }
  const invoke = () => runInNewContext(source, {
    __dirname, __filename: filename, Buffer, fixture: api, process: { cwd: () => root, argv: ['node', filename, ...args], execPath: process.execPath },
    console: { log: line => output.push(JSON.parse(line)) },
    require: name => Object.hasOwn(overrides, name) ? overrides[name] : localRequire(name)
  }, { filename })
  return { invoke, installed, inspected, output, executables }
}

test('provisions the linked Worktree using the explicitly selected executable including 0.169.0-alpha.11.1', () => {
  const f = run(['install', '--authorized', '--codex=' + binary], { version: '0.169.0-alpha.11.1' })
  f.invoke()
  assert.deepEqual(f.executables, [binary, binary])
  assert.equal(f.installed.length, 1)
  assert.equal(f.installed[0].record.path, root)
  assert.equal(f.installed[0].record.generation, 'original')
})

test('status is read-only and exposes the selected client qualification', () => {
  const f = run(['status', '--codex=' + binary], { version: '0.169.0-alpha.99' })
  f.invoke()
  assert.equal(f.output[0].client.reasonCode, 'VERSION_UNSUPPORTED')
  assert.equal(f.installed.length, 0)
  const qualified = run(['status', '--codex=' + binary], { version: '0.169.0-alpha.11.1' })
  qualified.invoke()
  assert.equal(qualified.output[0].client.state, 'QUALIFIED')
  assert.equal(qualified.output[0].client.version, '0.169.0-alpha.11.1')
})

test('installation refuses missing authorization, unidentified client, unsupported version and generation drift', () => {
  const selected = '--codex=' + binary
  for (const [args, options, error] of [
    [['install', selected], {}, /HOOK_AUTHORIZATION_REQUIRED/],
    [['install', '--authorized'], {}, /CODEX_EXECUTABLE_SELECTION_REQUIRED/],
    [['install', '--authorized', selected], { version: '0.169.0-alpha.99' }, /VERSION_UNSUPPORTED/],
    [['install', '--authorized', selected], { replaced: true }, /WORKTREE_STALE/]
  ]) {
    const f = run(args, options)
    assert.throws(f.invoke, error)
    assert.equal(f.installed.length, 0)
  }
})

test('supports --provider=antigravity status and install without requiring --codex', () => {
  const status = run(['status', '--provider=antigravity'])
  status.invoke()
  assert.deepEqual(status.inspected, ['antigravity'])
  assert.equal(status.output[0].provider, 'antigravity')
  assert.equal(status.output[0].client.contract, 'agents-hooks-v1')
  assert.equal(status.output[0].trust.reasonCode, 'CLIENT_TRUST_UNSUPPORTED')
  assert.equal(status.installed.length, 0)

  assert.throws(run(['install', '--provider=antigravity']).invoke, /HOOK_AUTHORIZATION_REQUIRED/)

  const install = run(['install', '--authorized', '--provider=antigravity'])
  install.invoke()
  assert.equal(install.executables.length, 0)
  assert.equal(install.installed.length, 1)
  assert.equal(install.installed[0].provider, 'antigravity')
  assert.equal(install.installed[0].record.path, root)
})
