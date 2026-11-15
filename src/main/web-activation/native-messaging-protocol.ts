export const MAX_NATIVE_INBOUND_BYTES = 4 * 1024 * 1024
export const MAX_NATIVE_OUTBOUND_BYTES = 1024 * 1024

export class NativeFramingError extends Error {
  readonly code: 'INVALID_FRAME_LENGTH' | 'PAYLOAD_TOO_LARGE' | 'INVALID_JSON'

  constructor(code: 'INVALID_FRAME_LENGTH' | 'PAYLOAD_TOO_LARGE' | 'INVALID_JSON', message: string) {
    super(message)
    this.name = 'NativeFramingError'
    this.code = code
  }
}

export function encodeNativeMessage(payload: unknown, maxBytes = MAX_NATIVE_OUTBOUND_BYTES): Buffer {
  const json = JSON.stringify(payload)
  const body = Buffer.from(json, 'utf8')
  if (body.byteLength === 0 || body.byteLength > maxBytes) {
    throw new NativeFramingError(
      'PAYLOAD_TOO_LARGE',
      `Native message payload size ${body.byteLength} exceeds ${maxBytes} byte limit`
    )
  }
  const frame = Buffer.allocUnsafe(4 + body.byteLength)
  frame.writeUInt32LE(body.byteLength, 0)
  body.copy(frame, 4)
  return frame
}

export class NativeMessageFrameDecoder {
  private buffer: Buffer = Buffer.alloc(0)
  readonly maxMessageBytes: number

  constructor(maxMessageBytes = MAX_NATIVE_INBOUND_BYTES) {
    this.maxMessageBytes = maxMessageBytes
  }

  push(chunk: Buffer): unknown[] {
    if (chunk.byteLength === 0) return []
    this.buffer = this.buffer.byteLength === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    const messages: unknown[] = []

    while (this.buffer.byteLength >= 4) {
      const length = this.buffer.readUInt32LE(0)
      if (length === 0) {
        this.buffer = Buffer.alloc(0)
        throw new NativeFramingError('INVALID_FRAME_LENGTH', 'Native message frame length cannot be 0')
      }
      if (length > this.maxMessageBytes) {
        this.buffer = Buffer.alloc(0)
        throw new NativeFramingError(
          'PAYLOAD_TOO_LARGE',
          `Inbound native message size ${length} exceeds ${this.maxMessageBytes} byte limit`
        )
      }
      if (this.buffer.byteLength < 4 + length) {
        break
      }

      const payloadBytes = this.buffer.subarray(4, 4 + length)
      this.buffer = this.buffer.subarray(4 + length)

      let parsed: unknown
      try {
        parsed = JSON.parse(payloadBytes.toString('utf8'))
      } catch {
        throw new NativeFramingError('INVALID_JSON', 'Inbound native message payload is not valid JSON')
      }
      messages.push(parsed)
    }

    return messages
  }
}

function writeFrame(stdout: NodeJS.WritableStream, frame: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const done = (err?: Error | null) => {
      if (settled) return
      settled = true
      if (err) reject(err)
      else resolve()
    }
    const ok = stdout.write(frame, done)
    if (!ok) {
      stdout.once('drain', () => done())
    }
  })
}

export async function runNativeStdioLoop(
  stdin: NodeJS.ReadableStream,
  stdout: NodeJS.WritableStream,
  handler: (message: unknown) => Promise<unknown> | unknown,
  options: { maxInboundBytes?: number; maxOutboundBytes?: number; protocolVersion?: string } = {}
): Promise<void> {
  const maxInbound = options.maxInboundBytes ?? MAX_NATIVE_INBOUND_BYTES
  const maxOutbound = options.maxOutboundBytes ?? MAX_NATIVE_OUTBOUND_BYTES
  const protocolVersion = options.protocolVersion ?? 'code-awareness-web-bridge/v1'
  const decoder = new NativeMessageFrameDecoder(maxInbound)

  const emitResponse = async (response: unknown) => {
    try {
      await writeFrame(stdout, encodeNativeMessage(response, maxOutbound))
    } catch (error) {
      const reqId =
        response && typeof response === 'object' && typeof (response as { id?: unknown }).id === 'string'
          ? (response as { id: string }).id
          : ''
      const fallback = encodeNativeMessage(
        {
          id: reqId,
          ok: false,
          protocol: protocolVersion,
          error: {
            code: error instanceof NativeFramingError && error.code === 'PAYLOAD_TOO_LARGE'
              ? 'RESPONSE_TOO_LARGE'
              : 'INTERNAL_ERROR',
            message: error instanceof Error ? error.message : String(error)
          }
        },
        maxOutbound
      )
      await writeFrame(stdout, fallback)
    }
  }

  let tail = Promise.resolve()
  const enqueue = (fn: () => Promise<void>) => {
    tail = tail.then(fn, fn)
  }

  await new Promise<void>((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      tail.then(resolve, resolve)
    }

    stdin.on('data', (raw: Buffer | string) => {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8')
      try {
        const messages = decoder.push(chunk)
        for (const msg of messages) {
          enqueue(async () => {
            const result = await handler(msg)
            await emitResponse(result)
          })
        }
      } catch (error) {
        const code = error instanceof NativeFramingError ? error.code : 'INTERNAL_ERROR'
        enqueue(async () => {
          await emitResponse({
            id: '',
            ok: false,
            protocol: protocolVersion,
            error: {
              code: code === 'PAYLOAD_TOO_LARGE' ? 'RESPONSE_TOO_LARGE' : 'INVALID_REQUEST',
              message: error instanceof Error ? error.message : String(error)
            }
          })
        })
        if (error instanceof NativeFramingError && error.code !== 'INVALID_JSON') {
          finish()
        }
      }
    })

    stdin.once('end', finish)
    stdin.once('close', finish)
    stdin.once('error', finish)
  })
}
