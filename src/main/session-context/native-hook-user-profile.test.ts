import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { removeDirectoryForceSync } from '../core/force-remove'
import { GitService } from '../core/git-service'
import { GitOperationsService } from '../git-operations/git-operations-service'
import { executeGitOperationsTool } from '../git-operations/git-operations-mcp'
import { GitWorktreeRegistry } from '../git-operations/git-worktree-registry'
import { RepositoryCatalogStore } from '../repository-catalog/repository-catalog-store'
import { RepositoryCatalogService } from '../repository-catalog/repository-catalog-service'
import { WorkspaceService } from '../core/workspace-service'
import type { AppSettings } from '../../shared/types'
import {
  disableUserProfileCodex,
  enrollRepositoryForUserCodex,
  enrollUserProfileCodex,
  reconcileRepositoryCodexHooks,
  revokeNativeHooks,
  userCodexProfileStatus
} from './native-hook-enrollment'
import {
  discoverCodexClients,
  formatUserCodexHookCommand,
  inspectUserCodexInstallation,
  parseUserCodexCommand,
  qualifyCodexBinary,
  resolveCodexHome,
  resolveDistributableNodeRuntime,
  resolvePortableHelperContent
} from './native-hook-profile'
import {
  hookPaths,
  installNativeHooks
} from './native-hook-installation'
import { nativeDigest, readNativeBinding, parseNativeEnvelope, type NativeHookBinding } from './native-hooks'
import { nativeHookReadiness } from './native-hook-readiness'
import { inspectNativeTrust, type NativeHookClient } from './native-hook-preflight'
import { inspectNativeCaptureHealth } from './capture-health'
import { SessionStore, sessionStorePath } from './store'
import { ingestNativeHooks } from './native-hook-ingestion'
import { correlateNativeGit } from './native-git-correlation'
import { sessionTargetResolver } from './target'

async function queryCodexHooksList(codexBinary: string, cwd: string, codexHome: string) {
  return await new Promise<Array<{ source: string; sourcePath: string; eventName: string; enabled: boolean }>>((resolve, reject) => {
    const child = spawn(codexBinary, ['app-server', '--listen', 'stdio://'], {
      cwd,
      env: { ...process.env, CODEX_HOME: codexHome },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let buf = ''
    let settled = false
    let pendingErr: unknown
    let pendingHooks: Array<{ source: string; sourcePath: string; eventName: string; enabled: boolean }> | undefined
    const finish = () => {
      clearTimeout(timer)
      if (pendingErr) reject(pendingErr)
      else resolve(pendingHooks ?? [])
    }
    const done = (err?: unknown, hooks?: Array<{ source: string; sourcePath: string; eventName: string; enabled: boolean }>) => {
      if (settled) return
      settled = true
      pendingErr = err
      pendingHooks = hooks
      if (child.exitCode !== null || child.signalCode !== null) { finish(); return }
      child.once('exit', finish)
      try { child.kill() } catch { finish() }
    }
    const timer = setTimeout(() => done(new Error('CODEX_APP_SERVER_TIMEOUT')), 15_000)
    child.on('error', err => done(err))
    child.once('exit', () => {
      if (!settled) done(new Error('CODEX_APP_SERVER_EXITED_EARLY'))
    })
    child.stdout.on('data', chunk => {
      buf += chunk.toString('utf8')
      let nl: number
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        try {
          const msg = JSON.parse(line) as { id?: number; error?: { message?: string }; result?: { data?: Array<{ hooks?: Array<{ source: string; sourcePath: string; eventName: string; enabled: boolean }> }> } }
          if (msg.id === 1 && !msg.error) {
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }) + '\n')
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'hooks/list', params: { cwds: [cwd] } }) + '\n')
          } else if (msg.id === 2) {
            if (msg.error) done(new Error(msg.error.message ?? 'HOOKS_LIST_ERROR'))
            else done(undefined, msg.result?.data?.[0]?.hooks ?? [])
          }
        } catch {}
      }
    })
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'code_awareness_test', title: 'Test', version: '1.0.0' }, capabilities: { experimentalApi: true } }
    }) + '\n')
  })
}

const cleanupPaths: string[] = []
const cleanupClosers: Array<() => void> = []
afterEach(async () => {
  for (const close of cleanupClosers.splice(0).reverse()) {
    try { close() } catch {}
  }
  for (const target of cleanupPaths.splice(0).reverse()) {
    for (let attempt = 0; attempt < 15; attempt++) {
      try {
        removeDirectoryForceSync(target)
        break
      } catch (err) {
        const code = (err as NodeJS.ErrnoException | undefined)?.code
        if ((code === 'EBUSY' || code === 'EPERM') && attempt < 14) {
          await new Promise(resolve => setTimeout(resolve, 100))
          continue
        }
        throw err
      }
    }
  }
})

function tempBase(prefix = 'codex-user-hooks-'): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  cleanupPaths.push(dir)
  return dir
}

function initRepo(dir: string, hooksDir: string, branch = 'main'): void {
  mkdirSync(dir, { recursive: true })
  const run = (...args: string[]) => execFileSync(
    'git',
    ['-C', dir, '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${hooksDir}`, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
    { encoding: 'utf8', windowsHide: true, stdio: 'pipe' }
  )
  run('init', '-b', branch)
  writeFileSync(join(dir, 'README.md'), 'fixture\n')
  run('add', 'README.md')
  run('commit', '-m', 'initial')
}

function runGit(cwd: string, hooksDir: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-C', cwd, '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${hooksDir}`, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
    { encoding: 'utf8', windowsHide: true, stdio: 'pipe' }
  ).trim()
}

function makeProfile(base: string) {
  const profile = join(base, 'Code Awareness Profile')
  const catalogPath = join(profile, 'repositories', 'catalog.db')
  mkdirSync(dirname(catalogPath), { recursive: true })
  const store = new RepositoryCatalogStore(catalogPath)
  cleanupClosers.push(() => store.close())
  return { profile, catalogPath, store }
}

function portableRuntime() {
  const helperContent = resolvePortableHelperContent({ packaged: false, appPath: process.cwd() })
  const runAsNode = !/^node(?:\.exe)?$/i.test(process.execPath.split(/[\\/]/).pop() ?? '')
  return { helperContent, helperDigest: nativeDigest(helperContent), nodePath: process.execPath, runAsNode }
}

function runPortableHook(options: {
  helperPath: string
  cwd: string
  payload: Record<string, unknown>
  runAsNode?: boolean
  nodePath?: string
  timing?: boolean
}) {
  const start = performance.now()
  const env = { ...process.env }
  if (options.runAsNode) env.ELECTRON_RUN_AS_NODE = '1'
  else delete env.ELECTRON_RUN_AS_NODE
  if (options.timing) env.CA_HOOK_TIMING = '1'
  let stderr = ''
  const stdout = execFileSync(options.nodePath ?? process.execPath, [options.helperPath], {
    cwd: options.cwd,
    input: JSON.stringify(options.payload),
    encoding: 'utf8',
    timeout: 3000,
    windowsHide: true,
    env
  })
  const durationMs = performance.now() - start
  return { stdout, stderr, durationMs }
}

test('U1: installs user-profile Codex hooks once with structural CAS merge, preserves unknown fields/third parties/TOML, supports Electron runtime, and isolates multi-repo enrollment & rollback', async () => {
  const base = tempBase('u1-profile-')
  const noHooks = join(base, 'no-hooks'); mkdirSync(noHooks)
  const { profile, store } = makeProfile(base)
  const codexHome = join(base, 'Codex Profile With Spaces')
  mkdirSync(codexHome, { recursive: true })

  // Preserve config.toml and rich existing hooks.json structure
  const tomlPath = join(codexHome, 'config.toml')
  const tomlBytes = 'model = "gpt-5"\n[features]\nhooks = true\n'
  writeFileSync(tomlPath, tomlBytes)

  const hooksPath = join(codexHome, 'hooks.json')
  const preExistingConfig = {
    extraTopLevel: { keepMe: true, count: 42 },
    hooks: {
      SessionStart: [
        { matcher: '*', unknownGroupField: 'keep', hooks: [{ type: 'command', command: 'echo third-party-start', timeout: 5, customField: 'abc' }] }
      ],
      CustomFutureEvent: [{ hooks: [{ type: 'command', command: 'echo future' }] }]
    }
  }
  writeFileSync(hooksPath, JSON.stringify(preExistingConfig, null, 2) + '\n')

  expect(resolveCodexHome(undefined, { ...process.env, CODEX_HOME: codexHome })).toBe(codexHome)

  // Register 4 active git checkouts via RepositoryCatalogStore
  const repoA = join(base, 'repo A')
  const repoB = join(base, 'repo B')
  const repoC = join(base, 'repo-c-not-enrolled')
  const repoD = join(base, 'repo-d-auto-enroll')
  for (const r of [repoA, repoB, repoC, repoD]) initRepo(r, noHooks)

  const recA = store.upsertLocalCheckout({ path: repoA, normalizedPath: repoA.toLowerCase(), name: 'repoA', status: 'ACTIVE', availability: 'AVAILABLE', gitState: 'GIT' }).record
  const recB = store.upsertLocalCheckout({ path: repoB, normalizedPath: repoB.toLowerCase(), name: 'repoB', status: 'ACTIVE', availability: 'AVAILABLE', gitState: 'GIT' }).record
  const recC = store.upsertLocalCheckout({ path: repoC, normalizedPath: repoC.toLowerCase(), name: 'repoC', status: 'ACTIVE', availability: 'AVAILABLE', gitState: 'GIT' }).record

  // Prepare packaged-style portable helper test & ELECTRON_RUN_AS_NODE resolution
  const packagedResources = join(base, 'packaged-resources')
  const unpackedPortable = join(packagedResources, 'app.asar.unpacked', 'out', 'session-context', 'native-hook-portable.cjs')
  mkdirSync(dirname(unpackedPortable), { recursive: true })
  const { helperContent, helperDigest, nodePath, runAsNode } = portableRuntime()
  writeFileSync(unpackedPortable, helperContent)
  expect(resolvePortableHelperContent({ packaged: true, appPath: join(base, 'ignored.asar'), resourcesPath: packagedResources })).toBe(helperContent)
  if (/[\\/]worktrees?[\\/]/i.test(process.execPath)) {
    expect(() => resolveDistributableNodeRuntime({ packaged: true, execPath: process.execPath })).toThrow('INSTALL_DESTINATION_EPHEMERAL')
  }
  const stableNodeCandidate = process.platform === 'win32'
    ? join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs', 'node.exe')
    : process.execPath
  if (existsSync(stableNodeCandidate) && !/[\\/]worktrees?[\\/]/i.test(stableNodeCandidate)) {
    expect(resolveDistributableNodeRuntime({ packaged: true, execPath: stableNodeCandidate })).toMatchObject({
      nodePath: realpathSync(stableNodeCandidate),
      runAsNode: true
    })
  }

  // Malformed hooks.json must be refused cleanly without overwriting
  const malformedHome = join(base, 'malformed-home'); mkdirSync(malformedHome, { recursive: true })
  writeFileSync(join(malformedHome, 'hooks.json'), '{not-valid-json')
  expect(() => enrollUserProfileCodex({
    profile, codexHome: malformedHome, helperContent, nodePath, runAsNode, authorized: true, allowWorktreeRuntime: true
  })).toThrow()
  expect(readFileSync(join(malformedHome, 'hooks.json'), 'utf8')).toBe('{not-valid-json')

  // Opt-in install at user profile (enroll only Repo A & Repo B initially)
  const firstInstall = enrollUserProfileCodex({
    profile,
    codexHome,
    helperContent,
    nodePath,
    runAsNode,
    gitCommitTool: 'mcp__code_awareness__commit_git_changes',
    autoEnrollNewProjects: false,
    repositoryIds: [recA.id, recB.id],
    authorized: true,
    allowWorktreeRuntime: true
  })
  expect(firstInstall.state).toBe('CONFIGURED')
  expect(firstInstall.trust).toBe('REVIEW_REQUIRED')
  expect(firstInstall.codexHome).toBe(codexHome)
  expect(firstInstall.configPath).toBe(hooksPath)
  expect(firstInstall.helperDigest).toBe(helperDigest)
  expect(firstInstall.enrolledRepositories.sort()).toEqual([recA.id, recB.id].sort())

  // Command contains ONLY distributed runtime + portable helper outside any checkout/worktree
  const parsedConfig = JSON.parse(readFileSync(hooksPath, 'utf8'))
  expect(parsedConfig.extraTopLevel).toEqual({ keepMe: true, count: 42 })
  expect(parsedConfig.hooks.CustomFutureEvent).toEqual([{ hooks: [{ type: 'command', command: 'echo future' }] }])
  expect(parsedConfig.hooks.SessionStart[0]).toEqual(preExistingConfig.hooks.SessionStart[0])
  const installedStartHook = parsedConfig.hooks.SessionStart[1].hooks[0]
  expect(installedStartHook.command).not.toContain(repoA)
  expect(installedStartHook.command).not.toContain(repoB)
  expect(installedStartHook.commandWindows).toContain('& ')
  expect(parseUserCodexCommand(installedStartHook.command)).toEqual({
    nodePath: realpathSync(nodePath),
    helperPath: firstInstall.helperPath,
    runAsNode
  })
  expect(readFileSync(tomlPath, 'utf8')).toBe(tomlBytes)

  // Idempotency: repeat call returns NO_CHANGE + UNCHANGED with identical bytes & mtime
  const beforeBytes = readFileSync(hooksPath, 'utf8')
  const beforeMtimeMs = statSync(hooksPath).mtimeMs
  const repeat = enrollUserProfileCodex({
    profile, codexHome, helperContent, nodePath, runAsNode,
    gitCommitTool: 'mcp__code_awareness__commit_git_changes',
    autoEnrollNewProjects: false,
    authorized: true,
    allowWorktreeRuntime: true
  })
  expect(repeat).toMatchObject({ state: 'NO_CHANGE', trust: 'UNCHANGED' })
  expect(readFileSync(hooksPath, 'utf8')).toBe(beforeBytes)
  expect(statSync(hooksPath).mtimeMs).toBe(beforeMtimeMs)

  // Re-enrolling / enrolling another repo does NOT rewrite hooks.json or helper
  const repoE = join(base, 'repoE'); initRepo(repoE, noHooks)
  const recE = store.upsertLocalCheckout({ path: repoE, normalizedPath: repoE.toLowerCase(), name: 'repoE', status: 'ACTIVE', availability: 'AVAILABLE', gitState: 'GIT' }).record
  expect(enrollRepositoryForUserCodex(profile, recE.id, { authorized: true }).state).toBe('ENROLLED')
  expect(readFileSync(hooksPath, 'utf8')).toBe(beforeBytes)

  // Explicit autoEnrollNewProjects gating via RepositoryCatalogService.importRoot / importLocal
  const scanRoot = join(base, 'managed-root'); mkdirSync(scanRoot)
  const managedDisabled = join(scanRoot, 'managed-disabled'); initRepo(managedDisabled, noHooks)
  const catalogService = new RepositoryCatalogService(store, new WorkspaceService(), undefined, async record => {
    reconcileRepositoryCodexHooks(profile, record.id, autoEnrollSetting)
  })
  let autoEnrollSetting = false
  await catalogService.importRoot(scanRoot)
  const managedDisabledRec = store.findByNormalizedPath(managedDisabled.toLowerCase())!
  expect(userCodexProfileStatus({ profile, codexHome, repositoryId: managedDisabledRec.id }).repositoryEnrolled).toBe(false)

  // Now flip autoEnrollNewProjects = true cleanly and scan a new project
  autoEnrollSetting = true
  enrollUserProfileCodex({
    profile, codexHome, helperContent, nodePath, runAsNode,
    autoEnrollNewProjects: true, authorized: true, allowWorktreeRuntime: true
  })
  await catalogService.importLocal(repoD)
  const recD = store.findByNormalizedPath(repoD.toLowerCase())!
  expect(userCodexProfileStatus({ profile, codexHome, repositoryId: recD.id }).repositoryEnrolled).toBe(true)

  // Revoking one repo preserves other enrolled repos & user profile hooks
  revokeNativeHooks(profile, recE.id, 'codex', true)
  const statusAfterRevoke = userCodexProfileStatus({ profile, codexHome, repositoryId: recE.id })
  expect(statusAfterRevoke.repositoryEnrolled).toBe(false)
  expect(statusAfterRevoke.enrolledRepositoryIds).toContain(recA.id)
  expect(statusAfterRevoke.enrolledRepositoryIds).toContain(recB.id)
  expect(statusAfterRevoke.enrolledRepositoryIds).not.toContain(recC.id)
  expect(statusAfterRevoke.installation.state).toBe('CONFIGURED')

  // Readiness & trust inspection WITHOUT preexisting binding.json
  const registryA = new GitWorktreeRegistry(repoA, new GitService(), { repositoryId: recA.id, isActive: () => true })
  const recordA = await registryA.resolveCheckout(repoA)
  const sStoreA = new SessionStore(sessionStorePath(profile, recA.id), recA.id)
  try {
    const fixedConnectedAt = new Date().toISOString()
    const installedHandlers = inspectUserCodexInstallation(profile, codexHome, process.platform).handlers
    const pendingClient: NativeHookClient = {
      authorized: true,
      scope: () => ({
        repositoryId: recA.id, worktreeId: recordA.worktreeId, generation: recordA.generation,
        clientId: 'c1', sessionId: 's1', threadId: 't1', connectedAt: fixedConnectedAt,
        clientVersion: '0.169.0-alpha.11.1', protocolVersion: 'codex-app-server/v2', workspaceRoot: repoA, projectTrusted: true
      }),
      request: async () => ({
        data: [{
          hooks: installedHandlers.map(h => ({
            key: h.key, sourcePath: h.sourcePath, eventName: h.event[0].toLowerCase() + h.event.slice(1),
            currentHash: 'sha256:' + nativeDigest(h.key), trustStatus: 'untrusted', enabled: true
          }))
        }]
      })
    }
    const trustPending = await inspectNativeTrust(repoA, { repositoryId: recA.id, ...recordA }, true, pendingClient, () => {}, profile)
    expect(trustPending).toMatchObject({ state: 'UNTRUSTED', reasonCode: 'HOOK_AUTHORIZATION_INCOMPLETE', loadedSource: 'USER', trusted: 0 })
    const readinessPending = nativeHookReadiness(sStoreA.registry, repoA, recordA, trustPending, 'codex', { profile })
    expect(readinessPending.bootstrap).toMatchObject({ state: 'AVAILABLE' })
    expect(readinessPending.execution.state).toBe('UNOBSERVED')
    expect(readinessPending.installation).toMatchObject({ state: 'CONFIGURED', reasonCode: 'USER_PROFILE_READY_BINDING_PENDING' })

    const trustedClient: NativeHookClient = {
      ...pendingClient,
      request: async () => ({
        data: [{
          hooks: installedHandlers.map(h => ({
            key: h.key, sourcePath: h.sourcePath, eventName: h.event[0].toLowerCase() + h.event.slice(1),
            currentHash: 'sha256:' + nativeDigest(h.key), trustStatus: 'trusted', enabled: true
          }))
        }]
      })
    }
    const trustOk = await inspectNativeTrust(repoA, { repositoryId: recA.id, ...recordA }, true, trustedClient, () => {}, profile)
    expect(trustOk).toMatchObject({ state: 'TRUSTED', loadedSource: 'USER', trusted: 7 })
    const health = inspectNativeCaptureHealth(sStoreA, repoA, recordA, 'codex', trustOk, profile)
    expect(health.state).toBe('CONFIGURED')
    expect(health.state).not.toBe('CAPTURE_VERIFIED')
    expect(health.nativeCapture.readiness.bootstrap).toMatchObject({ state: 'AVAILABLE' })
    expect(health.nativeCapture.readiness.execution.state).toBe('UNOBSERVED')
  } finally {
    sStoreA.close()
  }

  // Concurrent third-party handler added after install is preserved upon disableUserProfileCodex rollback!
  const afterThirdParty = JSON.parse(readFileSync(hooksPath, 'utf8'))
  afterThirdParty.hooks.PostToolUse.push({ hooks: [{ type: 'command', command: 'echo added-concurrently' }] })
  writeFileSync(hooksPath, JSON.stringify(afterThirdParty, null, 2) + '\n')
  const disabled = disableUserProfileCodex(profile, true, codexHome)
  expect(disabled.state).toBe('DISABLED')
  const rolledBack = JSON.parse(readFileSync(hooksPath, 'utf8'))
  expect(rolledBack.hooks.SessionStart).toHaveLength(1)
  expect(rolledBack.hooks.PostToolUse).toHaveLength(1)
  expect(rolledBack.hooks.PostToolUse[0].hooks[0].command).toBe('echo added-concurrently')
  expect(rolledBack.extraTopLevel).toEqual({ keepMe: true, count: 42 })

  // Real Codex CLI/Desktop app-server hooks/list qualification on isolated $CODEX_HOME (if installed on host)
  const discoveredClients = discoverCodexClients().filter(c => c.qualified)
  if (discoveredClients.length > 0) {
    const realCodexHome = join(base, 'Codex Real Qualification')
    mkdirSync(realCodexHome, { recursive: true })
    writeFileSync(join(realCodexHome, 'hooks.json'), JSON.stringify({
      hooks: { SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo valid-third-party', timeout: 5 }] }] }
    }, null, 2) + '\n')
    const reinstall = enrollUserProfileCodex({
      profile, codexHome: realCodexHome, helperContent, nodePath, runAsNode, authorized: true, allowWorktreeRuntime: true
    })
    expect(reinstall.state).toBe('CONFIGURED')
    const detachedWt = join(base, 'repoA-detached-no-codex')
    runGit(repoA, noHooks, 'worktree', 'add', '--detach', detachedWt)
    expect(existsSync(join(detachedWt, '.codex'))).toBe(false)
    const { summarizeHookList } = await import('../../shared/native-hook-preflight.cjs')
    const realHandlers = inspectUserCodexInstallation(profile, realCodexHome, process.platform).handlers
    for (const clientInfo of discoveredClients) {
      expect(qualifyCodexBinary(clientInfo.path, clientInfo.origin).qualified).toBe(true)
      const listResult = await queryCodexHooksList(clientInfo.path, detachedWt, realCodexHome)
      const userHooks = listResult.filter(h => h.source === 'user' && h.sourcePath === reinstall.configPath)
      // 7 Code Awareness handlers + 1 preserved third-party SessionStart handler
      expect(userHooks).toHaveLength(8)
      expect(userHooks.every(h => h.enabled === true)).toBe(true)
      const summary = summarizeHookList({ data: [{ hooks: listResult }] }, realHandlers)
      expect(summary.matched).toBe(7)
    }
  }
}, 45_000)

test('U2: cold-path SessionStart bootstrap without PS1/binding on external & detached worktrees, fast path, security barriers, Git MCP causality, timing (<3s), and safe legacy cutover', async () => {
  const base = tempBase('u2-capture-')
  const noHooks = join(base, 'no-hooks'); mkdirSync(noHooks)
  const { profile, store } = makeProfile(base)
  const codexHome = join(base, 'codex-user-home'); mkdirSync(codexHome, { recursive: true })
  const { helperContent, nodePath, runAsNode } = portableRuntime()

  const repoA = join(base, 'repoA'); initRepo(repoA, noHooks)
  const repoB = join(base, 'repoB'); initRepo(repoB, noHooks)
  const repoUnenrolled = join(base, 'repo-unenrolled'); initRepo(repoUnenrolled, noHooks)
  const foreignClone = join(base, 'repoA-foreign-clone'); initRepo(foreignClone, noHooks)

  const recA = store.upsertLocalCheckout({ path: repoA, normalizedPath: repoA.toLowerCase(), name: 'repoA', status: 'ACTIVE', availability: 'AVAILABLE', gitState: 'GIT' }).record
  const recB = store.upsertLocalCheckout({ path: repoB, normalizedPath: repoB.toLowerCase(), name: 'repoB', status: 'ACTIVE', availability: 'AVAILABLE', gitState: 'GIT' }).record

  // Legacy project hooks in repoB (with Entire + custom hook + legacy CA project handler + pending spool + SQLite session history)
  const wtBPreExisting = join(base, 'wt-b-legacy')
  runGit(repoB, noHooks, 'worktree', 'add', '-b', 'legacy-branch', wtBPreExisting)
  mkdirSync(join(wtBPreExisting, '.codex'), { recursive: true })
  const projectHooksFile = join(wtBPreExisting, '.codex', 'hooks.json')
  writeFileSync(projectHooksFile, JSON.stringify({
    hooks: {
      SessionStart: [
        { hooks: [{ type: 'command', command: 'entire hooks codex session-start', timeout: 20 }] },
        { hooks: [{ type: 'command', command: 'echo custom-repoB', timeout: 3 }] }
      ]
    }
  }, null, 2) + '\n')
  const registryB = new GitWorktreeRegistry(repoB, new GitService(), { repositoryId: recB.id, isActive: () => true })
  const recordWtB = await registryB.resolveCheckout(wtBPreExisting)
  const legacyCommandPath = join(process.cwd(), 'out', 'session-context', 'native-hook.cjs')
  const stableNode = process.platform === 'win32'
    ? join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs', 'node.exe')
    : process.execPath
  const legacyInstall = installNativeHooks({
    repositoryId: recB.id,
    record: recordWtB,
    commandPath: legacyCommandPath,
    nodePath: existsSync(stableNode) ? stableNode : process.execPath,
    authorized: true
  })
  expect(legacyInstall.state).toBe('CONFIGURED')
  const legacyBindingPath = legacyInstall.bindingPath
  const legacySpoolDir = join(dirname(legacyBindingPath), 'spool')
  writeFileSync(join(legacySpoolDir, '99.json'), '{"preserved":true}')
  const sStoreB = new SessionStore(sessionStorePath(profile, recB.id), recB.id)
  sStoreB.close()

  // Conflicting scope test repo (defer cutover when legacy config does not match snapshot)
  const conflictRepo = join(base, 'repo-conflict'); initRepo(conflictRepo, noHooks)
  store.upsertLocalCheckout({ path: conflictRepo, normalizedPath: conflictRepo.toLowerCase(), name: 'repoConflict', status: 'ACTIVE', availability: 'AVAILABLE', gitState: 'GIT' })
  mkdirSync(join(conflictRepo, '.codex'), { recursive: true })
  mkdirSync(join(conflictRepo, '.code-awareness', 'native-hooks'), { recursive: true })
  writeFileSync(join(conflictRepo, '.codex', 'hooks.json'), '{bad-json')
  writeFileSync(join(conflictRepo, '.code-awareness', 'native-hooks', 'installation.json'), '{"schema":1}')

  const enrolled = enrollUserProfileCodex({
    profile,
    codexHome,
    helperContent,
    nodePath,
    runAsNode,
    gitCommitTool: 'mcp__code_awareness__commit_git_changes',
    enrollActiveRepositories: true,
    cutoverLegacy: true,
    worktreePaths: [wtBPreExisting, conflictRepo],
    authorized: true,
    allowWorktreeRuntime: true
  })
  expect(enrolled.state).toBe('DEFERRED')
  expect(enrolled.cutover?.state).toBe('DEFERRED')
  expect(enrolled.cutover?.items.some(i => i.path === wtBPreExisting && i.state === 'REMOVED')).toBe(true)
  expect(enrolled.cutover?.items.some(i => i.path === conflictRepo && i.state === 'CONFLICT')).toBe(true)
  // Cutover preserved Entire, custom hook, pending spool, binding.json (now USER-scoped), and SQLite DB!
  const cleanedProjectHooks = JSON.parse(readFileSync(projectHooksFile, 'utf8'))
  expect(cleanedProjectHooks.hooks.SessionStart).toHaveLength(2)
  expect(cleanedProjectHooks.hooks.SessionStart[0].hooks[0].command).toBe('entire hooks codex session-start')
  expect(cleanedProjectHooks.hooks.SessionStart[1].hooks[0].command).toBe('echo custom-repoB')
  expect(cleanedProjectHooks.hooks.PreToolUse).toBeUndefined()
  expect(readFileSync(join(legacySpoolDir, '99.json'), 'utf8')).toBe('{"preserved":true}')
  expect(existsSync(legacyBindingPath)).toBe(true)
  expect(readNativeBinding(legacyBindingPath)).toMatchObject({ scope: 'USER', configPath: enrolled.configPath })
  expect(existsSync(join(dirname(legacyBindingPath), 'installation.json'))).toBe(false)
  expect(existsSync(sessionStorePath(profile, recB.id))).toBe(true)

  const helperPath = enrolled.helperPath
  const wtDetachedA = join(base, 'external-detached-A')
  const wtExternalB = join(base, 'external-wt-B')
  runGit(repoA, noHooks, 'worktree', 'add', '--detach', wtDetachedA)
  runGit(repoB, noHooks, 'worktree', 'add', '-b', 'feat-b', wtExternalB)
  expect(existsSync(join(wtDetachedA, '.codex'))).toBe(false)
  expect(existsSync(join(wtDetachedA, '.code-awareness'))).toBe(false)

  // 1. Out-of-scope / non-enrolled repo must exit 0 neutrally with NO files written
  const unEnrolledRes = runPortableHook({
    helperPath,
    cwd: repoUnenrolled,
    runAsNode,
    timing: true,
    payload: { cwd: repoUnenrolled, session_id: 's-out', hook_event_name: 'SessionStart' }
  })
  expect(unEnrolledRes.stdout).toBe('')
  expect(unEnrolledRes.durationMs).toBeLessThan(2500)
  expect(existsSync(join(repoUnenrolled, '.code-awareness'))).toBe(false)

  // 2. Foreign clone must exit neutrally
  runPortableHook({
    helperPath,
    cwd: foreignClone,
    runAsNode,
    payload: { cwd: foreignClone, session_id: 's-foreign', hook_event_name: 'SessionStart' }
  })
  expect(existsSync(join(foreignClone, '.code-awareness'))).toBe(false)

  // 3. PostToolUse-first on cold enrolled worktree MUST NOT bootstrap!
  runPortableHook({
    helperPath,
    cwd: wtDetachedA,
    runAsNode,
    payload: { cwd: wtDetachedA, session_id: 's-cold-post', hook_event_name: 'PostToolUse', tool_use_id: 't0', tool_name: 'Bash' }
  })
  expect(existsSync(join(wtDetachedA, '.code-awareness'))).toBe(false)

  // 4. Divergent payload cwd vs process cwd MUST NOT bootstrap or write
  runPortableHook({
    helperPath,
    cwd: wtDetachedA,
    runAsNode,
    payload: { cwd: repoA, session_id: 's-divergent', hook_event_name: 'SessionStart' }
  })
  expect(existsSync(join(wtDetachedA, '.code-awareness'))).toBe(false)

  // 5. Cold-path SessionStart bootstrap on external detached worktree WITHOUT .codex/ or PS1!
  const coldStart = runPortableHook({
    helperPath,
    cwd: wtDetachedA,
    runAsNode,
    timing: true,
    payload: { cwd: wtDetachedA, session_id: 's-detached-1', hook_event_name: 'SessionStart', model: 'gpt-5' }
  })
  expect(coldStart.stdout).toBe('')
  expect(coldStart.durationMs).toBeLessThan(2500)
  const bindingDetachedPath = join(wtDetachedA, '.code-awareness', 'native-hooks', 'binding.json')
  const bindingDetached = readNativeBinding(bindingDetachedPath)
  expect(bindingDetached).toMatchObject({
    schema: 1,
    scope: 'USER',
    repositoryId: recA.id,
    configPath: enrolled.configPath,
    gitCommitTool: 'mcp__code_awareness__commit_git_changes'
  })
  // Capture window + SessionStart event itself must both be preserved
  expect(readdirSync(bindingDetached.spool).some(f => /^window-[a-f0-9]{64}\.json$/.test(f))).toBe(true)
  expect(readdirSync(bindingDetached.spool).filter(f => /^\d+\.json$/.test(f))).toHaveLength(1)

  // 6. Fast path on 2nd event (PreToolUse) & branch switch keeps identity & capture
  const fastPre = runPortableHook({
    helperPath,
    cwd: wtDetachedA,
    runAsNode,
    timing: true,
    payload: { cwd: wtDetachedA, session_id: 's-detached-1', hook_event_name: 'PreToolUse', tool_use_id: 'call-1', tool_name: 'Bash' }
  })
  expect(fastPre.durationMs).toBeLessThan(2500)
  expect(readdirSync(bindingDetached.spool).filter(f => /^\d+\.json$/.test(f))).toHaveLength(2)

  // Branch switch inside wtDetachedA keeps worktreeId & generation intact and continues capturing!
  runGit(wtDetachedA, noHooks, 'checkout', '-b', 'branch-after-detach')
  runPortableHook({
    helperPath,
    cwd: wtDetachedA,
    runAsNode,
    payload: { cwd: wtDetachedA, session_id: 's-detached-1', hook_event_name: 'PreToolUse', tool_use_id: 'call-2', tool_name: 'Bash' }
  })
  expect(readdirSync(bindingDetached.spool).filter(f => /^\d+\.json$/.test(f))).toHaveLength(3)

  // 7. Partial recovery on PreToolUse-first cold external worktree of Repo B (no fake SessionStart, no capture-window.json!)
  runPortableHook({
    helperPath,
    cwd: wtExternalB,
    runAsNode,
    payload: { cwd: wtExternalB, session_id: 's-partial-B', hook_event_name: 'PreToolUse', tool_use_id: 'call-b1', tool_name: 'Bash' }
  })
  const bindingB = readNativeBinding(join(wtExternalB, '.code-awareness', 'native-hooks', 'binding.json'))
  expect(bindingB.repositoryId).toBe(recB.id)
  expect(readdirSync(bindingB.spool).some(f => /^window-[a-f0-9]{64}\.json$/.test(f))).toBe(false)
  const spooledB = readdirSync(bindingB.spool).filter(f => /^\d+\.json$/.test(f))
  expect(spooledB).toHaveLength(1)
  expect(parseNativeEnvelope(readFileSync(join(bindingB.spool, spooledB[0]), 'utf8')).event).toBe('PreToolUse')

  // 8. Full SESSION -> INVOCATION -> COMMIT Git MCP causality with real GitService receipt!
  const gitSvc = new GitService()
  const ops = new GitOperationsService(wtDetachedA, gitSvc, {} as any)
  writeFileSync(join(wtDetachedA, 'feature.txt'), 'new feature line\n')
  runGit(wtDetachedA, noHooks, 'add', 'feature.txt')
  const state = await ops.getState()
  const operationId = 'op-u2-' + '1'.repeat(10)
  const commitToolArgs = {
    operationId,
    message: 'feat: real git mcp commit',
    expectedHead: state.head,
    expectedIndexRevision: state.indexRevision
  }

  runPortableHook({
    helperPath,
    cwd: wtDetachedA,
    runAsNode,
    payload: {
      cwd: wtDetachedA,
      session_id: 's-detached-1',
      hook_event_name: 'PreToolUse',
      tool_use_id: 'git-commit-call-1',
      tool_name: 'mcp__code_awareness__commit_git_changes',
      tool_input: commitToolArgs
    }
  })
  const commitToolResult = await executeGitOperationsTool(ops, 'commit_git_changes', commitToolArgs)
  expect(commitToolResult.isError).not.toBe(true)
  const commitParsed = JSON.parse((commitToolResult.content[0] as { text: string }).text)

  // Negative check: wrong alias must NOT attach git causality metadata
  runPortableHook({
    helperPath,
    cwd: wtDetachedA,
    runAsNode,
    payload: {
      cwd: wtDetachedA,
      session_id: 's-detached-1',
      hook_event_name: 'PreToolUse',
      tool_use_id: 'git-wrong-alias-call',
      tool_name: 'mcp__untrusted__commit_git_changes',
      tool_input: commitToolArgs
    }
  })

  // Codex PostToolUse using structuredContent (real Codex behavior)
  runPortableHook({
    helperPath,
    cwd: wtDetachedA,
    runAsNode,
    payload: {
      cwd: wtDetachedA,
      session_id: 's-detached-1',
      hook_event_name: 'PostToolUse',
      tool_use_id: 'git-commit-call-1',
      tool_name: 'mcp__code_awareness__commit_git_changes',
      tool_input: commitToolArgs,
      tool_response: { structuredContent: { ...commitParsed, replayed: false } }
    }
  })

  // Negative replayed PostToolUse MUST NOT correlate as authorship
  runPortableHook({
    helperPath,
    cwd: wtDetachedA,
    runAsNode,
    payload: {
      cwd: wtDetachedA,
      session_id: 's-detached-1',
      hook_event_name: 'PreToolUse',
      tool_use_id: 'git-replay-call',
      tool_name: 'mcp__code_awareness__commit_git_changes',
      tool_input: commitToolArgs
    }
  })
  runPortableHook({
    helperPath,
    cwd: wtDetachedA,
    runAsNode,
    payload: {
      cwd: wtDetachedA,
      session_id: 's-detached-1',
      hook_event_name: 'PostToolUse',
      tool_use_id: 'git-replay-call',
      tool_name: 'mcp__code_awareness__commit_git_changes',
      tool_input: commitToolArgs,
      tool_response: { structuredContent: { ...commitParsed, replayed: true } }
    }
  })

  runPortableHook({
    helperPath,
    cwd: wtDetachedA,
    runAsNode,
    payload: { cwd: wtDetachedA, session_id: 's-detached-1', hook_event_name: 'SessionEnd' }
  })

  // Ingest + correlate against SessionStore
  const sStoreA = new SessionStore(sessionStorePath(profile, recA.id), recA.id)
  try {
    const registryA = new GitWorktreeRegistry(repoA, gitSvc, { repositoryId: recA.id, isActive: () => true })
    await registryA.discover()
    const resolver = sessionTargetResolver(registryA, () => {})
    const gitInvocations: string[] = []
    const ingested = await ingestNativeHooks(sStoreA.registry, bindingDetached, resolver, () => {}, Date.now(), async event => {
      if (event.git && event.event === 'PostToolUse' && event.invocationId) gitInvocations.push(event.invocationId)
    })
    expect(ingested.ingested).toBeGreaterThanOrEqual(7)
    expect(gitInvocations).toHaveLength(2)
    const outcomes = await Promise.all(gitInvocations.map(id => correlateNativeGit(sStoreA.registry, bindingDetached, id, gitSvc, () => {})))
    expect(outcomes).toContain('VERIFIED')
    expect(outcomes).toContain('REPLAY_NOT_AUTHORSHIP')

    // Wrong-alias invocation created NO NATIVE_GIT_REQUEST
    const wrongInvocationHash = createHash('sha256').update(JSON.stringify(['codex', 's-detached-1', '', 'git-wrong-alias-call'])).digest('hex')
    expect(sStoreA.registry.directEvidence({ kind: 'EXECUTION', id: `native-invocation:${wrongInvocationHash}` }, 'NATIVE_GIT_REQUEST')).toEqual([])
  } finally {
    sStoreA.close()
  }

  // 9. Symlink / junction rejection
  const symlinkDir = join(base, 'wt-symlink-junction')
  symlinkSync(wtDetachedA, symlinkDir, process.platform === 'win32' ? 'junction' : 'dir')
  const countBeforeSymlink = readdirSync(bindingDetached.spool).filter(f => /^\d+\.json$/.test(f)).length
  runPortableHook({
    helperPath,
    cwd: symlinkDir,
    runAsNode,
    payload: { cwd: symlinkDir, session_id: 's-sym', hook_event_name: 'PreToolUse', tool_use_id: 'call-sym', tool_name: 'Bash' }
  })
  expect(readdirSync(bindingDetached.spool).filter(f => /^\d+\.json$/.test(f)).length).toBe(countBeforeSymlink)

  // 10. Worktree recreation / new generation updates binding cleanly while enrolled, then revocation blocks capture
  runGit(repoA, noHooks, 'worktree', 'remove', '--force', wtDetachedA)
  runGit(repoA, noHooks, 'worktree', 'add', '--detach', wtDetachedA)
  runPortableHook({
    helperPath,
    cwd: wtDetachedA,
    runAsNode,
    payload: { cwd: wtDetachedA, session_id: 's-recreated', hook_event_name: 'SessionStart' }
  })
  const recreatedBinding = readNativeBinding(bindingDetachedPath)
  expect(recreatedBinding.generation).not.toBe(bindingDetached.generation)
  expect(readdirSync(recreatedBinding.spool).filter(f => /^\d+\.json$/.test(f))).toHaveLength(1)

  revokeNativeHooks(profile, recA.id, 'codex', true)
  runPortableHook({
    helperPath,
    cwd: wtDetachedA,
    runAsNode,
    payload: { cwd: wtDetachedA, session_id: 's-after-revoke', hook_event_name: 'PreToolUse', tool_use_id: 'call-rev', tool_name: 'Bash' }
  })
  expect(readdirSync(recreatedBinding.spool).filter(f => /^\d+\.json$/.test(f))).toHaveLength(1)

  // Emit observable timing telemetry to stdout in test output
  console.log(JSON.stringify({
    u2TimingsMs: {
      unEnrolledNeutral: Math.round(unEnrolledRes.durationMs),
      coldBootstrapSessionStart: Math.round(coldStart.durationMs),
      fastPathPreToolUse: Math.round(fastPre.durationMs)
    }
  }))
}, 60_000)
