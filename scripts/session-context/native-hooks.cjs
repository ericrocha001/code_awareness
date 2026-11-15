const { execFileSync } = require('node:child_process')
const { resolve, isAbsolute, basename } = require('node:path')
const { existsSync, readFileSync, lstatSync, realpathSync } = require('node:fs')
const { createHash } = require('node:crypto')
const { isQualifiedCodexHookVersion } = require('../../src/shared/native-hook-preflight.cjs')
const { buildSync } = require('esbuild')
const root = process.cwd()
const action = process.argv[2]
if (!['install', 'disable', 'status', 'acknowledge-gap'].includes(action)) throw new Error('Use install|disable|status|acknowledge-gap; writes require --authorized')
const authorized = process.argv.includes('--authorized')
if (action !== 'status' && !authorized) throw new Error('HOOK_AUTHORIZATION_REQUIRED: obtain explicit operator approval for this checkout before --authorized')
function checkout() {
  const status = JSON.parse(execFileSync(process.execPath, [resolve(__dirname, '../continuum/local.cjs'), 'status'], { cwd: root, encoding: 'utf8', windowsHide: true }))
  const record = status.worktrees?.find(record => resolve(record.path) === resolve(root))
  if (!status.available || !record || !status.repository?.repositoryId) throw new Error('WORKTREE_IDENTITY_UNAVAILABLE')
  return { repositoryId: status.repository.repositoryId, record }
}
const { repositoryId, record } = checkout()
const codex = process.argv.find(value => value.startsWith('--codex='))?.slice('--codex='.length)
function selectedExecutable() {
  if (!codex || !isAbsolute(codex) || !/^codex(?:\.exe)?$/i.test(basename(codex))) throw new Error('CODEX_EXECUTABLE_SELECTION_REQUIRED')
  try {
    const file = lstatSync(codex)
    if (!file.isFile() || file.isSymbolicLink() || realpathSync(codex) !== resolve(codex)) throw new Error()
  } catch { throw new Error('CODEX_EXECUTABLE_UNAVAILABLE') }
  return codex
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
  const binary = selectedExecutable()
  const client = inspectVersion(binary)
  if (client.state !== 'QUALIFIED') throw new Error(client.reasonCode)
  const git = args => execFileSync('git', args, { encoding: 'utf8', windowsHide: true }).trim()
  const branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD'])
  const head = git(['rev-parse', '--verify', 'HEAD'])
  const tool = process.argv.find(value => value.startsWith('--git-commit-tool='))?.slice(18)
  const commandContent = buildSync({ entryPoints: [resolve(__dirname, '../../src/main/session-context/native-hook-command.ts')], outfile: resolve(__dirname, '../../out/session-context/native-hook.cjs'), write: false, bundle: true, platform: 'node', target: 'node20', format: 'cjs' }).outputFiles[0].text
  const legacy = resolve(__dirname, '../../out/session-context/native-hook.cjs')
  const legacyStat = existsSync(legacy) ? lstatSync(legacy) : undefined
  const reuseLegacy = legacyStat?.isFile() && legacyStat.nlink === 1 && legacyStat.size === Buffer.byteLength(commandContent) && readFileSync(legacy, 'utf8') === commandContent
  const digest = createHash('sha256').update(commandContent).digest('hex')
  const commandPath = reuseLegacy ? legacy : resolve(__dirname, '../../out/session-context/native-hook-' + digest + '.cjs')
  const current = checkout()
  if (current.repositoryId !== repositoryId || current.record.worktreeId !== record.worktreeId || current.record.generation !== record.generation) throw new Error('WORKTREE_STALE')
  const verified = inspectVersion(selectedExecutable())
  if (verified.state !== 'QUALIFIED' || verified.version !== client.version) throw new Error('CODEX_EXECUTABLE_CHANGED')
  if (git(['symbolic-ref', '--quiet', '--short', 'HEAD']) !== branch || git(['rev-parse', '--verify', 'HEAD']) !== head) throw new Error('WORKTREE_STALE')
  console.log(JSON.stringify(installNativeHooks({ repositoryId, record: { ...current.record, branch, head, detached: false, missing: false, prunable: false, locked: false },
    commandPath, commandContent, nodePath: process.execPath, gitCommitTool: tool, authorized })))
} else if (action === 'disable') console.log(JSON.stringify(disableNativeHooks(root, authorized)))
else if (action === 'acknowledge-gap') {
  const { acknowledgeCheckoutGaps } = compile('native-hook-diagnostics')
  const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
  try {
    console.log(JSON.stringify(acknowledgeCheckoutGaps(root, { repositoryId, ...record }, option('revision'), option('reason'), resolve(option('proof')), authorized)))
  } catch (error) {
    const codes = ['HOOK_AUTHORIZATION_REQUIRED', 'WORKTREE_STALE', 'UNSAFE_SPOOL', 'UNSAFE_FILE', 'REVISION_CONFLICT', 'RECOVERY_PROOF_REQUIRED']
    console.error(JSON.stringify({ code: codes.includes(error.message) ? error.message : 'ACK_UNAVAILABLE' }))
    process.exitCode = 1
  }
}
else {
  const { handlers, ...installation } = inspectNativeInstallation(root, { repositoryId, ...record })
  const state = installation.reasonCode === 'NATIVE_CAPTURE_DISABLED' ? 'DISABLED' : installation.state === 'MISSING' ? 'HOOKS_MISSING' : installation.state
  let client
  try { client = inspectVersion(codex === undefined ? 'codex' : selectedExecutable()) }
  catch (error) { client = { state: 'UNKNOWN', reasonCode: error.message } }
  console.log(JSON.stringify({ state, capture: 'UNOBSERVED', installation, client, generation: record.generation, trust: { state: 'UNKNOWN', reasonCode: 'SESSION_SCOPE_UNAVAILABLE' }, execution: { state: 'UNOBSERVED' }, captureReadiness: { state: 'NOT_VERIFIED' }, repositoryId, worktreeId: record.worktreeId }))
}
