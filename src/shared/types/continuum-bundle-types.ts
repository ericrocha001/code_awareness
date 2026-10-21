export interface ContinuumBundleMember { artifactId: string; name: string; kind: string; revision: number; mediaPath?: string }
export interface ContinuumBundlePreview {
  repositoryId: string; snapshotId: string; slug: string; tagName: string; objective: string; generatedAt: string
  members: ContinuumBundleMember[]; markdown: string; markdownBytes: number; tokenCount: number; tokenizerEncoding: string
  hasVisuals: boolean
}
export interface ContinuumBundlePrepare { repositoryId: string; slug: string; objective?: string; order?: string[] }
export interface ContinuumBundleExport { repositoryId: string; snapshotId: string; intent: 'copy' | 'markdown' | 'zip' }
