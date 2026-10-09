export interface HostFileDescriptor { download_url: string; file_id: string; mime_type?: string; file_name?: string }

export function hostFileUrl(value: unknown): URL {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_FILE')
  const file = value as Record<string, unknown>
  if (Object.keys(file).some(key => !['download_url', 'file_id', 'mime_type', 'file_name'].includes(key)) || typeof file.download_url !== 'string' || typeof file.file_id !== 'string' || !file.file_id.trim() || ['mime_type', 'file_name'].some(key => file[key] !== undefined && typeof file[key] !== 'string')) throw new Error('INVALID_FILE')
  try {
    const url = new URL(file.download_url)
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error()
    return url
  } catch { throw new Error('INVALID_FILE') }
}

export async function acquireHostFile(file: HostFileDescriptor, maxBytes: number, options: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<Buffer> {
  const url = hostFileUrl(file)
  const controller = new AbortController()
  const timeout = options.timeoutMs ?? 10_000
  const deadline = Date.now() + timeout
  let abort!: () => void
  const expired = new Promise<never>((_, reject) => { abort = () => { controller.abort(); reject(new Error('REQUEST_TIMEOUT')) } })
  const timer = setTimeout(abort, timeout)
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  const bounded = async <T>(work: Promise<T>): Promise<T> => {
    if (Date.now() >= deadline || controller.signal.aborted) throw new Error('REQUEST_TIMEOUT')
    return Promise.race([work, expired])
  }
  try {
    const response = await bounded((options.fetch ?? fetch)(url, { signal: controller.signal, redirect: 'error' }))
    if (!response.ok || response.redirected || !response.body) throw new Error('DOWNLOAD_FAILED')
    const declared = response.headers.get('content-length')
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw new Error('FILE_TOO_LARGE')
    reader = response.body.getReader()
    const chunks: Buffer[] = []; let bytes = 0
    for (;;) {
      const chunk = await bounded(reader.read())
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > maxBytes) throw new Error('FILE_TOO_LARGE')
      chunks.push(Buffer.from(chunk.value))
    }
    if (!bytes || declared !== null && Number(declared) !== bytes) throw new Error('DOWNLOAD_FAILED')
    return Buffer.concat(chunks, bytes)
  } catch (error) {
    if (error instanceof Error && ['INVALID_FILE', 'REQUEST_TIMEOUT', 'FILE_TOO_LARGE', 'DOWNLOAD_FAILED'].includes(error.message)) throw error
    throw new Error(controller.signal.aborted ? 'REQUEST_TIMEOUT' : 'DOWNLOAD_FAILED')
  } finally { clearTimeout(timer); controller.abort(); if (reader) void reader.cancel().catch(() => {}) }
}
