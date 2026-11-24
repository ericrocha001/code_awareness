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
      action: 'preview' | 'copy' | 'export' | 'text'
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
  hasVisuals: boolean
  members: PickerArtifact[]
}

export type PickerResult = PickerCatalog | PickerPreview | { outcome: string } | { markdown: string }
export type PickerResponse = { ok: true; result: PickerResult } | { ok: false; error: { code: string; message: string } }

export type DraftOutcome =
  | { outcome: 'inserted' }
  | { outcome: 'unavailable' | 'uncertain'; reason: string }
