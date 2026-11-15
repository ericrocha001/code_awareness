import { randomUUID } from 'node:crypto'
import { closeSync, lstatSync, openSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { CheckpointRegistry, RegistryEntity } from './checkpoint-registry'
import { boundedFile, nativeDigest, nativeSessionEntityId, parseNativeEnvelope, readNativeBinding, type NativeHookBinding, type NativeHookEnvelope } from './native-hooks'
import { readNativeGapHistory } from './native-hook-diagnostics'

export function nativeCaptureConfiguration(binding: NativeHookBinding): string | undefined {
  try {
    const provider = binding.provider ?? 'codex'
    const bindingPath = join(binding.root, provider === 'antigravity' ? '.code-awareness/native-hooks/antigravity/binding.json' : '.code-awareness/native-hooks/binding.json')
    const configPath = join(binding.root, provider === 'antigravity' ? '.agents/hooks.json' : '.codex/hooks.json')
    const revision = (path: string) => {
      const stat = lstatSync(path, { bigint: true })
      return [stat.dev, stat.ino, stat.birthtimeNs, stat.mtimeNs, stat.ctimeNs].map(String).join(':')
    }
    const before = [revision(bindingPath), revision(configPath)]
    const current = readNativeBinding(bindingPath)
    if (JSON.stringify(current) !== JSON.stringify(binding)) return undefined
    const config = boundedFile(configPath, 65536)
    if (before[0] !== revision(bindingPath) || before[1] !== revision(configPath)) return undefined
    return nativeDigest(JSON.stringify([1, binding, config, before]))
  } catch { return undefined }
}

export function stampNativeCapture(event: NativeHookEnvelope, binding: NativeHookBinding): NativeHookEnvelope {
  const configuration = nativeCaptureConfiguration(binding)
  if (!configuration || !binding.enabled || event.repositoryId !== binding.repositoryId || event.worktreeId !== binding.worktreeId || event.generation !== binding.generation) return event
  try {
    if (lstatSync(binding.spool).isSymbolicLink() || realpathSync(binding.spool) !== resolve(binding.spool)) return event
    const history = readNativeGapHistory(binding.spool)
    if (history.overflow || history.entries.some(entry => entry.observedAt === null || entry.reasonCode === 'DIAGNOSTIC_INVALID')) return event
    const path = join(binding.spool, `window-${event.sessionId}.json`)
    if (event.event === 'SessionStart') {
      const lock = path + '.pending'
      if (readdirSync(binding.spool).filter(name => /^window-[a-f0-9]{64}\.json$/.test(name)).length >= 64) return event
      const descriptor = openSync(lock, 'wx', 0o600)
      try {
        writeFileSync(descriptor, JSON.stringify({ epoch: nativeDigest(randomUUID()), configuration, gapRevision: history.revision }), { flush: true })
      } finally { closeSync(descriptor) }
      try {
        if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) return event
        renameSync(lock, path)
      } finally {
        try { unlinkSync(lock) } catch {}
      }
    }
    const capture = JSON.parse(boundedFile(path, 512)) as NativeHookEnvelope['capture']
    if (capture?.configuration !== configuration || capture.gapRevision !== history.revision) return event
    const { digest: _digest, eventId: _eventId, observedAt, ...facts } = event
    const body = { ...facts, capture }
    const eventId = nativeDigest(JSON.stringify(body))
    const stamped = { ...body, observedAt, eventId, digest: nativeDigest(JSON.stringify({ ...body, observedAt, eventId })) }
    const parsed = parseNativeEnvelope(JSON.stringify(stamped))
    if (event.event === 'SessionEnd') unlinkSync(path)
    return parsed
  } catch { return event }
}

export function nativeInvocationWindow(registry: CheckpointRegistry, binding: NativeHookBinding, invocation: RegistryEntity, session: RegistryEntity): string {
  const edges = registry.directEvidence(invocation, 'NATIVE_CAPTURE_WINDOW')
  if (edges.length !== 2 || edges[0].evidenceRef !== edges[1].evidenceRef || !['PreToolUse', 'PostToolUse'].every(relation => edges.some(edge => edge.relation === relation))) return 'CAPTURE_WINDOW_UNPROVEN'
  const capture = JSON.parse(edges[0].evidenceRef) as NonNullable<NativeHookEnvelope['capture']>
  try {
    const observations = registry.directEvidence(invocation, 'NATIVE_HOOK_OBSERVED').filter(edge => edge.relation === 'invocation')
    if (observations.length !== 2) return 'CAPTURE_ENVELOPE_UNPROVEN'
    const events = observations.map(edge => {
      const source = registry.source('NATIVE_HOOK:' + edge.evidenceRef)
      const event = parseNativeEnvelope(source?.cursor ?? '')
      if (source?.revision !== event.digest || edge.digest !== event.digest || event.eventId !== edge.evidenceRef || event.repositoryId !== binding.repositoryId ||
        event.worktreeId !== binding.worktreeId || event.generation !== binding.generation || 'native-invocation:' + event.invocationId !== invocation.id ||
        nativeSessionEntityId(event, event.sessionId) !== session.id || JSON.stringify(event.capture) !== JSON.stringify(capture)) throw new Error('CAPTURE_ENVELOPE_UNPROVEN')
      return event
    })
    const pre = events.find(event => event.event === 'PreToolUse'), post = events.find(event => event.event === 'PostToolUse')
    if (!pre || !post) return 'CAPTURE_ENVELOPE_UNPROVEN'
    if (Date.parse(pre.observedAt) > Date.parse(post.observedAt)) return 'INVOCATION_ORDER_INVALID'
  } catch { return 'CAPTURE_ENVELOPE_UNPROVEN' }
  if (capture.configuration !== nativeCaptureConfiguration(binding)) return 'CAPTURE_CONFIGURATION_CHANGED'
  const boundary = registry.directEvidence({ kind: 'EXECUTION', id: 'native-window:' + capture.epoch }, 'NATIVE_CAPTURE_BOUNDARY')
  if (boundary.length !== 2 || !boundary.some(edge => edge.to.kind === 'SESSION' && edge.to.id === session.id) ||
    !boundary.some(edge => edge.to.kind === 'WORKTREE' && edge.to.id === binding.worktreeId + ':' + binding.generation) ||
    boundary.some(edge => edge.evidenceRef !== edges[0].evidenceRef)) return 'CAPTURE_WINDOW_UNPROVEN'
  const history = readNativeGapHistory(binding.spool)
  return history.overflow || history.revision !== capture.gapRevision || history.entries.some(entry => entry.observedAt === null) ? 'CAPTURE_PARTIAL' : 'VERIFIED'
}
