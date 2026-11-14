export interface HookListSummary {
  state: 'TRUSTED' | 'UNTRUSTED' | 'PARTIAL' | 'UNKNOWN'
  reasonCode: string
  expected: number
  matched: number
  trusted: number
  issues: { eventType: string; reasonCode: string }[]
  stale?: boolean
  hashDigest?: string
}
export function summarizeHookList(response: unknown, expected: { key: string; event: string; sourcePath?: string }[]): HookListSummary
export function matchesHookKey(key: unknown, handler: { key: string; sourcePath?: string }): boolean
export function sameHookPath(first: unknown, second: unknown): boolean

export function isQualifiedCodexHookVersion(version: string): boolean
