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

async function runCli() {
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

  const args = process.argv.slice(2)
  const human = args.includes('--human') || !args.includes('run') || process.env.CODE_AWARENESS_TEST_CAPTURE === '1'
  const parameters = [vitestCli, ...args.filter(arg => arg !== '--human')]
  if (!human) {
    const { run, project } = require('./test-output.cjs')
    const receipt = await run(electronPath, parameters, { cwd: projectRoot, env: { ELECTRON_RUN_AS_NODE: '1' } })
    console.log(project(receipt))
    process.exitCode = receipt.state === 'PASS' ? 0 : receipt.exitCode || 1
    return
  }
  const result = spawnSync(electronPath, parameters, {
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
  runCli().catch(error => { console.error(error.message); process.exitCode = 1 })
}
