export type RepositoryStatus = 'ACTIVE' | 'HIDDEN'
export type RepositoryAvailability = 'AVAILABLE' | 'MISSING'
export type RepositoryGitState = 'GIT' | 'NON_GIT'
export type GitHubRepositoryVisibility = 'PUBLIC' | 'PRIVATE' | 'INTERNAL'
export type GitHubRepositoryAccessState = 'AVAILABLE' | 'UNAVAILABLE'

export interface LocalCheckout {
  path: string
  availability: RepositoryAvailability
  gitState: RepositoryGitState
}

export interface GitHubRepositoryIdentity {
  repositoryId: string
  ownerId: string
  ownerLogin: string
  name: string
  fullName: string
  visibility: GitHubRepositoryVisibility
  htmlUrl: string
  cloneUrl: string
  accessState: GitHubRepositoryAccessState
  lastSeenAt: string
}

export interface RepositoryRecord {
  id: string
  name: string
  status: RepositoryStatus
  localCheckout: LocalCheckout | null
  github: GitHubRepositoryIdentity | null
  createdAt: string
  updatedAt: string
}
