export interface CodexDiscoveredClient {
  path: string
  origin: 'EXPLICIT' | 'DESKTOP' | 'CLI' | 'PATH'
  version: string | null
  qualified: boolean
  reasonCode: string
  surface?: 'IDE' | 'CLI'
}

export type AntigravityDiscoveredClient = CodexDiscoveredClient

export interface UserHooksInstallationSummary {
  state: 'NOT_INSTALLED' | 'CONFIGURED' | 'CONFLICT' | 'MODIFIED' | 'UNSUPPORTED' | 'WORKTREE_STALE' | 'INVALID' | 'MISSING' | 'INCOMPATIBLE' | 'UNKNOWN'
  reasonCode: string
  installed: number
  total?: number
  expected?: number
  enabled: boolean
  helperDigest?: string
  nodePath?: string
  runAsNode?: boolean
  clientPath?: string
  clientVersion?: string
}

export interface CodexUserHooksStatus {
  scope: 'USER'
  codexHome: string
  configHome?: string
  configPath: string
  profileEnabled: boolean
  autoEnrollNewProjects: boolean
  gitCommitTool?: string
  installation: UserHooksInstallationSummary & { total: number }
  clients: CodexDiscoveredClient[]
  enrolledRepositoryIds: string[]
  repositoryEnrolled?: boolean
  externalPreparation?: boolean
  trust: 'NOT_INSPECTED'
}

export interface AntigravityUserHooksStatus {
  scope: 'USER'
  configHome: string
  codexHome?: string
  configPath: string
  profileEnabled: boolean
  autoEnrollNewProjects: boolean
  installation: UserHooksInstallationSummary
  clients: AntigravityDiscoveredClient[]
  enrolledRepositoryIds: string[]
  repositoryEnrolled?: boolean
  externalPreparation?: boolean
  trust: 'CLIENT_TRUST_UNSUPPORTED'
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

export interface AntigravityUserHooksInstallInput {
  configHome?: string
  clientPath?: string
  autoEnrollNewProjects?: boolean
  enrollActiveRepositories?: boolean
  repositoryIds?: string[]
  cutoverLegacy?: boolean
}

export interface UserHooksCutoverSummary {
  state: 'COMPLETED' | 'DEFERRED'
  items: Array<{ path: string; repositoryId?: string; state: 'CLEAN' | 'REMOVED' | 'CONFLICT'; reasonCode: string; restored?: boolean }>
}

export interface CodexUserHooksResult {
  state: string
  status: CodexUserHooksStatus
  trust?: 'UNCHANGED' | 'REVIEW_REQUIRED'
  enrolledRepositories?: string[]
  cutover?: UserHooksCutoverSummary
}

export interface AntigravityUserHooksResult {
  state: string
  status: AntigravityUserHooksStatus
  trust?: 'UNCHANGED' | 'REVIEW_REQUIRED'
  enrolledRepositories?: string[]
  cutover?: UserHooksCutoverSummary
}

export interface CodexUserHooksApi {
  status: (repositoryId?: string) => Promise<CodexUserHooksStatus>
  install: (input: CodexUserHooksInstallInput) => Promise<CodexUserHooksResult>
  disable: (codexHome?: string) => Promise<CodexUserHooksResult>
  enrollRepository: (repositoryId: string, options?: { gitCommitTool?: string; cutoverLegacy?: boolean }) => Promise<CodexUserHooksResult>
  revokeRepository: (repositoryId: string) => Promise<CodexUserHooksResult>
}

export interface AntigravityUserHooksApi {
  status: (repositoryId?: string) => Promise<AntigravityUserHooksStatus>
  install: (input: AntigravityUserHooksInstallInput) => Promise<AntigravityUserHooksResult>
  disable: (configHome?: string) => Promise<AntigravityUserHooksResult>
  enrollRepository: (repositoryId: string, options?: { cutoverLegacy?: boolean }) => Promise<AntigravityUserHooksResult>
  revokeRepository: (repositoryId: string) => Promise<AntigravityUserHooksResult>
}
