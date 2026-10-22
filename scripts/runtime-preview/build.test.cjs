const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { createInterface } = require('node:readline')
const { randomUUID, createHash } = require('node:crypto')
const { build } = require('./build.cjs')
if (process.platform !== 'win32') throw new Error('REAL_WINDOWS_REQUIRED')
const root = path.resolve('.code-awareness/nb', randomUUID().slice(0, 8))
fs.mkdirSync(root, { recursive: true })
console.log(JSON.stringify({ evidenceRoot: root, platform: process.platform, windows: require('node:os').release() }))
const source = 'src/main/work-orchestration/runtime-preview/windows/'
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
function checkout() {
  const target = fs.mkdtempSync(path.join(root, 'case-'))
  for (const file of [source + 'Win32.cs', source + 'PreviewOwner.cs', 'scripts/runtime-preview/ControlledHelper.cs']) {
    fs.mkdirSync(path.dirname(path.join(target, file)), { recursive: true }); fs.copyFileSync(file, path.join(target, file))
  }
  return target
}
const fileState = file => {
  const stat = fs.statSync(file, { bigint: true })
  return { sha256: hash(file), mtime: stat.mtimeNs, birthtime: stat.birthtimeNs, size: stat.size, inode: stat.ino }
}
function compileChild(root) {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(require(process.argv[1]).build(false,{root:process.argv[2]})))', path.resolve(__dirname, 'build.cjs'), root], { stdio: 'pipe', windowsHide: true })
    let stdout = '', stderr = ''; child.stdout.on('data', b => { stdout += b }); child.stderr.on('data', b => { stderr += b })
    child.once('error', reject); child.once('close', code => code === 0 ? accept(JSON.parse(stdout)) : reject(new Error(stderr)))
  })
}
async function withLiveOwner(binary, run) {
  const child = spawn(binary, [], { stdio: 'pipe', windowsHide: true, env: { SystemRoot: process.env.SystemRoot } })
  const closed = new Promise((accept, reject) => { child.once('close', accept); child.once('error', reject) })
  let diagnostic = ''; child.stderr.on('data', bytes => { diagnostic += bytes })
  const lines = createInterface({ input: child.stdout }), replies = lines[Symbol.asyncIterator]()
  try {
    const ping = async () => {
      child.stdin.write(JSON.stringify({ id: 1, action: 'reconcile', sessionId: randomUUID(), pid: 0, created: null }) + '\n')
      const next = await replies.next(); assert.equal(next.done, false, diagnostic); assert.equal(JSON.parse(next.value).success, true)
      assert.equal(child.exitCode, null)
    }
    await ping(); await run(ping)
  } finally { child.stdin.end(); await closed; lines.close() }
}
test('equivalent builds reuse the same verified files while the owner executable is running', async () => {
  const target = checkout(), first = build(false, { root: target })
  const before = [fileState(first.owner), fileState(first.receipt)]
  await withLiveOwner(first.owner, async ping => {
    const second = build(false, { root: target })
    assert.equal(second.reused, true); assert.equal(second.owner, first.owner); assert.equal(second.buildId, first.buildId)
    assert.equal(second.fingerprint, hash(second.owner)); assert.deepEqual([fileState(first.owner), fileState(first.receipt)], before)
    await ping()
  })
})
test('changed source publishes another executable without replacing a live previous version', async () => {
  const target = checkout(), first = build(false, { root: target }), before = fileState(first.owner)
  await withLiveOwner(first.owner, async ping => {
    const file = path.join(target, source, 'PreviewOwner.cs')
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('internal sealed class Launch\n{', 'internal sealed class Launch\n{\n    public const string BuildVariation = "changed";').replace('internal sealed class Launch\r\n{', 'internal sealed class Launch\r\n{\r\n    public const string BuildVariation = "changed";'))
    const second = build(false, { root: target })
    assert.notEqual(second.buildId, first.buildId); assert.notEqual(second.owner, first.owner)
    assert.deepEqual(fileState(first.owner), before); await ping()
    await withLiveOwner(second.owner, async pingNew => pingNew())
  })
})
test('test and production identities, receipts and binaries remain distinct', () => {
  const target = checkout(), production = build(false, { root: target }), testing = build(true, { root: target })
  assert.notEqual(testing.buildId, production.buildId); assert.notEqual(testing.fingerprint, production.fingerprint)
  assert.equal(production.fixture, undefined); assert.ok(fs.existsSync(testing.fixture))
  const p = JSON.parse(fs.readFileSync(production.receipt)), t = JSON.parse(fs.readFileSync(testing.receipt))
  assert.equal(p.inputs.mode, 'production'); assert.equal(t.inputs.mode, 'test')
  assert.deepEqual(p.inputs.targets[0].defines, []); assert.deepEqual(t.inputs.targets[0].defines, ['/define:PREVIEW_TEST'])
  assert.equal(p.inputs.architecture, 'x64'); assert.ok(p.inputs.options.includes('/noconfig'))
  assert.equal(p.inputs.compiler.files.length, 3); assert.equal(p.inputs.references.length, 4)
  assert.equal(createHash('sha256').update(JSON.stringify(p.inputs)).digest('hex'), production.buildId)
  const fixture = path.join(target, 'scripts/runtime-preview/ControlledHelper.cs'); fs.appendFileSync(fixture, '\n// fixture variation\n')
  assert.equal(build(false, { root: target }).owner, production.owner)
  assert.notEqual(build(true, { root: target }).buildId, testing.buildId)
})
test('four independent concurrent builders publish one complete immutable winner', async () => {
  const target = checkout(), results = await Promise.all(Array.from({ length: 4 }, () => compileChild(target)))
  assert.equal(new Set(results.map(r => r.owner)).size, 1); assert.equal(new Set(results.map(r => r.fingerprint)).size, 1)
  assert.equal(results.filter(r => !r.reused).length, 1)
  assert.equal(build(false, { root: target }).reused, true)
  assert.deepEqual(fs.readdirSync(path.join(target, 'out/runtime-preview/production')), [results[0].buildId])
  await withLiveOwner(results[0].owner, async ping => ping())
})
for (const corruption of ['binary', 'receipt', 'missing-receipt']) test('fails closed without replacing a published artifact: ' + corruption, () => {
  const target = checkout(), first = build(false, { root: target })
  if (corruption === 'binary') fs.appendFileSync(first.owner, 'corrupt')
  if (corruption === 'receipt') fs.writeFileSync(first.receipt, '{}')
  if (corruption === 'missing-receipt') fs.unlinkSync(first.receipt)
  const before = fileState(first.owner)
  assert.throws(() => build(false, { root: target }), /NATIVE_BUILD_ARTIFACT_INVALID/)
  assert.deepEqual(fileState(first.owner), before)
})
test('compiler failure publishes no partial build and preserves older artifacts', () => {
  const target = checkout(), first = build(false, { root: target }), before = fileState(first.owner)
  fs.appendFileSync(path.join(target, source, 'PreviewOwner.cs'), '\ninvalid syntax here\n')
  assert.throws(() => build(false, { root: target }), /NATIVE_BUILD_COMPILE_FAILED/)
  assert.deepEqual(fs.readdirSync(path.dirname(path.dirname(first.owner))), [first.buildId])
  assert.deepEqual(fileState(first.owner), before)
})
