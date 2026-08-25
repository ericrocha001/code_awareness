# Bateria de Testes de UI — RestoreModal (`npm run test:ui`)

Documento independente que reúne a orientação de execução da bateria de Provas de
Aceitação do `RestoreModal` (confirmação de restauração). Mantido separado do
`AGENTS.md`, que é editado exclusivamente pelo engenheiro.

## Comando

```bash
npm run test:ui
```

Equivale a:

```bash
npx vitest run src/renderer/src/components/CodeJourneyView/restore-modal.test.tsx
```

> **Pré-requisito:** instalar as dependências de teste do renderer antes da
> primeira execução — `npm install` (ou `npm i -D jsdom @testing-library/react`)
> para registrar `jsdom` e `@testing-library/react` no `package.json`.

## O que cobre

Arquivo — `src/renderer/src/components/CodeJourneyView/restore-modal.test.tsx`
(ambiente `jsdom` via pragma por arquivo; **não** usa o binário nativo).

- **PA-M01** — renderização condicional e resistência a crash (regressão permanente do
  crash com preview legado sem `plan`);
- **PA-M02** — fidelidade da lista de mudanças: apenas `modified`/`created` renderizados
  (regressão permanente da listagem de inalterados), contagens `+X`/`−Y`, badge `Criar`,
  rótulo `alterado` para contagens `null` e `0/0` (sem `+0`/`−0`), bloqueados com motivo e
  estado vazio;
- **PA-M03** — exclusão de órfãos opt-in (badge `será excluído` só com limpeza marcada e
  `cleanupFiles` exato);
- **PA-M04** — defaults seguros (`backup` marcado, `limpeza` desmarcada) e reset a cada abertura;
- **PA-M05** — proteção em execução (ESC/overlay/X bloqueados, rótulo `Restaurando...`) e
  fechamento normal (ESC/overlay/X fecham; clique no conteúdo não fecha);
- **PA-M06** — delegação fiel com plano congelado (identidade do `plan` por referência);
- **PA-M07** — pele do design system: classes de variante do `Button`
  (`app-pill-btn` + `danger-outline` no confirmar, `app-ghost-btn` no cancelar),
  `aria-label` do X e ausência de emojis (regressão permanente dos botões fora do design system);
- **PA-M08** — implementações revertidas (seção presente com ordem, ausente quando vazia);
- **PA-M09** — unitária (sem DOM) de `getRevertedCheckpointNames` (`null`, alvo mais recente,
  alvo no meio com ordenação por data, datas iguais excluídas).

## Requisitos

- Executar do diretório raiz do projeto (`package.json`).
- Dependências `jsdom` e `@testing-library/react` instaladas (ver pré-requisito acima).
- O pragma `// @vitest-environment jsdom` no topo do arquivo seleciona o ambiente DOM
  sem configurar uma segunda instância de vitest.

## Importante

- **Não aciona o binário nativo** `better-sqlite3` e está isolado de `test:db` e `test:git`
  (cada um roda em comando separado). Nenhum mock de backend: o `RestoreModal` é
  estritamente apresentacional e não chama IPC — os espiões incidem apenas em `onClose` e `onConfirm`.
- **Relação com as demais baterias:** as contagens e status vêm do backend e são provadas por
  `PA-R10` em `test:db`; a validação do `stateHash` no execute é `PA-R09`; aqui valida-se apenas
  a renderização fiel e a delegação da UI.

## Limitações declaradas

- **jsdom não aplica CSS importado** — a validação visual (pílulas, cores, raio) é feita pelas
  classes de variante do design system (único ponto de integração observável), não por cor/estilo
  computado.
- **Volumes grandes** — o modal não virtualiza listas; a prova usa conjuntos pequenos. O teto de
  diffs (> 200k) e a proteção de memória são responsabilidade do backend (coberto por `PA-R10-B`).
- **Corrida de duplo clique** antes de `isExecuting` virar `true` é responsabilidade do
  orquestrador (`useJourneyRestore`/`CodeJourneyView`), não do modal.
- **Deleção/backup reais** são de responsabilidade do backend (bateria `test:db`);
  o modal apenas emite intenção via `onConfirm`.
