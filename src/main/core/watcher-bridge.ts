/*
-T ---
*/

import { relative } from 'path'
import { WatcherService } from './watcher-service'
import { repositoryEventBus } from './repository-events'
import { telemetryService } from './telemetry-service'

/**
 * Registra o bridge entre o WatcherService e o Repository Event Bus para uma raiz.
 * Retorna a função de desassinatura do watcher.
 */
export function createWatcherBridge(repoPath: string, watcherService: WatcherService): () => void {
  const normalizedRepoPath = repoPath.replace(/\\/g, '/').replace(/\/$/, '')
  // No MVP, repositoryId é o próprio repoPath normalizado.
  const repositoryId = normalizedRepoPath

  return watcherService.subscribe(normalizedRepoPath, (absolutePath) => {
    // Ignora arquivos fora do repositório ativo (defesa em profundidade)
    if (!absolutePath.startsWith(normalizedRepoPath)) {
      return
    }

    const relativePath = relative(normalizedRepoPath, absolutePath).replace(/\\/g, '/')

    // Entrada da cadeia de observabilidade: nasce o correlation ID e registra o bridge.
    // Puramente aditivo — não altera o fluxo de emissão do evento.
    const correlationId = telemetryService.startOperation('WATCHER_EVENT')
    telemetryService.log(correlationId, 'WATCHER', 'EVENT_BRIDGED', { relativePath })

    // O WatcherService atual não distingue created/deleted — emite file:modified.
    repositoryEventBus.emitFileModified(repositoryId, relativePath, correlationId)
  })
}