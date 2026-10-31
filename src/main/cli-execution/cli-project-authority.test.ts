import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ActiveProjectService } from '../core/active-project-service'
import type { RepositoryRecord } from '../../shared/types/repository-catalog-types'
import { createCliProjectAuthority } from './cli-project-authority'
import { CliExecutionService } from './cli-execution-service'
import { resolveCliCommand } from './cli-command-resolver'
import { CliOutputBuffer } from './cli-output-buffer'

const roots: string[] = [], services: CliExecutionService[] = []
function root() { const path = mkdtempSync(join(tmpdir(), 'ca-cli-project-')); roots.push(path); return path }
async function done(service: CliExecutionService, operationId: string) {
  const deadline = Date.now() + 6000
  while (Date.now() < deadline) {
    const record = service.get({ operationId })
    if (['SUCCEEDED', 'FAILED', 'REFUSED', 'CANCELLED'].includes(record.status)) return record
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('TEST_TIMEOUT')
}
function record(path: string, id: string, git = true): RepositoryRecord {
  return { id, name: id, status: 'ACTIVE', github: null, createdAt: '', updatedAt: '', localCheckout: { path, availability: 'AVAILABLE', gitState: git ? 'GIT' : 'NON_GIT' } }
}
afterEach(async () => {
  for (const service of services.splice(0)) await service.shutdown()
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
})
describe('CLI Active Project authority and exact Windows invocation', () => {
  it('UTF-8 chunks retain exact characters and respect the byte quota', () => {
    const buffer = new CliOutputBuffer(7)
    const bytes = Buffer.from('😀😀😀')
    buffer.appendStdout(bytes.subarray(0, 2))
    buffer.appendStdout(bytes.subarray(2))
    expect(buffer.readPage().stdout).toBe('😀')
    expect(buffer.readPage().totalStdoutBytes).toBeLessThanOrEqual(7)
    expect(buffer.isTruncated()).toBe(true)
  })
  it('two Catalog projects plus NON_GIT preserve cwd/identity; edits keep authority; selection and HEAD revoke it', async () => {
    const paths = [root(), root(), root()]
    const catalog = paths.map((path, index) => record(path, 'repo-' + index, index < 2))
    for (const path of paths.slice(0, 2)) {
      execFileSync('git', ['init', '-q', path], { windowsHide: true })
      execFileSync('git', ['-C', path, '-c', 'user.name=CLI Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-qm', 'fixture'], { windowsHide: true })
    }
    const active = new ActiveProjectService({ getOpenProjects: () => [], closeRepository: () => {} })
    const find = (path: string) => catalog.find(entry => realpathSync(entry.localCheckout!.path) === realpathSync(path)) ?? null
    const captureGitIdentity = vi.fn(async (path: string) => ({
      head: execFileSync('git', ['-C', path, 'rev-parse', 'HEAD'], { windowsHide: true, encoding: 'utf8' }).trim(),
      branch: execFileSync('git', ['-C', path, 'symbolic-ref', 'HEAD'], { windowsHide: true, encoding: 'utf8' }).trim()
    }))
    for (const entry of catalog) {
      await active.bind(entry)
      const authority = createCliProjectAuthority({ selection: active.getState(), getSelection: () => active.getState(), findRepository: find, captureGitIdentity })
      const fingerprint = await authority()
      writeFileSync(join(entry.localCheckout!.path, 'editor-change'), 'legitimate edit')
      expect(await authority()).toBe(fingerprint)
      const service = new CliExecutionService({ repoRoot: entry.localCheckout!.path, repositoryId: entry.id, getFingerprint: authority, enabledByDefault: true, approvalHandler: async () => true })
      services.push(service)
      const proposal = await service.prepare({ executable: process.execPath, args: ['-e', 'console.log(process.cwd())'] })
      expect(proposal.repositoryId).toBe(entry.id)
      service.start({ proposalId: proposal.proposalId, operationId: entry.id })
      const result = await done(service, entry.id)
      expect(result.status).toBe('SUCCEEDED')
      expect(realpathSync(result.stdout.trim())).toBe(realpathSync(entry.localCheckout!.path))
      if (entry.localCheckout!.gitState === 'GIT') {
        execFileSync('git', ['-C', entry.localCheckout!.path, '-c', 'user.name=CLI Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-qm', 'changed head'], { windowsHide: true })
        expect(await authority()).not.toBe(fingerprint)
      }
      await active.activate(null)
      await expect(authority()).rejects.toThrow('PROJECT_CONTEXT_CHANGED')
    }
    expect(captureGitIdentity.mock.calls.every(([path]) => path !== realpathSync(paths[2]))).toBe(true)
  }, 15000)
  it('A→B pending approval cancels A and a late consent cannot execute in either project', async () => {
    const a = record(root(), 'A', false), b = record(root(), 'B', false)
    const active = new ActiveProjectService({ getOpenProjects: () => [], closeRepository: () => {} })
    await active.bind(a)
    let approve!: (value: boolean) => void
    const authority = createCliProjectAuthority({ selection: active.getState(), getSelection: () => active.getState(), findRepository: () => a, captureGitIdentity: async () => { throw new Error('GIT_MUST_NOT_RUN') } })
    const service = new CliExecutionService({ repoRoot: a.localCheckout!.path, getFingerprint: authority, enabledByDefault: true, approvalHandler: () => new Promise(resolve => { approve = resolve }) })
    services.push(service)
    active.onBeforeChange(() => service.shutdown())
    const proposal = await service.prepare({ executable: process.execPath, args: ['-v'] })
    service.start({ proposalId: proposal.proposalId, operationId: 'pending-A' })
    await active.bind(b)
    approve(true)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(service.get({ operationId: 'pending-A' }).status).toBe('CANCELLED')
    expect(service.get({ operationId: 'pending-A' }).stdout).toBe('')
    await expect(authority()).rejects.toThrow('PROJECT_CONTEXT_CHANGED')
    expect(() => createCliProjectAuthority({ selection: { project: null, revision: 0 }, getSelection: () => active.getState(), findRepository: () => null, captureGitIdentity: async () => null })).toThrow('NO_ACTIVE_PROJECT')
  })
  it('canonical junction root works while a junction cwd escape is rejected', async () => {
    const parent = root(), physical = root(), outside = root(), alias = join(parent, 'alias')
    symlinkSync(physical, alias, 'junction')
    symlinkSync(outside, join(physical, 'escape'), 'junction')
    const project = { id: 'junction', path: alias }, selection = { project, revision: 1 }
    const authority = createCliProjectAuthority({ selection, getSelection: () => selection, findRepository: () => record(alias, project.id, false), captureGitIdentity: async () => null })
    expect(await authority()).toBe(await authority())
    expect(resolveCliCommand(alias, process.execPath).cwd).toBe(realpathSync(physical))
    expect(() => resolveCliCommand(alias, process.execPath, [], 'escape')).toThrow('CWD_OUTSIDE_CHECKOUT')
  })
  it('real npm.cmd/npx.cmd and a wrapper with spaces preserve approved invocation; unsafe metacharacters rejected before consent', async () => {
    const path = root(), spaced = join(path, 'wrapper space')
    mkdirSync(spaced)
    writeFileSync(join(spaced, 'args.js'), 'console.log(JSON.stringify(process.argv.slice(2)))')
    const wrapper = join(spaced, 'echo args.cmd')
    writeFileSync(wrapper, `@"${process.execPath}" "${join(spaced, 'args.js')}" %*\r\n`)
    const approval = vi.fn(async () => true)
    const service = new CliExecutionService({ repoRoot: path, enabledByDefault: true, approvalHandler: approval })
    services.push(service)
    for (const [executable, args] of [[wrapper, ['hello world', 'path\\file']], ['npm.cmd', ['--version']], ['npx.cmd', ['--version']]] as [string, string[]][]) {
      const proposal = await service.prepare({ executable, args })
      expect(proposal.command.executable.toLowerCase()).toMatch(/cmd\.exe$/)
      expect(proposal.command.displayCommandLine).toBe(proposal.command.windowsCommandLine)
      const operationId = executable
      service.start({ proposalId: proposal.proposalId, operationId })
      const result = await done(service, operationId)
      expect(result.status, JSON.stringify(result)).toBe('SUCCEEDED')
      if (executable === wrapper) expect(JSON.parse(result.stdout.trim())).toEqual(args)
      else expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/)
    }
    approval.mockClear()
    for (const value of ['a&b', 'a|b', 'a<b', 'a>b', '%PATH%', 'a"b', '!PATH!', 'a^b', 'line\nfeed', 'trailing\\']) {
      await expect(service.prepare({ executable: wrapper, args: [value] })).rejects.toThrow('WINDOWS_WRAPPER_ARGUMENT_UNREPRESENTABLE')
    }
    expect(approval).not.toHaveBeenCalled()
  }, 20000)
})
