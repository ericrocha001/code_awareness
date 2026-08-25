/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Prover um Event Bus global para eventos de alteração de arquivos no repositório.
2. Publicar eventos file:modified, file:created, file:deleted e file:confirmed.
3. Permitir que múltiplos consumidores assinem os eventos.
4. Transportar o correlation ID opcional junto ao evento para manter a cadeia de observabilidade contínua.

Mapa de Relacionamentos do Script

1. watcher-bridge.ts
   - Tipo: Dependência Inversa
   - Relação: Emite eventos no Event Bus ao receber notificações do WatcherService.
   - Criticidade: Alta

2. repository-synchronizer.ts (Sprint 5)
   - Tipo: Dependência Inversa
   - Relação: Assina eventos para disparar reindexação seletiva.
   - Criticidade: Alta

3. outros consumidores futuros (Code Journey, Diff Service, AI Context)
   - Tipo: Dependência Inversa
   - Relação: Podem assinar eventos para reagir a alterações.
   - Criticidade: Média

Invariantes do Script

1. O Event Bus é um singleton — uma única instância compartilhada por todo o main process.
2. O Event Bus não conhece o WatcherService nem o Synchronizer — apenas emite e recebe eventos.
3. Eventos são publicados com o caminho relativo do arquivo, nunca o caminho absoluto.
4. O Event Bus não faz buffering de eventos — se não houver assinante, o evento é perdido.
5. O evento file:confirmed carrega caminho relativo e nunca é bufferizado, com a mesma semântica dos demais eventos.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { EventEmitter } from 'events'

export type RepositoryEventType = 'file:modified' | 'file:created' | 'file:deleted' | 'file:confirmed'

export interface RepositoryFileEvent {
  repositoryId: string
  relativePath: string
  /** Correlation ID de observabilidade (opcional, retrocompatível). */
  correlationId?: string
}

class RepositoryEventBus extends EventEmitter {
  emitFileModified(repositoryId: string, relativePath: string, correlationId?: string): void {
    this.emit(
      'file:modified',
      { repositoryId, relativePath, correlationId } satisfies RepositoryFileEvent
    )
  }

  emitFileCreated(repositoryId: string, relativePath: string, correlationId?: string): void {
    this.emit('file:created', { repositoryId, relativePath, correlationId } satisfies RepositoryFileEvent)
  }

  emitFileDeleted(repositoryId: string, relativePath: string, correlationId?: string): void {
    this.emit('file:deleted', { repositoryId, relativePath, correlationId } satisfies RepositoryFileEvent)
  }

  onFileModified(handler: (event: RepositoryFileEvent) => void): void {
    this.on('file:modified', handler)
  }

  onFileCreated(handler: (event: RepositoryFileEvent) => void): void {
    this.on('file:created', handler)
  }

  onFileDeleted(handler: (event: RepositoryFileEvent) => void): void {
    this.on('file:deleted', handler)
  }

  emitFileConfirmed(repositoryId: string, relativePath: string, correlationId?: string): void {
    this.emit(
      'file:confirmed',
      { repositoryId, relativePath, correlationId } satisfies RepositoryFileEvent
    )
  }

  onFileConfirmed(handler: (event: RepositoryFileEvent) => void): void {
    this.on('file:confirmed', handler)
  }
}

export const repositoryEventBus = new RepositoryEventBus()