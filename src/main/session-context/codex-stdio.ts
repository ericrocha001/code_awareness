import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

export interface CodexProfile { executable: string; directory: string }
export function spawnCodex(profile: CodexProfile, args: string[], root: string): ChildProcessWithoutNullStreams {
  return spawn(profile.executable, args, { cwd: root, env: { ...process.env, CODEX_HOME: profile.directory, NO_COLOR: '1' }, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
}
export function codexCommand(profile: CodexProfile, args: string[], root: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('PROVIDER_UNREACHABLE')); return }
    const child = spawnCodex(profile, args, root)
    let output = '', bytes = 0, stderr = 0, failed = false
    const stop = () => { failed = true; child.kill() }
    signal.addEventListener('abort', stop, { once: true })
    const timer = setTimeout(stop, 10000)
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', stop) }
    child.stdin.on('error', stop)
    child.stdin.end()
    child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 32768) stop(); else output += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.length; if (stderr > 65536) stop() })
    child.once('error', () => { finish(); reject(new Error('EXECUTABLE_UNAVAILABLE')) })
    child.once('close', code => { finish(); if (failed || code !== 0) reject(new Error('PROTOCOL_UNSUPPORTED')); else resolve(output) })
  })
}
type Method = 'initialize' | 'account/read' | 'thread/list'
export class CodexStdio {
  private serial = 0
  private closed = false
  private buffer = ''
  private readonly decoder = new StringDecoder('utf8')
  private pending?: { id: number; resolve: (value: unknown) => void; reject: (error: Error) => void; cleanup: () => void }
  constructor(private readonly child: ChildProcessWithoutNullStreams, private readonly invalidated: () => void) {
    let stderr = 0
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.closed) return
      this.buffer += this.decoder.write(chunk)
      if (Buffer.byteLength(this.buffer) > 256 * 1024) { this.close(); return }
      for (;;) {
        const index = this.buffer.indexOf('\n'); if (index < 0) break
        const line = this.buffer.slice(0, index); this.buffer = this.buffer.slice(index + 1)
        if (!line.trim()) continue
        let frame
        try { frame = JSON.parse(line) } catch { this.close(); return }
        if (!frame || typeof frame !== 'object') { this.close(); return }
        if (frame.method) {
          if (frame.id !== undefined) { this.child.stdin.write(JSON.stringify({ id: frame.id, error: { code: -32601, message: 'Unsupported read-only method' } }) + '\n'); this.close(); return }
          if (frame.method === 'account/updated') { this.close(); return }
          continue
        }
        const request = this.pending
        if (!request || frame.id !== request.id) continue
        this.pending = undefined; request.cleanup()
        if (frame.error) request.reject(new Error('PROTOCOL_UNSUPPORTED'))
        else if ('result' in frame) request.resolve(frame.result)
        else request.reject(new Error('PROTOCOL_UNSUPPORTED'))
      }
    })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.length; if (stderr > 65536) this.close() })
    child.once('error', () => this.close()); child.once('close', () => this.close())
    child.stdin.on('error', () => this.close())
  }
  request(method: Method, params: object, signal: AbortSignal): Promise<unknown> {
    if (!['initialize', 'account/read', 'thread/list'].includes(method)) return Promise.reject(new Error('PROTOCOL_UNSUPPORTED'))
    if (this.closed || signal.aborted) return Promise.reject(new Error('PROVIDER_UNREACHABLE'))
    if (this.pending) return Promise.reject(new Error('BACKPRESSURE'))
    return new Promise((resolve, reject) => {
      const id = ++this.serial, cancel = () => this.close(), timer = setTimeout(cancel, 5000)
      signal.addEventListener('abort', cancel, { once: true })
      this.pending = { id, resolve, reject, cleanup: () => { clearTimeout(timer); signal.removeEventListener('abort', cancel) } }
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
    })
  }
  initialized(): void { if (!this.closed) this.child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n') }
  close(): void {
    if (this.closed) return
    this.closed = true; this.buffer = ''
    const pending = this.pending; this.pending = undefined
    pending?.cleanup(); pending?.reject(new Error('PROVIDER_UNREACHABLE'))
    this.child.stdin.end(); this.child.kill(); this.invalidated()
  }
}
