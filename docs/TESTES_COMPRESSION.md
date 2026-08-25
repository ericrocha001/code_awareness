# Bateria de Testes do Compression Service (`npm run test:compression`)

Documento independente que reúne a orientação de execução da bateria de Provas
de Aceitação do `CompressionService`. Mantido separado do `AGENTS.md`, que é
editado exclusivamente pelo engenheiro.

## Comando

```bash
npm run test:compression
```

Equivale a:

```bash
npx vitest run src/main/core/compression-service.test.ts
```

## O que cobre

`CompressionService` — `src/main/core/compression-service.test.ts` (10 testes):

- PA-01: Cache hit em arquivos inalterados
- PA-02: Invalidação por mtime
- PA-03: Normalização de caminhos
- PA-04: Limite de cache (1000 itens)
- PA-05: Ordem do Markdown
- PA-06: Falhas parciais
- PA-07: Falha total
- PA-08: Conteúdo vazio tratado como falha
- PA-09: Fallback individual
- PA-10: Falha de stat

## Requisitos

- Executar do diretório raiz do projeto (`package.json`).
- Node.js disponível (o `fs/promises` e `utimesSync` são usados para manipular arquivos temporários).

## Importante

- Não aciona o binário nativo `better-sqlite3`.
- Não aciona a CLI real do Repomix (adapter mockado).
- Os testes são Windows-friendly: usam `path.join`, diretórios temporários via `mkdtempSync` e cleanup com loop de retry.