import { dump } from 'js-yaml'
// @ts-expect-error Electron Vite bundles this ESM dependency into the CommonJS main entry.
import { toString } from 'mdast-util-to-string'
import { parseArtifactMarkdown, validateMarkdown, validateMetadata } from './artifact-metadata'
import { parseStructure } from './artifact-structure'
import type { ArtifactMetadata, ArtifactSemanticFields } from './continuum-types'

export class MissingSemanticFieldError extends Error {
  readonly code = 'MISSING_SEMANTIC_FIELD'
  constructor(readonly field: keyof ArtifactSemanticFields) {
    super(`MISSING_SEMANTIC_FIELD: ${field}: provide an explicit semantic ${field}`)
  }
}

export function publicationFields(value: unknown): ArtifactSemanticFields {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_ARGUMENT: semantic fields must be an object')
  const fields: ArtifactSemanticFields = {}
  for (const [key, field] of Object.entries(value)) {
    if (!['name', 'description', 'kind'].includes(key) || typeof field !== 'string' || !field.trim()) throw new Error('INVALID_ARGUMENT: only non-empty semantic name, description and kind are accepted')
    fields[key as keyof ArtifactSemanticFields] = field
  }
  return fields
}

export function canonicalizePublication(rawMarkdown: string, input: ArtifactSemanticFields = {}, prior?: ArtifactMetadata): { rawMarkdown: string; metadata: ArtifactMetadata } {
  validateMarkdown(rawMarkdown)
  const fields = publicationFields(input)
  if (/^(?:\uFEFF)?---(?:\r?\n|$)/.test(rawMarkdown)) {
    const { metadata } = parseArtifactMarkdown(rawMarkdown)
    for (const [key, value] of Object.entries(fields)) if (metadata[key] !== value) throw new Error(`INVALID_ARGUMENT: ${key} conflicts with authored frontmatter`)
    return { rawMarkdown, metadata }
  }
  const semanticPrior: Partial<ArtifactMetadata> = { ...prior }
  delete semanticPrior.media
  const metadata = { ...semanticPrior, ...fields }
  if (!metadata.kind) throw new MissingSemanticFieldError('kind')
  if (!metadata.name || !metadata.description) {
    const { nodes } = parseStructure(rawMarkdown)
    const title = nodes[0]
    const uniqueTitle = title?.type === 'heading' && title.depth === 1 && nodes.filter(node => node.type === 'heading' && node.depth === 1).length === 1
    if (!metadata.name) {
      const name = uniqueTitle ? toString(title).trim() : ''
      if (!name || name.length > 512) throw new MissingSemanticFieldError('name')
      metadata.name = name
    }
    if (!metadata.description) {
      const intro = uniqueTitle ? nodes[1] : nodes[0]
      const description = intro?.type === 'paragraph' && intro.children.every(node => node.type === 'text') ? toString(intro).replace(/\s+/g, ' ').trim() : ''
      if (description.length < 24 || description.length > 512 || !/[.!?。！？]$/.test(description)) throw new MissingSemanticFieldError('description')
      metadata.description = description
    }
  }
  const checked = validateMetadata(metadata)
  const bom = rawMarkdown.startsWith('\uFEFF') ? '\uFEFF' : ''
  const canonical = `${bom}---\n${dump(checked, { lineWidth: -1 })}---\n${rawMarkdown.slice(bom.length)}`
  return { rawMarkdown: canonical, metadata: checked }
}
