import { describe, it, expect, vi } from 'vitest'
import { ChannelMcpAdapter } from './channel-mcp-adapter'
import { executeGetChannelUsage } from './channel-usage-mcp'
import { ChannelUsage } from './channel-usage'
import type { ChannelUsagePort } from './channel-usage-types'

const navigation = {} as any
const decode = (result: any) => JSON.parse(result.content[0].text)
const recorder = (): ChannelUsagePort => ({ complete: vi.fn(), catalog: vi.fn(), query: vi.fn(async () => ({ calls: 0 })) })

describe('Channel usage instrumentation and contract', () => {
  it('classifies every published tool in conditional catalogs and records only changed exposures', () => {
    const usage = recorder()
    const context = { projectId: 'p', repoRoot: '/repo', navigation: { inspectWorktreeStructure() {} },
      continuum: { repositoryId: 'canonical-repo', inspectStructure() {}, readSection() {} },
      executionClosure: {}, visualContinuum: {}, validationExecution: {}, diagnosticSourceAccess: {}, runtimeRestart: {}, gitOperations: {},
      githubIntegration: { canCreatePullRequests: () => true, canIntegratePullRequests: () => true }, githubPrIsActive: () => true,
      repositoryFileIngress: {}, repositoryFileEditing: {}, runtimePreview: {}, sessionContext: {}, cliExecution: {} } as any
    const adapter = new ChannelMcpAdapter(context, undefined, undefined, {} as any, {} as any)
    adapter.setUsage(usage)
    const tools = adapter.listTools()
    expect(tools.length).toBeGreaterThan(100)
    expect(new Set(tools.map(t => t.name)).size).toBe(tools.length)
    for (const tool of tools) expect(adapter.capabilityForTool(tool.name), tool.name).toBeTruthy()
    expect(usage.catalog).toHaveBeenCalledTimes(1)
    context.githubIntegration.canCreatePullRequests = () => false
    context.githubIntegration.canIntegratePullRequests = () => false
    expect(adapter.listTools().some(t => t.name === 'create_pull_request')).toBe(false)
    expect(usage.catalog).toHaveBeenCalledTimes(2)
    adapter.stopUsage()
    expect(vi.mocked(usage.catalog).mock.calls.at(-1)![0].tools).toEqual([])
    console.info('Discovered complete conditional catalog:', tools.length)
  })

  it('captures original repository, unknown sanitized name, timeout once, and preserves Activity', async () => {
    let release!: (value: any) => void
    const usage = recorder()
    const context = { projectId: 'p', repoRoot: '/repo', navigation, continuum: { repositoryId: 'first' } } as any
    const adapter = new ChannelMcpAdapter(context)
    adapter.setUsage(usage)
    vi.spyOn(adapter as any, 'dispatchTool').mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const pending = adapter.callTool('get_artifact', { private: 'NEVER_PERSIST' })
    context.continuum.repositoryId = 'second'
    release({ content: [{ type: 'text', text: '{"code":"REQUEST_TIMEOUT"}' }], isError: true })
    await pending
    expect(usage.complete).toHaveBeenCalledTimes(1)
    expect(vi.mocked(usage.complete).mock.calls[0][0]).toMatchObject({ name: 'get_artifact', capability: 'Continuum', repositoryId: 'first', status: 'timeout' })
    await adapter.callTool('bad\nname', {})
    expect(vi.mocked(usage.complete).mock.calls[1][0]).toMatchObject({ name: 'bad_name', capability: 'unclassified', status: 'error' })
    expect(JSON.stringify(vi.mocked(usage.complete).mock.calls)).not.toContain('NEVER_PERSIST')
    expect(adapter.getActivityState()).toMatchObject({ totalRequests: 2, activeRequests: 0, timedOutRequests: 1, failedRequests: 1 })
  })

  it('fails open for consumers and keeps global capability events unattributed to a repository', async () => {
    const usage = recorder()
    vi.mocked(usage.complete).mockImplementation(() => { throw new Error('disk') })
    const adapter = new ChannelMcpAdapter({ projectId: 'p', repoRoot: '/repo', navigation, continuum: { repositoryId: 'repo' } } as any)
    adapter.setUsage(usage)
    vi.spyOn(adapter as any, 'dispatchTool').mockResolvedValue({ content: [{ type: 'text', text: '{}' }] })
    await expect(adapter.callTool('get_runtime_identity', {})).resolves.toBeDefined()
    expect(usage.complete).toHaveBeenCalledWith(expect.objectContaining({ repositoryId: null }))
    expect(adapter.getActivityState().activeRequests).toBe(0)
  })

  it('validates selectors, repository authorization and response budgets before data disclosure', async () => {
    const usage = recorder()
    for (const args of [{ sql: 'select *' }, { view: 'tool' }, { limit: 51 }, { days: '14' }, { includeDaily: true }, { cursor: 'x' }]) {
      expect(decode(await executeGetChannelUsage(usage, args, 'repo')).code).toBe('USAGE_INVALID_ARGUMENT')
    }
    expect(decode(await executeGetChannelUsage(usage, { repositoryId: 'other' }, 'repo')).code).toBe('USAGE_REPOSITORY_UNAUTHORIZED')
    expect(usage.query).not.toHaveBeenCalled()
    await executeGetChannelUsage(usage, { view: 'tool', toolName: 'get_channel_usage' }, 'repo')
    expect(usage.query).toHaveBeenCalledWith(expect.objectContaining({ includeDaily: false, days: '30', limit: 10 }))
    vi.mocked(usage.query).mockResolvedValue('x'.repeat(65536))
    expect(decode(await executeGetChannelUsage(usage, {}, 'repo')).code).toBe('USAGE_RESPONSE_BUDGET_EXCEEDED')
  })

  it('keeps recording bounded, lazy and independent of an unavailable worker', async () => {
    const unused = new ChannelUsage('never-created.sqlite', '/missing-worker.js')
    const rpc = vi.spyOn(unused as any, 'rpc')
    await unused.close()
    expect(rpc).not.toHaveBeenCalled()
    const usage = new ChannelUsage('not-opened.sqlite', '/missing-worker.js', 2)
    for (let i = 0; i < 100; i++) usage.complete({ name: 't', capability: 'c', instrumental: false, at: Date.now(), repositoryId: null, status: 'success', durationMs: 1 })
    expect((usage as any).worker).toBeUndefined()
    expect((usage as any).completions).toHaveLength(2)
    expect((usage as any).losses).toBe(98)
    await usage.close()
    expect((usage as any).worker).toBeUndefined()
    expect((usage as any).pending.size).toBe(0)
  })
})
