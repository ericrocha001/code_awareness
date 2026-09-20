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
    encoding: 'utf8'
  })
}

function observeElectronVersions(electronPath) {
  const result = runElectron(electronPath, [
    '-e',
    'console.log(JSON.stringify({ electron: process.versions.electron, node: process.versions.node, modules: process.versions.modules }))'
  ])

  if (result.status !== 0) {
    throw createIssue(
      'Electron runtime',
      'executable Electron runtime',
      result.stderr || result.stdout || `exit ${result.status}`,
      'Run npm ci with npm 10, or npm run native:prepare after a deliberate dependency change.'
    )
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
  process.exit(1)
}

function runCli() {
  const environmentIssue = createDesktopEnvironmentIssue(process.env)
  if (environmentIssue) {
    printStatus(environmentIssue.property, false)
    console.error(formatIssues([environmentIssue]))
    console.error(inspectElectronDesktopEnvironment(process.env).reason)
    console.log('Native Runtime    INVALID')
    process.exit(1)
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
      'Run npx -p npm@10.9.4 npm install once to create the lockfile, then use npm ci.'
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
      'Run npm ci with npm 10.'
    ))
  }

  if (installedElectronVersion && installedElectronVersion !== EXPECTED_ELECTRON_VERSION) {
    issues.push(createIssue(
      'node_modules/electron.version',
      EXPECTED_ELECTRON_VERSION,
      installedElectronVersion,
      'Run npm ci with npm 10 so the installed Electron matches package.json.'
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
          'Run npm ci with npm 10 so installed native dependencies match package.json.'
        ))
      }
    } catch (error) {
      issues.push(createIssue(
        `node_modules/${dependencyName}`,
        expectedVersion,
        error.message,
        'Run npm ci with npm 10.'
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
    failWithIssues([
      issueOrError.code === 'NATIVE_RUNTIME_INVALID'
        ? issueOrError
        : createIssue('Electron runtime', 'observable Electron runtime', issueOrError.message, 'Run npm ci with npm 10.')
    ])
  }

  if (versions.electron !== EXPECTED_ELECTRON_VERSION) {
    failWithIssues([
      createIssue(
        'process.versions.electron',
        EXPECTED_ELECTRON_VERSION,
        versions.electron,
        'Run npm ci with npm 10 so the executable Electron matches package.json.'
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
      probeIssues.push(createIssue(
        label,
        'functional native module under Electron',
        result.stderr || result.stdout || `exit ${result.status}`,
        'Run npm run native:prepare. If it still fails, stop and inspect the reported addon.'
      ))
    }
  }

  if (probeIssues.length > 0) {
    failWithIssues(probeIssues)
  }

  console.log('Native Runtime    HEALTHY')
}

if (require.main === module) {
  runCli()
}
