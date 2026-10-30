import type { CliOutputPage } from './cli-execution-types'

export class CliOutputBuffer {
  private stdoutBuffer = ''
  private stderrBuffer = ''
  private truncatedFlag = false

  constructor(
    private readonly maxBytesPerStream = 512 * 1024,
    private readonly defaultPageBytes = 16 * 1024
  ) {}

  appendStdout(chunk: Buffer | string): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    if (this.stdoutBuffer.length + text.length > this.maxBytesPerStream) {
      const remaining = Math.max(0, this.maxBytesPerStream - this.stdoutBuffer.length)
      if (remaining > 0) {
        this.stdoutBuffer += text.slice(0, remaining)
      }
      this.truncatedFlag = true
    } else {
      this.stdoutBuffer += text
    }
  }

  appendStderr(chunk: Buffer | string): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    if (this.stderrBuffer.length + text.length > this.maxBytesPerStream) {
      const remaining = Math.max(0, this.maxBytesPerStream - this.stderrBuffer.length)
      if (remaining > 0) {
        this.stderrBuffer += text.slice(0, remaining)
      }
      this.truncatedFlag = true
    } else {
      this.stderrBuffer += text
    }
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
