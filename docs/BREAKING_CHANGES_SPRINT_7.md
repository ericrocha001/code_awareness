# Breaking Changes — Sprint 7

Este documento registra formalmente as mudanças de contrato introduzidas na **Sprint 7 (Portas CodeMap + Separação de Testes)** e mantidas na **Sprint 8**. Visa orientar consumidores externos e futuros desenvolvedores sobre a migração necessária.

---

## 1. `CodeMapService` — Construtor agora exige `CompressionPort`

### Mudança

O construtor de `CodeMapService` passou a **exigir** um `CompressionPort` obrigatório. Antes, a instância de compressão era criada internamente (com um `ContentIdentityProvider` que capturava o mapa global `instances` via closure); agora, a dependência é injetada pelo bootstrap.

```ts
// Antes (Sprint 6 e anteriores)
const service = new CodeMapService(watcherService) // compression opcional, criado internamente

// Depois (Sprint 7 em diante)
const service = new CodeMapService(watcherService, compressionService) // obrigatório
```

### Exemplo de migração (padrão de bootstrap em `main.ts`)

A composição é centralizada no bootstrap, e a implementação concreta de `ContentIdentityPort` delega ao `CodeMapService` para reuso dos hashes SHA-256 já indexados:

```ts
let codeMapService: CodeMapService | null = null
const contentIdentityProvider: ContentIdentityPort = {
  getContentHash: (repoPath, relativePath) => {
    if (!codeMapService) return Promise.resolve(null)
    const contentHash = codeMapService.getFileContentHash(repoPath, relativePath)
    return Promise.resolve(contentHash)
  }
}
const compressionService = new CompressionService(undefined, contentIdentityProvider)
codeMapService = getCodeMapService(watcherService, compressionService)
```

A fábrica `getCodeMapService(watcherService, compressionService)` também passou a receber a porta.

### Portas de referência

- `src/main/core/compression-port.ts` — `CompressionPort`
- `src/main/core/content-identity-port.ts` — `ContentIdentityPort`

---

## 2. `CompressionService` — `ContentIdentityProvider` (function type) removido

### Mudança

O tipo `ContentIdentityProvider` (function type `(repoPath, relativePath) => Promise<string | null>`) foi **removido** em toda a base de código. O `CompressionService` agora depende diretamente da interface **`ContentIdentityPort`** (método `getContentHash`), sem adaptação interna (`toContentIdentityProvider` eliminado).

```ts
// Antes — injetava um function type
new CompressionService(adapter, async (repo, file) => hash)

// Depois — injeta um ContentIdentityPort
new CompressionService(adapter, {
  getContentHash: async (repo, file) => hash
})
```

### Importação da porta

A porta é a fonte única de definição:

```ts
import type { ContentIdentityPort } from './content-identity-port'
```

A função `resolveContentIdentity` (em `compression-content-identity.ts`) também passou a aceitar `ContentIdentityPort`.

---

## Impacto em testes

Testes que construíam `CompressionService` com provider como função devem passar a injetar `{ getContentHash: ... }`. Testes de `resolveContentIdentity` que injetavam um provider mockado como função devem usar `{ getContentHash: vi.fn()... }` e verificar `provider.getContentHash`.
