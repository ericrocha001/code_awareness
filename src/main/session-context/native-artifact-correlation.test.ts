import { afterEach, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildSync } from 'esbuild'
import Database from 'better-sqlite3'
import { fixture, markdown, withFixtureDatabase } from '../continuum/continuum-test-fixtures'
import { executeGetArtifact } from '../continuum/continuum-mcp'
import { SessionStore, sessionStorePath } from './store'
import { sourceFingerprint, type SessionTargetResolver } from './target'
import { SessionContextClient } from './client'
import { executeSessionTool } from './mcp'
import { nativeDigest, nativeGitIdentity, normalizeNativeHook, prepareNativeSpool, recordNativeGap, spoolNativeHook, type NativeHookBinding, type NativeHookEnvelope } from './native-hooks'
import { nativeObservationBatch } from './native-hook-ingestion'
import { correlateNativeArtifact } from './native-artifact-correlation'
import { stampNativeCapture } from './native-capture-window'
import { nativeCorrelationSourceCoverage, persistNativeCapture, readNativeGapHistory } from './native-hook-diagnostics'
import type { PublicationProvenancePort } from '../../shared/types/publication-provenance-types'
import type { ArtifactReceipt } from '../continuum/continuum-types'
const closes: (() => void)[] = []
afterEach(() => { closes.reverse().forEach(close => close()); closes.length = 0 })
function setup() {
  const f = fixture()
  closes.push(f.close)
  mkdirSync(join(f.dir, '.git')); writeFileSync(join(f.dir, '.git/HEAD'), 'ref: refs/heads/fixture\n')
  const directory = join(f.dir, '.code-awareness/native-hooks'), spool = join(directory, 'spool')
  prepareNativeSpool(spool)
  const binding: NativeHookBinding = { schema: 1, enabled: true, repositoryId: 'catalog-A', worktreeId: '1'.repeat(64), generation: '2'.repeat(64), ...nativeGitIdentity(f.dir), spool }
  writeFileSync(join(directory, 'binding.json'), JSON.stringify(binding))
  mkdirSync(join(f.dir, '.codex')); writeFileSync(join(f.dir, '.codex/hooks.json'), '{}')
  const path = sessionStorePath(f.dir, 'catalog-A')
  let sessions = new SessionStore(path, 'catalog-A')
  closes.push(() => sessions.close())
  const port: PublicationProvenancePort = {
    readReceipt: async id => f.service.readPublicationReceipt(id),
    associate: async value => f.service.associatePublication(value),
    invalidate: async (id, state) => { f.service.invalidatePublication(id, state) }
  }
  const start = () => {
    const event = stampNativeCapture(normalizeNativeHook({ session_id: 'session-1', cwd: f.dir, hook_event_name: 'SessionStart' }, binding), binding)
    const batch = nativeObservationBatch(event)
    sessions.registry.apply(batch, sessions.registry.source(batch.source)?.revision)
    return event
  }
  start()
  const events = (receipt: ArtifactReceipt, input = { rawMarkdown: markdown() }, call = 'call-1', changes: Record<string, unknown> = {}, captured = true) => {
    const payload = { session_id: 'session-1', cwd: f.dir, tool_use_id: call, turn_id: 'turn-1', tool_name: 'mcp__code_awareness_local__publish_artifact', tool_input: input, ...changes }
    const normalize = (value: unknown) => { const event = normalizeNativeHook(value, binding); return captured ? stampNativeCapture(event, binding) : event }
    return [
      normalize({ ...payload, hook_event_name: 'PreToolUse' }),
      normalize({ ...payload, hook_event_name: 'PostToolUse', tool_response: { content: [{ type: 'text', text: JSON.stringify(receipt) }] } })
    ] as const
  }
  const observe = (event: NativeHookEnvelope) => {
    const batch = nativeObservationBatch(event)
    if (!sessions.registry.source(batch.source)) sessions.registry.apply(batch, undefined)
  }
  const correlate = (event: NativeHookEnvelope, selectedPort = port) => correlateNativeArtifact(sessions.registry, binding, event.invocationId!, selectedPort, () => {})
  return { ...f, path, binding, port, start, sessions: () => sessions, events, observe, correlate, restart: () => { sessions.close(); sessions = new SessionStore(path, 'catalog-A') } }
}
it('bounds a new invocation by a persisted start after legacy loss without acknowledging or repairing history', async () => {
  const f = setup()
  writeFileSync(join(f.binding.spool, 'gap.json'), JSON.stringify({ schema: 1, observedAt: '2020-01-01T00:00:00.000Z' }))
  const history = readNativeGapHistory(f.binding.spool)
  f.start()
  const receipt = f.service.publish(markdown()), pair = f.events(receipt)
  pair.forEach(f.observe)
  f.restart()
  expect(await f.correlate(pair[1])).toBe('VERIFIED')
  pair.forEach(f.observe)
  expect(await f.correlate(pair[1])).toBe('VERIFIED')
  expect(readNativeGapHistory(f.binding.spool)).toEqual(history)
  expect(f.sessions().registry.nativeCaptureWindows(f.binding.worktreeId, f.binding.generation).find(window => window.epoch === pair[0].capture!.epoch)).toMatchObject({
    accepted: 3, pairs: 1, incompletePairs: 0, correlations: { verified: 1, partial: 0, ambiguous: 0, pending: 0 }, denominator: null, coverage: 'COVERAGE_UNKNOWN'
  })
  expect(persistNativeCapture(f.sessions().registry, f.binding, { ingested: 0, rejected: 0, expired: 0, pending: false }, () => {}).historicalCoverage).toMatchObject({ state: 'PARTIAL', acknowledgedCount: 0 })
  const db = new Database(f.path, { readonly: true })
  try {
    expect(db.pragma('foreign_key_check')).toEqual([])
    expect(db.prepare('SELECT id FROM registry_edges GROUP BY id HAVING count(*)>1').all()).toEqual([])
    expect(db.prepare("SELECT count(*) AS count FROM registry_edges WHERE source=? AND state='OBSERVED'").get('NATIVE_ARTIFACT:' + pair[0].invocationId)).toEqual({ count: 3 })
  } finally { db.close() }
})
it('refuses missing boundaries, generation/configuration drift, unordered loss and loss during readback', async () => {
  for (const mode of ['boundary', 'orphan', 'generation', 'configuration', 'unordered', 'readback', 'associate']) {
    const f = setup(), receipt = f.service.publish(markdown())
    if (mode === 'orphan') stampNativeCapture(normalizeNativeHook({ session_id: 'session-1', cwd: f.dir, hook_event_name: 'SessionStart' }, f.binding), f.binding)
    const pair = f.events(receipt, undefined, 'call-1', {}, mode !== 'boundary')
    pair.forEach(f.observe)
    if (mode === 'generation') writeFileSync(join(f.binding.root, '.code-awareness/native-hooks/binding.json'), JSON.stringify({ ...f.binding, generation: '9'.repeat(64) }))
    if (mode === 'configuration') writeFileSync(join(f.binding.root, '.codex/hooks.json'), '{"changed":true}')
    if (mode === 'unordered') writeFileSync(join(f.binding.spool, 'gap-0.json'), '{')
    const port = mode === 'readback' ? { ...f.port, readReceipt: async (id: string) => { recordNativeGap(f.binding.spool, 'SPOOL_FULL'); return f.port.readReceipt(id) } }
      : mode === 'associate' ? { ...f.port, associate: async (value: Parameters<PublicationProvenancePort['associate']>[0]) => { const result = await f.port.associate(value); recordNativeGap(f.binding.spool, 'SPOOL_FULL'); return result } } : f.port
    expect(await f.correlate(pair[1], port)).not.toBe('VERIFIED')
    if (mode === 'associate') expect(f.service.get(receipt.artifactId)!.provenance.nativeArtifact).toMatchObject({ state: 'PARTIAL' })
    else expect(f.service.get(receipt.artifactId)!.provenance.nativeArtifact).toBeUndefined()
    expect(f.sessions().registry.contextGraph({ kind: 'ARTIFACT', id: receipt.artifactId + ':1' }).edges.some(edge => edge.evidenceKind === 'NATIVE_ARTIFACT_CAUSAL' && edge.state === 'VERIFIED')).toBe(false)
  }
})
it('requires a new boundary after session end and does not promote the incomplete earlier invocation', async () => {
  const f = setup(), receipt = f.service.publish(markdown()), pair = f.events(receipt)
  f.observe(pair[0])
  const ended = stampNativeCapture(normalizeNativeHook({ session_id: 'session-1', cwd: f.dir, hook_event_name: 'SessionEnd' }, f.binding), f.binding)
  f.observe(ended)
  const afterEnd = f.events(receipt)[1]
  f.observe(afterEnd)
  expect(await f.correlate(afterEnd)).not.toBe('VERIFIED')
  f.start()
  const next = f.events(receipt, undefined, 'new-call')
  next.forEach(f.observe)
  expect(await f.correlate(next[1])).toBe('VERIFIED')
  expect(await f.correlate(pair[0])).not.toBe('VERIFIED')
})
it('requires both observations and canonical readback; keeps the exact chain, content and historical revision after restart', async () => {
  const f = setup(), receipt = f.service.publish(markdown()), original = f.service.get(receipt.artifactId)!
  const [pre, post] = f.events(receipt)
  f.observe(post)
  expect(await f.correlate(post)).toBe('INVOCATION_INCOMPLETE')
  f.observe(pre)
  expect(await f.correlate(pre)).toBe('VERIFIED')
  const projection = f.service.get(receipt.artifactId)!.provenance.nativeArtifact
  expect(projection).toMatchObject({ state: 'VERIFIED', revision: 1, sessionId: pre.sessionId, invocationId: pre.invocationId })
  expect(JSON.parse(executeGetArtifact(f.service, { artifactId: receipt.artifactId }).content[0].text).provenance.nativeArtifact).toEqual(projection)
  f.observe(pre); f.observe(post); f.restart()
  expect(await f.correlate(post)).toBe('VERIFIED')
  const graph = f.sessions().registry.contextGraph({ kind: 'ARTIFACT', id: receipt.artifactId + ':1' })
  expect(graph.nodes.find(n => n.type === 'ARTIFACT' && n.revision === 1)?.id).toBe(receipt.artifactId)
  expect(graph.edges.filter(e => e.evidenceKind === 'NATIVE_ARTIFACT_CAUSAL' && e.state === 'VERIFIED')).toHaveLength(3)
  expect(f.service.get(receipt.artifactId)!.rawMarkdown).toBe(original.rawMarkdown)
  expect(f.service.get(receipt.artifactId)!.contentHash).toBe(original.contentHash)
  withFixtureDatabase(join(f.dir, 'continuum.db'), db => {
    const snapshot = JSON.parse((db.prepare('SELECT snapshot_json FROM artifact_revisions WHERE artifact_id=? AND revision=1').get(receipt.artifactId) as { snapshot_json: string }).snapshot_json)
    expect(snapshot.provenance.nativeArtifact).toBeUndefined()
  })
  f.service.update(receipt.artifactId, 1, 'New body literal.')
  expect(f.service.get(receipt.artifactId)!.provenance.nativeArtifact).toBeUndefined()
  expect(f.sessions().registry.contextGraph({ kind: 'ARTIFACT', id: receipt.artifactId + ':1' }).edges.some(e => e.state === 'VERIFIED')).toBe(true)
})
it('rejects replay, missing results, cross-repository readback, subagent disagreement and partial capture', async () => {
  for (const mode of ['replay','missing','cross-repo','agent','gap','receipt']) {
    const f = setup(), receipt = f.service.publish(markdown())
    const [pre, normalPost] = f.events(mode === 'replay' ? { ...receipt, replayed: true } : mode === 'missing' ? { ...receipt, success: undefined } as never : receipt)
    const post = mode === 'agent' ? f.events(receipt, undefined, 'call-1', { agent_id: 'other-agent' })[1] : normalPost
    f.observe(pre); f.observe(post)
    if (mode === 'gap') recordNativeGap(f.binding.spool, 'SPOOL_FULL', 'WRITE', 'PostToolUse')
    const port = mode === 'cross-repo' ? { ...f.port, readReceipt: async () => ({ ...receipt.publicationReceipt!, repositoryId: 'other' }) }
      : mode === 'receipt' ? { ...f.port, readReceipt: async () => ({ ...receipt.publicationReceipt!, revision: 2 }) } : f.port
    expect(await f.correlate(post, port)).not.toBe('VERIFIED')
    expect(f.sessions().registry.contextGraph({ kind: 'EXECUTION', id: 'native-invocation:' + pre.invocationId }).edges.some(e => e.evidenceKind === 'NATIVE_ARTIFACT_CAUSAL' && e.state === 'VERIFIED')).toBe(false)
    expect(f.service.get(receipt.artifactId)!.provenance.nativeArtifact).toBeUndefined()
  }
})
it('invalidates both associations when two invocations claim one receipt', async () => {
  const f = setup(), receipt = f.service.publish(markdown())
  const first = f.events(receipt), second = f.events(receipt, undefined, 'call-2')
  first.forEach(f.observe)
  expect(await f.correlate(first[1])).toBe('VERIFIED')
  second.forEach(f.observe)
  expect(await f.correlate(second[1])).toBe('RECEIPT_AMBIGUOUS')
  expect(f.service.get(receipt.artifactId)!.provenance.nativeArtifact).toMatchObject({ state: 'AMBIGUOUS' })
  expect(f.sessions().registry.contextGraph({ kind: 'ARTIFACT', id: receipt.artifactId }).edges.filter(e => e.evidenceKind === 'NATIVE_ARTIFACT_CAUSAL').every(e => e.state !== 'VERIFIED')).toBe(true)
})
it('retries persisted native evidence incrementally through worker ports when canonical readback arrives later', async () => {
  const f = setup(), receipt = f.service.publish(markdown()), pair = f.events(receipt)
  pair.forEach(event => spoolNativeHook(event, f.binding.spool))
  const workerPath = join(f.dir, 'worker.cjs')
  const code = buildSync({ entryPoints: ['src/main/session-context/worker.ts'], bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false }).outputFiles[0].text
  writeFileSync(workerPath, `require = require('node:module').createRequire(${JSON.stringify(join(process.cwd(), 'package.json'))});\n` + code)
  const selection = { worktreeId: f.binding.worktreeId, generation: f.binding.generation }
  const resolve: SessionTargetResolver = async target => {
    if (target.worktreeId !== selection.worktreeId || target.generation !== selection.generation) throw new Error('WORKTREE_STALE')
    return { root: f.dir, fingerprint: sourceFingerprint(f.dir), validate: async () => {} }
  }
  resolve.discover = async () => [{ ...selection, root: f.dir, fingerprint: sourceFingerprint(f.dir) }]
  let available = false
  const delayed = { ...f.port, readReceipt: async (id: string) => available ? f.port.readReceipt(id) : null }
  const client = new SessionContextClient(f.dir, 'catalog-A', f.dir, () => true, workerPath, resolve, 20000, undefined, undefined, delayed)
  try {
    expect((await client.call('reconcile_checkpoint_registry', {})).isError).toBeFalsy()
    const pending = await client.call('discover_execution_context', { selector: { type: 'ARTIFACT', id: receipt.artifactId, revision: 1 } })
    expect(pending.isError).toBeFalsy()
    expect(f.service.get(receipt.artifactId)!.provenance.nativeArtifact).toBeUndefined()
    available = true
    expect((await client.call('reconcile_checkpoint_registry', {})).isError).toBeFalsy()
    const result = await client.call('discover_execution_context', { selector: { type: 'ARTIFACT', id: receipt.artifactId, revision: 1 }, mode: 'RELATION_DETAIL' })
    expect(result.isError).toBeFalsy()
    const graph = JSON.parse((result.content[0] as { text: string }).text)
    expect(graph.nodes.some((node: { revision?: number }) => node.revision === 1)).toBe(true)
    expect(graph.edges.some((edge: { evidenceKind: string; state: string }) => edge.evidenceKind === 'NATIVE_ARTIFACT_CAUSAL' && edge.state === 'VERIFIED'),
      JSON.stringify(f.sessions().registry.source('NATIVE_ARTIFACT:' + pair[0].invocationId))).toBe(true)
    expect(f.service.get(receipt.artifactId)!.provenance.nativeArtifact).toMatchObject({ state: 'VERIFIED' })
  } finally { await client.dispose() }
}, 30000)
it('does not write a causal association after cancellation while readback is in flight', async () => {
  const f = setup(), receipt = f.service.publish(markdown()), pair = f.events(receipt)
  pair.forEach(f.observe)
  let active = true, release!: () => void, entered!: () => void, associated = false
  const started = new Promise<void>(resolve => { entered = resolve })
  const barrier = new Promise<void>(resolve => { release = resolve })
  const port = { ...f.port, readReceipt: async (id: string) => { entered(); await barrier; return f.port.readReceipt(id) },
    associate: async (value: Parameters<PublicationProvenancePort['associate']>[0]) => { associated = true; return f.port.associate(value) } }
  const result = correlateNativeArtifact(f.sessions().registry, f.binding, pair[0].invocationId!, port, () => { if (!active) throw new Error('PROJECT_CONTEXT_CHANGED') })
  await started; active = false; release()
  await expect(result).rejects.toThrow('PROJECT_CONTEXT_CHANGED')
  expect(associated).toBe(false)
  expect(f.service.get(receipt.artifactId)!.provenance.nativeArtifact).toBeUndefined()
})

it('U3 rejects temporal inversion and tampered envelope readback on complete late pairs', async () => {
  for (const mode of ['order', 'readback']) {
    const f = setup(), receipt = f.service.publish(markdown()), pair = f.events(receipt)
    const event = (value: NativeHookEnvelope, observedAt: string) => { const { digest: _digest, ...body } = value; const changed = { ...body, observedAt }; return { ...changed, digest: nativeDigest(JSON.stringify(changed)) } }
    const pre = mode === 'order' ? event(pair[0], '2026-11-02T00:00:01.000Z') : pair[0]
    const post = mode === 'order' ? event(pair[1], '2026-11-02T00:00:00.000Z') : pair[1]
    f.observe(pre); expect(await f.correlate(pre)).toBe('INVOCATION_INCOMPLETE'); f.observe(post)
    if (mode === 'readback') {
      const db = new Database(f.path)
      try { db.prepare('UPDATE registry_sources SET cursor=? WHERE source=?').run('{}', 'NATIVE_HOOK:' + pre.eventId) } finally { db.close() }
    }
    const reason = mode === 'order' ? 'INVOCATION_ORDER_INVALID' : 'CAPTURE_ENVELOPE_UNPROVEN'
    expect(await f.correlate(post)).toBe(reason); f.restart(); expect(await f.correlate(post)).toBe(reason)
    expect(f.service.get(receipt.artifactId)!.provenance.nativeArtifact).toBeUndefined()
  }
})

it('U3 projects allowlisted source reasons for visible invocations only and retains them after restart', async () => {
  const f = setup(), receipt = f.service.publish(markdown()), [pre, post] = f.events(receipt)
  f.observe(pre); expect(await f.correlate(pre)).toBe('INVOCATION_INCOMPLETE')
  const invocation = pre.invocationId!, source = 'NATIVE_ARTIFACT:' + invocation
  const coverage = (ids: string[]) => nativeCorrelationSourceCoverage(f.sessions().registry, ids)
  const query = async (selector: object) => {
    const result = await executeSessionTool(f.sessions(), { refresh: async () => { throw new Error('UNEXPECTED_REFRESH') } }, 'discover_execution_context', { selector, mode: 'RELATION_DETAIL', depth: 1 }, () => {})
    expect(result.isError).toBeFalsy(); return JSON.parse(result.content[0].text)
  }
  const selector = { type: 'INVOCATION', id: invocation }
  const partial = await query(selector)
  expect(partial.sourceCoverage).toContainEqual(expect.objectContaining({ source, status: 'CONFLICT', reasonCode: 'INVOCATION_INCOMPLETE' }))
  expect(partial.reconciliation.backlog).toMatchObject({ pending: true, details: expect.arrayContaining([expect.objectContaining({ source, pending: true })]) })
  expect((await query({ type: 'INVOCATION', id: '0'.repeat(64) })).sourceCoverage.some((value: { source: string }) => value.source === source)).toBe(false)
  expect(coverage([])).toEqual([])
  expect(coverage([invocation, invocation, 'private-path'])).toEqual([expect.objectContaining({ source, status: 'CONFLICT', reasonCode: 'INVOCATION_INCOMPLETE', pending: true })])
  f.restart(); expect(coverage([invocation])[0].reasonCode).toBe('INVOCATION_INCOMPLETE')
  const unknownId = 'f'.repeat(64)
  f.sessions().registry.apply({ repositoryId: f.binding.repositoryId, source: 'NATIVE_GIT:' + unknownId, revision: nativeDigest('unknown'), status: 'CONFLICT', cursor: 'PRIVATE_PAYLOAD', edges: [] }, undefined)
  expect(coverage([invocation])).toHaveLength(1)
  expect(coverage([unknownId])[0]).toMatchObject({ reasonCode: 'NATIVE_CONFLICT_UNCLASSIFIED', pending: false })
  expect(JSON.stringify(coverage([unknownId]))).not.toContain('PRIVATE_PAYLOAD')
  f.observe(post); expect(await f.correlate(post)).toBe('VERIFIED')
  expect(coverage([invocation])[0]).toMatchObject({ source, status: 'COMPLETE', pending: false })
  expect(coverage([invocation])[0].reasonCode).toBeUndefined()
  f.restart()
  const artifact = { type: 'ARTIFACT', id: receipt.artifactId, revision: 1 }
  for (const key of [selector, artifact]) expect((await query(key)).edges).toContainEqual(expect.objectContaining({ evidenceKind: 'NATIVE_ARTIFACT_CAUSAL', confidenceClass: 'VERIFIED_CAUSAL', relation: 'published' }))
  const window = () => f.sessions().registry.nativeCaptureWindows(f.binding.worktreeId, f.binding.generation).find(item => item.epoch === pre.capture!.epoch)
  expect(window()).toMatchObject({ causalEdges: { current: 3, withdrawn: 0 }, denominator: null })
  recordNativeGap(f.binding.spool, 'SPOOL_FULL')
  expect(await f.correlate(post)).toBe('CAPTURE_PARTIAL')
  f.restart()
  expect(window()).toMatchObject({ causalEdges: { current: 0, withdrawn: 3 }, denominator: null })
  expect((await query(selector)).sourceCoverage).toContainEqual(expect.objectContaining({ source, status: 'CONFLICT', reasonCode: 'CAPTURE_PARTIAL' }))
  expect((await query(artifact)).edges.filter((edge: { confidenceClass: string }) => edge.confidenceClass === 'VERIFIED_CAUSAL')).toEqual([])
})
