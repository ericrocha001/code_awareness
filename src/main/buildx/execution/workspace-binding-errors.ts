export class BuildXWorkspaceBindingConflictError extends Error {
  constructor(reason: string) {
    super(`WORKSPACE_BINDING_CONFLICT: ${reason}`)
    this.name = 'BuildXWorkspaceBindingConflictError'
  }
}

export class BuildXWorkspaceNotFoundError extends Error {
  constructor(worktreeId: string) {
    super(`WORKSPACE_NOT_FOUND: Worktree "${worktreeId}" not found in repository inventory`)
    this.name = 'BuildXWorkspaceNotFoundError'
  }
}

export class BuildXWorkspaceInvalidError extends Error {
  constructor(reason: string) {
    super(`INVALID_WORKSPACE: ${reason}`)
    this.name = 'BuildXWorkspaceInvalidError'
  }
}

export class BuildXWorkspaceRepositoryMismatchError extends Error {
  constructor(expected: string, actual: string) {
    super(`REPOSITORY_MISMATCH: Expected repository "${expected}" but Git inventory reported "${actual}"`)
    this.name = 'BuildXWorkspaceRepositoryMismatchError'
  }
}
