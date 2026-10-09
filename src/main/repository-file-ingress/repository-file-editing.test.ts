import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { RepositoryFileEditing, RepositoryFileEditingError } from './repository-file-editing'
import { RepositoryFileIngress } from './repository-file-ingress'
import { executeRepositoryFileEditing } from './repository-file-editing-mcp'

let root: string
const original = '\ufeff# Rules\r\nUm: ação 😀\r\nDois: revisão\r\nTrês: fim\r\n'
const intent = { description: 'Update three explicitly selected regions' }
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'repository-edit-')); await writeFile(path.join(root, 'rules.md'), original) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
const service = () => new RepositoryFileEditing(root, { isActive: () => true })

describe('literal inspection', () => {
  it('hashes literal bytes, excludes content by default and preserves BOM/Unicode/CRLF on demand', async () => {
    expect(await service().inspectFile('./rules.md')).toEqual({ path: 'rules.md', size: Buffer.byteLength(original), sha256: sha(original) })
    expect((await service().inspectFile('rules.md', true)).text).toBe(original)
  })
  it.each(['../escape', 'C:relative', 'NUL', 'rules.md/', 'a:b'])('rejects invalid path %s', async value => {
    await expect(service().inspectFile(value)).rejects.toMatchObject({ code: 'INVALID_PATH' })
  })
  it.each(['.git/config', '.skills/s/SKILL.md', '.codex/settings.json', 'code_awareness/repository_model.db', '.env.local', 'secrets.json'])('refuses managed or secret path %s', async value => {
    await expect(service().inspectFile(value)).rejects.toMatchObject({ code: 'PROTECTED_PATH' })
  })
  it('refuses missing files, directories, junctions and invalid UTF-8; detects inactive context', async () => {
    await mkdir(path.join(root, 'directory'))
    await symlink(path.join(root, 'directory'), path.join(root, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir')
    await writeFile(path.join(root, 'binary'), Buffer.from([255, 0]))
    await expect(service().inspectFile('missing')).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' })
    await expect(service().inspectFile('directory')).rejects.toMatchObject({ code: 'INVALID_PATH' })
    await expect(service().inspectFile('redirect/a')).rejects.toMatchObject({ code: 'INVALID_PATH' })
    await expect(service().inspectFile('binary', true)).rejects.toMatchObject({ code: 'INVALID_UTF8' })
    await expect(new RepositoryFileEditing(root, { isActive: () => false }).inspectFile('rules.md')).rejects.toMatchObject({ code: 'REPOSITORY_CONTEXT_CHANGED' })
  })
})

describe('guarded mutations', () => {
  it('treats Unicode and PowerShell metacharacters in paths as literal data', async () => {
    const filename = 'ação $x `tick.md'
    await writeFile(path.join(root, filename), original)
    expect((await service().replaceFile(filename, sha(original), { text: 'literal' }, intent)).path).toBe(filename)
    expect(await readFile(path.join(root, filename), 'utf8')).toBe('literal')
  })
  it.each([null, [], { destinationPath: 'rules.md', text: 'unsafe' }, { destinationPath: 'rules.md', expectedSha256: sha(original), text: 'unsafe', intent, force: true }, { destinationPath: 'rules.md', expectedSha256: sha(original), text: 'unsafe', intent: { ...intent, explicitUserAuthorization: 'yes' } }])('rejects invalid public arguments %j', async args => {
    expect((await executeRepositoryFileEditing(service(), 'replace_repository_file', args)).isError).toBe(true)
    expect(await readFile(path.join(root, 'rules.md'), 'utf8')).toBe(original)
  })
  it('rejects stale bytes introduced during a host download even with the context still active', async () => {
    const ingress = new RepositoryFileIngress(root, { fetch: vi.fn(async () => { await writeFile(path.join(root, 'rules.md'), 'external'); return new Response('replacement') }) as typeof fetch })
    await expect(new RepositoryFileEditing(root, { isActive: () => true, ingress }).replaceFile('rules.md', sha(original), { file: { file_id: 'host', download_url: 'https://files.example/file' } }, intent)).rejects.toMatchObject({ code: 'FILE_REVISION_CONFLICT' })
    expect(await readFile(path.join(root, 'rules.md'), 'utf8')).toBe('external')
    expect(await readdir(root)).toEqual(['rules.md'])
  })
  it('returns confirmed unchanged receipts without invoking the publisher', async () => {
    const commit = vi.fn()
    const editor = new RepositoryFileEditing(root, { isActive: () => true, commit })
    expect(await editor.replaceFile('rules.md', sha(original), { text: original }, intent)).toMatchObject({ changed: false, state: 'CONFIRMED', afterSha256: sha(original) })
    expect(commit).not.toHaveBeenCalled()
  })
  it('refuses excessive text, malformed source selection, missing destination and duplicate patches', async () => {
    await expect(service().replaceFile('rules.md', sha(original), { text: 'x'.repeat(1024 * 1024 + 1) }, intent)).rejects.toMatchObject({ code: 'REQUEST_TOO_LARGE' })
    await expect(service().replaceFile('rules.md', sha(original), {}, intent)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(service().replaceFile('missing', sha(original), { text: 'next' }, intent)).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' })
    await expect(service().editText('rules.md', sha(original), Array(2).fill({ oldText: 'ação', newText: 'x' }), intent)).rejects.toMatchObject({ code: 'PATCH_AMBIGUOUS' })
    expect(await readFile(path.join(root, 'rules.md'), 'utf8')).toBe(original)
  })
  it.each(['truncated', 'timeout', 'oversize'])('preserves original and removes upload/temp after %s streaming', async failure => {
    const download = vi.fn(async () => failure === 'truncated' ? new Response('short', { headers: { 'content-length': '100' } }) : new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array(failure === 'oversize' ? 32 * 1024 * 1024 + 1 : 1))
      if (failure === 'oversize') controller.close()
    } }))) as typeof fetch
    const ingress = new RepositoryFileIngress(root, { fetch: download, timeoutMs: 100 })
    const editor = new RepositoryFileEditing(root, { isActive: () => true, ingress })
    await expect(editor.replaceFile('rules.md', sha(original), { file: { file_id: 'host', download_url: 'https://files.example/file' } }, intent)).rejects.toMatchObject({ code: failure === 'truncated' ? 'DOWNLOAD_FAILED' : failure === 'timeout' ? 'REQUEST_TIMEOUT' : 'REQUEST_TOO_LARGE' })
    expect(await readFile(path.join(root, 'rules.md'), 'utf8')).toBe(original)
    expect(await readdir(root)).toEqual(['rules.md'])
  })
  it('edits three disjoint regions and reconstructs original by reversing only those edits', async () => {
    const patches = [{ oldText: 'ação 😀', newText: 'autorização 🧭' }, { oldText: 'revisão', newText: 'hash' }, { oldText: 'fim', newText: 'final' }]
    const editor = service()
    const receipt = await editor.editText('rules.md', sha(original), patches, intent)
    const final = await readFile(path.join(root, 'rules.md'))
    expect(receipt).toMatchObject({ operation: 'EDIT', beforeSha256: sha(original), afterSha256: sha(final), size: final.length, changed: true, state: 'CONFIRMED' })
    let reconstructed = final.toString('utf8')
    for (const patch of patches) reconstructed = reconstructed.replace(patch.newText, patch.oldText)
    expect(Buffer.from(reconstructed)).toEqual(Buffer.from(original))
    expect(await readdir(root)).toEqual(['rules.md'])
  })
  it.each([{ patches: [{ oldText: 'absent', newText: 'x' }] }, { patches: [{ oldText: '\r\n', newText: 'x' }] }, { patches: [{ oldText: 'revisão', newText: 'x' }, { oldText: 'visão', newText: 'y' }] }])('rejects missing, repeated and overlapping anchors without writing', async ({ patches }) => {
    await expect(service().editText('rules.md', sha(original), patches, intent)).rejects.toMatchObject({ code: 'PATCH_AMBIGUOUS' })
    expect(await readFile(path.join(root, 'rules.md'), 'utf8')).toBe(original)
  })
  it('refuses stale revisions and gives only one cooperative writer a winning receipt', async () => {
    const editor = service()
    const results = await Promise.allSettled(['A', 'B'].map(text => editor.replaceFile('rules.md', sha(original), { text }, intent)))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const failed = results.find(result => result.status === 'rejected') as PromiseRejectedResult
    expect(failed.reason.code).toBe('FILE_REVISION_CONFLICT')
    await expect(editor.replaceFile('rules.md', '', { text: 'unsafe' }, intent)).rejects.toMatchObject({ code: 'FILE_REVISION_CONFLICT' })
  })
  it('protects fictional agent kernels unless this change has explicit human authorization', async () => {
    await writeFile(path.join(root, 'AGENTS.md'), original)
    await expect(service().replaceFile('AGENTS.md', sha(original), { text: 'authorized' }, intent)).rejects.toMatchObject({ code: 'PROTECTED_PATH' })
    expect((await service().replaceFile('AGENTS.md', sha(original), { text: 'authorized' }, { ...intent, explicitUserAuthorization: true })).state).toBe('CONFIRMED')
  })
  it('leaves original intact and removes temp after a failed commit; reconciles a lost success response', async () => {
    const failing = new RepositoryFileEditing(root, { isActive: () => true, commit: () => { throw new Error('disk failure') } })
    await expect(failing.replaceFile('rules.md', sha(original), { text: 'next' }, intent)).rejects.toMatchObject({ code: 'WRITE_FAILED' })
    expect(await readFile(path.join(root, 'rules.md'), 'utf8')).toBe(original)
    expect(await readdir(root)).toEqual(['rules.md'])
    const lost = new RepositoryFileEditing(root, { isActive: () => true, commit: (temp, destination) => { renameSync(temp, destination); throw new Error('lost completion') } })
    expect((await lost.replaceFile('rules.md', sha(original), { text: 'next' }, intent)).state).toBe('CONFIRMED')
  })
  it('reports unknown external outcome without retrying or restoring over the external writer', async () => {
    const editor = new RepositoryFileEditing(root, { isActive: () => true, commit: (_temp, destination) => { writeFileSync(destination, 'external'); throw new RepositoryFileEditingError('WRITE_OUTCOME_UNKNOWN') } })
    await expect(editor.replaceFile('rules.md', sha(original), { text: 'next' }, intent)).rejects.toMatchObject({ code: 'WRITE_OUTCOME_UNKNOWN' })
    expect(readFileSync(path.join(root, 'rules.md'), 'utf8')).toBe('external')
  })
  it('uses authorized file-param for binary replacement and refuses context/revision drift during streaming', async () => {
    const bytes = Buffer.from([0, 255, 42, 128])
    const file = { file_id: 'host-id', download_url: 'https://files.example/authorized' }
    let active = true
    let drift = false
    const ingress = new RepositoryFileIngress(root, { fetch: vi.fn(async () => {
      if (drift) { await writeFile(path.join(root, 'rules.md'), 'external'); active = false }
      return new Response(bytes)
    }) as typeof fetch })
    const editor = new RepositoryFileEditing(root, { isActive: () => active, ingress })
    const receipt = await editor.replaceFile('rules.md', sha(original), { file }, intent)
    expect(await readFile(path.join(root, 'rules.md'))).toEqual(bytes)
    expect(receipt.afterSha256).toBe(sha(bytes))
    drift = true
    await expect(editor.replaceFile('rules.md', sha(bytes), { file }, intent)).rejects.toMatchObject({ code: 'REPOSITORY_CONTEXT_CHANGED' })
    expect(await readFile(path.join(root, 'rules.md'), 'utf8')).toBe('external')
    expect(await readdir(root)).toEqual(['rules.md'])
  })
})
