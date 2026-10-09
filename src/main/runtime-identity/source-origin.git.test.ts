import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitService } from '../core/git-service'
import { GitWorktreeRegistry } from '../git-operations/git-worktree-registry'
import { RuntimeIdentityProvider } from './runtime-identity-provider'
import { SourceFingerprintCollector } from './source-fingerprint'
import { executeGetRuntimeIdentity } from './runtime-identity-mcp'

const roots: string[] = []
const temporary = () => { const root = mkdtempSync(join(tmpdir(), 'runtime-origin-')); roots.push(root); return root }
const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0).reverse()) rmSync(root, { recursive: true, force: true })
})

describe('startup source provenance with real Git', () => {
  it('identifies the secondary worktree and freezes branch/HEAD independently of later Git and collector options', async () => {
    const main = temporary()
    git(main, 'init', '-b', 'main')
    writeFileSync(join(main, 'package.json'), '{}')
    git(main, 'add', 'package.json')
    git(main, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'initial')
    const secondary = join(main, 'secondary')
    git(main, 'worktree', 'add', '-b', 'secondary', secondary)
    const provider = new RuntimeIdentityProvider({ rootDir: main, collector: new SourceFingerprintCollector({ rootDir: secondary }) })
    await provider.sourceOriginReady
    const origin = provider.getIdentityPayload().sourceOrigin
    expect(origin).toMatchObject({ status: 'GIT_WORKTREE', sourceRootPath: secondary,
      worktree: { rootPath: realpathSync(secondary), branch: 'secondary', head: git(secondary, 'rev-parse', 'HEAD'), detached: false, worktreeId: null } })
    await provider.bindSourceOrigin([{ repositoryId: 'canonical-test-repository', rootPath: main }])
    const registry = new GitWorktreeRegistry(main, new GitService(), { repositoryId: 'canonical-test-repository', isActive: () => true })
    const published = (await registry.discover()).worktrees.find(record => realpathSync(record.path) === realpathSync(secondary))!
    expect(provider.getIdentityPayload().sourceOrigin.worktree!.worktreeId).toBe(published.worktreeId)
    origin.worktree!.worktreeId = published.worktreeId
    git(secondary, 'switch', '--detach')
    expect(provider.getIdentityPayload().sourceOrigin).toEqual(origin)
    expect(provider.getIdentityPayload().freshness.state).toBe('MATCH')
    const detached = new RuntimeIdentityProvider({ rootDir: secondary })
    await detached.sourceOriginReady
    expect(detached.getIdentityPayload().sourceOrigin.worktree).toMatchObject({ branch: null, detached: true })
    const projected = JSON.parse((executeGetRuntimeIdentity(provider, {}).content[0] as { text: string }).text)
    expect(projected.sourceOrigin).toEqual(origin)
    expect(provider.getSummary()).not.toHaveProperty('sourceOrigin')
    origin.worktree!.branch = 'tampered'
    expect(provider.getIdentityPayload().sourceOrigin.worktree!.branch).toBe('secondary')
  })

  it('distinguishes non-Git, inaccessible Git and packaged execution without breaking identity', async () => {
    const root = temporary()
    const plain = new RuntimeIdentityProvider({ rootDir: root })
    await plain.sourceOriginReady
    expect(plain.getIdentityPayload().sourceOrigin).toMatchObject({ status: 'NON_GIT', sourceRootPath: root, worktree: null })
    vi.stubEnv('PATH', '')
    const unavailable = new RuntimeIdentityProvider({ rootDir: root })
    await unavailable.sourceOriginReady
    expect(unavailable.getIdentityPayload().sourceOrigin).toMatchObject({ status: 'UNAVAILABLE', sourceRootPath: root, worktree: null })
    expect(unavailable.getIdentityPayload().freshness.state).toBe('MATCH')
    const packaged = new RuntimeIdentityProvider({ rootDir: root, packaged: true })
    await packaged.sourceOriginReady
    expect(packaged.getIdentityPayload().sourceOrigin).toMatchObject({ status: 'NOT_APPLICABLE', sourceRootPath: null, worktree: null })
  })
})
