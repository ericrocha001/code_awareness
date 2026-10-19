import { afterEach, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { GitService } from '../core/git-service'
import { GitAtlasReader } from './git-atlas'
import { cleanupTempRepo, createTempGitRepo, gitExec, writeFile, stageAll, commit } from '../core/git-test-helpers'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await cleanupTempRepo(root) })
it('measures Atlas cold, repeated filters and multiple refs on the same repository', async () => {
  const root = await createTempGitRepo(); roots.push(root)
  const records: string[] = [], now = Math.floor(Date.now() / 1000)
  for (let index = 1; index <= 240; index++) records.push(`commit refs/heads/main\nmark :${index}\ncommitter Proof <proof@example.com> ${now - (240 - index) * 8640} +0000\ndata 8\nmeasured\n\n`)
  for (let index = 0; index < 80; index++) records.push(`reset refs/heads/ref-${index}\nfrom :${240 - index}\n\n`)
  const imported = spawnSync('git', ['fast-import', '--quiet'], { cwd: root, input: records.join(''), encoding: 'utf8', windowsHide: true })
  expect(imported.status).toBe(0)
  await gitExec(root, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  const git = new GitService(), reader = new GitAtlasReader(root, git, code => { throw new Error(code) })
  vi.spyOn(Date, 'now').mockReturnValue(Date.now())
  const history = vi.spyOn(git, 'getAtlasHistory'), commands = vi.spyOn(git as any, 'runGit')
  const timings: Record<string, number> = {}
  for (const [name, window] of [['cold', 30], ['hit', 30], ['60d', 60], ['90d', 90], ['return30', 30]] as const) {
    const start = performance.now()
    const page = await reader.history({ window, limit: 100, contextKey: 'measurement:1' })
    timings[name] = Math.round(performance.now() - start)
    expect(page.nodes).toHaveLength(100)
  }
  console.info(JSON.stringify({ atlasMeasurement: timings, historyCalls: history.mock.calls.length, gitCommands: commands.mock.calls.length }))
  expect(history).toHaveBeenCalledTimes(3)
}, 120000)

it('reobserves reset, rebased/deleted refs, and never poisons caches after errors', async () => {
  const root = await createTempGitRepo(); roots.push(root)
  const add = async (name: string) => { writeFile(root, name, name); await stageAll(root); await commit(root, name); return (await gitExec(root, ['rev-parse', 'HEAD'])).trim() }
  const initial = await add('root')
  await gitExec(root, ['branch', '-m', 'main'])
  await gitExec(root, ['switch', '-c', 'topic']); const old = await add('topic')
  await gitExec(root, ['switch', 'main']); const base = await add('base')
  const git = new GitService(), reader = new GitAtlasReader(root, git, code => { throw new Error(code) })
  const history = vi.spyOn(git, 'getAtlasHistory')
  const first = await reader.history({ window: 90, limit: 1 })
  await reader.history({ window: 90, limit: 1 }); expect(history).toHaveBeenCalledTimes(1)
  await gitExec(root, ['switch', 'topic']); await gitExec(root, ['rebase', '--onto', base, initial])
  const rebased = await reader.history({ window: 90 })
  expect(rebased.head).not.toBe(old)
  await expect(reader.history({ window: 90, limit: 1, cursor: first.nextCursor! })).rejects.toThrow('GIT_STATE_CHANGED')
  await gitExec(root, ['reset', '--hard', initial]); await gitExec(root, ['branch', '-D', 'main'])
  const reset = await reader.history({ window: 90 })
  expect(reset.head).toBe(initial); expect(reset.nodes.map(node => node.sha)).toEqual([initial])
  expect(reset.refs.some(ref => ref.name === 'main')).toBe(false)
  reader.invalidate()
  history.mockRejectedValueOnce(new Error('transient'))
  await expect(reader.history({ window: 90 })).rejects.toThrow('transient')
  expect((await reader.history({ window: 90 })).head).toBe(initial)
}, 60000)

it('coalesces simultaneous pages, expires temporal anchors, and refresh bypasses derived pages', async () => {
  const root = await createTempGitRepo(); roots.push(root)
  writeFile(root, 'file', 'data'); await stageAll(root); await commit(root, 'root')
  const now = Date.now(), cutoffDate = new Date(now - 30 * 86400000 + 20000).toISOString()
  const tree = (await gitExec(root, ['rev-parse', 'HEAD^{tree}'])).trim()
  const cutoff = spawnSync('git', ['commit-tree', tree, '-m', 'cutoff-boundary'], { cwd: root, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_AUTHOR_DATE: cutoffDate, GIT_COMMITTER_DATE: cutoffDate } })
  expect(cutoff.status).toBe(0)
  await gitExec(root, ['update-ref', 'refs/heads/cutoff', cutoff.stdout.trim()])
  const git = new GitService(), reader = new GitAtlasReader(root, git, code => { throw new Error(code) })
  const history = vi.spyOn(git, 'getAtlasHistory'), clock = vi.spyOn(Date, 'now').mockReturnValue(now)
  const pages = await Promise.all([reader.history({ window: 30 }), reader.history({ window: 30 })])
  expect(pages[0]).toEqual(pages[1]); expect(history).toHaveBeenCalledTimes(1)
  expect(pages[0].nodes.some(node => node.subject === 'cutoff-boundary')).toBe(true)
  pages[0].nodes[0].subject = 'poison'
  expect((await reader.history({ window: 30 })).nodes[0].subject).not.toBe('poison')
  writeFile(root, 'file', 'updated index'); await stageAll(root)
  await reader.history({ window: 30 }); expect(history).toHaveBeenCalledTimes(1)
  await reader.history({ window: 30, refresh: true }); expect(history).toHaveBeenCalledTimes(2)
  clock.mockReturnValue(now + 60001)
  const advanced = await reader.history({ window: 30 }); expect(history).toHaveBeenCalledTimes(3)
  expect(advanced.nodes.some(node => node.subject === 'cutoff-boundary')).toBe(false)
  reader.invalidate(true)
  await reader.history({ window: 30 }); expect(history).toHaveBeenCalledTimes(4)
}, 60000)
