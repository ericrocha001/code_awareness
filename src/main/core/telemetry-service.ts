/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Gerar correlation IDs de 8 caracteres hexadecimais para rastrear operações ponta a ponta.
2. Emitir logs estruturados no console do main process com formato correlacionado.

Mapa de Relacionamentos do Script

1. watcher-bridge.ts
   - Tipo: Dependência Inversa
   - Relação: Inicia operações e registra a entrada da cadeia (WATCHER).
   - Criticidade: Alta

2. repository-synchronizer.ts
   - Tipo: Dependência Inversa
   - Relação: Registra recepção de eventos e lotes de reindexação (CHANGE_DETECTION).
   - Criticidade: Alta

3. repository-model.ts
   - Tipo: Dependência Inversa
   - Relação: Registra indexação completa e reindexação seletiva (CODE_MAP).
   - Criticidade: Alta

Invariantes do Script

1. Nenhum método deste módulo jamais lança exceção — falhas internas de telemetria nunca podem afetar o sistema observado.
2. A serialização de payload é à prova de referência circular, com fallback textual seguro.
3. O módulo é um singleton do main process, exportado diretamente como instância única.
4. O módulo não conhece Watcher, Synchronizer, Model, banco ou IPC — depende apenas de 'crypto' do Node.

--- FIM ARQUITETURA DO SCRIPT ---
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
