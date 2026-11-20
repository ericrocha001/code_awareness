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
  async renewRuntime({ port, token, devUpdate }) {
    console.log(`[Dev Supervisor] Executando renovação completa DevUpdate (operação ${devUpdate.operationId})...`)
    const executable = process.platform === 'win32' ? (process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe') : 'npm'
    const predevArgs = process.platform === 'win32'
      ? ['/d', '/s', '/c', 'npm.cmd', 'run', 'predev']
      : ['run', 'predev']
    const predevResult = spawnSync(executable, predevArgs, {
      cwd: projectRoot,
      env: process.env,
      stdio: 'inherit',
      shell: false,
      windowsHide: true
    })
    if (predevResult.error || predevResult.status !== 0) {
      throw new Error(`PREDEV_FAILED: ${predevResult.error?.message ?? predevResult.status}`)
    }
    if (process.platform === 'win32') {
      try {
        delete require.cache[require.resolve('./runtime-preview/build.cjs')]
        nativePreviewBuild = JSON.stringify(require('./runtime-preview/build.cjs').build(false))
      } catch {
        console.warn('[Runtime Preview] PREVIEW_HELPER_UNAVAILABLE')
      }
    }
    const runtimeArgs = process.platform === 'win32'
      ? ['/d', '/s', '/c', 'npm.cmd', 'run', 'dev:runtime']
      : ['run', 'dev:runtime']
    return spawn(executable, runtimeArgs, {
      cwd: projectRoot,
      stdio: 'inherit',
      windowsHide: true,
      shell: false,
      env: {
        ...createDevRuntimeEnvironment(process.env, { port, token }),
        CODE_AWARENESS_DEV_SUPERVISOR_ROOT: projectRoot,
        CODE_AWARENESS_PREVIEW_NATIVE_BUILD: nativePreviewBuild ?? ''
      }
    })
  },
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
      env: {
        ...createDevRuntimeEnvironment(process.env, { port, token }),
        CODE_AWARENESS_DEV_SUPERVISOR_ROOT: projectRoot,
        CODE_AWARENESS_PREVIEW_NATIVE_BUILD: nativePreviewBuild ?? ''
      }
    })
  },
  onFinalExit(code) {
    process.exitCode = code
  }
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => supervisor.stop(signal))
}
