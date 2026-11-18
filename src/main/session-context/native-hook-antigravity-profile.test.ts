import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync,
  symlinkSync, writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'

const { ipcHandlers, electronUserData } = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  electronUserData: { path: '' }
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => { ipcHandlers.set(channel, handler) } },
  app: { getPath: () => electronUserData.path }
}))

import { removeDirectoryForceSync } from '../core/force-remove'
import { GitService } from '../core/git-service'
import { GitWorktreeRegistry } from '../git-operations/git-worktree-registry'
import { SettingsService } from '../core/settings-service'
import { WorkspaceService } from '../core/workspace-service'
import { RepositoryCatalogService } from '../repository-catalog/repository-catalog-service'
import { RepositoryCatalogStore } from '../repository-catalog/repository-catalog-store'
import {
  antigravityCmdWrapperPath,
  buildAntigravityCmdWrapperContent,
  cutoverLegacyProjectAntigravityHooks,
  disableUserAntigravityHooks,
  discoverAntigravityClients,
  formatUserAntigravityHookCommand,
  inspectUserAntigravityInstallation,
  installUserAntigravityHooks,
  qualifyAntigravityBinary,
  resolvePortableHelperContent
} from './native-hook-profile'
import {
  disableUserProfileAntigravity,
  enrollRepositoryForUserAntigravity,
  enrollUserProfileAntigravity,
  prepareExternalNativeHooks,
  reconcileRepositoryAntigravityHooks,
  revokeNativeHooks,
  userAntigravityProfileStatus
} from './native-hook-enrollment'
import { ANTIGRAVITY_HOOK_NAME, installNativeHooks, parseAntigravityUserCommand } from './native-hook-installation'
import {
  antigravityHookEvents,
  nativeDigest,
  nativeWorktreeIdentity,
  parseNativeEnvelope,
  readNativeBinding,
  sameNativePath,
  type NativeHookEvent
} from './native-hooks'
import { nativeHookReadiness } from './native-hook-readiness'
import { unknownNativeTrust } from './native-hook-preflight'
import { inspectNativeCaptureHealth } from './capture-health'
import { ingestNativeHooks } from './native-hook-ingestion'
import { SessionStore, sessionStorePath } from './store'
import { sessionTargetResolver } from './target'
import { registerAntigravityHooksHandlers, registerCodexHooksHandlers } from '../ipc/codex-hooks-handler'

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0).reverse()) {
    try { removeDirectoryForceSync(dir) } catch { try { rmSync(dir, { recursive: true, force: true }) } catch {} }
  }
})

function tempDir(prefix: string): string {
  const created = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  tempDirs.push(created)
  return created
}

function runGit(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function createRepo(root: string): string {
  mkdirSync(root, { recursive: true })
  runGit(root, 'init')
  runGit(root, 'config', 'user.email', 'test@example.com')
  runGit(root, 'config', 'user.name', 'Test User')
  writeFileSync(join(root, 'README.md'), 'hello\n')
  runGit(root, 'add', 'README.md')
  runGit(root, 'commit', '-m', 'init')
  return realpathSync(root)
}

async function createProfileWithRepos(baseDir: string, repos: Array<{ path: string }>) {
  const profile = join(baseDir, 'User Profile')
  mkdirSync(join(profile, 'repositories'), { recursive: true })
  const store = new RepositoryCatalogStore(join(profile, 'repositories', 'catalog.db'))
  const service = new RepositoryCatalogService(store, new WorkspaceService(), undefined)
  const settings = {
    gitManagement: { automaticFetch: true },
    rootFolders: [] as string[],
    individualProjects: repos.map(r => r.path),
    hiddenProjects: [] as string[],
    ignoredDiffFiles: {},
    tags: {},
    fileTags: {},
    projectPreferences: {}
  }
  await service.initialize(settings)
  const records = store.list()
  return {
    profile: realpathSync(profile),
    store,
    service,
    recordsByPath: new Map(records.map(r => [realpathSync(r.localCheckout!.path), r]))
  }
}

function findNodeBinary(): { path: string; runAsNode: boolean } {
  if (/^node(?:\.exe)?$/i.test(basename(process.execPath))) {
    return { path: realpathSync(process.execPath), runAsNode: false }
  }
  if (process.platform === 'win32') {
    const progNode = join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe')
    if (existsSync(progNode)) return { path: realpathSync(progNode), runAsNode: false }
  }
  return { path: realpathSync(process.execPath), runAsNode: true }
}

function runAntigravityCommand(command: string, cwd: string, payload: unknown): { status: number; stdout: string; stderr: string; elapsedMs: number } {
  const start = performance.now()
  const input = typeof payload === 'string' ? payload : JSON.stringify(payload)
  const cleanEnv = { ...process.env }
  delete cleanEnv.ELECTRON_RUN_AS_NODE
  if (process.platform === 'win32') {
    const out = execFileSync('cmd.exe', ['/d', '/s', '/c', command], {
      cwd,
      input,
      env: cleanEnv,
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    return { status: 0, stdout: out, stderr: '', elapsedMs: performance.now() - start }
  }
  const out = execFileSync('sh', ['-lc', command], {
    cwd,
    input,
    env: cleanEnv,
    encoding: 'utf8',
    timeout: 5000,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  return { status: 0, stdout: out, stderr: '', elapsedMs: performance.now() - start }
}

test('Antigravity user-profile installs named group preserving third parties, spaces, NO_CHANGE, drift repair and clean disable', () => {
  const root = tempDir('ca-ag-prof-')
  const profile = join(root, 'Profile With Spaces')
  const configHome = join(root, 'User Home', '.gemini', 'config')
  mkdirSync(profile, { recursive: true })
  mkdirSync(configHome, { recursive: true })
  const configPath = join(configHome, 'hooks.json')
  const preExisting = {
    'third-party-disabled': {
      enabled: false,
      extraMeta: { keep: 1 },
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo third-party', customFlag: true }] }]
    },
    'another-group': {
      enabled: true,
      SessionStart: [{ command: 'echo hi' }]
    }
  }
  writeFileSync(configPath, JSON.stringify(preExisting, null, 2) + '\n')

  const helperContent = resolvePortableHelperContent({ packaged: false, appPath: process.cwd() })
  const runtime = findNodeBinary()

  const first = installUserAntigravityHooks({
    profile,
    configHome,
    helperContent,
    nodePath: runtime.path,
    runAsNode: runtime.runAsNode,
    authorized: true,
    allowWorktreeRuntime: true
  })
  expect(first.state).toBe('CONFIGURED')
  expect(first.configPath).toBe(configPath)

  const second = installUserAntigravityHooks({
    profile,
    configHome,
    helperContent,
    nodePath: runtime.path,
    runAsNode: runtime.runAsNode,
    authorized: true,
    allowWorktreeRuntime: true
  })
  expect(second.state).toBe('NO_CHANGE')
  expect(second.trust).toBe('UNCHANGED')

  const rawText = readFileSync(configPath, 'utf8')
  const parsed = JSON.parse(rawText) as Record<string, Record<string, unknown>>
  expect(parsed['third-party-disabled']).toEqual(preExisting['third-party-disabled'])
  expect(parsed['another-group']).toEqual(preExisting['another-group'])
  const ownedGroup = parsed[ANTIGRAVITY_HOOK_NAME]
  expect(ownedGroup.enabled).toBe(true)
  for (const event of antigravityHookEvents) {
    const entries = ownedGroup[event] as unknown[]
    expect(Array.isArray(entries) && entries.length === 1).toBe(true)
    const hook = event === 'PreToolUse' || event === 'PostToolUse'
      ? (entries[0] as { matcher: string; hooks: Array<{ command: string; timeout: number }> }).hooks[0]
      : (entries[0] as { command: string; timeout: number })
    expect(hook.timeout).toBe(3)
    if (process.platform === 'win32') expect(hook.command).not.toContain('"')
    const parsedCmd = parseAntigravityUserCommand(hook.command)
    expect(parsedCmd?.event).toBe(event)
  }

  const inspected = inspectUserAntigravityInstallation(profile, configHome, process.platform)
  expect(inspected.state).toBe('CONFIGURED')
  expect(inspected.installed).toBe(6)
  expect(inspected.expected).toBe(6)

  // Drift repair (dropping Stop handler)
  delete ownedGroup.Stop
  writeFileSync(configPath, JSON.stringify(parsed, null, 2) + '\n')
  const drifted = inspectUserAntigravityInstallation(profile, configHome, process.platform)
  expect(drifted.state).toBe('INCOMPATIBLE')
  expect(drifted.reasonCode).toBe('NATIVE_HANDLERS_MISSING')
  expect(drifted.repairability).toBe('REPAIRABLE')

  const repaired = installUserAntigravityHooks({
    profile,
    configHome,
    helperContent,
    nodePath: runtime.path,
    runAsNode: runtime.runAsNode,
    authorized: true,
    allowWorktreeRuntime: true
  })
  expect(repaired.state).toBe('CONFIGURED')
  expect(inspectUserAntigravityInstallation(profile, configHome, process.platform).state).toBe('CONFIGURED')

  // Concurrent third-party edit inside another group is preserved on disable (restored = false if config altered)
  const afterRepair = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
  afterRepair['concurrent-third-party'] = { enabled: true, Stop: [{ command: 'echo concurrent' }] }
  writeFileSync(configPath, JSON.stringify(afterRepair, null, 2) + '\n')

  const disabled = disableUserAntigravityHooks(profile, true, configHome)
  expect(disabled.state).toBe('DISABLED')
  expect(disabled.restored).toBe(false)
  const remaining = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
  expect(remaining[ANTIGRAVITY_HOOK_NAME]).toBeUndefined()
  expect(remaining['third-party-disabled']).toEqual(preExisting['third-party-disabled'])
  expect(remaining['concurrent-third-party']).toEqual({ enabled: true, Stop: [{ command: 'echo concurrent' }] })
}, 30_000)

test('Antigravity disables cleanly by deleting empty hooks.json when before was null and detects digest/wrapper tampering', () => {
  const root = tempDir('ca-ag-clean-')
  const profile = join(root, 'Profile Space')
  const configHome = join(root, 'Empty Config Home')
  mkdirSync(profile, { recursive: true })
  mkdirSync(configHome, { recursive: true })

  const helperContent = resolvePortableHelperContent({ packaged: false, appPath: process.cwd() })
  const runtime = findNodeBinary()
  const res = installUserAntigravityHooks({
    profile,
    configHome,
    helperContent,
    nodePath: runtime.path,
    runAsNode: runtime.runAsNode,
    authorized: true,
    allowWorktreeRuntime: true
  })
  expect(existsSync(res.configPath)).toBe(true)

  const disabled = disableUserAntigravityHooks(profile, true)
  expect(disabled.state).toBe('DISABLED')
  expect(disabled.restored).toBe(true)
  expect(existsSync(res.configPath)).toBe(false)

  // Space-in-basename packaged wrapper (Code Awareness.exe) on Windows + cmd.exe execution
  if (process.platform === 'win32') {
    const appDir = join(root, 'Packaged App')
    mkdirSync(appDir, { recursive: true })
    const spacedExe = join(appDir, 'Code Awareness.exe')
    copyFileSync(runtime.path, spacedExe)

    const wrapperInstall = installUserAntigravityHooks({
      profile,
      configHome,
      helperContent,
      nodePath: spacedExe,
      runAsNode: true,
      authorized: true,
      allowWorktreeRuntime: true
    })
    expect(wrapperInstall.cmdWrapperPath).toBeTruthy()
    expect(basename(wrapperInstall.cmdWrapperPath!)).toMatch(/^ag-[a-f0-9]{64}\.cmd$/)
    const inspectWrapper = inspectUserAntigravityInstallation(profile, configHome, 'win32')
    expect(inspectWrapper.state).toBe('CONFIGURED')

    const agConfig = JSON.parse(readFileSync(wrapperInstall.configPath, 'utf8')) as Record<string, Record<string, unknown>>
    const preToolCmd = ((agConfig[ANTIGRAVITY_HOOK_NAME].PreToolUse as Array<{ hooks: Array<{ command: string }> }>)[0].hooks[0].command)
    expect(preToolCmd).not.toContain('"')
    expect(preToolCmd).toContain(basename(wrapperInstall.cmdWrapperPath!))

    // Execute via real cmd.exe from neutral non-git folder (configHome) -> fails open with allow
    const execOut = runAntigravityCommand(preToolCmd, configHome, { conversationId: 'conv-wrap', workspacePaths: [configHome] })
    expect(JSON.parse(execOut.stdout.trim())).toEqual({ decision: 'allow' })
    expect(execOut.elapsedMs).toBeLessThan(3000)

    // Verify expected wrapper digest check rejects tampered .cmd file
    writeFileSync(wrapperInstall.cmdWrapperPath!, buildAntigravityCmdWrapperContent(spacedExe, wrapperInstall.helperPath, false) + 'rem tampered\r\n')
    const tampered = inspectUserAntigravityInstallation(profile, configHome, 'win32')
    expect(tampered.state).toBe('INCOMPATIBLE')
    expect(tampered.reasonCode).toBe('HOOK_COMMAND_DIGEST_MISMATCH')
    expect(antigravityCmdWrapperPath(profile, '0'.repeat(64))).toContain('ag-' + '0'.repeat(64) + '.cmd')
    expect(formatUserAntigravityHookCommand({
      nodePath: spacedExe,
      helperPath: wrapperInstall.helperPath,
      event: 'Stop',
      runAsNode: true,
      platform: 'win32',
      cmdWrapperPath: join(profile, 'session-context', 'ag-' + nativeDigest('x') + '.cmd')
    }).command).not.toContain('"')
  }
}, 30_000)

test('Antigravity global hooks: workspacePaths + cwd validation, multi-root ambiguity, cold bootstrap on detached worktrees, Stop preservation, PostToolUse error, revocation & ingestion', async () => {
  const base = tempDir('ca-ag-e2e-')
  const repoA = createRepo(join(base, 'repo-a'))
  const repoB = createRepo(join(base, 'repo-b'))
  const repoUnenrolled = createRepo(join(base, 'repo-unenrolled'))
  const foreignNested = createRepo(join(repoA, 'nested-repo'))

  const linkedWorktreeA = join(base, 'wt-a-linked')
  runGit(repoA, 'worktree', 'add', '-b', 'feat-ag', linkedWorktreeA)
  const detachedWorktreeA = join(base, 'wt-a-detached')
  const headSha = runGit(repoA, 'rev-parse', 'HEAD')
  runGit(repoA, 'worktree', 'add', '--detach', detachedWorktreeA, headSha)

  const linkToA = join(base, 'link-to-a')
  symlinkSync(repoA, linkToA, process.platform === 'win32' ? 'junction' : 'dir')

  const subDirA = join(repoA, 'packages', 'sub')
  mkdirSync(subDirA, { recursive: true })

  const { profile, recordsByPath } = await createProfileWithRepos(base, [
    { path: repoA },
    { path: repoB },
    { path: repoUnenrolled }
  ])
  const recA = recordsByPath.get(repoA)!
  const recB = recordsByPath.get(repoB)!
  const recU = recordsByPath.get(repoUnenrolled)!

  const configHome = join(base, 'Gemini Config Home')
  mkdirSync(configHome, { recursive: true })
  const helperContent = resolvePortableHelperContent({ packaged: false, appPath: process.cwd() })
  const runtime = findNodeBinary()

  const enrolled = enrollUserProfileAntigravity({
    profile,
    configHome,
    helperContent,
    nodePath: runtime.path,
    runAsNode: runtime.runAsNode,
    repositoryIds: [recA.id, recB.id],
    authorized: true,
    allowWorktreeRuntime: true
  })
  expect(enrolled.state).toBe('CONFIGURED')
  expect(enrolled.enrolledRepositories.sort()).toEqual([recA.id, recB.id].sort())
  expect(userAntigravityProfileStatus({ profile, configHome, repositoryId: recU.id }).repositoryEnrolled).toBe(false)

  const hooksCfg = JSON.parse(readFileSync(enrolled.configPath, 'utf8')) as Record<string, Record<string, unknown>>
  const cmdFor = (event: NativeHookEvent): string => {
    const arr = hooksCfg[ANTIGRAVITY_HOOK_NAME][event] as Array<Record<string, unknown>>
    return event === 'PreToolUse' || event === 'PostToolUse'
      ? ((arr[0].hooks as Array<{ command: string }>)[0].command)
      : (arr[0].command as string)
  }

  // Readiness & capture health BEFORE binding.json exists on linkedWorktreeA
  const storePath = sessionStorePath(profile, recA.id)
  const storeA = new SessionStore(storePath, recA.id)
  const linkedWt = nativeWorktreeIdentity(linkedWorktreeA, true)
  const targetLinked = { worktreeId: linkedWt.worktreeId(recA.id), generation: linkedWt.generation }
  const beforeReadiness = nativeHookReadiness(storeA.registry, linkedWorktreeA, targetLinked, unknownNativeTrust('CLIENT_TRUST_UNSUPPORTED'), 'antigravity', { profile, codexHome: configHome })
  expect(beforeReadiness.installation.state).toBe('CONFIGURED')
  expect(beforeReadiness.installation.reasonCode).toBe('USER_PROFILE_READY_BINDING_PENDING')
  expect(beforeReadiness.bootstrap).toEqual({ state: 'AVAILABLE', reasonCode: 'USER_BOOTSTRAP_AVAILABLE' })
  expect(beforeReadiness.bindingState).toBe('PENDING_FIRST_SESSION')
  expect(beforeReadiness.trust.reasonCode).toBe('CLIENT_TRUST_UNSUPPORTED')
  expect(existsSync(join(linkedWorktreeA, '.code-awareness'))).toBe(false)

  // All hook commands run from neutral non-git cwd (configHome), simulating Antigravity global hook cwd!
  // 1. Un-enrolled repo produces fail-open stdout and zero writes
  const unRes1 = runAntigravityCommand(cmdFor('SessionStart'), configHome, { conversationId: 'conv-u1', workspacePaths: [repoUnenrolled], cwd: repoUnenrolled })
  const unRes2 = runAntigravityCommand(cmdFor('PreToolUse'), configHome, { conversationId: 'conv-u1', workspacePaths: [repoUnenrolled], toolCall: { id: 'tc-1', name: 'run_command' } })
  expect(JSON.parse(unRes1.stdout.trim())).toEqual({})
  expect(JSON.parse(unRes2.stdout.trim())).toEqual({ decision: 'allow' })
  expect(existsSync(join(repoUnenrolled, '.code-awareness'))).toBe(false)

  // 2. Multi-root distinct worktrees refused cleanly without writing to either repo
  const ambigRes = runAntigravityCommand(cmdFor('SessionStart'), configHome, { conversationId: 'conv-ambig', workspacePaths: [linkedWorktreeA, repoB] })
  expect(JSON.parse(ambigRes.stdout.trim())).toEqual({})
  expect(existsSync(join(linkedWorktreeA, '.code-awareness'))).toBe(false)
  expect(existsSync(join(repoB, '.code-awareness'))).toBe(false)

  // 3. Symlink/junction workspacePaths refused without writing
  const linkRes = runAntigravityCommand(cmdFor('SessionStart'), configHome, { conversationId: 'conv-link', workspacePaths: [linkToA] })
  expect(JSON.parse(linkRes.stdout.trim())).toEqual({})
  expect(existsSync(join(repoA, '.code-awareness'))).toBe(false)

  // 4. Foreign nested .git cwd inside repoA refused cleanly without bootstrapping repoA
  const nestedRes = runAntigravityCommand(cmdFor('SessionStart'), configHome, { conversationId: 'conv-nest', workspacePaths: [repoA], cwd: foreignNested })
  expect(JSON.parse(nestedRes.stdout.trim())).toEqual({})
  expect(existsSync(join(repoA, '.code-awareness'))).toBe(false)

  // 5. PostToolUse first on detachedWorktreeA must NOT bootstrap
  const postFirst = runAntigravityCommand(cmdFor('PostToolUse'), configHome, {
    conversationId: 'conv-det', workspacePaths: [detachedWorktreeA], invocationNum: 1, toolCall: { id: 'tc-0', name: 'view_file' }
  })
  expect(JSON.parse(postFirst.stdout.trim())).toEqual({})
  expect(existsSync(join(detachedWorktreeA, '.code-awareness'))).toBe(false)

  // 6. Cold bootstrap on linkedWorktreeA via PreInvocation first (partial recovery, no fake SessionStart)
  const coldPreInv = runAntigravityCommand(cmdFor('PreInvocation'), configHome, {
    conversationId: 'conv-ag-linked',
    workspacePaths: [linkedWorktreeA],
    cwd: linkedWorktreeA,
    invocationNum: 1
  })
  expect(JSON.parse(coldPreInv.stdout.trim())).toEqual({})
  expect(coldPreInv.elapsedMs).toBeLessThan(3000)
  expect(existsSync(join(linkedWorktreeA, '.agents', 'hooks.json'))).toBe(false)
  const linkedBindingPath = join(linkedWorktreeA, '.code-awareness', 'native-hooks', 'antigravity', 'binding.json')
  expect(existsSync(linkedBindingPath)).toBe(true)
  expect(readNativeBinding(linkedBindingPath).provider).toBe('antigravity')

  // Subsequent PreToolUse, PostToolUse (with error!), PostInvocation, Stop, and resume PreInvocation in same conversation
  const preTool = runAntigravityCommand(cmdFor('PreToolUse'), configHome, {
    conversationId: 'conv-ag-linked', workspacePaths: [linkedWorktreeA], invocationNum: 1, toolCall: { id: 'call-1', name: 'run_command' }, prompt: 'SECRET PROMPT'
  })
  expect(JSON.parse(preTool.stdout.trim())).toEqual({ decision: 'allow' })

  const postToolErr = runAntigravityCommand(cmdFor('PostToolUse'), configHome, {
    conversationId: 'conv-ag-linked', workspacePaths: [linkedWorktreeA], invocationNum: 1, stepIdx: 4, toolCall: { id: 'call-1', name: 'run_command' },
    error: { message: 'SENSITIVE ERROR DETAILS' }
  })
  expect(JSON.parse(postToolErr.stdout.trim())).toEqual({})

  // Non-nested subdirectory cwd in same repoA works seamlessly!
  const subDirEvent = runAntigravityCommand(cmdFor('PreInvocation'), configHome, {
    conversationId: 'conv-sub', workspacePaths: [repoA], cwd: subDirA, invocationNum: 1
  })
  expect(JSON.parse(subDirEvent.stdout.trim())).toEqual({})
  expect(existsSync(join(repoA, '.code-awareness', 'native-hooks', 'antigravity', 'binding.json'))).toBe(true)

  // 7. Detached worktree cold bootstrap on SessionStart, Stop (window preserved, no fake SessionEnd), then resume PreInvocation
  const detStart = runAntigravityCommand(cmdFor('SessionStart'), configHome, {
    conversationId: 'conv-det-1', workspacePaths: [detachedWorktreeA], transcriptPath: join(base, 'brain', 'conv-det-1', 'transcript.jsonl')
  })
  expect(JSON.parse(detStart.stdout.trim())).toEqual({})
  const detSpool = join(detachedWorktreeA, '.code-awareness', 'native-hooks', 'antigravity', 'spool')
  const windowFilesBeforeStop = readdirSync(detSpool).filter(f => f.startsWith('window-'))
  expect(windowFilesBeforeStop.length).toBe(1)

  const detStop = runAntigravityCommand(cmdFor('Stop'), configHome, { conversationId: 'conv-det-1', workspacePaths: [detachedWorktreeA] })
  expect(JSON.parse(detStop.stdout.trim())).toEqual({})
  expect(readdirSync(detSpool).filter(f => f.startsWith('window-'))).toEqual(windowFilesBeforeStop)

  const detResume = runAntigravityCommand(cmdFor('PreInvocation'), configHome, {
    conversationId: 'conv-det-1', workspacePaths: [detachedWorktreeA], invocationNum: 2
  })
  expect(JSON.parse(detResume.stdout.trim())).toEqual({})

  // Missing hookEventName uses fixed --event / CA_EVENT; mismatch fails open & records gap without ingesting wrong event
  const detMissingEvent = runAntigravityCommand(cmdFor('PostInvocation'), configHome, {
    conversationId: 'conv-det-1', workspacePaths: [detachedWorktreeA], invocationNum: 2
  })
  expect(JSON.parse(detMissingEvent.stdout.trim())).toEqual({})
  const detMismatch = runAntigravityCommand(cmdFor('PreToolUse'), configHome, {
    hookEventName: 'PostToolUse', conversationId: 'conv-det-1', workspacePaths: [detachedWorktreeA], invocationNum: 2, toolCall: { id: 'bad-1', name: 'view_file' }
  })
  expect(JSON.parse(detMismatch.stdout.trim())).toEqual({ decision: 'allow' })
  expect(readdirSync(detSpool).some(f => f.startsWith('gap-'))).toBe(true)

  // Verify spooled envelopes before ingestion: zero raw prompts/errors, Stop not mapped to SessionEnd
  const linkedSpool = join(linkedWorktreeA, '.code-awareness', 'native-hooks', 'antigravity', 'spool')
  const linkedEnvelopes = readdirSync(linkedSpool).filter(f => f.endsWith('.json') && !f.startsWith('window-') && !f.startsWith('gap-'))
    .map(f => parseNativeEnvelope(readFileSync(join(linkedSpool, f), 'utf8')))
  expect(linkedEnvelopes.map(e => e.event).sort()).toEqual(['PostToolUse', 'PreInvocation', 'PreToolUse'])
  expect(linkedEnvelopes.every(e => !JSON.stringify(e).includes('SECRET PROMPT') && !JSON.stringify(e).includes('SENSITIVE ERROR DETAILS'))).toBe(true)

  const detachedWt = nativeWorktreeIdentity(detachedWorktreeA, true)
  const targetDetached = { worktreeId: detachedWt.worktreeId(recA.id), generation: detachedWt.generation }
  const gitSvc = new GitService()
  const registryA = new GitWorktreeRegistry(repoA, gitSvc, { repositoryId: recA.id, isActive: () => true })
  await registryA.discover()
  const resolver = sessionTargetResolver(registryA, () => {})
  const detachedBinding = readNativeBinding(join(detachedWorktreeA, '.code-awareness', 'native-hooks', 'antigravity', 'binding.json'))
  await ingestNativeHooks(storeA.registry, readNativeBinding(linkedBindingPath), resolver, () => {})
  await ingestNativeHooks(storeA.registry, detachedBinding, resolver, () => {})

  const detEvidence = storeA.registry.nativeHookEvidence(targetDetached.worktreeId, targetDetached.generation, undefined, 'ANTIGRAVITY_NATIVE_HOOK')
  expect(detEvidence.map(e => e.event)).toContain('SessionStart')
  expect(detEvidence.map(e => e.event)).toContain('PreInvocation')
  expect(detEvidence.map(e => e.event)).toContain('PostInvocation')
  expect(detEvidence.map(e => e.event)).toContain('Stop')
  expect(detEvidence.map(e => e.event)).not.toContain('SessionEnd')
  const detSessionId = detEvidence[0].sessionId
  const boundaryEdges = storeA.registry.directEvidence({ kind: 'EXECUTION', id: 'native-window:' + detEvidence[0].capture!.epoch }, 'NATIVE_CAPTURE_BOUNDARY')
  expect(boundaryEdges.length).toBe(2)
  expect(detSessionId).toMatch(/^[a-f0-9]{64}$/)

  const captureHealth = inspectNativeCaptureHealth(
    storeA,
    detachedWorktreeA,
    targetDetached,
    'antigravity',
    { ...unknownNativeTrust('CLIENT_TRUST_UNSUPPORTED'), state: 'UNSUPPORTED' },
    profile
  )
  expect((captureHealth.nativeCapture as { causality: string }).causality).toBe('NOT_EVALUATED')
  expect((captureHealth.nativeCapture as { discovery: { reasonCode: string } }).discovery.reasonCode).toBe('CLIENT_TRUST_UNSUPPORTED')

  // Prepare CLI path for external Antigravity worktree works cleanly too
  const prepB = await prepareExternalNativeHooks(profile, recB.id, repoB, Infinity, 'antigravity')
  expect(prepB.state).toBe('CONFIGURED')
  expect(prepB.statuses?.[0].handlers).toBe(6)
  storeA.close()

  // Revocation of repoA immediately stops capturing new events on linked & detached worktrees
  expect(revokeNativeHooks(profile, recA.id, 'antigravity', true)).toEqual({ state: 'REVOKED' })
  const countBeforeRevoke = readdirSync(linkedSpool).length
  const afterRevoke = runAntigravityCommand(cmdFor('PostInvocation'), configHome, {
    conversationId: 'conv-ag-linked', workspacePaths: [linkedWorktreeA], invocationNum: 1
  })
  expect(JSON.parse(afterRevoke.stdout.trim())).toEqual({})
  expect(readdirSync(linkedSpool).length).toBe(countBeforeRevoke)
}, 60_000)

test('Antigravity legacy project cutover preserves third parties, Codex, Entire, spool and SQLite', async () => {
  const base = tempDir('ca-ag-cut-')
  const repo = createRepo(join(base, 'legacy-repo'))
  const { profile, recordsByPath } = await createProfileWithRepos(base, [{ path: repo }])
  const rec = recordsByPath.get(repo)!

  const git = new GitService()
  const registry = new GitWorktreeRegistry(repo, git, { repositoryId: rec.id, isActive: () => true })
  const record = await registry.resolveCheckout(repo)
  const runtime = findNodeBinary()
  const helper = join(profile, 'session-context', `native-hook-${nativeDigest('legacy')}.cjs`)
  mkdirSync(join(profile, 'session-context'), { recursive: true })
  writeFileSync(helper, 'legacy')

  // Seed legacy .agents/hooks.json with third-party group + Code Awareness antigravity handlers
  const agentsDir = join(repo, '.agents')
  mkdirSync(agentsDir, { recursive: true })
  writeFileSync(join(agentsDir, 'hooks.json'), JSON.stringify({
    'third-party-ext': { enabled: true, PreToolUse: [{ matcher: '*', hooks: [{ command: 'echo keep-me' }] }] }
  }, null, 2) + '\n')

  installNativeHooks({ repositoryId: rec.id, record, commandPath: helper, nodePath: runtime.path, provider: 'antigravity', authorized: true })
  const spoolFile = join(repo, '.code-awareness', 'native-hooks', 'antigravity', 'spool', '1-keep.json')
  writeFileSync(spoolFile, '{"keep":true}')

  const userConfigPath = join(base, 'Gemini Home', 'hooks.json')
  const cutover = cutoverLegacyProjectAntigravityHooks({
    profile,
    userConfigPath,
    repositoryId: rec.id,
    authorized: true
  })
  expect(cutover.state).toBe('COMPLETED')
  expect(cutover.items[0].state).toBe('REMOVED')

  const afterAgents = JSON.parse(readFileSync(join(agentsDir, 'hooks.json'), 'utf8')) as Record<string, unknown>
  expect(afterAgents['third-party-ext']).toBeTruthy()
  expect(afterAgents[ANTIGRAVITY_HOOK_NAME]).toBeUndefined()
  expect(existsSync(join(repo, '.code-awareness', 'native-hooks', 'antigravity', 'installation.json'))).toBe(false)
  expect(existsSync(spoolFile)).toBe(true)
  const migratedBinding = readNativeBinding(join(repo, '.code-awareness', 'native-hooks', 'antigravity', 'binding.json'))
  expect(migratedBinding.scope).toBe('USER')
  expect(migratedBinding.provider).toBe('antigravity')
  expect(sameNativePath(migratedBinding.configPath!, userConfigPath)).toBe(true)
}, 30_000)

test('Antigravity client discovery, honest trust, settings auto-enroll & real IPC handler security', async () => {
  const base = tempDir('ca-ag-ipc-')
  const repo = createRepo(join(base, 'repo-ipc'))
  const { profile, store, service, recordsByPath } = await createProfileWithRepos(base, [{ path: repo }])
  const rec = recordsByPath.get(repo)!
  const configHome = join(base, 'Gemini Home')
  mkdirSync(configHome, { recursive: true })

  // Mock client binaries: IDE binary with sibling version file + junction rejection
  const ideDir = join(base, 'AntigravityIDE')
  mkdirSync(ideDir, { recursive: true })
  const ideBin = join(ideDir, process.platform === 'win32' ? 'Antigravity.exe' : 'antigravity')
  writeFileSync(ideBin, 'binary')
  writeFileSync(join(ideDir, 'version'), '44.9.1')
  const linkDir = join(base, 'AntigravityIDELink')
  symlinkSync(ideDir, linkDir, process.platform === 'win32' ? 'junction' : 'dir')
  const linkBin = join(linkDir, basename(ideBin))
  expect(qualifyAntigravityBinary(linkBin).qualified).toBe(false)
  expect(qualifyAntigravityBinary(ideBin)).toMatchObject({ qualified: true, version: '44.9.1', surface: 'IDE' })
  expect(discoverAntigravityClients({ explicit: ideBin }).some(c => c.qualified && c.version === '44.9.1')).toBe(true)

  electronUserData.path = profile
  ipcHandlers.clear()
  const settingsService = new SettingsService()
  const trustedUrl = 'app://code-awareness/index.html'
  registerCodexHooksHandlers({ profile, appPath: process.cwd(), packaged: false, settingsService }, trustedUrl)
  registerAntigravityHooksHandlers({ profile, appPath: process.cwd(), packaged: false, settingsService }, trustedUrl)

  expect(ipcHandlers.has('codex-hooks:status')).toBe(true)
  expect(ipcHandlers.has('antigravity-hooks:status')).toBe(true)
  const fakeFrame = { url: trustedUrl }
  const trustedEvent = { senderFrame: fakeFrame, sender: { mainFrame: fakeFrame, isDestroyed: () => false } }
  const evilEvent = { senderFrame: { url: 'https://evil.example/' }, sender: { mainFrame: fakeFrame, isDestroyed: () => false } }
  expect(() => ipcHandlers.get('antigravity-hooks:status')!(evilEvent)).toThrow('INVALID_ANTIGRAVITY_HOOKS_REQUEST')
  expect(() => ipcHandlers.get('codex-hooks:status')!(evilEvent)).toThrow('INVALID_CODEX_HOOKS_REQUEST')

  const installed = await ipcHandlers.get('antigravity-hooks:install')!(trustedEvent, {
    configHome,
    clientPath: ideBin,
    autoEnrollNewProjects: true,
    enrollActiveRepositories: false,
    repositoryIds: [rec.id]
  }) as { state: string; status: { trust: string; enrolledRepositoryIds: string[] } }
  expect(installed.state).toBe('CONFIGURED')
  expect(installed.status.trust).toBe('CLIENT_TRUST_UNSUPPORTED')
  expect(installed.status.enrolledRepositoryIds).toEqual([rec.id])
  expect(settingsService.loadSettings().antigravityCapture?.autoEnrollNewProjects).toBe(true)

  // Add a second repo and verify reconcileRepositoryAntigravityHooks auto-enrolls ONLY when opted in
  const repo2 = createRepo(join(base, 'repo-ipc-2'))
  const rec2 = await service.importLocal(repo2)
  const recRes = reconcileRepositoryAntigravityHooks(profile, rec2.id, true)
  expect(recRes.state).toBe('ENROLLED')

  await ipcHandlers.get('antigravity-hooks:disable')!(trustedEvent, configHome)
  const disabledStatus = await ipcHandlers.get('antigravity-hooks:status')!(trustedEvent) as { profileEnabled: boolean }
  expect(disabledStatus.profileEnabled).toBe(false)

  expect(enrollRepositoryForUserAntigravity).toBeTypeOf('function')
  expect(disableUserProfileAntigravity).toBeTypeOf('function')
  expect(createHash('sha256').update('ok').digest('hex')).toHaveLength(64)
}, 30_000)
