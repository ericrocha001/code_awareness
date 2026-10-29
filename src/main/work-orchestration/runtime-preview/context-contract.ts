import { z } from 'zod'

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const id = z.string().min(1).max(512)
export const previewDataPolicy = z.object({
  kind: z.literal('CODE_AWARENESS'),
  dataPolicy: z.enum(['EMPTY', 'REPOSITORY_SNAPSHOT', 'ARTIFACT_FIRST']).default('EMPTY'),
  maxBytes: z.number().int().min(1048576).max(268435456),
  maxArtifacts: z.number().int().min(1).max(50000)
}).strict()
export const previewDataReceipt = z.union([z.object({
  policy: z.enum(['EMPTY', 'REPOSITORY_SNAPSHOT']), repositoryId: id,
  origin: z.enum(['EMPTY', 'HOST_REPOSITORY_CONTINUUM']),
  at: z.string().datetime(), schema: digest, digest,
  bytes: z.number().int().nonnegative(), artifacts: z.number().int().nonnegative(), media: z.number().int().nonnegative()
}).strict(), z.object({
  policy: z.literal('ARTIFACT_FIRST'), repositoryId: id, origin: z.literal('HOST_CANONICAL_REFERENCE'),
  at: z.string().datetime(), schema: z.null(), digest: z.null(), bytes: z.literal(0), artifacts: z.literal(0), media: z.literal(0)
}).strict()])
export const previewContextManifest = z.object({
  version: z.literal(1), mode: z.literal('PREVIEW'), sessionId: z.string().uuid(),
  selection: z.object({ repositoryId: id, worktreeId: id, generation: id, profileId: id, fingerprint: digest }).strict(),
  profileRevision: z.number().int().positive(), worktree: z.string().min(1).max(4096),
  source: z.object({ head: z.string().nullable(), branch: z.string().nullable(), indexRevision: z.string(), worktreeRevision: z.string(), dirty: z.boolean(), operation: z.string().nullable().optional() }).strict(),
  policy: previewDataPolicy, data: previewDataReceipt, catalogDigest: digest
}).strict()
export type PreviewContextManifest = z.infer<typeof previewContextManifest>
export type PreviewDataReceipt = z.infer<typeof previewDataReceipt>
