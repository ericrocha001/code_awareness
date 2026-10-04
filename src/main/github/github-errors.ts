import type { GitHubErrorCode } from '../../shared/types/github-types'

export class GitHubIntegrationError extends Error {
  constructor(readonly code: GitHubErrorCode, message: string, readonly recoveryPath?: string) {
    super(message)
    this.name = 'GitHubIntegrationError'
  }
}

export function toGitHubIntegrationError(error: unknown, fallback: GitHubErrorCode = 'NETWORK_ERROR'): GitHubIntegrationError {
  if (error instanceof GitHubIntegrationError) return error
  const code = error instanceof Error && isGitHubErrorCode(error.message) ? error.message : fallback
  return new GitHubIntegrationError(code, githubErrorMessage(code))
}

export function githubErrorMessage(code: GitHubErrorCode): string {
  const messages: Record<GitHubErrorCode, string> = {
    CONFIGURATION_REQUIRED: 'GitHub App configuration is required.',
    NOT_CONNECTED: 'Connect GitHub to continue.',
    REAUTH_REQUIRED: 'GitHub authorization expired. Connect again.',
    INSTALLATION_REQUIRED: 'Install the Code Awareness GitHub App to continue.',
    PERMISSION_DENIED: 'The GitHub App does not have permission for this operation.',
    RATE_LIMITED: 'GitHub rate limit reached. Try again later.',
    NETWORK_ERROR: 'GitHub is currently unavailable.',
    REPOSITORY_NOT_FOUND: 'GitHub repository was not found.',
    REPOSITORY_NAME_CONFLICT: 'A GitHub repository with this name already exists.',
    LOCAL_PATH_CONFLICT: 'The local destination already exists.',
    REMOTE_CONFLICT: 'The existing origin is not the selected GitHub repository.',
    GIT_OPERATION_FAILED: 'The Git operation failed.',
    SECURE_STORAGE_UNAVAILABLE: 'Secure credential storage is unavailable.',
    AUTHORIZATION_DENIED: 'GitHub authorization was denied.',
    AUTHORIZATION_EXPIRED: 'The GitHub authorization code expired.',
    AUTHORIZATION_CANCELLED: 'GitHub authorization was cancelled.'
  }
  return messages[code]
}

function isGitHubErrorCode(value: string): value is GitHubErrorCode {
  return value in {
    CONFIGURATION_REQUIRED: 1, NOT_CONNECTED: 1, REAUTH_REQUIRED: 1, INSTALLATION_REQUIRED: 1,
    PERMISSION_DENIED: 1, RATE_LIMITED: 1, NETWORK_ERROR: 1, REPOSITORY_NOT_FOUND: 1,
    REPOSITORY_NAME_CONFLICT: 1, LOCAL_PATH_CONFLICT: 1, REMOTE_CONFLICT: 1,
    GIT_OPERATION_FAILED: 1, SECURE_STORAGE_UNAVAILABLE: 1, AUTHORIZATION_DENIED: 1,
    AUTHORIZATION_EXPIRED: 1, AUTHORIZATION_CANCELLED: 1
  }
}
