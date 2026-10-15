import { expect, it, vi } from 'vitest'
import { GitHubApiClient } from './github-api-client'

const dto = { id: 123, number: 7, state: 'closed', merged: true, merged_at: '2026-10-15T13:00:00Z', merge_commit_sha: 'c'.repeat(40),
  base: { ref: 'main', sha: 'a'.repeat(40), repo: { id: 1, full_name: 'owner/repo' } },
  head: { ref: 'feature', sha: 'b'.repeat(40), repo: { id: 2, full_name: 'fork/repo' } } }

it('preserves verified PR identity, fork, submitted head and merge metadata without testing ancestry', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(dto)))
  const result = await new GitHubApiClient(async () => 'secret', fetcher).inspectPullRequestDelivery('owner/repo', 7)
  expect(result).toMatchObject({ status: 'OBSERVED', merged: true, mergeCommit: dto.merge_commit_sha, delivery: { repositoryId: '1', prId: '123', sourceRepositoryId: '2', head: dto.head.sha, targetBranch: 'main' } })
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(JSON.stringify(result)).not.toContain('secret')
})

it.each([
  { merged: false, merged_at: null, merge_commit_sha: null },
  { state: 'open', merged: false, merged_at: null, merge_commit_sha: 'e'.repeat(40) }
])('never equates closed or pre-merge metadata with merged', async override => {
  const api = new GitHubApiClient(async () => 'secret', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...dto, ...override }))))
  expect(await api.inspectPullRequestDelivery('owner/repo', 7)).toMatchObject({ merged: false, mergeCommit: null, mergedAt: null })
})

it.each([{ number: 8 }, { id: null }, { merged: null }, { merged_at: null }, { merge_commit_sha: null }, { base: { ...dto.base, repo: { id: 1, full_name: 'other/repo' } } }])('rejects incoherent identity or merge evidence', async override => {
  const api = new GitHubApiClient(async () => 'secret', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...dto, ...override }))))
  await expect(api.inspectPullRequestDelivery('owner/repo', 7)).rejects.toThrow()
})
