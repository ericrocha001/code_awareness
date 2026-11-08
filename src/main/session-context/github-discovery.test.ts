import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionStore, sessionStorePath } from './store'
import { discoverGitHubPage } from './github-discovery'
import { digest } from './privacy'
import { registrySources } from './registry-sources'
import { reconcileRegistry } from './registry-reconciliation'
import { discoverExecutionContext } from './execution-context'
import type { PullRequestRecord } from '../../shared/types/branch-pull-request-types'

const cleanup: (() => void)[] = []
afterEach(() => { cleanup.splice(0).reverse().forEach(close => close()); vi.useRealTimers() })
const sha = (n: number) => n.toString(16).padStart(40, '0')
const item = (number: number, updatedAt = '2026-11-01T00:00:00Z'): PullRequestRecord => ({ id: String(number), number, url: 'https://github.com/owner/repo/pull/' + number, title: 'not persisted', state: 'open', draft: false, merged: false, mergedAt: null, mergeCommit: null,
  createdAt: updatedAt, updatedAt, base: { repositoryId: 'remote', repository: 'owner/repo', ref: 'main', sha: sha(1) }, head: { repositoryId: 'remote', repository: 'owner/repo', ref: 'topic', sha: sha(number + 1000) } })
function fixture(count = 105) {
  const root = mkdtempSync(join(tmpdir(), 'github-discovery-')), path = sessionStorePath(root, 'repo')
  let store = new SessionStore(path, 'repo'), rows = Array.from({ length: count }, (_, n) => item(count - n)), scope = digest('account-A'), failure: string | undefined
  const requests: number[] = []
  const read = vi.fn(async (_root: string, page: number) => {
    requests.push(page)
    if (failure) throw Object.assign(new Error('PRIVATE_TOKEN_AND_ENDPOINT'), { code: failure })
    const items = rows.slice((page - 1) * 100, page * 100), hasNext = page * 100 < rows.length
    return { repositoryId: 'repo', providerRepositoryId: 'remote', scope, items, hasNext, observedAt: new Date().toISOString(), representation: { page, etag: 'same-page-etag', notModified: false, revision: digest(JSON.stringify(items)) } }
  })
  cleanup.push(() => { store.close(); rmSync(root, { recursive: true, force: true }) })
  const step = async (epoch = 'same-process', now = 1_800_000_000_000, apply = true) => {
    const batches = await discoverGitHubPage({ repositoryId: 'repo', root, read, epoch, now, cursor: store.registry.source('GITHUB_DISCOVERY')?.cursor, assertCurrent: () => {} })
    if (apply) store.registry.applyAll(batches, () => {})
    return batches
  }
  return { root, read, requests, step, store: () => store, rows: () => rows, setRows: (value: PullRequestRecord[]) => { rows = value }, setScope: () => { scope = digest('account-B') }, fail: (value?: string) => { failure = value },
    restart: () => { store.close(); store = new SessionStore(path, 'repo') } }
}
it('discovers >100 previously unknown PRs with equal timestamps and advances watermark only after two persisted full passes', async () => {
  const f = fixture()
  await f.step()
  expect(f.store().registry.source('GITHUB_DISCOVERY')?.status).toBe('PARTIAL')
  expect(JSON.parse(f.store().registry.source('GITHUB_DISCOVERY')!.cursor!).highWatermarkUpdatedAt).toBeUndefined()
  expect(f.store().registry.contextGraph({ kind: 'PR', id: '105' }).nodes).toHaveLength(1)
  await f.step(); await f.step(); await f.step()
  expect(f.requests).toEqual([1, 2, 1, 2])
  expect(f.store().registry.source('GITHUB_DISCOVERY')?.status).toBe('COMPLETE')
  expect(JSON.parse(f.store().registry.source('GITHUB_DISCOVERY')!.cursor!).highWatermarkUpdatedAt).toBe('2026-11-01T00:00:00Z')
  expect(f.store().registry.pendingReconciliation('PR', 200)).toHaveLength(105)
  expect(f.store().registry.map({ kind: 'PR', id: '105' }).edges).toEqual([])
  const before = f.requests.length; await f.step(); expect(f.requests).toHaveLength(before)
})
it('restarts interrupted mutable pagination from the top and never checkpoints uncommitted reads', async () => {
  const f = fixture()
  await f.step('before', undefined, false)
  expect(f.store().registry.source('GITHUB_DISCOVERY')).toBeUndefined()
  await f.step('before'); f.restart()
  await f.step('after')
  expect(f.requests).toEqual([1, 1, 1])
  expect(JSON.parse(f.store().registry.source('GITHUB_DISCOVERY')!.cursor!).highWatermarkUpdatedAt).toBeUndefined()
  await f.step('after'); await f.step('after'); await f.step('after')
  expect(f.store().registry.source('GITHUB_DISCOVERY')?.status).toBe('COMPLETE')
})
it('detects reordered pages and preserves a partial scan until the observed catalog stabilizes', async () => {
  const f = fixture()
  await f.step()
  f.setRows([item(999), ...f.rows()])
  await f.step(); await f.step(); await f.step()
  expect(f.store().registry.source('GITHUB_DISCOVERY')?.status).toBe('PARTIAL')
  expect(JSON.parse(f.store().registry.source('GITHUB_DISCOVERY')!.cursor!).highWatermarkUpdatedAt).toBeUndefined()
  await f.step(); await f.step()
  expect(f.store().registry.source('GITHUB_DISCOVERY')?.status).toBe('COMPLETE')
  expect(f.store().registry.pendingReconciliation('PR', 200)).toHaveLength(106)
})
it('scopes 304/body evidence to one page, preserves safe watermark on outages and resets account identity', async () => {
  const f = fixture(1)
  await f.step(); await f.step()
  const prior = JSON.parse(f.store().registry.source('GITHUB_DISCOVERY')!.cursor!).highWatermarkUpdatedAt
  for (const code of ['RATE_LIMITED','PERMISSION_DENIED','NETWORK_ERROR','REAUTH_REQUIRED']) {
    f.fail(code); await f.step('same-process', 1_800_000_100_000)
    const source = f.store().registry.source('GITHUB_DISCOVERY')!
    expect(source.status).toBe('UNAVAILABLE'); expect(source.cursor).not.toContain('PRIVATE_')
    expect(JSON.parse(source.cursor!).highWatermarkUpdatedAt).toBe(prior)
  }
  f.fail(); f.setScope(); await f.step('same-process', 1_800_000_100_000)
  expect(f.store().registry.source('GITHUB_DISCOVERY')?.status).toBe('PARTIAL')
  expect(JSON.parse(f.store().registry.source('GITHUB_DISCOVERY')!.cursor!).highWatermarkUpdatedAt).toBeUndefined()
  await f.step(); await f.step()
  expect(f.store().registry.source('GITHUB_DISCOVERY')?.status).toBe('COMPLETE')
})
it('overlap scanning reports selected scope, never full completeness, and periodic full scans reach older changes', async () => {
  const f = fixture(1), base = 1_800_000_000_000
  await f.step('process', base); await f.step('process', base)
  f.setRows([item(1), item(2, '2026-10-01T00:00:00Z')])
  await f.step('process', base + 31000)
  expect(f.store().registry.source('GITHUB_DISCOVERY')?.status).toBe('PARTIAL')
  expect(JSON.parse(f.store().registry.source('GITHUB_DISCOVERY')!.cursor!).reasonCode).toBe('OVERLAP_WINDOW_ONLY')
  await f.step('process', base + 3600001); await f.step('process', base + 3600001)
  expect(f.store().registry.source('GITHUB_DISCOVERY')?.status).toBe('COMPLETE')
  expect(f.store().registry.pendingReconciliation('PR', 200)).toHaveLength(2)
})
it('drains catalog/commit backlog automatically, verifies both graph directions after restart and detects head changes without updatedAt', async () => {
  const f = fixture(5)
  const commits = [sha(101), sha(102), sha(103)], requests: number[] = []
  const github = { pullRequestCatalogPage: f.read, commitPullRequests: vi.fn(async () => []), getPullRequest: vi.fn(async (_root, number) => ({ pullRequest: { head: { sha: f.rows().find(pr => pr.number === number)!.head.sha } } })),
    pullRequestCommits: vi.fn(async (_root, number, _head, page) => { requests.push(page); return { repositoryId: 'repo', commits: number === 5 ? commits.slice((page - 1) * 2, page * 2).map(sha => ({ sha })) : [], nextPage: number === 5 && page === 1 ? 2 : null } }) }
  const continuum = { assertRepository: () => {}, list: () => ({ artifacts: [] }), get: () => null } as any
  const ledger = { projectionPage: async () => ({ proofs: [], cursor: 'end', more: false }) } as any
  let allowed = false
  const read = registrySources({ repositoryId: 'repo', root: f.root, github: github as any, continuum: () => continuum, ledger, networkAllowed: () => allowed, assertCurrent: () => {} })
  const runner = async () => ({ code: 1, text: '', limited: false })
  await reconcileRegistry(f.store(), runner, f.root, undefined, () => {}, read)
  expect(f.read).not.toHaveBeenCalled()
  allowed = true
  for (let round = 0; round < 12; round++) {
    await reconcileRegistry(f.store(), runner, f.root, undefined, () => {}, read)
    if (!f.store().registry.reconciliationBacklog().drainable) break
  }
  expect(f.store().registry.pendingReconciliation('PR', 1)).toEqual([])
  expect(f.store().registry.source('GITHUB:PR:5')?.status).toBe('COMPLETE')
  f.restart()
  for (const commit of commits) {
    expect(f.store().registry.contextGraph({ kind: 'PR', id: '5' }).nodes.some(n => n.id === commit)).toBe(true)
    expect(f.store().registry.contextGraph({ kind: 'COMMIT', id: commit }).nodes.some(n => n.type === 'PR' && n.id === '5')).toBe(true)
  }
  const rows = f.rows(); rows[0] = { ...rows[0], head: { ...rows[0].head, sha: sha(9999) }, state: 'closed', merged: true }
  f.setRows(rows)
  for (let round = 0; round < 5; round++) await reconcileRegistry(f.store(), runner, f.root, undefined, () => {}, read)
  expect(f.store().registry.source('GITHUB:PR:5')?.revision).toBe(sha(9999))
  const map = discoverExecutionContext(f.store(), { selector: { type: 'PR', id: '5' }, mode: 'MAP', depth: 1, limit: 20 })
  expect(map.reconciliation.backlog.details[0]).toMatchObject({ source: 'GITHUB_DISCOVERY' })
  expect(JSON.stringify(map)).not.toContain('PRIVATE_')
}, 20000)

it('atomically rolls back discovery entities and cursor and retains core cursors beyond one catalog page', async () => {
  const f = fixture()
  const batches = await f.step('crash', undefined, false)
  let calls = 0
  expect(() => f.store().registry.applyAll(batches, () => { if (++calls === 5) throw new Error('CANCELLED') })).toThrow('CANCELLED')
  expect(f.store().registry.source('GITHUB_DISCOVERY')).toBeUndefined()
  expect(f.store().registry.pendingReconciliation('PR', 200)).toEqual([])
  f.store().registry.applyAll([{ repositoryId: 'repo', source: 'CONTINUUM', revision: 'old', cursor: 'saved-safe-cursor', status: 'COMPLETE', edges: [] }], () => {})
  await f.step(); await f.step(); await f.step(); await f.step()
  expect(f.store().registry.cursors().CONTINUUM).toBe('saved-safe-cursor')
})
it('handles empty repositories and rejects foreign repositories, malformed order and unverifiable pages without COMPLETE', async () => {
  const f = fixture(0)
  await f.step(); await f.step()
  expect(f.store().registry.source('GITHUB_DISCOVERY')?.status).toBe('COMPLETE')
  const before = f.store().registry.source('GITHUB_DISCOVERY')!.cursor
  f.read.mockResolvedValueOnce({ repositoryId: 'foreign', providerRepositoryId: 'remote', scope: digest('account-A'), items: [], hasNext: false, observedAt: new Date().toISOString(), representation: { page: 1, etag: null as any, notModified: false, revision: 'invalid' } })
  const batches = await f.step('same-process', 1_800_000_100_000)
  expect(batches.at(-1)?.status).toBe('UNAVAILABLE')
  expect(JSON.parse(batches.at(-1)!.cursor!).reasonCode).toBe('REMOTE_IDENTITY_MISMATCH')
  expect(before).not.toBeUndefined()
  const unsorted = fixture(2); unsorted.setRows([item(1, '2026-01-01T00:00:00Z'), item(2, '2026-11-01T00:00:00Z')])
  await unsorted.step()
  expect(unsorted.store().registry.source('GITHUB_DISCOVERY')?.status).toBe('UNAVAILABLE')
})

it('rejects a duplicated immutable PR across non-adjacent pages without advancing the safe watermark', async () => {
  const f = fixture(201)
  await f.step(); await f.step()
  const rows = f.rows(); rows[200] = item(201); f.setRows(rows)
  await f.step()
  const cursor = JSON.parse(f.store().registry.source('GITHUB_DISCOVERY')!.cursor!)
  expect(cursor).toMatchObject({ page: 1, phase: 'FULL', reasonCode: 'CATALOG_PAGE_OVERLAP' })
  expect(cursor.highWatermarkUpdatedAt).toBeUndefined()
  expect(f.store().registry.source('GITHUB_DISCOVERY')?.status).toBe('PARTIAL')
})

it('preserves the prior watermark if overlap is detected in a would-be complete last batch', async () => {
  const f = fixture(1)
  await f.step(); await f.step()
  const old = JSON.parse(f.store().registry.source('GITHUB_DISCOVERY')!.cursor!).highWatermarkUpdatedAt
  const batches = await f.step('new-runtime', 1_800_001_000_000, false)
  f.store().registry.applyAll(batches, () => {})
  const pass = JSON.parse(batches[0].cursor!).scanPass
  const discovery = batches.at(-1)!
  const unsafe = { ...JSON.parse(discovery.cursor!), phase: 'IDLE', highWatermarkUpdatedAt: '2099-01-01T00:00:00Z' }
  f.store().registry.applyAll([{ ...batches[0], cursor: JSON.stringify({ ...JSON.parse(batches[0].cursor!), scanPass: pass }) }, { ...discovery, status: 'COMPLETE', cursor: JSON.stringify(unsafe) }], () => {})
  const actual = JSON.parse(f.store().registry.source('GITHUB_DISCOVERY')!.cursor!)
  expect(actual.highWatermarkUpdatedAt).toBe(old)
  expect(f.store().registry.source('GITHUB_DISCOVERY')?.status).toBe('PARTIAL')
})
it('persists a safe restart after network revocation but aborts repository cancellation without applying data', async () => {
  const f = fixture(), cursor = JSON.stringify({ version: 1, phase: 'FULL', page: 2, epoch: 'process', rolling: digest('partial'), highWatermarkUpdatedAt: '2026-10-01T00:00:00Z' })
  const batches = await discoverGitHubPage({ repositoryId: 'repo', root: f.root, read: f.read, cursor, epoch: 'process', assertCurrent: () => {}, assertNetwork: () => { throw new Error('NETWORK_NOT_AUTHORIZED') } })
  expect(f.read).not.toHaveBeenCalled()
  expect(batches[0].status).toBe('NETWORK_NOT_AUTHORIZED')
  expect(JSON.parse(batches[0].cursor!)).toMatchObject({ page: 1, highWatermarkUpdatedAt: '2026-10-01T00:00:00Z', reasonCode: 'NETWORK_NOT_AUTHORIZED' })
  await expect(discoverGitHubPage({ repositoryId: 'repo', root: f.root, read: f.read, epoch: 'process', assertCurrent: () => { throw new Error('PROJECT_CONTEXT_CHANGED') } })).rejects.toThrow('PROJECT_CONTEXT_CHANGED')
})

it('keeps foreign-source PR facts but conflicts their commit evidence without starving eligible PRs', async () => {
  const f = fixture(2), rows = f.rows(), head = rows[0].head.sha
  rows[0] = { ...rows[0], head: { ...rows[0].head, repositoryId: 'fork', repository: 'foreign/repo' } }; f.setRows(rows)
  f.store().registry.applyAll([{ repositoryId: 'repo', source: 'GITHUB:PR:2:1', revision: head, status: 'COMPLETE', edges: [{ from: { kind: 'COMMIT', id: sha(900) }, relation: 'member-of', to: { kind: 'PR', id: '2' }, evidenceKind: 'GITHUB_COMMIT_LIST', evidenceRef: 'previous-snapshot', digest: digest('old'), freshness: 'OBSERVED_SNAPSHOT' }] }], () => {})
  const github = { pullRequestCatalogPage: f.read, commitPullRequests: async () => [], getPullRequest: vi.fn(async (_root, number) => ({ pullRequest: { head: { sha: rows.find(pr => pr.number === number)!.head.sha } } })),
    pullRequestCommits: vi.fn(async () => ({ repositoryId: 'repo', commits: [], nextPage: null })) }
  const read = registrySources({ repositoryId: 'repo', root: f.root, github: github as any, continuum: () => ({ assertRepository: () => {}, list: () => ({ artifacts: [] }), get: () => null }) as any,
    ledger: { projectionPage: async () => ({ proofs: [], more: false, cursor: 'end' }) } as any, networkAllowed: () => true, assertCurrent: () => {} })
  for (let round = 0; round < 5; round++) await reconcileRegistry(f.store(), async () => ({ code: 1, text: '', limited: false }), f.root, undefined, () => {}, read)
  expect(f.store().registry.source('GITHUB:PR:2')?.status).toBe('CONFLICT')
  expect(f.store().registry.source('GITHUB:PR:1')?.status).toBe('COMPLETE')
  expect(f.store().registry.pendingReconciliation('PR', 1)).toEqual([])
  expect(github.getPullRequest.mock.calls.every(call => call[1] !== 2)).toBe(true)
  expect(f.store().registry.map({ kind: 'PR', id: '2' }).edges.every(edge => edge.state === 'CONFLICT')).toBe(true)
  expect(f.store().registry.contextGraph({ kind: 'PR', id: '2' }).edges.every(edge => edge.state === 'UNKNOWN')).toBe(true)
})

it('restarts from the top after a paused partial scan in the same process', async () => {
  const f = fixture(), now = 1_800_000_000_000
  await f.step('process', now)
  await f.step('process', now + 60001)
  expect(f.requests).toEqual([1, 1])
  expect(f.store().registry.source('GITHUB_DISCOVERY')?.status).toBe('PARTIAL')
  expect(JSON.parse(f.store().registry.source('GITHUB_DISCOVERY')!.cursor!).highWatermarkUpdatedAt).toBeUndefined()
})

it('continues beyond the legacy thousand-page boundary without increasing one-page round work', async () => {
  const f = fixture(1)
  f.read.mockResolvedValueOnce({ repositoryId: 'repo', providerRepositoryId: 'remote', scope: digest('account-A'), items: [item(1)], hasNext: true, observedAt: new Date().toISOString(), representation: { page: 1000, etag: 'page-1000', notModified: false, revision: digest('page') } })
  const result = await discoverGitHubPage({ repositoryId: 'repo', root: f.root, read: f.read, epoch: 'process', cursor: JSON.stringify({ version: 1, epoch: 'process', phase: 'FULL', page: 1000, rolling: digest('prior-pages') }), assertCurrent: () => {} })
  expect(f.read).toHaveBeenCalledTimes(1)
  expect(f.read.mock.calls[0][1]).toBe(1000)
  expect(JSON.parse(result.at(-1)!.cursor!).page).toBe(1001)
  expect(result.at(-1)?.status).toBe('PARTIAL')
})
