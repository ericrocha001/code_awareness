import { expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { isInstallationConfigured } from './installation-configured'

it('checks installation without creating identity or exposing protected data', () => {
  const directory = mkdtempSync(join(tmpdir(), 'integration-state-'))
  const protection = { isEncryptionAvailable: () => true, decryptString: vi.fn((buffer: Buffer) => buffer.toString()), encryptString: vi.fn() }
  try {
    expect(isInstallationConfigured(directory, protection)).toBe(false)
    expect(readdirSync(directory)).toEqual([])
    const id = randomUUID()
    const files = { 'installation.json': JSON.stringify({ id }), 'installation.credential': JSON.stringify({ id, credential: 'x'.repeat(43) }) }
    for (const [name, value] of Object.entries(files)) writeFileSync(join(directory, name), value)
    expect(isInstallationConfigured(directory, protection)).toBe(true)
    for (const [name, value] of Object.entries(files)) expect(readFileSync(join(directory, name), 'utf8')).toBe(value)
    expect(protection.encryptString).not.toHaveBeenCalled()
    protection.decryptString.mockImplementation(() => { throw new Error('sensitive detail') })
    expect(isInstallationConfigured(directory, protection)).toBe(false)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
