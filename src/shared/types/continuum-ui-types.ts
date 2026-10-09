export type ContinuumScalar = string | number | boolean
export type ContinuumMetadataValue = null | ContinuumScalar | ContinuumMetadataValue[] | { [key: string]: ContinuumMetadataValue }
export interface ContinuumFacet { key: string; values: { value: ContinuumScalar; count: number }[] }
export interface ContinuumListRequest { repositoryId: string; query?: string; metadata?: Record<string, ContinuumScalar>; cursor?: string }
export interface ContinuumItem { artifactId: string; name: string; description?: string; kind: string; status?: string; updatedAt: string; relationCount: number }
export interface ContinuumTimeline { repositoryId: string | null; artifacts: ContinuumItem[]; nextCursor?: string }
export interface ContinuumFacets { repositoryId: string | null; facets: ContinuumFacet[] }
export interface ContinuumDetail {
  artifactId: string
  revision: number
  metadata: Record<string, ContinuumMetadataValue | undefined>
  body: string
  createdAt: string
  updatedAt: string
}
export interface ContinuumSelection { repositoryId: string | null; artifact: ContinuumDetail | null }
export interface ContinuumChange { repositoryId: string | null }
export interface ContinuumPublishRequest { repositoryId: string; fileName: string; rawMarkdown: string }
export interface ContinuumPublishReceipt { success: true; artifactId: string; revision: number; updatedAt: string }
export interface ContinuumVisualPublishRequest {
  repositoryId: string
  name: string
  description: string
  context: string
  relations?: { artifactId: string; kind: string }[]
  data: Uint8Array
}
export interface ContinuumVisualSelection { repositoryId: string; artifactId: string; mimeType: 'image/webp'; data: Uint8Array }
