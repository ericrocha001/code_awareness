/*
-T ---
*/

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const projectRoot = path.resolve(__dirname, '..')

function resolveElectronExecutable() {
  return require('electron')
}

function resolveVitestCli() {
  const candidates = []

  try {
    candidates.push(require.resolve('vitest/vitest.mjs', { paths: [projectRoot] }))
  } catch (_) {}

  candidates.push(path.join(projectRoot, 'node_modules', 'vitest', 'vitest.mjs'))
  candidates.push(path.join(projectRoot, 'node_modules', 'vitest', 'dist', 'cli.js'))

  const cliPath = candidates.find((candidate) => candidate && fs.existsSync(candidate))
  if (!cliPath) {
    throw new Error('Vitest CLI was not found in node_modules. Run npm ci with npm 10.')
  }

  return cliPath
}

function runCli() {
  let electronPath
  let vitestCli

  try {
    electronPath = resolveElectronExecutable()
    vitestCli = resolveVitestCli()
  } catch (error) {
    console.error('VITEST_ELECTRON_LAUNCHER_INVALID')
    console.error(error.message)
    process.exit(1)
  }

  const result = spawnSync(electronPath, [vitestCli, ...process.argv.slice(2)], {
    cwd: projectRoot,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1'
    },
    stdio: 'inherit'
  })

  if (result.error) {
    console.error('VITEST_ELECTRON_LAUNCHER_INVALID')
    console.error(result.error.message)
    process.exit(1)
  }

  process.exit(result.status === null ? 1 : result.status)
}

if (require.main === module) {
  runCli()
}
