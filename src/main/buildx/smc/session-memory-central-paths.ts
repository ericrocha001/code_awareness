import { join } from 'node:path'

export function validateRepositoryId(repositoryId: unknown): string {
  if (typeof repositoryId !== 'string' || !repositoryId.trim()) {
    throw new Error('REPOSITORY_ID_REQUIRED: A valid non-empty repositoryId is strictly required and cannot be omitted.')
  }
  return repositoryId.trim()
}

export function smcDatabasePath(storageBaseDir: string, repositoryId: string): string {
  const validRepoId = validateRepositoryId(repositoryId)
  if (!storageBaseDir || typeof storageBaseDir !== 'string' || !storageBaseDir.trim()) {
    throw new Error('STORAGE_BASE_DIR_REQUIRED: Canonical storage base directory must be provided.')
  }
  const encodedRepoId = Buffer.from(validRepoId).toString('base64url')
  return join(storageBaseDir, 'repositories', encodedRepoId, 'smc.sqlite')
}
