import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InstallationIdentityService, type InstallationSecretProtection } from './installation-identity-service'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
function directory() { const path = mkdtempSync(join(tmpdir(), 'installation-identity-')); directories.push(path); return path }
function protection(): InstallationSecretProtection {
  const values = new Map<string, string>()
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => { const token = crypto.randomUUID(); values.set(token, value); return Buffer.from(token) },
    decryptString: (value) => values.get(value.toString())!
  }
}

describe('installation identity', () => {
  it('persists a random public identity independently from protected credential, restart and rotation', () => {
    const path = directory(), secure = protection()
    const identity = new InstallationIdentityService(path, secure)
    const id = identity.getId()
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(identity.getCredential()).toBeNull()
    identity.rotateCredential()
    const original = identity.getCredential()!
    const restarted = new InstallationIdentityService(path, secure)
    expect(restarted.getId()).toBe(id)
    expect(restarted.getCredential()).toBe(original)
    expect(readFileSync(join(path, 'installation.json'), 'utf8')).toBe(JSON.stringify({ id }))
    expect(readFileSync(join(path, 'installation.credential'), 'utf8')).not.toContain(original)
    restarted.rotateCredential()
    expect(restarted.getCredential()).not.toBe(original)
    restarted.clearCredential()
    expect(identity.getCredential()).toBeNull()
    expect(identity.getId()).toBe(id)
  })
  it('fails closed for unavailable or plaintext secret storage', () => {
    for (const secure of [{ ...protection(), isEncryptionAvailable: () => false }, { ...protection(), getSelectedStorageBackend: () => 'basic_text' }]) {
      const identity = new InstallationIdentityService(directory(), secure)
      expect(() => identity.rotateCredential()).toThrow('SECURE_STORAGE_UNAVAILABLE')
    }
  })
  it('does not replace corrupted identities or leak protector errors', () => {
    const path = directory(), secure = protection()
    const identity = new InstallationIdentityService(path, secure)
    identity.getId()
    secure.encryptString = vi.fn(() => { throw new Error('secret-content') })
    expect(() => identity.rotateCredential()).toThrow('INSTALLATION_CREDENTIAL_UNAVAILABLE')
    writeFileSync(join(path, 'installation.json'), 'broken')
    expect(() => identity.getId()).toThrow('INSTALLATION_ID_UNAVAILABLE')
    expect(readFileSync(join(path, 'installation.json'), 'utf8')).toBe('broken')
  })
})
