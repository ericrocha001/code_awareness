# Compression Format Validation

Validação empírica dos quatro formatos de saída do Repomix (Plain, Markdown, XML,
JSON) para decidir: quais formatos suportam **extração por arquivo** (Compression
Core com cache) e quais exigem **geração direta do documento** (Direct Output).
Todos os resultados foram obtidos por execução real da CLI (sem inferência).

## Ambiente

- **Versão do Repomix:** `1.15.0` (confirmada via `repomix --version`)
- **Sistema Operacional:** Windows (`Windows_NT`), PowerShell 7.6.5
- **Data da investigação:** 2026-08-16
- **Alvo dos testes:** repositório `code_awareness` (arquivos reais)
- **Arquivos representativos usados:**
  - `src/shared/utils/path-utils.ts` (TS pequeno)
  - `src/main/core/compression-service.ts` (TS médio)
  - `src/renderer/src/index.css` (CSS)

> Nenhum arquivo de `src/`, `package.json` ou de teste foi modificado. Apenas o
> presente documento foi criado.

---

## Resumo da Decisão

| Formato | Extração por Arquivo? | Caminho Arquitetural | Parser Necessário |
|---------|----------------------|---------------------|-------------------|
| Plain   | **Sim** (determinístico) | **Compression Core** | `parseBatchOutput` (existente) |
| Markdown| Sim, porém frágil (fences) | **Direct Output** | Novo parser de headers + fences |
| XML     | Sim, porém exige `--parsable-style` p/ validade | **Direct Output** | Novo parser XML |
| JSON    | **Sim (trivial, melhor)** | **Compression Core** (recomendado) | `JSON.parse` (mínimo) |

**Recomendação:** manter **Plain** como formato atual do Compression Core e
adicionar **JSON** como formato robusto de extração por arquivo (custo de parser
~zero). **Markdown** e **XML** ficam como Direct Output (documento inteiro).

---

## Formato: Plain

### Estrutura de Saída

Exemplo real (3 arquivos, primeira parte), separador = `================` (16 `=`):

```
================================================================
Files
================================================================

================
File: src/shared/utils/path-utils.ts
================
/* ... bloco de comentário ... */
⋮----
/** Normaliza caminho de projeto: barras invertidas → barras e remove a barra final. */
export function normalizeProjectPath(path: string): string

================
File: src/main/core/compression-service.ts
================
/* ... conteúdo comprimido ... */

================================================================
End of Codebase
================================================================
```

### Viabilidade de Extração

- **Determinístico:** sim. `parseBatchOutput`/`extractFileBlock` casam o cabeçalho
  exato `File: <path>` seguido do separador `====`, coletando até a próxima
  ocorrência de separador. Confirmado em batch 1/3/10/20 arquivos.
- **Marcadores:** `================` + `File: <path>` (início) + `====` (separadores
  de bloco) + `End of Codebase` (fim).
- **Fragilidade:** a detecção é por linha ancorada; um arquivo cujo **conteúdo**
  contenha literalmente `File: <path>` idêntico a outro caminho não é um problema
  real (o parser casa a linha exata após um separador). Contagem crua de substrings
  `File: ` pode superestimar (falso positivo em conteúdo), mas a extração real é
  por linha, sem ambiguidade.
- `--header-text` insere a seção `User Provided Header` **antes** do bloco de
  arquivos — não afeta a extração.
- `--parsable-style`, `--truncate-base64` (sem data-uri) e `--output-show-line-numbers`
  sob `--compress` são **no-op** — estrutura inalterada.

### Combinações Testadas

3 arquivos: `path-utils.ts`, `compression-service.ts`, `index.css` (base = `--compress --style plain --stdout --no-file-summary --no-directory-structure`).

| Combinação | Funciona? | Estrutura p/ extração preservada? | Tamanho (chars) |
|------------|-----------|-----------------------------------|-----------------|
| Base | **Sim** | Sim (`File:`+`====` por arquivo) | 10589 |
| + `--remove-comments` | **Sim** | Sim | 3285 |
| + `--remove-empty-lines` | **Sim** | Sim | 10573 |
| + `--truncate-base64` | **Sim** | Sim | 10589 |
| + `--parsable-style` | **Sim** (inócuo) | Sim | 10589 |
| + `--output-show-line-numbers` | **Sim** (no-op sob compress) | Sim | 10589 |
| + `--header-text "Teste"` | **Sim** | Sim (header antes de Files) | 10749 |

### Decisão

**Compression Core (cache por arquivo)** — formato atual, determinístico, parser
existente, estrutura preservada em todas as combinações e em todos os volumes
(1/3/10/20).
---

## Formato: Markdown

### Estrutura de Saída

Exemplo real (3 arquivos, primeira parte):

```
# Files

## File: src/shared/utils/path-utils.ts
```typescript
/* ... bloco de comentário ... */
⋮----
export function normalizeProjectPath(path: string): string
```

## File: src/main/core/compression-service.ts
```typescript
/* ... conteúdo comprimido ... */
```

...
```

### Viabilidade de Extração

- **Marcadores determinísticos:** cabeçalho `## File: <path>` (início) + linha de
  fence ````` ```<lang>``` ` ````` (ex.: `typescript`, `css`) seguido do conteúdo e
  fechado por ````` ``` ````` (fim). Confirmado em batch 1/3/10/20
  (headres e fences escalam exatamente 1×/2× o número de arquivos).
- **Determinístico:** sim, mas **frágil** — a linguagem do fence varia por tipo de
  arquivo (`typescript`, `css`, etc.), exigindo parser tolerante; e se o **conteúdo
  comprimido contiver três orquilhas** (`` `` ``), o fence de fechamento pode ser
  ambiguizado. `--parsable-style` **não alterou** a saída nestes testes (tamanho
  idêntico), não fornecendo blindagem observada contra quebra de fence.
- **Combinações:** todas preservaram `## File:` (3) e fences (6), sem arquivos
  ausentes. `--remove-comments` reduz (10264→2960). `--parsable-style`,
  `--output-show-line-numbers` e `--truncate-base64` são no-op. `--header-text`
  adiciona o header sem afetar os marcadores (3 cabeçalhos preservados).
- LEN (3 arquivos): base 10264; +rmcomments 2960; +rmemptylines 10248; +truncb64
  10264; +parsable 10264; +linenums 10264; +header 10296.

### Decisão

**Direct Output** — extração por arquivo é *possível* (padrão determinístico), mas
exige um parser novo de headers+fences e é frágil diante de conteúdo com fences;
não há ganho sobre Plain/JSON para o cache por arquivo. O Markdown permanece útil
apenas como formato de documento completo (geração seletiva atual).

---

## Formato: XML

### Estrutura de Saída

Exemplo real (3 arquivos, primeira parte):

```
<files>
This section contains the contents of the repository's files.

<file path="src/shared/utils/path-utils.ts">
/* ... bloco de comentário ... */
⋮----
export function normalizeProjectPath(path: string): string
</file>

<file path="src/main/core/compression-service.ts">
/* ... conteúdo comprimido ... */
</file>

</files>
```

### Viabilidade de Extração

- **Marcadores determinísticos:** `<file path="<caminho relativo>">` (início) e
  `</file>` (fim), dentro de `<files>`. Atributo `path` confirmado presente para
  todos os arquivos. Batch 1/3/10/20: `<file path=` e `</file>` escalam exatamente
  com a quantidade de arquivos (1→3→10→20).
- **Validade / fragilidade:** **sem `--parsable-style` o conteúdo NÃO é escapado** —
  caracteres `<`, `>`, `&` no conteúdo produzem XML **inválido** (observado:
  `<tag>` e `&&` crus). Com `--parsable-style` o conteúdo é escapado (`&lt;`,
  `&amp;`, `&apos;`) e o elemento vira XML válido — a estrutura `<file path=...>`/
  `</file>` é preservada, porém o formato de impressão muda (pode colapsar em uma
  linha conforme o conteúdo).
- **Combinações:** OPEN/CLOSE = 3 em todas. `--remove-comments` reduz (10328→3024);
  `--parsable-style` adiciona ~106 chars de escaping (10328→10434); `--truncate-base64`
  sem data-uri e `--output-show-line-numbers` são no-op; `--header-text` preserva
  a estrutura.
- **Parser:** extração confiável apenas com `--parsable-style` + um parser XML
  (DOM/SAX ou regex sobre `<file path="...">...</file>`).

### Decisão

**Direct Output** — a extração é condicionada a `--parsable-style` (para validade)
e a um parser XML novo; sem o flag o documento pode ser XML inválido. Não agrega
custo-benefício ao cache por arquivo frente a Plain/JSON. O XML pode ser mantido
apenas como formato de documento inteiro.
---

## Formato: JSON

### Estrutura de Saída

Exemplo real (3 arquivos, primeira parte):

```json
{
  "files": {
    "src/shared/utils/path-utils.ts": "/*\\r\\n--- ARQUITETURA DO SCRIPT ---\\r\\n...⋮\\n/** ... */\\nexport function normalizeProjectPath(path: string): string",
    "src/main/core/compression-service.ts": "/* ... conteúdo comprimido ... */",
    "src/renderer/src/index.css": "..."
  }
}
```

### Viabilidade de Extração

- **Estrutura = dicionário** `caminho → conteúdo`: chaves são os **caminhos
  relativos** dos arquivos; conteúdo é **acessível por chave** direto de
  `JSON.parse(...).files[path]`. Este é o único formato onde a extração é trivial
  (sem parser dedicado).
- **Robustez em todas as combinações** (validadas com `ConvertFrom-Json` — todas
  geram JSON válido com os 3 arquivos presentes):
  - Base: válido (10543) · +`--remove-comments`: válido (3043) · +`--remove-empty-lines`:
    válido (10497) · +`--truncate-base64`: válido (10543) · +`--parsable-style`:
    válido (10543, no-op pois JSON já é escapado) · +`--output-show-line-numbers`:
    válido (10543, no-op sob compress) · **+`--header-text "Teste"`: válido, header
    vira chave dedicada `"userProvidedHeader"`** (10578) — não quebra o dicionário.
- **Batch:** n=1/3/10 → `NKEYS` = nº de arquivos presentes; estrutura de dicionário
  mantida. Arquivo inexistente é silenciosamente omitido (exit 0), como já
  documentado na Sprint 7A.
- **Conteúdo:** usa escapes JSON (`\r\n`, `\n`) e o marcador `⋮` de compressão;
  encoding UTF-8.

### Decisão

**Compression Core (cache por arquivo) — candidato recomendado.** Extração trivial
via `JSON.parse`, chave = caminho relativo, robusta a todas as combinações testadas
(incluindo `--header-text`, que fica em chave própria `userProvidedHeader`). Custo
de parser ≈ zero; menor superfície de fratura que parsing textual de marcadores.

---

## Implicações Arquiteturais

- **Formato default recomendado:** **Plain** (continuidade, parser existente e
  testado). **JSON** é a extensão recomendada como formato robusto de extração por
  arquivo, caso se queira um caminho menos frágil que parsing textual de marcadores.
- **Parser atual precisa ser estendido?** Sim, apenas se adotar JSON (mínimo,
  `JSON.parse`, ~poucas linhas) ou forçar Markdown/XML (novo parser, alta
  complexidade). Para a decisão desta Sprint: **não estender o parser atual** —
  manter `parseBatchOutput` para Plain; adicionar `JSON.parse` se JSON entrar no
  compression core.
- **`profileHash` deve incluir `outputFormat`?** **Sim.** O conteúdo de cache varia
  conforme o formato (Plain vs JSON diferem na serialização e no escaping; `⋮` é
  comum, mas `\r\n`/JSON-escaping é específico do JSON). A chave de cache por
  arquivo precisa incorporar `outputFormat` para evitar colisões entre formatos.
- **Cache por arquivo é viável em todos os formatos?**
  - Plain: **sim** (atual).
  - JSON: **sim** (dict por chave).
  - Markdown: sim, porém frágil (fence por linguagem variável + risco de
    triple-backticks no conteúdo).
  - XML: sim apenas com `--parsable-style` + parser XML.
  - Conclusão: cache por arquivo é viável de fato em **Plain** e **JSON**.
- **Escopo do cache:** `--header-text`/`--instruction-file-path` são globais do
  documento (em JSON, `userProvidedHeader` é chave raiz, fora de `files`). A
  reaplicação do header deve ocorrer na montagem do documento (Direct Output), não
  no conteúdo por arquivo em cache.

---

## Decisões para a Sprint 8

1. **Manter Plain como formato do Compression Core** atual (`parseBatchOutput`).
2. **Adotar JSON como formato robusto de extração por arquivo** (opcional,
   recomendado): parser = `JSON.parse`, chave = caminho relativo. Cobre todas as
   combinações relevantes (compress, remove-comments, remove-empty-lines,
   header-text via `userProvidedHeader`).
3. **Markdown e XML → Direct Output** (documento inteiro), fora do cache por
   arquivo; sem novo parser nesta Sprint.
4. **Incluir `outputFormat` no `profileHash`** / na chave de cache por arquivo, para
   evitar colisão entre Plain e JSON.
5. **Documentar/validar pré-existência** do arquivo de `--instruction-file-path`
   (falha silenciosa com exit 1) e do `--header-text ≤ 16KB` (limite do Windows) —
   em continuidade à Sprint 7A.
6. **Não usar** `--output-show-line-numbers` como garantia de numeração sob
   `--compress` (é no-op em todos os formatos testados) nem `--parsable-style` como
   blindagem de extração no Plain/JSON (no-op; no XML é requisito de validade).
7. **Pré-validar `--include`:** arquivos inexistentes são omitidos com exit 0 —
   manter a defesa de "arquivo ausente" + fallback individual do adapter.

**Nota final:** Sprint exclusivamente investigativa — nenhum arquivo de produção,
`package.json` ou teste foi modificado; nenhum arquivo temporário persistiu no
repositório.