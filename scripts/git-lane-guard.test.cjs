const assert = require('assert')
const { spawnSync } = require('child_process')
const path = require('path')
const {
  GIT_HEAVY_SUITES,
  findGitTestFiles,
  partitionGitSuites,
  validateGitPartition
} = require('./git-lane-guard.cjs')

const cases = [
  {
    name: 'Valida a particao real do repositorio com sucesso',
    run: () => {
      const result = validateGitPartition()
      assert.strictEqual(result.valid, true, `Erros encontrados: ${result.errors.join(', ')}`)
      assert.strictEqual(result.heavy.length, 1)
      assert.strictEqual(result.heavy[0], 'src/main/git-operations/git-worktree-operations.git.test.ts')
      assert.ok(result.rest.length >= 13)
      assert.strictEqual(result.heavy.length + result.rest.length, result.allFiles.length)
    }
  },
  {
    name: 'Nova suite Git generica e alocada automaticamente em Git Rest preservando a uniao',
    run: () => {
      const baseFiles = findGitTestFiles()
      const syntheticFiles = [...baseFiles, 'src/main/foo/nova-feature.git.test.ts'].sort()
      const result = validateGitPartition({ allFiles: syntheticFiles })
      assert.strictEqual(result.valid, true)
      assert.ok(result.rest.includes('src/main/foo/nova-feature.git.test.ts'))
      assert.ok(!result.heavy.includes('src/main/foo/nova-feature.git.test.ts'))
      assert.strictEqual(result.heavy.length + result.rest.length, syntheticFiles.length)
    }
  },
  {
    name: 'Suite pesada ausente do conjunto de testes gera erro',
    run: () => {
      const syntheticFiles = ['src/main/core/diff-service.git.test.ts']
      const result = validateGitPartition({ allFiles: syntheticFiles })
      assert.strictEqual(result.valid, false)
      assert.ok(result.errors.some(e => e.includes('Suite pesada Git ausente')))
    }
  },
  {
    name: 'Lista com caminhos duplicados gera erro',
    run: () => {
      const baseFiles = findGitTestFiles()
      const duplicatedFiles = [...baseFiles, baseFiles[0]]
      const result = validateGitPartition({ allFiles: duplicatedFiles })
      assert.strictEqual(result.valid, false)
      assert.ok(result.errors.some(e => e.includes('caminhos duplicados')))
    }
  },
  {
    name: 'Particao Heavy vazia gera erro',
    run: () => {
      const baseFiles = findGitTestFiles()
      const result = validateGitPartition({ allFiles: baseFiles, heavyFiles: [] })
      assert.strictEqual(result.valid, false)
      assert.ok(result.errors.some(e => e.includes('Git Heavy esta vazia')))
    }
  },
  {
    name: 'CLI executa e retorna codigo 0 na arvore valida',
    run: () => {
      const proc = spawnSync(process.execPath, [path.join(__dirname, 'git-lane-guard.cjs')], {
        encoding: 'utf8'
      })
      assert.strictEqual(proc.status, 0, proc.stderr)
      assert.ok(proc.stdout.includes('Git Lane Partition PASS'))
    }
  }
]

let passed = 0
for (const testCase of cases) {
  try {
    testCase.run()
    console.log(`PASS: ${testCase.name}`)
    passed++
  } catch (error) {
    console.error(`FAIL: ${testCase.name}`)
    console.error(error)
    process.exit(1)
  }
}

console.log(`\nTodos os ${passed} testes de git-lane-guard foram aprovados.`)
