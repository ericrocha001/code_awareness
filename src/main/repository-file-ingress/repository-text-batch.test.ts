import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { RepositoryFileEditing, RepositoryFileEditingError } from './repository-file-editing'

let root: string
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const intent = { description: 'Coordinated multi-file source batch' }
const firstInitial = '\ufeff// Header\r\nconst msg = "ação 😀"\r\nconst second = "unchanged"\r\n'
const secondInitial = 'export const a = 1\nexport const b = 2' // LF, no trailing newline

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'repository-batch-'))
  await mkdir(path.join(root, 'src'))
  await writeFile(path.join(root, 'src/first.ts'), firstInitial)
  await writeFile(path.join(root, 'src/second.ts'), secondInitial)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('coordinated text batch editing', () => {
  it('applies multiple edits and exclusive creation while preserving CRLF, BOM, Unicode and trailing newline absence', async () => {
    const editor = new RepositoryFileEditing(root, { isActive: () => true })
    const result = await editor.applyTextBatch([
      {
        operation: 'EDIT',
        path: './src/first.ts',
        expectedSha256: sha(firstInitial),
        replacements: [
          { oldText: 'ação 😀', newText: 'edição ✅' },
          { oldText: '// Header', newText: '// Updated Header' }
        ]
      },
      {
        operation: 'EDIT',
        path: 'src/second.ts',
        expectedSha256: sha(secondInitial),
        replacements: [
          { oldText: 'a = 1', newText: 'a = 10' },
          { oldText: 'b = 2', newText: 'b = 20' }
        ]
      },
      {
        operation: 'CREATE',
        path: 'src/created.ts',
        text: 'export const created = "novo 🚀"\n'
      }
    ], intent)

    expect(result.state).toBe('APPLIED')
    const expectedFirst = '\ufeff// Updated Header\r\nconst msg = "edição ✅"\r\nconst second = "unchanged"\r\n'
    const expectedSecond = 'export const a = 10\nexport const b = 20'
    const expectedCreated = 'export const created = "novo 🚀"\n'
    expect(readFileSync(path.join(root, 'src/first.ts'), 'utf8')).toBe(expectedFirst)
    expect(readFileSync(path.join(root, 'src/second.ts'), 'utf8')).toBe(expectedSecond)
    expect(readFileSync(path.join(root, 'src/created.ts'), 'utf8')).toBe(expectedCreated)
    expect(result.files).toEqual([
      { path: 'src/first.ts', operation: 'EDIT', beforeSha256: sha(firstInitial), afterSha256: sha(expectedFirst), size: Buffer.byteLength(expectedFirst), changed: true, state: 'CONFIRMED' },
      { path: 'src/second.ts', operation: 'EDIT', beforeSha256: sha(secondInitial), afterSha256: sha(expectedSecond), size: Buffer.byteLength(expectedSecond), changed: true, state: 'CONFIRMED' },
      { path: 'src/created.ts', operation: 'CREATE', beforeSha256: null, afterSha256: sha(expectedCreated), size: Buffer.byteLength(expectedCreated), changed: true, state: 'CONFIRMED' }
    ])
    expect(result.previews).toHaveLength(3)
    expect((await readdir(path.join(root, 'src'))).some(name => name.startsWith('.repository-'))).toBe(false)
  }, 60_000)

  it('returns explicit NO_CHANGE without touching disk when replacements produce identical bytes', async () => {
    const editor = new RepositoryFileEditing(root, { isActive: () => true, commit: () => { throw new Error('must not commit') } })
    const result = await editor.applyTextBatch([
      { operation: 'EDIT', path: 'src/first.ts', expectedSha256: sha(firstInitial), replacements: [{ oldText: 'ação 😀', newText: 'ação 😀' }] }
    ], intent)
    expect(result).toEqual({
      state: 'NO_CHANGE',
      files: [{ path: 'src/first.ts', operation: 'EDIT', beforeSha256: sha(firstInitial), afterSha256: sha(firstInitial), size: Buffer.byteLength(firstInitial), changed: false, state: 'NO_CHANGE' }],
      previews: []
    })
  }, 60_000)

  it('rejects preflight failures (existing create target, stale hash, ambiguous patch, protected path, duplicate path) with zero writes', async () => {
    const editor = new RepositoryFileEditing(root, { isActive: () => true })
    await writeFile(path.join(root, 'AGENTS.md'), 'kernel')
    await writeFile(path.join(root, '.env'), 'SECRET=1')

    const cases: Array<{ changes: Parameters<RepositoryFileEditing['applyTextBatch']>[0]; expectedCode: string }> = [
      {
        changes: [
          { operation: 'EDIT', path: 'src/first.ts', expectedSha256: sha(firstInitial), replacements: [{ oldText: 'ação 😀', newText: 'changed' }] },
          { operation: 'CREATE', path: 'src/second.ts', text: 'overwrite' }
        ],
        expectedCode: 'FILE_ALREADY_EXISTS'
      },
      {
        changes: [
          { operation: 'EDIT', path: 'src/first.ts', expectedSha256: sha(firstInitial), replacements: [{ oldText: 'ação 😀', newText: 'changed' }] },
          { operation: 'EDIT', path: 'src/second.ts', expectedSha256: '0'.repeat(64), replacements: [{ oldText: 'a = 1', newText: 'a = 2' }] },
          { operation: 'CREATE', path: 'src/never.ts', text: 'never' }
        ],
        expectedCode: 'FILE_REVISION_CONFLICT'
      },
      {
        changes: [
          { operation: 'EDIT', path: 'src/first.ts', expectedSha256: sha(firstInitial), replacements: [{ oldText: 'ação 😀', newText: 'changed' }] },
          { operation: 'EDIT', path: 'src/second.ts', expectedSha256: sha(secondInitial), replacements: [{ oldText: 'export const', newText: 'x' }] }
        ],
        expectedCode: 'PATCH_AMBIGUOUS'
      },
      {
        changes: [
          { operation: 'EDIT', path: 'src/first.ts', expectedSha256: sha(firstInitial), replacements: [{ oldText: 'ação 😀', newText: 'changed' }] },
          { operation: 'CREATE', path: '.env.local', text: 'KEY=2' }
        ],
        expectedCode: 'PROTECTED_PATH'
      },
      {
        changes: [
          { operation: 'EDIT', path: 'src/first.ts', expectedSha256: sha(firstInitial), replacements: [{ oldText: 'ação 😀', newText: 'changed' }] },
          { operation: 'EDIT', path: 'AGENTS.md', expectedSha256: sha('kernel'), replacements: [{ oldText: 'kernel', newText: 'hacked' }] }
        ],
        expectedCode: 'PROTECTED_PATH'
      },
      {
        changes: [
          { operation: 'EDIT', path: 'src/first.ts', expectedSha256: sha(firstInitial), replacements: [{ oldText: 'ação 😀', newText: 'changed' }] },
          { operation: 'EDIT', path: 'src/FIRST.ts', expectedSha256: sha(firstInitial), replacements: [{ oldText: 'Header', newText: 'H' }] }
        ],
        expectedCode: process.platform === 'win32' ? 'INVALID_ARGUMENT' : 'FILE_NOT_FOUND'
      }
    ]

    for (const testCase of cases) {
      const result = await editor.applyTextBatch(testCase.changes, { description: 'negative', explicitUserAuthorization: true } as any)
      expect(result.state).toBe('REJECTED')
      expect(result.code).toBe(testCase.expectedCode)
      expect(result.files[0].state).toBe('NOT_STARTED')
      expect(result.files[1].state).toBe('REJECTED')
      expect(result.files[1].code).toBe(testCase.expectedCode)
      expect(readFileSync(path.join(root, 'src/first.ts'), 'utf8')).toBe(firstInitial)
      expect(readFileSync(path.join(root, 'src/second.ts'), 'utf8')).toBe(secondInitial)
      expect(readFileSync(path.join(root, 'AGENTS.md'), 'utf8')).toBe('kernel')
      expect(existsSync(path.join(root, 'src/never.ts'))).toBe(false)
      expect(existsSync(path.join(root, '.env.local'))).toBe(false)
    }
  }, 60_000)

  it('reports PARTIAL without rollback when an error occurs after the first committed file', async () => {
    const editor = new RepositoryFileEditing(root, { isActive: () => true })
    const result = await editor.applyTextBatch([
      { operation: 'EDIT', path: 'src/first.ts', expectedSha256: sha(firstInitial), replacements: [{ oldText: 'ação 😀', newText: 'step-1' }] },
      { operation: 'EDIT', path: 'src/second.ts', expectedSha256: sha(secondInitial), replacements: [{ oldText: 'a = 1', newText: 'a = 99' }] },
      { operation: 'CREATE', path: 'src/third.ts', text: 'never' }
    ], intent, async index => {
      if (index === 1) throw new Error('GIT_STATE_CHANGED')
    })

    expect(result.state).toBe('PARTIAL')
    expect(result.code).toBe('EDIT_PARTIAL')
    expect(result.files[0]).toMatchObject({ path: 'src/first.ts', state: 'CONFIRMED', changed: true })
    expect(result.files[1]).toMatchObject({ path: 'src/second.ts', state: 'CONFLICT', code: 'GIT_STATE_CHANGED' })
    expect(result.files[2]).toMatchObject({ path: 'src/third.ts', state: 'NOT_STARTED' })
    expect(readFileSync(path.join(root, 'src/first.ts'), 'utf8')).toContain('step-1')
    expect(readFileSync(path.join(root, 'src/second.ts'), 'utf8')).toBe(secondInitial)
    expect(existsSync(path.join(root, 'src/third.ts'))).toBe(false)
  }, 60_000)

  it('reports PARTIAL on clean commit failure and UNKNOWN when outcome cannot be reconciled after the first file', async () => {
    let calls = 0
    const editor = new RepositoryFileEditing(root, {
      isActive: () => true,
      commit: (temp, dest) => {
        calls++
        if (calls === 1 || calls === 3) {
          writeFileSync(dest, readFileSync(temp))
          return
        }
        if (calls === 2) throw new Error('clean disk failure')
        writeFileSync(dest, 'external')
        throw new RepositoryFileEditingError('WRITE_OUTCOME_UNKNOWN')
      }
    })
    const partial = await editor.applyTextBatch([
      { operation: 'EDIT', path: 'src/first.ts', expectedSha256: sha(firstInitial), replacements: [{ oldText: 'ação 😀', newText: 'step-1' }] },
      { operation: 'EDIT', path: 'src/second.ts', expectedSha256: sha(secondInitial), replacements: [{ oldText: 'a = 1', newText: 'a = 99' }] }
    ], intent)

    expect(partial.state).toBe('PARTIAL')
    expect(partial.code).toBe('EDIT_PARTIAL')
    expect(partial.files[0].state).toBe('CONFIRMED')
    expect(partial.files[1]).toMatchObject({ state: 'CONFLICT', code: 'WRITE_FAILED' })
    expect(readFileSync(path.join(root, 'src/first.ts'), 'utf8')).toContain('step-1')
    expect(readFileSync(path.join(root, 'src/second.ts'), 'utf8')).toBe(secondInitial)

    const currentFirst = readFileSync(path.join(root, 'src/first.ts'), 'utf8')
    calls = 2
    const unknown = await editor.applyTextBatch([
      { operation: 'EDIT', path: 'src/first.ts', expectedSha256: sha(currentFirst), replacements: [{ oldText: 'step-1', newText: 'step-2' }] },
      { operation: 'EDIT', path: 'src/second.ts', expectedSha256: sha(secondInitial), replacements: [{ oldText: 'a = 1', newText: 'a = 99' }] }
    ], intent)
    expect(unknown.state).toBe('UNKNOWN')
    expect(unknown.code).toBe('EDIT_OUTCOME_UNKNOWN')
    expect(unknown.files[0].state).toBe('CONFIRMED')
    expect(unknown.files[1]).toMatchObject({ state: 'UNKNOWN', code: 'WRITE_OUTCOME_UNKNOWN' })
    expect(readFileSync(path.join(root, 'src/second.ts'), 'utf8')).toBe('external')
  }, 60_000)

  it('refuses creation collision without overwriting external file and blocks symlinked parents', async () => {
    const editor = new RepositoryFileEditing(root, { isActive: () => true })
    const race = await editor.applyTextBatch([
      { operation: 'CREATE', path: 'src/raced.ts', text: 'ours' }
    ], intent, async () => {
      writeFileSync(path.join(root, 'src/raced.ts'), 'external-winner')
    })
    expect(race.state).toBe('REJECTED')
    expect(race.code).toBe('FILE_ALREADY_EXISTS')
    expect(race.files[0]).toMatchObject({ state: 'CONFLICT', code: 'FILE_ALREADY_EXISTS' })
    expect(readFileSync(path.join(root, 'src/raced.ts'), 'utf8')).toBe('external-winner')

    await mkdir(path.join(root, 'real-dir'))
    await symlink(path.join(root, 'real-dir'), path.join(root, 'link-dir'), process.platform === 'win32' ? 'junction' : 'dir')
    const linkCreate = await editor.applyTextBatch([
      { operation: 'CREATE', path: 'link-dir/file.ts', text: 'escaped' }
    ], intent)
    expect(linkCreate.state).toBe('REJECTED')
    expect(linkCreate.code).toBe('INVALID_PATH')
    expect(existsSync(path.join(root, 'real-dir/file.ts'))).toBe(false)
    expect((await readdir(path.join(root, 'src'))).some(name => name.startsWith('.repository-'))).toBe(false)
  }, 60_000)
})
