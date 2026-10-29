import { z } from 'zod'

const id = z.string().min(1).max(512)
export const previewChannelScope = z.object({ sessionId: z.string().uuid(), repositoryId: id, worktreeId: id, generation: id }).strict()
export const previewChannelRequest = z.object({ version: z.literal(1), requestId: z.string().uuid(), scope: previewChannelScope,
  operation: z.string().min(1).max(64), input: z.record(z.unknown()) }).strict()
export const previewChannelError = z.enum(['PREVIEW_UNAVAILABLE', 'SESSION_STALE', 'CAPABILITY_UNAVAILABLE', 'SCOPE_REJECTED'])
export const previewRuntimeIdentity = z.object({ ...previewChannelScope.shape, instanceId: z.string().uuid(), pid: z.number().int().positive(),
  runtime: id, abi: id, source: z.object({ head: z.string().nullable(), branch: z.string().nullable(),
    indexRevision: z.string(), worktreeRevision: z.string(), dirty: z.boolean(), operation: z.string().nullable().optional() }).strict() }).strict()
export const previewCapabilities = [
  { operation: 'runtime.identity', input: { type: 'object', properties: {}, additionalProperties: false } },
  { operation: 'runtime.liveness', input: { type: 'object', properties: {}, additionalProperties: false } },
  { operation: 'runtime.capabilities', input: { type: 'object', properties: {}, additionalProperties: false } },
  { operation: 'checkout.list', input: { type: 'object', properties: { path: { type: 'string', maxLength: 1024 }, offset: { type: 'integer', minimum: 0, maximum: 1000 } }, additionalProperties: false } }
] as const
export const previewOperationData = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('IDENTITY'), identity: previewRuntimeIdentity }).strict(),
  z.object({ kind: z.literal('LIVENESS'), alive: z.literal(true) }).strict(),
  z.object({ kind: z.literal('CAPABILITIES'), version: z.literal(1), capabilities: z.array(z.object({ operation: id, input: z.record(z.unknown()) }).strict()).max(16),
    readiness: z.record(z.object({ state: id, reasonCode: id.optional() }).strict()) }).strict(),
  z.object({ kind: z.literal('CHECKOUT'), path: z.string().max(1024), entries: z.array(z.object({ name: z.string().max(512), kind: z.enum(['DIRECTORY', 'FILE']) }).strict()).max(20), nextOffset: z.number().int().nullable() }).strict()
])
export const previewChannelReply = z.object({ version: z.literal(1), requestId: z.string().uuid(), identity: previewRuntimeIdentity,
  result: z.discriminatedUnion('success', [z.object({ success: z.literal(true), data: previewOperationData }).strict(),
    z.object({ success: z.literal(false), code: previewChannelError }).strict()]) }).strict()
export type PreviewChannelScope = z.infer<typeof previewChannelScope>
export type PreviewChannelRequest = z.infer<typeof previewChannelRequest>
