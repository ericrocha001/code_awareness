import { createConnection, type Socket } from 'node:net'
import type { DevSyncSupervisorReceipt } from './dev-sync-types'

export interface IDevSyncSupervisorClient {
  isAvailable(): boolean
  reserve(operationId: string): Promise<boolean>
  cancel(operationId: string): Promise<boolean>
  commit(params: {
    operationId: string
    origin: { rootPath: string; branch: string }
    expectedHead: string
    oldInstanceId?: string
  }): Promise<boolean>
  announceReady(params: {
    instanceId: string
    startupHead: string
    sourceOrigin?: unknown
    freshness?: unknown
  }): Promise<boolean>
  getStatus(operationId?: string): Promise<DevSyncSupervisorReceipt | null>
}

export class DevSyncSupervisorClient implements IDevSyncSupervisorClient {
  constructor(
    private readonly endpoint = process.env.CODE_AWARENESS_DEV_SUPERVISOR_ENDPOINT,
    private readonly token = process.env.CODE_AWARENESS_DEV_SUPERVISOR_TOKEN
  ) {}

  isAvailable(): boolean {
    return Boolean(this.endpoint && this.token && /^\d+$/.test(this.endpoint))
  }

  private async executeCommand(payload: Record<string, unknown>): Promise<string | null> {
    if (!this.isAvailable()) return null
    try {
      const socket = createConnection({ host: '127.0.0.1', port: Number(this.endpoint) })
      const response = await this.exchange(socket, JSON.stringify({ ...payload, token: this.token }))
      socket.end()
      return response
    } catch {
      return null
    }
  }

  private exchange(socket: Socket, payload: string): Promise<string> {
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
      socket.once('connect', onConnect)
    })
  }

  async reserve(operationId: string): Promise<boolean> {
    const response = await this.executeCommand({ action: 'DEV_SYNC_PREPARE', operationId })
    return response === 'READY'
  }

  async cancel(operationId: string): Promise<boolean> {
    const response = await this.executeCommand({ action: 'DEV_SYNC_CANCEL', operationId })
    return response === 'RELEASED'
  }

  async commit(params: {
    operationId: string
    origin: { rootPath: string; branch: string }
    expectedHead: string
    oldInstanceId?: string
  }): Promise<boolean> {
    const response = await this.executeCommand({
      action: 'DEV_SYNC_COMMIT',
      ...params
    })
    return response === 'ACK'
  }

  async announceReady(params: {
    instanceId: string
    startupHead: string
    sourceOrigin?: unknown
    freshness?: unknown
  }): Promise<boolean> {
    const response = await this.executeCommand({
      action: 'RUNTIME_READY',
      ...params
    })
    return response === 'ACK'
  }

  async getStatus(operationId?: string): Promise<DevSyncSupervisorReceipt | null> {
    const response = await this.executeCommand({ action: 'GET_DEV_SYNC_STATUS', operationId })
    if (!response) return null
    try {
      const parsed = JSON.parse(response) as DevSyncSupervisorReceipt
      return parsed.status === 'NONE' ? null : parsed
    } catch {
      return null
    }
  }
}
