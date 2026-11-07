import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CheckpointRegistry } from '../checkpoint-registry'
import { nativeDigest, type NativeHookBinding, type NativeHookEnvelope } from '../native-hooks'
import { nativeObservationBatch } from '../native-hook-ingestion'
import { stampNativeCapture } from '../native-capture-window'

export function startCaptureFixture(registry: CheckpointRegistry, binding: NativeHookBinding, sessionId: string) {
  mkdirSync(join(binding.root, '.codex'), { recursive: true })
  mkdirSync(join(binding.root, '.code-awareness/native-hooks'), { recursive: true })
  const bindingPath = join(binding.root, '.code-awareness/native-hooks/binding.json'), configPath = join(binding.root, '.codex/hooks.json')
  if (!existsSync(bindingPath)) writeFileSync(bindingPath, JSON.stringify(binding))
  if (!existsSync(configPath)) writeFileSync(configPath, '{}')
  const facts = { schema: 1 as const, source: 'CODEX_NATIVE_HOOK' as const, repositoryId: binding.repositoryId,
    worktreeId: binding.worktreeId, generation: binding.generation, sessionId, event: 'SessionStart' as const }
  const body = { ...facts, observedAt: new Date().toISOString(), eventId: nativeDigest(JSON.stringify(facts)) }
  const event = stampNativeCapture({ ...body, digest: nativeDigest(JSON.stringify(body)) }, binding)
  const batch = nativeObservationBatch(event)
  registry.apply(batch, registry.source(batch.source)?.revision)
  return (envelope: NativeHookEnvelope) => stampNativeCapture(envelope, binding)
}
