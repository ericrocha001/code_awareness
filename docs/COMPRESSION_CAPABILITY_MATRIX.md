# Compression Capability Matrix

Matriz empírica de capacidades da CLI do Repomix na versão instalada, produzida
exclusivamente por execução real de comandos (sem inferência de documentação).
Serve de congelamento do contrato técnico para o **Compression Profile (Sprint 8)**.

## Ambiente

- **Versão do Repomix:** `1.15.0` (confirmada via `repomix --version`)
- **Sistema Operacional:** Windows (`$env:OS = Windows_NT`; build 2026-08-16)
- **Shell utilizado:** PowerShell 7.6.5 (`$PSVersionTable.PSVersion`)
- **Execução de referência:** binário `repomix.cmd` (mesmo invocado pelo
  `RepomixAdapter` em `win32`, via `spawn` com `shell: true`)
- **Data da investigação:** 2026-08-16
- **Alvo dos testes:** repositório `code_awareness` + diretório temporário em
  `%TEMP%\repomix_sprint7a` (removido ao final; nenhum arquivo de `src/`, de
  `package.json` ou de teste foi alterado)

> **Fonte autoritativa de flags:** `repomix --help` (lista real de opções da
> versão instalada). Qualquer flag ausente do `--help` foi testada e rejeitada
> empiricamente com `error: unknown option`.

---

## Grupo 1 — Compression

### `--compress`
- **Existe:** sim (presente no `--help`).
- **Funciona:** sim.
- **Efeito observado:** ativa compactação via Tree-sitter. Em `src/shared/utils/path-utils.ts`
  reduziu a saída (style plain, código sem flags): **1204 → 1152 caracteres**.
  O corpo da função é removido e o ponto de remoção é marcado com `⋮`.
- **Determinístico:** sim (mesmo tamanho em execuções repetidas).
- **Observação parser:** mantém o bloco `File: <path>` + separador `====`.

### `--remove-comments`
- **Existe:** sim.
- **Funciona:** sim.
- **Efeito observado:** remove blocos `/* */` (incluindo o bloco arquitetural),
  JSDoc `/** */` e comentários inline. Em `path-utils.ts`: **1204 → 474 caracteres**
  (sem `--compress`).
- **Determinístico:** sim.

### `--remove-empty-lines`
- **Existe:** sim.
- **Funciona:** sim.
- **Efeito observado:** remove linhas em branco. Em `path-utils.ts`: **1204 → 1196
  caracteres** (removeu as linhas vazias dentro do bloco de comentário).
- **Determinístico:** sim.
- **Observação:** sob `--compress` + `--remove-comments` é **inócuo** (417 → 417),
  pois a saída já está compactada sem linhas vazias relevantes.

### `--truncate-base64`
- **Existe:** sim.
- **Funciona:** parcialmente (somente para determinados padrões).
- **Efeito observado:** trunca strings base64 em *data URIs*
  (`data:image/png;base64,<longo>...`) substituindo o corpo longo por `...`.
  **NÃO truncou** uma string base64 comum de 600 caracteres embutida em código
  TypeScript (saída com e sem a flag idêntica, 1203 caracteres). A detecção é
  específica (data-uri), não genérica.
- **Determinístico:** sim.

---

## Grupo 2 — Representation

### `--output-show-line-numbers`
- **Existe:** sim.
- **Funciona:** sim (sem `--compress`); **sem efeito sob `--compress`**.
- **Efeito observado (sem compress):** prefixa cada linha com número alinhado e
  dois-pontos: ` 1: `, ` 2: ` etc. `path-utils.ts`: **1204 → 1312 caracteres**.
- **Efeito sob `--compress`:** nenhum — a compactação Tree-sitter remove as
  linhas originais e a numeração não é emitida (**combinação atual do adapter
  carrega esta flag, mas ela é um *no-op*** sob `--compress`).
- **Determinístico:** sim.

### `--parsable-style`
- **Existe:** sim.
- **Funciona:** sim, porém **sem efeito em `plain`**.
- **Efeito observado (style `xml`):** escapa `&`, `<`, `>`, `'` (→ `&amp;`,
  `&lt;`, `&gt;`, `&apos;`), colapsa a saída em uma linha e envolve em raiz
  `<repomix>`. Arquivo com `<tag>`, `&&`, `<x>`: XML bruto 134 → **171 caracteres**
  (válido XML).
- **Efeito observado (style `plain`):** tamanho idêntico com/sem a flag
  (379 = 379) — inócuo na pipeline plain de compressão.
- **Determinístico:** sim.

### `--output-file-path-style`
- **Existe:** **NÃO** na versão 1.15.0.
- **Evidência:** `error: unknown option '--output-file-path-style'` (stderr,
  exit code 1, stdout vazio) para ambos os valores `cwd-relative` e
  `target-relative`.
- **Conclusão:** fora do domínio nesta versão. O formato de caminho em `plain` é
  relativo ao alvo (ex.: `File: src/shared/utils/path-utils.ts`).
---

## Grupo 3 — Structure

### `--no-file-summary`
- **Existe:** sim. Remove a seção de resumo de arquivos do stdout.
- **Funciona/efeito:** confirmado — ausência da seção de resumo em todas as
  execuções que o usaram.
- **Determinístico:** sim.

### `--no-directory-structure`
- **Existe:** sim. Remove a seção `Directory Structure` do stdout.
- **Funciona/efeito:** confirmado — sem o flag a árvore aparece; com o flag, some.
- **Determinístico:** sim.

### `--include-empty-directories`
- **Existe:** sim.
- **Funciona:** sim, condicionalmente.
- **Efeito observado:** com a árvore presente **e sem `--include`**, a pasta vazia
  (`empty_sub/`) aparece em `Directory Structure`. **Com `--include`**, a pasta
  vazia **não** é listada (o filtro de include a exclui). Ou seja, o flag depende
  da árvore de diretórios e é sobreposto pelo `--include`.
- **Determinístico:** sim.

### `--include-full-directory-structure`
- **Existe:** sim.
- **Funciona:** sim.
- **Efeito observado:** com `--include` estreitando arquivos, o flag mostra a
  árvore **completa** do repositório (ex.: ~3244 caracteres com a árvore inteira
  em vez de só a subárvore do arquivo incluído).
- **Observação:** conflita conceitualmente com `--no-directory-structure`.

### `--style <type>` (plain | markdown | xml | json)
- **Todos existem e funcionam.** Formatos observados (mesmo arquivo comprimido):

| style | Formato do bloco | Tamanho (`path-utils.ts`) |
|-------|------------------|---------------------------|
| `plain` | `File: <path>` + linha de `====` + conteúdo | ~1152 (compress) |
| `markdown` | `# Files` / `## File: <path>` + fenced ``````` | 860 |
| `xml` | `<files>` / `<file path="...">...</file>` | 927 |
| `json` | `{"files":{"<path>":"<content>"}}` (escapa, `\r\n`) | 920 |

- **Observação crítica:** somente `plain` produz o formato `File:` + `====` que o
  `extractFileBlock`/`parseBatchOutput` do adapter espera. `markdown`, `xml` e
  `json` mudam a estrutura do bloco e **quebrariam o parser atual**.

---

## Grupo 4 — Context Enrichment

### `--header-text`
- **Existe:** sim. Adiciona a seção `User Provided Header` no topo da saída.
- **Funciona:** sim para textos curtos e longos.
- **Limite operacional (determinado empiricamente):**
  - 1KB: OK · 4KB: OK · 8KB: OK · **16KB: OK** ·
  - **18KB: falha** (`Linha de comando muito longa.`, exit code 1) via `repomix.cmd`;
  - 20/24/32KB: falha (mesmo erro); via shim `repomix.ps1` aos ~32KB ocorre erro
    de redirecionamento (`StandardOutputEncoding is only supported when standard
    output is redirected`).
  - **Conclusão: limite seguro de `--header-text` = 16KB** na plataforma Windows
    com o wrapper `.cmd`. O teto é do **tamanho da linha de comando do Windows**,
    não um limite interno do Repomix.
- **Escaping:** apóstrofo, `#`, `&`, `<`, `>` são preservados. **Aspas duplas são
  removidas** pelo wrapper `.cmd` → evitar aspas duplas no conteúdo do header ou
  passar o texto por caminho/placeholder.

### `--instruction-file-path`
- **Existe:** sim. Adiciona a seção `Instruction` com o conteúdo do arquivo.
- **Comportamento — arquivo existente:** exit code 0; seção `Instruction`
  presente com o conteúdo (ex.: 1389 caracteres).
- **Comportamento — arquivo inexistente:** exit code **1**, **stdout vazio e sem
  mensagem de erro no stderr (falha silenciosa)**. A CLI não emite warning; a
  única sinalização é o código de saída != 0. O adapter deve valer-se do exit code
  para detectar esse caso e **validar a existência do arquivo antes de executar**.
- **Determinístico:** sim.

### `--include-diffs`
- **Existe:** sim. Adiciona a seção `Diffs` com diffs do working tree e staged.
- **Funciona:** sim. Formato padrão `diff --git` (a/... b/...).
- **Tamanho:** potencialmente grande — em repositório com muitas mudanças, 1
  arquivo incluído resultou em **~198KB** de saída.

### `--include-logs` / `--include-logs-count`
- **Existem:** sim.
- **Funcionam:** sim. Adicionam a seção **`Git Logs`** com blocos no formato
  `Date:` / `Message:` / `Files:` (separados por `====`).
- **`--include-logs-count`:** controla o número de commits (default: 50).
  Testado com 3 e 5 → retornou exatamente 3 e 5 commits. **Depende de `--include-logs`**.
- **Determinístico:** sim.

---

## Grupo 5 — Seleção (`--include`)

| Teste | Resultado |
|-------|-----------|
| `--include` 1 arquivo | OK. |
| `--include` 3 arquivos (vírgula) | OK — todos presentes. |
| `--include` 10 arquivos | OK — exit 0, 47046 chars, todos presentes. |
| `--include` 20 arquivos | OK — exit 0, 86347 chars, nenhum ausente, ~2.1s. |
| `--include` 50 arquivos | OK — exit 0, 238353 chars, nenhum ausente. |
| `--include` caminhos com espaços (1 e dentro de lista vírgula) | OK — arquivo presente. |
| `--include` caminhos com caracteres especiais `()` `#` | OK. |
| `--include` arquivo **inexistente** | **exit 0**, arquivo **silenciosamente omitido** (seção Files vazia). Não falha o comando. |

- **Formato separado por vírgula** (`selectedFiles.join(',')`, como usado no
  adapter): **validado e mantido** nesta versão, inclusive com espaço dentro de um
  caminho e caracteres especiais em outros itens da mesma lista.
---

## Combinações Testadas

Arquivo de referência: `src/shared/utils/path-utils.ts` (salvo comb 8).
Base da combinação 1 (combinação atual do adapter):

```
--include <list> --compress --remove-comments --output-show-line-numbers
--style plain --stdout --no-file-summary --no-directory-structure
```

| # | Combinação | Funciona? | Saída (chars) | Tempo aprox. |
|---|------------|-----------|---------------|--------------|
| 1 | combinação atual do adapter | **Sim** | 417 | ~1.7–2.1s |
| 2 | comb 1 + `--remove-empty-lines` | **Sim** | 417 (inócuo sob compress+rmcomments) | ~1.7–2.1s |
| 3 | comb 1 + `--parsable-style` | **Sim** | 417 (inócuo em plain) | ~1.7–2.1s |
| 4 | comb 1 + `--header-text "Contexto de teste"` | **Sim** | 587 (header adicionado) | ~1.7–2.1s |
| 5 | comb 1 + `--style xml` | **Sim (mas quebra parser)** | 192 | ~1.7–2.1s |
| 6 | comb 1 + `--style json` | **Sim (mas quebra parser)** | 119 | ~1.7–2.1s |
| 7 | comb 1 + `--style markdown` | **Sim (mas quebra parser)** | 125 | ~1.7–2.1s |
| 8 | `--compress` + `--include` 20 arquivos + `--style plain` | **Sim** | 86347, 0 ausentes | ~2.1s |

Mensagens de erro observadas em falha:
- `--output-file-path-style`: `error: unknown option '--output-file-path-style'`
- `--header-text` acima do limite (via `.cmd`): `Linha de comando muito longa.`
- `--instruction-file-path` inexistente: nenhuma mensagem (exit code 1, stdout/stderr vazios).

**Validação do parser (item crítico 3):** nas combinações 1 e 2 o formato
`File: <path>` + separador `====` é **mantido**, portanto `extractFileBlock` /
`parseBatchOutput` seguem compatíveis. Nas combinações 5–7 (styles xml/json/markdown)
o formato muda e o parser atual **não** funcionaria.

---

## Limites Operacionais Descobertos

- **`--header-text`:** limite seguro **16KB**; acima disso falha no Windows
  (`Linha de comando muito longa.`) — teto da linha de comando do cmd.exe/`.cmd`,
  não do Repomix.
- **`--include`:** **pelo menos 50 arquivos** funcionam em lote único (nenhum teto
  encontrado). O adapter mantém `MAX_FILES_PER_BATCH = 20` e
  `MAX_INCLUDE_PATTERN_BYTES = 8192` por robustez (evita linha de comando longa e
  falha silenciosa do Repomix). O limite real de bytes do argumento interage com
  o teto de linha de comando do Windows (~8191 caracteres em contexto `cmd`).
- **`--instruction-file-path` inexistente:** não é detectável por stdout; a única
  sinalização confiável é o **exit code 1**.
- **Tamanho da saída com diffs:** `--include-diffs` pode inflar muito a saída
  (ex.: ~198KB com apenas 1 arquivo incluído em repo com muitas mudanças).
- **Escaping de shell:** aspas duplas no `--header-text` são removidas pelo
  wrapper `.cmd` no Windows.
---

## Conflitos e Incompatibilidades

- `--output-show-line-numbers` **+ `--compress`**: a numeração não é emitida sob
  compressão (flag inócuo nessa combinação).
- `--parsable-style` **+ `--style plain`**: sem efeito (só relevante em xml/markdown).
- `--style` != `plain` **+ pipeline de compressão**: quebra o parser atual
  (`File:` + `====` só no `plain`).
- `--include-empty-directories` **+ `--include`**: pastas vazias não aparecem
  (o filtro de include sobrepõe o flag).
- `--include-full-directory-structure` **vs `--no-directory-structure`**: objetivos
  opostos; não devem ser combinados.
- `--include` com **arquivo inexistente**: exit code 0 + arquivo omitido —
  risco de "sucesso" sem conteúdo (mitigado pela defesa de 'arquivo ausente' do
  adapter).
- `--header-text` **longo no Windows**: falha de linha de comando (limite 16KB).
- Aspas duplas dentro de `--header-text` no Windows: removidas pelo shell.

---

## Dependências

- `--include-logs-count` **depende de** `--include-logs`.
- `--include-empty-directories` / `--include-full-directory-structure` **dependem
  da** seção `Directory Structure` presente (conflitam com `--no-directory-structure`).
- `parseBatchOutput` / `extractFileBlock` **dependem de** `--style plain` + presença
  de `File:`/`====`.
- `--compress` depende do Tree-sitter built-in (funciona sem instalação adicional
  nesta versão; ativo por padrão quando a flag é passada).
- `--instruction-file-path` exige pré-validação de existência do arquivo (a CLI
  falha silenciosamente quando ausente).

---

## Decisões para o Compression Profile

Classificação final de cada capacidade para o profile de compressão:

| Capacidade | Classificação | Justificativa empírica |
|------------|---------------|------------------------|
| `--compress` | **Suportado** | Núcleo; reduz saída e mantém formato `plain`/parser. |
| `--remove-comments` | **Suportado** | Redução relevante (1204→474). |
| `--remove-empty-lines` | **Suportado** | Reduz; inócuo sob compress+rmcomments (pode ser omitido). |
| `--truncate-base64` | **Suportado com restrições** | Só age em data-URIs base64, não em strings embutidas. |
| `--output-show-line-numbers` | **Suportado, porém no-op sob `--compress`** | Excluir da combinação atual (não produz efeito); número perdido na compressão. |
| `--parsable-style` | **Fora de uso na pipeline `plain`** | Inócuo em plain (útil apenas p/ xml/markdown). |
| `--output-file-path-style` | **Não suportado pela CLI (1.15.0)** | Flag inexistente. |
| `--no-file-summary` | **Suportado** | Reduz overhead; usar sempre. |
| `--no-directory-structure` | **Suportado** | Reduz overhead; usar sempre. |
| `--include-empty-directories` | **Fora do domínio da compression** | Sem árvore no profile (no-directory-structure). |
| `--include-full-directory-structure` | **Fora do domínio da compression** | Sem árvore no profile. |
| `--style plain` | **Suportado (obrigatório p/ parser)** | Único formato compatível com `File:`/`====`. |
| `--style markdown/xml/json` | **Fora da compression** | Seletiva usa format próprio e parser próprio. |
| `--header-text` | **Suportado com restrições** | `≤ 16KB`, sem aspas duplas (limite do Windows). |
| `--instruction-file-path` | **Suportado com restrições** | Pré-validar arquivo; falha silenciosa (exit 1) se inexistente. |
| `--include-diffs` | **Fora do domínio da compression** | Seção git; infla muito a saída. |
| `--include-logs` / `--include-logs-count` | **Fora do domínio da compression** | Seção git. |
| `--include <padrões vírgula>` | **Suportado** | `join(',')` validado; ≥50 arquivos; espaços/caracteres especiais OK. |

**Nota final:** nenhum arquivo de produção (`src/`), `package.json` ou teste foi
modificado nesta Sprint. Arquivos temporários foram criados em
`%TEMP%\repomix_sprint7a` e removidos ao término da investigação.