const { spawn } = require('node:child_process')
const path = require('node:path')
const { createDevSupervisor, createDevRuntimeEnvironment } = require('./dev-supervisor-core.cjs')

const projectRoot = path.resolve(__dirname, '..')
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
      env: createDevRuntimeEnvironment(process.env, { port, token })
    })
  },
  onFinalExit(code) {
    process.exitCode = code
  }
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => supervisor.stop(signal))
}
