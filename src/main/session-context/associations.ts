import { z } from 'zod'

const text = z.string().min(1).max(200)
export const sessionSelection = z.object({ worktreeId: z.string().regex(/^[a-f0-9]{64}$/), generation: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
export const historicalSelectors = {
  executionId: text.optional(), artifactId: text.optional(), commitSha: z.string().regex(/^[a-f0-9]{40}$/).optional(), pullRequest: z.number().int().positive().optional()
}
export const declaredAssociation = z.object({ ...historicalSelectors, sourceArtifactId: text,
  sourceRevision: z.number().int().positive().optional(), sourceHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  proofIds: z.array(z.string().regex(/^proof-[a-f0-9-]{36}$/)).max(10).default([]), expectedCatalogRevision: z.number().int().positive() }).strict()
export type DeclaredSessionAssociation = z.infer<typeof declaredAssociation>
export interface SessionAssociation {
  repositoryId: string
  sessionId: string
  providerSessionId: string
  provider: 'entire' | 'codex'
  worktreeId: string
  generation: string
  executionId?: string
  artifactId?: string
  commitSha?: string
  pullRequest?: number
  sourceArtifactId?: string
  sourceRevision?: number
  sourceHash?: string
  checkpointId?: string
  archived?: true
  providerAccountHash?: string
  proofIds?: string[]
  evidence: 'PROVIDER_OBSERVED' | 'WORKTREE_VERIFIED' | 'CHECKPOINT_VERIFIED' | 'HANDOFF_DECLARED'
  origin: 'ENTIRE_PROVIDER' | 'ENTIRE_CHECKPOINT' | 'CONTINUUM_HANDOFF' | 'CODEX_APP_SERVER'
}
export interface SessionFilter {
  state?: string; agent?: string; after?: string; before?: string
  executionId?: string; artifactId?: string; commitSha?: string; pullRequest?: number
}
