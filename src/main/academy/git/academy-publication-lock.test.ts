import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { withPublicationLock } from './academy-publication-lock'

it('excludes concurrent publication services and releases after failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'academy-publication-lock-'))
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  try {
    const first = withPublicationLock(root, () => barrier)
    await expect(withPublicationLock(root, async () => 1)).rejects.toThrow('PUBLICATION_BUSY')
    release(); await first
    await expect(withPublicationLock(root, async () => { throw new Error('interrupted') })).rejects.toThrow('interrupted')
    expect(await withPublicationLock(root, async () => 2)).toBe(2)
    writeFileSync(join(root, 'publication.lock'), JSON.stringify({ pid: 99999999 }))
    writeFileSync(join(root, 'publication.lock.recovery'), JSON.stringify({ pid: 99999999 }))
    expect(await withPublicationLock(root, async () => 3)).toBe(3)
  } finally { release(); rmSync(root, { recursive: true, force: true }) }
})
