import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { GitHubApiClient } from './github-api-client'
import { GitHubIntegrationService } from './github-integration-service'
import { ChannelMcpAdapter } from '../mcp/channel-mcp-adapter'
import { createMcpHttpServer, type McpOperationalLogEntry } from '../mcp/mcp-http-server'

const sha = 'b'.repeat(40)
const input = { headBranch: 'cline/proof', baseBranch: 'main', expectedHeadSha: sha, title: 'private PR title', body: 'private description', operationId: 'http-proof', worktreeId: 'c'.repeat(64) }
const root = mkdtempSync(join(tmpdir(), 'pr-http-'))
const logs: McpOperationalLogEntry[] = []
let exists = false
const pr = () => ({ number: 23, html_url: 'https://github.com/owner/repo/pull/23', title: input.title, state: 'open', draft: false, merged_at: null, head: { ref: input.headBranch, sha, repo: { full_name: 'owner/repo' } }, base: { ref: 'main', sha: 'a'.repeat(40), repo: { full_name: 'owner/repo' } } })
const json = (body: unknown) => new Response(JSON.stringify(body))
const rest = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
  const path = new URL(String(url)).pathname
  if (path === '/repos/owner/repo') return json({ id: 7, name: 'repo', full_name: 'owner/repo', owner: { id: 9, login: 'owner' }, html_url: 'https://github.com/owner/repo', clone_url: 'https://github.com/owner/repo.git', permissions: { pull: true, push: true } })
  if (path === '/user/installations') return json({ installations: [{ id: 1, app_slug: 'ours', account: { login: 'owner' }, permissions: { pull_requests: 'write' } }] })
  if (path === '/user/installations/1/repositories') return json({ repositories: [{ id: 7 }] })
  if (path.includes('/git/ref/heads/')) { const branch = decodeURIComponent(path.split('/git/ref/heads/')[1]); return json({ ref: `refs/heads/${branch}`, object: { type: 'commit', sha: branch === 'main' ? 'a'.repeat(40) : sha } }) }
  if (path.endsWith('/pulls/23')) return json(pr())
  if (path.endsWith('/pulls')) {
    if (init?.method === 'POST') { exists = true; return json(pr()) }
    return json(exists ? [pr()] : [])
  }
  throw new Error('Unexpected REST endpoint')
})
const approve = vi.fn(async () => true)
const api = new GitHubApiClient(async () => 'oauth-never-log-this', rest, 'ours')
const integration = new GitHubIntegrationService({ clientId: 'client', appSlug: 'ours' }, {} as any, { hasCredentials: () => true } as any, api,
  { findByPath: () => ({ id: 'repository', github: { fullName: 'owner/repo', repositoryId: '7' } }) } as any,
  { getRemoteUrl: async () => 'git@github.com:owner/repo.git' } as any, {} as any, { receiptDirectory: root, approve })
const adapter = new ChannelMcpAdapter({ projectId: 'project', repoRoot: '/desktop-main', navigation: {} as any, githubIntegration: integration, githubPrIsActive: () => true,
  gitOperations: { inspectWorktree: async () => ({ branch: input.headBranch, head: sha }) } as any })
const server = createMcpHttpServer(adapter, entry => logs.push(entry))
let endpoint: string
beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`
})
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }) })
async function call(name: string, args: unknown, headers: Record<string, string> = {}) {
  return fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
}
function readBody(response: Response) { return response.json() as Promise<{ result: { isError?: boolean; content: Array<{ text: string }> } }> }

it('exposes the same REST capability locally and through relay forwarding headers, with native approval and no secrets in telemetry', async () => {
  expect((await readBody(await call('get_pull_request_access', {}))).result.content[0].text).toContain('READY')
  const created = await readBody(await call('create_pull_request', input))
  expect(JSON.parse(created.result.content[0].text)).toMatchObject({ status: 'CREATED', pullRequest: { number: 23, url: 'https://github.com/owner/repo/pull/23', draft: false } })
  const replay = await readBody(await call('create_pull_request', input, { 'x-code-awareness-request-id': 'relay-request', 'x-code-awareness-session-id': 'relay-connection' }))
  expect(JSON.parse(replay.result.content[0].text)).toMatchObject({ status: 'EXISTING_OPEN', replayed: true })
  expect(rest.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  expect(approve).toHaveBeenCalledTimes(1)
  expect(JSON.stringify(logs)).not.toMatch(/oauth-never-log-this|private PR title|private description/)
  expect(adapter.getActivityState().byCapability['Git Operations'].totalRequests).toBe(3)
})

it.each([{ origin: 'https://attacker.example' }, { origin: 'null' }])('rejects arbitrary browser origins before approval %j', async headers => {
  const approvals = approve.mock.calls.length
  expect((await call('create_pull_request', input, headers)).status).toBe(403)
  expect(approve).toHaveBeenCalledTimes(approvals)
})

it('rejects DNS rebinding Host headers before dispatch', async () => {
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest(endpoint, { method: 'POST', headers: { host: 'attacker.example', 'content-type': 'application/json' } }, response => { response.resume(); resolve(response.statusCode) })
    request.on('error', reject)
    request.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }))
  })
  expect(status).toBe(403)
})

it('requires native consent even on unauthenticated loopback and reports refusal', async () => {
  exists = false; approve.mockResolvedValue(false)
  const denied = await readBody(await call('create_pull_request', { ...input, worktreeId: undefined, headBranch: 'cline/proof-two', operationId: 'denied' }))
  expect(denied.result.isError).toBe(true)
  expect(JSON.parse(denied.result.content[0].text).code).toBe('AUTHORIZATION_DENIED')
  expect(rest.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
})
