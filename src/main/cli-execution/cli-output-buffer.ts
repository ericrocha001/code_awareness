import { StringDecoder } from 'node:string_decoder'
import type { CliOutputPage } from './cli-execution-types'

export class CliOutputBuffer {
  private stdoutBuffer = ''
  private stderrBuffer = ''
  private truncatedFlag = false
  private stdoutBytes = 0
  private stderrBytes = 0
  private readonly stdoutDecoder = new StringDecoder('utf8')
  private readonly stderrDecoder = new StringDecoder('utf8')

  constructor(
    private readonly maxBytesPerStream = 512 * 1024,
    private readonly defaultPageBytes = 16 * 1024,
    private readonly maxTotalBytes = Infinity
  ) {}

  appendStdout(chunk: Buffer | string): void {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    const remaining = Math.max(0, Math.min(this.maxBytesPerStream - this.stdoutBytes, this.maxTotalBytes - this.stdoutBytes - this.stderrBytes))
    const accepted = bytes.subarray(0, remaining)
    this.stdoutBytes += accepted.length
    this.stdoutBuffer += this.stdoutDecoder.write(accepted)
    if (bytes.length > remaining) this.truncatedFlag = true
  }

  appendStderr(chunk: Buffer | string): void {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    const remaining = Math.max(0, Math.min(this.maxBytesPerStream - this.stderrBytes, this.maxTotalBytes - this.stdoutBytes - this.stderrBytes))
    const accepted = bytes.subarray(0, remaining)
    this.stderrBytes += accepted.length
    this.stderrBuffer += this.stderrDecoder.write(accepted)
    if (bytes.length > remaining) this.truncatedFlag = true
  }

  readPage(cursorStr?: string, maxBytes = this.defaultPageBytes): CliOutputPage {
    const cursor = cursorStr ? Math.max(0, parseInt(cursorStr, 10) || 0) : 0
    const stdoutSlice = this.stdoutBuffer.slice(cursor, cursor + maxBytes)
    const stderrSlice = this.stderrBuffer.slice(cursor, cursor + maxBytes)

    const nextOffset = cursor + Math.max(stdoutSlice.length, stderrSlice.length)
    const hasMore =
      nextOffset < this.stdoutBuffer.length || nextOffset < this.stderrBuffer.length

    return {
      stdout: stdoutSlice,
      stderr: stderrSlice,
      cursor: cursorStr ?? '0',
      nextCursor: hasMore ? String(nextOffset) : null,
      hasMore,
      truncated: this.truncatedFlag,
      totalStdoutBytes: Buffer.byteLength(this.stdoutBuffer, 'utf8'),
      totalStderrBytes: Buffer.byteLength(this.stderrBuffer, 'utf8')
    }
  }

  isTruncated(): boolean {
    return this.truncatedFlag
  }

  readBoundedPage(cursor = '0:0'): CliOutputPage {
    if (!/^\d+:\d+$/.test(cursor)) throw new Error('INVALID_OUTPUT_CURSOR')
    const [stdoutOffset, stderrOffset] = cursor.split(':').map(Number)
    if (!Number.isSafeInteger(stdoutOffset) || !Number.isSafeInteger(stderrOffset) || stdoutOffset > this.stdoutBuffer.length || stderrOffset > this.stderrBuffer.length) throw new Error('INVALID_OUTPUT_CURSOR')
    let remaining = 8192
    const take = (value: string, offset: number) => {
      let result = ''
      for (const character of value.slice(offset)) {
        const bytes = Buffer.byteLength(character)
        if (bytes > remaining) break
        result += character; remaining -= bytes
      }
      return result
    }
    const stdout = take(this.stdoutBuffer, stdoutOffset), stderr = take(this.stderrBuffer, stderrOffset)
    const next = [stdoutOffset + stdout.length, stderrOffset + stderr.length]
    const hasMore = next[0] < this.stdoutBuffer.length || next[1] < this.stderrBuffer.length
    return { stdout, stderr, cursor, nextCursor: hasMore ? next.join(':') : null, hasMore, truncated: this.truncatedFlag,
      totalStdoutBytes: Buffer.byteLength(this.stdoutBuffer), totalStderrBytes: Buffer.byteLength(this.stderrBuffer) }
  }
}
