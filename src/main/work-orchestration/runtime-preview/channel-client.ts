import { readFile, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { NativeOwner } from './native-owner'
import type { PreviewContextManifest } from './context-contract'
import { previewChannelReply, previewChannelRequest, type PreviewChannelScope } from './channel-contract'
import { previewFingerprint } from '../preview-profile'

const endpoint = z.object({ version: z.literal(1), sessionId: z.string().uuid(), port: z.number().int().min(1).max(65535), pid: z.number().int().positive() }).strict()
export async function invokePreviewChannel(context: PreviewContextManifest, directory: string, token: string, owner: NativeOwner,
  scope: PreviewChannelScope, operation: string, input: Record<string, unknown>, main: { pid: number; runtime: string; abi: string }) {
  const file = join(directory, 'channel.json'), stat = await lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) throw Error('PREVIEW_UNAVAILABLE')
  const target = endpoint.parse(JSON.parse(await readFile(file, 'utf8')))
  if (target.sessionId !== context.sessionId) throw Error('SESSION_STALE')
  const proof = await owner.endpoint(target.port)
  const peer = proof.listeners[0]
  if (proof.listeners.length !== 1 || !peer.member || !peer.loopback || peer.pid !== target.pid || peer.pid !== main.pid) throw Error('SCOPE_REJECTED')
  const request = previewChannelRequest.parse({ version: 1, requestId: randomUUID(), scope, operation, input })
  const response = await fetch(`http://127.0.0.1:${target.port}/`, { method: 'POST', body: JSON.stringify(request),
    headers: { 'Content-Type': 'application/json', 'X-Preview-Channel-Token': token }, redirect: 'error', signal: AbortSignal.timeout(3000) })
  if (!response.ok) throw Error('SCOPE_REJECTED')
  const reader = response.body!.getReader(), chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.length; if (bytes > 32768) throw Error('SCOPE_REJECTED'); chunks.push(next.value) }
  } finally { await reader.cancel() }
  const reply = previewChannelReply.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
  const after = await owner.endpoint(target.port), process = await owner.inspect()
  if (process.rootSignaled || !process.assignedAtCreation || process.jobClosed || previewFingerprint(after) !== previewFingerprint(proof)) throw Error('SESSION_STALE')
  const identity = reply.identity
  if (reply.requestId !== request.requestId || identity.pid !== peer.pid || identity.runtime !== main.runtime || identity.abi !== main.abi || identity.sessionId !== context.sessionId ||
    identity.repositoryId !== context.selection.repositoryId || identity.worktreeId !== context.selection.worktreeId || identity.generation !== context.selection.generation ||
    previewFingerprint(identity.source) !== previewFingerprint(context.source) || previewFingerprint(identity.build ?? null) !== previewFingerprint(context.snapshot ? { captureId: context.snapshot.captureId, buildId: context.snapshot.buildId, runtimeId: context.snapshot.runtimeId } : null)) throw Error('SCOPE_REJECTED')
  return reply
}
