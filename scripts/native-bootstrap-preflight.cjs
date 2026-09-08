/*
-T ---
*/

const dns = require('dns')
const fs = require('fs')
const https = require('https')
const net = require('net')
const path = require('path')
const tls = require('tls')
const {
  detectCurrentNpmVersion,
  formatIssues,
  readPackageJson,
  validateNpmVersion,
  validatePackageManifest
} = require('./native-runtime-policy.cjs')

const DEFAULT_REGISTRY_URL = 'https://registry.npmjs.org/'
const GITHUB_HOST = 'github.com'
const HTTPS_PORT = 443
const TIMEOUT_MS = 5000

function createIssue(code, property, expected, found, action) {
  return {
    code,
    property,
    expected,
    found: found === undefined ? 'absent' : found,
    action
  }
}

function readLockfile(projectRoot = process.cwd()) {
  const lockfilePath = path.join(projectRoot, 'package-lock.json')
  return JSON.parse(fs.readFileSync(lockfilePath, 'utf8'))
}

function validateLockfileCompatibility(packageJson, lockfile) {
  const rootPackage = lockfile && lockfile.packages && lockfile.packages['']
  if (!rootPackage) {
    return {
      ok: false,
      issues: [
        createIssue(
          'NATIVE_BOOTSTRAP_LOCKFILE_INVALID',
          'package-lock.json root package',
          'present',
          'absent',
          'Regenerate package-lock.json with npm 10 after deliberate dependency changes.'
        )
      ]
    }
  }

  const issues = []
  for (const field of ['dependencies', 'devDependencies']) {
    const manifestDependencies = packageJson[field] || {}
    const lockDependencies = rootPackage[field] || {}

    for (const [dependencyName, expectedVersion] of Object.entries(manifestDependencies)) {
      const foundVersion = lockDependencies[dependencyName]
      if (foundVersion !== expectedVersion) {
        issues.push(createIssue(
          'NATIVE_BOOTSTRAP_LOCKFILE_MISMATCH',
          `package-lock.json root ${field}.${dependencyName}`,
          expectedVersion,
          foundVersion,
          'Regenerate package-lock.json with npm 10 after deliberate dependency changes.'
        ))
      }
    }
  }

  return {
    ok: issues.length === 0,
    issues
  }
}

function requestHead(url, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve) => {
    const request = https.request(url, { method: 'HEAD', timeout: timeoutMs }, (response) => {
      response.resume()
      resolve({
        ok: response.statusCode >= 200 && response.statusCode < 400,
        statusCode: response.statusCode
      })
    })

    request.on('timeout', () => {
      request.destroy(new Error('timeout'))
    })

    request.on('error', (error) => {
      resolve({
        ok: false,
        error
      })
    })

    request.end()
  })
}

function connectTls(host, port = HTTPS_PORT, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = tls.connect({
      host,
      port,
      servername: host,
      timeout: timeoutMs
    })

    socket.once('secureConnect', () => {
      socket.end()
      resolve({ ok: true })
    })

    socket.once('timeout', () => {
      socket.destroy(new Error('timeout'))
    })

    socket.once('error', (error) => {
      resolve({ ok: false, error })
    })
  })
}

async function checkRegistryAvailability(registryUrl, adapters = {}) {
  const request = adapters.requestHead || requestHead
  const result = await request(registryUrl)

  if (result.ok) return { ok: true }

  return {
    ok: false,
    issues: [
      createIssue(
        'NATIVE_BOOTSTRAP_REGISTRY_UNAVAILABLE',
        'npm registry reachable',
        registryUrl,
        result.error ? result.error.message : `HTTP ${result.statusCode}`,
        'Restore registry connectivity or npm proxy configuration before running npm ci.'
      )
    ]
  }
}

async function checkGithubDns(host = GITHUB_HOST, adapters = {}) {
  const lookup = adapters.dnsLookup || dns.promises.lookup

  try {
    await lookup(host)
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      issues: [
        createIssue(
          'NATIVE_BOOTSTRAP_GITHUB_DNS_FAILED',
          'github.com DNS resolution',
          'resolves',
          error.message,
          'Restore DNS/proxy connectivity to github.com before running npm ci.'
        )
      ]
    }
  }
}

async function checkGithubHttps(host = GITHUB_HOST, adapters = {}) {
  const connect = adapters.connectTls || connectTls
  const result = await connect(host, HTTPS_PORT)

  if (result.ok) return { ok: true }

  return {
    ok: false,
    issues: [
      createIssue(
        'NATIVE_BOOTSTRAP_GITHUB_HTTPS_FAILED',
        'github.com:443 reachable',
        'TLS connection succeeds',
        result.error ? result.error.message : 'connection failed',
        'Restore HTTPS connectivity to github.com before running npm ci.'
      )
    ]
  }
}

async function evaluatePreflight(options = {}) {
  const projectRoot = options.projectRoot || process.cwd()
  const packageJson = options.packageJson || readPackageJson(projectRoot)
  const npmVersion = options.npmVersion || detectCurrentNpmVersion()
  const registryUrl = options.registryUrl || process.env.npm_config_registry || DEFAULT_REGISTRY_URL
  const adapters = options.adapters || {}

  const npmResult = validateNpmVersion(npmVersion)
  if (!npmResult.ok) {
    return {
      ok: false,
      phase: 'npm',
      issues: npmResult.issues.map((issue) => ({
        ...issue,
        code: 'NATIVE_BOOTSTRAP_INVALID_NPM'
      }))
    }
  }

  const policyResult = validatePackageManifest(packageJson)
  if (!policyResult.ok) {
    return {
      ok: false,
      phase: 'policy',
      issues: policyResult.issues
    }
  }

  let lockfile
  try {
    lockfile = options.lockfile || readLockfile(projectRoot)
  } catch (error) {
    return {
      ok: false,
      phase: 'lockfile',
      issues: [
        createIssue(
          'NATIVE_BOOTSTRAP_LOCKFILE_MISSING',
          'package-lock.json',
          'present',
          error.message,
          'Create package-lock.json with npm 10 before running bootstrap.'
        )
      ]
    }
  }

  const lockfileResult = validateLockfileCompatibility(packageJson, lockfile)
  if (!lockfileResult.ok) {
    return {
      ok: false,
      phase: 'lockfile',
      issues: lockfileResult.issues
    }
  }

  const registryResult = await checkRegistryAvailability(registryUrl, adapters)
  if (!registryResult.ok) {
    return {
      ok: false,
      phase: 'registry',
      issues: registryResult.issues
    }
  }

  const githubDnsResult = await checkGithubDns(GITHUB_HOST, adapters)
  if (!githubDnsResult.ok) {
    return {
      ok: false,
      phase: 'github-dns',
      issues: githubDnsResult.issues
    }
  }

  const githubHttpsResult = await checkGithubHttps(GITHUB_HOST, adapters)
  if (!githubHttpsResult.ok) {
    return {
      ok: false,
      phase: 'github-https',
      issues: githubHttpsResult.issues
    }
  }

  return {
    ok: true,
    phase: 'ready',
    npmVersion,
    registryUrl
  }
}

function printPass(label) {
  console.log(`${label.padEnd(18)} PASS`)
}

async function runCli() {
  const result = await evaluatePreflight()

  if (!result.ok) {
    console.error(formatIssues(result.issues))
    console.log('Native Bootstrap  BLOCKED')
    process.exit(1)
  }

  printPass('npm')
  printPass('Policy')
  printPass('Lockfile')
  printPass('npm registry')
  printPass('GitHub DNS')
  printPass('GitHub HTTPS')
  console.log('Native Bootstrap  READY')
}

if (require.main === module) {
  runCli().catch((error) => {
    console.error('NATIVE_BOOTSTRAP_FAILED')
    console.error(error && error.stack ? error.stack : error)
    process.exit(1)
  })
}

module.exports = {
  DEFAULT_REGISTRY_URL,
  checkGithubDns,
  checkGithubHttps,
  checkRegistryAvailability,
  evaluatePreflight,
  validateLockfileCompatibility
}
