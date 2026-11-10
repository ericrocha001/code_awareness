/*
-T ---
*/

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const {
  EXPECTED_ELECTRON_VERSION,
  REQUIRED_NATIVE_DEPENDENCIES,
  createDesktopEnvironmentIssue,
  formatIssues,
  inspectElectronDesktopEnvironment,
  readNpmLifecyclePolicy,
  readPackageJson,
  validatePackageManifest
} = require('./native-runtime-policy.cjs')

const projectRoot = path.resolve(__dirname, '..')
const probeScript = path.join(__dirname, 'native-runtime-probe.cjs')

function createIssue(property, expected, found, action) {
  return {
    code: 'NATIVE_RUNTIME_INVALID',
    property,
    expected,
    found: found === undefined ? 'absent' : found,
    action
  }
}

function readInstalledPackageVersion(packageName) {
  const packageJsonPath = require.resolve(`${packageName}/package.json`, { paths: [projectRoot] })
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
  return packageJson.version
}

function resolveElectronExecutable() {
  return require('electron')
}

function runElectron(electronPath, args) {
  return spawnSync(electronPath, args, {
    cwd: projectRoot,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1'
    },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000
  })
}

function observeElectronVersions(electronPath) {
  const result = runElectron(electronPath, [
    '-e',
    'console.log(JSON.stringify({ electron: process.versions.electron, node: process.versions.node, modules: process.versions.modules }))'
  ])

  if (result.status !== 0) {
    const issue = createIssue(
      'Electron runtime',
      'executable Electron runtime',
      result.error?.message || result.stderr || result.stdout || `exit ${result.status}`,
      'Run npm ci with the declared npm toolchain, or npm run native:prepare after a deliberate dependency change.'
    )
    if (['EACCES', 'EPERM'].includes(result.error?.code)) issue.code = 'NATIVE_RUNTIME_EXECUTION_BLOCKED'
    throw issue
  }

  return JSON.parse(result.stdout.trim())
}

function runProbe(electronPath, probeName) {
  return runElectron(electronPath, [probeScript, probeName])
}

function printStatus(label, ok) {
  console.log(`${label.padEnd(18)} ${ok ? 'PASS' : 'FAIL'}`)
}

function failWithIssues(issues) {
  for (const issue of issues) {
    printStatus(issue.property, false)
  }
  console.error(formatIssues(issues))
  console.log('Native Runtime    INVALID')
  throw Object.assign(new Error('NATIVE_RUNTIME_INVALID'), { issues })
}

function runChecks() {
  const environmentIssue = createDesktopEnvironmentIssue(process.env)
  if (environmentIssue) {
    printStatus(environmentIssue.property, false)
    console.error(formatIssues([environmentIssue]))
    console.error(inspectElectronDesktopEnvironment(process.env).reason)
    console.log('Native Runtime    INVALID')
    throw Object.assign(new Error(environmentIssue.code), { issues: [environmentIssue] })
  }
  printStatus('Electron Desktop Environment', true)

  const issues = []
  let packageJson

  try {
    packageJson = readPackageJson(projectRoot)
  } catch (error) {
    failWithIssues([
      createIssue('package.json', 'readable manifest', error.message, 'Restore package.json before validating the native runtime.')
    ])
  }

  const policyResult = validatePackageManifest(packageJson)
  if (!policyResult.ok) {
    failWithIssues(policyResult.issues)
  }

  printStatus('Policy', true)

  if (!fs.existsSync(path.join(projectRoot, 'package-lock.json'))) {
    issues.push(createIssue(
      'package-lock.json',
      'present',
      'absent',
      'Run npx -p npm@12.0.2 npm install once to create the lockfile, then use npm ci.'
    ))
  }

  let installedElectronVersion
  try {
    installedElectronVersion = readInstalledPackageVersion('electron')
  } catch (error) {
    issues.push(createIssue(
      'node_modules/electron',
      EXPECTED_ELECTRON_VERSION,
      error.message,
      'Run npm ci with the declared npm toolchain.'
    ))
  }

  if (installedElectronVersion && installedElectronVersion !== EXPECTED_ELECTRON_VERSION) {
    issues.push(createIssue(
      'node_modules/electron.version',
      EXPECTED_ELECTRON_VERSION,
      installedElectronVersion,
      'Run npm ci with the declared npm toolchain so the installed Electron matches package.json.'
    ))
  }

  for (const [dependencyName, expectedVersion] of Object.entries(REQUIRED_NATIVE_DEPENDENCIES)) {
    try {
      const installedVersion = readInstalledPackageVersion(dependencyName)
      if (installedVersion !== expectedVersion) {
        issues.push(createIssue(
          `node_modules/${dependencyName}.version`,
          expectedVersion,
          installedVersion,
          'Run npm ci with the declared npm toolchain so installed native dependencies match package.json.'
        ))
      }
    } catch (error) {
      issues.push(createIssue(
        `node_modules/${dependencyName}`,
        expectedVersion,
        error.message,
        'Run npm ci with the declared npm toolchain.'
      ))
    }
  }

  if (issues.length > 0) {
    failWithIssues(issues)
  }

  printStatus('Electron', true)

  let electronPath
  let versions
  try {
    electronPath = resolveElectronExecutable()
    versions = observeElectronVersions(electronPath)
  } catch (issueOrError) {
    const missingElectron = !fs.existsSync(path.join(projectRoot, 'node_modules/electron/path.txt')) || /Electron failed to install correctly/.test(issueOrError.message)
    failWithIssues([
      issueOrError.code === 'NATIVE_RUNTIME_INVALID'
        ? issueOrError
        : { ...createIssue('Electron runtime', 'observable Electron runtime', issueOrError.message, 'Run npm run bootstrap.'), code: issueOrError.code === 'NATIVE_RUNTIME_EXECUTION_BLOCKED' ? issueOrError.code : missingElectron ? 'ELECTRON_BINARY_MISSING' : 'NATIVE_RUNTIME_INVALID' }
    ])
  }

  if (versions.electron !== EXPECTED_ELECTRON_VERSION) {
    failWithIssues([
      createIssue(
        'process.versions.electron',
        EXPECTED_ELECTRON_VERSION,
        versions.electron,
        'Run npm ci with the declared npm toolchain so the executable Electron matches package.json.'
      )
    ])
  }

  console.log(`Electron ABI       ${versions.modules}`)

  const probeLabels = [
    ['better-sqlite3', 'better-sqlite3'],
    ['tree-sitter', 'tree-sitter'],
    ['tree-sitter-typescript', 'TS grammar'],
    ['tree-sitter-javascript', 'JS grammar']
  ]

  const probeIssues = []
  for (const [probeName, label] of probeLabels) {
    const result = runProbe(electronPath, probeName)
    const ok = result.status === 0
    printStatus(label, ok)
    if (!ok) {
      const issue = createIssue(
        label,
        'functional native module under Electron',
        result.error?.message || result.stderr || result.stdout || `exit ${result.status}`,
        'Run npm run native:prepare. If it still fails, stop and inspect the reported addon.'
      )
      if (['EACCES', 'EPERM'].includes(result.error?.code)) issue.code = 'NATIVE_RUNTIME_EXECUTION_BLOCKED'
      probeIssues.push(issue)
    }
  }

  if (probeIssues.length > 0) {
    failWithIssues(probeIssues)
  }

  console.log('Native Runtime    HEALTHY')
}

function inspectRuntime() {
  try { runChecks(); return { ok: true, checkout: fs.realpathSync(projectRoot), issues: [] } }
  catch (error) {
    const issues = error.issues ?? [createIssue('Native runtime', 'functional runtime', error.message, 'Inspect native:doctor before retrying bootstrap.')]
    const repairable = issues.every(issue => issue.code === 'ELECTRON_BINARY_MISSING' || issue.code === 'NATIVE_RUNTIME_INVALID' && ['Electron runtime', 'better-sqlite3', 'tree-sitter', 'TS grammar', 'JS grammar'].includes(issue.property))
    return { ok: false, issues, repairable }
  }
}

function runCli() {
  const result = inspectRuntime()
  if (!result.ok) {
    try {
      const policy = readNpmLifecyclePolicy({ projectRoot })
      if (policy.ignoreScripts) console.error(`${policy.code}: ignore-scripts=true (${policy.source}); installation hooks may have been skipped. Run npx --yes --package npm@12.0.2 npm run bootstrap for scoped preparation; do not change user/global npm config.`)
    } catch (error) { console.error(error.message) }
    process.exitCode = 1
  }
}

if (require.main === module) {
  runCli()
}

module.exports = { inspectRuntime }
