const fs = require('node:fs')
const { join, resolve, dirname } = require('node:path')
const { createHash } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { isDeepStrictEqual } = require('node:util')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
function buildContext(test, root) {
  if (process.platform !== 'win32') throw new Error('WINDOWS_REQUIRED')
  const compiler = join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe')
  const sources = ['src/main/work-orchestration/runtime-preview/windows/Win32.cs', 'src/main/cli-execution/windows/CliJobOwner.cs']
  const refs = ['mscorlib.dll', 'System.dll', 'System.Core.dll', 'System.Web.Extensions.dll']
  const inputs = { version: 1, test, recipe: hash(fs.readFileSync(__filename)), compiler: hash(fs.readFileSync(compiler)),
    references: refs.map(name => ({ name, sha256: hash(fs.readFileSync(join(dirname(compiler), name))) })),
    sources: sources.map(name => ({ name, sha256: hash(fs.readFileSync(join(root, name))) })) }
  const directory = join(root, 'out/cli-execution', test ? 'test' : 'production')
  const executable = join(directory, 'cli-job-owner.exe'), receipt = join(directory, 'receipt.json')
  return { compiler, sources, refs, inputs, directory, executable, receipt }
}
function build(test = false, root = resolve(__dirname, '../..')) {
  const { compiler, sources, refs, inputs, directory, executable, receipt } = buildContext(test, root)
  fs.mkdirSync(directory, { recursive: true })
  const result = spawnSync(compiler, ['/nologo', '/noconfig', '/nostdlib+', '/platform:x64', '/target:exe', '/optimize+', '/debug-',
    ...refs.map(name => '/r:' + join(dirname(compiler), name)), ...(test ? ['/define:CLI_TEST'] : []), '/out:' + executable, ...sources.map(name => join(root, name))],
    { windowsHide: true, encoding: 'utf8', timeout: 60000 })
  if (result.error || result.status !== 0) throw new Error('CLI_NATIVE_BUILD_FAILED: ' + (result.error?.message ?? '') + result.stdout + result.stderr)
  const output = { sha256: hash(fs.readFileSync(executable)), size: fs.statSync(executable).size }
  fs.writeFileSync(receipt, JSON.stringify({ version: 1, inputs, output }, null, 2) + '\n')
  return { executable, receipt, ...output }
}
function validArtifact({ executable, receipt, inputs }) {
  try {
    const recorded = JSON.parse(fs.readFileSync(receipt, 'utf8'))
    const bytes = fs.readFileSync(executable)
    return recorded.version === 1 && isDeepStrictEqual(recorded.inputs, inputs) &&
      recorded.output.size === bytes.length && recorded.output.sha256 === hash(bytes)
  } catch { return false }
}
function ensureProduction(root = resolve(__dirname, '../..')) {
  try {
    let context = buildContext(false, root)
    const rebuilt = !validArtifact(context)
    if (rebuilt) {
      build(false, root)
      context = buildContext(false, root)
      if (!validArtifact(context)) throw new Error('CLI_NATIVE_INTEGRITY_FAILED')
    }
    return { executable: context.executable, receipt: context.receipt, rebuilt }
  } catch (cause) {
    throw new Error(`CLI_TEST_ENVIRONMENT_UNAVAILABLE: Windows production supervisor preflight failed in ${root}: ${cause.message}`, { cause })
  }
}
module.exports = { build, ensureProduction }
if (require.main === module) console.log(JSON.stringify(build(process.argv.includes('--test'))))
