export interface CodexDiscoveredClient {
  path: string
  origin: 'EXPLICIT' | 'DESKTOP' | 'CLI' | 'PATH'
  version: string | null
  qualified: boolean
  reasonCode: string
}

export interface CodexUserHooksStatus {
  scope: 'USER'
  codexHome: string
  configPath: string
  profileEnabled: boolean
  autoEnrollNewProjects: boolean
  gitCommitTool?: string
  installation: {
    state: 'NOT_INSTALLED' | 'CONFIGURED' | 'CONFLICT' | 'MODIFIED' | 'UNSUPPORTED' | 'WORKTREE_STALE' | 'INVALID'
    reasonCode: string
    installed: number
    total: number
    enabled: boolean
    helperDigest?: string
    nodePath?: string
    runAsNode?: boolean
    clientPath?: string
    clientVersion?: string
  }
  clients: CodexDiscoveredClient[]
  enrolledRepositoryIds: string[]
  repositoryEnrolled?: boolean
  externalPreparation?: boolean
  trust: 'NOT_INSPECTED'
}

export interface CodexUserHooksInstallInput {
  codexHome?: string
  clientPath?: string
  gitCommitTool?: string
  autoEnrollNewProjects?: boolean
  enrollActiveRepositories?: boolean
  repositoryIds?: string[]
  cutoverLegacy?: boolean
}

export interface CodexUserHooksResult {
  state: string
  status: CodexUserHooksStatus
  trust?: 'UNCHANGED' | 'REVIEW_REQUIRED'
  enrolledRepositories?: string[]
  cutover?: {
    state: 'COMPLETED' | 'DEFERRED'
    items: Array<{ path: string; repositoryId?: string; state: 'CLEAN' | 'REMOVED' | 'CONFLICT'; reasonCode: string; restored?: boolean }>
  }
}

export interface CodexUserHooksApi {
  status: (repositoryId?: string) => Promise<CodexUserHooksStatus>
  install: (input: CodexUserHooksInstallInput) => Promise<CodexUserHooksResult>
  disable: (codexHome?: string) => Promise<CodexUserHooksResult>
  enrollRepository: (repositoryId: string, options?: { gitCommitTool?: string; cutoverLegacy?: boolean }) => Promise<CodexUserHooksResult>
  revokeRepository: (repositoryId: string) => Promise<CodexUserHooksResult>
}
