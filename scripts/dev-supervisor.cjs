const { spawn, spawnSync } = require('node:child_process')
const path = require('node:path')
const { createDevSupervisor, createDevRuntimeEnvironment } = require('./dev-supervisor-core.cjs')

const projectRoot = path.resolve(__dirname, '..')
if (process.env.npm_lifecycle_event !== 'dev' || process.env.npm_config_ignore_scripts === 'true') {
  for (const script of ['dependency-readiness.cjs', 'native-runtime-doctor.cjs']) {
    const result = spawnSync(process.execPath, [path.join(__dirname, script)], { cwd: projectRoot, env: process.env, stdio: 'inherit', shell: false, windowsHide: true })
    if (result.error || result.status !== 0) {
      console.error(`[Dev Supervisor] ${script}: ${result.error?.message ?? result.signal ?? result.status}; runtime não iniciado.`)
      process.exit(result.status || 1)
    }
  }
}
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
