# Checklist de Aceitação Visual — FileCollection (browser real)

> **Limitação registrada:** jsdom não executa layout. Os testes `layout-contracts.test.ts` protegem os **contratos declarativos** (CSS/estrutura); a evidência geométrica abaixo só é obtida em browser real (Electron). Se o projeto adotar E2E Electron futuro, estas propriedades devem virar testes automatizados de geometria — substituindo este checklist, mas **não** o CSS-contract test, que permanece como guarda de CI.

## Procedimento

1. Abrir a coleção com **305 arquivos** na File View (única visualização desde a Sprint 2.3 — ver `docs/architecture/filegridview-removal.md`).

## Verificações (executar nos temas claro e escuro)

| # | Propriedade | Regressão de origem | OK |
|---|-------------|---------------------|----|
| 1 | Exatamente **uma** barra de rolagem vertical (sem scroll duplo) | B2 | ☐ |
| 2 | FileView em meia tela: coluna de tokens legível; TokenBadge alinhado à esquerda (Sprint 4) e não toca o botão de ações | B3 | ☐ |
| 2a | Em meia tela, o conteúdo pode exceder a largura da viewport; o scroll horizontal revela todas as colunas com o header sticky sincronizado | 4 (R-B8) | ☐ |
| 3 | Header da FileView legível em meia tela; primeira coluna (Seleção) com respiro adequado | B4 | ☐ |
| 4 | Glifo de ações horizontal (três pontos "…") na linha | B5 | ☐ |
| 5 | Linhas com >1 linha de tags: clip + fade à direita + "+N" visível com contagem correta; coluna de tokens e ações íntegras (sem invasão); clique abre TagPopover com todas as tags | 2.2 (R-B6) | ☐ |
| 6 | Hover na área de tags exibe tooltip com a lista integral de nomes | 2.2 (R-B6) | ☐ |
| 7 | "AÇÕES" íntegro no header da FileView (sem truncamento), nos dois temas | 3 (R-B3.1/56px) | ☐ |
| 8 | Botão "Limpar" evidente (borda + fundo) quando há seleção | 3 | ☐ |
| 9 | Célula de tags SEM artefato de fade permanente; "+N" só quando há tags ocultas | 3 (R-B7) | ☐ |
| 10 | Gatilho "+" visível na célula de tags; com arquivo sem tags, clique abre o popover ancorado nele | 3 (R-B7) | ☐ |
| 11 | Arrastar alça de coluna redimensiona Identidade/Caminho/Tags/Tokens; recarregar o app mantém a largura persistida por projeto | 3 | ☐ |

> Sprint 2.3: itens de validação exclusivos do Grid (rolagem sem interseção entre cards; reflow ao redimensionar) foram removidos — o FileGridView não existe mais.

## Resultado

- Data: ____
- Tema claro: ☐ aprovado ☐ reprovado
- Tema escuro: ☐ aprovado ☐ reprovado
- Observações: ____
