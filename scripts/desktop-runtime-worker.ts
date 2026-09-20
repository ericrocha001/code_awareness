import { app, safeStorage } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertCanonicalDesktopProfile, canonicalDesktopProfile, DESKTOP_APP_NAME } from '../src/main/desktop-profile'
import { InstallationIdentityService } from '../src/main/installation/installation-identity-service'
import { installationId } from '../src/shared/distribution/relay-protocol'

function finish(result: unknown) {
  process.send?.(result, () => app.exit(0))
}

process.once('message', async (input: { mode: string; appData?: string; wrongProfile?: boolean; credential?: string }) => {
  try {
    if (input.mode === 'resolve') { finish(canonicalDesktopProfile(app.getPath('appData'))); return }
    if (!input.appData) throw new Error('PROFILE_REQUIRED')
    app.setPath('appData', input.appData)
    app.setName(input.wrongProfile ? 'Electron' : DESKTOP_APP_NAME)
    app.setPath('userData', join(input.appData, app.getName()))
    const profile = assertCanonicalDesktopProfile(app)
    await app.whenReady()
    const checks: Record<string, string> = { Profile: 'PASS' }
    let enabled: boolean | undefined, transport: string | undefined, id: string | undefined
    try {
      if (!existsSync(profile.settingsPath)) throw new Error('SETTINGS_NOT_FOUND')
      const settings = JSON.parse(readFileSync(profile.settingsPath, 'utf8'))
      if (typeof settings.remoteAccessEnabled !== 'boolean') throw new Error('SETTINGS_INVALID')
      if (!['relay', 'ngrok'].includes(settings.transportKind)) throw new Error('INVALID_TRANSPORT_KIND')
      enabled = settings.remoteAccessEnabled; transport = settings.transportKind; checks.Settings = 'PASS'
    } catch (error) {
      const code = error instanceof Error ? error.message : ''
      checks.Settings = ['SETTINGS_NOT_FOUND', 'SETTINGS_INVALID', 'INVALID_TRANSPORT_KIND'].includes(code) ? code : 'SETTINGS_INVALID'
    }
    try { id = installationId(JSON.parse(readFileSync(join(profile.installationPath, 'installation.json'), 'utf8')).id); checks.Installation = 'PASS' }
    catch { checks.Installation = 'INSTALLATION_ID_UNAVAILABLE' }
    checks.safeStorage = safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== 'basic_text' ? 'PASS' : 'SECURE_STORAGE_UNAVAILABLE'
    const service = new InstallationIdentityService(profile.installationPath, safeStorage)
    let credential: string | null = null
    if (input.mode === 'write') {
      if (Object.values(checks).some((value) => value !== 'PASS')) throw new Error('MIGRATION_PRECONDITION_FAILED')
      if (!input.credential) throw new Error('CREDENTIAL_REQUIRED')
      service.rotateCredential(input.credential)
    }
    const credentialFile = join(profile.installationPath, 'installation.credential')
    if (!existsSync(credentialFile)) checks.Credential = 'CREDENTIAL_NOT_FOUND'
    else if (!id || checks.safeStorage !== 'PASS') checks.Credential = 'CREDENTIAL_VALIDATION_BLOCKED'
    else {
      try { credential = service.getCredential(); checks.Credential = credential ? 'PASS' : 'CREDENTIAL_NOT_FOUND' }
      catch { checks.Credential = 'CREDENTIAL_NOT_DECRYPTABLE' }
    }
    const healthy = Object.values(checks).every((value) => value === 'PASS')
    finish({ checks, enabled, transport, id: id ? `${id.slice(0, 4)}...${id.slice(-4)}` : undefined, healthy,
      ...(input.mode === 'read' && healthy ? { credential } : {}) })
  } catch (error) {
    const value = error as { code?: string; stage?: string; expected?: unknown; actual?: unknown }
    finish({ healthy: false, code: value.code || 'HARNESS_OPERATION_FAILED', stage: value.stage || 'runtime', expected: value.expected, actual: value.actual })
  }
})
