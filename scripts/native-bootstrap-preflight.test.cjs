/*
-T ---
*/

const assert = require('assert')
const { evaluatePreflight } = require('./native-bootstrap-preflight.cjs')

function createValidManifest() {
  return {
    packageManager: 'npm@10.9.4',
    dependencies: {
      '@tanstack/react-virtual': '^3.13.0',
      'better-sqlite3': '12.11.1',
      'tree-sitter': '0.21.1',
      'tree-sitter-typescript': '0.23.2',
      'tree-sitter-javascript': '0.23.1'
    },
    devDependencies: {
      electron: '32.0.0',
      vitest: '3.2.7'
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
        npmVersion: '10.9.4',
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
        npmVersion: '10.9.4',
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
        npmVersion: '10.9.4',
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
      manifest.devDependencies.electron = '^32.0.0'
      const result = await evaluatePreflight({
        packageJson: manifest,
        lockfile: createCompatibleLockfile(manifest),
        npmVersion: '10.9.4',
        adapters: createAvailableAdapters(calls)
      })
      assert.strictEqual(result.ok, false)
      assert.strictEqual(result.phase, 'policy')
      assert.deepStrictEqual(calls, [])
    }
  },
  {
    name: 'tudo disponivel -> READY',
    run: async () => {
      const calls = []
      const result = await evaluatePreflight({
        packageJson: createValidManifest(),
        lockfile: createCompatibleLockfile(),
        npmVersion: '10.9.4',
        adapters: createAvailableAdapters(calls)
      })
      assert.strictEqual(result.ok, true)
      assert.strictEqual(result.phase, 'ready')
      assert.deepStrictEqual(calls, ['registry', 'dns', 'https'])
    }
  }
]

async function runAll() {
  let failures = 0

  for (const testCase of cases) {
    try {
      await testCase.run()
      console.log(`${testCase.name}: PASS`)
    } catch (error) {
      failures++
      console.error(`${testCase.name}: FAIL`)
      console.error(error)
    }
  }

  if (failures > 0) {
    process.exit(1)
  }

  console.log('Native Bootstrap Preflight tests PASS')
}

runAll().catch((error) => {
  console.error(error)
  process.exit(1)
})
