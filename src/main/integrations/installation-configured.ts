import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { installationId } from '../../shared/distribution/relay-protocol'
import type { InstallationSecretProtection } from '../installation/installation-identity-service'

export function isInstallationConfigured(directory: string, protection: InstallationSecretProtection): boolean {
  try {
    const identityFile = join(directory, 'installation.json')
    if (!existsSync(identityFile) || !existsSync(join(directory, 'installation.credential'))) return false
    const id = installationId(JSON.parse(readFileSync(identityFile, 'utf8')).id)
    if (!protection.isEncryptionAvailable() || protection.getSelectedStorageBackend?.() === 'basic_text') return false
    const stored = JSON.parse(protection.decryptString(readFileSync(join(directory, 'installation.credential'))))
    return stored.id === id && typeof stored.credential === 'string' && /^[A-Za-z0-9_-]{43}$/.test(stored.credential)
  } catch { return false }
}
