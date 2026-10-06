import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { RepositoryFileIngress, REPOSITORY_FILE_MAX_BYTES } from './repository-file-ingress'

const descriptor = { download_url: 'https://files.example/secret?signature=private', file_id: 'private-id', mime_type: 'application/octet-stream', file_name: 'ignored.bin' }
const binary = Buffer.from([0, 255, 1, 2, 128, 13, 10, 0, 42])
let root: string

function downloader(bytes: Uint8Array = binary): typeof fetch {
  return vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close() } }))) as typeof fetch
}

beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'repository-file-ingress-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('RepositoryFileIngress', () => {
  it('accepts an empty binary file and a non-traversing parent beginning with two dots', async () => {
    const receipt = await new RepositoryFileIngress(root, { fetch: downloader(new Uint8Array()) }).importFile(descriptor, '..cache/empty.bin')
    expect(receipt).toEqual({ path: '..cache/empty.bin', size: 0, sha256: createHash('sha256').digest('hex') })
    expect(await readFile(path.join(root, receipt.path))).toEqual(Buffer.alloc(0))
  })

  it('streams identical bytes and returns only normalized path, size and sha256', async () => {
    const download = downloader()
    const receipt = await new RepositoryFileIngress(root, { fetch: download }).importFile(descriptor, './docs//mockups\\nova.bin')
    expect(receipt).toEqual({ path: 'docs/mockups/nova.bin', size: binary.length, sha256: createHash('sha256').update(binary).digest('hex') })
    expect(await readFile(path.join(root, receipt.path))).toEqual(binary)
    expect(await readdir(path.join(root, 'docs/mockups'))).toEqual(['nova.bin'])
    expect(download).toHaveBeenCalledWith(new URL(descriptor.download_url), { redirect: 'error', signal: expect.any(AbortSignal) })
    expect(JSON.stringify(receipt)).not.toMatch(/private|file_id|download_url|mime_type|file_name/)
  })

  it.each(['', ' ', '.', '..', '../escape.bin', 'a/../../escape.bin', '/absolute.bin', 'C:\\absolute.bin', 'C:relative.bin', '\\\\server\\share\\file', 'a/../file', 'file\0.bin', 'NUL', 'a:b', 'a./file', 'a /file', 'folder/'])('rejects unsafe destination %j before downloading', async destination => {
    const download = downloader()
    await expect(new RepositoryFileIngress(root, { fetch: download }).importFile(descriptor, destination)).rejects.toMatchObject({ code: 'INVALID_PATH' })
    expect(download).not.toHaveBeenCalled()
    expect(await readdir(root)).toEqual([])
  })

  it.each([
    { ...descriptor, download_url: 'http://files.example/private' },
    { ...descriptor, download_url: 'file:///private' },
    { ...descriptor, download_url: 'https://user:private@files.example/file' },
    { ...descriptor, file_id: '' },
    { ...descriptor, mime_type: 5 },
    { ...descriptor, url: 'https://alternative.example' },
    { download_url: descriptor.download_url }
  ])('rejects an invalid file descriptor', async file => {
    const download = downloader()
    await expect(new RepositoryFileIngress(root, { fetch: download }).importFile(file as typeof descriptor, 'new.bin')).rejects.toMatchObject({ code: 'INVALID_FILE' })
    expect(download).not.toHaveBeenCalled()
  })

  it.each([undefined, '1', String(REPOSITORY_FILE_MAX_BYTES * 2)])('enforces the streaming bound regardless of Content-Length %s', async declaredLength => {
    const chunk = new Uint8Array(64 * 1024)
    let transferred = 0
    const download = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      controller.enqueue(chunk)
      transferred += chunk.length
      if (transferred > REPOSITORY_FILE_MAX_BYTES) controller.close()
    } }), { headers: declaredLength ? { 'content-length': declaredLength } : {} })) as typeof fetch
    await expect(new RepositoryFileIngress(root, { fetch: download }).importFile(descriptor, 'oversize.bin')).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' })
    expect(await readdir(root)).toEqual([])
  })

  it('accepts exactly 32 MiB without buffering the whole transfer', async () => {
    const chunk = new Uint8Array(64 * 1024).fill(137)
    let transferred = 0
    const download = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      if (transferred === REPOSITORY_FILE_MAX_BYTES) { controller.close(); return }
      controller.enqueue(chunk)
      transferred += chunk.length
    } }))) as typeof fetch
    const expectedHash = createHash('sha256')
    for (let i = 0; i < REPOSITORY_FILE_MAX_BYTES / chunk.length; i++) expectedHash.update(chunk)
    expect(await new RepositoryFileIngress(root, { fetch: download }).importFile(descriptor, 'limit.bin')).toEqual({ path: 'limit.bin', size: REPOSITORY_FILE_MAX_BYTES, sha256: expectedHash.digest('hex') })
  })

  it.each(['fetch', 'body'])('times out a stalled %s and removes every partial file', async stage => {
    const cancel = vi.fn()
    const download = vi.fn(async () => stage === 'fetch' ? new Promise<Response>(() => {}) : new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(binary) }, cancel }))) as typeof fetch
    await expect(new RepositoryFileIngress(root, { fetch: download, timeoutMs: 100 }).importFile(descriptor, 'stalled.bin')).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' })
    expect(await readdir(root)).toEqual([])
    if (stage === 'body') expect(cancel).toHaveBeenCalled()
  })

  it('sanitizes transport and streaming failures and removes partial bytes', async () => {
    let reads = 0
    const download = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      if (reads++ === 0) controller.enqueue(binary)
      else controller.error(new Error(descriptor.download_url + descriptor.file_id))
    } }))) as typeof fetch
    await expect(new RepositoryFileIngress(root, { fetch: download }).importFile(descriptor, 'failed.bin')).rejects.toThrow('DOWNLOAD_FAILED')
    expect(await readdir(root)).toEqual([])
    const failingFetch = vi.fn(async () => { throw new Error(descriptor.download_url) }) as typeof fetch
    await expect(new RepositoryFileIngress(root, { fetch: failingFetch }).importFile(descriptor, 'failed.bin')).rejects.toThrow('DOWNLOAD_FAILED')
  })

  it.each([302, 403, 500])('rejects HTTP status %i without publishing', async status => {
    const download = vi.fn(async () => new Response(binary, { status })) as typeof fetch
    await expect(new RepositoryFileIngress(root, { fetch: download }).importFile(descriptor, 'failed.bin')).rejects.toMatchObject({ code: 'DOWNLOAD_FAILED' })
    expect(await readdir(root)).toEqual([])
  })

  it('rejects an already redirected response and preserves HTTPS-only redirect policy', async () => {
    const response = new Response(binary)
    Object.defineProperty(response, 'redirected', { value: true })
    const download = vi.fn(async () => response) as typeof fetch
    await expect(new RepositoryFileIngress(root, { fetch: download }).importFile(descriptor, 'redirected.bin')).rejects.toMatchObject({ code: 'DOWNLOAD_FAILED' })
    expect(await readdir(root)).toEqual([])
    expect(download).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ redirect: 'error' }))
  })

  it.each(['file', 'directory'])('preserves an existing destination %s without downloading', async kind => {
    const destination = path.join(root, 'existing')
    if (kind === 'file') await writeFile(destination, binary)
    else await mkdir(destination)
    const download = downloader(Buffer.from('replacement'))
    await expect(new RepositoryFileIngress(root, { fetch: download }).importFile(descriptor, 'existing')).rejects.toMatchObject({ code: 'DESTINATION_CONFLICT' })
    expect(download).not.toHaveBeenCalled()
    if (kind === 'file') expect(await readFile(destination)).toEqual(binary)
  })

  it.each(['outside', 'inside'])('rejects parent junction/symlink redirection to %s', async location => {
    const target = path.join(root, location === 'inside' ? 'target' : '../' + path.basename(root) + '-outside')
    await mkdir(target)
    try {
      await symlink(target, path.join(root, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir')
      const download = downloader()
      await expect(new RepositoryFileIngress(root, { fetch: download }).importFile(descriptor, 'redirect/nested/escape.bin')).rejects.toMatchObject({ code: 'INVALID_PATH' })
      expect(download).not.toHaveBeenCalled()
      expect(await readdir(target)).toEqual([])
    } finally {
      if (location === 'outside') await rm(target, { recursive: true, force: true })
    }
  })

  it('revalidates the parent after download before publication', async () => {
    await mkdir(path.join(root, 'parent'))
    const target = path.join(root, 'other')
    await mkdir(target)
    let release: (() => void) | undefined
    const download = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(binary)
      release = () => controller.close()
    } }))) as typeof fetch
    const operation = new RepositoryFileIngress(root, { fetch: download }).importFile(descriptor, 'parent/new.bin')
    await vi.waitFor(async () => expect((await readdir(root)).some(name => name.startsWith('.file-ingress-'))).toBe(true))
    await rename(path.join(root, 'parent'), path.join(root, 'original'))
    await symlink(target, path.join(root, 'parent'), process.platform === 'win32' ? 'junction' : 'dir')
    release!()
    await expect(operation).rejects.toMatchObject({ code: 'INVALID_PATH' })
    expect(await readdir(target)).toEqual([])
    expect(await readdir(path.join(root, 'original'))).toEqual([])
    expect((await readdir(root)).some(name => name.startsWith('.file-ingress-'))).toBe(false)
  })

  it('gives exactly one winner to concurrent creates of the same destination', async () => {
    const ingress = new RepositoryFileIngress(root, { fetch: downloader() })
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => ingress.importFile(descriptor, 'race/new.bin')))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    for (const result of results) if (result.status === 'rejected') expect(result.reason.code).toBe('DESTINATION_CONFLICT')
    expect(await readFile(path.join(root, 'race/new.bin'))).toEqual(binary)
    expect(await readdir(path.join(root, 'race'))).toEqual(['new.bin'])
  })

  it('allows an independent destination to finish while another download is stalled', async () => {
    let release: (() => void) | undefined
    const download = vi.fn(async (url: Parameters<typeof fetch>[0]) => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(binary)
      if (String(url).includes('slow')) release = () => controller.close()
      else controller.close()
    } }))) as typeof fetch
    const ingress = new RepositoryFileIngress(root, { fetch: download })
    const slow = ingress.importFile({ ...descriptor, download_url: 'https://files.example/slow' }, 'slow.bin')
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    try {
      await expect(ingress.importFile(descriptor, 'fast.bin')).resolves.toMatchObject({ path: 'fast.bin' })
      expect(await readFile(path.join(root, 'fast.bin'))).toEqual(binary)
    } finally { release!(); await slow }
  })
})
