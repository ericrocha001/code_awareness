const { spawnSync } = require('node:child_process')
const { mkdirSync, existsSync } = require('node:fs')
const { resolve, join } = require('node:path')

function build(test = false) {
  if (process.platform !== 'win32') throw new Error('WINDOWS_REQUIRED')
  const compiler = join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe')
  if (!existsSync(compiler)) throw new Error('WINDOWS_FRAMEWORK_COMPILER_REQUIRED')
  const directory = resolve('out/runtime-preview', test ? 'test' : 'production')
  mkdirSync(directory, { recursive: true })
  const source = resolve('src/main/work-orchestration/runtime-preview/windows')
  const compile = (name, files, defines = []) => {
    const output = join(directory, name + '.exe')
    const result = spawnSync(compiler, ['/nologo', '/platform:x64', '/target:exe', '/r:System.Web.Extensions.dll', ...defines, '/out:' + output, ...files], { encoding: 'utf8', windowsHide: true })
    if (result.status !== 0) throw new Error(result.stdout + result.stderr)
    return output
  }
  const owner = compile('preview-owner', [join(source, 'Win32.cs'), join(source, 'PreviewOwner.cs')], test ? ['/define:PREVIEW_TEST'] : [])
  const fixture = test ? compile('controlled-helper', [join(source, 'Win32.cs'), resolve('scripts/runtime-preview/ControlledHelper.cs')]) : undefined
  return { owner, fixture }
}
module.exports = { build }
if (require.main === module) console.log(JSON.stringify(build(process.argv.includes('--test'))))
