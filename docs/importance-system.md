# Sistema de Importância Arquitetural

## Visão Geral

O Sistema de Importância Arquitetural classifica cada arquivo do repositório em 4 níveis de importância (critical, high, medium, low) baseado em heurísticas de nome, caminho e conteúdo. Isso permite ao usuário filtrar arquivos por importância e gerar markdown apenas com os arquivos mais relevantes, economizando tokens.

## Arquitetura

O sistema é composto por 4 camadas de heurísticas, orquestradas pelo `ImportanceService`:

```
Camada 1: Filtro de Exclusão Automática
   ↓ (arquivos que são ruído certo)
Camada 2: Heurísticas de Nome e Caminho
   ↓ (padrões estruturais conhecidos)
Camada 3: Heurísticas de Conteúdo (topo do arquivo)
   ↓ (comentários, tamanho, débito técnico)
Camada 4: Consolidação e Desempate
   ↓
Tag Final: critical | high | medium | low
```

## Camada 1: Filtro de Exclusão Automática

Classifica automaticamente como `low` arquivos que são ruído arquitetural certo.

### Extensões de Ruído
- Imagens: `.png`, `.jpg`, `.jpeg`, `.gif`, `.svg`, `.ico`, `.webp`, `.bmp`
- Vídeos/áudio: `.mp4`, `.mp3`, `.wav`, `.ogg`, `.avi`, `.mov`
- Archives: `.zip`, `.tar`, `.gz`, `.rar`, `.7z`
- Binários: `.exe`, `.dll`, `.so`, `.bin`, `.wasm`, `.pdf`
- Lockfiles: `.lock` (qualquer arquivo terminando em `.lock`)
- Build artifacts: `.tsbuildinfo`, `.map`, `.min.js`, `.min.css`

### Nomes de Arquivo de Ruído
- `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock`
- `Gemfile.lock`, `Cargo.lock`, `composer.lock`, `poetry.lock`
- `.DS_Store`, `Thumbs.db`, `desktop.ini`
- `.env.local`, `.env.*.local`

### Pastas de Ruído
- `node_modules/`, `dist/`, `build/`, `out/`, `.git/`, `.next/`, `.nuxt/`
- `coverage/`, `__pycache__/`, `.cache/`, `.svelte-kit/`, `.angular/`

## Camada 2: Heurísticas de Nome e Caminho

Calcula pontuação baseada em padrões estruturais de nome e caminho.

### Tabela de Pontuação

| Padrão | Pontos | Justificativa |
|--------|--------|---------------|
| Nome = `main.*`, `index.*`, `app.*`, `server.*`, `bootstrap.*` | +40 | Entry points são sempre críticos |
| Nome = `router.*`, `routes.*` | +35 | Orquestram navegação |
| Pasta contém `/core/`, `/domain/`, `/entities/` | +30 | Camada de domínio |
| Pasta contém `/services/`, `/usecases/`, `/application/` | +25 | Lógica de negócio |
| Pasta contém `/controllers/`, `/handlers/` | +20 | Camada de entrada |
| Nome = `types.*`, `interfaces.*`, `schemas.*`, `contracts.*` | +30 | Definem contratos |
| Nome = `constants.*`, `config.*` | +15 | Configuração |
| Pasta contém `/shared/`, `/common/`, `/utils/` | +10 | Utilitários compartilhados |
| Pasta contém `/components/`, `/pages/`, `/views/` | +5 | UI é importante, mas não crítica |
| Arquivo na raiz do projeto (0 níveis) | +15 | Arquivos raiz tendem a ser centrais |
| Arquivo 1 nível profundo | +10 | |
| Extensão = `.css`, `.scss`, `.sass`, `.less` | -10 | Estilo é ruído arquitetural |
| Nome contém `.test.*`, `.spec.*` | -15 | Testes não são arquiteturais |
| Pasta contém `/tests/`, `/__tests__/`, `/spec/` | -10 | |
| Arquivo 5+ níveis profundo | -5 | Muito aninhado |

**Regra de acumulação:** Se um arquivo está em `src/core/services/auth.ts`, ele ganha +30 (core) **E** +25 (services) = +55 pontos.

## Camada 3: Heurísticas de Conteúdo

Lê as primeiras 30 linhas do arquivo procurando por sinais de qualidade arquitetural.

### Sinais Positivos
- Bloco de comentário estruturado no topo (JSDoc, C-style): +5
- Docstring Python no topo: +5
- Arquivo tem 100-500 linhas (tamanho saudável): +5

### Sinais Negativos
- Arquivo tem < 10 linhas: -5
- Arquivo tem > 1000 linhas: -5
- Tem muitos TODO/FIXME/HACK (> 3): -3

### Gancho para Tríade Futura
A função `extractTriadSignals()` está preparada para detectar a tríade de documentação arquitetural (Responsabilidades, Relacionamentos, Invariantes) quando os arquivos começarem a seguir a convenção.

## Camada 4: Consolidação e Mapeamento

Consolida as pontuações das camadas anteriores e mapeia para os 4 níveis finais.

### Regras de Consolidação
1. Se a Camada 1 retornou `'low'`, retorna `'low'` imediatamente (filtro de exclusão vence)
2. Caso contrário, soma `namePathScore + contentScore`
3. Mapeia para o nível baseado nos thresholds:

| Pontuação Total | Nível |
|-----------------|-------|
| ≥ 50 | 🔴 `critical` |
| 25-49 | 🟠 `high` |
| 10-24 | 🟡 `medium` |
| < 10 | ⚪ `low` |

## Persistência e Cache

### Cache em Memória
- Chave: `${repoPath}::${relativePath}`
- Validação: `mtime` do arquivo
- Limite: 5000 itens (LRU simplificado)
- Se o `mtime` não mudou, reutiliza a classificação em cache

### Persistência no settings.json
- Chave: fingerprint do repositório (hash SHA-256 do conteúdo do manifesto)
- Estrutura:
  ```json
  {
    "fileImportance": {
      "a3f8c2e1b9d4...": {
        "repoName": "code_awareness",
        "lastKnownPath": "/Users/eric/projects/code_awareness",
        "files": {
          "src/main.ts": {
            "level": "critical",
            "source": "heuristic",
            "mtime": 1719500000000,
            "score": 85,
            "tokenEstimate": 1234
          }
        }
      }
    }
  }
  ```

### Fingerprint Resiliente
O fingerprint é calculated a partir do conteúdo dos arquivos de manifesto (package.json, Cargo.toml, etc.), não do path. Isso permite identificar o mesmo repositório mesmo se ele for movido ou renomeado no disco.

**Ordem de prioridade:**
1. `package.json` (Node.js/JavaScript/TypeScript)
2. `Cargo.toml` (Rust)
3. `pyproject.toml` (Python)
4. `go.mod` (Go)
5. `pom.xml` (Java/Maven)
6. `build.gradle` (Java/Gradle)
7. `Gemfile` (Ruby)
8. `composer.json` (PHP)
9. Fallback: `README.md`
10. Fallback: primeiro arquivo de código-fonte na raiz
11. Fallback final: hash do nome do diretório

## Override Manual

O usuário pode sobrescrever a classificação automática clicando no badge de importância na sidebar. Overrides manuais:
- São marcados com `source: 'manual'`
- São persistidos no `settings.json`
- Exibem um ícone ✏️ ao lado do badge
- Podem ser revertidos para "Automático" selecionando o nível original

## Interface do Usuário

### Badges de Importância
- 🔴 **Crítico** — fundo vermelho suave
- 🟠 **Alto** — fundo laranja suave
- 🟡 **Médio** — fundo amarelo suave
- ⚪ **Baixo** — fundo cinza suave

### Botão Mágico 🎯
Seleciona todos os arquivos classificados como `critical` ou `high` de uma vez.

### Ordenação Visual
A sidebar exibe os arquivos ordenados por importância (🔴🟠🟡⚪), alfabeticamente dentro do mesmo nível.

### Estimativa de Tokens
Cada arquivo exibe `≈ Xk tokens` ao lado do nome, atualizado em tempo real. O total de tokens selecionados aparece no cabeçalho da sidebar.

## Estrutura de Arquivos

```
src/main/core/
  ├── importance-service.ts          ← Orquestrador principal
  ├── importance-heuristics.ts       ← Camadas 1, 2, 3, 4 (regras determinísticas)
  ├── importance-fingerprint.ts      ← Cálculo do fingerprint do repo
  └── __tests__/
      ├── importance-heuristics.test.ts  ← Testes das funções puras
      └── importance-async.test.ts       ← Testes das funções assíncronas

src/shared/types.ts                  ← Tipos: ImportanceLevel, FileImportance, etc.

src/renderer/src/components/
  ├── ImportanceBadge/               ← Componente visual reutilizável
  ├── CodeSourceView/                ← Consome ImportanceService via IPC
  └── CodeCompressionView/           ← Consome ImportanceService via IPC
```

## Manutenção

### Adicionar Novos Padrões de Ruído
Edite as constantes em `importance-heuristics.ts`:
- `NOISE_EXTENSIONS`
- `NOISE_FILENAMES`
- `NOISE_DIRECTORIES`

### Ajustar Thresholds de Importância
Edite a constante `SCORE_THRESHOLDS` em `importance-heuristics.ts`:
```typescript
const SCORE_THRESHOLDS = {
  critical: 50,
  high: 25,
  medium: 10
}
```

### Adicionar Novos Padrões de Pontuação
Edite a função `scoreByNameAndPath` em `importance-heuristics.ts`.

### Integrar Tríade Futura
Implemente a função `extractTriadSignals` em `importance-heuristics.ts` para detectar a tríade de documentação arquitetural.

## Testes

Execute os testes com:
```bash
npm run test
```

Para execução única (sem watch):
```bash
npm run test:run
```

## Futuras Evoluções

### Fase 2 (Planejado)
- **Análise de conectividade:** parsear `import`/`require` para identificar structural hubs
- **Recálculo automático:** invalidar tags quando o arquivo muda (mtime diferente)
- **Camada de IA:** integrar Gemini para ler comentários e refinar classificação
- **Suporte a múltiplos providers:** OpenAI, Anthropic, etc.

### Fase 3 (Exploratório)
- **Aprendizado de máquina:** treinar modelo com feedback do usuário
- **Análise semântica:** usar embeddings para entender similaridade arquitetural
- **Recomendações automáticas:** sugerir refatorações baseado na importância

## Referências

- [AGENTS.md](../AGENTS.md) — Convenções de desenvolvimento
- [Prompt Engenheiro e Arquiteto de Software](../Prompt%20Engenheiro%20e%20Arquiteto%20de%20Software.md) — Prompt do arquiteto
