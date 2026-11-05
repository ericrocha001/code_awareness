import { afterEach, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildSync } from 'esbuild'
import { fixture, markdown, withFixtureDatabase } from '../continuum/continuum-test-fixtures'
import { executeGetArtifact } from '../continuum/continuum-mcp'
import { SessionStore, sessionStorePath } from './store'
import { sourceFingerprint, type SessionTargetResolver } from './target'
import { SessionContextClient } from './client'
import { nativeDigest, nativeGitIdentity, normalizeNativeHook, prepareNativeSpool, recordNativeGap, spoolNativeHook, type NativeHookBinding, type NativeHookEnvelope } from './native-hooks'
import { nativeObservationBatch } from './native-hook-ingestion'
import { correlateNativeArtifact } from './native-artifact-correlation'
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
  const path = sessionStorePath(f.dir, 'catalog-A')
  let sessions = new SessionStore(path, 'catalog-A')
  closes.push(() => sessions.close())
  const port: PublicationProvenancePort = {
    readReceipt: async id => f.service.readPublicationReceipt(id),
    associate: async value => f.service.associatePublication(value),
    invalidate: async (id, state) => { f.service.invalidatePublication(id, state) }
  }
  const events = (receipt: ArtifactReceipt, input = { rawMarkdown: markdown() }, call = 'call-1', changes: Record<string, unknown> = {}) => {
    const payload = { session_id: 'session-1', cwd: f.dir, tool_use_id: call, turn_id: 'turn-1', tool_name: 'mcp__code_awareness_local__publish_artifact', tool_input: input, ...changes }
    return [
      normalizeNativeHook({ ...payload, hook_event_name: 'PreToolUse' }, binding),
      normalizeNativeHook({ ...payload, hook_event_name: 'PostToolUse', tool_response: { content: [{ type: 'text', text: JSON.stringify(receipt) }] } }, binding)
    ] as const
  }
  const observe = (event: NativeHookEnvelope) => {
    const batch = nativeObservationBatch(event)
    if (!sessions.registry.source(batch.source)) sessions.registry.apply(batch, undefined)
  }
  const correlate = (event: NativeHookEnvelope, selectedPort = port) => correlateNativeArtifact(sessions.registry, binding, event.invocationId!, selectedPort, () => {})
  return { ...f, path, binding, port, sessions: () => sessions, events, observe, correlate, restart: () => { sessions.close(); sessions = new SessionStore(path, 'catalog-A') } }
}
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
    const pending = await client.call('discover_execution_context', { selector: { type: 'ARTIFACT', id: receipt.artifactId, revision: 1 } })
    expect(pending.isError).toBeFalsy()
    expect(f.service.get(receipt.artifactId)!.provenance.nativeArtifact).toBeUndefined()
    available = true
    const result = await client.call('discover_execution_context', { selector: { type: 'ARTIFACT', id: receipt.artifactId, revision: 1 }, mode: 'RELATION_DETAIL' })
    expect(result.isError).toBeFalsy()
    const graph = JSON.parse((result.content[0] as { text: string }).text)
    expect(graph.nodes.some((node: { revision?: number }) => node.revision === 1)).toBe(true)
    expect(graph.edges.some((edge: { evidenceKind: string; state: string }) => edge.evidenceKind === 'NATIVE_ARTIFACT_CAUSAL' && edge.state === 'VERIFIED')).toBe(true)
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
