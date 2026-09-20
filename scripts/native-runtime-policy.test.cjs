/*
-T ---
*/

const assert = require('assert')
const { spawnSync } = require('child_process')
const path = require('path')
const {
  ELECTRON_DESKTOP_ENVIRONMENT_CODE,
  createDesktopEnvironmentIssue,
  inspectElectronDesktopEnvironment,
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
  },
  {
    name: 'Desktop environment limpo e aceito',
    run: () => {
      const inspection = inspectElectronDesktopEnvironment({})
      assert.strictEqual(inspection.healthy, true)
      assert.strictEqual(createDesktopEnvironmentIssue({}), null)
    }
  },
  {
    name: 'ELECTRON_RUN_AS_NODE=1 rejeitado com codigo especifico',
    run: () => {
      const inspection = inspectElectronDesktopEnvironment({ ELECTRON_RUN_AS_NODE: '1' })
      assert.strictEqual(inspection.healthy, false)
      assert.strictEqual(inspection.code, ELECTRON_DESKTOP_ENVIRONMENT_CODE)
      const issue = createDesktopEnvironmentIssue({ ELECTRON_RUN_AS_NODE: '1' })
      assert.strictEqual(issue.code, ELECTRON_DESKTOP_ENVIRONMENT_CODE)
      assert.strictEqual(issue.property, 'Electron Desktop Environment')
    }
  },
  {
    name: 'Doctor falha com exit nao-zero e nao muta o ambiente',
    run: () => {
      const doctorPath = path.join(__dirname, 'native-runtime-doctor.cjs')
      const before = process.env.ELECTRON_RUN_AS_NODE
      const result = spawnSync(process.execPath, [doctorPath], {
        encoding: 'utf8',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      })
      assert.notStrictEqual(result.status, 0)
      const output = `${result.stdout || ''}\n${result.stderr || ''}`
      assert.ok(output.includes(ELECTRON_DESKTOP_ENVIRONMENT_CODE))
      assert.ok(output.includes('Electron Desktop Environment'))
      assert.strictEqual(process.env.ELECTRON_RUN_AS_NODE, before)
      assert.strictEqual(result.stdout.includes('start electron app'), false)
    }
  },
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
