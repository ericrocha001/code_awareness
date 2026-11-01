import './cli-native-test-setup'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { GitService } from '../core/git-service'
import { GitWorktreeRegistry, type WorktreeRecord } from '../git-operations/git-worktree-registry'
import { createCliProjectAuthority } from './cli-project-authority'
import { resolveCliWorktree } from './cli-worktree-authority'
import { CliExecutionService } from './cli-execution-service'
import { executeCliTool } from './cli-execution-mcp'
import type { CliWorktreeSelector } from './cli-execution-types'
import { textContent } from '../mcp/mcp-test-content'
import type { CliPolicy } from '../../shared/types/cli-policy-types'
import { CLI_EXECUTION_TOOLS } from './cli-execution-mcp'

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
    if (directory) rmSync(directory, { recursive: true, force: true })
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

  it('keeps Worktree selection out of investigation manifests in schema and dispatch', async () => {
    const tool = CLI_EXECUTION_TOOLS.find(tool => tool.name === 'prepare_cli_investigation')!
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
})
