const fs = require('node:fs')
const { join, resolve, dirname } = require('node:path')
const { createHash } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
function build(test = false, root = resolve(__dirname, '../..')) {
  if (process.platform !== 'win32') throw new Error('WINDOWS_REQUIRED')
  const compiler = join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe')
  const sources = ['src/main/work-orchestration/runtime-preview/windows/Win32.cs', 'src/main/cli-execution/windows/CliJobOwner.cs']
  const refs = ['mscorlib.dll', 'System.dll', 'System.Core.dll', 'System.Web.Extensions.dll']
  const inputs = { version: 1, test, recipe: hash(fs.readFileSync(__filename)), compiler: hash(fs.readFileSync(compiler)),
    references: refs.map(name => ({ name, sha256: hash(fs.readFileSync(join(dirname(compiler), name))) })),
    sources: sources.map(name => ({ name, sha256: hash(fs.readFileSync(join(root, name))) })) }
  const directory = join(root, 'out/cli-execution', test ? 'test' : 'production')
  fs.mkdirSync(directory, { recursive: true })
  const executable = join(directory, 'cli-job-owner.exe'), receipt = join(directory, 'receipt.json')
  const result = spawnSync(compiler, ['/nologo', '/noconfig', '/nostdlib+', '/platform:x64', '/target:exe', '/optimize+', '/debug-',
    ...refs.map(name => '/r:' + join(dirname(compiler), name)), ...(test ? ['/define:CLI_TEST'] : []), '/out:' + executable, ...sources.map(name => join(root, name))],
    { windowsHide: true, encoding: 'utf8', timeout: 60000 })
  if (result.error || result.status !== 0) throw new Error('CLI_NATIVE_BUILD_FAILED: ' + result.stdout + result.stderr)
  const output = { sha256: hash(fs.readFileSync(executable)), size: fs.statSync(executable).size }
  fs.writeFileSync(receipt, JSON.stringify({ version: 1, inputs, output }, null, 2) + '\n')
  return { executable, receipt, ...output }
}
module.exports = { build }
if (require.main === module) console.log(JSON.stringify(build(process.argv.includes('--test'))))
