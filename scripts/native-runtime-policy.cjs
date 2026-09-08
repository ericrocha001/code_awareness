/*
-T ---
*/

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const EXPECTED_ELECTRON_VERSION = '32.0.0'
const EXPECTED_VITEST_VERSION = '3.2.7'
const EXPECTED_PACKAGE_MANAGER_PREFIX = 'npm@10.'
const SUPPORTED_NPM_MAJOR = 10

const REQUIRED_NATIVE_DEPENDENCIES = Object.freeze({
  'better-sqlite3': '12.11.1',
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
      'Declare electron exactly as 32.0.0.'
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
      'Use Vitest 3.2.7 while the project remains on Vite 5.'
    ))
  }

  const packageManager = packageJson.packageManager
  if (typeof packageManager !== 'string' || !packageManager.startsWith(EXPECTED_PACKAGE_MANAGER_PREFIX)) {
    issues.push(createIssue(
      'packageManager',
      `${EXPECTED_PACKAGE_MANAGER_PREFIX}x`,
      packageManager,
      'Declare npm 10 as the supported installation toolchain.'
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
  if (major === SUPPORTED_NPM_MAJOR) {
    return { ok: true, major }
  }

  return {
    ok: false,
    major,
    issues: [
      createIssue(
        'npm major',
        String(SUPPORTED_NPM_MAJOR),
        major === null ? 'unknown' : String(major),
        'Run the canonical bootstrap with npm 10, for example: npx -p npm@10.9.4 npm run bootstrap.'
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
  EXPECTED_PACKAGE_MANAGER_PREFIX,
  EXPECTED_VITEST_VERSION,
  REQUIRED_NATIVE_DEPENDENCIES,
  SUPPORTED_NPM_MAJOR,
  formatIssues,
  detectCurrentNpmVersion,
  parseNpmMajorFromVersion,
  parseNpmMajorFromUserAgent,
  readPackageJson,
  validateNpmVersion,
  validateNpmUserAgent,
  validatePackageManifest
}
