const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const { resolve, join, dirname, relative, basename, isAbsolute } = require('node:path')
const { createHash } = require('node:crypto')

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const digest = file => hash(fs.readFileSync(file))
const options = ['/nologo', '/noconfig', '/nostdlib+', '/platform:x64', '/target:exe', '/debug-', '/optimize+']
const references = ['mscorlib.dll', 'System.dll', 'System.Core.dll', 'System.Web.Extensions.dll']

function verifyExecutable(file) {
  const bytes = fs.readFileSync(file), pe = bytes.length >= 64 ? bytes.readUInt32LE(60) : -1
  if (bytes.toString('ascii', 0, 2) !== 'MZ' || pe < 0 || pe + 26 > bytes.length || bytes.readUInt32LE(pe) !== 0x4550 || bytes.readUInt16LE(pe + 4) !== 0x8664) throw new Error('NATIVE_BUILD_OUTPUT_INVALID')
  return { sha256: hash(bytes), size: bytes.length }
}

function readBuild(directory, inputs, buildId, reused) {
  try {
    if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) throw new Error('BUILD_DIRECTORY_INVALID')
    const receiptFile = join(directory, 'receipt.json')
    if (fs.lstatSync(receiptFile).isSymbolicLink()) throw new Error('BUILD_RECEIPT_LINK')
    const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'))
    if (receipt.version !== 1 || receipt.buildId !== buildId || JSON.stringify(receipt.inputs) !== JSON.stringify(inputs)) throw new Error('BUILD_IDENTITY_MISMATCH')
    const names = inputs.targets.map(t => t.name + '.exe')
    if (JSON.stringify(Object.keys(receipt.outputs).sort()) !== JSON.stringify([...names].sort())) throw new Error('BUILD_OUTPUT_SCOPE_MISMATCH')
    for (const name of names) {
      const file = join(directory, name)
      if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw new Error('BUILD_EXECUTABLE_INVALID')
      if (JSON.stringify(verifyExecutable(file)) !== JSON.stringify(receipt.outputs[name])) throw new Error('BUILD_INTEGRITY_MISMATCH')
    }
    return { owner: join(directory, 'preview-owner.exe'), fixture: inputs.mode === 'test' ? join(directory, 'controlled-helper.exe') : undefined,
      buildId, fingerprint: receipt.outputs['preview-owner.exe'].sha256, receipt: receiptFile, reused }
  } catch (cause) { throw new Error('NATIVE_BUILD_ARTIFACT_INVALID', { cause }) }
}

function build(test = false, { root = resolve(__dirname, '../..') } = {}) {
  if (process.platform !== 'win32') throw new Error('WINDOWS_REQUIRED')
  if (typeof test !== 'boolean') throw new Error('INVALID_BUILD_MODE')
  root = fs.realpathSync(root)
  const compiler = join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe')
  if (!fs.existsSync(compiler)) throw new Error('WINDOWS_FRAMEWORK_COMPILER_REQUIRED')
  const framework = dirname(compiler), mode = test ? 'test' : 'production'
  const native = 'src/main/work-orchestration/runtime-preview/windows/'
  const targets = [{ name: 'preview-owner', files: [native + 'Win32.cs', native + 'PreviewOwner.cs'], defines: test ? ['/define:PREVIEW_TEST'] : [] },
    ...(test ? [{ name: 'controlled-helper', files: [native + 'Win32.cs', 'scripts/runtime-preview/ControlledHelper.cs'], defines: [] }] : [])]
  const files = [...new Set(targets.flatMap(t => t.files))]
  const sources = files.map(file => ({ file, bytes: fs.readFileSync(join(root, file)) }))
  const snapshot = () => ({ version: 1, recipe: digest(__filename), mode, architecture: 'x64', options, targets,
    compiler: { path: fs.realpathSync(compiler), files: ['csc.exe', 'csc.exe.config', 'clr.dll'].map(file => ({ file, sha256: digest(join(framework, file)) })) },
    references: references.map(file => ({ file, sha256: digest(join(framework, file)) })), sources: files.map(file => ({ file, sha256: digest(join(root, file)) })) })
  const inputs = snapshot(), buildId = hash(JSON.stringify(inputs))
  if (sources.some(s => hash(s.bytes) !== inputs.sources.find(input => input.file === s.file).sha256)) throw new Error('NATIVE_BUILD_INPUTS_CHANGED')
  const parent = join(root, 'out/runtime-preview', mode), directory = join(parent, buildId)
  for (let path = parent; path !== root; path = dirname(path)) {
    if (fs.existsSync(path) && fs.lstatSync(path).isSymbolicLink()) throw new Error('NATIVE_BUILD_DIRECTORY_LINK')
  }
  const current = () => { if (hash(JSON.stringify(snapshot())) !== buildId) throw new Error('NATIVE_BUILD_INPUTS_CHANGED') }
  if (fs.existsSync(directory)) { const result = readBuild(directory, inputs, buildId, true); current(); return result }
  fs.mkdirSync(parent, { recursive: true })
  const temporary = fs.mkdtempSync(join(parent, '.build-'))
  let published = false
  try {
    const outputs = {}, copied = new Map(sources.map((source, index) => [source.file, join(temporary, 'input-' + index + '.cs')]))
    for (const source of sources) fs.writeFileSync(copied.get(source.file), source.bytes, { flag: 'wx' })
    for (const target of targets) {
      const file = target.name + '.exe'
      const result = spawnSync(compiler, [...options, ...references.map(ref => '/r:' + join(framework, ref)), ...target.defines,
        '/out:' + join(temporary, file), ...target.files.map(file => copied.get(file))], { cwd: temporary, encoding: 'utf8', windowsHide: true, timeout: 60000 })
      if (result.error || result.status !== 0) throw new Error('NATIVE_BUILD_COMPILE_FAILED: ' + (result.error?.message ?? '') + result.stdout + result.stderr)
      outputs[file] = verifyExecutable(join(temporary, file))
    }
    // Only private, never-published input snapshots are removed; published executables are never replaced.
    for (const file of copied.values()) fs.unlinkSync(file)
    fs.writeFileSync(join(temporary, 'receipt.json'), JSON.stringify({ version: 1, buildId, inputs, outputs }, null, 2) + '\n', { flag: 'wx' })
    readBuild(temporary, inputs, buildId, false); current()
    try { fs.renameSync(temporary, directory); published = true }
    catch (error) { if (!fs.existsSync(directory)) throw error }
    const result = readBuild(directory, inputs, buildId, !published); current()
    return result
  } finally {
    if (!published) {
      const physical = fs.realpathSync(temporary), scope = relative(fs.realpathSync(parent), physical)
      if (physical !== temporary || isAbsolute(scope) || scope.startsWith('..') || !scope || !basename(physical).startsWith('.build-')) throw new Error('NATIVE_BUILD_CLEANUP_PATH_INVALID')
      fs.rmSync(physical, { recursive: true, force: true })
    }
  }
}
module.exports = { build }
if (require.main === module) console.log(JSON.stringify(build(process.argv.includes('--test'))))
