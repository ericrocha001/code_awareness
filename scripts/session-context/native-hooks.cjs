const { execFileSync } = require('node:child_process')
const { resolve, join } = require('node:path')
const { buildSync } = require('esbuild')
const root = process.cwd()
const action = process.argv[2]
if (!['install', 'disable', 'status', 'acknowledge-gap'].includes(action)) throw new Error('Use install|disable|status|acknowledge-gap; writes require --authorized')
const authorized = process.argv.includes('--authorized')
if (action !== 'status' && !authorized) throw new Error('HOOK_AUTHORIZATION_REQUIRED: obtain explicit operator approval for this checkout before --authorized')
const status = JSON.parse(execFileSync(process.execPath, [resolve(__dirname, '../continuum/local.cjs'), 'status'], { cwd: root, encoding: 'utf8', windowsHide: true }))
const record = status.worktrees?.find(record => resolve(record.path) === resolve(root))
if (!status.available || !record || !status.repository?.repositoryId) throw new Error('WORKTREE_IDENTITY_UNAVAILABLE')
const output = resolve(__dirname, '../../out/session-context/native-hook-installation.cjs')
buildSync({ entryPoints: [resolve(__dirname, '../../src/main/session-context/native-hook-installation.ts')], outfile: output, bundle: true, platform: 'node', format: 'cjs' })
const { installNativeHooks, disableNativeHooks } = require(output)
if (action === 'install') {
  const version = execFileSync('codex', ['--version'], { encoding: 'utf8', windowsHide: true }).trim()
  if (version !== 'codex-cli 0.166.0-alpha.6') throw new Error('UNSUPPORTED_CODEX_VERSION: validate the hook protocol before installation')
  require('./build-native-hook.cjs')
  const branch = execFileSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim()
  const head = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim()
  const tool = process.argv.find(value => value.startsWith('--git-commit-tool='))?.slice(18)
  console.log(JSON.stringify(installNativeHooks({ repositoryId: status.repository.repositoryId, record: { ...record, branch, head, detached: false, missing: false, prunable: false, locked: false },
    commandPath: resolve(__dirname, '../../out/session-context/native-hook.cjs'), nodePath: process.execPath, gitCommitTool: tool, authorized })))
} else if (action === 'disable') console.log(JSON.stringify(disableNativeHooks(root, authorized)))
else if (action === 'acknowledge-gap') {
  const compiled = resolve(__dirname, '../../out/session-context/native-hook-diagnostics.cjs')
  buildSync({ entryPoints: [resolve(__dirname, '../../src/main/session-context/native-hook-diagnostics.ts')], outfile: compiled, bundle: true, platform: 'node', format: 'cjs' })
  const { acknowledgeCheckoutGaps } = require(compiled)
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
  const { existsSync, readFileSync } = require('node:fs')
  const path = join(root, '.code-awareness/native-hooks/binding.json')
  console.log(JSON.stringify({ state: !existsSync(path) ? 'HOOKS_MISSING' : JSON.parse(readFileSync(path)).enabled ? 'READY' : 'DISABLED', capture: 'UNOBSERVED', repositoryId: status.repository.repositoryId, worktreeId: record.worktreeId }))
}
