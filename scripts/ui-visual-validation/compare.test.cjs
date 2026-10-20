const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const sharp = require('sharp')
const { evidenceRoot, comparisonDirectory } = require('./evidence.cjs')

let directory, reference, actual, metadata
const originals = new Map(), results = []
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')

before(async () => {
  directory = comparisonDirectory()
  reference = path.join(directory, 'synthetic-reference.png')
  actual = path.join(directory, 'synthetic-actual.png')
  metadata = path.join(directory, 'metadata.json')
  fs.writeFileSync(reference, await sharp({ create: { width: 64, height: 40, channels: 3, background: '#ff0000' } }).png().toBuffer())
  fs.writeFileSync(actual, await sharp({ create: { width: 64, height: 40, channels: 3, background: '#0000ff' } }).png().toBuffer())
  fs.writeFileSync(metadata, JSON.stringify({ reference: { viewport: { width: 64, height: 40 }, scale: 1 }, actual: { viewport: { width: 64, height: 40 }, scale: 1 } }))
  for (const file of [reference, actual, metadata]) originals.set(file, hash(file))
})

function invoke(extra = []) {
  const args = ['--reference', reference, '--reference-approved', '--actual', actual, '--origin', 'USER_RUNTIME_SCREENSHOT', '--metadata', metadata]
  for (const [key, value] of extra) args[args.indexOf(key) + 1] = value
  const execution = spawnSync(process.execPath, [path.join(__dirname, 'compare.cjs'), ...args], { encoding: 'utf8', windowsHide: true })
  assert.ifError(execution.error)
  const manifest = JSON.parse(execution.stdout)
  results.push({ exitCode: execution.status, ...manifest })
  assert.ok(manifest.directory.startsWith(evidenceRoot + path.sep))
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(manifest.directory, 'comparison.json'), 'utf8')).state, manifest.state)
  assert.equal(manifest.gates.visualAcceptance, 'NOT_REVIEWED')
  return { exitCode: execution.status, manifest }
}

test('standalone CLI composes declared synthetic input fixtures without Electron', async () => {
  const { exitCode, manifest } = invoke()
  assert.equal(exitCode, 0)
  assert.equal(manifest.state, 'READY_FOR_REVIEW')
  assert.equal(manifest.reference.sha256, originals.get(reference))
  assert.equal(manifest.actual.sha256, originals.get(actual))
  assert.equal(manifest.referenceApproval.authority, 'CALLER_DECLARATION')
  const sideFile = path.join(manifest.directory, 'side-by-side.png'), overlayFile = path.join(manifest.directory, 'overlay.png')
  assert.equal(hash(sideFile), manifest.outputs.sideBySide.sha256)
  assert.equal(hash(overlayFile), manifest.outputs.overlay.sha256)
  const side = await sharp(sideFile).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const overlay = await sharp(overlayFile).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  assert.equal(side.info.width, 128)
  assert.equal(side.info.height, 40)
  assert.equal(overlay.info.width, 64)
  assert.equal(overlay.info.height, 40)
  for (let y = 0; y < 40; y++) for (let x = 0; x < 128; x++) {
    const offset = (y * 128 + x) * 3
    assert.deepEqual([...side.data.subarray(offset, offset + 3)], x < 64 ? [255, 0, 0] : [0, 0, 255])
  }
  for (let offset = 0; offset < overlay.data.length; offset += 3) assert.deepEqual([...overlay.data.subarray(offset, offset + 3)], [128, 0, 128])
})

function expectClosed(extra, reason) {
  const { exitCode, manifest } = invoke(extra)
  assert.equal(exitCode, 1)
  assert.equal(manifest.state, 'ERROR')
  assert.equal(manifest.error.code, reason)
  assert.equal(manifest.gates.comparison, 'NOT_READY')
  assert.deepEqual(fs.readdirSync(manifest.directory), ['comparison.json'])
}

test('truncated PNG fails closed without overwriting either input', () => {
  const truncated = path.join(directory, 'truncated.png')
  fs.writeFileSync(truncated, fs.readFileSync(reference).subarray(0, 32))
  originals.set(truncated, hash(truncated))
  expectClosed([['--reference', truncated]], 'PNG_INVALID')
})

test('equal pixel dimensions with incompatible known viewport and scale are refused', () => {
  const mismatch = path.join(directory, 'incompatible-geometry.json')
  fs.writeFileSync(mismatch, JSON.stringify({ reference: { viewport: { width: 32, height: 20 }, scale: 2 }, actual: { viewport: { width: 64, height: 40 }, scale: 1 } }))
  originals.set(mismatch, hash(mismatch))
  expectClosed([['--metadata', mismatch]], 'GEOMETRY_INCOMPATIBLE')
})

test('network path is refused before file access and creates only safe error evidence', () => {
  expectClosed([['--reference', '\\\\unapproved-host\\reference.png']], 'PATH_UNAUTHORIZED')
})

after(() => {
  for (const [file, expected] of originals) assert.equal(hash(file), expected)
  fs.writeFileSync(path.join(directory, 'verification.json'), JSON.stringify({
    purpose: 'Functional regression fixtures only; USER_RUNTIME_SCREENSHOT is a simulated caller declaration, not proof of an actual application screenshot or design approval.',
    immutableInputs: true, results
  }, null, 2))
  console.log(`Comparator evidence: ${directory}`)
})
