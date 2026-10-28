import type { ContinuumItem, ContinuumListRequest, ContinuumSelectedArtifact } from './continuum-ui-types'

export type BundleQuery = Omit<ContinuumListRequest, 'repositoryId' | 'cursor'>
export type BundleComponentSource = { kind: 'artifact'; selected: ContinuumSelectedArtifact[] } | { kind: 'query'; filter: BundleQuery }
export interface BundleComponent { id: string; source: BundleComponentSource; members: ContinuumItem[] }
export interface BundleComposition { repositoryId: string; components: BundleComponent[]; excluded: string[]; order: string[] }
export type BundleCompressionProfile = 'off' | 'light' | 'balanced' | 'strong'
export type BundleCompressionOutcome = 'disabled' | 'no-eligible-blocks' | 'no-block-gain' | 'roundtrip-rejected' | 'overhead-no-gain' | 'timeout' | 'byte-limit' | 'invalid-block' | 'pakt-error' | 'applied'
export interface BundleCompressionReport {
  profile: BundleCompressionProfile; applied: boolean; originalTokens: number; outputTokens: number; savedTokens: number; savedPercent: number; transformedBlocks: number; reason: string
  outcome?: BundleCompressionOutcome; detectedBlocks?: number; rejectedBlocks?: number; unchangedBlocks?: number
}
export interface BuilderPreview { repositoryId: string; fingerprint: string; count: number; documentTokens: number; tokenCount: number; tokenizerEncoding: string; markdownBytes: number; hasVisuals: boolean; markdown: string; compression?: BundleCompressionReport }
export interface BundleResult {
  id: string; repositoryId: string; generatedAt: string; name?: string; format: 'copy' | 'markdown' | 'zip'; sha256: string; bytes: number
  count: number; tokenCount: number; tokenizerEncoding: string; hasVisuals: boolean; composition: BundleComposition; compression?: BundleCompressionReport
}
export type BuilderRequest = { repositoryId: string } & (
  | { action: 'resolve'; source: BundleComponentSource; refresh?: boolean }
  | { action: 'preview'; composition: BundleComposition; profile?: BundleCompressionProfile; intent?: 'copy' | 'markdown' | 'zip' }
  | { action: 'export'; composition: BundleComposition; profile?: BundleCompressionProfile; intent: 'copy' | 'markdown' | 'zip'; name?: string }
  | { action: 'recent' }
  | { action: 'reuse'; id: string }
  | { action: 'restore'; id: string; mode: 'members' | 'recipe' }
  | { action: 'cancel' }
)
export interface BuilderReceipt { repositoryId: string; outcome: 'copied' | 'saved' | 'cancelled'; retained?: boolean; retentionMessage?: string; historicalAt?: string; compression?: BundleCompressionReport }

export function consolidateBundle(composition: BundleComposition): ContinuumItem[] {
  const unique = new Map<string, ContinuumItem>()
  for (const component of composition.components) for (const member of component.members) {
    const prior = unique.get(member.artifactId)
    if (prior && prior.revision !== member.revision) throw new Error('BUNDLE_SNAPSHOT_STALE: atualize os grupos conflitantes')
    unique.set(member.artifactId, member)
  }
  const order = new Map(composition.order.map((id, index) => [id, index]))
  const excluded = new Set(composition.excluded)
  return [...unique.values()].filter(member => !excluded.has(member.artifactId)).sort((a, b) =>
    (order.get(a.artifactId) ?? Infinity) - (order.get(b.artifactId) ?? Infinity) || a.artifactId.localeCompare(b.artifactId, 'en'))
}
