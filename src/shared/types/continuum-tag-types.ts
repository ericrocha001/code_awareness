export interface ContinuumTag { slug: string; name: string; color: string; description: string; count: number }
export interface ContinuumTagDefinition { slug: string; name: string; color: string; description?: string }
export interface ContinuumTagAssignment { artifactId: string; expectedRevision: number }
export type ContinuumTagMutation = { repositoryId: string } & (
  { intent: 'create' | 'edit'; tag: ContinuumTagDefinition } |
  { intent: 'delete'; slug: string } |
  { intent: 'assign'; slug: string; selected: ContinuumTagAssignment[]; assigned: boolean; confirmed: boolean }
)
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
