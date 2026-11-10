import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeDirectoryForceSync } from './force-remove'

const cleanupRoots: Array<{ root: string; restorePaths: string[] }> = []

afterEach(() => {
  for (const item of cleanupRoots.splice(0)) {
    for (const file of item.restorePaths) {
      try { chmodSync(file, 0o600) } catch {}
    }
    try { removeDirectoryForceSync(item.root) } catch {}
  }
})

describe('removeDirectoryForceSync', () => {
  it('removes directory trees containing read-only files cleanly', () => {
    const root = mkdtempSync(join(tmpdir(), 'force-remove-'))
    cleanupRoots.push({ root, restorePaths: [] })
    const nested = join(root, '.git', 'objects', 'pack')
    mkdirSync(nested, { recursive: true })
    const readonlyFile = join(nested, 'pack-sample.idx')
    writeFileSync(readonlyFile, 'sample-object')
    chmodSync(readonlyFile, 0o444)

    removeDirectoryForceSync(root)

    expect(existsSync(root)).toBe(false)
  })

  it('unlinks nested junctions or directory symlinks without mutating permissions or deleting external targets', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'force-remove-adv-'))
    const externalDir = join(sandbox, 'external-secret')
    const targetDir = join(sandbox, 'checkout-to-remove')
    mkdirSync(externalDir, { recursive: true })
    mkdirSync(join(targetDir, '.git', 'objects'), { recursive: true })

    const externalReadonly = join(externalDir, 'immutable.txt')
    const externalWritable = join(externalDir, 'keep.txt')
    writeFileSync(externalReadonly, 'do-not-chmod-or-delete')
    writeFileSync(externalWritable, 'must-remain-intact')
    chmodSync(externalReadonly, 0o444)
    cleanupRoots.push({ root: sandbox, restorePaths: [externalReadonly] })

    const internalReadonly = join(targetDir, '.git', 'objects', 'obj-01')
    writeFileSync(internalReadonly, 'git-object')
    chmodSync(internalReadonly, 0o444)

    const readonlyModeBefore = statSync(externalReadonly).mode & 0o777
    const linkType = process.platform === 'win32' ? 'junction' : 'dir'
    const nestedLink = join(targetDir, 'external-link')
    symlinkSync(externalDir, nestedLink, linkType)
    expect(lstatSync(nestedLink).isSymbolicLink()).toBe(true)

    removeDirectoryForceSync(targetDir)

    expect(existsSync(targetDir)).toBe(false)
    expect(existsSync(nestedLink)).toBe(false)
    expect(existsSync(externalDir)).toBe(true)
    expect(readFileSync(externalReadonly, 'utf8')).toBe('do-not-chmod-or-delete')
    expect(readFileSync(externalWritable, 'utf8')).toBe('must-remain-intact')
    expect(statSync(externalReadonly).mode & 0o777).toBe(readonlyModeBefore)
  })

  it('unlinks a root junction or symlink directly without touching its external target', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'force-remove-rootlink-'))
    const externalDir = join(sandbox, 'external-root-target')
    mkdirSync(externalDir, { recursive: true })
    const externalReadonly = join(externalDir, 'guarded.txt')
    writeFileSync(externalReadonly, 'intact')
    chmodSync(externalReadonly, 0o444)
    cleanupRoots.push({ root: sandbox, restorePaths: [externalReadonly] })

    const modeBefore = statSync(externalReadonly).mode & 0o777
    const linkType = process.platform === 'win32' ? 'junction' : 'dir'
    const rootLink = join(sandbox, 'root-junction')
    symlinkSync(externalDir, rootLink, linkType)

    removeDirectoryForceSync(rootLink)

    expect(lstatSync.bind(null, rootLink)).toThrow()
    expect(existsSync(externalDir)).toBe(true)
    expect(readFileSync(externalReadonly, 'utf8')).toBe('intact')
    expect(statSync(externalReadonly).mode & 0o777).toBe(modeBefore)
  })

  it('removes dangling junctions or symlinks without failing on missing targets', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'force-remove-dangling-'))
    const missingTarget = join(sandbox, 'ephemeral-target')
    const targetDir = join(sandbox, 'tree')
    mkdirSync(missingTarget, { recursive: true })
    mkdirSync(targetDir, { recursive: true })
    cleanupRoots.push({ root: sandbox, restorePaths: [] })

    const linkType = process.platform === 'win32' ? 'junction' : 'dir'
    const danglingLink = join(targetDir, 'dangling-link')
    symlinkSync(missingTarget, danglingLink, linkType)
    removeDirectoryForceSync(missingTarget)

    removeDirectoryForceSync(targetDir)

    expect(existsSync(targetDir)).toBe(false)
    expect(lstatSync.bind(null, danglingLink)).toThrow()
  })
})
