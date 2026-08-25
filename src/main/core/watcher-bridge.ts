/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Adaptar o WatcherService para o Event Bus do Repository Model via assinatura por raiz.
2. Escutar notificações de alteração de arquivo e republicar como eventos estruturados.
3. Mapear caminho absoluto para caminho relativo antes de emitir.

Mapa de Relacionamentos do Script

1. watcher-service.ts
   - Tipo: Dependência Direta
   - Relação: Assina o evento de alteração de arquivos de uma raiz no WatcherService.
   - Criticidade: Alta

2. repository-events.ts
   - Tipo: Dependência Direta
   - Relação: Emite eventos no Event Bus.
   - Criticidade: Alta

3. telemetry-service.ts
   - Tipo: Dependência Direta
   - Relação: Inicia a operação e registra EVENT_BRIDGED.
   - Criticidade: Alta

4. code-map-service.ts
   - Tipo: Dependência Inversa
   - Relação: Cria a ponte ao abrir um repositório e executa a desassinatura ao fechar.
   - Criticidade: Alta

Invariantes do Script

1. O Bridge emite file:modified para todas as alterações (não distingue created/deleted).
2. O Bridge ignora arquivos fora do repositório ativo (caminho não começa com repoPath).
3. O Bridge converte caminho absoluto para relativo antes de emitir.
4. O Bridge não faz parsing, análise ou persistência — apenas adapta eventos.
5. A criação da ponte retorna uma função de desassinatura que encerra apenas a própria escuta.

--- FIM ARQUITETURA DO SCRIPT ---
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