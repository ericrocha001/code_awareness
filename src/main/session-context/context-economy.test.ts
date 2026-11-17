import Database from 'better-sqlite3'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { countCanonicalTokens } from '../core/tokenizer'
import { authenticatedAgentPrincipal, authorizeArtifactAgent } from '../continuum/agent-authority'
import { ChannelMcpAdapter } from '../mcp/channel-mcp-adapter'
import type { McpProjectContext } from '../mcp/project-mcp-context'
import { entireFileIdentity } from './entire-source'
import { EntireTranscriptStream, ENTIRE_TRANSCRIPT_NORMALIZERS, normalizeEntireRecord } from './entire-transcript'
import { buildSync } from 'esbuild'
import { createMcpHttpServer } from '../mcp/mcp-http-server'
import { SessionContextClient } from './client'
import { antigravityAppTranscriptPath } from './antigravity-app-locator'
import { discoverAntigravityAppSources } from './native-antigravity-app-source'
import { discoverCodexSources } from './native-codex-source'
import { executeSessionTool, SESSION_CONTEXT_TOOLS, type SessionToolName } from './mcp'
import { nativeDigest } from './native-hooks'
import { SessionStore, sessionStorePath } from './store'
import { sourceFingerprint } from './target'

const cleanup: Array<() => void> = []
afterEach(() => { cleanup.splice(0).reverse().forEach(fn => fn()) })

function safeRemove(dir: string) {
  execFileSync('node', ['-e', "require('node:fs').rmSync(process.argv[1], { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })", dir], { windowsHide: true })
}

it('U5 proves focal investigation reduces canonical tokens and calls vs legacy while preserving legacy contracts', async () => {
  const base = mkdtempSync(join(tmpdir(), 'u5-econ-'))
  cleanup.push(() => safeRemove(base))
  const root = join(base, 'repo')
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git/HEAD'), 'ref: refs/heads/main\n')
  const store = new SessionStore(sessionStorePath(base, 'repo-econ'), 'repo-econ')
  cleanup.push(() => store.close())
  const target = { worktreeId: 'a'.repeat(64), generation: 'b'.repeat(64) }

  const providerId = 'entire-u5-1'
  const meta = store.ingest({
    providerSessionId: providerId, providerVersion: '0.12.2', agent: 'codex', state: 'ENDED',
    endedAt: '2026-11-17T10:00:00Z', coverage: 'COMPLETE', sourceDigest: 'seed', sourceBytes: 0, importState: 'METADATA_ONLY'
  }, [])
  const transcriptPath = join(root, '.entire/metadata', providerId, 'full.jsonl')
  mkdirSync(dirname(transcriptPath), { recursive: true })
  const errText = 'Validation failed: exit code 1 at src/main/session-context/entire-provider.ts:127'
  const lines: string[] = []
  for (let i = 0; i < 60; i++) {
    lines.push(JSON.stringify({ type: 'event_msg', payload: { type: i === 0 ? 'user_message' : i === 42 ? 'error' : 'agent_message', message: i === 42 ? errText : `Step ${i}` } }))
  }
  const buf = Buffer.from(lines.join('\n') + '\n')
  writeFileSync(transcriptPath, buf)
  const run = store.references.begin(meta.sessionId, { kind: 'ENTIRE_FILE', path: transcriptPath, identity: await entireFileIdentity(transcriptPath) }, ENTIRE_TRANSCRIPT_NORMALIZERS.codex)
  const stream = new EntireTranscriptStream(record => store.references.append(run, normalizeEntireRecord('codex', record, () => undefined)))
  stream.push(buf)
  const parsed = await stream.finish()
  store.references.commit(run, parsed.sourceDigest, parsed.sourceBytes, () => {}, 'COMPLETE')

  const artifactId = 'artifact-11111111-1111-4111-8111-111111111111'
  store.observeWorktree(meta.sessionId, target)
  store.declareAssociation(meta.sessionId, target, { artifactId, sourceArtifactId: artifactId, proofIds: [], expectedCatalogRevision: store.catalogRevision() }, () => {})
  store.registry.apply({
    repositoryId: 'repo-econ', source: 'CONTINUUM', revision: '1', status: 'COMPLETE',
    edges: [{ from: { kind: 'ARTIFACT', id: artifactId }, to: { kind: 'SESSION', id: `entire:${providerId}` }, relation: 'implements', evidenceKind: 'HANDOFF_DECLARED', evidenceRef: artifactId, digest: nativeDigest('e1'), freshness: 'OBSERVED_SNAPSHOT' }]
  }, undefined)

  const readEvent = async (_row: unknown, ev: { sourcePosition: number }, offset: number, size: number) => {
    expect(ev.sourcePosition).toBeGreaterThan(0)
    const slice = errText.slice(offset, offset + size)
    return { content: slice, range: { startByte: offset, endByte: offset + Buffer.byteLength(slice) }, complete: true, partial: false, sanitized: false, payloadDigest: nativeDigest(errText) }
  }
  const adapter = new ChannelMcpAdapter({
    projectId: 'repo-econ', repoRoot: root, navigation: {} as McpProjectContext['navigation'],
    continuum: { repositoryId: 'repo-econ' } as never,
    sessionContext: { call: (name, args) => executeSessionTool(store, { refresh: async () => ({}), readEvent: readEvent as any }, name, args, () => {}, target, [{ ...target, root, fingerprint: 'fp' }], undefined, root) }
  })

  const measureFlow = async (focal: boolean) => {
    let calls = 0, textTokens = 0, wireTokens = 0
    const call = async (name: SessionToolName, args: unknown) => {
      calls++
      const res = await adapter.callTool(name, args)
      expect(res.isError).toBeFalsy()
      textTokens += countCanonicalTokens((res.content[0] as { text: string }).text).tokenCount
      wireTokens += countCanonicalTokens(JSON.stringify(res)).tokenCount
      return JSON.parse((res.content[0] as { text: string }).text)
    }
    const list = await call('list_agent_sessions', focal ? { artifactId, view: 'FOCAL' } : { artifactId })
    if (!focal) expect(list.contextMap).toBeDefined()
    else expect(list.contextMap).toBeUndefined()

    const inspect = await call('inspect_agent_session', focal ? list.sessions[0].deepen.arguments : { sessionId: list.sessions[0].sessionId })
    let errEventId: string, revision: number
    if (focal) {
      expect(inspect.diagnostics).toBeUndefined()
      errEventId = inspect.errors[0].eventId
      revision = inspect.revision
    } else {
      expect(inspect.diagnostics).toBeDefined()
      const events = await call('list_agent_session_events', { sessionId: list.sessions[0].sessionId, types: ['ERROR'] })
      errEventId = events.events[0].eventId
      revision = events.revision
    }
    const read = await call('read_agent_session_event', { sessionId: list.sessions[0].sessionId, eventId: errEventId, expectedRevision: revision })
    expect(read.content).toBe(errText)
    return { calls, textTokens, wireTokens }
  }

  const legacy = await measureFlow(false)
  const focal = await measureFlow(true)
  expect(focal.calls).toBeLessThan(legacy.calls)
  expect(focal.textTokens).toBeLessThan(Math.floor(legacy.textTokens * 0.6))
  expect(focal.wireTokens).toBeLessThan(Math.floor(legacy.wireTokens * 0.65))
  expect(store.diagnostics().payloadBytes).toBe(0)
}, 30000)

it('U5 keeps large Codex sources bounded with omittedSourceEvents, zero SQLite payload storage, and flat MCP schemas', async () => {
  const { AjvJsonSchemaValidator } = await import('@modelcontextprotocol/sdk/validation/ajv')
  const ajv = new AjvJsonSchemaValidator()
  for (const name of ['list_agent_sessions', 'inspect_agent_session', 'list_agent_session_events', 'read_agent_session_event']) {
    const def = SESSION_CONTEXT_TOOLS.find(t => t.name === name)!
    const schema = def.inputSchema as { properties?: Record<string, object> }
    for (const prop of Object.values(schema.properties ?? {})) expect(prop).not.toHaveProperty('oneOf')
    expect(() => ajv.getValidator(def.inputSchema as any)).not.toThrow()
  }

  const base = mkdtempSync(join(tmpdir(), 'u5-large-'))
  cleanup.push(() => safeRemove(base))
  const root = join(base, 'repo')
  mkdirSync(join(root, '.git'), { recursive: true })
  const store = new SessionStore(sessionStorePath(base, 'repo-large'), 'repo-large')
  cleanup.push(() => store.close())
  const target = { worktreeId: 'a'.repeat(64), generation: 'b'.repeat(64) }
  const profile = join(base, 'codex-profile')
  const rolloutDir = join(profile, 'sessions', '2026', '11', '15')
  mkdirSync(rolloutDir, { recursive: true })
  const sessionUuid = '01a1e000-0000-7000-8000-000000000059'
  const accHash = nativeDigest(JSON.stringify(['u5-user', 'u5-acc']))
  writeFileSync(join(dirname(store.path), 'session-context.provider.json'), JSON.stringify({
    repositoryId: 'repo-large', nativeSources: { codex: { profile, creatorAccountHash: accHash } }
  }))
  const pad = 'x'.repeat(4000)
  const lines = [JSON.stringify({
    timestamp: '2026-11-15T10:00:00Z', type: 'session_meta',
    payload: { id: sessionUuid, session_id: sessionUuid, account_scoped: true, creator_user_id: 'u5-user', creator_account_id: 'u5-acc',
      cwd: root, runtime_workspace_roots: [root], cli_version: '0.169.0-alpha.11.1' }
  })]
  for (let i = 0; i < 600; i++) {
    lines.push(JSON.stringify({
      timestamp: '2026-11-15T10:00:01Z', type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `${i}:${pad}` }] }
    }))
  }
  writeFileSync(join(rolloutDir, `rollout-2026-11-15T10-00-00-${sessionUuid}.jsonl`), lines.join('\n') + '\n')

  const principal = authenticatedAgentPrincipal('MCP', () => true)
  const authority = authorizeArtifactAgent(principal, 'repo-large', () => true)
  const adapter = new ChannelMcpAdapter({
    projectId: 'repo-large', repoRoot: root, navigation: {} as McpProjectContext['navigation'],
    continuum: { repositoryId: 'repo-large' } as never,
    sessionContext: { call: (name, args) => executeSessionTool(store, {}, name, args, () => {}, target, [{ ...target, root, fingerprint: 'fp' }], undefined, root) }
  })
  const listed = JSON.parse((await adapter.callTool('list_agent_sessions', target, undefined, authority).then(r => r.content[0] as { text: string })).text)
  const inspected = JSON.parse((await adapter.callTool('inspect_agent_session', listed.sessions[0].deepen.arguments, undefined, authority).then(r => r.content[0] as { text: string })).text)
  expect(inspected.sourceEventCount).toBe(512)
  expect(inspected.omittedSourceEvents).toBe(88)
  expect(store.count()).toBe(0)
  expect(store.diagnostics().payloadBytes).toBe(0)
}, 30000)

it('U5 executes the end-to-end focal investigation through an authenticated HTTP MCP client and real worker boundary', async () => {
  const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
    import('@modelcontextprotocol/sdk/client'),
    import('@modelcontextprotocol/sdk/client/streamableHttp.js')
  ])
  const base = mkdtempSync(join(tmpdir(), 'u5-http-mcp-'))
  cleanup.push(() => safeRemove(base))
  const root = join(base, 'repo')
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git/HEAD'), 'ref: refs/heads/feat\n')
  const workerPath = join(base, 'worker.cjs')
  const repoCwd = process.cwd()
  const code = buildSync({ entryPoints: ['src/main/session-context/worker.ts'], bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false }).outputFiles[0].text
  writeFileSync(workerPath, `require = require('node:module').createRequire(${JSON.stringify(join(repoCwd, 'package.json'))});\n` + code)

  const target = { worktreeId: 'c'.repeat(64), generation: 'd'.repeat(64) }
  const profile = join(base, 'codex')
  const rolloutDir = join(profile, 'sessions', '2026', '11', '15')
  mkdirSync(rolloutDir, { recursive: true })
  const sessionUuid = '01a1e000-0000-7000-8000-000000000060'
  const accHash = nativeDigest(JSON.stringify(['http-user', 'http-acc']))
  const storePath = sessionStorePath(base, 'repo-http')
  const seeded = new SessionStore(storePath, 'repo-http')
  seeded.close()
  writeFileSync(join(dirname(storePath), 'session-context.provider.json'), JSON.stringify({
    repositoryId: 'repo-http', nativeSources: { codex: { profile, creatorAccountHash: accHash } }
  }))
  const expectedErr = 'HTTP_E2E_FAILURE'
  writeFileSync(join(rolloutDir, `rollout-2026-11-15T10-00-00-${sessionUuid}.jsonl`), [
    JSON.stringify({
      timestamp: '2026-11-15T10:00:00Z', type: 'session_meta',
      payload: { id: sessionUuid, session_id: sessionUuid, account_scoped: true, creator_user_id: 'http-user', creator_account_id: 'http-acc',
        cwd: root, runtime_workspace_roots: [root], cli_version: '0.169.0-alpha.11.1' }
    }),
    JSON.stringify({ timestamp: '2026-11-15T10:00:01Z', type: 'response_item', payload: { type: 'function_call', name: 'bash', call_id: 'c1', arguments: '{}' } }),
    JSON.stringify({ timestamp: '2026-11-15T10:00:02Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: JSON.stringify({ isError: true, code: expectedErr, error: expectedErr }) } })
  ].join('\n') + '\n')

  const fp = sourceFingerprint(root)
  const resolver = Object.assign(
    async () => ({ root, fingerprint: fp, validate: async () => {} }),
    { discover: async () => [{ ...target, root, fingerprint: fp }] }
  )
  const clientWorker = new SessionContextClient(base, 'repo-http', root, () => true, workerPath, resolver as any, 20000)
  cleanup.push(() => clientWorker.dispose())

  const principal = authenticatedAgentPrincipal('MCP', () => true)
  const authority = authorizeArtifactAgent(principal, 'repo-http', () => true)
  const adapter = new ChannelMcpAdapter({
    projectId: 'repo-http', repoRoot: root, navigation: {} as McpProjectContext['navigation'],
    continuum: { repositoryId: 'repo-http' } as never,
    sessionContext: { call: (name, args, allowArtifactMetadata) => clientWorker.call(name, args, allowArtifactMetadata) }
  })
  const token = 'bearer-u5-candidate-token'
  const server = createMcpHttpServer(adapter, () => {}, undefined, headers => headers.authorization === `Bearer ${token}`, () => authority)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())))
  const address = server.address() as { port: number }

  const mcpClient = new Client({ name: 'u5-http-acceptance', version: '1' })
  cleanup.push(() => mcpClient.close())
  await mcpClient.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  }))

  const listed = JSON.parse(((await mcpClient.callTool({ name: 'list_agent_sessions', arguments: target })).content as any)[0].text)
  expect(listed.sessions, JSON.stringify(listed)).toHaveLength(1)
  expect(listed.sessions[0].captureCoverage).toBe('SOURCE_AVAILABLE_NO_HOOK_CAPTURE')

  const inspected = JSON.parse(((await mcpClient.callTool({ name: 'inspect_agent_session', arguments: listed.sessions[0].deepen.arguments })).content as any)[0].text)
  expect(inspected.errors, JSON.stringify(inspected)).toHaveLength(1)

  const read = JSON.parse(((await mcpClient.callTool({
    name: 'read_agent_session_event',
    arguments: { ...listed.sessions[0].deepen.arguments, expectedRevision: inspected.revision, eventId: inspected.errors[0].eventId }
  })).content as any)[0].text)
  expect(read.content).toContain(expectedErr)

  const verifyStore = new SessionStore(storePath, 'repo-http', true)
  try {
    expect(verifyStore.count()).toBe(0)
    expect(verifyStore.diagnostics().payloadBytes).toBe(0)
  } finally { verifyStore.close() }
}, 30000)


it('C2 proves focal native discovery saves real disk I/O bytes vs unindexed scans without importing transcripts', async () => {
  const base = mkdtempSync(join(tmpdir(), 'c2-io-econ-'))
  cleanup.push(() => safeRemove(base))
  const root = join(base, 'repo')
  const other = join(base, 'other')
  mkdirSync(join(root, '.git'), { recursive: true })
  mkdirSync(other, { recursive: true })
  writeFileSync(join(root, '.git/HEAD'), 'ref: refs/heads/feat\n')
  const store = new SessionStore(sessionStorePath(base, 'repo-io'), 'repo-io')
  cleanup.push(() => store.close())

  const agProfile = join(base, 'ag')
  const codexProfile = join(base, 'codex')
  const codexDir = join(codexProfile, 'sessions', '2026', '11', '15')
  mkdirSync(codexDir, { recursive: true })
  const agMatch = '019ba000-0000-7000-8000-000000000301'
  const codexMatch = '01a1e000-0000-7000-8000-000000000301'
  const accHash = nativeDigest(JSON.stringify(['io-user', 'io-acc']))

  const agMatchPath = antigravityAppTranscriptPath(agProfile, agMatch)
  mkdirSync(dirname(agMatchPath), { recursive: true })
  writeFileSync(agMatchPath, [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-15T10:00:00Z', content: 'Run tests' },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-15T10:00:05Z', content: 'Completed' }
  ].map(r => JSON.stringify(r)).join('\n') + '\n')

  const agDb = new Database(join(agProfile, 'conversation_summaries.db'))
  agDb.exec('CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, workspace_uris TEXT, last_modified_time TEXT)')
  const insAg = agDb.prepare('INSERT INTO conversation_summaries (conversation_id, workspace_uris, last_modified_time) VALUES (?, ?, ?)')
  insAg.run(agMatch, JSON.stringify([pathToFileURL(root).href]), '2026-11-15 10:00:05+00:00')
  for (let i = 0; i < 20; i++) {
    const id = `019ba000-0000-7000-8000-${String(310 + i).padStart(12, '0')}`
    insAg.run(id, JSON.stringify([pathToFileURL(other).href]), '2026-11-15 10:00:06+00:00')
    const p = antigravityAppTranscriptPath(agProfile, id)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify({ step_index: 0, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-11-15T10:00:06Z', content: 'p'.repeat(32_768) }) + '\n')
  }
  agDb.close()

  const codexMatchPath = join(codexDir, `rollout-2026-11-15T10-00-00-${codexMatch}.jsonl`)
  writeFileSync(codexMatchPath, [
    JSON.stringify({ type: 'session_meta', payload: { id: codexMatch, session_id: codexMatch, account_scoped: true, creator_user_id: 'io-user', creator_account_id: 'io-acc', cwd: root, runtime_workspace_roots: [root], cli_version: '0.169.0-alpha.11.1' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'IO_OK' }] } })
  ].join('\n') + '\n')
  for (let i = 0; i < 20; i++) {
    const id = `01a1e000-0000-7000-8000-${String(310 + i).padStart(12, '0')}`
    writeFileSync(join(codexDir, `rollout-2026-11-15T10-05-${String(i).padStart(2, '0')}-${id}.jsonl`),
      JSON.stringify({ type: 'session_meta', payload: { id, session_id: id, account_scoped: true, creator_user_id: 'io-user', creator_account_id: 'io-acc', cwd: other, runtime_workspace_roots: [other], cli_version: '0.169.0-alpha.11.1', pad: 'p'.repeat(12_000) } }) + '\n')
  }

  writeFileSync(join(dirname(store.path), 'session-context.provider.json'), JSON.stringify({
    repositoryId: 'repo-io',
    nativeSources: { codex: { profile: codexProfile, creatorAccountHash: accHash }, antigravityApp: { profile: agProfile } }
  }))

  const agDiscovery = discoverAntigravityAppSources({ storePath: store.path, repositoryId: 'repo-io', worktreeRoot: root, assertCurrent: () => {} })
  expect(agDiscovery.sessions).toHaveLength(1)
  expect(agDiscovery.stats.transcriptFilesOpened).toBe(0)
  expect(agDiscovery.stats.transcriptBytesRead).toBe(0)

  const codexNoIdx = discoverCodexSources({ storePath: store.path, repositoryId: 'repo-io', worktreeRoot: root, assertCurrent: () => {} })
  const codexDb = new Database(join(codexProfile, 'state_5.sqlite'))
  codexDb.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, updated_at INTEGER)')
  const insCodex = codexDb.prepare('INSERT INTO threads (id, rollout_path, cwd, updated_at) VALUES (?, ?, ?, ?)')
  insCodex.run(codexMatch, codexMatchPath, `\\\\?\\${root}`, 3000)
  for (let i = 0; i < 20; i++) {
    const id = `01a1e000-0000-7000-8000-${String(310 + i).padStart(12, '0')}`
    insCodex.run(id, join(codexDir, `rollout-2026-11-15T10-05-${String(i).padStart(2, '0')}-${id}.jsonl`), other, 2000 - i)
  }
  codexDb.close()

  const codexWithIdx = discoverCodexSources({ storePath: store.path, repositoryId: 'repo-io', worktreeRoot: root, assertCurrent: () => {} })
  expect(codexWithIdx.sessions).toHaveLength(1)
  expect(codexWithIdx.stats.filesOpened).toBe(1)
  expect(codexWithIdx.stats.headerBytesRead).toBeLessThan(Math.floor(codexNoIdx.stats.headerBytesRead / 10))
  expect(store.count()).toBe(0)
}, 30000)
