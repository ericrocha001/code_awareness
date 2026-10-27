export interface ContinuumBundleMember { artifactId: string; name: string; kind: string; revision: number; mediaPath?: string }
export interface ContinuumBundlePreview {
  repositoryId: string; snapshotId: string; slug: string; tagName: string; tagDescription: string; generatedAt: string
  members: ContinuumBundleMember[]; markdown: string; markdownBytes: number; tokenCount: number; tokenizerEncoding: string
  hasVisuals: boolean
  source?: ContinuumBundleSource
  compositionAvailable?: boolean
}
export type ContinuumBundleSource = { kind: 'tag'; slug: string } | { kind: 'selection'; selected: import('./continuum-ui-types').ContinuumSelectedArtifact[] }
export type ContinuumBundlePrepare = { repositoryId: string; order?: string[] } & ({ slug: string; source?: never } | { source: ContinuumBundleSource; slug?: never })
export interface ContinuumBundleExport { repositoryId: string; snapshotId: string; intent: 'copy' | 'markdown' | 'zip' }
export type ContinuumBundleQuick = {
  repositoryId: string
  intent: ContinuumBundleExport['intent']
} & (
  | { slug: string; selected?: never }
  | { selected: import('./continuum-ui-types').ContinuumSelectedArtifact[]; slug?: never }
)
export interface ContinuumBundleReceipt {
  repositoryId: string; slug: string; snapshotId: string; count: number; markdownBytes: number; tokenCount: number; tokenizerEncoding: string; hasVisuals: boolean; outcome: 'preview' | 'copied' | 'saved' | 'cancelled'
  filePath?: string
}
