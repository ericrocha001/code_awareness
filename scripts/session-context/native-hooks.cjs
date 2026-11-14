const { execFileSync } = require('node:child_process')
const { resolve, isAbsolute, basename, sep } = require('node:path')
const { existsSync, readFileSync, lstatSync, realpathSync } = require('node:fs')
const { createHash } = require('node:crypto')
const { isQualifiedCodexHookVersion } = require('../../src/shared/native-hook-preflight.cjs')
const { buildSync } = require('esbuild')
const root = process.cwd()
const action = process.argv[2]
if (!['install', 'disable', 'status', 'acknowledge-gap'].includes(action)) throw new Error('Use install|disable|status|acknowledge-gap; writes require --authorized')
const authorized = process.argv.includes('--authorized')
if (action !== 'status' && !authorized) throw new Error('HOOK_AUTHORIZATION_REQUIRED: obtain explicit operator approval for this checkout before --authorized')
const providerArg = process.argv.find(value => value.startsWith('--provider='))?.slice('--provider='.length)
const provider = providerArg ?? 'codex'
if (!['codex', 'antigravity'].includes(provider)) throw new Error('PROVIDER_UNSUPPORTED')
function checkout() {
  const status = JSON.parse(execFileSync(process.execPath, [resolve(__dirname, '../continuum/local.cjs'), 'status'], { cwd: root, encoding: 'utf8', windowsHide: true }))
  const record = status.worktrees?.find(record => resolve(record.path) === resolve(root))
  if (!status.available || !record || !status.repository?.repositoryId) throw new Error('WORKTREE_IDENTITY_UNAVAILABLE')
  return { repositoryId: status.repository.repositoryId, record }
}
const { repositoryId, record } = checkout()
const codex = process.argv.find(value => value.startsWith('--codex='))?.slice('--codex='.length)
const antigravity = process.argv.find(value => value.startsWith('--antigravity='))?.slice('--antigravity='.length)
function selectedExecutable() {
  if (!codex || !isAbsolute(codex) || !/^codex(?:\.exe)?$/i.test(basename(codex))) throw new Error('CODEX_EXECUTABLE_SELECTION_REQUIRED')
  try {
    const file = lstatSync(codex)
    if (!file.isFile() || file.isSymbolicLink() || realpathSync(codex) !== resolve(codex)) throw new Error()
  } catch { throw new Error('CODEX_EXECUTABLE_UNAVAILABLE') }
  return codex
}
function inspectAntigravityClient() {
  const samePath = (a, b) => sep === '\\' ? a.toLowerCase() === b.toLowerCase() : a === b
  if (antigravity !== undefined) {
    if (!antigravity || !isAbsolute(antigravity)) throw new Error('ANTIGRAVITY_EXECUTABLE_UNAVAILABLE')
    try {
      const file = lstatSync(antigravity)
      if (!file.isFile() || file.isSymbolicLink() || !samePath(realpathSync(antigravity), resolve(antigravity))) throw new Error()
    } catch { throw new Error('ANTIGRAVITY_EXECUTABLE_UNAVAILABLE') }
    return { state: 'QUALIFIED', provider: 'antigravity', contract: 'agents-hooks-v1', ideExecutable: 'AVAILABLE', cliExecutable: 'NOT_DETECTED' }
  }
  const localAppData = process.env?.LOCALAPPDATA || ''
  const defaultIde = localAppData ? resolve(localAppData, 'Programs/Antigravity/Antigravity.exe') : ''
  let ideAvailable = false
  if (defaultIde) {
    try {
      const file = lstatSync(defaultIde)
      ideAvailable = existsSync(defaultIde) && file.isFile() && !file.isSymbolicLink() && samePath(realpathSync(defaultIde), defaultIde)
    } catch {}
  }
  return { state: 'QUALIFIED', provider: 'antigravity', contract: 'agents-hooks-v1', ideExecutable: ideAvailable ? 'AVAILABLE' : 'NOT_DETECTED', cliExecutable: 'NOT_DETECTED' }
}
function compile(name) {
  const source = buildSync({ entryPoints: [resolve(__dirname, '../../src/main/session-context/', name + '.ts')], write: false, bundle: true, platform: 'node', target: 'node20', format: 'cjs' }).outputFiles[0].text
  const module = { exports: {} }
  new Function('require', 'module', 'exports', '__filename', '__dirname', source)(require, module, module.exports, __filename, __dirname)
  return module.exports
}
const { installNativeHooks, disableNativeHooks, inspectNativeInstallation } = compile('native-hook-installation')
function inspectVersion(binary) {
  let output
  try { output = execFileSync(binary, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 2000, stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
  catch { return { state: 'UNKNOWN', reasonCode: 'CODEX_EXECUTABLE_UNAVAILABLE' } }
  const version = /^codex-cli ([a-zA-Z0-9.+_-]{1,80})$/.exec(output)?.[1]
  if (!version) return { state: 'UNKNOWN', reasonCode: 'CODEX_VERSION_UNAVAILABLE' }
  return isQualifiedCodexHookVersion(version)
    ? { state: 'QUALIFIED', version }
    : { state: 'UNSUPPORTED', reasonCode: 'VERSION_UNSUPPORTED', version }
}
if (action === 'install') {
  let client
  if (provider === 'codex') {
    const binary = selectedExecutable()
    client = inspectVersion(binary)
    if (client.state !== 'QUALIFIED') throw new Error(client.reasonCode)
  } else {
    client = inspectAntigravityClient()
  }
  const git = args => execFileSync('git', args, { encoding: 'utf8', windowsHide: true }).trim()
  const branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD'])
  const head = git(['rev-parse', '--verify', 'HEAD'])
  const tool = provider === 'codex' ? process.argv.find(value => value.startsWith('--git-commit-tool='))?.slice(18) : undefined
  const commandContent = buildSync({ entryPoints: [resolve(__dirname, '../../src/main/session-context/native-hook-command.ts')], outfile: resolve(__dirname, '../../out/session-context/native-hook.cjs'), write: false, bundle: true, platform: 'node', target: 'node20', format: 'cjs' }).outputFiles[0].text
  const legacy = resolve(__dirname, '../../out/session-context/native-hook.cjs')
  const legacyStat = existsSync(legacy) ? lstatSync(legacy) : undefined
  const reuseLegacy = legacyStat?.isFile() && legacyStat.nlink === 1 && legacyStat.size === Buffer.byteLength(commandContent) && readFileSync(legacy, 'utf8') === commandContent
  const digest = createHash('sha256').update(commandContent).digest('hex')
  const commandPath = reuseLegacy ? legacy : resolve(__dirname, '../../out/session-context/native-hook-' + digest + '.cjs')
  const current = checkout()
  if (current.repositoryId !== repositoryId || current.record.worktreeId !== record.worktreeId || current.record.generation !== record.generation) throw new Error('WORKTREE_STALE')
  if (provider === 'codex') {
    const verified = inspectVersion(selectedExecutable())
    if (verified.state !== 'QUALIFIED' || verified.version !== client.version) throw new Error('CODEX_EXECUTABLE_CHANGED')
  }
  if (git(['symbolic-ref', '--quiet', '--short', 'HEAD']) !== branch || git(['rev-parse', '--verify', 'HEAD']) !== head) throw new Error('WORKTREE_STALE')
  console.log(JSON.stringify(installNativeHooks({ repositoryId, record: { ...current.record, branch, head, detached: false, missing: false, prunable: false, locked: false },
    commandPath, commandContent, nodePath: process.execPath, gitCommitTool: tool, provider, authorized })))
} else if (action === 'disable') console.log(JSON.stringify(disableNativeHooks(root, authorized, provider)))
else if (action === 'acknowledge-gap') {
  const { acknowledgeCheckoutGaps } = compile('native-hook-diagnostics')
  const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
  try {
    console.log(JSON.stringify(acknowledgeCheckoutGaps(root, { repositoryId, ...record }, option('revision'), option('reason'), resolve(option('proof')), authorized, provider)))
  } catch (error) {
    const codes = ['HOOK_AUTHORIZATION_REQUIRED', 'WORKTREE_STALE', 'UNSAFE_SPOOL', 'UNSAFE_FILE', 'REVISION_CONFLICT', 'RECOVERY_PROOF_REQUIRED']
    console.error(JSON.stringify({ code: codes.includes(error.message) ? error.message : 'ACK_UNAVAILABLE' }))
    process.exitCode = 1
  }
}
else {
  const { handlers, ...installation } = inspectNativeInstallation(root, { repositoryId, ...record }, process.platform, provider)
  const state = installation.reasonCode === 'NATIVE_CAPTURE_DISABLED' ? 'DISABLED' : installation.state === 'MISSING' ? 'HOOKS_MISSING' : installation.state
  let client
  if (provider === 'antigravity') {
    try { client = inspectAntigravityClient() }
    catch (error) { client = { state: 'UNKNOWN', reasonCode: error.message } }
  } else {
    try { client = inspectVersion(codex === undefined ? 'codex' : selectedExecutable()) }
    catch (error) { client = { state: 'UNKNOWN', reasonCode: error.message } }
  }
  console.log(JSON.stringify({ state, provider, capture: 'UNOBSERVED', installation, client, generation: record.generation, trust: { state: 'UNKNOWN', reasonCode: provider === 'antigravity' ? 'CLIENT_TRUST_UNSUPPORTED' : 'SESSION_SCOPE_UNAVAILABLE' }, execution: { state: 'UNOBSERVED' }, captureReadiness: { state: 'NOT_VERIFIED' }, repositoryId, worktreeId: record.worktreeId }))
}
