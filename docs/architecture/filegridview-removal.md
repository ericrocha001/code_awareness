# Decisão Arquitetural: Eliminação do FileGridView

**Data:** 2026-08-21
**Sprint:** 2.3 — Refinamento (remoção arquitetural)
**Status:** Ratificada e implementada

## Decisão

Eliminar completamente o `FileGridView` (componente, CSS, testes) e toda a infraestrutura associada (switcher Grid/Dense no `FileCollectionView`). A `DenseView` torna-se a única e default visualização da coleção de arquivos.

## Justificativa

O problema B1 (cards sobrepostos na grade virtualizada) persistiu após duas Sprints corretivas (2.1 e 2.2). A causa raiz — estratégia de posicionamento absoluto combinada com medição dinâmica de altura dos cards dentro da virtualização — revelou-se frágil e difícil de corrigir sem reescrever a arquitetura de virtualização do Grid.

A Dense View (tabela compacta com `FileRow`) atende ao caso de uso principal — consultabilidade de arquivos, tokens e tags — sem os problemas de layout do Grid. O contrato de overflow de tags da Sprint 2.2 (+N, tooltip, TagPopover) permanece íntegro na view única.

## Impacto

- Usuários perdem a visualização em cards.
- Ganham consistência de renderização e eliminação definitiva das regressões visuais da grade.
- `FileCollectionView` fica mais simples: sem estado de modo de visualização; o prop legado `defaultViewMode` ainda é aceito por compatibilidade, mas é ignorado.

## Alternativas consideradas

1. **Reescrever a virtualização do Grid com spacers de fluxo** — complexidade alta e risco de novos defeitos em uma superfície já instável.
2. **Congelar altura fixa dos cards com contenção de tags** — limitação de produto: tags integrais eram o valor original da visualização.
3. **Eliminar o Grid** (decisão tomada) — remove por completo a superfície do problema, ao custo de perder a visualização em cards.

## Consequências para o futuro

- Se houver necessidade futura de visualização em cards, uma nova arquitetura deve ser projetada do zero (virtualização por fluxo, não por posicionamento absoluto). **Não reutilizar o código deletado.**
- Os contratos R-B1 (CSS de `.fgv-row`, altura percentual em `.file-card`) foram removidos de `layout-contracts.test.ts`; os blocos R-B2..R-B6 permanecem congelando o layout da Dense View.
