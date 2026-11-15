import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { buildSync } from 'esbuild'
import { expect, it } from 'vitest'
import { authenticatedAgentPrincipal, authorizeArtifactAgent } from '../continuum/agent-authority'
import { GitService } from '../core/git-service'
import { GitWorktreeRegistry } from '../git-operations/git-worktree-registry'
import { nativeObservationBatch } from './native-hook-ingestion'
import { nativeDigest, nativeGitIdentity, normalizeNativeHook } from './native-hooks'
import { sessionRepositoryReader } from './session-repository-read'
import { SessionStore, sessionStorePath } from './store'

it('routes native reads through one authorized Catalog store and preserves checkout, SQLite and principal scope', async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'session-repository-read-')))
  const git = new GitService()
  let active = 'alpha'
  let authenticated = true
  let hidden = false
  const roots = new Map<string, string>()
  const selections = new Map<string, { id: string; worktreeId: string; generation: string }>()
  const sha = (input: string) => nativeDigest(input)
  const command = (...args: string[]) => execFileSync('git', args, { windowsHide: true, stdio: 'pipe' })
  try {
    for (const id of ['alpha', 'beta']) {
      const root = join(base, id), linked = root + '-linked'
      command('init', '-b', 'main', root)
      command('-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'baseline')
      command('-C', root, 'worktree', 'add', '-b', 'pilot', linked)
      roots.set(id, root)
      const registry = new GitWorktreeRegistry(root, git, { repositoryId: id, isActive: () => true })
      const { worktrees } = await registry.discover()
      expect(worktrees).toHaveLength(2)
      const store = new SessionStore(sessionStorePath(base, id), id)
      try {
        for (const tree of worktrees) {
          const key = tree.branch === 'pilot' ? id : id + '-root'
          const binding = { schema: 1 as const, enabled: true, repositoryId: id, worktreeId: tree.worktreeId,
            generation: tree.generation, ...nativeGitIdentity(tree.path), spool: join(tree.path, 'unused-spool') }
          const event = normalizeNativeHook({
            cwd: tree.path, session_id: key, hook_event_name: 'SessionStart'
          }, binding, new Date('2026-11-15T10:00:00.000Z'))
          selections.set(key, { id: event.sessionId, worktreeId: tree.worktreeId, generation: tree.generation })
          store.registry.apply(nativeObservationBatch(event), undefined)
        }
      } finally { store.close() }
    }
    const betaStore = sessionStorePath(base, 'beta')
    const grantPath = join(dirname(betaStore), 'session-context.provider.json')
    const grant = () => writeFileSync(grantPath, JSON.stringify({ repositoryId: 'beta', mcpSessionReaders: ['alpha'] }))
    const bytes = sha(readFileSync(betaStore).toString('base64'))
    const workerPath = join(base, 'worker.cjs')
    const code = buildSync({ entryPoints: ['src/main/session-context/worker.ts'], bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false }).outputFiles[0].text
    writeFileSync(workerPath, 'require = require("node:module").createRequire(' + JSON.stringify(resolve('package.json')) + ');\n' + code)
    const catalog = {
      resolveAvailable(id: string) {
        const path = roots.get(id)
        if (!path || hidden) throw new Error('LOCAL_CHECKOUT_UNAVAILABLE')
        return { id, name: id, status: 'ACTIVE' as const, localCheckout: { path, availability: 'AVAILABLE' as const, gitState: 'GIT' as const }, github: null, createdAt: '', updatedAt: '' }
      }
    }
    const principal = authenticatedAgentPrincipal('MCP', () => authenticated)
    const authority = authorizeArtifactAgent(principal, 'alpha', () => active === 'alpha')
    const reader = sessionRepositoryReader(catalog, git, base, 'alpha', workerPath)
    const list = () => reader('beta', 'list_agent_sessions', { source: 'NATIVE_HOOK' }, authority)
    await expect(list()).rejects.toThrow()
    grant()
    const result = await list()
    const data = JSON.stringify(result)
    expect(result.isError, result.content[0].text).toBeFalsy()
    expect(data).toContain(selections.get('beta')!.id)
    expect(data).toContain(selections.get('beta-root')!.id)
    expect(data).not.toContain(selections.get('alpha')!.id)
    expect(data).not.toContain(selections.get('alpha-root')!.id)
    const linked = await reader('beta', 'inspect_agent_session', {
      nativeSession: { provider: 'codex-native', ...selections.get('beta') },
      sourceSessionId: '019ba000-0000-7000-8000-000000000001'
    }, authority)
    expect(JSON.parse(linked.content[0].text)).toEqual({ code: 'SOURCE_IDENTITY_CONFLICT' })
    expect(sha(readFileSync(betaStore).toString('base64'))).toBe(bytes)
    expect(active).toBe('alpha')
    hidden = true
    await expect(list()).rejects.toThrow()
    hidden = false
    writeFileSync(grantPath, JSON.stringify({ repositoryId: 'beta', mcpSessionReaders: [] }))
    await expect(list()).rejects.toThrow('REPOSITORY_NOT_AUTHORIZED')
    grant()
    authenticated = false
    await expect(list()).rejects.toThrow('AGENT_UNAUTHORIZED')
    authenticated = true
    active = 'beta'
    await expect(list()).rejects.toThrow('AGENT_UNAUTHORIZED')
  } finally {
    if (process.platform === 'win32') execFileSync('node', ['-e', "require('node:fs').rmSync(process.argv[1], { recursive: true, force: true, maxRetries: 5 })", base], { windowsHide: true })
    else rmSync(base, { recursive: true, force: true, maxRetries: 5 })
  }
}, 60_000)
