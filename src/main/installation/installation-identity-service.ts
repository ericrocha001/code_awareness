import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { installationId, newInstallationId, type InstallationId } from '../../shared/distribution/relay-protocol'

export interface InstallationSecretProtection {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
  getSelectedStorageBackend?(): string
}

export class InstallationIdentityService {
  constructor(private readonly directory: string, private readonly protection: InstallationSecretProtection) {}

  getId(): InstallationId {
    const file = join(this.directory, 'installation.json')
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 })
      if (!existsSync(file)) {
        try { writeFileSync(file, JSON.stringify({ id: newInstallationId() }), { flag: 'wx', mode: 0o600 }) } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        }
      }
      return installationId(JSON.parse(readFileSync(file, 'utf8')).id)
    } catch { throw new Error('INSTALLATION_ID_UNAVAILABLE') }
  }

  getCredential(): string | null {
    const file = join(this.directory, 'installation.credential')
    if (!existsSync(file)) return null
    this.requireProtection()
    try {
      const stored = JSON.parse(this.protection.decryptString(readFileSync(file)))
      if (stored.id !== this.getId() || typeof stored.credential !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(stored.credential)) throw new Error()
      return stored.credential
    } catch { throw new Error('INSTALLATION_CREDENTIAL_UNAVAILABLE') }
  }

  rotateCredential(credential: string = randomBytes(32).toString('base64url')): void {
    this.requireProtection()
    if (!/^[A-Za-z0-9_-]{43}$/.test(credential)) throw new Error('INSTALLATION_CREDENTIAL_INVALID')
    const id = this.getId()
    const destination = join(this.directory, 'installation.credential')
    const temporary = `${destination}.${randomBytes(8).toString('hex')}.tmp`
    try {
      const encrypted = this.protection.encryptString(JSON.stringify({ id, credential }))
      writeFileSync(temporary, encrypted, { flag: 'wx', mode: 0o600 })
      renameSync(temporary, destination)
    } catch { throw new Error('INSTALLATION_CREDENTIAL_UNAVAILABLE') } finally {
      rmSync(temporary, { force: true })
    }
  }

  clearCredential(): void {
    try { rmSync(join(this.directory, 'installation.credential'), { force: true }) } catch { throw new Error('INSTALLATION_CREDENTIAL_UNAVAILABLE') }
  }

  private requireProtection(): void {
    if (!this.protection.isEncryptionAvailable() || this.protection.getSelectedStorageBackend?.() === 'basic_text') throw new Error('SECURE_STORAGE_UNAVAILABLE')
  }
}
