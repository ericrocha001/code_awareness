import type { ContinuumFacet, ContinuumSelectedArtifact } from '../types/continuum-ui-types'

export interface PickerScope {
  repositoryId: string
  binding: string
}

export interface PickerFilters {
  query?: string
  tag?: string
  kind?: string
  status?: string
  cursor?: string
}

export type PickerRequest =
  | { action: 'catalog'; scope?: PickerScope; filters: PickerFilters }
  | {
      action: 'preview' | 'copy' | 'download' | 'attach' | 'text'
      scope: PickerScope
      selected: ContinuumSelectedArtifact[]
    }

export interface PickerArtifact {
  artifactId: string
  revision: number
  name: string
  kind: string
}

export interface PickerCatalog {
  scope: PickerScope
  projectName: string
  tags?: { slug: string; name: string }[]
  facets?: ContinuumFacet[]
  artifacts: PickerArtifact[]
  nextCursor?: string
}

export interface PickerPreview {
  tokenCount: number
  markdownBytes: number
  artifactTokens: { artifactId: string; rawMarkdownTokenCount: number }[]
  hasVisuals: boolean
  members: PickerArtifact[]
}

export interface PickerFile {
  name: string
  type: 'text/markdown' | 'image/webp'
  encoded: string
}

export interface PickerDownload {
  outcome: 'downloaded'
  directory: string
  names: string[]
}

export interface PickerAttachment {
  outcome: 'attached' | 'partial' | 'failed' | 'unavailable' | 'uncertain'
  confirmed: string[]
  pending: string[]
  failed?: string[]
}

export type PickerResult = PickerCatalog | PickerPreview | PickerDownload | { outcome: 'copied' } |
  { markdown: string } | { files: PickerFile[] }
export type PickerResponse = { ok: true; result: PickerResult } | { ok: false; error: { code: string; message: string } }

export type DraftOutcome =
  | { outcome: 'inserted' }
  | { outcome: 'unavailable' | 'uncertain'; reason: string }
