# Contrato de Formato no Direct Output

## Assimetria `OutputFormat` → pipeline

O `OutputFormat` é o mecanismo de transporte do resultado do Repomix e determina o
**caminho arquitetural** da pipeline de compressão:

| Formato | Pipeline | Responsável pelo documento |
| :--- | :--- | :--- |
| `plain` | Compression Core | `CompressionService` (documento-esqueleto via `assembleCompressionDocument`; consumido pelo CodeMap) |
| `markdown` | Direct Output | Repomix (stdout é o documento) via `RepomixAdapter.generateDirectOutput` |
| `xml` | Direct Output | Repomix (stdout é o documento) via `RepomixAdapter.generateDirectOutput` |
| `json` | Direct Output | Repomix (stdout é o documento JSON) via `RepomixAdapter.generateDirectOutput` |

A decisão é tomada por `resolveCompressionPath(format)`: `plain` → Compression Core;
`markdown`/`xml`/`json` → Direct Output. O caminho Direct Output **não usa** cache por arquivo nem
o `inFlight` do Core.

> **Razão da mudança (Sprint 6.1):** anteriormente `json` residia no Core, produzindo um documento
> Markdown dentro de um arquivo `.json` — conflito com o requisito de produto "o documento é do
> formato escolhido". O novo contrato faz `json` ser documento nativo do Repomix (Direct Output),
> produzindo JSON real no preview e na exportação. `plain` permanece como documento-esqueleto legado,
> sem alteração no consumo do CodeMap.

## Contrato de envelope no Direct Output

O método privado `generateDirectOutput` do `CompressionService` é **consciente do formato**
(D1 — envelope consciente do formato):

- **`markdown`:** recebe o **envelope completo** — cabeçalho `# Code Compression — [repo] (data)`,
  blockquote de descrição, seções de enrichment pré-conteúdo, conteúdo do Repomix e seções de
  enrichment pós-conteúdo.
- **`xml` e `json`:** são **passthrough puro** do conteúdo do Repomix — sem cabeçalho Markdown, sem
  blockquote, sem seções de enrichment. O stdout do Repomix é retornado íntegro, produzindo um
  documento nativo válido (XML bem-formado / JSON parseável).

Invariante de saída: para `xml` e `json` o resultado é **exatamente** `result.content` do Repomix.

## Limitação atual

O contexto enrichment (`buildEnrichmentSections`) **não é aplicado** quando o formato é `xml` ou
`json` (D2 — enrichment ignorado no XML/JSON). O método privado não chama `buildEnrichmentSections`
nesses caminhos, evitando que seções Markdown sejam injetadas no documento nativo e o corrompam.

Isso é uma **limitação atual de implementação**, **não** uma impossibilidade conceitual: o enrichment
podría ser representado como elementos XML/JSON. A evolução futura é registrada como escopo futuro
(§ Evolución futura).

## Sentinela de falha total

A sentinela `COMPRESSION_TOTAL_FAILURE_MARKER` é **única e universal** entre os formatos (D3).
Em falha total (exit code ≠ 0, stdout vazio ou erro de processo), o Direct Output retorna a
sentinela seguida do motivo — independentemente de `markdown`, `xml` ou `json`.

A sentinela **não** é "um documento malformado": quando há falha total **não existe documento**;
o retorno é exclusivamente o sentinela de falha.

## Evolução futura (fora do escopo atual)

- Enrichment como **elementos XML/JSON** (seção de contexto, instruções, diffs e logs serializados),
  caso o produto deseje documentos com contexto adicional.
- Reflexo da limitação do XML/JSON na UI (Sprint 4 — OutputModal) para que o usuário esteja ciente de
  que o enrichment não se aplica a esses formatos.
- Tratamento do sentinela de falha como conteúdo não-native é intencional e documentado; consumidores
  de XML/JSON devem detectar a falha via o prefixo `COMPRESSION_TOTAL_FAILURE_MARKER` antes de tentar
  parsear.

## Documentos relacionados

- `AGENTS.md` — regras de arquitetura autoexplicativa e integridade arquitetural.
- `src/main/core/compression-service.ts` — implementação do envelope consciente do formato.