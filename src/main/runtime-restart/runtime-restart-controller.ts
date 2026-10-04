import { createConnection, type Socket } from 'node:net'
import type { RuntimeIdentityProvider } from '../runtime-identity/runtime-identity-provider'

export type RuntimeRestartStatus = 'SCHEDULED' | 'UNSUPPORTED' | 'INSTANCE_MISMATCH' | 'RESTART_NOT_REQUIRED' | 'RESTART_ALREADY_SCHEDULED'

export interface RestartPreparation {
  commit(): Promise<void>
}

export interface RestartSupervisorClient {
  prepare(): Promise<RestartPreparation | null>
}

export interface RuntimeRestartResult {
  status: RuntimeRestartStatus
  message: string
  postResponse?: () => Promise<void>
}

export class EnvironmentRestartSupervisorClient implements RestartSupervisorClient {
  constructor(
    private readonly endpoint = process.env.CODE_AWARENESS_DEV_SUPERVISOR_ENDPOINT,
    private readonly token = process.env.CODE_AWARENESS_DEV_SUPERVISOR_TOKEN
  ) {}

  async prepare(): Promise<RestartPreparation | null> {
    if (!this.endpoint || !this.token || !/^\d+$/.test(this.endpoint)) return null
    const socket = createConnection({ host: '127.0.0.1', port: Number(this.endpoint) })
    const response = await exchange(socket, JSON.stringify({ action: 'PREPARE', token: this.token }))
    if (response !== 'READY') {
      socket.destroy()
      return null
    }
    return {
      commit: async () => {
        const committed = await exchange(socket, JSON.stringify({ action: 'COMMIT', token: this.token }), false)
        socket.end()
        if (committed !== 'ACK') throw new Error('SUPERVISOR_COMMIT_FAILED')
      }
    }
  }
}

function exchange(socket: Socket, payload: string, connect = true): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const cleanup = () => {
      socket.off('error', onError)
      socket.off('data', onData)
      socket.off('connect', onConnect)
    }
    const onError = (error: Error) => { cleanup(); reject(error) }
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      cleanup()
      resolve(buffer.slice(0, newline))
    }
    const onConnect = () => socket.write(`${payload}\n`)
    socket.on('error', onError)
    socket.on('data', onData)
    if (connect) socket.once('connect', onConnect)
    else socket.write(`${payload}\n`)
  })
}

export class RuntimeRestartController {
  private scheduled = false

  constructor(
    private readonly runtimeIdentity: RuntimeIdentityProvider,
    private readonly supervisor: RestartSupervisorClient,
    private readonly requestShutdown: () => void
  ) {}

  async request(expectedInstanceId: string): Promise<RuntimeRestartResult> {
    const runtime = this.runtimeIdentity.getRuntimeInfo()
    if (runtime.mode !== 'development') return { status: 'UNSUPPORTED', message: 'Runtime restart is supported only in development.' }
    if (expectedInstanceId !== runtime.instanceId) return { status: 'INSTANCE_MISMATCH', message: 'The expected instance does not match the running instance.' }
    if (this.scheduled) return { status: 'RESTART_ALREADY_SCHEDULED', message: 'A runtime restart is already scheduled.' }
    const identity = this.runtimeIdentity.getIdentityPayload()
    if (identity.freshness.state !== 'SOURCE_CHANGED_SINCE_START' || identity.freshness.divergence?.recommendedAction !== 'RESTART_RUNTIME') {
      return { status: 'RESTART_NOT_REQUIRED', message: 'Runtime Identity does not recommend a restart.' }
    }
    let preparation: RestartPreparation | null
    try {
      preparation = await this.supervisor.prepare()
    } catch {
      preparation = null
    }
    if (!preparation) return { status: 'UNSUPPORTED', message: 'The development supervisor is not available.' }
    this.scheduled = true
    return {
      status: 'SCHEDULED',
      message: 'Restart scheduled. The current connection will close. After Code Awareness returns, run Atualizar ações in the ChatGPT plugin/connector before using the tools again.',
      postResponse: async () => {
        await preparation.commit()
        this.requestShutdown()
      }
    }
  }
}
