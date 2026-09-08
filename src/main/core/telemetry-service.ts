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

/**
 * Serviço passivo de observabilidade do main process.
 * Observa e registra; nunca controla fluxo nem participa de decisões de negócio.
 * Toda falha interna é engolida silenciosamente (INVARIANT: nenhum método lança).
 */
class TelemetryService {
  /** Inicia uma operação e devolve o correlation ID de 8 caracteres hexadecimais. */
  startOperation(_operationType: string): string {
    return randomBytes(4).toString('hex')
  }

  /** Registra um log de debug correlacionado. */
  log(correlationId: string, component: TelemetryComponent, event: string, payload?: unknown): void {
    this.emitEntry(correlationId, component, event, payload, console.debug.bind(console))
  }

  /** Registra um log de erro correlacionado. */
  logError(
    correlationId: string,
    component: TelemetryComponent,
    event: string,
    payload?: unknown
  ): void {
    this.emitEntry(correlationId, component, event, payload, console.error.bind(console))
  }

  private emitEntry(
    correlationId: string,
    component: TelemetryComponent,
    event: string,
    payload: unknown | undefined,
    printer: (...args: unknown[]) => void
  ): void {
    try {
      const line = `[Telemetry][${correlationId}][${component}] ${event}`
      const serialized = payload === undefined ? '' : ` ${this.safeSerialize(payload)}`
      printer(line + serialized)
    } catch {
      // nunca lança — telemetria não pode derrubar o sistema observado
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
