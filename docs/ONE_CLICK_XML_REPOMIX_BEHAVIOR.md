# Comportamento Real do Repomix 1.15.0 no One-Click XML

Fonte: bateria de aceitação real (`src/main/core/one-click-xml-acceptance.test.ts`) e sondagens manuais da CLI (agosto/2026).

## Passthrough
- `OneClickXmlService.generateOneClickXml()` retorna **byte a byte** o stdout do Repomix obtido via `RepomixAdapter.generateDirectOutput()` (PA-00). Sem envelope, sem parsing, sem reassembly.

## Untracked (decisão de produto)
- Arquivos untracked (não commitados, não staged) **são incluídos** no XML, tanto pela allowlist (`GitService.getAllFiles` soma `git ls-files` + untracked do status) quanto pelo Repomix (PA-09, PA-17 — repositório sem nenhum commit também funciona).

## Binários (delegação ao Repomix)
- Binários explicitamente incluídos (png, pdf) são **silenciosamente excluídos** da seção `<files>` pelo Repomix, **sem falhar** a execução. Arquivos de código da mesma execução continuam presentes (PA-10).

## Git Ignore
- Arquivos cobertos pelo `.gitignore` não entram na allowlist (filter do `IgnorePolicy`) e o Repomix também os exclui mesmo em `--include` explícito (PA-05, PA-11, PA-12).

## Code Awareness Ignore
- Caminhos exatos de `ignoredDiffFiles[repoPath]` são removidos da allowlist antes do Repomix (PA-06).

## Flags de limpeza
- `--compress` é **sempre** emitido pelo `RepomixArgumentsBuilder`; a compressão Tree-sitter preserva apenas assinaturas (corpos de funções e `const` literais são descartados). Fixture de teste deve usar assinaturas de função para sobreviver.
- `removeComments`: efetiva — comentários de linha/bloco/JSDoc somem do conteúdo (prova diferencial com/sem flag, PA-02).
- `truncateBase64`: efetiva em arquivos não comprimidos (ex.: `.json`); a data URI completa some e o output encolhe (PA-04).
- `removeEmptyLines`: **NO-OP** no Repomix 1.15.0 — sob `--compress` as linhas vazias já são eliminadas pela compressão; em md/json/txt a flag não tem efeito nem fora da compressão. A saída é idêntica com e sem a flag (PA-03, limitação conhecida da CLI, não defeito da cadeia).

## Caracteres especiais em nomes de arquivo
- Nomes com espaços e `&` (ex.: `weird & file.ts`) funcionam. **Bug corrigido** nesta Sprint: `RepomixProcessRunner` usava `shell: true` no Windows sem aspas, corrompendo o comando; agora os argumentos contendo espaços/metacaracteres do cmd são envolvidos em aspas duplas (PA-14).

## Outros
- Allowlist vazia (ex.: `.gitignore` com `*`) encerra com erro estruturado "Nenhum arquivo elegível..." sem invocar o Repomix (PA-16).
- Paths no XML são escapados (`&` → `&amp;`); a estrutura nativa `<files>`/`<file path="...">` permanece intacta (PA-01, PA-13).
