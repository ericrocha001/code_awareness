/*
-T ---
*/

const dns = require('dns')
const fs = require('fs')
const https = require('https')
const net = require('net')
const path = require('path')
const tls = require('tls')
const { spawn } = require('node:child_process')
const {
  detectCurrentNpmVersion,
  formatIssues,
  readPackageJson,
  resolveNpmCli,
  readNpmLifecyclePolicy,
  lifecyclePreparationEnvironment,
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

  const ready = { ok: true, phase: 'install-ready', runtimeChecked: false, npmVersion, registryUrl }
  if (options.checkNetwork === false) return ready
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

  return ready
}

function execute(command, args, options) {
  return new Promise(resolve => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false })
    let stdout = '', stderr = ''
    child.stdout.on('data', bytes => { stdout = (stdout + bytes).slice(-16000) })
    child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-16000) })
    child.once('error', error => resolve({ status: null, error, stdout, stderr }))
    child.once('close', (status, signal) => resolve({ status, signal, stdout, stderr }))
  })
}

function requireSuccess(result, step) {
  if (result.status === 0 && !result.error) return
  throw new Error(`NATIVE_BOOTSTRAP_${step}_FAILED: ${result.error?.message ?? result.signal ?? result.status}\n${(result.stderr || result.stdout || '').slice(-6000)}\nAction: inspect the failure and retry npm run bootstrap only after resolving network, credential or host policy restrictions.`)
}

function reportLifecycle(policy, log) {
  log(`${policy.code}: ignore-scripts=${policy.ignoreScripts} (${policy.source}); ${policy.declarations.map(item => `${item.source}=${item.ignoreScripts}${item.overridden ? ' overridden' : ' effective'}`).join(', ')}`)
  if (policy.ignoreScripts) log('Bootstrap opt-in: ci/recovery use --ignore-scripts=false only in preparation subprocesses. User/global npm configuration is unchanged. If host policy forbids scripts, stop and contact its administrator.')
}

async function runBootstrap(options = {}) {
  const root = fs.realpathSync(options.projectRoot ?? process.cwd())
  const environment = options.environment ?? process.env
  const preflight = options.preflight ?? evaluatePreflight
  const initial = await preflight({ projectRoot: root, checkNetwork: false })
  if (!initial.ok) throw new Error(formatIssues(initial.issues))
  const policy = (options.readLifecycle ?? readNpmLifecyclePolicy)({ projectRoot: root, environment })
  const log = options.log ?? console.log
  reportLifecycle(policy, log)
  const scoped = lifecyclePreparationEnvironment(environment)
  const cli = resolveNpmCli(environment)
  const run = options.execute ?? execute
  const npm = args => run(process.execPath, [cli, ...args], { cwd: root, env: scoped })
  const { ensureDependencyReadiness, inspectInstallation } = require('./dependency-readiness.cjs')
  const doctor = options.doctor ?? require('./native-runtime-doctor.cjs').inspectRuntime
  const ensure = options.ensureReadiness ?? ensureDependencyReadiness
  const result = await ensure({ root, log, install: async (checkout, state) => {
    const installPreflight = await preflight({ projectRoot: checkout })
    if (!installPreflight.ok) throw new Error(formatIssues(installPreflight.issues))
    log('Native Bootstrap  INSTALLING (npm ci --ignore-scripts=false)')
    const installed = await npm(['ci', '--ignore-scripts=false', '--no-audit', '--no-fund', '--include=dev', '--include=optional'])
    const refusal = /EACCES|EPERM|ENOTFOUND|EAI_AGAIN|ECONN|ETIMEDOUT|E401|E403|access.*denied|permission denied|host policy|network unavailable|credential.*denied/i.test(`${installed.stdout ?? ''}\n${installed.stderr ?? ''}`)
    if (installed.status !== 0 && /Native Runtime\s+INVALID/.test(installed.stdout ?? '') && !installed.error && !refusal && inspectInstallation(checkout, state).problems.length === 0) {
      log('NATIVE_BOOTSTRAP_POSTINSTALL_RUNTIME_INVALID: installation is complete; native:doctor must prove recovery.')
    } else requireSuccess(installed, 'INSTALL')
  }, verifyRuntime: async () => {
    let observed = doctor()
    if (observed.ok && observed.checkout !== root) throw new Error('NATIVE_BOOTSTRAP_CHECKOUT_MISMATCH')
    if (observed.ok) return observed
    if (!observed.repairable) throw new Error(`NATIVE_BOOTSTRAP_RUNTIME_BLOCKED\n${formatIssues(observed.issues)}\nAction: resolve the reported policy/environment restriction before npm run bootstrap.`)
    log('Native Bootstrap  RECOVERING (one bounded attempt)')
    if (observed.issues.some(issue => issue.code === 'ELECTRON_BINARY_MISSING' || issue.property === 'Electron runtime')) requireSuccess(await npm(['rebuild', 'electron', '--ignore-scripts=false']), 'ELECTRON_PREPARE')
    const addons = { 'tree-sitter': 'tree-sitter', 'TS grammar': 'tree-sitter-typescript', 'JS grammar': 'tree-sitter-javascript' }
    const rebuild = [...new Set(observed.issues.map(issue => addons[issue.property]).filter(Boolean))]
    if (rebuild.length) requireSuccess(await npm(['rebuild', ...rebuild, '--ignore-scripts=false']), 'ADDON_PREPARE')
    requireSuccess(await npm(['run', 'native:prepare', '--ignore-scripts=false', '--', '--force']), 'NATIVE_PREPARE')
    observed = doctor()
    if (!observed.ok) throw new Error(`NATIVE_BOOTSTRAP_RUNTIME_INVALID_AFTER_REPAIR: ${observed.issues.map(issue => `${issue.code} (${issue.property})`).join('; ')}\nAction: inspect npm run native:doctor; automatic recovery will not repeat within this bootstrap.`)
    if (observed.checkout !== root) throw new Error('NATIVE_BOOTSTRAP_CHECKOUT_MISMATCH')
    return { ...observed, repaired: true }
  } })
  log(`Native Bootstrap  ${result.status} (${root}; Electron/native verified)`)
  return result
}

function printPass(label) {
  console.log(`${label.padEnd(18)} PASS`)
}

async function runCli() {
  if (process.argv.includes('--bootstrap')) {
    if (fs.realpathSync(process.cwd()) !== fs.realpathSync(path.join(__dirname, '..'))) throw new Error('NATIVE_BOOTSTRAP_CHECKOUT_MISMATCH: run bootstrap inside its own Worktree.')
    await runBootstrap()
    return
  }
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
  reportLifecycle(readNpmLifecyclePolicy(), console.log)
  console.log('Native Preflight  INSTALL_READY (runtime not checked; use npm run bootstrap)')
}

if (require.main === module) {
  runCli().catch((error) => {
    console.error('NATIVE_BOOTSTRAP_FAILED')
    console.error(error.message ?? String(error))
    console.log('Native Bootstrap  BLOCKED')
    process.exit(1)
  })
}

module.exports = {
  DEFAULT_REGISTRY_URL,
  checkGithubDns,
  checkGithubHttps,
  checkRegistryAvailability,
  evaluatePreflight,
  runBootstrap,
  validateLockfileCompatibility
}
