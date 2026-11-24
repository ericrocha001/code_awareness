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

export type PickerTagRequest =
  | { action: 'tag-membership'; scope: PickerScope; artifactId: string }
  | { action: 'tag-assign'; scope: PickerScope; target: ContinuumSelectedArtifact; slug: string; operation: 'add' | 'remove' }
  | { action: 'tag-create'; scope: PickerScope; target: ContinuumSelectedArtifact; name: string; description?: string }

export type PickerTagMutation = Exclude<PickerTagRequest, { action: 'tag-membership' }>

export interface PickerTagView {
  artifact: PickerArtifact
  assigned: string[]
  tags: NonNullable<PickerCatalog['tags']>
  receipt?: { state: 'PERSISTED'; artifactId: string; revision: number }
}

export function isPickerTagMutation(value: unknown): value is PickerTagMutation {
  return value !== null && typeof value === 'object' && 'action' in value &&
    (value.action === 'tag-assign' || value.action === 'tag-create')
}

export type PickerRequest =
  | PickerTagRequest
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

export type PickerResult = PickerCatalog | PickerPreview | PickerDownload | PickerTagView | { outcome: 'copied' } |
  { markdown: string } | { files: PickerFile[] }
export type PickerResponse = { ok: true; result: PickerResult } | { ok: false; error: { code: string; message: string } }

export type DraftOutcome =
  | { outcome: 'inserted' }
  | { outcome: 'unavailable' | 'uncertain'; reason: string }

export function isPopupPickerRequest(value: unknown): value is PickerRequest {
  if (value === null || typeof value !== 'object' || !('action' in value)) return false
  return value.action === 'catalog' || value.action === 'preview' ||
    value.action === 'copy' || value.action === 'download' || value.action === 'tag-membership' || isPickerTagMutation(value)
}
