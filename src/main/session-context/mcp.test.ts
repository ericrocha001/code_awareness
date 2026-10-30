import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildSync } from 'esbuild'
import { SessionStore, sessionStorePath } from './store'
import { EntireProvider } from './entire-provider'
import { executeSessionTool, SESSION_CONTEXT_TOOLS, SESSION_RESPONSE_BUDGETS, type SessionToolName } from './mcp'
import { SessionContextClient } from './client'
import { ChannelMcpAdapter } from '../mcp/channel-mcp-adapter'
import type { McpProjectContext } from '../mcp/project-mcp-context'
import type { McpToolResult } from '../mcp/mcp-types'
import { createMcpHttpServer } from '../mcp/mcp-http-server'
import type { EventInput } from './types'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0 })
const data = (result: McpToolResult) => JSON.parse(result.content[0].text)
const sessionInput = (id: string) => ({ providerSessionId: id, providerVersion: 'fixture', agent: 'codex' as const, state: 'ENDED' as const,
  endedAt: '2026-01-01T00:00:00Z', coverage: 'COMPLETE' as const, sourceDigest: id, sourceBytes: 0 })
function setup() {
  const base = mkdtempSync(join(tmpdir(), 'session-channel-'))
  cleanup.push(() => rmSync(base, { recursive: true, force: true }))
  const store = new SessionStore(sessionStorePath(base, 'A'), 'A'); cleanup.push(() => store.close())
  const refresh = vi.fn(async () => ({ coverage: 'UNAVAILABLE', code: 'PROVIDER_UNAVAILABLE' }))
  let current = true
  const assert = () => { if (!current) throw new Error('PROJECT_CONTEXT_CHANGED') }
  const call = (name: SessionToolName, args: unknown) => executeSessionTool(store, { refresh }, name, args, assert)
  const adapter = new ChannelMcpAdapter({ projectId: 'A', repoRoot: base, navigation: {} as McpProjectContext['navigation'], sessionContext: { call } })
  return { base, store, refresh, call, adapter, switchProject: () => { current = false } }
}
function events(n: number): EventInput[] { return Array.from({ length: n }, (_, index) => ({ type: index === 487 ? 'ERROR' : 'AGENT_UPDATE', text: index === 487 ? 'unique failure evidence: token=private-value' : `progress ${index}`, sourcePosition: index + 1 })) }

describe('Session Context progressive MCP disclosure', () => {
  it('finds a specific failure in 740 events with four real Channel HTTP calls and no transcript expansion', async () => {
    const f = setup()
    f.store.ingest(sessionInput('large-session'), events(740))
    const server = createMcpHttpServer(f.adapter, () => {})
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
    const address = server.address() as { port: number }
    const call = async (name: SessionToolName, args: unknown) => {
      const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
      const text = await response.text()
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(SESSION_RESPONSE_BUDGETS[name])
      return { value: data(JSON.parse(text).result), text }
    }
    const catalog = await call('list_agent_sessions', {})
    const session = catalog.value.sessions[0]
    expect(catalog.text).not.toContain('progress'); expect(catalog.text).not.toContain('unique failure')
    const map = await call('inspect_agent_session', { sessionId: session.sessionId })
    expect(map.value.types).toContainEqual({ type: 'ERROR', count: 1 })
    expect(map.text).not.toContain('unique failure'); expect(map.text).not.toContain('progress 1')
    const selected = await call('list_agent_session_events', { sessionId: session.sessionId, types: ['ERROR'] })
    expect(selected.value.events).toHaveLength(1)
    const literal = await call('read_agent_session_event', { sessionId: session.sessionId, eventId: selected.value.events[0].eventId, expectedRevision: selected.value.revision })
    expect(literal.value).toMatchObject({ content: 'unique failure evidence: token=[REDACTED]', complete: true, sanitized: true, untrusted: true, claimsVerified: false })
    expect(f.refresh).not.toHaveBeenCalled()
    expect(SESSION_CONTEXT_TOOLS.every(tool => f.adapter.listTools().some(published => published.name === tool.name))).toBe(true)
  })
  it('paginates all four levels within escaped wire budgets and rejects changed filters, revisions, foreign IDs and global access', async () => {
    const f = setup()
    for (let n = 0; n < 30; n++) f.store.ingest(sessionInput(`session-${n}`), [])
    const text = ('"\\\n🧪').repeat(5000)
    const imported = f.store.ingest(sessionInput('payload'), [{ type: 'INPUT', text, sourcePosition: 1 }, ...events(2000)])
    let cursor: string | undefined, count = 0
    do {
      const result = await f.call('list_agent_sessions', { limit: 20, cursor })
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(8192)
      const page = data(result); count += page.sessions.length; cursor = page.nextCursor
    } while (cursor)
    expect(count).toBe(31)
    const firstMap = data(await f.call('inspect_agent_session', { sessionId: imported.sessionId, limit: 1 }))
    expect(firstMap.nextCursor).toBeDefined()
    expect(data(await f.call('inspect_agent_session', { sessionId: imported.sessionId, limit: 1, cursor: firstMap.nextCursor })).segments[0].first).toBe(101)
    const firstEvents = data(await f.call('list_agent_session_events', { sessionId: imported.sessionId, limit: 1 }))
    expect(data(await f.call('list_agent_session_events', { sessionId: imported.sessionId, types: ['ERROR'], cursor: firstEvents.nextCursor }))).toMatchObject({ code: 'CURSOR_STALE' })
    const stored = f.store.event(imported.sessionId, firstEvents.events[0].eventId)
    let literal = '', pages = 0; cursor = undefined
    do {
      const result = await f.call('read_agent_session_event', { sessionId: imported.sessionId, eventId: stored.id, expectedRevision: imported.revision, cursor })
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(16384)
      const page = data(result); literal += page.content; cursor = page.nextCursor; pages++
      expect(page.omission).toBe('LIMIT_REACHED')
    } while (cursor)
    expect(literal).toBe(stored.text); expect(pages).toBeGreaterThan(1)
    expect(literal).not.toContain('�')
    const foreign = new SessionStore(sessionStorePath(f.base, 'B'), 'B'); cleanup.push(() => foreign.close())
    const other = foreign.ingest(sessionInput('foreign'), events(1))
    expect(data(await f.call('inspect_agent_session', { sessionId: other.sessionId })).code).toBe('SESSION_UNAVAILABLE')
    expect(data(await f.call('list_agent_sessions', { repositoryId: 'B' })).code).toBe('INVALID_ARGUMENT')
    f.store.ingest({ ...sessionInput('payload'), sourceDigest: 'changed' }, events(5))
    expect(data(await f.call('inspect_agent_session', { sessionId: imported.sessionId, cursor: firstMap.nextCursor, limit: 1 })).code).toBe('CURSOR_STALE')
    expect(data(await f.call('read_agent_session_event', { sessionId: imported.sessionId, eventId: stored.id, expectedRevision: imported.revision })).code).toBe('REVISION_CONFLICT')
    expect(data(await f.call('list_agent_sessions', { executionId: 'unverified' })).sessions).toEqual([])
    f.switchProject()
    for (const tool of SESSION_CONTEXT_TOOLS) expect(data(await f.call(tool.name as SessionToolName, {})).code).toBe('PROJECT_CONTEXT_CHANGED')
  })
  it('reports evicted sessions and provider absence honestly, never resurrecting them from a read', async () => {
    const f = setup()
    const first = f.store.ingest(sessionInput('first'), events(1))
    const payload = f.store.events(first.sessionId, {}, 0, 1)[0]
    for (let n = 1; n <= 500; n++) f.store.ingest({ ...sessionInput(`next-${n}`), endedAt: '2026-02-01T00:00:00Z' }, [])
    expect(data(await f.call('read_agent_session_event', { sessionId: first.sessionId, eventId: payload.id, expectedRevision: 1 })).code).toBe('SESSION_UNAVAILABLE')
    const provider = new EntireProvider(f.store, f.base, () => {})
    expect(await provider.refresh()).toMatchObject({ code: 'PROVIDER_UNAVAILABLE', coverage: 'UNAVAILABLE' })
    expect(f.store.count()).toBe(500)
  })
  it('runs the genuine worker off the main event loop, persists across restart and rejects project-switch races', async () => {
    const f = setup(), output = process.env.SESSION_CONTEXT_BUILT_SMOKE === '1' ? join(process.cwd(), 'out/main/session-context-worker.js') : join(f.base, 'worker.cjs')
    if (process.env.SESSION_CONTEXT_BUILT_SMOKE !== '1') {
      const code = buildSync({ entryPoints: ['src/main/session-context/worker.ts'], bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false }).outputFiles[0].text
      writeFileSync(output, `require = require('node:module').createRequire(${JSON.stringify(join(process.cwd(), 'package.json'))});\n` + code)
    }
    f.store.ingest(sessionInput('worker-session'), events(740))
    let current = true, ticks = 0
    const timer = setInterval(() => ticks++, 1); cleanup.push(() => clearInterval(timer))
    const client = new SessionContextClient(f.base, 'A', f.base, () => current, output); cleanup.push(() => client.dispose())
    const catalog = data(await client.call('list_agent_sessions', {}))
    expect(catalog.sessions[0].eventCount).toBe(740)
    expect(ticks).toBeGreaterThan(5)
    expect(data(await client.call('refresh_agent_sessions', {}))).toMatchObject({ coverage: 'UNAVAILABLE', code: 'PROVIDER_UNAVAILABLE' })
    client.dispose()
    const restarted = new SessionContextClient(f.base, 'A', f.base, () => current, output); cleanup.push(() => restarted.dispose())
    expect(data(await restarted.call('inspect_agent_session', { sessionId: catalog.sessions[0].sessionId })).eventCount).toBe(740)
    const raced = restarted.call('list_agent_sessions', {})
    current = false; restarted.dispose()
    expect(data(await raced).code).toBe('PROJECT_CONTEXT_CHANGED')
    await new Promise(resolve => setTimeout(resolve, 150))
  })
})
