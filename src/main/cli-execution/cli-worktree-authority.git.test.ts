import './cli-native-test-setup'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { GitService } from '../core/git-service'
import { SettingsService } from '../core/settings-service'
import { GitWorktreeRegistry, type WorktreeRecord } from '../git-operations/git-worktree-registry'
import { createCliProjectAuthority, createCliProjectRuntimeAuthority } from './cli-project-authority'
import { resolveCliWorktree } from './cli-worktree-authority'
import { CliExecutionService } from './cli-execution-service'
import { CliTrustPolicy } from './cli-trust-policy'
import { executeCliTool } from './cli-execution-mcp'
import type { CliWorktreeSelector } from './cli-execution-types'
import { textContent } from '../mcp/mcp-test-content'
import type { CliPolicy } from '../../shared/types/cli-policy-types'
import { CLI_EXECUTION_TOOLS } from './cli-execution-mcp'

const localProfile = vi.hoisted(() => ({ path: '' }))
vi.mock('electron', () => ({ app: { getPath: () => localProfile.path } }))

function git(root: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${join(root, 'no-hooks')}`, '-C', root, ...args],
    { encoding: 'utf8', windowsHide: true, timeout: 10000 }).trim()
}
async function until<T>(read: () => T, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 12000
  while (Date.now() < deadline) {
    const value = read()
    if (ready(value)) return value
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('TEST_TIMEOUT')
}

describe('CLI general execution in discovered Worktrees', () => {
  let directory: string, main: string, sibling: string, other: string
  let registry: GitWorktreeRegistry, selected: WorktreeRecord, service: CliExecutionService
  let selection: { revision: number; project: { id: string; path: string } }
  let policy: CliPolicy
  const gitService = new GitService()
  const approval = vi.fn(async (_request: unknown) => true)
  const selector = (): CliWorktreeSelector => ({ worktreeId: selected.worktreeId, generation: selected.generation })
  const complete = (operationId: string) => until(() => service.get({ operationId }), value => value.phase === 'TERMINAL')

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'ca-cli-worktree-'))
    localProfile.path = join(directory, 'profile')
    mkdirSync(localProfile.path, { recursive: true })
    main = join(directory, 'main'); sibling = join(directory, 'sibling'); other = join(directory, 'other')
    execFileSync('git', ['init', '-q', main], { windowsHide: true, timeout: 10000 })
    git(main, 'config', 'user.name', 'CLI Worktree Fixture')
    git(main, 'config', 'user.email', 'cli@example.test')
    writeFileSync(join(main, 'tracked'), 'baseline')
    git(main, 'add', 'tracked'); git(main, 'commit', '-qm', 'baseline')
    git(main, 'worktree', 'add', '-qb', 'sibling', sibling)
    git(main, 'worktree', 'add', '-qb', 'other', other)
    selection = { revision: 1, project: { id: 'repository', path: main } }
    registry = new GitWorktreeRegistry(main, gitService, { repositoryId: 'repository', isActive: () => selection.revision === 1 })
    selected = (await registry.discover()).worktrees.find(tree => tree.branch === 'sibling')!
    approval.mockReset().mockResolvedValue(true)
    policy = { mode: 'SUPERVISED', revision: 'initial', rule: 'native-command-consent' }
    service = new CliExecutionService({
      repoRoot: main, repositoryId: 'repository', enabledByDefault: true, approvalHandler: approval,
      getPolicy: () => policy,
      getFingerprint: createCliProjectAuthority({ selection, getSelection: () => selection,
        findRepository: () => ({ id: 'repository', localCheckout: { path: main, availability: 'AVAILABLE', gitState: 'GIT' } }),
        captureGitIdentity: async path => { const snapshot = await gitService.captureWorktreeReadSnapshot(path); return { head: snapshot.head, branch: snapshot.branch } }
      }),
      resolveWorktree: target => resolveCliWorktree(registry, gitService, target)
    })
  }, 20000)
  afterEach(async () => {
    await service?.shutdown()
    vi.restoreAllMocks()
    if (directory) {
      try { rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch {}
    }
  })

  it('executes in either selected sibling, preserves the active project and retains the unitary fallback', async () => {
    const head = git(main, 'rev-parse', 'HEAD')
    for (const branch of ['sibling', 'other', null]) {
      const tree = branch ? (await registry.discover()).worktrees.find(record => record.branch === branch)! : undefined
      const target = tree ? { worktreeId: tree.worktreeId, generation: tree.generation } : undefined
      const prepared = await executeCliTool(service, 'prepare_cli_execution', {
        executable: process.execPath, args: ['-e', 'console.log(process.cwd())'], ...(target ? { worktree: target } : {})
      })
      expect(prepared.isError).not.toBe(true)
      const proposal = JSON.parse(textContent(prepared.content[0]))
      expect(proposal.worktree?.worktreeId).toBe(tree?.worktreeId)
      const operationId = branch ?? 'active'
      service.start({ proposalId: proposal.proposalId, operationId })
      const result = await complete(operationId)
      expect(result.status, JSON.stringify(result)).toBe('SUCCEEDED')
      expect(realpathSync(result.stdout.trim())).toBe(realpathSync(tree?.path ?? main))
      expect(result.treeObservation).toEqual({ activeProcesses: 0, handlesClosed: true })
      expect(result.worktree?.head).toBe(tree?.head)
    }
    expect(selection).toEqual({ revision: 1, project: { id: 'repository', path: main } })
    expect(git(main, 'rev-parse', 'HEAD')).toBe(head)
    expect(git(main, 'status', '--porcelain')).toBe('')
  }, 30000)

  it('permits general commands and an explicitly approved write only in the selected fixture', async () => {
    const proposal = await service.prepare({ worktree: selector(), executable: process.execPath,
      args: ['-e', "require('fs').writeFileSync('authorized-effect', 'exact command'); console.log('done')"] })
    service.start({ proposalId: proposal.proposalId, operationId: 'write' })
    expect((await complete('write')).status).toBe('SUCCEEDED')
    expect(readFileSync(join(sibling, 'authorized-effect'), 'utf8')).toBe('exact command')
    expect(existsSync(join(main, 'authorized-effect'))).toBe(false)
    expect(existsSync(join(other, 'authorized-effect'))).toBe(false)
    expect(approval).toHaveBeenCalledWith(expect.objectContaining({
      repositoryId: 'repository', repositoryDirectory: realpathSync(sibling), activeCheckoutDirectory: realpathSync(main),
      worktree: expect.objectContaining({ ...selector(), head: selected.head }), command: proposal.command
    }))
    expect(existsSync(join(main, '.git', 'code-awareness-worktree-ownership'))).toBe(false)
  }, 20000)

  it('composes active-checkout autonomy, sibling consent and active-checkout batches on one runner', async () => {
    policy = { mode: 'AUTONOMOUS_TRUSTED', revision: 'trusted', rule: 'local-repository-trust' }
    const active = await service.prepare({ executable: process.execPath, args: ['--version'] })
    service.start({ proposalId: active.proposalId, operationId: 'trusted-active' })
    expect((await complete('trusted-active')).status).toBe('SUCCEEDED')
    expect(approval).not.toHaveBeenCalled()

    approval.mockResolvedValueOnce(false)
    const siblingProposal = await service.prepare({ executable: process.execPath, worktree: selector(),
      args: ['-e', "require('fs').writeFileSync('must-not-run', 'unsafe')"] })
    expect(siblingProposal.policy?.mode).toBe('SUPERVISED')
    expect(siblingProposal.autoAuthorized).toBe(false)
    service.start({ proposalId: siblingProposal.proposalId, operationId: 'sibling-refused' })
    expect((await complete('sibling-refused')).status).toBe('REFUSED')
    expect(existsSync(join(sibling, 'must-not-run'))).toBe(false)

    const approved = await service.prepare({ executable: process.execPath, worktree: selector(), args: ['-e', 'console.log(process.cwd())'] })
    service.start({ proposalId: approved.proposalId, operationId: 'sibling-approved' })
    const result = await complete('sibling-approved')
    expect(result.status).toBe('SUCCEEDED')
    expect(realpathSync(result.stdout.trim())).toBe(realpathSync(sibling))
    expect(service.start({ proposalId: approved.proposalId, operationId: 'sibling-approved' }).worktree).toEqual(approved.worktree)
    expect(approval).toHaveBeenCalledTimes(2)

    const batch = await service.prepareInvestigation({ commands: [
      { executable: process.execPath, args: ['-e', 'console.log(process.cwd())'] },
      { executable: process.execPath, args: ['--version'] }
    ] })
    service.startInvestigation({ proposalId: batch.proposalId, operationId: 'trusted-batch' })
    const summary = await until(() => service.getInvestigation({ operationId: 'trusted-batch' }), value => value.phase === 'TERMINAL')
    expect(summary.status).toBe('SUCCEEDED')
    const output = service.getInvestigation({ operationId: 'trusted-batch', index: 0 })
    expect('output' in output && realpathSync(output.output.stdout.trim())).toBe(realpathSync(main))
    expect(approval).toHaveBeenCalledTimes(2)
    expect(selection.revision).toBe(1)
  }, 30000)

  it('keeps Worktree selection out of investigation manifest items while exposing optional top-level worktree', async () => {
    const tool = CLI_EXECUTION_TOOLS.find(tool => tool.name === 'prepare_cli_investigation')!
    expect((tool.inputSchema.properties as any).worktree).toBeDefined()
    const commands = (tool.inputSchema.properties as any).commands
    expect(commands.items.properties.worktree).toBeUndefined()
    const query = { executable: process.execPath, args: ['--version'] }
    expect((await executeCliTool(service, 'prepare_cli_investigation', { commands: [query, { ...query, worktree: selector() }] })).isError).toBe(true)
    await expect(service.prepareInvestigation({ commands: [query, { ...query, worktree: selector() } as never] })).rejects.toThrow('INVALID_WORKTREE_SELECTOR')
    expect(approval).not.toHaveBeenCalled()
  })

  it('invalidates sibling consent when active-checkout trust is revoked', async () => {
    policy = { mode: 'AUTONOMOUS_TRUSTED', revision: 'trusted', rule: 'local-repository-trust' }
    let accept!: (allowed: boolean) => void
    approval.mockImplementation(() => new Promise(resolve => { accept = resolve }))
    const proposal = await service.prepare({ executable: process.execPath, worktree: selector(),
      args: ['-e', "require('fs').writeFileSync('must-not-run', 'unsafe')"] })
    service.start({ proposalId: proposal.proposalId, operationId: 'revoke' })
    await until(() => accept, Boolean)
    policy = { mode: 'SUPERVISED', revision: 'revoked', rule: 'native-command-consent' }
    service.refreshPolicy()
    accept(true)
    expect((await complete('revoke')).status).toBe('CANCELLED')
    expect(existsSync(join(sibling, 'must-not-run'))).toBe(false)
  })

  it('refuses undiscovered, foreign, removed, locked and generation-stale Worktrees', async () => {
    const fresh = new GitWorktreeRegistry(main, gitService, { repositoryId: 'repository', isActive: () => true })
    await expect(resolveCliWorktree(fresh, gitService, selector())).rejects.toThrow('WORKTREE_NOT_DISCOVERED')
    await expect(service.prepare({ executable: process.execPath, worktree: { ...selector(), worktreeId: 'f'.repeat(64) } })).rejects.toThrow('WORKTREE_NOT_DISCOVERED')
    await expect(service.prepare({ executable: process.execPath, worktree: { ...selector(), generation: 'f'.repeat(64) } })).rejects.toThrow('WORKTREE_STALE')
    git(main, 'worktree', 'lock', sibling)
    await expect(service.prepare({ executable: process.execPath, worktree: selector() })).rejects.toThrow('WORKTREE_LOCKED')
    git(main, 'worktree', 'unlock', sibling)
    git(main, 'worktree', 'remove', sibling)
    await expect(service.prepare({ executable: process.execPath, worktree: selector() })).rejects.toThrow('WORKTREE_STALE')
    expect(approval).not.toHaveBeenCalled()
  }, 20000)

  it.each(['head', 'index', 'generation', 'project', 'locked'] as const)('refuses %s drift while consent is pending', async drift => {
    let accept!: (allowed: boolean) => void
    approval.mockImplementation(() => new Promise(resolve => { accept = resolve }))
    const proposal = await service.prepare({ worktree: selector(), executable: process.execPath,
      args: ['-e', "require('fs').writeFileSync('must-not-run', 'unsafe')"] })
    const input = { proposalId: proposal.proposalId, operationId: drift }
    service.start(input)
    await until(() => accept, Boolean)
    if (drift === 'head') git(sibling, 'commit', '--allow-empty', '-qm', 'head drift')
    if (drift === 'index') { writeFileSync(join(sibling, 'tracked'), 'staged'); git(sibling, 'add', 'tracked') }
    if (drift === 'generation') {
      git(main, 'worktree', 'remove', sibling)
      git(main, 'worktree', 'add', '-q', sibling, 'sibling')
    }
    if (drift === 'project') selection = { ...selection, revision: 2 }
    if (drift === 'locked') git(main, 'worktree', 'lock', sibling)
    accept(true)
    const result = await complete(drift)
    expect(result.status).toBe('REFUSED')
    expect(result.diagnostic).toBe('CHECKOUT_CHANGED')
    expect(service.start(input).status).toBe('REFUSED')
    expect(existsSync(join(sibling, 'must-not-run'))).toBe(false)
  }, 20000)

  it('rechecks target identity at the native suspended-process barrier', async () => {
    const original = gitService.captureWorktreeReadSnapshot.bind(gitService)
    const capture = vi.spyOn(gitService, 'captureWorktreeReadSnapshot')
    let targetCaptures = 0
    capture.mockImplementation(async path => {
      if (realpathSync(path) === realpathSync(sibling) && ++targetCaptures === 5) {
        git(sibling, 'commit', '--allow-empty', '-qm', 'changed before native resume')
      }
      return original(path)
    })
    const proposal = await service.prepare({ worktree: selector(), executable: process.execPath,
      args: ['-e', "require('fs').writeFileSync('must-not-run', 'unsafe')"] })
    service.start({ proposalId: proposal.proposalId, operationId: 'suspended' })
    const result = await complete('suspended')
    expect(targetCaptures).toBe(5)
    expect(result.status).toBe('CANCELLED')
    expect(result.treeObservation).toEqual({ activeProcesses: 0, handlesClosed: true })
    expect(existsSync(join(sibling, 'must-not-run'))).toBe(false)
  }, 20000)

  it('refuses CWD traversal, junction escape and invalid selector/path arguments before consent', async () => {
    symlinkSync(other, join(sibling, 'escape'), 'junction')
    for (const relativeCwd of ['..', '../other', other, 'escape']) {
      await expect(service.prepare({ worktree: selector(), executable: process.execPath, relativeCwd })).rejects.toThrow(/CWD_OUTSIDE_CHECKOUT|ABSOLUTE_CWD_FORBIDDEN/)
    }
    for (const worktree of [null, {}, { ...selector(), path: other }, { worktreeId: sibling, generation: selected.generation }]) {
      expect((await executeCliTool(service, 'prepare_cli_execution', { executable: process.execPath, worktree })).isError).toBe(true)
    }
    expect(approval).not.toHaveBeenCalled()
  }, 20000)

  it.each(['refuse', 'cancel', 'disable'] as const)('cannot run a general command after %s or a late consent', async action => {
    let accept!: (allowed: boolean) => void
    approval.mockImplementation(() => new Promise(resolve => { accept = resolve }))
    const proposal = await service.prepare({ worktree: selector(), executable: process.execPath,
      args: ['-e', "require('fs').writeFileSync('must-not-run', 'unsafe')"] })
    service.start({ proposalId: proposal.proposalId, operationId: action })
    await until(() => accept, Boolean)
    if (action === 'cancel') await service.cancel({ operationId: action })
    if (action === 'disable') service.setEnabled(false)
    accept(action !== 'refuse')
    const result = await complete(action)
    expect(result.status).toBe(action === 'refuse' ? 'REFUSED' : 'CANCELLED')
    expect(existsSync(join(sibling, 'must-not-run'))).toBe(false)
  }, 20000)

  it('executes YOLO across existing and future Worktrees (unitary + top-level investigation) with zero command dialogs and zero changes to main', async () => {
    const mainHead = git(main, 'rev-parse', 'HEAD')
    const settings = new SettingsService()
    settings.saveSettings({ ...settings.loadSettings(), cliExecutionEnabled: true })
    const initialConsent = vi.fn(async () => true)
    const trustPolicy = new CliTrustPolicy(
      settings,
      () => ({ repositoryId: 'repository', path: main, revision: selection.revision }),
      initialConsent
    )
    await expect(trustPolicy.choose('AUTONOMOUS_TRUSTED', 'REPOSITORY_WORKTREES')).resolves.toBe(true)
    expect(initialConsent).toHaveBeenCalledTimes(1)

    const yoloService = new CliExecutionService({
      repoRoot: main,
      repositoryId: 'repository',
      enabledByDefault: true,
      approvalHandler: approval,
      getPolicy: target => trustPolicy.getPolicy({ repositoryId: 'repository', path: target?.directory ?? main }),
      getFingerprint: createCliProjectAuthority({
        selection,
        getSelection: () => selection,
        findRepository: () => ({ id: 'repository', localCheckout: { path: main, availability: 'AVAILABLE', gitState: 'GIT' } }),
        captureGitIdentity: async path => {
          const dirs = await gitService.getRepositoryDirectories(path)
          const snap = await gitService.captureWorktreeReadSnapshot(path)
          return { commonDirectory: realpathSync(dirs.common), worktreeDirectory: realpathSync(dirs.admin), head: snap.head, branch: snap.branch, operation: snap.operation }
        }
      }),
      getRuntimeIdentity: createCliProjectRuntimeAuthority({
        selection,
        getSelection: () => selection,
        findRepository: () => ({ id: 'repository', localCheckout: { path: main, availability: 'AVAILABLE', gitState: 'GIT' } }),
        captureStableGitIdentity: async path => {
          const dirs = await gitService.getRepositoryDirectories(path)
          return { commonDirectory: realpathSync(dirs.common), worktreeDirectory: realpathSync(dirs.admin) }
        }
      }),
      resolveWorktree: target => resolveCliWorktree(registry, gitService, target)
    })

    try {
      const hostPolicy = await yoloService.getPolicyForWorktree(selector())
      expect(hostPolicy.mode).toBe('AUTONOMOUS_TRUSTED')
      expect(hostPolicy.scope).toBe('REPOSITORY_WORKTREES')

      // Future worktree created AFTER YOLO grant
      const future = join(directory, 'future-wt')
      git(main, 'worktree', 'add', '-qb', 'future-wt', future)
      mkdirSync(join(future, 'nested'), { recursive: true })
      const futureRecord = (await registry.discover()).worktrees.find(tree => tree.branch === 'future-wt')!
      const futureSelector = { worktreeId: futureRecord.worktreeId, generation: futureRecord.generation }

      // 1. Unitary op in future worktree with custom cwd & large paginated output
      const payloadArg = 'arbitrary argv "quotes" & spaces'
      const p1 = await executeCliTool(yoloService, 'prepare_cli_execution', {
        worktree: futureSelector,
        executable: process.execPath,
        relativeCwd: 'nested',
        args: ['-e', "console.log(process.cwd()); console.log(process.argv[1]); for (let i = 0; i < 500; i++) console.log('YOLO_PAGE_' + i + '_PADDING_012345678901234567890123456789');", payloadArg]
      })
      expect(p1.isError).not.toBe(true)
      const prop1 = JSON.parse(textContent(p1.content[0]))
      expect(prop1.policy.mode).toBe('AUTONOMOUS_TRUSTED')
      expect(prop1.policy.scope).toBe('REPOSITORY_WORKTREES')
      expect(prop1.autoAuthorized).toBe(true)
      await executeCliTool(yoloService, 'start_cli_execution', { proposalId: prop1.proposalId, operationId: 'yolo-u1' })
      const r1 = await until(() => yoloService.get({ operationId: 'yolo-u1' }), v => v.phase === 'TERMINAL')
      expect(r1.status).toBe('SUCCEEDED')
      expect(r1.treeObservation).toEqual({ activeProcesses: 0, handlesClosed: true })
      expect(r1.stdout).toContain(realpathSync(join(future, 'nested')))
      expect(r1.stdout).toContain(payloadArg)
      const page1 = yoloService.get({ operationId: 'yolo-u1', cursor: '0' })
      expect(page1.hasMore).toBe(true)
      const page2 = yoloService.get({ operationId: 'yolo-u1', cursor: page1.nextCursor! })
      expect(page2.stdout.length).toBeGreaterThan(0)

      // 2. Second unitary op in `other` worktree
      const otherRecord = (await registry.discover()).worktrees.find(tree => tree.branch === 'other')!
      const p2 = await yoloService.prepare({
        worktree: { worktreeId: otherRecord.worktreeId, generation: otherRecord.generation },
        executable: process.execPath,
        args: ['-e', "console.log('OTHER_WT:' + process.cwd())"]
      })
      expect(p2.autoAuthorized).toBe(true)
      yoloService.start({ proposalId: p2.proposalId, operationId: 'yolo-u2' })
      const r2 = await until(() => yoloService.get({ operationId: 'yolo-u2' }), v => v.phase === 'TERMINAL')
      expect(r2.status).toBe('SUCCEEDED')
      expect(r2.stdout).toContain(realpathSync(other))

      // 3. Top-level worktree investigation batch in `sibling` where Step 0 commits and Step 1 verifies new HEAD
      const batchPrep = await executeCliTool(yoloService, 'prepare_cli_investigation', {
        worktree: selector(),
        commands: [
          { executable: 'git', args: ['status', '--short'] },
          {
            executable: process.execPath,
            args: ['-e', "const fs=require('fs'), cp=require('child_process'); fs.writeFileSync('batch-commit.txt','from-batch'); cp.execFileSync('git',['add','batch-commit.txt'],{stdio:'inherit'}); cp.execFileSync('git',['-c','commit.gpgsign=false','commit','-qm','batch commit'],{stdio:'inherit'});"]
          },
          { executable: 'git', args: ['log', '-1', '--pretty=%s'] }
        ]
      })
      expect(batchPrep.isError).not.toBe(true)
      const batchProp = JSON.parse(textContent(batchPrep.content[0]))
      expect(batchProp.autoAuthorized).toBe(true)
      expect(batchProp.worktree.worktreeId).toBe(selected.worktreeId)
      await executeCliTool(yoloService, 'start_cli_investigation', { proposalId: batchProp.proposalId, operationId: 'yolo-batch' })
      const summary = await until(() => yoloService.getInvestigation({ operationId: 'yolo-batch' }), v => v.phase === 'TERMINAL')
      expect(summary.status, JSON.stringify(summary)).toBe('SUCCEEDED')
      expect(summary.worktree?.worktreeId).toBe(selected.worktreeId)
      expect(summary.steps.every(s => s.status === 'SUCCEEDED')).toBe(true)
      const step2Out = yoloService.getInvestigation({ operationId: 'yolo-batch', index: 2 })
      expect('output' in step2Out && step2Out.output.stdout.trim()).toBe('batch commit')

      expect(approval).not.toHaveBeenCalled()
      expect(git(main, 'rev-parse', 'HEAD')).toBe(mainHead)
      expect(git(main, 'status', '--porcelain')).toBe('')
    } finally {
      await yoloService.shutdown()
    }
  }, 45000)

  it('survives a real git commit inside a running YOLO Worktree across monitor ticks while cancelling on revocation', async () => {
    const settings = new SettingsService()
    settings.saveSettings({ ...settings.loadSettings(), cliExecutionEnabled: true })
    const trustPolicy = new CliTrustPolicy(
      settings,
      () => ({ repositoryId: 'repository', path: main, revision: selection.revision }),
      async () => true
    )
    await trustPolicy.choose('AUTONOMOUS_TRUSTED', 'REPOSITORY_WORKTREES')

    const yoloService = new CliExecutionService({
      repoRoot: main,
      repositoryId: 'repository',
      enabledByDefault: true,
      approvalHandler: approval,
      getPolicy: target => trustPolicy.getPolicy({ repositoryId: 'repository', path: target?.directory ?? main }),
      getFingerprint: createCliProjectAuthority({
        selection,
        getSelection: () => selection,
        findRepository: () => ({ id: 'repository', localCheckout: { path: main, availability: 'AVAILABLE', gitState: 'GIT' } }),
        captureGitIdentity: async path => {
          const dirs = await gitService.getRepositoryDirectories(path)
          const snap = await gitService.captureWorktreeReadSnapshot(path)
          return { commonDirectory: realpathSync(dirs.common), worktreeDirectory: realpathSync(dirs.admin), head: snap.head, branch: snap.branch, operation: snap.operation }
        }
      }),
      getRuntimeIdentity: createCliProjectRuntimeAuthority({
        selection,
        getSelection: () => selection,
        findRepository: () => ({ id: 'repository', localCheckout: { path: main, availability: 'AVAILABLE', gitState: 'GIT' } }),
        captureStableGitIdentity: async path => {
          const dirs = await gitService.getRepositoryDirectories(path)
          return { commonDirectory: realpathSync(dirs.common), worktreeDirectory: realpathSync(dirs.admin) }
        }
      }),
      resolveWorktree: target => resolveCliWorktree(registry, gitService, target)
    })

    try {
      const beforeHead = git(sibling, 'rev-parse', 'HEAD')
      const commitProp = await yoloService.prepare({
        worktree: selector(),
        executable: process.execPath,
        args: ['-e', "setTimeout(() => console.log('SURVIVED_COMMIT'), 1700)"]
      })
      yoloService.start({ proposalId: commitProp.proposalId, operationId: 'yolo-live-commit' })
      await until(() => yoloService.get({ operationId: 'yolo-live-commit' }), v => v.status === 'RUNNING')
      writeFileSync(join(sibling, 'live-commit.txt'), 'committed during monitor')
      git(sibling, 'add', 'live-commit.txt')
      git(sibling, 'commit', '-qm', 'live commit while running')
      const commitResult = await until(() => yoloService.get({ operationId: 'yolo-live-commit' }), v => v.phase === 'TERMINAL')
      expect(commitResult.status, JSON.stringify(commitResult)).toBe('SUCCEEDED')
      expect(commitResult.stdout.trim()).toBe('SURVIVED_COMMIT')
      expect(git(sibling, 'rev-parse', 'HEAD')).not.toBe(beforeHead)

      // Revocation during active Worktree command cancels the process tree cleanly
      const cancelProp = await yoloService.prepare({
        worktree: selector(),
        executable: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)']
      })
      yoloService.start({ proposalId: cancelProp.proposalId, operationId: 'yolo-revoke' })
      await until(() => yoloService.get({ operationId: 'yolo-revoke' }), v => v.status === 'RUNNING')
      await trustPolicy.choose('SUPERVISED')
      yoloService.refreshPolicy()
      const revokedResult = await until(() => yoloService.get({ operationId: 'yolo-revoke' }), v => v.phase === 'TERMINAL')
      expect(revokedResult.status).toBe('CANCELLED')
      expect(revokedResult.diagnostic).toBe('POLICY_CHANGED')
      expect(revokedResult.treeObservation).toEqual({ activeProcesses: 0, handlesClosed: true })
      expect(approval).not.toHaveBeenCalled()
    } finally {
      await yoloService.shutdown()
    }
  }, 45000)
})
