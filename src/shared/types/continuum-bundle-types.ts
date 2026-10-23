export interface ContinuumBundleMember { artifactId: string; name: string; kind: string; revision: number; mediaPath?: string }
export interface ContinuumBundlePreview {
  repositoryId: string; snapshotId: string; slug: string; tagName: string; generatedAt: string
  members: ContinuumBundleMember[]; markdown: string; markdownBytes: number; tokenCount: number; tokenizerEncoding: string
  hasVisuals: boolean
}
export interface ContinuumBundlePrepare { repositoryId: string; slug: string; order?: string[] }
export interface ContinuumBundleExport { repositoryId: string; snapshotId: string; intent: 'copy' | 'markdown' | 'zip' }
export interface ContinuumBundleQuick { repositoryId: string; slug: string; intent: ContinuumBundleExport['intent'] }
export interface ContinuumBundleReceipt {
  repositoryId: string; slug: string; snapshotId: string; count: number; markdownBytes: number; tokenCount: number; tokenizerEncoding: string; hasVisuals: boolean; outcome: 'preview' | 'copied' | 'saved' | 'cancelled'
}
