import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { removeDirectoryForceSync } from './force-remove'

describe('removeDirectoryForceSync', () => {
  it('removes directory trees containing read-only files cleanly', () => {
    const root = mkdtempSync(join(tmpdir(), 'force-remove-'))
    const nested = join(root, '.git', 'objects', 'pack')
    mkdirSync(nested, { recursive: true })
    const readonlyFile = join(nested, 'pack-sample.idx')
    writeFileSync(readonlyFile, 'sample-object')
    chmodSync(readonlyFile, 0o444)

    removeDirectoryForceSync(root)

    expect(existsSync(root)).toBe(false)
  })
})
