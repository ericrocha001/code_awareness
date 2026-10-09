import { randomBytes, timingSafeEqual } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { createServer, type Server, type Socket } from 'node:net'
import { object, text } from './request-validation'
import type { LocalChannelAdapter, LocalRequestContext } from './local-channel-types'

export const LOCAL_MAX_BYTES = 8 * 1024 * 1024
export const LOCAL_TIMEOUT_MS = 15_000
function fail(code: string): never { throw new Error(code) }

export class LocalChannelHost {
  private server?: Server
  private readonly sockets = new Set<Socket>()
  private readonly token = randomBytes(32).toString('hex')
  private readonly descriptors: string[] = []
  constructor(private readonly adapters: readonly LocalChannelAdapter[], private readonly profile: string) {
    if (new Set(adapters.map(adapter => adapter.domain)).size !== adapters.length || adapters.some(adapter => adapter.domain === 'channel')) fail('INVALID_ARGUMENT')
  }

  async start(): Promise<void> {
    if (this.server) fail('CHANNEL_ALREADY_STARTED')
    const directory = join(this.profile, 'local-agent-channel')
    const legacyDirectory = join(this.profile, 'continuum-local')
    for (const folder of [directory, legacyDirectory]) {
      mkdirSync(folder, { recursive: true, mode: 0o700 })
      if (process.platform === 'win32') {
        const sid = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'], { encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim()
        if (!/^S-1-\d+(?:-\d+)+$/.test(sid)) fail('AUTHORIZATION_UNAVAILABLE')
        execFileSync('icacls.exe', [folder, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`], { windowsHide: true, timeout: 5000, stdio: 'pipe' })
      }
    }
    // Existing clients validate this pipe prefix before connecting.
    const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\code-awareness-continuum-${randomBytes(24).toString('hex')}` : join(directory, 'channel.sock')
    const server = createServer(socket => this.accept(socket))
    this.server = server
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(endpoint, () => { server.off('error', reject); resolve() }) })
      server.on('error', () => this.dispose())
      for (const [folder, protocol] of [[directory, 'code-awareness-local/v1'], [legacyDirectory, 'continuum-local/v1']]) {
        const descriptor = join(folder, 'endpoint.json')
        writeFileSync(descriptor + '.tmp', JSON.stringify({ protocol, endpoint, token: this.token }), { mode: 0o600 })
        renameSync(descriptor + '.tmp', descriptor)
        this.descriptors.push(descriptor)
      }
    } catch (error) { this.dispose(); throw error }
  }

  dispose(): void {
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    this.server?.close(); this.server = undefined
    for (const descriptor of this.descriptors.splice(0)) { try { unlinkSync(descriptor) } catch {} }
  }

  private accept(socket: Socket): void {
    if (this.sockets.size >= 16) { socket.destroy(); return }
    this.sockets.add(socket)
    socket.on('error', () => socket.destroy())
    socket.once('close', () => this.sockets.delete(socket))
    const deadline = setTimeout(() => socket.destroy(), LOCAL_TIMEOUT_MS)
    socket.once('close', () => clearTimeout(deadline))
    let chunks: Buffer[] = [], bytes = 0, handled = false
    socket.on('data', chunk => {
      if (handled) return
      bytes += chunk.length
      if (bytes > LOCAL_MAX_BYTES) { handled = true; socket.end(JSON.stringify({ error: { code: 'REQUEST_TOO_LARGE' } }) + '\n'); return }
      chunks.push(chunk)
      if (!chunk.includes(10)) return
      handled = true
      const raw = Buffer.concat(chunks); chunks = []
      void (async () => {
        try {
          if (raw.indexOf(10) !== raw.length - 1) fail('INVALID_ARGUMENT')
          const result = await this.dispatch(JSON.parse(raw.subarray(0, -1).toString('utf8')), () => !socket.destroyed)
          const response = JSON.stringify({ result }) + '\n'
          if (Buffer.byteLength(response) > LOCAL_MAX_BYTES * 2) fail('RESPONSE_TOO_LARGE')
          socket.end(response)
        } catch (error) {
          const message = error instanceof Error ? error.message : ''
          const explicit = (error as { code?: string })?.code
          const code = /^[A-Z][A-Z0-9_]{2,64}$/.test(explicit ?? '') ? explicit : /^([A-Z][A-Z0-9_]{2,64})(?::|$)/.exec(message)?.[1] ?? (error instanceof SyntaxError ? 'INVALID_ARGUMENT' : 'INTERNAL_ERROR')
          socket.end(JSON.stringify({ error: { code } }) + '\n')
        }
      })()
    })
  }

  private async dispatch(input: unknown, connected: () => boolean): Promise<unknown> {
    const value = object(input)
    const supplied = typeof value.token === 'string' ? Buffer.from(value.token) : Buffer.alloc(0)
    const expected = Buffer.from(this.token)
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) fail('UNAUTHORIZED')
    let domain: string, action: string, args: unknown
    if (value.protocol === 'continuum-local/v1') {
      const { protocol, token, operation, ...legacyArgs } = value
      domain = 'continuum'; action = text(operation); args = legacyArgs
    } else {
      object(value, ['protocol', 'token', 'domain', 'action', 'args'])
      if (value.protocol !== 'code-awareness-local/v1') fail('INVALID_ARGUMENT')
      domain = text(value.domain); action = text(value.action); args = value.args
    }
    if (domain === 'channel' && action === 'status') {
      object(args, [])
      return { available: true, domains: this.adapters.map(adapter => adapter.domain) }
    }
    const adapter = this.adapters.find(adapter => adapter.domain === domain)
    if (!adapter || !Object.hasOwn(adapter.operations, action)) fail('METHOD_NOT_FOUND')
    const context: LocalRequestContext = { connected }
    if (!connected()) fail('IPC_CLOSED')
    return adapter.operations[action].execute(args, context)
  }
}
