const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { comparisonDirectory, localPath, isStem } = require('./evidence.cjs')

const maxPixels = 32000000
const fail = (code, message) => { throw Object.assign(new Error(message), { code }) }
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

function readPng(file) {
  const resolved = localPath(file)
  if (path.extname(resolved).toLowerCase() !== '.png') fail('PNG_INVALID', 'Inputs must be PNG files')
  if (!fs.lstatSync(resolved).isFile()) fail('PNG_INVALID', 'Input must be a regular file')
  const fd = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.size > 64 * 1024 * 1024) fail('PNG_INVALID', 'Input must be a regular PNG of at most 64 MiB')
    const bytes = fs.readFileSync(fd)
    if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.toString('ascii', 12, 16) !== 'IHDR') fail('PNG_INVALID', 'Invalid PNG header')
    let offset = 8, ended = false
    while (offset + 12 <= bytes.length) {
      const size = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8)
      if (offset + size + 12 > bytes.length || type === 'acTL') fail('PNG_INVALID', 'Truncated or animated PNG is not supported')
      offset += size + 12
      if (type === 'IEND') { ended = size === 0 && offset === bytes.length; break }
    }
    if (!ended) fail('PNG_INVALID', 'PNG must end with IEND')
    return { resolved, bytes }
  } finally { fs.closeSync(fd) }
}

function geometry(metadata, width, height) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) fail('METADATA_INVALID', 'Image metadata must be an object')
  const { viewport, scale } = metadata
  if (metadata.theme != null && (typeof metadata.theme !== 'string' || !metadata.theme.trim())) fail('METADATA_INVALID', 'Theme must be a nonempty string when known')
  if (scale !== undefined && (!Number.isFinite(scale) || scale <= 0)) fail('METADATA_INVALID', 'Scale must be positive')
  if (viewport !== undefined) {
    if (!viewport || !Number.isInteger(viewport.width) || !Number.isInteger(viewport.height) || viewport.width <= 0 || viewport.height <= 0) fail('METADATA_INVALID', 'Viewport must have positive integer dimensions')
    const inferredScale = width / viewport.width
    if (Math.abs(height / viewport.height - inferredScale) > .001 || scale !== undefined && (Math.abs(width - viewport.width * scale) > 1 || Math.abs(height - viewport.height * scale) > 1)) fail('GEOMETRY_INCOMPATIBLE', 'Viewport/scale does not match PNG dimensions')
    return { viewport, scale: scale ?? inferredScale, scaleSource: scale === undefined ? 'DERIVED_FROM_VIEWPORT' : 'DECLARED' }
  }
  return { viewport: null, scale: scale ?? null, scaleSource: scale === undefined ? 'UNKNOWN' : 'DECLARED' }
}

async function imageInput(file, metadata, directory, sharp) {
  const { resolved, bytes } = readPng(file)
  const decoded = await sharp(bytes, { limitInputPixels: maxPixels, failOn: 'warning' }).metadata()
  if (decoded.format !== 'png' || (decoded.pages ?? 1) !== 1 || !decoded.width || !decoded.height || decoded.width * decoded.height > maxPixels || (decoded.orientation ?? 1) !== 1) fail('PNG_INVALID', 'A static, unrotated PNG within the pixel budget is required')
  const pixels = await sharp(bytes, { limitInputPixels: maxPixels, failOn: 'warning' }).flatten({ background: '#ffffff' }).toColourspace('srgb').removeAlpha().raw().toBuffer()
  return {
    pixels,
    record: { path: path.relative(directory, resolved), sha256: sha256(bytes), width: decoded.width, height: decoded.height, ...geometry(metadata, decoded.width, decoded.height), theme: metadata.theme ?? null, gitRevision: metadata.gitRevision ?? null, runtime: metadata.runtime ?? null }
  }
}

async function compare({ reference, actual, approvedReference = false, origin, mode = 'both', metadata = {}, capture, parent } = {}) {
  let directory
  const manifest = {
    schemaVersion: 1, state: 'ERROR', createdAt: new Date().toISOString(),
    mode: 'SIDE_BY_SIDE_AND_OVERLAY',
    gates: { capture: 'NOT_VERIFIED', comparison: 'NOT_READY', visualAcceptance: 'NOT_REVIEWED' },
    referenceApproval: { declared: approvedReference === true, authority: 'CALLER_DECLARATION' },
    origin: capture ? 'HARNESS_FIXTURE_ELECTRON' : origin ?? null,
    alignment: { resize: false, crop: null, overlayReferenceOpacity: .5, background: '#ffffff', colourspace: 'srgb' },
    limitations: ['Preparation for review only; no aesthetic, backend, performance or accessibility acceptance.', 'Illustrative dates, names and values are not literal fidelity requirements.']
  }
  try {
    directory = comparisonDirectory(parent)
    if (mode !== 'both') fail('MODE_UNSUPPORTED', 'The supported comparison mode is both (side-by-side and overlay)')
    if (approvedReference !== true) fail('REFERENCE_NOT_APPROVED', 'Declare the explicitly selected reference approved before comparison')
    if (!capture && origin !== 'USER_RUNTIME_SCREENSHOT') fail('ORIGIN_REQUIRED', 'Declare USER_RUNTIME_SCREENSHOT for an externally supplied application screenshot')
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) fail('METADATA_INVALID', 'Metadata must be an object')
    const sharp = require('sharp')
    const expected = await imageInput(reference, metadata.reference ?? {}, directory, sharp)
    manifest.reference = expected.record
    const actualMetadata = capture ? { viewport: capture.image.viewport, scale: capture.image.dimensions.width / capture.image.viewport.width, theme: capture.image.theme, gitRevision: capture.receipt.source?.head, runtime: capture.receipt.runtime } : metadata.actual ?? {}
    const observed = await imageInput(actual, actualMetadata, directory, sharp)
    manifest.actual = observed.record
    if (capture) {
      if (capture.receipt.status !== 'PASS' || !capture.receipt.captures.includes(capture.image)) fail('CAPTURE_UNVERIFIED', 'Capture must belong to the successful harness run')
      if (observed.record.sha256 !== capture.image.sha256) fail('CAPTURE_UNVERIFIED', 'Capture bytes changed after acquisition')
      manifest.capture = { scenario: capture.receipt.scenario, runId: capture.receipt.runId, name: capture.image.name, capturedAt: capture.image.capturedAt, devicePixelRatio: capture.image.devicePixelRatio, source: capture.receipt.source, receipt: path.relative(directory, path.join(capture.receipt.evidenceDir, 'receipt.json')), runtime: capture.receipt.runtime }
      manifest.gates.capture = 'CAPTURE_OK'
    } else manifest.gates.capture = 'USER_PROVIDED_PNG'
    const a = expected.record, b = observed.record
    if (a.width !== b.width || a.height !== b.height || a.scale !== null && b.scale !== null && Math.abs(a.scale - b.scale) > .001 || a.viewport && b.viewport && (a.viewport.width !== b.viewport.width || a.viewport.height !== b.viewport.height)) fail('GEOMETRY_INCOMPATIBLE', 'Dimensions, known viewport and scale must match; no implicit resize or crop')
    if (a.theme !== null && b.theme !== null && a.theme !== b.theme) fail('THEME_INCOMPATIBLE', 'Known themes must match')
    if (a.scale === null || b.scale === null || !a.viewport || !b.viewport) manifest.limitations.push('Viewport/scale not fully known; equal PNG dimensions alone do not establish equivalent viewport regions.')
    const { width, height } = a
    const overlay = Buffer.alloc(expected.pixels.length)
    for (let index = 0; index < overlay.length; index++) overlay[index] = Math.round((expected.pixels[index] + observed.pixels[index]) / 2)
    const raw = { width, height, channels: 3 }
    const side = await sharp({ create: { width: width * 2, height, channels: 3, background: '#ffffff' }, limitInputPixels: maxPixels * 2 }).composite([
      { input: expected.pixels, raw, left: 0, top: 0 },
      { input: observed.pixels, raw, left: width, top: 0 }
    ]).png().toBuffer()
    const blended = await sharp(overlay, { raw }).png().toBuffer()
    fs.writeFileSync(path.join(directory, 'side-by-side.png'), side, { flag: 'wx', mode: 0o600 })
    fs.writeFileSync(path.join(directory, 'overlay.png'), blended, { flag: 'wx', mode: 0o600 })
    manifest.outputs = { sideBySide: { path: 'side-by-side.png', order: ['reference', 'actual'], sha256: sha256(side) }, overlay: { path: 'overlay.png', sha256: sha256(blended) } }
    manifest.state = 'READY_FOR_REVIEW'
    manifest.gates.comparison = 'COMPARISON_READY'
  } catch (error) { manifest.error = { code: error.code || 'COMPARISON_FAILED', message: error.message } }
  if (directory) {
    try { fs.writeFileSync(path.join(directory, 'comparison.json'), JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 }) }
    catch (error) { manifest.state = 'ERROR'; manifest.gates.comparison = 'NOT_READY'; manifest.error = { code: 'OUTPUT_UNWRITABLE', message: error.message } }
  }
  return { ...manifest, directory }
}

function parseArguments(args, scenario = false) {
  const result = {}, allowed = new Set(['reference', 'actual', 'metadata', 'capture', 'origin', 'mode'])
  for (let index = 0; index < args.length; index++) {
    const key = args[index].replace(/^--/, '')
    if (args[index] === '--reference-approved' && result.approvedReference === undefined) { result.approvedReference = true; continue }
    if (!args[index].startsWith('--') || !allowed.has(key) || key in result || !args[index + 1] || args[index + 1].startsWith('--')) fail('ARGUMENT_INVALID', `Invalid or duplicate argument: ${args[index]}`)
    result[key] = args[++index]
  }
  if (!result.reference || !result.approvedReference || (scenario ? !isStem(result.capture) || result.actual : !result.actual || result.capture)) fail('ARGUMENT_INVALID', 'Use --reference <png> --reference-approved and either --actual <png> or scenario --capture <name>')
  if (scenario ? result.origin !== undefined : result.origin !== 'USER_RUNTIME_SCREENSHOT') fail('ORIGIN_REQUIRED', 'External screenshots require --origin USER_RUNTIME_SCREENSHOT; scenarios establish fixture origin themselves')
  if (result.mode !== undefined && result.mode !== 'both') fail('MODE_UNSUPPORTED', 'The supported comparison mode is both')
  if (result.metadata) {
    const file = localPath(result.metadata)
    if (!fs.statSync(file).isFile() || fs.statSync(file).size > 16384) fail('METADATA_INVALID', 'Metadata must be a JSON file of at most 16 KiB')
    result.metadata = JSON.parse(fs.readFileSync(file, 'utf8'))
  }
  if (result.metadata === undefined) result.metadata = {}
  if (!result.metadata || typeof result.metadata !== 'object' || Array.isArray(result.metadata)) fail('METADATA_INVALID', 'Metadata must be an object')
  if (scenario) {
    const { bytes } = readPng(result.reference)
    geometry(result.metadata.reference ?? {}, bytes.readUInt32BE(16), bytes.readUInt32BE(20))
  }
  return result
}

module.exports = { compare, parseArguments }
if (require.main === module) {
  Promise.resolve().then(() => compare(parseArguments(process.argv.slice(2)))).then(result => {
    console.log(JSON.stringify(result, null, 2)); process.exitCode = result.state === 'READY_FOR_REVIEW' ? 0 : 1
  }).catch(error => { console.error(JSON.stringify({ state: 'ERROR', error: { code: error.code || 'ARGUMENT_INVALID', message: error.message } })); process.exitCode = 1 })
}
