import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcademyStore } from '../academy-store'
import { AcademyGitMaterializer } from './academy-git-materializer'
import { AcademyGitSyncService } from './academy-git-sync-service'
import { AcademyPluginRepositoryProjection } from './academy-plugin-repository-projection'
import type { GitRemoteTransport, AcademyGitRepositoryPort } from './academy-git-sync-service'
import type { RepositoryRecord } from '../../../shared/types/repository-catalog-types'
import { GitService } from '../../core/git-service'
import { createTempGitRepo, cleanupTempRepo } from '../../core/git-test-helpers'

const roots: string[] = []
const root = () => {
  const value = mkdtempSync(join(tmpdir(), 'academy-sync-svc-'))
  roots.push(value)
  return value
}

afterEach(async () => {
  for (const dir of roots.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})

describe('AcademyGitSyncService', () => {
  it('coordinates bind -> materialize -> commit -> push -> SYNCED', async () => {
    const dataDir = root()
    const store = new AcademyStore(join(dataDir, 'academy.db'))
    const repoPath = await createTempGitRepo()
    roots.push(repoPath)

    // Create initial commit in repo
    const git = new GitService()
    writeFileSync(join(repoPath, 'README.md'), '# Initial')
    await git.stagePaths(repoPath, ['README.md'])
    await git.commit(repoPath, 'initial repo commit')

    // Create a GLOBAL + ACTIVE skill in Academy
    store.create({
      package: {
        skillMd: '---\nname: my-skill\ndescription: A test skill\n---\n# My Skill Content\n',
        artifacts: {}
      },
      scope: 'GLOBAL',
      origin: 'UI'
    })

    const pushedBranches: string[] = []
    const mockTransport: GitRemoteTransport = {
      push: async (rPath, branch) => {
        pushedBranches.push(`${rPath}:${branch}`)
      }
    }

    const mockRepoRecord: RepositoryRecord = {
      id: 'repo-cat-1',
      name: 'Academy',
      status: 'ACTIVE',
      localCheckout: {
        path: repoPath,
        availability: 'AVAILABLE',
        gitState: 'GIT'
      },
      github: {
        repositoryId: 'gh-1234',
        name: 'Academy',
        fullName: 'ericrocha001/Academy',
        owner: 'ericrocha001',
        visibility: 'PUBLIC',
        cloneUrl: 'https://github.com/ericrocha001/Academy.git',
        htmlUrl: 'https://github.com/ericrocha001/Academy',
        accessState: 'AVAILABLE',
        lastSeenAt: new Date().toISOString()
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }

    const mockRepoPort: AcademyGitRepositoryPort = {
      resolveRepository: (id) => (id === 'repo-cat-1' ? mockRepoRecord : null),
      findByGitHubId: (ghId) => (ghId === 'gh-1234' ? mockRepoRecord : null),
      listEligibleRepositories: () => [mockRepoRecord]
    }

    const materializer = new AcademyGitMaterializer()
    const syncService = new AcademyGitSyncService(
      store,
      materializer,
      git,
      mockTransport,
      mockRepoPort
    )

    // Bind
    const boundStatus = await syncService.bindRepository('repo-cat-1')
    expect(boundStatus.syncState).toBe('SYNCED')
    expect(pushedBranches).toHaveLength(1)
    expect(existsSync(join(repoPath, 'skills/my-skill/SKILL.md'))).toBe(true)

    // Working tree is clean in skills
    expect(await git.hasWorkingTreeChanges(repoPath, 'skills')).toBe(false)

    // Commit exists
    const headCommit = await git.getCurrentCommitHash(repoPath)
    expect(boundStatus.lastCommitSha).toBe(headCommit)
    expect(boundStatus.profile?.lastPushedCommitSha).toBe(headCommit)

    store.close()
  })

  it('preserves commit when push fails (offline -> PUSH_PENDING) and pushes existing commit on retry', async () => {
    const dataDir = root()
    const store = new AcademyStore(join(dataDir, 'academy.db'))
    const repoPath = await createTempGitRepo()
    roots.push(repoPath)

    const git = new GitService()
    writeFileSync(join(repoPath, 'README.md'), '# Initial')
    await git.stagePaths(repoPath, ['README.md'])
    await git.commit(repoPath, 'initial')

    store.create({
      package: {
        skillMd: '---\nname: offline-skill\ndescription: Test offline\n---\n# Offline Skill\n',
        artifacts: {}
      },
      scope: 'GLOBAL',
      origin: 'UI'
    })

    let shouldFailPush = true
    const pushCalls: string[] = []
    const mockTransport: GitRemoteTransport = {
      push: async (_rPath, branch) => {
        pushCalls.push(branch)
        if (shouldFailPush) {
          throw new Error('Network error: Could not resolve host github.com')
        }
      }
    }

    const mockRepoRecord: RepositoryRecord = {
      id: 'repo-1',
      name: 'Academy',
      status: 'ACTIVE',
      localCheckout: { path: repoPath, availability: 'AVAILABLE', gitState: 'GIT' },
      github: {
        repositoryId: 'gh-1',
        name: 'Academy',
        fullName: 'ericrocha001/Academy',
        owner: 'ericrocha001',
        visibility: 'PUBLIC',
        cloneUrl: 'https://github.com/ericrocha001/Academy.git',
        htmlUrl: 'https://github.com/ericrocha001/Academy',
        accessState: 'AVAILABLE',
        lastSeenAt: new Date().toISOString()
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }

    const mockRepoPort: AcademyGitRepositoryPort = {
      resolveRepository: () => mockRepoRecord,
      findByGitHubId: () => mockRepoRecord,
      listEligibleRepositories: () => [mockRepoRecord]
    }

    const syncService = new AcademyGitSyncService(
      store,
      new AcademyGitMaterializer(),
      git,
      mockTransport,
      mockRepoPort
    )

    // Bind with failing push
    const status1 = await syncService.bindRepository('repo-1')
    expect(status1.syncState).toBe('PUSH_PENDING')
    expect(status1.lastCommitSha).toBeDefined()
    expect(status1.profile?.lastPushedCommitSha).toBeNull()

    const createdCommit = status1.lastCommitSha

    // Retry while online: same commit should be pushed, no new commit created!
    shouldFailPush = false
    const status2 = await syncService.syncNow()
    expect(status2.syncState).toBe('SYNCED')
    expect(status2.lastCommitSha).toBe(createdCommit)
    expect(status2.profile?.lastPushedCommitSha).toBe(createdCommit)

    // Current HEAD is still the same commit
    const currentHead = await git.getCurrentCommitHash(repoPath)
    expect(currentHead).toBe(createdCommit)

    store.close()
  })

  it('detects uncommitted LOCAL_DRIFT in skills/ and refuses to overwrite', async () => {
    const dataDir = root()
    const store = new AcademyStore(join(dataDir, 'academy.db'))
    const repoPath = await createTempGitRepo()
    roots.push(repoPath)

    const git = new GitService()
    writeFileSync(join(repoPath, 'README.md'), '# Initial')
    await git.stagePaths(repoPath, ['README.md'])
    await git.commit(repoPath, 'initial')

    store.create({
      package: {
        skillMd: '---\nname: drift-skill\ndescription: Test drift\n---\n# Drift\n',
        artifacts: {}
      },
      scope: 'GLOBAL',
      origin: 'UI'
    })

    const mockRepoRecord: RepositoryRecord = {
      id: 'repo-1',
      name: 'Academy',
      status: 'ACTIVE',
      localCheckout: { path: repoPath, availability: 'AVAILABLE', gitState: 'GIT' },
      github: {
        repositoryId: 'gh-1',
        name: 'Academy',
        fullName: 'ericrocha001/Academy',
        owner: 'ericrocha001',
        visibility: 'PUBLIC',
        cloneUrl: 'https://github.com/ericrocha001/Academy.git',
        htmlUrl: 'https://github.com/ericrocha001/Academy',
        accessState: 'AVAILABLE',
        lastSeenAt: new Date().toISOString()
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }

    const syncService = new AcademyGitSyncService(
      store,
      new AcademyGitMaterializer(),
      git,
      { push: async () => {} },
      {
        resolveRepository: () => mockRepoRecord,
        findByGitHubId: () => mockRepoRecord,
        listEligibleRepositories: () => [mockRepoRecord]
      }
    )

    // First sync
    await syncService.bindRepository('repo-1')

    // Human makes uncommitted manual change inside skills/
    writeFileSync(join(repoPath, 'skills/drift-skill/SKILL.md'), '# Manual Drift')

    // Next sync attempts to run
    const driftStatus = await syncService.syncNow()
    expect(driftStatus.syncState).toBe('LOCAL_DRIFT')

    // Content was preserved and not overwritten!
    expect(readFileSync(join(repoPath, 'skills/drift-skill/SKILL.md'), 'utf8')).toBe('# Manual Drift')

    store.close()
  })

  it('detects REMOTE_DIVERGED when push is rejected as non-fast-forward', async () => {
    const dataDir = root()
    const store = new AcademyStore(join(dataDir, 'academy.db'))
    const repoPath = await createTempGitRepo()
    roots.push(repoPath)

    const git = new GitService()
    writeFileSync(join(repoPath, 'README.md'), '# Initial')
    await git.stagePaths(repoPath, ['README.md'])
    await git.commit(repoPath, 'initial')

    store.create({
      package: {
        skillMd: '---\nname: diverged-skill\ndescription: Test divergence\n---\n# Content\n',
        artifacts: {}
      },
      scope: 'GLOBAL',
      origin: 'UI'
    })

    const mockRepoRecord: RepositoryRecord = {
      id: 'repo-1',
      name: 'Academy',
      status: 'ACTIVE',
      localCheckout: { path: repoPath, availability: 'AVAILABLE', gitState: 'GIT' },
      github: {
        repositoryId: 'gh-1',
        name: 'Academy',
        fullName: 'ericrocha001/Academy',
        owner: 'ericrocha001',
        visibility: 'PUBLIC',
        cloneUrl: 'https://github.com/ericrocha001/Academy.git',
        htmlUrl: 'https://github.com/ericrocha001/Academy',
        accessState: 'AVAILABLE',
        lastSeenAt: new Date().toISOString()
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }

    const mockTransport: GitRemoteTransport = {
      push: async () => {
        throw new Error('Updates were rejected because the remote contains work that you do not have locally (non-fast-forward)')
      }
    }

    const syncService = new AcademyGitSyncService(
      store,
      new AcademyGitMaterializer(),
      git,
      mockTransport,
      {
        resolveRepository: () => mockRepoRecord,
        findByGitHubId: () => mockRepoRecord,
        listEligibleRepositories: () => [mockRepoRecord]
      }
    )

    const status = await syncService.bindRepository('repo-1')
    expect(status.syncState).toBe('REMOTE_DIVERGED')

    store.close()
  })

  it('syncs complete agent plugin (skills/ + plugin.json + assets/logo.png) within managed boundary', async () => {
    const dataDir = root()
    const store = new AcademyStore(join(dataDir, 'academy.db'))
    const repoPath = await createTempGitRepo()
    roots.push(repoPath)

    const git = new GitService()
    writeFileSync(join(repoPath, 'README.md'), '# Academy Repository')
    writeFileSync(join(repoPath, 'unmanaged.txt'), 'do not touch')
    await git.stagePaths(repoPath, ['README.md', 'unmanaged.txt'])
    await git.commit(repoPath, 'initial')

    // Create skill
    store.create({
      package: {
        skillMd: '---\nname: plugin-skill\ndescription: Test skill for plugin\n---\n# Content\n',
        artifacts: {}
      },
      scope: 'GLOBAL',
      origin: 'UI'
    })

    // Create valid 512x512 PNG logo in temp dir
    const logoSource = join(dataDir, 'logo.png')
    const pngBuf = Buffer.alloc(24)
    Buffer.from('89504e470d0a1a0a', 'hex').copy(pngBuf)
    pngBuf.writeUInt32BE(512, 16)
    pngBuf.writeUInt32BE(512, 20)
    writeFileSync(logoSource, pngBuf)

    // Create OpenAI plugin profile
    store.createOpenAiPluginProfile({
      name: 'academy-skills',
      displayName: 'Academy Skills',
      description: 'Autonomous procedural knowledge for agents',
      author: { name: 'Academy Team' },
      openAiInterface: {
        displayName: 'Academy Skills',
        shortDescription: 'Procedural skills for agents',
        longDescription: 'Curated skills maintained canonically by Academy',
        developerName: 'Academy',
        category: 'Productivity',
        capabilities: ['Interactive'],
        defaultPrompt: ['Help me write code']
      },
      logoPath: logoSource,
      publishedVersion: '0.1.3',
      deletionSemantics: 'UNKNOWN',
      deletionSemanticsEvidence: null
    })
    store.saveMarketplaceTakeoverState({ takeoverStatus: 'TAKEOVER_UNSUPPORTED', observedPluginId: null, evidence: 'Probe created a distinct source identity.' })

    const mockRepoRecord: RepositoryRecord = {
      id: 'repo-plugin-1',
      name: 'Academy',
      status: 'ACTIVE',
      localCheckout: { path: repoPath, availability: 'AVAILABLE', gitState: 'GIT' },
      github: {
        repositoryId: 'gh-p1',
        name: 'Academy',
        fullName: 'ericrocha001/Academy',
        owner: 'ericrocha001',
        visibility: 'PUBLIC',
        cloneUrl: 'https://github.com/ericrocha001/Academy.git',
        htmlUrl: 'https://github.com/ericrocha001/Academy',
        accessState: 'AVAILABLE',
        lastSeenAt: new Date().toISOString()
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }

    const pushed: string[] = []
    const syncService = new AcademyGitSyncService(
      store,
      new AcademyGitMaterializer(),
      git,
      { push: async () => { pushed.push('pushed') } },
      {
        resolveRepository: () => mockRepoRecord,
        findByGitHubId: () => mockRepoRecord,
        listEligibleRepositories: () => [mockRepoRecord]
      },
      undefined,
      new AcademyPluginRepositoryProjection()
    )

    const status = await syncService.bindRepository('repo-plugin-1')
    expect(status.syncState).toBe('SYNCED')
    expect(pushed).toHaveLength(1)

    // Check materialized files
    expect(existsSync(join(repoPath, 'skills', 'plugin-skill', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(repoPath, 'plugin.json'))).toBe(true)
    expect(existsSync(join(repoPath, 'assets', 'logo.png'))).toBe(true)
    expect(existsSync(join(repoPath, '.agents', 'plugins', 'marketplace.json'))).toBe(true)

    // Check manifest content
    const manifest = JSON.parse(readFileSync(join(repoPath, 'plugin.json'), 'utf8'))
    expect(manifest.name).toBe('academy-skills')
    expect(manifest.version).toBe('0.1.3')
    expect(manifest.extensions['com.openai'].interface.logo).toBe('./assets/logo.png')
    const marketplace = readFileSync(join(repoPath, '.agents', 'plugins', 'marketplace.json'), 'utf8')
    expect(marketplace).not.toContain('plugins_')

    // Check unmanaged files are completely untouched
    expect(readFileSync(join(repoPath, 'README.md'), 'utf8')).toBe('# Academy Repository')
    expect(readFileSync(join(repoPath, 'unmanaged.txt'), 'utf8')).toBe('do not touch')

    // Verify git status: working tree is clean
    const hasAnyChanges = await git.hasWorkingTreeChanges(repoPath, '.')
    expect(hasAnyChanges).toBe(false)

    // Now test managed boundary with untracked file
    writeFileSync(join(repoPath, 'arbitrary-file.txt'), 'untracked human content')

    // Update skill to trigger new sync
    const skill = store.list('ACTIVE')[0]
    store.update({
      skillId: skill.id,
      expectedVersion: skill.currentVersion,
      package: {
        skillMd: '---\nname: plugin-skill\ndescription: Updated skill\n---\n# Updated Content\n',
        artifacts: {}
      },
      origin: 'UI'
    })

    const updatedStatus = await syncService.syncNow()
    expect(updatedStatus.syncState).toBe('SYNCED')

    // arbitrary-file.txt must NOT have been staged or committed — it remains untracked!
    const untrackedStillThere = existsSync(join(repoPath, 'arbitrary-file.txt'))
    expect(untrackedStillThere).toBe(true)
    const hasUncommittedArbitrary = await git.hasWorkingTreeChanges(repoPath, 'arbitrary-file.txt')
    expect(hasUncommittedArbitrary).toBe(true) // Git still sees it as untracked, was not staged

    store.close()
  }, 20000)

  it('fails sync when plugin projection validation fails', async () => {
    const dataDir = root()
    const store = new AcademyStore(join(dataDir, 'academy.db'))
    const repoPath = await createTempGitRepo()
    roots.push(repoPath)

    const git = new GitService()
    writeFileSync(join(repoPath, 'README.md'), '# Initial')
    await git.stagePaths(repoPath, ['README.md'])
    await git.commit(repoPath, 'initial')

    store.create({
      package: {
        skillMd: '---\nname: valid-skill\ndescription: Test\n---\n# Valid\n',
        artifacts: {}
      },
      scope: 'GLOBAL',
      origin: 'UI'
    })

    // Configure profile with non-existent logo
    store.createOpenAiPluginProfile({
      name: 'academy-skills',
      displayName: 'Academy Skills',
      description: 'Test',
      author: { name: 'Academy' },
      openAiInterface: {
        displayName: 'Academy Skills',
        shortDescription: 'Desc',
        longDescription: 'Long',
        developerName: 'Dev',
        category: 'Productivity',
        capabilities: ['Interactive'],
        defaultPrompt: ['Prompt']
      },
      logoPath: join(dataDir, 'does-not-exist.png'),
      publishedVersion: '0.1.3',
      deletionSemantics: 'UNKNOWN',
      deletionSemanticsEvidence: null
    })
    store.saveMarketplaceTakeoverState({ takeoverStatus: 'TAKEOVER_UNSUPPORTED', observedPluginId: null, evidence: 'Probe created a distinct source identity.' })

    const mockRepoRecord: RepositoryRecord = {
      id: 'repo-fail-1',
      name: 'Academy',
      status: 'ACTIVE',
      localCheckout: { path: repoPath, availability: 'AVAILABLE', gitState: 'GIT' },
      github: {
        repositoryId: 'gh-f1',
        name: 'Academy',
        fullName: 'ericrocha001/Academy',
        owner: 'ericrocha001',
        visibility: 'PUBLIC',
        cloneUrl: 'https://github.com/ericrocha001/Academy.git',
        htmlUrl: 'https://github.com/ericrocha001/Academy',
        accessState: 'AVAILABLE',
        lastSeenAt: new Date().toISOString()
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }

    const syncService = new AcademyGitSyncService(
      store,
      new AcademyGitMaterializer(),
      git,
      { push: async () => {} },
      {
        resolveRepository: () => mockRepoRecord,
        findByGitHubId: () => mockRepoRecord,
        listEligibleRepositories: () => [mockRepoRecord]
      },
      undefined,
      new AcademyPluginRepositoryProjection()
    )

    const status = await syncService.bindRepository('repo-fail-1')
    expect(status.syncState).toBe('ERROR')
    expect(status.lastError).toContain('Plugin validation failed')

    store.close()
  }, 20000)
})
