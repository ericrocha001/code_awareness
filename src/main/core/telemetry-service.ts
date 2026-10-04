/*
-T ---
*/

import { randomBytes } from 'crypto'

export type TelemetryComponent =
  | 'WATCHER'
  | 'CHANGE_DETECTION'
  | 'PERSISTENCE'
  | 'CODE_MAP'
  | 'INTEGRITY'
  | 'GIT'

export interface TelemetryEntry {
  correlationId: string
  component: TelemetryComponent
  event: string
  payload?: unknown
  isError: boolean
  timestamp: number
}

export type TelemetrySubscriber = (entry: TelemetryEntry) => void

/**
 * Serviço passivo de observabilidade do main process.
 * Observa e registra; nunca controla fluxo nem participa de decisões de negócio.
 * Toda falha interna é engolida silenciosamente (INVARIANT: nenhum método lança).
 */
class TelemetryService {
  private readonly subscribers = new Set<TelemetrySubscriber>()

  /** Inicia uma operação e devolve o correlation ID de 8 caracteres hexadecimais. */
  startOperation(_operationType: string): string {
    return randomBytes(4).toString('hex')
  }

  /** Registra um log de debug correlacionado. */
  log(correlationId: string, component: TelemetryComponent, event: string, payload?: unknown): void {
    this.emitEntry(correlationId, component, event, payload, false, console.debug.bind(console))
  }

  /** Registra um log de erro correlacionado. */
  logError(
    correlationId: string,
    component: TelemetryComponent,
    event: string,
    payload?: unknown
  ): void {
    this.emitEntry(correlationId, component, event, payload, true, console.error.bind(console))
  }

  /**
   * Registra um subscriber para receber entradas de telemetria.
   * Retorna função de desassinatura. Non-throwing — erros do subscriber são engolidos.
   */
  subscribe(subscriber: TelemetrySubscriber): () => void {
    this.subscribers.add(subscriber)
    return () => this.subscribers.delete(subscriber)
  }

  private emitEntry(
    correlationId: string,
    component: TelemetryComponent,
    event: string,
    payload: unknown | undefined,
    isError: boolean,
    printer: (...args: unknown[]) => void
  ): void {
    try {
      const line = `[Telemetry][${correlationId}][${component}] ${event}`
      const serialized = payload === undefined ? '' : ` ${this.safeSerialize(payload)}`
      printer(line + serialized)
    } catch {
      // nunca lança — telemetria não pode derrubar o sistema observado
    }

    if (this.subscribers.size > 0) {
      const entry: TelemetryEntry = { correlationId, component, event, payload, isError, timestamp: Date.now() }
      for (const sub of this.subscribers) {
        try {
          sub(entry)
        } catch {
          // subscriber não pode derrubar a telemetria
        }
      }
    }
  }

  /** Serializa payload para JSON à prova de referência circular, com fallback textual seguro. */
  private safeSerialize(value: unknown): string {
    try {
      const seen = new WeakSet<object>()
      const json = JSON.stringify(value, (_key, v) => {
        if (typeof v === 'object' && v !== null) {
          if (seen.has(v)) {
            return '[Circular]'
          }
          seen.add(v)
        }
        return v
      })
      return json === undefined ? String(value) : json
    } catch {
      try {
        return String(value)
      } catch {
        return '[Unserializable]'
      }
    }
  }
}

/** Singleton do main process — instância única compartilhada por toda a cadeia. */
export const telemetryService = new TelemetryService()
