import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcademyStore } from '../academy-store'
import { AcademyGitMaterializer } from './academy-git-materializer'
import { AcademyGitSyncService } from './academy-git-sync-service'
import { GitService } from '../../core/git-service'
import { gitExec, writeFile } from '../../core/git-test-helpers'
import type { RepositoryRecord } from '../../../shared/types/repository-catalog-types'
import { readAcademyGitSnapshot } from './academy-git-snapshot'

const roots: string[] = []
const stores: AcademyStore[] = []
const synchronizers: AcademyGitSyncService[] = []
afterEach(async () => { for (const sync of synchronizers.splice(0)) await sync.close(); vi.restoreAllMocks(); for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) { try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) } catch {} } })
const pkg = (text = 'canonical', name = 'alpha') => ({ skillMd: `---\nname: ${name}\ndescription: Test skill\n---\n${text}\n`, artifacts: {} })

async function fixture(local = 'canonical') {
  const root = mkdtempSync(join(tmpdir(), 'academy-git-first-')); roots.push(root)
  const remote = join(root, 'remote.git'), human = join(root, 'human')
  await gitExec(root, ['init', '--bare', remote])
  await gitExec(root, ['clone', remote, human])
  await gitExec(human, ['switch', '-c', 'main'])
  await gitExec(human, ['config', 'user.name', 'Test'])
  await gitExec(human, ['config', 'user.email', 'test@example.com'])
  writeFile(human, 'skills/alpha/SKILL.md', pkg().skillMd)
  writeFile(human, 'README.md', 'external documentation')
  await gitExec(human, ['add', '.']); await gitExec(human, ['commit', '-m', 'baseline'])
  await gitExec(human, ['push', '-u', 'origin', 'main'])
  const databasePath = join(root, 'data', 'academy.db')
  let store = new AcademyStore(databasePath); stores.push(store)
  const skill = store.create({ package: pkg(local), scope: 'GLOBAL', origin: 'UI' })
  const git = new GitService()
  const transport = {
    authorizationIdentity: () => 'fixture-credential-grant',
    fetch: (path: string, origin: string) => git.fetchRemote(path, origin),
    readRemoteHead: (path: string, origin: string, ref: string) => git.readRemoteHead(path, origin, ref),
    push: (path: string, branch: string, origin = 'origin', head?: string) => git.push(path, origin, branch, head)
  }
  const record = { id: 'destination', name: 'Academy', status: 'ACTIVE',
    localCheckout: { path: human, availability: 'AVAILABLE', gitState: 'GIT' },
    github: { repositoryId: 'github-id', name: 'Academy', fullName: 'test/academy', ownerId: 'owner-id', ownerLogin: 'test', visibility: 'PRIVATE', cloneUrl: remote, htmlUrl: 'https://github.com/test/academy', accessState: 'AVAILABLE', lastSeenAt: new Date().toISOString() },
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as RepositoryRecord
  const port = { resolveRepository: () => record, findByGitHubId: () => record, listEligibleRepositories: () => [record] }
  const service = () => {
    const sync = new AcademyGitSyncService(store, new AcademyGitMaterializer(), git, transport, port)
    synchronizers.push(sync)
    return sync
  }
  const sync = service()
  const externalCommit = async (content: string, name = 'alpha', push = true) => {
    writeFile(human, `skills/${name}/SKILL.md`, pkg(content, name).skillMd)
    await gitExec(human, ['add', '--', `skills/${name}`]); await gitExec(human, ['commit', '-m', content])
    if (push) await gitExec(human, ['push', 'origin', 'main'])
    return git.resolveCommit(human, 'HEAD')
  }
  const restart = () => { store.close(); store = new AcademyStore(databasePath); stores.push(store); return service() }
  return { root, remote, human, git, transport, record, sync, skill, externalCommit, restart, get store() { return store } }
}

describe('Academy Git-first source', () => {
  it('cuts over explicitly, persists offline edits and converges without duplicate versions or exposing private skills', async () => {
    const f = await fixture()
    await f.sync.bindRepository(f.record.id)
    const cutover = await f.sync.completeLocalCutover(true)
    expect(cutover.lastError).toBeNull()
    expect(f.store.usesLocalAuthority()).toBe(true)
    expect((await f.sync.publish()).lastError).toBeNull()
    const skill = f.store.get(f.skill.id)
    f.store.update({ skillId: skill.id, expectedVersion: skill.currentVersion, package: pkg('offline local edit'), origin: 'UI' })
    const privateSkill = f.store.create({ package: pkg('private body', 'private'), scope: 'GLOBAL', origin: 'UI' })
    let restarted = f.restart()
    expect(restarted.getStatus().convergence).toMatchObject({ pending: true, freshness: 'UNVERIFIED' })
    let pushedHead: string | undefined, disconnected = false
    const push = f.transport.push.bind(f.transport), fetch = f.transport.fetch.bind(f.transport)
    const pushSpy = vi.spyOn(f.transport, 'push').mockImplementation(async (path, branch, origin, head) => {
      await push(path, branch, origin, head)
      pushedHead = head; disconnected = true
      throw new Error('lost push receipt')
    })
    const fetchSpy = vi.spyOn(f.transport, 'fetch').mockImplementation((path, origin) => disconnected ? Promise.reject(new Error('offline after push')) : fetch(path, origin))
    expect((await restarted.publish()).lastError).toBe('offline after push')
    expect(f.store.getGitAuthority()?.processedCommitSha).not.toBe(pushedHead)
    pushSpy.mockRestore(); fetchSpy.mockRestore()
    restarted = f.restart()
    const published = await restarted.publish()
    expect(published.lastError).toBeNull()
    expect(f.store.get(skill.id).currentVersion).toBe(2)
    expect(f.store.getGitAuthority()?.processedCommitSha).toBe(pushedHead)
    expect(f.store.publicationEligibility(privateSkill.id)).toBe('PRIVATE')
    expect(f.store.getConvergenceCheckpoint()?.fingerprint).toBe(f.store.replicatedFingerprint())
    const source = f.store.getGitSnapshot('github-id', f.store.getGitAuthority()!.processedCommitSha)!
    expect(source.skills.map(skill => skill.name)).toEqual(['alpha'])
    expect(source.identities?.skills[0].skillId).toBe(skill.id)
    const head = f.store.getGitAuthority()!.processedCommitSha
    await restarted.publish()
    expect(f.store.getGitAuthority()!.processedCommitSha).toBe(head)
    expect(f.store.get(skill.id).currentVersion).toBe(2)
    await gitExec(f.human, ['pull', '--ff-only', 'origin', 'main'])
    await gitExec(f.human, ['switch', '-c', 'reviewed-contribution'])
    await f.externalCommit('externally reviewed content', 'alpha', false)
    await gitExec(f.human, ['switch', 'main'])
    await gitExec(f.human, ['merge', '--no-ff', 'reviewed-contribution', '-m', 'approved merge'])
    await gitExec(f.human, ['push', 'origin', 'main'])
    expect((await restarted.syncNow()).lastError).toBeNull()
    expect(f.store.get(skill.id).currentVersion).toBe(3)
    expect(f.store.get(skill.id).current.package.skillMd).toContain('externally reviewed content')
    await restarted.syncNow()
    expect(f.store.get(skill.id).currentVersion).toBe(3)
  }, 240000)
  it('rejects staged byte transformations before creating a Save commit', async () => {
    const f = await fixture()
    writeFile(f.human, '.gitattributes', 'skills/** text eol=lf\n')
    await gitExec(f.human, ['add', '--', '.gitattributes'])
    await gitExec(f.human, ['commit', '-m', 'explicit text normalization'])
    await gitExec(f.human, ['push', 'origin', 'main'])
    const bound = await f.sync.bindRepository(f.record.id)
    const head = bound.publication!.localHead!
    const input = pkg('preserve CRLF bytes')
    input.skillMd = input.skillMd.replaceAll('\n', '\r\n')
    await expect(f.sync.saveDraft({ skillId: f.skill.id, expectedVersion: 1, package: input, origin: 'UI' })).rejects.toThrow('GIT_DRAFT_CONTENT_CHANGED_BY_FILTER')
    expect(await f.git.resolveCommit(bound.publication!.workspacePath!, 'HEAD')).toBe(head)
    expect(f.store.get(f.skill.id).currentVersion).toBe(1)
  }, 30000)
  it('automatically ingests a merged branch as one main transition and preserves activation', async () => {
    const f = await fixture()
    await f.sync.bindRepository(f.record.id)
    f.store.setEnabled(f.skill.id, false, 1)
    await f.sync.configureAutomation({ autoPublish: false, autoUpdate: true, confirmed: true, expectedRepositoryId: 'github-id', expectedBranch: 'main' })
    await gitExec(f.human, ['switch', '-c', 'contribution'])
    await f.externalCommit('branch internal one', 'alpha', false)
    await f.externalCommit('branch internal two', 'alpha', false)
    await f.externalCommit('new approved skill', 'beta', false)
    await f.sync.refreshAutomatically()
    expect(f.store.get(f.skill.id).currentVersion).toBe(1)
    await gitExec(f.human, ['switch', 'main'])
    await gitExec(f.human, ['merge', '--no-ff', 'contribution', '-m', 'approved merge'])
    await gitExec(f.human, ['push', 'origin', 'main'])
    const restarted = f.restart()
    await restarted.recoverOnStartup()
    expect(f.store.get(f.skill.id).currentVersion).toBe(2)
    expect(f.store.get(f.skill.id).status).toBe('DISABLED')
    expect(f.store.get(f.skill.id).stateRevision).toBe(2)
    expect(f.store.findByName('beta')?.currentVersion).toBe(1)
    expect(f.store.getGitSnapshot('github-id', f.store.getGitAuthority()!.processedCommitSha)?.skills).toHaveLength(2)
  }, 45000)

  it('ingests remote content without overwriting a conflicting draft', async () => {
    const f = await fixture()
    await f.sync.bindRepository(f.record.id)
    const draft = await f.sync.saveDraft({ skillId: f.skill.id, expectedVersion: 1, package: pkg('local draft'), origin: 'UI' })
    await f.externalCommit('remote content')
    const result = await f.sync.syncNow()
    expect(result.syncState).toBe('CONFLICT')
    expect(result.remoteCheck?.state).toBe('OK')
    expect(f.store.get(f.skill.id).current.package.skillMd).toContain('remote content')
    expect((await f.sync.getDraft('alpha')).workspaceCommitSha).toBe(draft.workspaceCommitSha)
    expect((await f.sync.getDraft('alpha')).package?.skillMd).toContain('local draft')
    expect(await f.git.getGitOperation(result.publication!.workspacePath!)).toBeNull()
    const started = await f.sync.resolveManagedConflict(result.publication!.remoteHead, draft.workspaceCommitSha)
    expect(started.syncState).toBe('CONFLICT')
    const review = await f.sync.reviewGitConflict('skills/alpha/SKILL.md')
    expect(review.local).toContain('local draft')
    expect(review.remote).toContain('remote content')
    const resolved = await f.sync.resolveGitConflict({ path: review.path, head: review.head, revision: review.revision, content: pkg('reviewed reconciliation').skillMd, confirmed: true })
    expect(resolved.syncState, resolved.lastError ?? '').toBe('LOCAL_CHANGES')
    expect((await f.sync.publish()).syncState).toBe('SYNCED')
    expect(f.store.get(f.skill.id).current.package.skillMd).toContain('reviewed reconciliation')
  }, 90000)

  it('integrates independent changes with the observed main as first parent while preserving local commits', async () => {
    const f = await fixture()
    await f.sync.bindRepository(f.record.id)
    const draft = await f.sync.saveDraft({ skillId: f.skill.id, expectedVersion: 1, package: pkg('local content'), origin: 'UI' })
    const remoteHead = await f.externalCommit('external beta', 'beta')
    const reconciled = await f.sync.syncNow()
    expect(reconciled.syncState, reconciled.lastError ?? '').toBe('LOCAL_CHANGES')
    expect(await f.git.firstParent(reconciled.publication!.workspacePath!, reconciled.publication!.localHead!)).toBe(remoteHead)
    expect(await f.git.isAncestor(reconciled.publication!.workspacePath!, draft.workspaceCommitSha, reconciled.publication!.localHead!)).toBe(true)
    const published = await f.sync.publish()
    expect(published.syncState, published.lastError ?? '').toBe('SYNCED')
    expect(f.store.get(f.skill.id).currentVersion).toBe(2)
    expect(f.store.findByName('beta')?.currentVersion).toBe(1)
  }, 45000)
  it('keeps three saves private across restart, then numbers all three only after confirmed push', async () => {
    const f = await fixture()
    await f.sync.bindRepository(f.record.id)
    const head = await f.git.resolveCommit(f.human, 'HEAD')
    const push = vi.spyOn(f.transport, 'push')
    let token: string | undefined
    const commits: string[] = []
    for (const text of ['save one', 'save two', 'save three']) {
      const receipt = await f.sync.saveDraft({ skillId: f.skill.id, expectedVersion: 1, expectedDraftCommitSha: token, package: pkg(text), origin: 'UI' })
      expect(receipt.state).toBe('DRAFT_SAVED')
      token = receipt.workspaceCommitSha; commits.push(token)
    }
    expect(push).not.toHaveBeenCalled()
    expect(f.store.get(f.skill.id).currentVersion).toBe(1)
    expect(await f.git.readRemoteHead(f.human, 'origin', 'refs/heads/main')).toBe(head)
    const restarted = f.restart()
    expect((await restarted.getDraft('alpha')).package?.skillMd).toContain('save three')
    expect((await restarted.publish()).syncState).toBe('SYNCED')
    expect(f.store.get(f.skill.id).currentVersion).toBe(4)
    expect(f.store.history(f.skill.id).slice(0, 3).map(version => version.gitSource?.sourceCommitSha)).toEqual([...commits].reverse())
    expect((await restarted.publish()).syncState).toBe('SYNCED')
    expect(f.store.get(f.skill.id).currentVersion).toBe(4)
    expect(await f.git.resolveCommit(f.human, 'HEAD')).toBe(head)
  }, 60000)

  it('refuses invalid and stale saves, preserves rejected pushes, and never bypasses branch protection', async () => {
    const f = await fixture()
    await f.sync.bindRepository(f.record.id)
    await expect(f.sync.saveDraft({ skillId: f.skill.id, expectedVersion: 1, package: { skillMd: 'invalid', artifacts: {} }, origin: 'UI' })).rejects.toThrow()
    const receipt = await f.sync.saveDraft({ skillId: f.skill.id, expectedVersion: 1, package: pkg('pending'), origin: 'UI' })
    await expect(f.sync.saveDraft({ skillId: f.skill.id, expectedVersion: 1, package: pkg('stale writer'), origin: 'UI' })).rejects.toThrow('DRAFT_REVISION_REQUIRED')
    vi.spyOn(f.transport, 'push').mockRejectedValue(new Error('GH006 protected branch requires pull request'))
    const result = await f.sync.publish()
    expect(result.syncState).toBe('PR_PENDING')
    expect((await f.sync.getDraft('alpha')).workspaceCommitSha).toBe(receipt.workspaceCommitSha)
    expect(f.store.get(f.skill.id).currentVersion).toBe(1)
  }, 45000)

  it('publishes a separate candidate branch without creating canonical versions, then preserves removal history', async () => {
    const f = await fixture()
    await f.sync.bindRepository(f.record.id)
    const draft = await f.sync.saveDraft({ skillId: f.skill.id, expectedVersion: 1, package: pkg('candidate'), origin: 'UI' })
    const candidate = await f.sync.publishCandidate({ branch: 'academy/review', expectedHead: draft.workspaceCommitSha, confirmed: true })
    expect(candidate.syncState, candidate.lastError ?? '').toBe('PR_PENDING')
    expect(await f.git.readRemoteHead(f.human, 'origin', 'refs/heads/academy/review')).toBe(draft.workspaceCommitSha)
    expect(f.store.get(f.skill.id).currentVersion).toBe(1)
    await gitExec(f.human, ['fetch', 'origin'])
    await gitExec(f.human, ['merge', '--no-ff', 'origin/academy/review', '-m', 'approved candidate'])
    await gitExec(f.human, ['push', 'origin', 'main'])
    expect((await f.sync.syncNow()).syncState).toBe('SYNCED')
    const token = (await f.sync.getDraft('alpha')).workspaceCommitSha
    expect((await f.sync.deleteDraft({ skillId: f.skill.id, expectedVersion: 2, expectedDraftCommitSha: token, confirmed: true })).syncState).toBe('LOCAL_CHANGES')
    expect(f.store.get(f.skill.id).source?.state).toBe('CONFIRMED')
    expect((await f.sync.publish()).syncState).toBe('SYNCED')
    expect(f.store.get(f.skill.id).source?.state).toBe('REMOVED')
    expect(f.store.history(f.skill.id)).toHaveLength(2)
    const cutover = await f.sync.completeLocalCutover(true)
    expect(cutover.lastError).toBeNull()
    expect(f.store.usesLocalAuthority()).toBe(true)
    expect(cutover.publication?.candidateCommitSha).toBe(draft.workspaceCommitSha)
    expect(f.store.history(f.skill.id, { version: 2 }).package.skillMd).toContain('candidate')
  }, 120000)

  it('automatically publishes consecutive saves only under the bound credential authorization', async () => {
    const f = await fixture()
    await f.sync.bindRepository(f.record.id)
    await f.sync.configureAutomation({ autoPublish: true, autoUpdate: false, confirmed: true, expectedRepositoryId: 'github-id', expectedBranch: 'main' })
    const push = vi.spyOn(f.transport, 'push')
    let token: string | undefined
    for (const text of ['automatic one', 'automatic two', 'automatic three']) {
      token = (await f.sync.saveDraft({ skillId: f.skill.id, expectedVersion: 1, expectedDraftCommitSha: token, package: pkg(text), origin: 'UI' })).workspaceCommitSha
    }
    await f.sync.syncNow()
    expect(f.store.get(f.skill.id).currentVersion).toBe(4)
    expect(push).toHaveBeenCalled()
    const count = push.mock.calls.length
    vi.spyOn(f.transport, 'authorizationIdentity').mockReturnValue('different-credential')
    await f.sync.saveDraft({ skillId: f.skill.id, expectedVersion: 4, package: pkg('blocked grant'), origin: 'UI' })
    await f.sync.syncNow()
    expect(push).toHaveBeenCalledTimes(count)
    expect(f.store.get(f.skill.id).currentVersion).toBe(4)
  }, 90000)

  it('rejects rewritten main and unsafe workspace links while preserving the last accepted snapshot', async () => {
    const f = await fixture()
    await f.sync.bindRepository(f.record.id)
    const baseline = f.store.getGitAuthority()!.processedCommitSha
    await f.externalCommit('accepted advance')
    await f.sync.syncNow()
    const accepted = f.store.getGitAuthority()!.processedCommitSha
    await gitExec(f.remote, ['update-ref', 'refs/heads/main', baseline])
    const rewritten = await f.sync.syncNow()
    expect(rewritten.syncState).not.toBe('SYNCED')
    expect(f.store.getGitAuthority()!.processedCommitSha).toBe(accepted)
    const workspace = rewritten.publication!.workspacePath!
    const target = join(f.root, 'sentinel')
    writeFile(target, 'SKILL.md', pkg('external sentinel').skillMd)
    rmSync(join(workspace, 'skills', 'alpha'), { recursive: true })
    symlinkSync(target, join(workspace, 'skills', 'alpha'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(f.sync.saveDraft({ skillId: f.skill.id, expectedVersion: 2, package: pkg('unsafe edit'), origin: 'UI' })).rejects.toThrow()
    expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toBe(pkg('external sentinel').skillMd)
  }, 45000)

  it('pins exact committed bytes without reading dirty worktrees or a candidate branch', async () => {
    const f = await fixture()
    const head = await f.git.resolveCommit(f.human, 'HEAD')
    writeFile(f.human, 'skills/alpha/SKILL.md', pkg('dirty').skillMd)
    const snapshot = await readAcademyGitSnapshot(f.git, f.human, { repositoryId: 'repo', remoteUrl: f.remote, branch: 'main', sourceCommitSha: head, observedAt: new Date().toISOString() })
    expect(snapshot.skills[0].package.skillMd).toBe(pkg().skillMd)
    expect(snapshot.sourceCommitSha).toBe(head)
  }, 30000)

  it('cuts over without a push, preserves disabled private skills and never edits the developer checkout', async () => {
    const f = await fixture()
    const privateSkill = f.store.create({ package: pkg('private', 'secret'), scope: 'GLOBAL', origin: 'UI' })
    f.store.setEnabled(privateSkill.id, false, 1)
    const push = vi.spyOn(f.transport, 'push')
    const head = await f.git.resolveCommit(f.human, 'HEAD')
    const result = await f.sync.bindRepository(f.record.id)
    expect(result.syncState, result.lastError ?? '').toBe('SYNCED')
    expect(push).not.toHaveBeenCalled()
    expect(f.store.history(privateSkill.id)).toHaveLength(1)
    expect(f.store.getGitSnapshot('github-id', head)!.skills.map(skill => skill.name)).toEqual(['alpha'])
    expect(await f.git.resolveCommit(f.human, 'HEAD')).toBe(head)
    expect(readFileSync(join(f.human, 'README.md'), 'utf8')).toBe('external documentation')
    const sourceRoot = result.publication!.checkoutPath
    writeFile(sourceRoot, '.git/hooks/post-merge', '#!/bin/sh\nprintf executed > hook-was-run\n')
    await f.externalCommit('remote update with inert scripts')
    expect((await f.sync.syncNow()).syncState).toBe('SYNCED')
    expect(existsSync(join(sourceRoot, 'hook-was-run'))).toBe(false)
  }, 30000)

  it('preserves divergent migration across restart until an exact reviewed reconciliation', async () => {
    const f = await fixture('local private edit')
    const result = await f.sync.bindRepository(f.record.id)
    expect(result.syncState).toBe('CONFLICT')
    expect(f.store.getGitAuthority()).toBeNull()
    const restarted = f.restart()
    await restarted.recoverOnStartup()
    expect(f.store.history(f.skill.id)[0].package.skillMd).toContain('local private edit')
    const before = result.publication!
    expect(await f.git.getRemoteUrl(before.migrationCandidatePath!)).toBeNull()
    expect(readFileSync(join(before.migrationCandidatePath!, 'skills', 'alpha', 'SKILL.md'), 'utf8')).toContain('local private edit')
    const accepted = await restarted.completeMigration(before.remoteHead!, before.migrationCandidateHash!, true)
    expect(accepted.syncState, accepted.lastError ?? '').toBe('SYNCED')
    expect(f.store.history(f.skill.id)).toHaveLength(2)
    expect(f.store.history(f.skill.id)[1].package.skillMd).toContain('local private edit')
  }, 30000)

  it('ingests three external commits from one refresh in order and a repeated refresh is idempotent', async () => {
    const f = await fixture()
    expect((await f.sync.bindRepository(f.record.id)).syncState).toBe('SYNCED')
    const commits = []
    for (const text of ['second', 'third', 'canonical']) commits.push(await f.externalCommit(text, 'alpha', false))
    await gitExec(f.human, ['push', 'origin', 'main'])
    const result = await f.sync.syncNow()
    expect(result.syncState, result.lastError ?? '').toBe('SYNCED')
    expect(f.store.history(f.skill.id).map(version => version.gitSource?.sourceCommitSha)).toEqual([...commits].reverse().concat([undefined as any]))
    await f.sync.syncNow()
    expect(f.store.get(f.skill.id).currentVersion).toBe(4)
    await f.externalCommit('other skill', 'beta')
    await f.sync.syncNow()
    expect(f.store.get(f.skill.id).currentVersion).toBe(4)
  }, 60000)

  it('keeps remote observation separate from ingestion and reports offline honestly', async () => {
    const f = await fixture()
    await f.sync.bindRepository(f.record.id)
    const cachedCommit = f.store.getGitAuthority()!.processedCommitSha
    await f.externalCommit('remote advance')
    expect((await f.sync.fetch()).syncState).toBe('REMOTE_CHANGES')
    expect(f.store.get(f.skill.id).currentVersion).toBe(1)
    vi.spyOn(f.transport, 'fetch').mockRejectedValue(new Error('offline'))
    expect((await f.sync.syncNow()).syncState).toBe('OFFLINE')
    expect(f.store.get(f.skill.id).currentVersion).toBe(1)
    await expect(f.sync.getSourceSnapshot({ mode: 'LATEST' })).rejects.toThrow('GIT_SOURCE_LATEST_UNVERIFIED')
    const rebuild = await f.sync.getSourceSnapshot({ mode: 'REBUILD', sourceCommitSha: cachedCommit })
    expect(rebuild.remoteConfirmation).toBe('CACHED')
    expect(rebuild.snapshot.canonicalVersions?.['skills/alpha']).toEqual({ skillId: f.skill.id, version: 1 })
  }, 30000)

  it('refuses committed symlinks without materialization or following their target', async () => {
    const f = await fixture()
    await f.sync.bindRepository(f.record.id)
    writeFile(f.human, 'target.txt', '../../sentinel')
    const blob = (await gitExec(f.human, ['hash-object', '-w', '--', 'target.txt'])).trim()
    await gitExec(f.human, ['update-index', '--add', '--cacheinfo', '120000', blob, 'skills/unsafe'])
    await gitExec(f.human, ['commit', '-m', 'unsafe tree'])
    await gitExec(f.human, ['push', 'origin', 'main'])
    const result = await f.sync.syncNow()
    expect(result.syncState).not.toBe('SYNCED')
    expect(f.store.get(f.skill.id).currentVersion).toBe(1)
  }, 30000)

  it('recovers idempotently from an interrupted prepareLocalCommit workspace and updates convergence checkpoint', async () => {
    const f = await fixture()
    await f.sync.bindRepository(f.record.id)
    await f.sync.completeLocalCutover(true)
    const cutover = await f.sync.publish()
    expect(cutover.syncState, cutover.lastError ?? '').toBe('SYNCED')
    const workspace = cutover.publication!.workspacePath!

    const updated = f.store.update({ skillId: f.skill.id, expectedVersion: 1, package: pkg('recovered content'), origin: 'UI' })
    f.store.approvePublicSkill(updated.id, updated.currentVersion)
    writeFile(workspace, 'skills/alpha/SKILL.md', updated.current.package.skillMd)
    expect(await f.git.getOperationsStatus(workspace)).not.toBe('')

    const recovered = await f.sync.syncNow()
    expect(recovered.lastError).toBeNull()
    expect(recovered.syncState).toBe('LOCAL_CHANGES')
    expect(await f.git.getOperationsStatus(workspace)).toBe('')

    const published = await f.sync.publish()
    expect(published.syncState, published.lastError ?? '').toBe('SYNCED')
    expect(published.convergence?.pending).toBe(false)
    expect(published.convergence?.lastConvergedRevision).toBe(published.convergence?.localRevision)

    writeFile(workspace, '.academy/identities.json', readFileSync(join(workspace, '.academy/identities.json'), 'utf8'))
    await gitExec(workspace, ['add', '--', '.academy/identities.json'])
    const stillSynced = await f.sync.syncNow()
    expect(stillSynced.syncState, stillSynced.lastError ?? '').toBe('SYNCED')
    expect(stillSynced.lastError).toBeNull()
  }, 60000)

  it('preserves unknown external workspace edits byte-for-byte without false SYNCED or destructive reset', async () => {
    const f = await fixture()
    await f.sync.bindRepository(f.record.id)
    await f.sync.completeLocalCutover(true)
    const cutover = await f.sync.publish()
    expect(cutover.syncState).toBe('SYNCED')
    const workspace = cutover.publication!.workspacePath!

    writeFile(workspace, 'notes.txt', 'external operator note')
    const originalSkill = readFileSync(join(workspace, 'skills/alpha/SKILL.md'), 'utf8')
    const externalSkill = pkg('uncommitted external edit').skillMd
    writeFile(workspace, 'skills/alpha/SKILL.md', externalSkill)

    const status = await f.sync.syncNow()
    expect(status.syncState).toBe('LOCAL_CHANGES')
    expect(status.lastError).toBe('WORKSPACE_EXTERNAL_CHANGES_REVIEW_REQUIRED')
    expect(readFileSync(join(workspace, 'notes.txt'), 'utf8')).toBe('external operator note')
    expect(readFileSync(join(workspace, 'skills/alpha/SKILL.md'), 'utf8')).toBe(externalSkill)
    expect(originalSkill).not.toBe(externalSkill)

    const blocked = await f.sync.publish()
    expect(blocked.lastError).toBe('GIT_PUBLICATION_REQUIRES_RECONCILIATION')
    expect(blocked.syncState).toBe('LOCAL_CHANGES')
    expect(readFileSync(join(workspace, 'notes.txt'), 'utf8')).toBe('external operator note')
  }, 60000)

  it('requires verified checkpoint and observation freshness for SYNCED and stops autoPublish cleanly on non-retryable state', async () => {
    const f = await fixture()
    await f.sync.bindRepository(f.record.id)
    await f.sync.completeLocalCutover(true)
    await f.sync.publish()
    const configured = await f.sync.configureAutomation({
      autoPublish: true, autoUpdate: false, confirmed: true,
      expectedRepositoryId: f.record.github!.repositoryId, expectedBranch: 'main'
    })
    expect(configured.syncState).toBe('SYNCED')

    vi.spyOn(f.transport, 'push').mockRejectedValue(new Error('GH006 protected branch requires pull request'))
    const v2 = f.store.update({ skillId: f.skill.id, expectedVersion: 1, package: pkg('pr blocked'), origin: 'UI' })
    f.store.approvePublicSkill(v2.id, v2.currentVersion)
    f.sync.scheduleLocalChange()
    await vi.waitFor(() => expect(f.sync.getStatus().syncState).toBe('PR_PENDING'), { timeout: 15000 })
    expect(f.transport.push).toHaveBeenCalledTimes(1)
  }, 60000)
})
