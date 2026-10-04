import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GitHubErrorCode, GitHubUserProjection } from '../../shared/types/github-types'

export interface GitHubSecretProtection {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
  getSelectedStorageBackend?(): string
}

export interface GitHubCredentials {
  accessToken: string
  accessTokenExpiresAt: string
  refreshToken: string
  refreshTokenExpiresAt: string
}

export interface GitHubConnectionMetadata {
  user: GitHubUserProjection | null
  connectedAt?: string
  lastSuccessfulSyncAt?: string
  lastSyncError?: { code: GitHubErrorCode; message: string }
}

export class GitHubCredentialStore {
  constructor(private readonly directory: string, private readonly protection: GitHubSecretProtection) {}

  loadCredentials(): GitHubCredentials | null {
    const file = this.credentialsPath()
    if (!existsSync(file)) return null
    this.requireProtection()
    try {
      const value = JSON.parse(this.protection.decryptString(readFileSync(file))) as GitHubCredentials
      if (!value.accessToken || !value.refreshToken || !value.accessTokenExpiresAt || !value.refreshTokenExpiresAt) throw new Error()
      return value
    } catch (error) {
      if (error instanceof Error && error.message === 'SECURE_STORAGE_UNAVAILABLE') throw error
      throw new Error('REAUTH_REQUIRED')
    }
  }

  saveCredentials(credentials: GitHubCredentials): void {
    this.requireProtection()
    this.atomicWrite(this.credentialsPath(), this.protection.encryptString(JSON.stringify(credentials)))
  }

  clearCredentials(): void {
    rmSync(this.credentialsPath(), { force: true })
  }

  loadMetadata(): GitHubConnectionMetadata {
    try {
      const value = JSON.parse(readFileSync(this.metadataPath(), 'utf8')) as GitHubConnectionMetadata
      return { ...value, user: value.user ?? null }
    } catch { return { user: null } }
  }

  saveMetadata(metadata: GitHubConnectionMetadata): void {
    this.atomicWrite(this.metadataPath(), Buffer.from(JSON.stringify(metadata, null, 2), 'utf8'))
  }

  clearMetadata(): void {
    rmSync(this.metadataPath(), { force: true })
  }

  private requireProtection(): void {
    if (!this.protection.isEncryptionAvailable() || this.protection.getSelectedStorageBackend?.() === 'basic_text') {
      throw new Error('SECURE_STORAGE_UNAVAILABLE')
    }
  }

  private credentialsPath(): string { return join(this.directory, 'credentials.bin') }
  private metadataPath(): string { return join(this.directory, 'metadata.json') }

  private atomicWrite(destination: string, content: Buffer): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const temporary = `${destination}.${randomBytes(8).toString('hex')}.tmp`
    try {
      writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 })
      renameSync(temporary, destination)
    } finally {
      rmSync(temporary, { force: true })
    }
  }
}
