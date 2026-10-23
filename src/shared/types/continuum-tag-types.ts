export interface ContinuumTag { slug: string; name: string; count: number }
export interface ContinuumTagDefinition { slug: string; name: string }
export interface ContinuumTagAssignment { artifactId: string; expectedRevision: number }
export type ContinuumTagMutation = { repositoryId: string } & (
  { intent: 'quick-create'; name: string; selected?: ContinuumTagAssignment[] } |
  { intent: 'create' | 'edit'; tag: ContinuumTagDefinition } |
  { intent: 'delete'; slug: string } |
  { intent: 'assign'; slug: string; selected: ContinuumTagAssignment[]; assigned: boolean; confirmed: boolean }
)
export function quickTag(name: string): ContinuumTagDefinition {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 80) throw new Error('INVALID_TAG_NAME')
  const slug = name.trim().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  validateTagSlug(slug)
  return { slug, name: name.trim() }
}
export function validateTagSlug(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) || ['constructor', 'prototype'].includes(value)) throw new Error('INVALID_TAG_SLUG: use lowercase letters, numbers and hyphens, up to 64 characters')
}
export function artifactTags(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 100) throw new Error('INVALID_TAGS: unique slug array required')
  value.forEach(validateTagSlug)
  if (new Set(value).size !== value.length) throw new Error('INVALID_TAGS: duplicate slug')
  return value as string[]
}
