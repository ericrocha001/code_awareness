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
    private readonly defaultPageBytes = 16 * 1024
  ) {}

  appendStdout(chunk: Buffer | string): void {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    const remaining = Math.max(0, this.maxBytesPerStream - this.stdoutBytes)
    const accepted = bytes.subarray(0, remaining)
    this.stdoutBytes += accepted.length
    this.stdoutBuffer += this.stdoutDecoder.write(accepted)
    if (bytes.length > remaining) this.truncatedFlag = true
  }

  appendStderr(chunk: Buffer | string): void {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    const remaining = Math.max(0, this.maxBytesPerStream - this.stderrBytes)
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
}
