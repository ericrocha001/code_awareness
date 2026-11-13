const { execFileSync } = require('node:child_process')
const { resolve } = require('node:path')
const { existsSync, readFileSync, lstatSync } = require('node:fs')
const { createHash } = require('node:crypto')
const { buildSync } = require('esbuild')
const root = process.cwd()
const action = process.argv[2]
if (!['install', 'disable', 'status', 'acknowledge-gap'].includes(action)) throw new Error('Use install|disable|status|acknowledge-gap; writes require --authorized')
const authorized = process.argv.includes('--authorized')
if (action !== 'status' && !authorized) throw new Error('HOOK_AUTHORIZATION_REQUIRED: obtain explicit operator approval for this checkout before --authorized')
const status = JSON.parse(execFileSync(process.execPath, [resolve(__dirname, '../continuum/local.cjs'), 'status'], { cwd: root, encoding: 'utf8', windowsHide: true }))
const record = status.worktrees?.find(record => resolve(record.path) === resolve(root))
if (!status.available || !record || !status.repository?.repositoryId) throw new Error('WORKTREE_IDENTITY_UNAVAILABLE')
function compile(name) {
  const source = buildSync({ entryPoints: [resolve(__dirname, '../../src/main/session-context/', name + '.ts')], write: false, bundle: true, platform: 'node', target: 'node20', format: 'cjs' }).outputFiles[0].text
  const module = { exports: {} }
  new Function('require', 'module', 'exports', '__filename', '__dirname', source)(require, module, module.exports, __filename, __dirname)
  return module.exports
}
const { installNativeHooks, disableNativeHooks, inspectNativeInstallation } = compile('native-hook-installation')
if (action === 'install') {
  const version = execFileSync('codex', ['--version'], { encoding: 'utf8', windowsHide: true }).trim()
  if (!['codex-cli 0.166.0-alpha.6', 'codex-cli 0.167.0-alpha.3.2'].includes(version)) throw new Error('UNSUPPORTED_CODEX_VERSION: validate the hook protocol before installation')
  const branch = execFileSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim()
  const head = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim()
  const tool = process.argv.find(value => value.startsWith('--git-commit-tool='))?.slice(18)
  const commandContent = buildSync({ entryPoints: [resolve(__dirname, '../../src/main/session-context/native-hook-command.ts')], outfile: resolve(__dirname, '../../out/session-context/native-hook.cjs'), write: false, bundle: true, platform: 'node', target: 'node20', format: 'cjs' }).outputFiles[0].text
  const legacy = resolve(__dirname, '../../out/session-context/native-hook.cjs')
  const legacyStat = existsSync(legacy) ? lstatSync(legacy) : undefined
  const reuseLegacy = legacyStat?.isFile() && legacyStat.nlink === 1 && legacyStat.size === Buffer.byteLength(commandContent) && readFileSync(legacy, 'utf8') === commandContent
  const digest = createHash('sha256').update(commandContent).digest('hex')
  const commandPath = reuseLegacy ? legacy : resolve(__dirname, '../../out/session-context/native-hook-' + digest + '.cjs')
  console.log(JSON.stringify(installNativeHooks({ repositoryId: status.repository.repositoryId, record: { ...record, branch, head, detached: false, missing: false, prunable: false, locked: false },
    commandPath, commandContent, nodePath: process.execPath, gitCommitTool: tool, authorized })))
} else if (action === 'disable') console.log(JSON.stringify(disableNativeHooks(root, authorized)))
else if (action === 'acknowledge-gap') {
  const { acknowledgeCheckoutGaps } = compile('native-hook-diagnostics')
  const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
  try {
    console.log(JSON.stringify(acknowledgeCheckoutGaps(root, { repositoryId: status.repository.repositoryId, ...record }, option('revision'), option('reason'), resolve(option('proof')), authorized)))
  } catch (error) {
    const codes = ['HOOK_AUTHORIZATION_REQUIRED', 'WORKTREE_STALE', 'UNSAFE_SPOOL', 'UNSAFE_FILE', 'REVISION_CONFLICT', 'RECOVERY_PROOF_REQUIRED']
    console.error(JSON.stringify({ code: codes.includes(error.message) ? error.message : 'ACK_UNAVAILABLE' }))
    process.exitCode = 1
  }
}
else {
  const { handlers, ...installation } = inspectNativeInstallation(root, { repositoryId: status.repository.repositoryId, ...record })
  const state = installation.reasonCode === 'NATIVE_CAPTURE_DISABLED' ? 'DISABLED' : installation.state === 'MISSING' ? 'HOOKS_MISSING' : installation.state
  console.log(JSON.stringify({ state, capture: 'UNOBSERVED', installation, trust: { state: 'UNKNOWN', reasonCode: 'SESSION_SCOPE_UNAVAILABLE' }, execution: { state: 'UNOBSERVED' }, captureReadiness: { state: 'NOT_VERIFIED' }, repositoryId: status.repository.repositoryId, worktreeId: record.worktreeId }))
}
