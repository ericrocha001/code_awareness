import { readSync } from 'node:fs'
import { createZstdDecompress } from 'node:zlib'
import { NATIVE_IO_CHUNK_BYTES, NATIVE_LINE_MAX_BYTES, type NativeStepBudget } from './native-source-index'

const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

interface ZstdStreamState {
  key: string
  decomp: ReturnType<typeof createZstdDecompress>
  physicalOffset: number
  logicalOffset: number
  pending: Buffer
  skippingOversized: boolean
  eof: boolean
  lastAccessMs: number
}

const STREAM_CACHE = new Map<string, ZstdStreamState>()
const MAX_CACHED_STREAMS = 2
const STREAM_TTL_MS = 30_000

export function invalidateZstdStreamCache(nativeKey?: string): void {
  for (const [key, entry] of STREAM_CACHE.entries()) {
    if (!nativeKey || key.startsWith(`${nativeKey}:`)) {
      try { entry.decomp.destroy() } catch {}
      STREAM_CACHE.delete(key)
    }
  }
}

function pruneStreamCache(): void {
  const now = Date.now()
  for (const [key, entry] of STREAM_CACHE.entries()) {
    if (now - entry.lastAccessMs > STREAM_TTL_MS) {
      try { entry.decomp.destroy() } catch {}
      STREAM_CACHE.delete(key)
    }
  }
  while (STREAM_CACHE.size > MAX_CACHED_STREAMS) {
    const oldest = STREAM_CACHE.keys().next().value
    if (!oldest) break
    const entry = STREAM_CACHE.get(oldest)
    try { entry?.decomp.destroy() } catch {}
    STREAM_CACHE.delete(oldest)
  }
}

function pumpZstdChunk(
  fd: number,
  fileSize: number,
  state: ZstdStreamState,
  formatError: string,
  assertCurrent: () => void
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    assertCurrent()
    if (state.eof) {
      resolve(Buffer.alloc(0))
      return
    }
    const chunks: Buffer[] = []
    let settled = false
    const cleanup = () => {
      state.decomp.removeListener('data', onData)
      state.decomp.removeListener('error', onError)
      state.decomp.removeListener('end', onEnd)
    }
    const finish = (err?: Error) => {
      if (settled) return
      settled = true
      cleanup()
      if (err) reject(err)
      else resolve(chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks))
    }
    const onData = (chunk: Buffer) => {
      chunks.push(chunk)
    }
    const onError = () => {
      finish(new Error(formatError))
    }
    const onEnd = () => {
      state.eof = true
      finish()
    }
    state.decomp.on('data', onData)
    state.decomp.on('error', onError)
    state.decomp.on('end', onEnd)

    if (state.physicalOffset >= fileSize) {
      state.decomp.end()
      return
    }
    const buf = Buffer.allocUnsafe(NATIVE_IO_CHUNK_BYTES)
    const toRead = Math.min(buf.length, fileSize - state.physicalOffset)
    const bytesRead = readSync(fd, buf, 0, toRead, state.physicalOffset)
    if (bytesRead <= 0) {
      state.decomp.end()
      return
    }
    state.physicalOffset += bytesRead
    const slice = buf.subarray(0, bytesRead)
    const atEnd = state.physicalOffset >= fileSize
    state.decomp.write(slice, err => {
      if (err) {
        finish(new Error(formatError))
        return
      }
      if (atEnd) {
        state.decomp.end()
      } else {
        setImmediate(() => finish())
      }
    })
  })
}

export async function readZstdFirstLine(
  fd: number,
  fileSize: number,
  maxHeaderLine: number,
  maxCompressedBytes: number,
  assertCurrent: () => void
): Promise<{ line?: string; bytesRead: number }> {
  const decomp = createZstdDecompress({ chunkSize: 16 * 1024 })
  const state: ZstdStreamState = {
    key: 'header',
    decomp,
    physicalOffset: 0,
    logicalOffset: 0,
    pending: Buffer.alloc(0),
    skippingOversized: false,
    eof: false,
    lastAccessMs: Date.now()
  }
  try {
    let accumulated: Buffer = Buffer.alloc(0)
    while (state.physicalOffset < Math.min(fileSize, maxCompressedBytes) && !state.eof) {
      assertCurrent()
      const chunk = await pumpZstdChunk(fd, Math.min(fileSize, maxCompressedBytes), state, 'SOURCE_FORMAT_UNSUPPORTED', assertCurrent)
      if (chunk.length > 0) {
        accumulated = accumulated.length ? Buffer.concat([accumulated, chunk]) : chunk
        const nl = accumulated.indexOf(10)
        if (nl > 0) {
          return {
            line: utf8Decoder.decode(accumulated.subarray(0, Math.min(nl, maxHeaderLine))),
            bytesRead: state.physicalOffset
          }
        }
        if (accumulated.length >= maxHeaderLine) {
          return { bytesRead: state.physicalOffset }
        }
      }
    }
    return { bytesRead: state.physicalOffset }
  } catch {
    return { bytesRead: state.physicalOffset }
  } finally {
    try { decomp.destroy() } catch {}
  }
}

function getOrCreateStreamState(key: string): ZstdStreamState {
  pruneStreamCache()
  const existing = STREAM_CACHE.get(key)
  if (existing) {
    existing.lastAccessMs = Date.now()
    return existing
  }
  const fresh: ZstdStreamState = {
    key,
    decomp: createZstdDecompress({ chunkSize: 16 * 1024 }),
    physicalOffset: 0,
    logicalOffset: 0,
    pending: Buffer.alloc(0),
    skippingOversized: false,
    eof: false,
    lastAccessMs: Date.now()
  }
  STREAM_CACHE.set(key, fresh)
  return fresh
}

export async function streamZstdJsonlChunk(options: {
  fd: number
  fileSize: number
  nativeKey: string
  fileIdentity: string
  startOffset: number
  formatError: string
  stepBudget?: NativeStepBudget
  assertCurrent: () => void
  onRecord: (record: unknown, lineStart: number, lineEnd: number) => void
  onUnavailableRecord?: (lineStart: number, lineEnd: number, limitation: 'RECORD_TOO_LARGE' | 'INVALID_RECORD_FORMAT') => void
}): Promise<{ done: boolean; nextOffset: number; processedBytes: number; processedLines: number }> {
  const { fd, fileSize, nativeKey, fileIdentity, startOffset, formatError, stepBudget, assertCurrent, onRecord, onUnavailableRecord } = options
  const cacheKey = `${nativeKey}:${fileIdentity}`
  let state = getOrCreateStreamState(cacheKey)
  if (state.logicalOffset !== startOffset) {
    invalidateZstdStreamCache(nativeKey)
    state = getOrCreateStreamState(cacheKey)
  }

  const maxStepBytes = stepBudget?.maxBytes ?? Number.POSITIVE_INFINITY
  const maxStepLines = stepBudget?.maxLines ?? Number.POSITIVE_INFINITY
  const deadlineMs = stepBudget?.deadlineMs
  let processedBytes = 0
  let processedLines = 0
  let paused = false

  // If resuming from offset 0 when startOffset > 0 (after restart/cache miss), advance to startOffset cleanly.
  while (state.logicalOffset < startOffset && !state.eof) {
    assertCurrent()
    if (deadlineMs !== undefined && Date.now() >= deadlineMs) {
      return { done: false, nextOffset: startOffset, processedBytes: 0, processedLines: 0 }
    }
    const chunk = await pumpZstdChunk(fd, fileSize, state, formatError, assertCurrent)
    if (chunk.length === 0 && state.eof) break
    const combined = state.pending.length ? Buffer.concat([state.pending, chunk]) : chunk
    const remainingToSkip = startOffset - state.logicalOffset
    if (combined.length <= remainingToSkip) {
      state.logicalOffset += combined.length
      state.pending = Buffer.alloc(0)
    } else {
      state.pending = Buffer.from(combined.subarray(remainingToSkip))
      state.logicalOffset = startOffset
    }
  }

  let lineStart = state.logicalOffset
  while (!paused && (!state.eof || state.pending.length > 0)) {
    assertCurrent()
    const chunk = state.eof ? Buffer.alloc(0) : await pumpZstdChunk(fd, fileSize, state, formatError, assertCurrent)
    let data = state.skippingOversized
      ? chunk
      : (state.pending.length ? Buffer.concat([state.pending, chunk]) : chunk)
    let dataOffset = state.skippingOversized ? state.logicalOffset : lineStart
    state.logicalOffset += chunk.length

    let newline: number
    while ((newline = data.indexOf(10)) !== -1) {
      const lineEnd = dataOffset + newline
      if (state.skippingOversized || lineEnd - lineStart > NATIVE_LINE_MAX_BYTES) {
        if (!onUnavailableRecord) throw new Error('SOURCE_LIMIT_REACHED')
        onUnavailableRecord(lineStart, lineEnd, 'RECORD_TOO_LARGE')
        state.skippingOversized = false
        data = data.subarray(newline + 1)
        dataOffset = lineEnd + 1
        const consumed = (lineEnd + 1) - lineStart
        lineStart = lineEnd + 1
        processedBytes += consumed
        processedLines++
      } else {
        let parsed: unknown
        let parseOk = true
        try {
          parsed = JSON.parse(utf8Decoder.decode(data.subarray(0, newline)))
        } catch {
          parseOk = false
        }
        data = data.subarray(newline + 1)
        dataOffset = lineEnd + 1
        if (parseOk) {
          onRecord(parsed, lineStart, lineEnd)
        } else {
          if (!onUnavailableRecord) throw new Error(formatError)
          onUnavailableRecord(lineStart, lineEnd, 'INVALID_RECORD_FORMAT')
        }
        lineStart = lineEnd + 1
        processedBytes += newline + 1
        processedLines++
      }
      if (!state.eof && (
        processedBytes >= maxStepBytes ||
        processedLines >= maxStepLines ||
        (deadlineMs !== undefined && Date.now() >= deadlineMs)
      )) {
        paused = true
        break
      }
    }

    if (paused) {
      state.pending = Buffer.from(data)
      state.logicalOffset = lineStart + state.pending.length
      break
    }
    if (state.skippingOversized) {
      state.pending = Buffer.alloc(0)
    } else if (data.length > NATIVE_LINE_MAX_BYTES) {
      if (!onUnavailableRecord) throw new Error('SOURCE_LIMIT_REACHED')
      state.skippingOversized = true
      state.pending = Buffer.alloc(0)
    } else {
      state.pending = data.length ? Buffer.from(data) : Buffer.alloc(0)
    }
    if (state.eof) break
  }

  if (!paused && (state.pending.length > 0 || state.skippingOversized)) {
    invalidateZstdStreamCache(nativeKey)
    throw new Error(formatError)
  }

  const done = !paused && state.eof && state.pending.length === 0
  if (done) invalidateZstdStreamCache(nativeKey)
  return {
    done,
    nextOffset: lineStart,
    processedBytes,
    processedLines
  }
}

export async function readZstdLogicalRange(options: {
  fd: number
  fileSize: number
  nativeKey: string
  fileIdentity: string
  lineStart: number
  lineEnd: number
  staleError: string
  formatError: string
  assertCurrent: () => void
  deadlineMs?: number
}): Promise<Buffer> {
  const { fd, fileSize, nativeKey, fileIdentity, lineStart, lineEnd, staleError, formatError, assertCurrent, deadlineMs } = options
  const targetLen = lineEnd - lineStart
  if (targetLen < 0 || targetLen > NATIVE_LINE_MAX_BYTES) throw new Error('SOURCE_LIMIT_REACHED')
  if (targetLen === 0) return Buffer.alloc(0)

  const cacheKey = `${nativeKey}:read:${fileIdentity}`
  let state = getOrCreateStreamState(cacheKey)
  if (state.logicalOffset > lineStart) {
    invalidateZstdStreamCache(`${nativeKey}:read`)
    state = getOrCreateStreamState(cacheKey)
  }

  while (state.logicalOffset < lineStart && !state.eof) {
    assertCurrent()
    if (deadlineMs !== undefined && Date.now() >= deadlineMs) throw new Error('SOURCE_READ_BUDGET_REACHED')
    const chunk = await pumpZstdChunk(fd, fileSize, state, formatError, assertCurrent)
    if (chunk.length === 0 && state.eof) break
    const combined = state.pending.length ? Buffer.concat([state.pending, chunk]) : chunk
    const skip = lineStart - state.logicalOffset
    if (combined.length <= skip) {
      state.logicalOffset += combined.length
      state.pending = Buffer.alloc(0)
    } else {
      state.pending = Buffer.from(combined.subarray(skip))
      state.logicalOffset = lineStart
    }
  }

  if (state.logicalOffset < lineStart) throw new Error(staleError)

  while (state.pending.length < targetLen && !state.eof) {
    assertCurrent()
    if (deadlineMs !== undefined && Date.now() >= deadlineMs) throw new Error('SOURCE_READ_BUDGET_REACHED')
    const chunk = await pumpZstdChunk(fd, fileSize, state, formatError, assertCurrent)
    if (chunk.length > 0) {
      state.pending = state.pending.length ? Buffer.concat([state.pending, chunk]) : chunk
    }
  }

  if (state.pending.length < targetLen) throw new Error(staleError)
  const result = Buffer.from(state.pending.subarray(0, targetLen))
  state.pending = Buffer.from(state.pending.subarray(targetLen))
  state.logicalOffset = lineEnd
  return result
}
