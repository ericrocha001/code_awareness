# Política de Binário Nativo (better-sqlite3) e Isolamento de Persistência

Este projeto utiliza `better-sqlite3`, um addon V8 nativo compilado exclusivamente para o runtime do Electron (ABI 123, Electron v30).

A partir das **Sprints 10 e 10.1**, toda a camada de domínio e a suíte de testes foram completamente desacopladas do binding nativo através do padrão de Arquitetura Hexagonal (Portas e Adaptadores) e runners segregados por ambiente.

---

## 1. Arquitetura de Isolamento

```text
[ Domínio / Handlers IPC ]
         │ (Injeção de Dependência via Interfaces)
         ▼
[ database-ports.ts ] (ActionLogPort, CheckpointCatalogPort, CampaignPort)
   ├── Implementação de Produção & E2E: [ BetterSqlite3DatabaseAdapter ] (Electron / SQLite Real)
   └── Implementação de Testes Domínio: [ FakePorts ] (Node / Vitest em Memória)
```

1. **Serviços de Domínio** (`CheckpointService`, `CampaignService`, `RestoreService`) e **Handlers IPC** não importam `better-sqlite3` nem executam SQL diretamente.
2. **Testes de Domínio** (`*.test.ts`) rodam diretamente no runtime Node/Vitest sem carregar o native addon e sem toggle de ABI.
3. **Testes de Infraestrutura e Persistência** (`*.e2e.test.ts` e `scripts/run-adapter-tests-electron.js`) rodam **exclusivamente no runtime Electron**, onde o ABI 123 é nativo.
4. O `vitest.config.ts` exclui `**/*.e2e.test.ts` da descoberta padrão, garantindo que `npm test` nunca tente carregar o binding nativo.
5. Um teste de fronteira automatizado (`database-runtime-boundary.test.ts`) descobre dinamicamente todos os testes de domínio e assegura contratualmente que nenhum importe `better-sqlite3` ou o adaptador concreto.

---

## 2. Comandos e Fluxo de Desenvolvimento

| Comando | Runtime | O que faz |
|---------|---------|-----------|
| `npm run dev` | Electron | Inicia o app Electron (usa o binário compilado para Electron 30). |
| `npm test` | Node / Vitest | Executa todos os testes de domínio (sem native addon e sem toggle). |
| `npm run test:domain` | Node / Vitest | Executa explicitamente a suíte de serviços de domínio e boundary. |
| `npm run test:db` | Electron | Executa a suíte de persistência do adapter no Electron (sem toggle). |
| `npm run test:compression` | Node / Vitest | Executa testes do pipeline de compressão. |
| `npm run test:git` | Node / Vitest | Executa testes de integração com Git e Diff. |
| `npm run native:electron` | Ferramenta | **Recuperação manual:** reinstala o binário do Electron 30 via `prebuild-install`. |
| `npm run native:node` | Ferramenta | **Recuperação manual:** reinstala o binário do Node via `prebuild-install`. |

> **Nota:** Os scripts `native:electron` e `native:node` permanecem apenas para fins de suporte e recuperação manual em caso de corrupção do `node_modules`. Nenhum script de teste automatizado invoca comandos de rebuild ou toggle de ABI.

---

## 3. Débitos Técnicos Documentados

> A migração `repo_path` na tabela `campaigns` foi aplicada na Sprint 11. Todas as queries da `CampaignPort` filtram por `repo_path`.

