/*
-T ---
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