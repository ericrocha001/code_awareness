export type ArtifactType = 'IMPLEMENTATION_HANDOFF'

export const SUPPORTED_ARTIFACT_TYPES: ReadonlySet<string> = new Set<ArtifactType>([
  'IMPLEMENTATION_HANDOFF'
])

export type ProducerRole = 'IMPLEMENTER'

export const SUPPORTED_PRODUCER_ROLES: ReadonlySet<string> = new Set<ProducerRole>([
  'IMPLEMENTER'
])

export interface Artifact {
  artifactId: string
  type: ArtifactType
  schemaVersion: number
  title: string
  producerRole: ProducerRole
  repositoryKey: string
  createdAt: string
  ingestedAt: string
  sourceFingerprint: string | null
  gitHead: string | null
  contentHash: string
  rawMarkdown: string
}

export interface ArtifactSummary {
  artifactId: string
  type: ArtifactType
  schemaVersion: number
  title: string
  producerRole: ProducerRole
  repositoryKey: string
  createdAt: string
  ingestedAt: string
  sourceFingerprint: string | null
  gitHead: string | null
  contentHash: string
}

export interface AppendArtifactInput {
  artifactId: string
  type: ArtifactType
  schemaVersion: number
  title: string
  producerRole: ProducerRole
  repositoryKey: string
  createdAt: string
  rawMarkdown: string
  sourceFingerprint?: string | null
  gitHead?: string | null
  contentHash?: string | null
  ingestedAt?: string | null
}

export interface ListArtifactsFilter {
  type?: ArtifactType
  producerRole?: ProducerRole
  repositoryKey?: string
  limit?: number
}

export interface IArtifactReader {
  get(artifactId: string): Artifact | null
  list(filter?: ListArtifactsFilter): ArtifactSummary[]
}

export interface IArtifactStore extends IArtifactReader {
  append(input: AppendArtifactInput): Artifact
  close(): void
}
