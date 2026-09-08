/*
-T ---
*/

const assert = require('assert')
const {
  validatePackageManifest,
  validateNpmUserAgent
} = require('./native-runtime-policy.cjs')

function createValidManifest() {
  return {
    packageManager: 'npm@10.9.4',
    dependencies: {
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

const cases = [
  {
    name: 'Electron com range e rejeitado',
    run: () => {
      const manifest = createValidManifest()
      manifest.devDependencies.electron = '^32.0.0'
      const result = validatePackageManifest(manifest)
      assert.strictEqual(result.ok, false)
      assert.ok(result.issues.some((issue) => issue.property === 'devDependencies.electron'))
    }
  },
  {
    name: 'Electron exato e aprovado',
    run: () => {
      const result = validatePackageManifest(createValidManifest())
      assert.strictEqual(result.ok, true)
    }
  },
  {
    name: 'Dependencia nativa obrigatoria ausente e rejeitada',
    run: () => {
      const manifest = createValidManifest()
      delete manifest.dependencies['better-sqlite3']
      const result = validatePackageManifest(manifest)
      assert.strictEqual(result.ok, false)
      assert.ok(result.issues.some((issue) => issue.property === 'dependencies.better-sqlite3'))
    }
  },
  {
    name: 'tree-sitter-javascript apenas transitivo e rejeitado',
    run: () => {
      const manifest = createValidManifest()
      delete manifest.dependencies['tree-sitter-javascript']
      const result = validatePackageManifest(manifest)
      assert.strictEqual(result.ok, false)
      assert.ok(result.issues.some((issue) => issue.property === 'dependencies.tree-sitter-javascript'))
    }
  },
  {
    name: 'Manifesto correto e aprovado',
    run: () => {
      const result = validatePackageManifest(createValidManifest())
      assert.deepStrictEqual(result.issues, [])
      assert.strictEqual(result.ok, true)
    }
  },
  {
    name: 'npm fora do major autorizado e rejeitado',
    run: () => {
      const result = validateNpmUserAgent('npm/12.0.2 node/v24.18.0 win32 x64 workspaces/false')
      assert.strictEqual(result.ok, false)
      assert.ok(result.issues.some((issue) => issue.property === 'npm major'))
    }
  }
]

let failures = 0

for (const testCase of cases) {
  try {
    testCase.run()
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

console.log('Native Runtime Policy tests PASS')
