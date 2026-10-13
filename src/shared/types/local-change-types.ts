export type LocalChangeCategory = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflicted'
export interface LocalChange {
  path: string
  previousPath?: string
  stagedState: string | null
  unstagedState: string | null
  untracked: boolean
  deleted: boolean
  renamed: boolean
  conflicted: boolean
}
export interface LocalChangeSummary {
  total: number
  categories: Record<LocalChangeCategory, number>
}
