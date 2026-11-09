import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSync } from 'esbuild'
import { ChannelUsageStore } from './channel-usage-store'
import { ChannelUsage } from './channel-usage'
import { ChannelMcpAdapter } from './channel-mcp-adapter'
import { createMcpHttpServer } from './mcp-http-server'
import type { UsageBatch, UsageQuery } from './channel-usage-types'

const query = (overrides: Partial<UsageQuery> = {}): UsageQuery => ({ view: 'overview', days: '30', sort: 'calls', order: 'desc', availability: 'exposed', includeInstrumental: true, includeDaily: false, limit: 10, ...overrides })
const at = Date.parse('2026-11-08T00:00:00Z')
const tool = (name: string) => ({ name, capability: 'Code Navigation', instrumental: false })
const event = (name: string, time = at, repositoryId = 'r1') => ({ ...tool(name), at: time, repositoryId, status: 'success' as const, durationMs: 10 })
let batchSequence = 0
const batch = (overrides: Partial<UsageBatch> = {}): UsageBatch => ({ id: ++batchSequence, runId: 'run', startedAt: at - 1000, at: at + 1000, completions: [], catalogs: [], losses: 0, ...overrides })
const closers: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close() })
const setup = () => { const base = mkdtempSync(join(tmpdir(), 'channel-usage-')); return { base, path: join(base, 'usage.sqlite') } }
const buildWorker = (base: string) => {
  if (process.env.CHANNEL_USAGE_BUILT_SMOKE === '1') return join(process.cwd(), 'out/main/channel-usage-worker.js')
  const worker = join(base, 'worker.cjs')
  const built = buildSync({ entryPoints: ['src/main/mcp/channel-usage-worker.ts'], bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false }).outputFiles[0].text
  writeFileSync(worker, `require = require('node:module').createRequire(${JSON.stringify(join(process.cwd(), 'package.json'))});\n` + built)
  return worker
}

describe('Channel historical usage SQLite and worker acceptance', () => {
  it('persists exact counts across restart, UTC rollover, retries, repositories and timeout subsets', () => {
    const f = setup()
    let store = new ChannelUsageStore(f.path)
    const data = batch({ catalogs: [{ at: at - 1000, repositoryId: 'r1', tools: [tool('a'), tool('zero')] }],
      completions: [event('a', at - 1), event('a'), { ...event('a'), status: 'timeout' }, { ...event('a', at, 'r2'), status: 'error', durationMs: 30 }] })
    store.write(data); store.write(data)
    expect(store.query(query(), at + 1000)).toMatchObject({ calls: 4, errors: 2, timeouts: 1, toolsWithCalls: 1, exposedZeroTools: 1 })
    store.close()
    store = new ChannelUsageStore(f.path); closers.push(() => store.close())
    expect(store.query(query({ repositoryId: 'r1' }), at + 1000)).toMatchObject({ calls: 3, errors: 1, timeouts: 1 })
    expect(store.query(query({ view: 'tool', toolName: 'a', includeDaily: true }), at + 1000)).toMatchObject({
      tool: { calls: 4, successes: 2, errors: 2, timeouts: 1, averageDurationMs: 15, maxDurationMs: 30 },
      daily: [{ day: '2026-11-07', calls: 1 }, { day: '2026-11-08', calls: 3 }] })
    const bytes = readFileSync(f.path).toString('utf8')
    expect(bytes).not.toContain('requestId'); expect(bytes).not.toContain('sessionId')
  })

  it('distinguishes exposure, recent zero, unexposed and loss windows, with stable paginated rankings', () => {
    const f = setup(), store = new ChannelUsageStore(f.path); closers.push(() => store.close())
    store.write(batch({ catalogs: [{ at: at - 1000, repositoryId: 'r1', tools: [tool('a'), tool('b'), tool('z')] }], completions: [event('a')] }))
    store.write(batch({ at: at + 2000, catalogs: [{ at: at + 1500, repositoryId: 'r1', tools: [tool('a'), tool('b'), tool('recent')] }], losses: 2 }))
    const ranking = query({ view: 'ranking', order: 'asc', limit: 1 })
    const first = store.query(ranking, at + 2000) as any
    expect(first.items[0]).toMatchObject({ toolName: 'b', calls: 0, availability: 'EXPOSED_NO_OBSERVED_CALLS' })
    store.write(batch({ at: at + 2500, completions: [event('b'), event('b')] }))
    const second = store.query({ ...ranking, cursor: first.nextCursor }, at + 3000) as any
    expect(second.items[0]).toMatchObject({ toolName: 'recent', calls: 0 })
    expect(second.coverage.lostRecords).toBe(2)
    expect(second.period.asOf).toBe(first.period.asOf)
    expect(() => store.query({ ...ranking, repositoryId: 'other', cursor: first.nextCursor }, at + 3000)).toThrow('USAGE_CURSOR_STALE')
    const all = store.query(query({ view: 'ranking', availability: 'all', repositoryId: 'r2' }), at + 3000) as any
    expect(all.items.every((r: any) => r.availability === 'NOT_EXPOSED_IN_WINDOW')).toBe(true)
    expect(store.query(query({ view: 'tool', toolName: 'a' }), at + 3000)).not.toHaveProperty('daily')
  })

  it('keeps all windows UTC and exposes unclean restart coverage and instruments explicitly', () => {
    const f = setup(), store = new ChannelUsageStore(f.path); closers.push(() => store.close())
    store.write(batch({ catalogs: [{ at: at - 1000, repositoryId: null, tools: [{ name: 'get_channel_usage', capability: 'Channel', instrumental: true }] }],
      completions: [{ ...event('get_channel_usage'), capability: 'Channel', instrumental: true, repositoryId: null }] }))
    store.write(batch({ runId: 'restarted', startedAt: at + 10000, at: at + 11000, stopped: true }))
    for (const days of ['7', '15', '30', '60', '90', '180', '365', 'all'] as const) {
      const overview = store.query(query({ days }), at + 11000) as any
      expect(overview.calls).toBe(1)
      expect(overview.period.start.endsWith(days === 'all' ? '23:59:59.000Z' : '00:00:00.000Z')).toBe(true)
      expect(overview.coverage.windows).toEqual(expect.arrayContaining([expect.objectContaining({ cleanStop: false }), expect.objectContaining({ cleanStop: true })]))
    }
    expect((store.query(query({ view: 'ranking', includeInstrumental: false }), at + 11000) as any).items).toEqual([])
    expect((store.query(query({ view: 'tool', toolName: 'get_channel_usage', includeInstrumental: false }), at + 11000) as any).tool.calls).toBe(1)
  })

  it('survives real worker release/restart and preserves HTTP calls and exposed zeros', async () => {
    const f = setup()
    const worker = buildWorker(f.base)
    let usage = new ChannelUsage(f.path, worker, 2048, 20)
    const adapter = new ChannelMcpAdapter({ projectId: 'r1', repoRoot: '/repo', navigation: {} as any }, undefined, { getIdentityPayload: () => ({ instanceId: 'controlled-runtime' }) } as any)
    adapter.setUsage(usage)
    const server = createMcpHttpServer(adapter, () => {})
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    closers.push(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await usage.close() })
    const call = async (name: string, args: object) => {
      const response = await fetch(`http://127.0.0.1:${(server.address() as any).port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
      return (await response.json() as any).result
    }
    const before = await call('get_runtime_identity', {})
    await usage.flush()
    await new Promise(resolve => setTimeout(resolve, 100))
    expect((usage as any).worker).toBeUndefined()
    const overview = JSON.parse((await call('get_channel_usage', {})).content[0].text)
    expect(overview.calls).toBe(1)
    expect(overview.exposedZeroTools).toBeGreaterThan(0)
    adapter.stopUsage(); await usage.close()
    usage = new ChannelUsage(f.path, worker)
    adapter.setUsage(usage)
    expect(await call('get_runtime_identity', {})).toEqual(before)
    const after = JSON.parse((await call('get_channel_usage', { view: 'tool', toolName: 'get_runtime_identity' })).content[0].text)
    expect(after.tool.calls).toBe(2)
    expect(after.tool.errors).toBe(0)
    const instrumental = JSON.parse((await call('get_channel_usage', { view: 'tool', toolName: 'get_channel_usage' })).content[0].text)
    expect(instrumental.tool.calls).toBe(2)
  }, 15000)

  it('reports disk failures and overflow, recovers on new activity and leaves no worker after close', async () => {
    const f = setup(), blocked = join(f.base, 'blocked')
    writeFileSync(blocked, 'test-owned blocking file')
    const usage = new ChannelUsage(join(blocked, 'usage.sqlite'), buildWorker(f.base), 2)
    closers.push(() => usage.close())
    usage.catalog({ at: Date.now(), repositoryId: 'r1', tools: [tool('a'), tool('zero')] })
    for (let i = 0; i < 5; i++) usage.complete(event('a', Date.now()))
    await usage.flush()
    expect((usage as any).losses).toBeGreaterThanOrEqual(5)
    unlinkSync(blocked)
    usage.complete(event('a', Date.now()))
    const result = await usage.query(query()) as any
    expect(result.calls).toBe(1)
    expect(result.coverage.lostRecords).toBeGreaterThanOrEqual(5)
    expect(result.coverage.lossWindows.length).toBeGreaterThan(0)
    expect(result.coverage.windows[0].state).toBe('ACTIVE')
    expect(result.coveredZeroTools).toBe(0)
    await usage.close()
    expect((usage as any).worker).toBeUndefined()
    expect((usage as any).pending.size).toBe(0)
  }, 15000)

  it('keeps the Main loop responsive while the real worker writes concurrent completions', async () => {
    const f = setup(), usage = new ChannelUsage(f.path, buildWorker(f.base))
    closers.push(() => usage.close())
    usage.catalog({ at: Date.now(), repositoryId: 'r1', tools: [tool('a')] })
    const latencies: number[] = []
    let previous = performance.now()
    const timer = setInterval(() => { const now = performance.now(); latencies.push(now - previous); previous = now }, 5)
    try {
      await Promise.all(Array.from({ length: 10 }, async () => {
        for (let i = 0; i < 100; i++) usage.complete(event('a', Date.now()))
        await new Promise(resolve => setTimeout(resolve, 1))
      }))
      await usage.flush()
      expect((await usage.query(query()) as any).calls).toBe(1000)
      expect(latencies.length).toBeGreaterThan(1)
      const maxTick = Math.max(...latencies)
      console.info(JSON.stringify({ realWorkerMainLoopMaxTickMs: maxTick, calls: 1000 }))
      expect(maxTick).toBeLessThan(250)
    } finally { clearInterval(timer) }
  }, 15000)

  it('keeps proportional adapter latency and main loop responsiveness under representative load', async () => {
    const f = setup(), usage = new ChannelUsage(f.path, '/not-started.js')
    const adapter = new ChannelMcpAdapter({} as any)
    vi.spyOn(adapter as any, 'dispatchTool').mockResolvedValue({ content: [{ type: 'text', text: '{}' }] })
    const run = async () => { const start = performance.now(); for (let i = 0; i < 2000; i++) await adapter.callTool('get_runtime_identity', {}); return performance.now() - start }
    await run()
    const baseline = await run()
    adapter.setUsage(usage)
    const enabled = await run()
    const overheadPerCall = Math.max(0, enabled - baseline) / 2000
    console.info(JSON.stringify({ baselineMs: baseline, enabledMs: enabled, overheadMsPerCall: overheadPerCall, queued: (usage as any).completions.length }))
    expect(overheadPerCall).toBeLessThan(0.1)
    expect((usage as any).worker).toBeUndefined()
    await usage.close()
  })
})
