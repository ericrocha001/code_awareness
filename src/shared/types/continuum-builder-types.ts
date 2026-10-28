import type { ContinuumItem, ContinuumListRequest, ContinuumSelectedArtifact } from './continuum-ui-types'

export type BundleQuery = Omit<ContinuumListRequest, 'repositoryId' | 'cursor'>
export type BundleComponentSource = { kind: 'artifact'; selected: ContinuumSelectedArtifact[] } | { kind: 'query'; filter: BundleQuery }
export interface BundleComponent { id: string; source: BundleComponentSource; members: ContinuumItem[] }
export interface BundleComposition { repositoryId: string; components: BundleComponent[]; excluded: string[]; order: string[] }
export interface BuilderPreview { repositoryId: string; fingerprint: string; count: number; documentTokens: number; tokenCount: number; tokenizerEncoding: string; markdownBytes: number; hasVisuals: boolean; markdown: string }
export interface BundleResult {
  id: string; repositoryId: string; generatedAt: string; name?: string; format: 'copy' | 'markdown' | 'zip'; sha256: string; bytes: number
  count: number; tokenCount: number; tokenizerEncoding: string; hasVisuals: boolean; composition: BundleComposition
}
export interface HistoricalBundleResult extends BundleResult { readonly compression?: Readonly<{ applied: boolean; [key: string]: unknown }> }
export type BuilderRequest = { repositoryId: string } & (
  | { action: 'resolve'; source: BundleComponentSource; refresh?: boolean }
  | { action: 'preview'; composition: BundleComposition; intent?: 'copy' | 'markdown' | 'zip' }
  | { action: 'export'; composition: BundleComposition; intent: 'copy' | 'markdown' | 'zip'; name?: string }
  | { action: 'recent' }
  | { action: 'reuse'; id: string }
  | { action: 'restore'; id: string; mode: 'members' | 'recipe' }
  | { action: 'cancel' }
)
export interface BuilderReceipt { repositoryId: string; outcome: 'copied' | 'saved' | 'cancelled'; retained?: boolean; retentionMessage?: string; historicalAt?: string }

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
