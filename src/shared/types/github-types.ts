import type { RepositoryRecord } from './repository-catalog-types'

export type GitHubConnectionState =
  | 'CONFIGURATION_REQUIRED'
  | 'DISCONNECTED'
  | 'AUTHORIZING'
  | 'INSTALLATION_REQUIRED'
  | 'CONNECTED'
  | 'REAUTH_REQUIRED'

export type GitHubErrorCode =
  | 'CONFIGURATION_REQUIRED'
  | 'NOT_CONNECTED'
  | 'REAUTH_REQUIRED'
  | 'INSTALLATION_REQUIRED'
  | 'PERMISSION_DENIED'
  | 'RATE_LIMITED'
  | 'NETWORK_ERROR'
  | 'REPOSITORY_NOT_FOUND'
  | 'REPOSITORY_NAME_CONFLICT'
  | 'LOCAL_PATH_CONFLICT'
  | 'REMOTE_CONFLICT'
  | 'GIT_OPERATION_FAILED'
  | 'SECURE_STORAGE_UNAVAILABLE'
  | 'AUTHORIZATION_DENIED'
  | 'AUTHORIZATION_EXPIRED'
  | 'AUTHORIZATION_CANCELLED'

export interface GitHubUserProjection {
  id: string
  login: string
  avatarUrl: string
}

export interface GitHubStatusProjection {
  state: GitHubConnectionState
  user: GitHubUserProjection | null
  userCode?: string
  verificationUri?: string
  installationUrl?: string
  manageAccessUrl?: string
  lastSuccessfulSyncAt?: string
  lastSyncError?: { code: GitHubErrorCode; message: string }
}

export interface GitHubOperationResult {
  success: boolean
  repositories?: RepositoryRecord[]
  error?: { code: GitHubErrorCode; message: string; recoveryPath?: string }
  warning?: string
}

export interface GitHubCreateRepositoryInput {
  name: string
  visibility: 'PUBLIC' | 'PRIVATE'
  localParentPath?: string
}

export interface GitHubPublishRepositoryInput {
  repositoryId: string
  name: string
  visibility: 'PUBLIC' | 'PRIVATE'
}
