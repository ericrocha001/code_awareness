import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { buildSync } from 'esbuild'
import { expect, test, vi } from 'vitest'
import { GitService } from '../core/git-service'
import { GitWorktreeRegistry } from '../git-operations/git-worktree-registry'
import { enrollNativeHooks, enrolledNativeStatus, prepareEnrolledNativeHooks, revokeNativeHooks } from './native-hook-enrollment'
import { hookPaths, inspectSharedNativeInstallation } from './native-hook-installation'
import { nativeDigest, parseNativeEnvelope, readNativeBinding } from './native-hooks'
import { SessionStore, sessionStorePath } from './store'
import { ingestNativeHooks } from './native-hook-ingestion'
import { sessionTargetResolver } from './target'

const qualification = vi.hoisted(() => ({ fixturePath: '' }))
vi.mock(import('node:child_process'), async original => {
  const module = await original()
  return { ...module, execFileSync: ((binary: string, ...args: unknown[]) =>
    qualification.fixturePath && binary === qualification.fixturePath ? 'codex-cli 0.169.0-alpha.11.1' : Reflect.apply(module.execFileSync, null, [binary, ...args])) as typeof execFileSync }
})

test('two cataloged repositories use one portable helper with separate offline spools and revocation', async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'native-catalog-')))
  const profile = join(base, 'profile'), database = join(profile, 'repositories/catalog.db')
  mkdirSync(dirname(database), { recursive: true })
  const db = new DatabaseSync(database)
  db.exec(`CREATE TABLE repository_catalog_records(id TEXT PRIMARY KEY, checkout_path TEXT, status TEXT, availability TEXT, git_state TEXT);
    CREATE TABLE repository_catalog_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);`)
  const insert = db.prepare("INSERT INTO repository_catalog_records VALUES(?,?,'ACTIVE','AVAILABLE','GIT')")
  const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'core.fsmonitor=false',
    '-c', 'core.hooksPath=' + join(base, 'no-hooks'), '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
  { encoding: 'utf8', windowsHide: true, stdio: 'pipe' })
  const helperContent = buildSync({ entryPoints: ['src/main/session-context/native-hook-command.ts'], write: false,
    bundle: true, platform: 'node', format: 'cjs', define: { __CODE_AWARENESS_DISTRIBUTED_CAPTURE__: 'true' } }).outputFiles[0].text
  const helper = join(profile, 'session-context', 'native-hook-' + nativeDigest(helperContent) + '.cjs')
  const clients = { codex: join(base, process.platform === 'win32' ? 'codex.exe' : 'codex'),
    antigravity: join(base, process.platform === 'win32' ? 'Antigravity.exe' : 'antigravity') }
  for (const binary of Object.values(clients)) writeFileSync(binary, '')
  qualification.fixturePath = clients.codex
  try {
    const fixtures = []
    for (const repositoryId of ['repo-a', 'repo-b']) {
      const root = join(base, repositoryId), linked = join(base, repositoryId + '-linked')
      mkdirSync(root)
      git(root, 'init', '-b', 'main')
      git(root, 'commit', '--allow-empty', '-m', 'start')
      git(root, 'worktree', 'add', '-b', 'linked', linked)
      const registry = new GitWorktreeRegistry(root, new GitService(), { repositoryId, isActive: () => true })
      const record = await registry.resolveCheckout(linked)
      const selection = { profile, repositoryId, registry, record }
      const permission = { authorized: true, clientPath: clients.codex, nodePath: process.execPath, helperContent, managed: true }
      await expect(enrollNativeHooks({ ...selection, provider: 'codex' }, permission)).rejects.toThrow('HOOK_REPOSITORY_UNAVAILABLE')
      insert.run(repositoryId, root)
      await expect(enrollNativeHooks({ ...selection, provider: 'codex' }, { ...permission, authorized: false })).rejects.toThrow('HOOK_AUTHORIZATION_REQUIRED')
      const config = hookPaths(root).configPath
      mkdirSync(dirname(config), { recursive: true })
      const third = { type: 'command', command: 'third-party', timeout: 20 }
      writeFileSync(config, JSON.stringify({ hooks: { SessionStart: [{ hooks: [third] }] } }))
      for (const provider of ['codex', 'antigravity'] as const) {
        await expect(enrollNativeHooks({ ...selection, provider }, { ...permission, clientPath: clients[provider] })).resolves.toMatchObject({ state: 'CONFIGURED' })
        expect(enrolledNativeStatus(profile, repositoryId, provider, record)).toMatchObject({ enrolled: true, trust: 'NOT_INSPECTED' })
      }
      expect(JSON.parse(readFileSync(config, 'utf8')).hooks.SessionStart[0].hooks).toEqual([third])
      expect(inspectSharedNativeInstallation(linked, { repositoryId, ...record })?.handlers).toHaveLength(7)
      fixtures.push({ root, linked, repositoryId, record, selection })
    }
    const run = (cwd: string, anchor: string, provider: 'codex' | 'antigravity', event: string, id: string) =>
      new Promise<void>((resolve, reject) => {
        const binding = hookPaths(anchor, provider).bindingPath
        const child = execFile(process.execPath, [helper, binding], { cwd, timeout: 4000 }, error => error ? reject(error) : resolve())
        child.stdin!.end(JSON.stringify(provider === 'codex'
          ? { cwd, session_id: id, hook_event_name: event, tool_use_id: 'one', tool_name: 'Bash' }
          : { cwd, workspacePaths: [cwd], conversationId: id, hookEventName: event, toolCall: { id: 'one', name: 'run_command' } }))
      })
    const [a, b] = fixtures
    await Promise.all(fixtures.flatMap(f => [
      run(f.linked, f.root, 'codex', 'SessionStart', 'same-id'),
      run(f.linked, f.linked, 'antigravity', 'SessionStart', 'same-id')
    ]))
    const counts = fixtures.map(f => ['codex', 'antigravity'].map(provider => {
      const spool = join(hookPaths(f.linked, provider as 'codex' | 'antigravity').directory, 'spool')
      const event = readdirSync(spool).find(name => /^\d+\.json$/.test(name))!
      const value = parseNativeEnvelope(readFileSync(join(spool, event), 'utf8'))
      expect(value).toMatchObject({ repositoryId: f.repositoryId, worktreeId: f.record.worktreeId, generation: f.record.generation })
      return value.sessionId
    })).flat()
    expect(new Set(counts).size).toBe(4)
    for (const f of fixtures) {
      await Promise.all([run(f.linked, f.root, 'codex', 'PreToolUse', 'same-id'), run(f.linked, f.linked, 'antigravity', 'PreToolUse', 'same-id')])
      await Promise.all([run(f.linked, f.root, 'codex', 'PostToolUse', 'same-id'), run(f.linked, f.linked, 'antigravity', 'PostToolUse', 'same-id')])
    }
    const spoolA = join(hookPaths(a.linked).directory, 'spool'), spoolB = join(hookPaths(b.linked).directory, 'spool')
    const beforeA = readdirSync(spoolA), beforeB = readdirSync(spoolB)
    await run(b.linked, a.root, 'codex', 'PreToolUse', 'wrong-repo')
    db.prepare("UPDATE repository_catalog_records SET status='HIDDEN' WHERE id=?").run(a.repositoryId)
    await run(a.linked, a.root, 'codex', 'PreToolUse', 'hidden')
    revokeNativeHooks(profile, b.repositoryId, 'codex', true)
    await run(b.linked, b.root, 'codex', 'PreToolUse', 'revoked')
    expect(readdirSync(spoolA)).toEqual(beforeA)
    expect(readdirSync(spoolB)).toEqual(beforeB)
    expect(await prepareEnrolledNativeHooks(b.selection, 'CATALOG_CHECKOUT')).toEqual([{ provider: 'codex', state: 'NOT_ENROLLED' }, { provider: 'antigravity', state: 'CONFIGURED' }])
    for (const f of fixtures) {
      const path = sessionStorePath(profile, f.repositoryId)
      let store = new SessionStore(path, f.repositoryId)
      const resolveTarget = sessionTargetResolver(f.selection.registry, () => {})
      try {
        for (const provider of ['codex', 'antigravity'] as const) {
          const binding = readNativeBinding(hookPaths(f.linked, provider).bindingPath)
          await ingestNativeHooks(store.registry, binding, resolveTarget, () => {})
        }
        store.close(); store = new SessionStore(path, f.repositoryId)
        const events = store.registry.nativeHookEvidence(f.record.worktreeId, f.record.generation)
        expect(events.map(event => event.event).sort()).toEqual(['PostToolUse', 'PostToolUse', 'PreToolUse', 'PreToolUse', 'SessionStart', 'SessionStart'])
        const another = f === a ? b : a
        expect(store.registry.nativeHookEvidence(another.record.worktreeId, another.record.generation)).toEqual([])
      } finally { store.close() }
    }
    expect(await prepareEnrolledNativeHooks(b.selection, 'MANAGED_CREATION')).toEqual([{ provider: 'codex', state: 'NOT_ENROLLED' },
      { provider: 'antigravity', state: 'CONFIGURED' }])
  } finally {
    qualification.fixturePath = ''
    db.close()
    if (process.platform === 'win32') execFileSync('node', ['-e', "require('node:fs').rmSync(process.argv[1], { recursive: true, force: true, maxRetries: 5 })", base], { windowsHide: true })
    else rmSync(base, { recursive: true, force: true, maxRetries: 5 })
  }
}, 120000)
