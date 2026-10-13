import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalChannelHost } from './local-channel-host'
import { localChannelStartupDiagnostic } from './startup-diagnostic'

describe('local channel startup diagnostics', () => {
  it('reports a real profile initialization failure without exposing the underlying path', async () => {
    const temporary = mkdtempSync(join(tmpdir(), 'host-profile-'))
    const profile = join(temporary, 'private-profile')
    writeFileSync(profile, 'preserved')
    const host = new LocalChannelHost([], profile)
    try {
      await expect(host.start()).rejects.toMatchObject({ stage: 'profile' })
      await host.start().catch(error => {
        const diagnostic = localChannelStartupDiagnostic(error)
        expect(diagnostic.stage).toBe('profile')
        expect(diagnostic.code).toBe('APP_UNAVAILABLE')
        expect(JSON.stringify(diagnostic)).not.toContain(profile)
      })
    } finally { host.dispose(); rmSync(temporary, { recursive: true, force: true }) }
  })
  it('projects only allowlisted fields for authorization and listener failures', () => {
    expect(localChannelStartupDiagnostic({ code: 'EPERM', stage: 'authorization', message: 'secret' })).toEqual({ code: 'APP_UNAVAILABLE', stage: 'authorization', reason: 'ACCESS_DENIED' })
    expect(localChannelStartupDiagnostic({ code: 'EADDRINUSE', stage: 'listen' }).reason).toBe('EADDRINUSE')
    expect(localChannelStartupDiagnostic(new Error('private'))).toEqual({ code: 'APP_UNAVAILABLE', stage: 'startup', reason: 'START_FAILED' })
  })
})
