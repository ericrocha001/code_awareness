import { afterEach, expect, it } from 'vitest'
import { join } from 'node:path'
import { renameSync } from 'node:fs'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { GitService } from '../core/git-service'
import { GitAtlasReader } from './git-atlas'
import { createTempGitRepo, cleanupTempRepo, gitExec, writeFile, stageAll, commit } from '../core/git-test-helpers'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await cleanupTempRepo(root) })
async function fixture() {
  const root = await createTempGitRepo(); roots.push(root)
  const git = new GitService()
  const reader = new GitAtlasReader(root, git, code => { throw new Error(code) })
  const add = async (name: string) => { writeFile(root, name, name); await stageAll(root); await commit(root, name); return (await gitExec(root, ['rev-parse', 'HEAD'])).trim() }
  return { root, reader, add }
}

it.each([7, 15] as const)('filters real commits within the %i-day window', async days => {
  const { root, reader } = await fixture()
  const run = promisify(execFile)
  for (const age of [20, 10, 0]) {
    const date = new Date(Date.now() - age * 86400000).toISOString()
    await run('git', ['commit', '--allow-empty', '-m', `age-${age}`], { cwd: root, windowsHide: true, env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } })
  }
  const page = await reader.history({ window: days })
  expect(page.nodes.map(node => node.subject)).toEqual(days === 7 ? ['age-0'] : ['age-0', 'age-10'])
  expect(Date.parse(page.queriedAt) - Date.parse(page.since!)).toBe(days * 86400000)
})

it('queries bounded temporal pages, real merge ancestry, remote refs, tags and detached worktree HEADs', async () => {
  const { root, reader, add } = await fixture()
  await gitExec(root, ['branch', '-m', 'trunk'])
  const initial = await add('root')
  await gitExec(root, ['config', 'code-awareness.primaryBranch', 'trunk'])
  await gitExec(root, ['switch', '-c', 'topic'])
  const topic = await add('topic')
  await gitExec(root, ['switch', 'trunk'])
  await add('trunk')
  await gitExec(root, ['merge', '--no-ff', 'topic', '-m', 'integrate'])
  const merge = (await gitExec(root, ['rev-parse', 'HEAD'])).trim()
  await gitExec(root, ['tag', '-a', 'v1', '-m', 'release'])
  await gitExec(root, ['update-ref', 'refs/remotes/origin/topic', topic])
  const detached = join(root, 'detached')
  await gitExec(root, ['worktree', 'add', '--detach', detached, initial])
  writeFile(detached, 'detached.txt', 'separate'); await stageAll(detached); await commit(detached, 'detached')
  const detachedSha = (await gitExec(detached, ['rev-parse', 'HEAD'])).trim()
  const before = await gitExec(root, ['status', '--porcelain'])
  let page = await reader.history({ window: 90, limit: 2, contextKey: 'project:1' })
  expect(page.primaryRef).toBe('refs/heads/trunk')
  expect(page.tags).toContainEqual({ name: 'v1', sha: merge })
  expect(page.detachedHeads).toContainEqual({ sha: detachedSha, name: 'detached' })
  const first = page, nodes = [...page.nodes]
  while (page.nextCursor) { page = await reader.history({ window: 90, limit: 2, contextKey: 'project:1', cursor: page.nextCursor }); expect(page.queriedAt).toBe(first.queriedAt); nodes.push(...page.nodes) }
  expect(new Set(nodes.map(node => node.sha)).size).toBe(5)
  expect(nodes.find(node => node.sha === merge)?.parents).toContain(topic)
  expect(nodes.some(node => node.sha === detachedSha)).toBe(true)
  const comparison = await reader.compare({ snapshot: first.snapshot, left: 'refs/heads/trunk', right: 'refs/heads/topic', contextKey: 'project:1' })
  expect(comparison).toMatchObject({ mergeBases: [topic], leftOnly: 2, rightOnly: 0 })
  await expect(reader.history({ window: 30, cursor: first.nextCursor!, contextKey: 'project:1' })).rejects.toThrow('GIT_STATE_CHANGED')
  await expect(reader.history({ window: 90, cursor: first.nextCursor!, contextKey: 'other:1' })).rejects.toThrow('GIT_STATE_CHANGED')
  expect(await gitExec(root, ['status', '--porcelain'])).toBe(before)
  await gitExec(root, ['branch', 'new-ref'])
  await expect(reader.history({ window: 90, cursor: first.nextCursor!, contextKey: 'project:1' })).rejects.toThrow('GIT_STATE_CHANGED')
  await expect(reader.compare({ snapshot: first.snapshot, left: 'HEAD', right: 'refs/heads/topic', contextKey: 'project:1' })).rejects.toThrow('GIT_STATE_CHANGED')
  await gitExec(root, ['config', 'remote.origin.url', root])
  await gitExec(root, ['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'])
  await gitExec(root, ['branch', '--set-upstream-to=origin/topic', 'topic'])
  const tracked = await reader.history({ window: 90 })
  expect(tracked.refs.find(ref => ref.ref === 'refs/heads/topic')?.upstream).toBe('origin/topic')
  const tree = (await gitExec(root, ['rev-parse', 'HEAD^{tree}'])).trim()
  const tagOnly = (await gitExec(root, ['commit-tree', tree, '-m', 'Tagged independent root'])).trim()
  await gitExec(root, ['tag', '-a', 'tag-only', '-m', 'Independent history', tagOnly])
  await gitExec(root, ['tag', 'tree-tag', tree])
  const tagged = await reader.history({ window: 90 })
  expect(tagged.nodes.some(node => node.sha === tagOnly)).toBe(true)
  expect(tagged.tags).toContainEqual({ name: 'tag-only', sha: tagOnly })
  expect(tagged.tags.some(tag => tag.name === 'tree-tag')).toBe(false)
  expect(await reader.compare({ snapshot: tagged.snapshot, left: 'refs/heads/trunk', right: detachedSha })).toMatchObject({ right: { ref: detachedSha, sha: detachedSha }, mergeBases: [initial] })
  renameSync(detached, detached + '-unavailable')
  const partial = await reader.history({ window: 90 })
  expect(partial.detachedCoverage).toBe('PARTIAL')
  expect(partial.detachedHeads.some(head => head.sha === detachedSha)).toBe(false)
}, 60000)

it('filters by committer date despite inverted ancestry and never invents deleted branch names', async () => {
  const { root, reader, add } = await fixture()
  const first = await add('recent-root')
  const tree = (await gitExec(root, ['rev-parse', 'HEAD^{tree}'])).trim()
  const old = (await promisify(execFile)('git', ['commit-tree', tree, '-p', first, '-m', 'old child'], { cwd: root, env: { ...process.env, GIT_AUTHOR_DATE: '2001-01-01T12:00:00Z', GIT_COMMITTER_DATE: '2001-01-01T12:00:00Z' } })).stdout.trim()
  await gitExec(root, ['update-ref', 'HEAD', old])
  await gitExec(root, ['branch', 'deleted']); await gitExec(root, ['branch', '-D', 'deleted'])
  const page = await reader.history({ window: 30 })
  expect(page.refs.some(ref => ref.name === 'deleted')).toBe(false)
  expect(page.nodes.map(node => node.sha)).toEqual([first])
  expect((await reader.history({ window: 'ALL' })).nodes.find(node => node.sha === old)?.parents).toEqual([first])
  expect(page.primaryRef).toBeNull()
  await expect(reader.history({ window: 90, limit: 101 })).rejects.toThrow('INVALID_ARGUMENT')
  await expect(reader.history({ window: 90, cursor: 'forged.cursor' })).rejects.toThrow('GIT_STATE_CHANGED')
}, 30000)

it('distinguishes fast-forward ancestry, squash divergence and unrelated histories with exact reachability', async () => {
  const { root, reader, add } = await fixture()
  await gitExec(root, ['branch', '-m', 'trunk']); await add('root')
  await gitExec(root, ['switch', '-c', 'fast']); const fast = await add('fast')
  await gitExec(root, ['switch', 'trunk']); await gitExec(root, ['merge', '--ff-only', 'fast'])
  let page = await reader.history({ window: 90 })
  expect(page.nodes.find(node => node.sha === fast)?.parents).toHaveLength(1)
  expect(await reader.compare({ snapshot: page.snapshot, left: 'refs/heads/trunk', right: 'refs/heads/fast' })).toMatchObject({ leftOnly: 0, rightOnly: 0, mergeBases: [fast] })
  await gitExec(root, ['switch', '-c', 'squashed']); const source = await add('squashed')
  await gitExec(root, ['switch', 'trunk']); await gitExec(root, ['merge', '--squash', 'squashed']); await commit(root, 'squash result')
  await gitExec(root, ['update-ref', 'refs/remotes/origin/divergent', source])
  page = await reader.history({ window: 60 })
  const result = await reader.compare({ snapshot: page.snapshot, left: 'refs/heads/trunk', right: 'refs/remotes/origin/divergent' })
  expect(result).toMatchObject({ leftOnly: 1, rightOnly: 1, mergeBases: [fast] })
  expect(result.exclusive.right).toEqual([source])
  await gitExec(root, ['switch', '--orphan', 'unrelated']); await add('other-root')
  page = await reader.history({ window: 'ALL' })
  expect(await reader.compare({ snapshot: page.snapshot, left: 'refs/heads/trunk', right: 'refs/heads/unrelated' })).toMatchObject({ mergeBases: [] })
}, 30000)

it('handles unborn repositories without fabricating history', async () => {
  const { reader } = await fixture()
  expect(await reader.history({ window: 'ALL' })).toMatchObject({ nodes: [], head: null, nextCursor: null, primaryRef: null })
}, 30000)

it('bounds a small window in a large history and binds pages to detached HEAD changes', async () => {
  const { root, reader } = await fixture()
  const records: string[] = []
  const now = Math.floor(Date.now() / 1000)
  for (let index = 0; index < 1000; index++) {
    const date = index === 999 ? now : 978350400 + index
    const message = `commit ${index}\n`
    records.push(`commit refs/heads/trunk\ncommitter Test <test@example.com> ${date} +0000\ndata ${Buffer.byteLength(message)}\n${message}\n`)
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', ['fast-import', '--quiet'], { cwd: root, stdio: ['pipe', 'ignore', 'pipe'] })
    let error = ''; child.stderr.on('data', chunk => { error += chunk })
    child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(error)))
    child.stdin.end(records.join(''))
  })
  await gitExec(root, ['symbolic-ref', 'HEAD', 'refs/heads/trunk'])
  const small = await reader.history({ window: 30, limit: 2 })
  expect(small.nodes).toHaveLength(1)
  expect(small.nodes[0].subject).toBe('commit 999')
  expect(small.boundary).toEqual(small.nodes[0].parents)
  expect(small.nextCursor).toBeNull()
  expect(Buffer.byteLength(JSON.stringify(small))).toBeLessThan(5000)
  const all = await reader.history({ window: 'ALL', limit: 2 })
  expect(all.nodes).toHaveLength(2); expect(all.nextCursor).not.toBeNull()
  const path = join(root, 'detached')
  await gitExec(root, ['worktree', 'add', '--detach', path, 'HEAD~2'])
  await expect(reader.history({ window: 'ALL', cursor: all.nextCursor! })).rejects.toThrow('GIT_STATE_CHANGED')
  const current = await reader.history({ window: 'ALL', limit: 2 })
  await gitExec(path, ['switch', '--detach', 'HEAD~1'])
  await expect(reader.history({ window: 'ALL', cursor: current.nextCursor! })).rejects.toThrow('GIT_STATE_CHANGED')
}, 30000)
