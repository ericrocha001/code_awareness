/*
-T ---
*/

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const EXPECTED_ELECTRON_VERSION = '45.2.3'
const EXPECTED_VITEST_VERSION = '5.1.0'
const EXPECTED_PACKAGE_MANAGER_PATTERN = /^npm@(11|12)\.\d+\.\d+$/
const SUPPORTED_NPM_MAJORS = [11, 12]
const SUPPORTED_NPM_MAJOR = 12
const ELECTRON_RUN_AS_NODE_ENV = 'ELECTRON_RUN_AS_NODE'
const ELECTRON_DESKTOP_ENVIRONMENT_CODE = 'ELECTRON_RUN_AS_NODE_LEAKED'

const REQUIRED_NATIVE_DEPENDENCIES = Object.freeze({
  'better-sqlite3': '13.0.3',
  'tree-sitter': '0.21.1',
  'tree-sitter-typescript': '0.23.2',
  'tree-sitter-javascript': '0.23.1'
})

function createIssue(property, expected, found, action) {
  return {
    code: 'NATIVE_RUNTIME_INVALID',
    property,
    expected,
    found: found === undefined ? 'absent' : found,
    action
  }
}

function normalizeDesktopEnvironmentValue(rawValue) {
  if (rawValue === undefined || rawValue === null) return null
  if (typeof rawValue !== 'string') return String(rawValue)
  const trimmed = rawValue.trim()
  return trimmed === '' ? null : trimmed
}

function inspectElectronDesktopEnvironment(environment = process.env) {
  const value = normalizeDesktopEnvironmentValue(environment ? environment[ELECTRON_RUN_AS_NODE_ENV] : undefined)
  if (value === null || value === '0') {
    return { healthy: true, code: null, reason: null }
  }
  return {
    healthy: false,
    code: ELECTRON_DESKTOP_ENVIRONMENT_CODE,
    reason: `${ELECTRON_RUN_AS_NODE_ENV}=${value} is incompatible with the Electron desktop runtime.`
  }
}

function createDesktopEnvironmentIssue(environment = process.env) {
  const inspection = inspectElectronDesktopEnvironment(environment)
  if (inspection.healthy) return null
  const found = normalizeDesktopEnvironmentValue(environment[ELECTRON_RUN_AS_NODE_ENV])
  return {
    code: inspection.code,
    property: 'Electron Desktop Environment',
    expected: `${ELECTRON_RUN_AS_NODE_ENV} absent`,
    found: `${ELECTRON_RUN_AS_NODE_ENV}=${found}`,
    action: 'Remove-Item Env:\\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue'
  }
}

function isExactVersion(version) {
  return typeof version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)
}

function readPackageJson(projectRoot = process.cwd()) {
  const packageJsonPath = path.join(projectRoot, 'package.json')
  return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
}

function validatePackageManifest(packageJson) {
  const issues = []
  const dependencies = packageJson.dependencies || {}
  const devDependencies = packageJson.devDependencies || {}

  const electronVersion = devDependencies.electron || dependencies.electron
  if (electronVersion !== EXPECTED_ELECTRON_VERSION || !isExactVersion(electronVersion)) {
    issues.push(createIssue(
      'devDependencies.electron',
      EXPECTED_ELECTRON_VERSION,
      electronVersion,
      `Declare electron exactly as ${EXPECTED_ELECTRON_VERSION}.`
    ))
  }

  for (const [dependencyName, expectedVersion] of Object.entries(REQUIRED_NATIVE_DEPENDENCIES)) {
    const declaredVersion = dependencies[dependencyName]
    if (declaredVersion !== expectedVersion || !isExactVersion(declaredVersion)) {
      issues.push(createIssue(
        `dependencies.${dependencyName}`,
        expectedVersion,
        declaredVersion,
        `Declare ${dependencyName} as a direct dependency with version ${expectedVersion}.`
      ))
    }
  }

  const vitestVersion = devDependencies.vitest
  if (vitestVersion !== EXPECTED_VITEST_VERSION || !isExactVersion(vitestVersion)) {
    issues.push(createIssue(
      'devDependencies.vitest',
      EXPECTED_VITEST_VERSION,
      vitestVersion,
      `Use Vitest ${EXPECTED_VITEST_VERSION} compatible with the active Vite toolchain.`
    ))
  }

  const packageManager = packageJson.packageManager
  if (typeof packageManager !== 'string' || !EXPECTED_PACKAGE_MANAGER_PATTERN.test(packageManager)) {
    issues.push(createIssue(
      'packageManager',
      'npm@11.x or npm@12.x',
      packageManager,
      'Declare an exact npm 11 or npm 12 version in packageManager.'
    ))
  }

  return {
    ok: issues.length === 0,
    issues
  }
}

function parseNpmMajorFromUserAgent(userAgent) {
  if (typeof userAgent !== 'string') return null
  const match = userAgent.match(/(?:^|\s)npm\/(\d+)\./)
  return match ? Number(match[1]) : null
}

function parseNpmMajorFromVersion(version) {
  if (typeof version !== 'string') return null
  const match = version.trim().match(/^(\d+)\./)
  return match ? Number(match[1]) : null
}

function validateNpmUserAgent(userAgent) {
  const major = parseNpmMajorFromUserAgent(userAgent)
  return validateNpmMajor(major)
}

function validateNpmVersion(version) {
  const major = parseNpmMajorFromVersion(version)
  return validateNpmMajor(major)
}

function validateNpmMajor(major) {
  if (SUPPORTED_NPM_MAJORS.includes(major)) {
    return { ok: true, major }
  }

  return {
    ok: false,
    major,
    issues: [
      createIssue(
        'npm major',
        SUPPORTED_NPM_MAJORS.join(' or '),
        major === null ? 'unknown' : String(major),
        'Run the canonical bootstrap with npm 11 or npm 12, for example: npx -p npm@12.0.2 npm run bootstrap.'
      )
    ]
  }
}

function detectCurrentNpmVersion() {
  const npmExecPath = process.env.npm_execpath
  if (npmExecPath) {
    const result = spawnSync(process.execPath, [npmExecPath, '--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    if (result.status === 0 && result.stdout.trim()) {
      return result.stdout.trim()
    }
  }

  const result = spawnSync('npm', ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32'
  })

  if (result.status === 0 && result.stdout.trim()) {
    return result.stdout.trim()
  }

  return null
}

function resolveNpmCli(environment = process.env) {
  const candidates = [environment.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')]
  const cli = candidates.find(file => file && path.isAbsolute(file) && fs.existsSync(file))
  if (!cli) throw new Error('NPM_LIFECYCLE_POLICY_UNKNOWN: npm CLI unavailable; use npx --yes --package npm@12.0.2 npm run bootstrap.')
  return cli
}

function readNpmLifecyclePolicy({ projectRoot = process.cwd(), environment = process.env, run = spawnSync } = {}) {
  const result = run(process.execPath, [resolveNpmCli(environment), 'config', 'list', '--long'], { cwd: projectRoot, env: environment, encoding: 'utf8', windowsHide: true, shell: false, timeout: 15000 })
  if (result.error || result.status !== 0) throw new Error('NPM_LIFECYCLE_POLICY_UNKNOWN: cannot read effective npm configuration; inspect npm config get ignore-scripts before bootstrap.')
  let source = 'unknown', effective
  const declarations = []
  for (const line of result.stdout.split(/\r?\n/)) {
    const section = /^; "([^"]+)" config from /.exec(line)
    if (section) source = section[1]
    const setting = /^(;\s*)?ignore-scripts\s*=\s*(true|false)(?:\s*;.*)?$/.exec(line)
    if (!setting) continue
    const declaration = { source, ignoreScripts: setting[2] === 'true', overridden: Boolean(setting[1]) }
    declarations.push(declaration)
    if (!declaration.overridden) {
      if (effective) throw new Error('NPM_LIFECYCLE_POLICY_UNKNOWN: ambiguous ignore-scripts configuration.')
      effective = declaration
    }
  }
  if (!effective) throw new Error('NPM_LIFECYCLE_POLICY_UNKNOWN: npm did not report effective ignore-scripts.')
  return { ...effective, declarations, code: effective.ignoreScripts ? 'NPM_LIFECYCLE_SCRIPTS_DISABLED' : 'NPM_LIFECYCLE_SCRIPTS_ENABLED' }
}

function lifecyclePreparationEnvironment(environment = process.env) {
  return { ...Object.fromEntries(Object.entries(environment).filter(([key]) => key.toLowerCase() !== 'npm_config_ignore_scripts')), npm_config_ignore_scripts: 'false' }
}

function formatIssues(issues) {
  return issues.map((issue) => [
    issue.code,
    `${issue.property}`,
    `expected: ${issue.expected}`,
    `found: ${issue.found}`,
    `action: ${issue.action}`
  ].join('\n')).join('\n\n')
}

function runCli() {
  if (process.argv.includes('--check-npm')) {
    const detectedVersion = detectCurrentNpmVersion()
    const result = detectedVersion
      ? validateNpmVersion(detectedVersion)
      : validateNpmUserAgent(process.env.npm_config_user_agent)
    if (!result.ok) {
      console.error(formatIssues(result.issues))
      process.exit(1)
    }
    console.log(`Native Runtime Policy npm PASS (${detectedVersion || SUPPORTED_NPM_MAJOR})`)
    return
  }

  const result = validatePackageManifest(readPackageJson())
  if (!result.ok) {
    console.error(formatIssues(result.issues))
    process.exit(1)
  }

  console.log('Native Runtime Policy PASS')
}

if (require.main === module) {
  runCli()
}

module.exports = {
  EXPECTED_ELECTRON_VERSION,
  EXPECTED_PACKAGE_MANAGER_PATTERN,
  EXPECTED_VITEST_VERSION,
  REQUIRED_NATIVE_DEPENDENCIES,
  SUPPORTED_NPM_MAJOR,
  SUPPORTED_NPM_MAJORS,
  ELECTRON_RUN_AS_NODE_ENV,
  ELECTRON_DESKTOP_ENVIRONMENT_CODE,
  formatIssues,
  createDesktopEnvironmentIssue,
  detectCurrentNpmVersion,
  inspectElectronDesktopEnvironment,
  parseNpmMajorFromVersion,
  parseNpmMajorFromUserAgent,
  readPackageJson,
  resolveNpmCli,
  readNpmLifecyclePolicy,
  lifecyclePreparationEnvironment,
  validateNpmVersion,
  validateNpmUserAgent,
  validatePackageManifest
}
