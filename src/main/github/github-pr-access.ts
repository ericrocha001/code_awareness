import type { GitHubErrorCode } from '../../shared/types/github-types'
import { GitHubIntegrationError } from './github-errors'

export interface PullRequestAccessDiagnostic {
  cause: string
  operations: string[]
  requiredGrant?: string
  nextAction: string
  url?: string
  source?: string
}

export interface PullRequestEndpointPermissions {
  read: boolean
  close: boolean
  merge: boolean
  checks: boolean
  statuses: boolean
  accessState: 'READY' | 'PERMISSION_DENIED' | 'INSTALLATION_REQUIRED' | 'UNAVAILABLE'
  diagnostics: PullRequestAccessDiagnostic[]
  evidence: {
    source: 'GITHUB_APP_USER_TOKEN'
    installation: 'OBSERVED' | 'NOT_OBSERVED' | 'UNKNOWN'
    repositoryScope: 'INCLUDED' | 'NOT_OBSERVED' | 'UNKNOWN'
    installationId?: number
    grants?: Record<string, string>
    userPermissions?: { pull: boolean | null; push: boolean | null }
    publicResourceReadIsGrantEvidence: false
  }
}

export class GitHubPrAccessError extends GitHubIntegrationError {
  constructor(code: GitHubErrorCode, readonly diagnostic: PullRequestAccessDiagnostic) { super(code, code) }
}

export const prAccessOperations = ['read', 'reviews', 'checks', 'statuses', 'create', 'close', 'merge']
export function deniedPullRequestAccess(accessState: PullRequestEndpointPermissions['accessState'], diagnostic: PullRequestAccessDiagnostic, evidence: Partial<PullRequestEndpointPermissions['evidence']> = {}): PullRequestEndpointPermissions {
  return { read: false, close: false, merge: false, checks: false, statuses: false, accessState, diagnostics: [diagnostic],
    evidence: { source: 'GITHUB_APP_USER_TOKEN', installation: 'UNKNOWN', repositoryScope: 'UNKNOWN', ...evidence, publicResourceReadIsGrantEvidence: false } }
}

export function pullRequestAccessFailure(code: string, source = 'GITHUB_INTEGRATION'): PullRequestAccessDiagnostic {
  const cause = code === 'CONFIGURATION_REQUIRED' ? 'CONFIGURATION_OVERRIDE_INCOMPLETE' : code === 'REAUTH_REQUIRED' ? 'USER_TOKEN_REAUTH_REQUIRED' : code === 'NOT_CONNECTED' ? 'DESKTOP_SESSION_REQUIRED' : code === 'PERMISSION_DENIED' ? 'PROVIDER_ACCESS_DENIED' : code === 'RATE_LIMITED' ? 'PROVIDER_RATE_LIMITED' : code === 'REMOTE_CONFLICT' ? 'REPOSITORY_IDENTITY_MISMATCH' : 'ACCESS_NOT_ESTABLISHED'
  return { cause, operations: prAccessOperations, source, nextAction: code === 'CONFIGURATION_REQUIRED' ? 'REMOVE_BOTH_OVERRIDES_OR_PROVIDE_COMPLETE_PAIR' : code === 'REAUTH_REQUIRED' || code === 'NOT_CONNECTED' ? 'CONNECT_OR_REAUTHORIZE_IN_DESKTOP' : code === 'PERMISSION_DENIED' ? 'REVIEW_INSTALLATION_AND_USER_AUTHORIZATION' : code === 'RATE_LIMITED' ? 'WAIT_FOR_PROVIDER_RATE_LIMIT' : 'INSPECT_PROVIDER_ACCESS_WITHOUT_MUTATION',
    ...(code === 'PERMISSION_DENIED' ? { url: 'https://github.com/settings/installations' } : {}) }
}
