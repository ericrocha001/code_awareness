import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildSync } from 'esbuild'
import { removeDirectoryForceSync } from '../core/force-remove'
import { GitService } from '../core/git-service'
import { GitWorktreeRegistry } from '../git-operations/git-worktree-registry'
import { sessionTargetResolver, type SessionTargetSelection } from './target'
import { SessionStore, sessionStorePath } from './store'
import { SessionContextClient } from './client'
import { hasNativeBindingFile, nativeBindingPath, nativeDigest, nativeWorktreeIdentity, normalizeNativeHook, prepareNativeSpool, spoolEventFiles, spoolNativeHook, type NativeHookBinding, type NativeHookProvider } from './native-hooks'
import type { McpMultimodalToolResult } from '../mcp/mcp-types'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

const data = (result: McpMultimodalToolResult) => {
  const first = result.content[0]
  if (!first || first.type !== 'text') throw new Error('EXPECTED_TEXT')
  return JSON.parse(first.text)
}

function buildWorkerBundle(base: string): string {
  const output = join(base, 'worker.cjs')
  const code = buildSync({ entryPoints: ['src/main/session-context/worker.ts'], bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false }).outputFiles[0].text
  writeFileSync(output, `require = require('node:module').createRequire(${JSON.stringify(join(process.cwd(), 'package.json'))});\n${code}`)
  return output
}

function createRepo(prefix: string) {
  const base = mkdtempSync(join(tmpdir(), prefix))
  cleanup.push(() => removeDirectoryForceSync(base))
  const main = join(base, 'main'), hooks = join(base, 'empty-hooks')
  mkdirSync(main); mkdirSync(hooks)
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${hooks}`, ...args], { cwd, windowsHide: true, encoding: 'utf8' })
  git(main, 'init', '-q', '-b', 'main')
  git(main, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init')
  return { base, main, git }
}

function writeBinding(root: string, repositoryId: string, selection: SessionTargetSelection, spoolDir: string, provider: NativeHookProvider = 'codex', enabled = true): NativeHookBinding {
  const id = nativeWorktreeIdentity(root)
  prepareNativeSpool(spoolDir)
  const binding: NativeHookBinding = {
    schema: 1,
    provider,
    enabled,
    repositoryId,
    worktreeId: selection.worktreeId,
    generation: selection.generation,
    root: id.root,
    commonDirectory: id.commonDirectory,
    directoryIdentity: id.directoryIdentity,
    spool: spoolDir
  }
  const path = nativeBindingPath(id.root, provider)
  mkdirSync(join(id.root, '.code-awareness/native-hooks', ...(provider === 'antigravity' ? ['antigravity'] : [])), { recursive: true })
  writeFileSync(path, JSON.stringify(binding, null, 2))
  return binding
}

function writeEnvelopes(binding: NativeHookBinding, sessionId: string, count: number, startSec = 0) {
  for (let i = 0; i < count; i++) {
    const provider = binding.provider ?? 'codex'
    const payload = provider === 'antigravity'
      ? { hookEventName: i === 0 ? 'SessionStart' : 'PreInvocation', conversationId: sessionId, workspacePaths: [binding.root], timestamp: new Date(Date.UTC(2026, 10, 19, 1, 0, startSec + i)).toISOString() }
      : { hook_event_name: i === 0 ? 'SessionStart' : 'Stop', session_id: sessionId, turn_id: `turn-${i}`, cwd: binding.root, timestamp: new Date(Date.UTC(2026, 10, 19, 1, 0, startSec + i)).toISOString() }
    const env = normalizeNativeHook(payload, binding, new Date(Date.UTC(2026, 10, 19, 1, 0, startSec + i)))
    spoolNativeHook(env, binding.spool)
  }
}

describe('U1 selective native ingestion and target scaling', () => {
  it('filters GitWorktreeRegistry.discover before rev-parse across 1, 8, and 72 worktrees', async () => {
    const { base, main, git } = createRepo('wt-scale-')
    const realGit = new GitService()
    const realCommon = await realGit.getCommonDirectory(main)
    const realDirectories = await realGit.getRepositoryDirectories(main)
    const headSha = git(main, 'rev-parse', 'HEAD').trim()
    for (const total of [1, 8, 72]) {
      const boundLimit = total === 1 ? 1 : total === 8 ? 3 : 9
      const entries: { path: string; bound: boolean; admin: string }[] = [{ path: realpathSync(main), bound: true, admin: realDirectories.admin }]
      for (let i = 1; i < total; i++) {
        const dir = join(base, `wt-${total}-${i}`)
        const admin = join(realCommon, 'worktrees', `wt-${total}-${i}`)
        mkdirSync(dir, { recursive: true })
        mkdirSync(admin, { recursive: true })
        writeFileSync(join(dir, '.git'), `gitdir: ${admin}\n`)
        writeFileSync(join(admin, 'gitdir'), `${join(dir, '.git')}\n`)
        entries.push({ path: realpathSync(dir), bound: i < boundLimit, admin: realpathSync(admin) })
      }
      const porcelain = entries.map((e, i) => `worktree ${e.path}\0HEAD ${headSha}\0branch refs/heads/wt-${i}\0`).join('\0')
      const entryByPath = new Map(entries.map(e => [e.path, e]))
      let revParseCalls = 0
      let listCalls = 0
      const stubGit = {
        getCommonDirectory: async () => realCommon,
        listWorktreeRecords: async () => { listCalls++; return porcelain },
        getRepositoryDirectories: async (cwd: string) => {
          revParseCalls++
          const entry = entryByPath.get(realpathSync(cwd))
          return entry ? { common: realCommon, admin: entry.admin } : realDirectories
        }
      } as unknown as GitService
      const registry = new GitWorktreeRegistry(main, stubGit, { repositoryId: `repo-${total}`, isActive: () => true })
      const boundSet = new Set(entries.filter(e => e.bound).map(e => e.path))
      const result = await registry.discover({ filterPath: path => boundSet.has(path) })
      expect(listCalls).toBe(1)
      expect(revParseCalls).toBe(boundLimit)
      expect(result.worktrees).toHaveLength(boundLimit)
    }
  }, 15_000)

  it('serves focal queries without sibling discovery/ingestion, preserves global/paginated zero-drain, and isolates excluded providers', async () => {
    const { base, main, git } = createRepo('focal-selective-')
    const w1 = join(base, 'w1'), w2 = join(base, 'w2')
    git(main, 'worktree', 'add', '-q', '-b', 'w1', w1)
    git(main, 'worktree', 'add', '-q', '-b', 'w2', w2)
    let active = true
    const registry = new GitWorktreeRegistry(main, new GitService(), { repositoryId: 'repo-sel', isActive: () => active })
    const discovered = await registry.discover()
    const rec0 = discovered.worktrees.find(w => w.branch === 'main')!
    const rec1 = discovered.worktrees.find(w => w.branch === 'w1')!
    const rec2 = discovered.worktrees.find(w => w.branch === 'w2')!
    const sel0 = { worktreeId: rec0.worktreeId, generation: rec0.generation }
    const sel1 = { worktreeId: rec1.worktreeId, generation: rec1.generation }
    const sel2 = { worktreeId: rec2.worktreeId, generation: rec2.generation }

    const spool0Codex = join(base, 'spools/w0-codex')
    const spool0Ag = join(base, 'spools/w0-ag')
    const spool1 = join(base, 'spools/w1-codex')
    const spool2 = join(base, 'spools/w2-codex')
    const b0Codex = writeBinding(main, 'repo-sel', sel0, spool0Codex, 'codex')
    const b0Ag = writeBinding(main, 'repo-sel', sel0, spool0Ag, 'antigravity')
    const b1 = writeBinding(w1, 'repo-sel', sel1, spool1, 'codex')
    const b2 = writeBinding(w2, 'repo-sel', sel2, spool2, 'codex')
    writeEnvelopes(b0Codex, 'sess-w0-codex', 2, 0)
    writeEnvelopes(b0Ag, 'sess-w0-ag', 2, 10)
    writeEnvelopes(b1, 'sess-w1', 3, 20)
    writeEnvelopes(b2, 'sess-w2', 3, 30)

    const baseResolver = sessionTargetResolver(registry, () => { if (!active) throw new Error('PROJECT_CONTEXT_CHANGED') })
    const resolveCalls: SessionTargetSelection[] = []
    let discoverCalls = 0
    let hangingW1 = true
    const spyResolver: typeof baseResolver = Object.assign(
      async (sel: SessionTargetSelection) => {
        resolveCalls.push(sel)
        if (sel.worktreeId === sel1.worktreeId && hangingW1) {
          const resolved = await baseResolver(sel)
          return { ...resolved, validate: () => new Promise<void>(() => {}) }
        }
        return baseResolver(sel)
      },
      {
        current: () => baseResolver.current!(),
        discover: async () => { discoverCalls++; return baseResolver.discover!() },
        discoverMatching: async (pred: (p: string) => boolean) => baseResolver.discoverMatching!(pred)
      }
    )

    const worker = buildWorkerBundle(base)
    const storage = join(base, 'storage')
    const store = new SessionStore(sessionStorePath(storage, 'repo-sel'), 'repo-sel')
    cleanup.push(() => store.close())
    const client = new SessionContextClient(storage, 'repo-sel', main, () => active, worker, spyResolver, 5000)
    cleanup.push(() => client.dispose())
    let maintenanceTriggered = 0
    client.setMaintenanceTrigger(() => { maintenanceTriggered++ })

    // 1. Focal query filtered by agent='codex' only drains w0-codex; leaves w0-ag and siblings w1/w2 untouched, zero discover().
    const focalCodex = data(await client.call('list_agent_sessions', { source: 'NATIVE_HOOK', ...sel0, agent: 'codex' }))
    expect(focalCodex.sessions).toHaveLength(1)
    expect(focalCodex.sessions[0]).toMatchObject({ agent: 'codex', provider: 'codex-native' })
    expect(discoverCalls).toBe(0)
    expect(resolveCalls.every(s => s.worktreeId === sel0.worktreeId)).toBe(true)
    expect(spoolEventFiles(spool0Codex)).toHaveLength(0)
    expect(spoolEventFiles(spool0Ag)).toHaveLength(2)
    expect(spoolEventFiles(spool1)).toHaveLength(3)
    expect(spoolEventFiles(spool2)).toHaveLength(3)

    // 2. Global index-only queries trigger maintenance without blocking on stalled w1 or draining spools, serving persisted SQLite rows immediately.
    const beforeGlobal = maintenanceTriggered
    const globalNative = data(await client.call('list_agent_sessions', { source: 'NATIVE_HOOK' }))
    expect(globalNative.sessions).toHaveLength(1)
    expect(maintenanceTriggered).toBe(beforeGlobal + 1)
    const globalMerged = data(await client.call('list_agent_sessions', {}))
    expect(globalMerged).toBeDefined()
    expect(maintenanceTriggered).toBe(beforeGlobal + 2)
    expect(spoolEventFiles(spool1)).toHaveLength(3)
    expect(spoolEventFiles(spool2)).toHaveLength(3)

    // 3. Selector query & paginated focal query do NOT drain spools and paginated query does NOT trigger maintenance.
    const byExec = data(await client.call('list_agent_sessions', { executionId: 'non-existent-exec' }))
    expect(byExec.sessions).toEqual([])
    expect(spoolEventFiles(spool0Ag)).toHaveLength(2)
    const page1 = data(await client.call('list_agent_sessions', { source: 'NATIVE_HOOK', ...sel0, limit: 1 }))
    expect(spoolEventFiles(spool0Ag)).toHaveLength(0) // drained on page1 focal without cursor
    writeEnvelopes(b0Codex, 'sess-w0-codex-extra', 1, 50)
    if (page1.nextCursor) {
      const beforePage = maintenanceTriggered
      await client.call('list_agent_sessions', { source: 'NATIVE_HOOK', ...sel0, limit: 1, cursor: page1.nextCursor })
      expect(maintenanceTriggered).toBe(beforePage)
      expect(spoolEventFiles(spool0Codex)).toHaveLength(1) // paginated cursor did NOT drain spool
    }
    hangingW1 = false
  }, 30_000)

  it('bounds focal ingestion and exposes PARTIAL nativeCatchUp when backlog exceeds focal batch limit, plus boundary contrasts', async () => {
    const { base, main, git } = createRepo('focal-budget-')
    const detached = join(base, 'detached')
    git(main, 'worktree', 'add', '-q', '--detach', detached)
    let active = true
    const registry = new GitWorktreeRegistry(main, new GitService(), { repositoryId: 'repo-b', isActive: () => active })
    const discovered = await registry.discover()
    const mainRec = discovered.worktrees.find(w => w.branch === 'main')!
    const detRec = discovered.worktrees.find(w => w.detached)!
    const selMain = { worktreeId: mainRec.worktreeId, generation: mainRec.generation }
    const selDet = { worktreeId: detRec.worktreeId, generation: detRec.generation }

    const spoolMain = join(base, 'spools/main')
    const spoolDet = join(base, 'spools/det')
    const bMain = writeBinding(main, 'repo-b', selMain, spoolMain, 'codex')
    const bDet = writeBinding(detached, 'repo-b', selDet, spoolDet, 'codex')
    writeEnvelopes(bMain, 'sess-big', 40, 0)
    writeEnvelopes(bDet, 'sess-det', 1, 100)

    const resolver = sessionTargetResolver(registry, () => { if (!active) throw new Error('PROJECT_CONTEXT_CHANGED') })
    const worker = buildWorkerBundle(base)
    const storage = join(base, 'storage')
    const client = new SessionContextClient(storage, 'repo-b', main, () => active, worker, resolver, 5000)
    cleanup.push(() => client.dispose())

    // >32 focal batch limit -> serves session snapshot, reports PARTIAL + pending, leaves remainder on disk
    const focalBig = data(await client.call('list_agent_sessions', { source: 'NATIVE_HOOK', ...selMain }))
    expect(focalBig.sessions).toHaveLength(1)
    expect(focalBig.coverage).toBe('PARTIAL')
    expect(focalBig.nativeCatchUp).toMatchObject({ state: 'PARTIAL', pending: true })
    expect(focalBig.coverageReasons).toContain(focalBig.nativeCatchUp.reason)
    expect(spoolEventFiles(spoolMain).length).toBeGreaterThan(0)

    // Valid detached HEAD resolves cleanly and reads focal
    const detRes = data(await client.call('list_agent_sessions', { source: 'NATIVE_HOOK', ...selDet }))
    expect(detRes.sessions).toHaveLength(1)
    expect(detRes.worktreeState).toBe('ACTIVE')

    // Recreated / divergent physical identity throws WORKTREE_STALE cleanly on resolver
    const gone = join(base, 'rec')
    git(main, 'worktree', 'add', '-q', '-b', 'rec', gone)
    const recList = await registry.discover()
    const recRec = recList.worktrees.find(w => w.branch === 'rec')!
    renameSync(gone, gone + '-old')
    mkdirSync(gone)
    await expect(resolver({ worktreeId: recRec.worktreeId, generation: recRec.generation })).rejects.toThrow()

    // Symlink target fails strict native hook identity check if symlinked on POSIX/supported FS
    expect(hasNativeBindingFile(join(base, 'nonexistent-traversal/..'))).toBe(false)
    try {
      const sym = join(base, 'sym')
      symlinkSync(detached, sym, 'junction')
      expect(() => nativeWorktreeIdentity(sym, true)).toThrow()
    } catch { /* symlink privilege optional on some Windows setups */ }

    // Repository switch terminates subsequent queries
    active = false
    expect(data(await client.call('list_agent_sessions', { source: 'NATIVE_HOOK', ...selMain })).code).toBe('PROJECT_CONTEXT_CHANGED')
  }, 30_000)
})
