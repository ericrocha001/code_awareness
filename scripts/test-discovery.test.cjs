const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')

const configRoot = path.resolve(__dirname, '..')
const native = 'src/main/continuum/artifact-structure.test.ts'
const heavy = 'src/main/git-operations/git-worktree-operations.git.test.ts'
const benchmarks = ['src/main/core/context/progressive-navigation-real.benchmark.ts', 'src/main/core/context/member-resolution-real.benchmark.ts']
const nodeFiles = ['src/checkout.test.ts', 'src/view.test.tsx', 'src/example.spec.js', 'infra/gateway/domain/checkout.test.ts', 'docs/spikes/checkout.test.mjs']
const rest = 'src/small.git.test.ts', e2e = 'src/checkout.e2e.test.ts', script = 'scripts/checkout.test.cjs'
const cases = [
  ['vitest.config.ts', nodeFiles],
  ['vitest.e2e.config.ts', [...nodeFiles, rest, heavy, e2e, native, script]],
  ['vitest.git.config.ts', [rest, heavy]],
  ['vitest.git-rest.config.ts', [rest]],
  ['vitest.git-heavy.config.ts', [heavy]],
  ['vitest.native.config.ts', [native]],
  ['vitest.benchmark.config.ts', benchmarks]
]

test('Vitest discovers only authorized checkout trees and preserves each lane', async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'checkout-discovery-'))
  const child = path.join(temporary, '.code-awareness/pilot/target')
  const paths = [...nodeFiles, rest, heavy, e2e, native, script, ...benchmarks]
  const write = (root, file) => {
    const destination = path.join(root, file)
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.writeFileSync(destination, "throw Error('Discovery must not execute test or benchmark bodies')\n")
  }
  for (const root of [temporary, child, path.join(temporary, 'src/.code-awareness/pilot/target')]) for (const file of paths) write(root, file)
  write(temporary, 'unauthorized/src/checkout.test.ts')
  const { createVitest } = await import('vitest/node')
  const collect = async (root, config, filters) => {
    const vitest = await createVitest('test', { root, config: path.join(configRoot, config), watch: false })
    try {
      const specs = await vitest.globTestSpecifications(filters)
      return specs.map(spec => path.relative(root, spec.moduleId).replace(/\\/g, '/')).sort()
    } finally { await vitest.close() }
  }
  try {
    for (const [config, expected] of cases) await t.test(config, async () => {
      const files = await collect(temporary, config)
      assert.deepEqual(files, [...expected].sort())
      assert.equal(new Set(files).size, files.length)
    })
    await t.test('targeted filters cannot select the nested namesake', async () => {
      assert.deepEqual(await collect(temporary, 'vitest.config.ts', ['checkout.test.ts']), ['infra/gateway/domain/checkout.test.ts', 'src/checkout.test.ts'])
      assert.deepEqual(await collect(temporary, 'vitest.config.ts', ['.code-awareness/pilot/target/src/checkout.test.ts']), [])
    })
    await t.test('explicit child root remains independently collectable', async () => {
      assert.deepEqual(await collect(child, 'vitest.config.ts'), [...nodeFiles].sort())
    })
  } finally {
    assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()))
    assert.ok(path.basename(temporary).startsWith('checkout-discovery-'))
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})
