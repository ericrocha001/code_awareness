const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { createHash } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { ensureProduction } = require('./build.cjs')

function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'ca-cli-preflight-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const name of ['src/main/work-orchestration/runtime-preview/windows/Win32.cs', 'src/main/cli-execution/windows/CliJobOwner.cs']) {
    const target = join(root, name)
    fs.mkdirSync(resolve(target, '..'), { recursive: true })
    fs.copyFileSync(join(__dirname, '../..', name), target)
  }
  return root
}

test('production preflight builds cold and preserves valid artifacts on repeated calls', t => {
  const root = fixture(t)
  const cold = ensureProduction(root)
  assert.equal(cold.rebuilt, true)
  const receipt = JSON.parse(fs.readFileSync(cold.receipt, 'utf8'))
  const bytes = fs.readFileSync(cold.executable)
  assert.equal(receipt.inputs.test, false)
  assert.equal(receipt.output.size, bytes.length)
  assert.equal(receipt.output.sha256, createHash('sha256').update(bytes).digest('hex'))
  for (const file of [cold.executable, cold.receipt]) fs.utimesSync(file, 946684800, 946684800)
  for (let i = 0; i < 4; i++) assert.equal(ensureProduction(root).rebuilt, false)
  for (const file of [cold.executable, cold.receipt]) assert.equal(fs.statSync(file).mtimeMs, 946684800000)
})

test('preflight rejects stale build inputs even with intact executable bytes', t => {
  const root = fixture(t)
  const output = ensureProduction(root)
  fs.appendFileSync(join(root, 'src/main/cli-execution/windows/CliJobOwner.cs'), '\n')
  assert.equal(ensureProduction(root).rebuilt, true)
  for (const mutate of [
    receipt => { receipt.inputs.recipe = 'old recipe' },
    receipt => { receipt.inputs.compiler = 'old compiler' },
    receipt => { receipt.inputs.references[0].sha256 = 'old reference' },
    receipt => { receipt.inputs.test = true }
  ]) {
    const receipt = JSON.parse(fs.readFileSync(output.receipt, 'utf8'))
    mutate(receipt)
    fs.writeFileSync(output.receipt, JSON.stringify(receipt))
    assert.equal(ensureProduction(root).rebuilt, true)
    assert.equal(ensureProduction(root).rebuilt, false)
  }
  fs.appendFileSync(output.executable, 'corruption')
  assert.equal(ensureProduction(root).rebuilt, true)
  fs.writeFileSync(output.receipt, 'invalid JSON')
  assert.equal(ensureProduction(root).rebuilt, true)
})

test('compiler failure is an explicit environment failure and cannot reuse stale output', t => {
  const root = fixture(t)
  ensureProduction(root)
  fs.writeFileSync(join(root, 'src/main/cli-execution/windows/CliJobOwner.cs'), 'invalid C# source')
  assert.throws(() => ensureProduction(root), /CLI_TEST_ENVIRONMENT_UNAVAILABLE:.*CLI_NATIVE_BUILD_FAILED/)
})

test('unsupported platform fails explicitly instead of skipping dependent tests', () => {
  const result = spawnSync(process.execPath, ['-e', `
    Object.defineProperty(process, 'platform', { value: 'linux' });
    require(${JSON.stringify(join(__dirname, 'build.cjs'))}).ensureProduction();
  `], { encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /CLI_TEST_ENVIRONMENT_UNAVAILABLE:.*WINDOWS_REQUIRED/)
})
