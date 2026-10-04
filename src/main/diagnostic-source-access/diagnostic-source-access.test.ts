import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DiagnosticSourceAccess } from './diagnostic-source-access'

const roots: string[] = []
function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'diagnostic-source-'))
  roots.push(root)
  return root
}
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

describe('DiagnosticSourceAccess', () => {
  it('lists immediate children, reads ranges, finds literal text, and never modifies files', async () => {
    const root = temporaryRoot()
    mkdirSync(join(root, 'src'))
    const file = join(root, 'src', 'sample.ts')
    writeFileSync(file, 'one\nneedle two\nneedle three\nfour', 'utf8')
    const before = readFileSync(file)
    const access = new DiagnosticSourceAccess(root)

    expect((await access.listDirectory('.')).entries).toEqual([{ name: 'src', type: 'directory' }])
    expect(await access.readFile('src/sample.ts', 2, 3)).toMatchObject({ text: 'needle two\nneedle three', startLine: 2, endLine: 3 })
    expect(await access.findText(['src/sample.ts'], 'needle', 1)).toMatchObject({ truncated: true, matches: [{ line: 2 }] })
    expect(readFileSync(file)).toEqual(before)
  })

  it.each(['../outside.ts', 'src/../../outside.ts'])('rejects traversal %s', async (path) => {
    const root = temporaryRoot()
    await expect(new DiagnosticSourceAccess(root).readFile(path, 1, 1)).rejects.toThrow('PATH_OUTSIDE_REPOSITORY')
  })

  it('rejects symlink escapes, binary files, oversized files, and missing paths', async () => {
    const root = temporaryRoot()
    const outside = temporaryRoot()
    writeFileSync(join(outside, 'secret.txt'), 'secret', 'utf8')
    symlinkSync(outside, join(root, 'escape'), 'junction')
    writeFileSync(join(root, 'binary.bin'), Buffer.from([1, 0, 2]))
    writeFileSync(join(root, 'large.txt'), Buffer.alloc(1024 * 1024 + 1, 65))
    const access = new DiagnosticSourceAccess(root)

    await expect(access.readFile('escape/secret.txt', 1, 1)).rejects.toThrow('PATH_OUTSIDE_REPOSITORY')
    await expect(access.readFile('binary.bin', 1, 1)).rejects.toThrow('BINARY_FILE_REJECTED')
    await expect(access.readFile('large.txt', 1, 1)).rejects.toThrow('FILE_TOO_LARGE')
    await expect(access.readFile('missing.txt', 1, 1)).rejects.toThrow('PATH_NOT_FOUND')
  })

  it('operates without any CodeMap, CodeScope, readiness, or system-health dependency', async () => {
    const root = temporaryRoot()
    writeFileSync(join(root, 'source.ts'), 'export const available = true', 'utf8')
    const access = new DiagnosticSourceAccess(root)
    await expect(access.findText(['source.ts'], 'available')).resolves.toMatchObject({ matches: [{ line: 1 }] })
  })
})
