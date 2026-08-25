# Bateria de Testes Git + Diff (`npm run test:git`)

Documento independente que reúne a orientação de execução da bateria de Provas de
Aceitação de `GitService` e `DiffService`. Mantido separado do `AGENTS.md`, que é
editado exclusivamente pelo engenheiro.

## Comando

```bash
npm run test:git
```

Equivale a:

```bash
npx vitest run src/main/core/git-service.test.ts src/main/core/diff-service.test.ts
```

## O que cobre

- **`GitService`** — `src/main/core/git-service.test.ts` (22 testes):
  - PA-01 `isGitRepository`;
  - PA-02 `getModifiedFiles` (inclui o contrato pós-Sprint 1: deletados com
    `changeType: 'deleted'`, `mtime: 0`, `size: 0`);
  - PA-03 `getAllFiles` (invariante nº 5 diferenciada por método);
  - PA-04 `getModifiedHunks` e `getFileAtHead`;
  - PA-05 `getCurrentCommitHash`;
  - PA-06 parser de status (códigos M/A/D, MM, rename, caminhos não-ASCII);
  - PA-07 — **Limitação documentada:** o mecanismo de timeout de `runGit` não é
    exercitado de forma automatizada (não-determinístico), apenas coberto por revisão.
- **`DiffService`** — `src/main/core/diff-service.test.ts` (12 testes), instanciado
  com `GitService` injetado (validação da injeção da Sprint 2):
  - PA-08 caso vazio;
  - PA-09 `selectedFiles` em três estados (`undefined`, `[]`, subconjunto);
  - PA-10 formatos de seção (adicionado, modificado, deletado);
  - PA-11 fronteira de 2 MB (incluindo conteúdo histórico de deletado);
  - PA-12 múltiplos hunks;
  - PA-13 robustez.

## Requisitos

- Executar do diretório raiz do projeto (`package.json`).
- `git` disponível no `PATH` (os testes usam repositórios Git temporários reais,
  sem mocks de `child_process.spawn`).

## Importante

- **Não aciona o binário nativo** `better-sqlite3`. Para a bateria que usa o
  repositório de banco (que recompila o nativo), utilize `npm run test:db` em
  comando separado.
- Os testes são Windows-friendly: usam `path.join`, configuram identidade Git
  local no repos temporário e possuem cleanup com loop de retry.