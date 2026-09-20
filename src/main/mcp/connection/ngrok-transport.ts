import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { ConnectionError, type ConnectionConfiguration, type ConnectionTransportPort, type TransportState } from './connection-transport-port'
import type { ConnectionErrorCode } from '../../../shared/types/connection-types'

type SpawnAgent = (args: string[]) => ChildProcess

export class NgrokTransport implements ConnectionTransportPort {
  readonly name = 'ngrok'
  private state: TransportState = { status: 'STOPPED' }
  private child: ChildProcess | null = null
  private closed: Promise<void> = Promise.resolve()
  private starting: Promise<{ externalEndpoint: string }> | null = null
  private stopping: Promise<void> | null = null
  private binding: string | null = null
  private cancelStartup: (() => void) | null = null
  private readonly listeners = new Set<(state: TransportState) => void>()

  constructor(
    private readonly spawnAgent: SpawnAgent = (args) => spawn('ngrok', args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }),
    private readonly startupTimeoutMs = 20_000,
    private readonly probe: (endpoint: string, signal: AbortSignal) => Promise<boolean> = async (endpoint, signal) => {
      const response = await fetch(endpoint, { signal, headers: { 'ngrok-skip-browser-warning': 'true' } })
      await response.body?.cancel()
      return response.ok || response.status === 405
    }
  ) {}

  getState(): TransportState { return { ...this.state } }

  onChanged(listener: (state: TransportState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  start(localEndpoint: string, configuration: ConnectionConfiguration, signal: AbortSignal): Promise<{ externalEndpoint: string }> {
    if (this.starting) return this.starting
    const operation = this.launch(localEndpoint, configuration, signal)
    this.starting = operation
    void operation.finally(() => { if (this.starting === operation) this.starting = null }).catch(() => {})
    return operation
  }

  private async launch(localEndpoint: string, configuration: ConnectionConfiguration, signal: AbortSignal): Promise<{ externalEndpoint: string }> {
    if (this.stopping) await this.stopping
    const domain = configuration.publicDomain
    if (!domain) throw new ConnectionError('NGROK_DOMAIN_NOT_CONFIGURED')
    if (typeof domain !== 'string' || domain.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(domain)) {
      throw new ConnectionError('NGROK_DOMAIN_INVALID')
    }
    const local = new URL(localEndpoint)
    if (local.protocol !== 'http:' || local.hostname !== '127.0.0.1' || !local.port || local.pathname !== '/mcp' || local.search || local.hash || local.username || local.password) {
      throw new ConnectionError('MCP_NOT_RUNNING')
    }
    const externalEndpoint = `https://${domain.toLowerCase()}/mcp`
    const binding = `${localEndpoint}|${externalEndpoint}`
    if (this.state.status === 'RUNNING' && binding === this.binding) return { externalEndpoint }
    await this.stop()
    if (signal.aborted) throw new ConnectionError('NGROK_START_FAILED')
    this.setState({ status: 'STARTING' })
    let failure: ConnectionErrorCode = 'NGROK_START_FAILED'
    try {
      const child = this.spawnAgent(['http', local.origin, '--url', `https://${domain.toLowerCase()}`, '--inspect=false', '--log=stdout', '--log-format=json', '--log-level=info'])
      this.child = child
      this.closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
      await new Promise<void>((resolve, reject) => {
        let settled = false
        const finish = (error?: ConnectionErrorCode) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          signal.removeEventListener('abort', abort)
          this.cancelStartup = null
          if (error) reject(new ConnectionError(error))
          else resolve()
        }
        const abort = () => finish('NGROK_START_FAILED')
        const timer = setTimeout(() => finish('NGROK_START_TIMEOUT'), this.startupTimeoutMs)
        this.cancelStartup = abort
        signal.addEventListener('abort', abort, { once: true })
        child.on('error', (error: NodeJS.ErrnoException) => {
          failure = error.code === 'ENOENT' ? 'NGROK_NOT_FOUND' : 'NGROK_START_FAILED'
          finish(failure)
        })
        child.once('close', () => {
          finish(failure)
          if (this.child === child && !this.stopping && this.state.status === 'RUNNING') {
            this.child = null
            this.binding = null
            this.setState({ status: 'ERROR', error: 'NGROK_EXITED' })
          }
        })
        const streams = [child.stdout, child.stderr].filter((stream) => stream !== null)
        const readers = streams.map((stream) => createInterface({ input: stream! }))
        for (const reader of readers) reader.on('line', (line: string) => {
          if (/ERR_NGROK_(4018|105|107|108)\b/.test(line)) failure = 'NGROK_NOT_AUTHENTICATED'
          try {
            const record = JSON.parse(line) as { msg?: string; url?: string }
            if (record.msg === 'started tunnel') {
              if (record.url !== `https://${domain.toLowerCase()}`) finish('TRANSPORT_IDENTITY_CHANGED')
              else finish()
            }
          } catch {}
        })
        child.once('close', () => readers.forEach((reader) => reader.close()))
        if (signal.aborted) abort()
      })
      const readiness = AbortSignal.any([signal, AbortSignal.timeout(this.startupTimeoutMs)])
      let ready = false
      while (!readiness.aborted && child.exitCode === null && child.signalCode === null) {
        try { ready = await this.probe(externalEndpoint, readiness) } catch {}
        if (ready) break
        try { await delay(150, undefined, { signal: readiness }) } catch {}
      }
      if (!ready) throw new ConnectionError(signal.aborted ? 'NGROK_START_FAILED' : 'NGROK_START_TIMEOUT')
      if (signal.aborted || child.exitCode !== null || child.signalCode !== null) throw new ConnectionError('NGROK_START_FAILED')
      this.binding = binding
      this.setState({ status: 'RUNNING', externalEndpoint })
      return { externalEndpoint }
    } catch (error) {
      await this.stop()
      const code = error instanceof ConnectionError ? error.code : 'NGROK_START_FAILED'
      this.setState({ status: 'ERROR', error: code })
      throw new ConnectionError(code)
    }
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping
    const child = this.child
    if (!child) { this.setState({ status: 'STOPPED' }); return Promise.resolve() }
    this.cancelStartup?.()
    const operation = Promise.resolve().then(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill()
      const force = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }, 2_000)
      try { await this.closed } finally { clearTimeout(force) }
      if (this.child === child) this.child = null
      this.binding = null
      this.setState({ status: 'STOPPED' })
    })
    this.stopping = operation
    void operation.finally(() => { if (this.stopping === operation) this.stopping = null }).catch(() => {})
    return operation
  }

  private setState(state: TransportState): void {
    this.state = state
    for (const listener of this.listeners) { try { listener({ ...state }) } catch {} }
  }
}
