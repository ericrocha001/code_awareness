/*
-T ---
*/

const assert = require('assert')
const { test, afterEach } = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { evaluatePreflight, runBootstrap } = require('./native-bootstrap-preflight.cjs')
const { readNpmLifecyclePolicy, lifecyclePreparationEnvironment } = require('./native-runtime-policy.cjs')

function createValidManifest() {
  return {
    packageManager: 'npm@12.0.2',
    dependencies: {
      '@tanstack/react-virtual': '^3.13.0',
      'better-sqlite3': '13.0.3',
      'tree-sitter': '0.21.1',
      'tree-sitter-typescript': '0.23.2',
      'tree-sitter-javascript': '0.23.1'
    },
    devDependencies: {
      electron: '45.2.3',
      vitest: '5.1.0'
    }
  }
}

function createCompatibleLockfile(packageJson = createValidManifest()) {
  return {
    lockfileVersion: 3,
    packages: {
      '': {
        dependencies: { ...packageJson.dependencies },
        devDependencies: { ...packageJson.devDependencies }
      }
    }
  }
}

function createAvailableAdapters(calls = []) {
  return {
    requestHead: async () => {
      calls.push('registry')
      return { ok: true }
    },
    dnsLookup: async () => {
      calls.push('dns')
      return { address: '127.0.0.1' }
    },
    connectTls: async () => {
      calls.push('https')
      return { ok: true }
    }
  }
}

const cases = [
  {
    name: 'DNS failure -> GITHUB_DNS_FAILED',
    run: async () => {
      const adapters = createAvailableAdapters()
      adapters.dnsLookup = async () => {
        throw new Error('getaddrinfo ENOTFOUND github.com')
      }
      const result = await evaluatePreflight({
        packageJson: createValidManifest(),
        lockfile: createCompatibleLockfile(),
        npmVersion: '12.0.2',
        adapters
      })
      assert.strictEqual(result.ok, false)
      assert.strictEqual(result.issues[0].code, 'NATIVE_BOOTSTRAP_GITHUB_DNS_FAILED')
    }
  },
  {
    name: 'HTTPS failure -> GITHUB_HTTPS_FAILED',
    run: async () => {
      const adapters = createAvailableAdapters()
      adapters.connectTls = async () => ({
        ok: false,
        error: new Error('connect ECONNREFUSED')
      })
      const result = await evaluatePreflight({
        packageJson: createValidManifest(),
        lockfile: createCompatibleLockfile(),
        npmVersion: '12.0.2',
        adapters
      })
      assert.strictEqual(result.ok, false)
      assert.strictEqual(result.issues[0].code, 'NATIVE_BOOTSTRAP_GITHUB_HTTPS_FAILED')
    }
  },
  {
    name: 'registry failure -> REGISTRY_UNAVAILABLE',
    run: async () => {
      const adapters = createAvailableAdapters()
      adapters.requestHead = async () => ({
        ok: false,
        error: new Error('registry timeout')
      })
      const result = await evaluatePreflight({
        packageJson: createValidManifest(),
        lockfile: createCompatibleLockfile(),
        npmVersion: '12.0.2',
        adapters
      })
      assert.strictEqual(result.ok, false)
      assert.strictEqual(result.issues[0].code, 'NATIVE_BOOTSTRAP_REGISTRY_UNAVAILABLE')
    }
  },
  {
    name: 'policy failure -> nao prossegue para rede',
    run: async () => {
      const calls = []
      const manifest = createValidManifest()
      manifest.devDependencies.electron = '^45.2.3'
      const result = await evaluatePreflight({
        packageJson: manifest,
        lockfile: createCompatibleLockfile(manifest),
        npmVersion: '12.0.2',
        adapters: createAvailableAdapters(calls)
      })
      assert.strictEqual(result.ok, false)
      assert.strictEqual(result.phase, 'policy')
      assert.deepStrictEqual(calls, [])
    }
  },
  {
    name: 'preflight proves installation prerequisites, never executable readiness',
    run: async () => {
      const calls = []
      const result = await evaluatePreflight({
        packageJson: createValidManifest(),
        lockfile: createCompatibleLockfile(),
        npmVersion: '12.0.2',
        adapters: createAvailableAdapters(calls)
      })
      assert.strictEqual(result.ok, true)
      assert.strictEqual(result.phase, 'install-ready')
      assert.strictEqual(result.runtimeChecked, false)
      assert.deepStrictEqual(calls, ['registry', 'dns', 'https'])
    }
  }
]

for (const testCase of cases) test(testCase.name, testCase.run)

const roots = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
function bootstrapFixture({ install = false, observations } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-policy-'))); roots.push(root)
  const cli = path.join(root, 'npm/bin/npm-cli.js')
  fs.mkdirSync(path.dirname(cli), { recursive: true }); fs.writeFileSync(cli, '')
  const userConfig = path.join(root, 'user.npmrc'), globalConfig = path.join(root, 'global.npmrc')
  fs.writeFileSync(userConfig, 'ignore-scripts=true\n'); fs.writeFileSync(globalConfig, 'ignore-scripts=true\n')
  const environment = Object.freeze({ npm_execpath: cli, NPM_CONFIG_IGNORE_SCRIPTS: 'true', npm_config_userconfig: userConfig, npm_config_globalconfig: globalConfig })
  const commands = [], logs = [], checks = []
  let probes = 0
  const options = { projectRoot: root, environment, log: text => logs.push(text),
    preflight: async input => { checks.push(input.checkNetwork); return { ok: true } },
    readLifecycle: () => ({ ignoreScripts: true, source: 'env', code: 'NPM_LIFECYCLE_SCRIPTS_DISABLED', declarations: [{ source: 'env', ignoreScripts: true }] }),
    execute: async (command, args, config) => { commands.push({ command, args, config }); return { status: 0 } },
    doctor: () => observations ? observations[probes++] : { ok: true, checkout: root },
    ensureReadiness: async input => {
      if (install) await input.install(root, {})
      const runtime = await input.verifyRuntime()
      return { status: install || runtime.repaired ? 'REPAIRED' : 'READY' }
    }
  }
  return { root, options, commands, logs, checks, userConfig, globalConfig, probes: () => probes }
}

test('effective ignore-scripts follows npm precedence for global, user, environment and CLI without exposing other config', () => {
  const f = bootstrapFixture()
  for (const source of ['global', 'user', 'env', 'cli']) {
    const stdout = `; "default" config from default values\n; ignore-scripts = false ; overridden by ${source}\n; "${source}" config from selected configuration\nignore-scripts = true\n_authToken = private-fixture-token\n`
    const observed = readNpmLifecyclePolicy({ projectRoot: f.root, environment: f.options.environment, run: () => ({ status: 0, stdout }) })
    assert.strictEqual(observed.ignoreScripts, true); assert.strictEqual(observed.source, source)
    assert.strictEqual(observed.code, 'NPM_LIFECYCLE_SCRIPTS_DISABLED')
    assert.ok(!JSON.stringify(observed).includes('private-fixture-token'))
  }
  const enabled = readNpmLifecyclePolicy({ environment: f.options.environment, run: () => ({ status: 0, stdout: '; "user" config from user\n; ignore-scripts = true ; overridden by env\n; "env" config from environment\nignore-scripts = false\n' }) })
  assert.strictEqual(enabled.ignoreScripts, false); assert.strictEqual(enabled.source, 'env')
})

test('scoped lifecycle environment never mutates inherited settings or unrelated policy', () => {
  const inherited = Object.freeze({ NPM_CONFIG_IGNORE_SCRIPTS: 'true', npm_config_ignore_scripts: 'true', ELECTRON_SKIP_BINARY_DOWNLOAD: '1' })
  const scoped = lifecyclePreparationEnvironment(inherited)
  assert.deepStrictEqual(scoped, { npm_config_ignore_scripts: 'false', ELECTRON_SKIP_BINARY_DOWNLOAD: '1' })
  assert.strictEqual(inherited.NPM_CONFIG_IGNORE_SCRIPTS, 'true')
})

test('unknown or unreadable lifecycle policy fails closed', () => {
  const f = bootstrapFixture()
  for (const result of [{ status: 1, error: new Error('policy denied') }, { status: 0, stdout: '' }]) assert.throws(() => readNpmLifecyclePolicy({ environment: f.options.environment, run: () => result }), /NPM_LIFECYCLE_POLICY_UNKNOWN/)
})

test('opt-in installation overrides lifecycle only in its ci subprocess and preserves user/global files', async () => {
  const f = bootstrapFixture({ install: true })
  assert.strictEqual((await runBootstrap(f.options)).status, 'REPAIRED')
  assert.strictEqual(f.commands.length, 1)
  assert.ok(f.commands[0].args.includes('ci')); assert.ok(f.commands[0].args.includes('--ignore-scripts=false'))
  assert.strictEqual(f.commands[0].config.cwd, f.root)
  assert.strictEqual(f.commands[0].config.env.npm_config_ignore_scripts, 'false')
  assert.strictEqual(f.options.environment.NPM_CONFIG_IGNORE_SCRIPTS, 'true')
  assert.strictEqual(fs.readFileSync(f.userConfig, 'utf8'), 'ignore-scripts=true\n')
  assert.strictEqual(fs.readFileSync(f.globalConfig, 'utf8'), 'ignore-scripts=true\n')
  assert.deepStrictEqual(f.checks, [false, undefined])
  assert.ok(f.logs.some(line => line.includes('NPM_LIFECYCLE_SCRIPTS_DISABLED')))
})

test('normal installation with healthy doctor never rebuilds again', async () => {
  const f = bootstrapFixture({ install: true })
  f.options.readLifecycle = () => ({ ignoreScripts: false, source: 'default', code: 'NPM_LIFECYCLE_SCRIPTS_ENABLED', declarations: [] })
  await runBootstrap(f.options)
  assert.strictEqual(f.commands.length, 1)
  assert.ok(!f.commands.some(command => command.args.includes('native:prepare')))
})

test('ready worktree passes again without reinstall, rebuild or network preflight', async () => {
  const f = bootstrapFixture()
  assert.strictEqual((await runBootstrap(f.options)).status, 'READY')
  assert.strictEqual((await runBootstrap(f.options)).status, 'READY')
  assert.strictEqual(f.commands.length, 0)
  assert.deepStrictEqual(f.checks, [false, false])
})

test('missing Electron runs its existing installer and native preparation once before a successful doctor', async () => {
  const f = bootstrapFixture()
  const observed = [{ ok: false, repairable: true, issues: [{ code: 'ELECTRON_BINARY_MISSING', property: 'Electron runtime' }] }, { ok: true, checkout: f.root }]
  f.options.doctor = () => observed.shift()
  assert.strictEqual((await runBootstrap(f.options)).status, 'REPAIRED')
  assert.strictEqual(f.commands.length, 2)
  assert.ok(f.commands[0].args.includes('electron')); assert.ok(f.commands[1].args.includes('native:prepare'))
  assert.ok(f.commands[1].args.includes('--force'))
  assert.strictEqual(observed.length, 0)
})

test('ABI/addon recovery is bounded; a failing second doctor never returns readiness', async () => {
  const broken = { ok: false, repairable: true, issues: [{ code: 'NATIVE_RUNTIME_INVALID', property: 'better-sqlite3', found: 'NODE_MODULE_VERSION mismatch' }] }
  const f = bootstrapFixture({ observations: [broken, broken] })
  await assert.rejects(runBootstrap(f.options), /NATIVE_BOOTSTRAP_RUNTIME_INVALID_AFTER_REPAIR/)
  assert.strictEqual(f.probes(), 2); assert.strictEqual(f.commands.length, 1)
  assert.ok(f.commands[0].args.includes('native:prepare'))
  assert.ok(!f.logs.some(line => /Native Bootstrap  (READY|REPAIRED)/.test(line)))
})

test('network, credential or policy refusal never triggers native recovery or installer retries', async () => {
  for (const cause of ['EACCES host policy prohibits lifecycle', 'network unavailable', 'credential denied']) {
    const f = bootstrapFixture({ install: true })
    f.options.execute = async (...args) => { f.commands.push(args); return { status: 1, stdout: 'Native Runtime    INVALID', stderr: cause } }
    f.options.doctor = () => { throw new Error('doctor must not run') }
    await assert.rejects(runBootstrap(f.options), /NATIVE_BOOTSTRAP_INSTALL_FAILED/)
    assert.strictEqual(f.commands.length, 1)
    assert.ok(!f.logs.some(line => /Native Bootstrap  (READY|REPAIRED)/.test(line)))
  }
})

test('execution policy and wrong-checkout evidence cannot be repaired into readiness', async () => {
  const f = bootstrapFixture()
  f.options.doctor = () => ({ ok: false, repairable: false, issues: [{ code: 'NATIVE_RUNTIME_EXECUTION_BLOCKED', property: 'Electron runtime', found: 'EPERM' }] })
  await assert.rejects(runBootstrap(f.options), /NATIVE_BOOTSTRAP_RUNTIME_BLOCKED/)
  assert.strictEqual(f.commands.length, 0)
  f.options.doctor = () => ({ ok: true, checkout: path.dirname(f.root) })
  await assert.rejects(runBootstrap(f.options), /NATIVE_BOOTSTRAP_CHECKOUT_MISMATCH/)
})
