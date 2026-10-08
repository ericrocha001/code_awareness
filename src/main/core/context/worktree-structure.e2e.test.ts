import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { GitService } from '../git-service'
import { createTempGitRepo, cleanupTempRepo, gitExec, stageAll, commit } from '../git-test-helpers'
import { GitOperationsService } from '../../git-operations/git-operations-service'
import { GitHubGitTransport } from '../../github/github-git-transport'
import { WorktreeStructureNavigation } from './worktree-structure-navigation'
import { CodeMapService } from '../code-map-service'
import { WatcherService } from '../watcher-service'
import { ContextEngine } from './context-engine'
import { bindProjectNavigation } from './project-context-navigation'
import { ChannelMcpAdapter } from '../../mcp/channel-mcp-adapter'
import { createMcpHttpServer } from '../../mcp/mcp-http-server'
import { getCanonicalTokenizer } from '../tokenizer'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await cleanupTempRepo(root) })
async function fixture() {
  const root = await createTempGitRepo(); roots.push(root)
  await gitExec(root, ['config', 'core.autocrlf', 'false'])
  const parent = mkdtempSync(join(tmpdir(), 'generic structure ')); roots.push(parent)
  const initial: Record<string, string> = {
    'app.ts': 'import { helper } from "./helper"\nexport function run(value: number): number { return value + 1 }\n',
    'helper.js': 'export function helper() { return "BASE" }\n',
    'consumer.ts': 'import { helper } from "./helper"\nexport const consume = helper()\n',
    'rename.ts': 'export class Renamed { run() { return 1 } }\n',
    'style.css': '.item { color: red; }\n',
    'config.json': '{"value": 1}\n',
    'readme.md': '# Header\nOld body\n',
    'notes.xyz': 'Old text\n',
    'deleted.ts': 'export class Deleted {}\n'
  }
  for (const [path, content] of Object.entries(initial)) writeFileSync(join(root, path), content)
  await stageAll(root); await commit(root, 'base')
  const git = new GitService(); const base = await git.getCurrentCommitHash(root)
  const a = join(parent, 'a'); const b = join(parent, 'b')
  await gitExec(root, ['worktree', 'add', '-b', 'a', a]); await gitExec(root, ['worktree', 'add', '-b', 'b', b])
  await gitExec(a, ['mv', 'rename.ts', 'moved.ts']); await gitExec(a, ['rm', 'deleted.ts'])
  writeFileSync(join(a, 'app.ts'), 'import { helper } from "./other"\nexport function run(value: string): string { return value + "A" }\n')
  await stageAll(a); await commit(a, 'a structural change')
  writeFileSync(join(a, 'helper.js'), 'export function helper() { return "A_DIRTY" }\n')
  writeFileSync(join(a, 'style.css'), '.item { color: blue; }\n')
  writeFileSync(join(a, 'config.json'), '{"value": 2}\n')
  writeFileSync(join(a, 'readme.md'), '# Header\nNew body\n')
  writeFileSync(join(a, 'notes.xyz'), 'New text\n')
  writeFileSync(join(a, 'added.ts'), 'export class Added {}\n')
  writeFileSync(join(b, 'app.ts'), '\n\n' + initial['app.ts'])
  writeFileSync(join(b, 'helper.js'), 'export function helper() { return "B_DIRTY" }\n'); await stageAll(b)
  writeFileSync(join(root, 'app.ts'), 'export class CanonicalDirty {}\n')
  const service = new GitOperationsService(root, git, new GitHubGitTransport(null, git), { repositoryId: 'generic-app', isActive: () => true })
  const worktrees = (await service.discoverWorktrees()).worktrees
  const aId = worktrees.find(w => w.branch === 'a')!.worktreeId; const bId = worktrees.find(w => w.branch === 'b')!.worktreeId
  const watcher = new WatcherService()
  const map = new CodeMapService(watcher, { async generateCompressionMarkdown() { throw new Error('unused') } })
  const navigation = new WorktreeStructureNavigation(service, map, root)
  return { root, a, b, base, git, service, aId, bId, map, navigation, paths: ['app.ts', 'helper.js', 'moved.ts', 'deleted.ts', 'style.css', 'config.json', 'readme.md', 'notes.xyz', 'added.ts', 'consumer.ts'] }
}
describe('ephemeral worktree structure with native extractors', () => {
  it('compares a generic app across divergent dirty worktrees and preserves the canonical map', async () => {
    const f = await fixture()
    try {
      await f.map.openRepository(f.root); await f.map.awaitMaintenance(f.root); await f.map.indexRepository(f.root)
      const indexed = JSON.stringify([f.map.getFiles(f.root), f.map.getElements(f.root), f.map.getRelationships(f.root)])
      const before = await f.git.captureWorktreeReadSnapshot(f.a)
      const a = await f.navigation.inspect({ worktreeId: f.aId, paths: f.paths })
      const b = await f.navigation.inspect({ worktreeId: f.bId, paths: ['app.ts', 'helper.js'] })
      expect(a.baseCommit).toBe(f.base); expect(b.baseCommit).toBe(f.base)
      expect(a.entries).toContainEqual(expect.objectContaining({ path: 'app.ts', kind: 'function', name: 'run', change: 'SIGNATURE' }))
      expect(a.entries).toContainEqual(expect.objectContaining({ path: 'helper.js', kind: 'function', name: 'helper', change: 'IMPLEMENTATION' }))
      expect(a.entries).toContainEqual(expect.objectContaining({ path: 'deleted.ts', kind: 'class', change: 'REMOVED' }))
      expect(a.entries).toContainEqual(expect.objectContaining({ path: 'added.ts', kind: 'class', change: 'ADDED' }))
      expect(a.files.find(f => f.path === 'moved.ts')?.limitations).toContain('ADDED_OR_RENAME_FROM_OUTSIDE_SELECTION')
      const rename = await f.navigation.inspect({ worktreeId: f.aId, paths: ['rename.ts', 'moved.ts'] })
      expect(rename.entries).toEqual([])
      expect(rename.files[1].previousPath).toBe('rename.ts')
      expect(rename.files[0].renamedTo).toBe('moved.ts')
      await gitExec(f.b, ['mv', 'rename.ts', 'staged-move.ts'])
      const stagedRename = await f.navigation.inspect({ worktreeId: f.bId, paths: ['rename.ts', 'staged-move.ts'] })
      expect(stagedRename.entries).toEqual([])
      writeFileSync(join(f.b, 'rename.ts'), 'export class RecreatedOrigin {}\n')
      const recreated = await f.navigation.inspect({ worktreeId: f.bId, paths: ['rename.ts', 'staged-move.ts'] })
      expect(recreated.entries).toContainEqual(expect.objectContaining({ path: 'rename.ts', name: 'RecreatedOrigin', kind: 'class', change: 'ADDED' }))
      expect(b.entries.some(e => e.path === 'app.ts')).toBe(false)
      expect(a.entries.some(e => e.path === 'style.css')).toBe(true)
      expect(a.entries.some(e => e.path === 'config.json')).toBe(true)
      expect(a.entries.some(e => e.path === 'readme.md')).toBe(true)
      expect(a.files.find(f => f.path === 'notes.xyz')?.limitations).toContain('STRUCTURE_UNAVAILABLE')
      expect(a.files[0].canonicalReference).toEqual({ base: 'INCOMPATIBLE', current: 'INCOMPATIBLE' })
      expect(a.files.find(f => f.path === 'helper.js')?.importerCandidates.base.paths).toEqual(['consumer.ts'])
      expect(a.files.find(f => f.path === 'helper.js')?.importerCandidates.current.paths).toEqual([])
      expect(JSON.stringify(a)).not.toContain('CanonicalDirty')
      expect(JSON.stringify(a)).not.toContain('A_DIRTY')
      expect(JSON.stringify(b)).not.toContain('B_DIRTY')
      expect(JSON.stringify(a)).not.toMatch(/"target":"t:/)
      expect(JSON.stringify([f.map.getFiles(f.root), f.map.getElements(f.root), f.map.getRelationships(f.root)])).toBe(indexed)
      expect(await f.git.captureWorktreeReadSnapshot(f.a)).toEqual(before)
      expect(readFileSync(join(f.a, 'helper.js'), 'utf8')).toContain('A_DIRTY')
    } finally { f.map.closeRepository(f.root) }
  }, 60000)

  it('routes one protected tool through real HTTP, separates worktrees and measures the same structural question', async () => {
    const f = await fixture()
    const body = Array.from({ length: 120 }, (_, i) => `  // sentinel current implementation ${i} ${'x'.repeat(40)}`).join('\n')
    writeFileSync(join(f.a, 'helper.js'), `export function helper() {\n${body}\n  return "A_DIRTY"\n}\n`)
    const projectNavigation = bindProjectNavigation(new ContextEngine(f.map), f.root, f.navigation)
    const adapter = new ChannelMcpAdapter({ projectId: 'generic', repoRoot: f.root, navigation: projectNavigation, gitOperations: f.service })
    const server = createMcpHttpServer(adapter, () => {})
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as import('node:net').AddressInfo).port
    const send = async (message: unknown) => {
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(message) })
      expect(response.status).toBe(200)
      return response.json() as Promise<any>
    }
    let id = 0
    const call = (name: string, args: unknown) => send({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } })
    try {
      const catalog = await send({ jsonrpc: '2.0', id: ++id, method: 'tools/list' })
      const tool = catalog.result.tools.filter((t: any) => t.name === 'inspect_worktree_structure')
      expect(tool).toHaveLength(1); expect(tool[0].securitySchemes).toEqual([{ type: 'oauth2', scopes: [] }])
      const before = await f.git.captureWorktreeReadSnapshot(f.a)
      const args = { worktreeId: f.aId, paths: ['app.ts', 'helper.js'] }
      const [a, b] = await Promise.all([call('inspect_worktree_structure', args), call('inspect_worktree_structure', { ...args, worktreeId: f.bId })])
      expect(a.result.isError).toBeUndefined(); expect(b.result.isError).toBeUndefined()
      const projection = JSON.parse(a.result.content[0].text); const other = JSON.parse(b.result.content[0].text)
      expect(projection.head).not.toBe(other.head)
      expect(projection.files).toHaveLength(2)
      expect(projection.entries.some((e: any) => e.path === 'app.ts' && e.change === 'SIGNATURE')).toBe(true)
      expect(other.entries.some((e: any) => e.path === 'app.ts')).toBe(false)
      expect(a.result.content[0].text).not.toContain('sentinel current implementation')
      const alternative = await Promise.all([
        call('get_worktree_changes', { worktreeId: f.aId }),
        call('get_worktree_diff', { ...args, mode: 'BETWEEN_REFS', base: f.base, head: projection.head }),
        call('get_worktree_diff', { ...args, mode: 'WORKTREE' }),
        call('read_worktree_file', { worktreeId: f.aId, path: 'app.ts', startLine: 1, endLine: 2 }),
        call('read_worktree_file', { worktreeId: f.aId, path: 'helper.js', startLine: 1, endLine: 123 })
      ])
      expect(alternative.every(response => !response.result.isError)).toBe(true)
      const defaultText = JSON.stringify(a); const alternativeText = JSON.stringify(alternative)
      const tokenizer = getCanonicalTokenizer()
      const metrics = { defaultBytes: Buffer.byteLength(defaultText), defaultTokens: tokenizer.count(defaultText), alternativeBytes: Buffer.byteLength(alternativeText), alternativeTokens: tokenizer.count(alternativeText), files: args.paths }
      console.log('WORKTREE_STRUCTURE_CONTEXT_COST', JSON.stringify(metrics))
      expect(metrics.defaultBytes).toBeLessThan(metrics.alternativeBytes)
      expect(metrics.defaultTokens).toBeLessThan(metrics.alternativeTokens)
      expect(await f.git.captureWorktreeReadSnapshot(f.a)).toEqual(before)
      const invalid = await call('inspect_worktree_structure', { ...args, baseCommit: 'HEAD' })
      expect(JSON.parse(invalid.result.content[0].text)).toMatchObject({ code: 'INVALID_ARGUMENT', valid: false })
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
  }, 60000)

  it('pages without losing deltas, rejects stale cursors and reads locked detached worktrees without ownership', async () => {
    const f = await fixture()
    await gitExec(f.root, ['worktree', 'lock', f.b])
    await gitExec(f.b, ['checkout', '--detach'])
    writeFileSync(join(f.b, 'many.ts'), Array.from({ length: 180 }, (_, i) => `export function fn${i}(x: number): number { return x + ${i} }`).join('\n'))
    await f.service.discoverWorktrees()
    const state = await f.service.inspectWorktree(f.bId)
    expect(state).toMatchObject({ ownership: 'NOT_GRANTED', mutationAllowed: false, branch: null })
    const request = { worktreeId: f.bId, paths: ['many.ts'], baseCommit: f.base! }
    const first = await f.navigation.inspect(request)
    expect(first.truncated).toBe(true)
    const seen = [...first.entries]
    let cursor = first.nextCursor
    while (cursor) {
      const page = await f.navigation.inspect({ ...request, cursor })
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(24000)
      expect(page.revision).toBe(first.revision)
      seen.push(...page.entries); cursor = page.nextCursor
    }
    expect(seen).toHaveLength(first.totalEntries)
    expect(new Set(seen.map(e => e.ancestry)).size).toBe(seen.length)
    writeFileSync(join(f.b, 'many.ts'), 'export function changed() {}\n')
    await expect(f.navigation.inspect({ ...request, cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'GIT_STATE_CHANGED' })
    writeFileSync(join(f.b, 'ambiguous.ts'), 'export function same(x: string): string;\nexport function same(x: number): string;\nexport function same(x: unknown): string { return String(x) }\n')
    const ambiguous = await f.navigation.inspect({ worktreeId: f.bId, paths: ['ambiguous.ts'] })
    expect(ambiguous.files[0].limitations).toContain('AMBIGUOUS_ELEMENT_MATCH')
    expect(ambiguous.entries.some(e => e.change === 'UNCERTAIN')).toBe(true)
    writeFileSync(join(f.b, 'broken.ts'), 'export function broken( {\n<<<<<<< unresolved\n')
    const broken = await f.navigation.inspect({ worktreeId: f.bId, paths: ['broken.ts'] })
    expect(broken.files[0].limitations).toContain('PARSE_INCOMPLETE')
    expect(broken.files[0].coverage.current).toBe('PARTIAL_STRUCTURE')
    expect(f.map.getOpenProjects()).toEqual([])
  }, 60000)
})
