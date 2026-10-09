import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, realpath, link, unlink } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import path from 'node:path'

export interface RepositoryFileDescriptor {
  download_url: string
  file_id: string
  mime_type?: string
  file_name?: string
}

export interface RepositoryFileReceipt {
  path: string
  size: number
  sha256: string
}

export const REPOSITORY_FILE_MAX_BYTES = 32 * 1024 * 1024

export class RepositoryFileIngressError extends Error {
  constructor(readonly code: 'INVALID_FILE' | 'INVALID_PATH' | 'DESTINATION_CONFLICT' | 'DOWNLOAD_FAILED' | 'FILE_TOO_LARGE' | 'REQUEST_TIMEOUT' | 'FILESYSTEM_FAILED' | 'CLEANUP_FAILED' | 'PROTECTED_PATH' | 'REPOSITORY_CONTEXT_CHANGED') {
    super(code)
    this.name = 'RepositoryFileIngressError'
  }
}

function hasCode(error: unknown, code: string): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === code
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

export function relativeDestination(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || path.win32.isAbsolute(value) || path.posix.isAbsolute(value)) throw new RepositoryFileIngressError('INVALID_PATH')
  const segments = value.replace(/\\/g, '/').split('/')
  if (segments.some(segment => segment === '..' || /[\x00-\x1f<>:"|?*]/.test(segment) || /[. ]$/.test(segment) && segment !== '.' || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))) throw new RepositoryFileIngressError('INVALID_PATH')
  const normalized = segments.filter(segment => segment && segment !== '.').join('/')
  if (!normalized || value.endsWith('/') || value.endsWith('\\')) throw new RepositoryFileIngressError('INVALID_PATH')
  return normalized
}

function fileUrl(value: unknown): URL {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RepositoryFileIngressError('INVALID_FILE')
  const file = value as Record<string, unknown>
  if (Object.keys(file).some(key => !['download_url', 'file_id', 'mime_type', 'file_name'].includes(key)) || typeof file.download_url !== 'string' || typeof file.file_id !== 'string' || !file.file_id.trim() || ['mime_type', 'file_name'].some(key => file[key] !== undefined && typeof file[key] !== 'string')) throw new RepositoryFileIngressError('INVALID_FILE')
  try {
    const url = new URL(file.download_url)
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error()
    return url
  } catch {
    throw new RepositoryFileIngressError('INVALID_FILE')
  }
}

export class RepositoryFileIngress {
  private readonly root: string
  private readonly fetchFile: typeof fetch
  private readonly timeoutMs: number

  constructor(private readonly repositoryRoot: string, private readonly options: { fetch?: typeof fetch; timeoutMs?: number; validateDestination?: (relative: string) => void } = {}) {
    this.root = realpathSync(repositoryRoot)
    this.fetchFile = options.fetch ?? fetch
    this.timeoutMs = options.timeoutMs ?? 15_000
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new Error('Invalid ingress timeout')
  }

  private async validateDirectory(directory: string): Promise<void> {
    const stats = await lstat(directory)
    if (!stats.isDirectory() || stats.isSymbolicLink() || !samePath(await realpath(directory), directory)) throw new RepositoryFileIngressError('INVALID_PATH')
  }

  private async validateParents(parent: string, create: boolean): Promise<void> {
    if (!samePath(await realpath(this.repositoryRoot), this.root)) throw new RepositoryFileIngressError('INVALID_PATH')
    await this.validateDirectory(this.root)
    const relative = path.relative(this.root, parent)
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new RepositoryFileIngressError('INVALID_PATH')
    let directory = this.root
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      directory = path.join(directory, segment)
      if (create) {
        try { await mkdir(directory) } catch (error) { if (!hasCode(error, 'EEXIST')) throw error }
      }
      await this.validateDirectory(directory)
    }
  }

  async importFile(file: RepositoryFileDescriptor, destinationPath: string): Promise<RepositoryFileReceipt> {
    const relative = relativeDestination(destinationPath)
    this.options.validateDestination?.(relative)
    const url = fileUrl(file)
    const destination = path.join(this.root, ...relative.split('/'))
    const parent = path.dirname(destination)
    const controller = new AbortController()
    const deadline = Date.now() + this.timeoutMs
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let temporary: string | undefined
    let handle: Awaited<ReturnType<typeof open>> | undefined
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    const checkBudget = () => {
      if (controller.signal.aborted || Date.now() >= deadline) throw new RepositoryFileIngressError('REQUEST_TIMEOUT')
    }
    const bounded = async <T>(work: () => Promise<T>): Promise<T> => {
      checkBudget()
      let onAbort: () => void = () => {}
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(new RepositoryFileIngressError('REQUEST_TIMEOUT'))
        controller.signal.addEventListener('abort', onAbort, { once: true })
      })
      try {
        return await Promise.race([Promise.resolve().then(work), aborted])
      } catch (error) {
        if (error instanceof RepositoryFileIngressError) throw error
        throw new RepositoryFileIngressError(controller.signal.aborted ? 'REQUEST_TIMEOUT' : 'DOWNLOAD_FAILED')
      } finally { controller.signal.removeEventListener('abort', onAbort) }
    }
    try {
      await this.validateParents(parent, true)
      try {
        await lstat(destination)
        throw new RepositoryFileIngressError('DESTINATION_CONFLICT')
      } catch (error) { if (!hasCode(error, 'ENOENT')) throw error }
      checkBudget()
      const response = await bounded(() => this.fetchFile(url, { signal: controller.signal, redirect: 'error' }))
      if (!response.ok || response.redirected || !response.body) throw new RepositoryFileIngressError('DOWNLOAD_FAILED')
      reader = response.body.getReader()
      await this.validateParents(parent, false)
      const temporaryPath = path.join(this.root, `.file-ingress-${randomUUID()}.tmp`)
      handle = await open(temporaryPath, 'wx', 0o600)
      temporary = temporaryPath
      if ((await handle.stat()).dev !== (await lstat(parent)).dev) throw new RepositoryFileIngressError('FILESYSTEM_FAILED')
      const hash = createHash('sha256')
      let size = 0
      for (;;) {
        const chunk = await bounded(() => reader!.read())
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > REPOSITORY_FILE_MAX_BYTES) throw new RepositoryFileIngressError('FILE_TOO_LARGE')
        hash.update(chunk.value)
        let offset = 0
        while (offset < chunk.value.byteLength) {
          checkBudget()
          const { bytesWritten } = await handle.write(chunk.value, offset, chunk.value.byteLength - offset)
          if (!bytesWritten) throw new RepositoryFileIngressError('FILESYSTEM_FAILED')
          offset += bytesWritten
        }
      }
      const sha256 = hash.digest('hex')
      const declaredSize = response.headers.get('content-length')
      if (declaredSize !== null && /^\d+$/.test(declaredSize) && Number(declaredSize) !== size) throw new RepositoryFileIngressError('DOWNLOAD_FAILED')
      await handle.sync()
      const temporaryIdentity = await handle.stat()
      await handle.close()
      handle = undefined
      const currentIdentity = await lstat(temporary)
      if (!currentIdentity.isFile() || currentIdentity.isSymbolicLink() || currentIdentity.dev !== temporaryIdentity.dev || currentIdentity.ino !== temporaryIdentity.ino) throw new RepositoryFileIngressError('INVALID_PATH')
      await this.validateParents(parent, false)
      checkBudget()
      this.options.validateDestination?.(relative)
      try { await link(temporary, destination) } catch (error) {
        if (hasCode(error, 'EEXIST')) throw new RepositoryFileIngressError('DESTINATION_CONFLICT')
        throw error
      }
      return { path: relative, size, sha256 }
    } catch (error) {
      if (error instanceof RepositoryFileIngressError) throw error
      if (controller.signal.aborted) throw new RepositoryFileIngressError('REQUEST_TIMEOUT')
      throw new RepositoryFileIngressError('FILESYSTEM_FAILED')
    } finally {
      clearTimeout(timer)
      controller.abort()
      if (reader) void reader.cancel().catch(() => {})
      let cleanupFailed = false
      try { if (handle) await handle.close() } catch { cleanupFailed = true }
      if (temporary) {
        try { await unlink(temporary) } catch (error) { if (!hasCode(error, 'ENOENT')) cleanupFailed = true }
      }
      if (cleanupFailed) throw new RepositoryFileIngressError('CLEANUP_FAILED')
    }
  }
}
