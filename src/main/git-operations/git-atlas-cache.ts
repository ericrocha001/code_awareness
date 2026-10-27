import type { GitHistoryNode } from '../../shared/types/git-management-types'
import type { GitAtlasScope, GitAtlasWindow } from '../../shared/types/git-atlas-types'
import type { AtlasCatalogManifest, AtlasCollectionRound, AtlasCatalogDiagnostic } from '../../shared/types/git-atlas-catalog-types'

export type AtlasCommit = Omit<GitHistoryNode, 'decorations'>
export interface AtlasHistoryOrder {
  key: string
  offset: number
  shas: string[]
  complete: boolean
}
export interface AtlasOrderPage {
  shas: string[]
  materialized: number
  complete: boolean
}
export interface AtlasHistorySlice {
  order?: AtlasHistoryOrder
  revision: string
  worktreeGeneration: string
  scope?: GitAtlasScope
  tips: string[]
  window: GitAtlasWindow
  offset: number
  limit: number
  shas: string[]
  hasMore: boolean
  since: string | null
  anchorAt: string
  anchorKind: 'PRESENT' | 'CHECKOUT'
  upperBound: string | null
  queriedAt: string
}
export interface AtlasPersistence {
  readonly catalogIdentity: string
  diagnostic(): AtlasCatalogDiagnostic
  suspend(reason: string): void
  retry?(): boolean
  getCommit(sha: string): AtlasCommit | undefined
  getDisplayCommit(sha: string): AtlasCommit | undefined
  getSlice(key: string): AtlasHistorySlice | undefined
  getOrder?(key: string, offset: number, limit: number, since: string | null, until: string | null): AtlasOrderPage | undefined
  findSlice(revision: string, since: string | null, until: string): AtlasHistorySlice | undefined
  save(key: string, slice: AtlasHistorySlice, commits: readonly AtlasCommit[], observation?: AtlasCatalogManifest): boolean
  beginRound(manifest: AtlasCatalogManifest): AtlasCollectionRound | undefined
  getRound(id: string): AtlasCollectionRound | undefined
  frontier(id: string, limit: number): string[]
  covered(sha: string, topology: string): boolean
  checkpoint(id: string, commits: readonly AtlasCommit[], processed: readonly string[]): boolean
  finishRound(id: string, revision: string, available: boolean): boolean
  markUnknown(id: string, reason: string): void
  close(): void
}

function freeze(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return
  for (const child of Object.values(value)) freeze(child)
  Object.freeze(value)
}

export class AtlasCache {
  private readonly entries = new Map<string, { value: unknown; bytes: number }>()
  private bytes = 0
  constructor(private readonly capacity = 64, private readonly byteLimit = 8 * 1024 * 1024) {}
  get<T>(key: string): T | undefined {
    const value = this.getReadonly<T>(key)
    return value === undefined ? undefined : structuredClone(value)
  }
  getReadonly<T>(key: string): T | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    this.entries.delete(key); this.entries.set(key, entry)
    return entry.value as T
  }
  findReadonly<T>(matches: (value: T) => boolean): T | undefined {
    for (const [key, entry] of this.entries) { if (matches(entry.value as T)) return this.getReadonly<T>(key) }
    return undefined
  }
  set(key: string, value: unknown) {
    const bytes = Buffer.byteLength(JSON.stringify(value))
    if (bytes > this.byteLimit) return
    const existing = this.entries.get(key)
    if (existing) { this.bytes -= existing.bytes; this.entries.delete(key) }
    const stored = structuredClone(value)
    freeze(stored)
    this.entries.set(key, { value: stored, bytes }); this.bytes += bytes
    while (this.entries.size > this.capacity || this.bytes > this.byteLimit) {
      const oldest = this.entries.keys().next().value!
      this.bytes -= this.entries.get(oldest)!.bytes; this.entries.delete(oldest)
    }
  }
  clear() { this.entries.clear(); this.bytes = 0 }
}
