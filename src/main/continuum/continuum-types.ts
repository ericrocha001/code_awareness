export type MetadataValue = null | boolean | number | string | MetadataValue[] | { [key: string]: MetadataValue }
export interface ArtifactRelation { artifactId: string; kind: string }
export interface ArtifactMetadata {
  name: string
  description?: string
  kind: string
  status?: string
  relations?: ArtifactRelation[]
  [key: string]: MetadataValue | ArtifactRelation[] | undefined
}
export interface Artifact {
  artifactId: string
  revision: number
  metadata: ArtifactMetadata
  rawMarkdown: string
  createdAt: string
  updatedAt: string
  contentHash: string
  provenance: Record<string, MetadataValue>
}
export interface ArtifactDiscoveryRecord {
  artifactId: string
  name: string
  description?: string
  kind: string
  status?: string
  updatedAt: string
  relationCount: number
  metadata?: Record<string, MetadataValue>
}
export interface ListArtifactsFilter {
  query?: string
  kind?: string
  status?: string
  metadata?: Record<string, MetadataValue>
  metadataKeys?: string[]
  relatedToArtifactId?: string
  relationKind?: string
  direction?: 'inbound' | 'outbound' | 'both'
  updatedAfter?: string
  updatedBefore?: string
  limit?: number
  cursor?: string
}
export interface ArtifactPage { artifacts: ArtifactDiscoveryRecord[]; nextCursor?: string }
export interface CreateArtifactInput {
  artifactId: string
  metadata: ArtifactMetadata
  rawMarkdown: string
  createdAt?: string
  updatedAt?: string
  contentHash?: string
  provenance?: Record<string, MetadataValue>
}
export interface UpdateArtifactInput {
  artifactId: string
  expectedRevision: number
  metadata: ArtifactMetadata
  rawMarkdown: string
}
export interface ArtifactReceipt { success: true; artifactId: string; revision: number; updatedAt: string }
export interface IArtifactReader {
  get(artifactId: string): Artifact | null
  list(filter?: ListArtifactsFilter): ArtifactPage
}
export interface IContinuumService extends IArtifactReader {
  publish(rawMarkdown: string): ArtifactReceipt
  update(artifactId: string, expectedRevision: number, rawMarkdown: string): ArtifactReceipt
}
