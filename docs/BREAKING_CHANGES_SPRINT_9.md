# Breaking Changes — Sprint 9

Este documento registra as mudanças de contrato introduzidas na **Sprint 9 (Remover Singleton Global + Refinamentos da Auditoria Sprint 8)**.

---

## 1. `getCompressionService` removido — injeção explícita no bootstrap

### Mudança

A fábrica singleton `getCompressionService()` e a variável de estado global `compressionServiceInstance` foram **removidas** do `compression-service.ts`. O `CompressionService` agora é instanciado **uma única vez** no bootstrap (`main.ts`) e injetado por parâmetro nos consumidores.

```ts
// Antes (Sprint 8 e anteriores)
import { getCompressionService } from '../core/compression-service'
const compressionService = getCompressionService() // singleton global

// Depois (Sprint 9 em diante) — no bootstrap (main.ts)
const compressionService = new CompressionService(undefined, contentIdentityProvider)
// injetado em registerGitHandlers
registerGitHandlers(watcherService, settingsService, compressionService)
```

### Impacto em consumidores

- **`git-handler.ts`**: `registerGitHandlers(watcherService, settingsService, compressionService)` agora recebe a instância como terceiro parâmetro (antes usava o singleton internamente).
- **`code-map-service.ts`**: não sofreu alteração nesta sprint — já não utilizava o singleton.

---

## 2. `ContentIdentityProvider` / `ContentIdentityPort` e a guarda defensiva

A `ContentIdentityPort` composta no `main.ts` ganhou **guarda defensiva com log de warning em desenvolvimento**, retornando `null` se o `codeMapService` ainda não estiver inicializado:

```ts
if (!codeMapService) {
  if (process.env.NODE_ENV === 'development') {
    console.warn('[main] getContentHash chamado antes da inicialização do codeMapService')
  }
  return Promise.resolve(null)
}
```

> Nota: a recomendação da auditoria era baseada em código onde esta guarda ainda não existia. Na Sprint 8 ela já havia sido adicionada (retornando `null`); a Sprint 9 adiciona o log de warning em desenvolvimento.

---

## 3. `BaseRepomixAdapter.runProcess` — divergência documentada (R2)

A assinatura do `runProcess` permanece `runProcess(command, args, options): Promise<RunProcessResult>` (retornando `{ exitCode, stdout, stderr }`). A divergência em relação à especificação original da Sprint 8 (`runProcess(command, args, cwd, timeoutMs): Promise<string>`) está agora **documentada no JSDoc** do método, para evitar que tentativas de "correção" quebrem os chamadores de retry/fallback em lote.

```ts
protected runProcess(command: string, args: string[], options: RunProcessOptions): Promise<RunProcessResult>
```

---

## Impacto em testes

A suíte `compression-service.test.ts` já instanciava `CompressionService` diretamente com mocks — portanto não foi afetada pela remoção da fábrica. Nenhum teste dependia de `getCompressionService`.