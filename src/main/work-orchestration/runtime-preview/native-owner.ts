import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { z } from 'zod'

export const rootExitSchema = z.object({
  status: z.enum(['KNOWN', 'UNKNOWN']), code: z.number().int().min(0).max(0xffffffff).nullable(),
  reasonCode: z.string().min(1).max(80), observedAt: z.string().max(64).nullable()
}).strict().refine(value => value.status === 'KNOWN' ? value.code !== null && value.observedAt !== null : value.code === null)
export const nativeObservation = z.object({
  pid: z.number().int().nonnegative(), created: z.string().nullable(), rootSignaled: z.boolean(), knownHandlesClosed: z.boolean(),
  activeProcesses: z.number().int().nonnegative(), jobClosed: z.boolean(), eventClosed: z.boolean(),
  assignedAtCreation: z.boolean(), ownerOutsideJob: z.boolean(), phase: z.string(), rootExit: rootExitSchema.optional()
}).strict()
export type NativeObservation = z.infer<typeof nativeObservation>
export interface NativeLaunch {
  sessionId: string; operationId: string; directory: string; slotKey: string; executable: string; executableHash: string; cwd: string;
  args: string[]; env: Record<string, string>; spawn: 'JOB_LIST_AT_CREATE'; graceful: 'SESSION_EVENT' | 'NONE';
  graceMs: number; forceMs: number; hostPid: number
}
export class NativeOwner {
  private readonly process: ChildProcessWithoutNullStreams
  private sequence = 0
  private pending?: { id: number; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  private exited = false
  readonly finished: Promise<void>
  constructor(executable: string) {
    if (process.platform !== 'win32') throw new Error('WINDOWS_REQUIRED')
    this.process = spawn(executable, [], { shell: false, windowsHide: true, env: { SystemRoot: process.env.SystemRoot }, stdio: 'pipe' })
    this.finished = new Promise(resolve => this.process.once('close', () => resolve()))
    let bytes = 0
    this.process.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > 65536) { this.fail(new Error('NATIVE_OUTPUT_LIMIT')); this.close() }
    })
    const lines = createInterface({ input: this.process.stdout })
    lines.on('line', line => {
      bytes = 0
      try {
        if (line.length > 65536) throw new Error('NATIVE_RESPONSE_LIMIT')
        const value = JSON.parse(line)
        if (!this.pending || value.id !== this.pending.id || typeof value.success !== 'boolean') throw new Error('NATIVE_PROTOCOL_ERROR')
        const pending = this.pending; this.pending = undefined; clearTimeout(pending.timer)
        if (value.success) pending.resolve(value.result)
        else pending.reject(new Error(`NATIVE_FAILURE:${value.code}:${value.win32}`))
      } catch (error) { this.fail(error instanceof Error ? error : new Error('NATIVE_PROTOCOL_ERROR')); this.close() }
    })
    this.process.stderr.resume()
    this.process.on('error', error => this.fail(error))
    this.process.on('exit', () => { this.exited = true; this.fail(new Error('OWNER_LOST')) })
    this.process.stdin.on('error', error => this.fail(error))
  }
  private fail(error: Error) {
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(error); this.pending = undefined }
  }
  get available() { return !this.exited }
  private request(action: 'start' | 'inspect' | 'stop' | 'reconcile' | 'endpoint' | 'processes', fields: Record<string, unknown> = {}, timeout = 10000): Promise<unknown> {
    if (this.exited || this.pending) return Promise.reject(new Error(this.exited ? 'OWNER_LOST' : 'NATIVE_REQUEST_BUSY'))
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.fail(new Error('OWNER_UNRESPONSIVE')); this.close() }, timeout)
      this.pending = { id, resolve, reject, timer }
      this.process.stdin.write(JSON.stringify({ id, action, ...fields }) + '\n')
    })
  }
  async start(launch: NativeLaunch) { return nativeObservation.parse(await this.request('start', { launch })) }
  async inspect() { return nativeObservation.parse(await this.request('inspect')) }
  async endpoint(port: number) {
    return z.object({ port: z.number().int(), listeners: z.array(z.object({ pid: z.number().int().positive(), created: z.string(), member: z.boolean(), loopback: z.boolean() }).strict()).max(128) }).strict().parse(await this.request('endpoint', { port }))
  }
  async processes() {
    return z.object({ processes: z.array(z.object({ pid: z.number().int().positive(), created: z.string() }).strict()).max(128) }).strict().parse(await this.request('processes'))
  }
  reconcile(sessionId: string, pid: number, created: string | null) { return this.request('reconcile', { sessionId, pid, created }) }
  async stop(graceMs: number, forceMs: number, graceful: boolean) {
    return nativeObservation.parse(await this.request('stop', { graceMs, forceMs, graceful }, graceMs + forceMs + 10000))
  }
  close() { this.process.stdin.end() }
  async shutdown() {
    this.close()
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([this.finished, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('SUPERVISOR_EXIT_UNVERIFIED')), 5000) })])
    } finally { if (timer) clearTimeout(timer) }
  }
}
