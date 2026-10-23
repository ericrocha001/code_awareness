const { spawn } = require('node:child_process')
const path = require('node:path')
const { createDevSupervisor, createDevRuntimeEnvironment } = require('./dev-supervisor-core.cjs')

const projectRoot = path.resolve(__dirname, '..')
let nativePreviewBuild
if (process.platform === 'win32') {
  try { nativePreviewBuild = JSON.stringify(require('./runtime-preview/build.cjs').build(false)) }
  catch { console.warn('[Runtime Preview] PREVIEW_HELPER_UNAVAILABLE') }
}
const supervisor = createDevSupervisor({
  spawnRuntime({ port, token }) {
    const executable = process.platform === 'win32' ? (process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe') : 'npm'
    const args = process.platform === 'win32'
      ? ['/d', '/s', '/c', 'npm.cmd', 'run', 'dev:runtime']
      : ['run', 'dev:runtime']
    return spawn(executable, args, {
      cwd: projectRoot,
      stdio: 'inherit',
      windowsHide: true,
      shell: false,
      env: { ...createDevRuntimeEnvironment(process.env, { port, token }), CODE_AWARENESS_PREVIEW_NATIVE_BUILD: nativePreviewBuild ?? '' }
    })
  },
  onFinalExit(code) {
    process.exitCode = code
  }
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => supervisor.stop(signal))
}
