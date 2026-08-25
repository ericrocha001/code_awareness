# Spike — Mecanismo de Configuração do Repomix (Transporte por Arquivo de Configuração)

**Tipo:** Fundação (spike empírico)
**Sprint:** 1
**Objetivo Macro:** Determinar empiricamente se e como a versão instalada do Repomix recebe a lista de `include` fora da linha de comando, produzindo evidência suficiente para fundamentar ou invalidar o transporte por arquivo de configuração no Direct Output.
**Data de execução:** 2026-08-20

---

## 1. Ambiente

| Aspecto | Valor observado |
|---|---|
| Sistema operacional | Microsoft Windows 11 Pro (build 26200), `Windows_NT 10.0.26200 x64` |
| Shell | PowerShell (orquestração); a CLI do Repomix foi invocada através de `repomix.cmd` com `shell: true` no runner Node.js |
| Versão do Repomix | **1.15.0** — coincide com a versão fixa do projeto (1.15.0). Divergência de versão: **não observada** |
| Caminho do executável | `C:\Users\ericr\AppData\Roaming\npm\repomix.cmd` (instalação global npm; coexistem `repomix` e `repomix.ps1`) |

---

## 2. Mecanismo descoberto

### 2.1 Flag de CLI

`repomix.cmd --help` (versão 1.15.0, seção "Configuration Options"):

```text
Configuration Options
  -c, --config <path>   Use custom config file instead of repomix.config.json
  --init                Create a new repomix.config.json file with defaults
  --global              With --init, create config in home directory instead of current directory
```

Portanto, o mecanismo para transportar a lista de inclusão fora da linha de comandos é a flag **`-c, --config <path>`**, que aponta para um arquivo de configuração externo ao invés de passar `--include` diretamente.

### 2.2 Formato do arquivo

Formato **JSON (JSON5)**. Fonte de código na tag `v1.15.0`: [`src/config/configSchema.ts`](https://github.com/yamadashy/repomix/blob/v1.15.0/src/config/configSchema.ts):

```ts
include: v.optional(v.array(v.string())),
```

Esquema mínimo usado neste spike (arquivo em `%TEMP%`, fora do repositório de descarte):

```json
{
  "include": [
    "app.ts",
    "src/core/engine.ts",
    "src/utils/helper.ts",
    "src/data_adjacent/note.txt",
    "data/config.json",
    "README.md"
  ]
}
```

2.3 Resolução de caminhos

- `--config` aceita **caminhos absolutos** (o arquivo pode residir fora do repositório; resolvido com `path.resolve`, mantendo a absolutidade).
- Quando o caminho é absoluto, a localização do arquivo de configuração **não altera** a resolução de caminhos nem a saída.
- As entradas de `include` são tratadas como padrões glob; se forem caminhos relativos, são resolvidos contra o diretório de trabalho da execução (cwd = repoPath).

---

## 3. Respostas às perguntas obrigatórias (Q1–Q6)

Cada resposta inclui o comando executado e a evidência observada. Todos os comandos foram executados com `repomix.cmd` no Windows.

### Q1 — Qual o mecanismo exato (argumento da CLI, formato e esquema mínimo)?

**Mecanismo:** a flag `-c, --config <path>` recepciona um arquivo de configuração cujo esquema mínimo contém a propriedade raiz `include` (array de strings). Fonte na tag: `configSchema.ts` (`include: v.optional(v.array(v.string()))`).

Comando de verificação de ajuda:

```text
repomix.cmd --help
→ ... "-c, --config <path>   Use custom config file instead of repomix.config.json"
```

Comando de transporte usado no teste:

```text
repomix.cmd --config %TEMP%\repomix_sprint1_config.json --compress --stdout --style xml
```

Evidência: o comando acima retornou saída XML idêntica à baseline `--include` (ver Q4).

### Q2 — Que flags CLI permanecem válidas em combinação e preservam efeito idêntico?

**Resposta:** Todas as flags do Direct Output permanecem válidas e preservam efeito idêntico — confirmado pela paridade byte a byte (ver Seção 4).

| Flag | Válida em combinação? | Efeito preservado? |
|---|---|---|
| `--compress` | Sim | Sim |
| `--stdout` | Sim | Sim |
| `--style xml` / `--style markdown` | Sim | Sim |
| `--remove-comments` | Sim | Sim |
| `--remove-empty-lines` | Sim | Sim |
| `--truncate-base64` | Sim | Sim |
| `--parsable-style` | Sim | Sim |
| `--no-file-summary` | Sim | Sim |
| `--no-directory-structure` | Sim | Sim |
| `--include-empty-directories` | Sim | Sim |
| `--include-full-directory-structure` | Sim | Sim |

(`--stdout` não pertence ao esquema do arquivo, apenas ao da CLI; por isso continua passada como flag.)

### Q3 — A lista de inclusão na configuração aceita caminhos relativos resolvidos contra o diretório de trabalho?

**Resposta:** Sim — confirmado. O arquivo de configuração (`%TEMP%\repomix_sprint1_config.json`) contém caminhos relativos (`app.ts`, `src/core/engine.ts`, etc.) e reside fora do repositório; o diretório de trabalho era `%TEMP%\repomix_sprint1_discard` (o repositório). A saída foi **idêntica a byte** à baseline `--include` (mesmos arquivos resolvidos). Logo, os caminhos de `include` resolvem-se contra o cwd, não contra o local do arquivo.

### Q4 — O Direct Output (saída integral) é idêntico ao do caminho atual para a mesma seleção e mesmas flags?

**Resposta:** Sim — confirmado, idêntico a byte. Resultados da paridade (sem `--no-security-check`, conforme a especificação da Sprint):

- `xml`: baseline 2783 bytes × config 2783 bytes — mesmo SHA-256.
- `markdown`: baseline 2642 bytes × config 2642 bytes — mesmo SHA-256.

Nenhuma diferença de conteúdo, ordem ou metadados foi encontrada.

### Q5 — O arquivo de configuração temporário interfere na resolução do diretório de trabalho? Pode residir fora do repositório?

**Resposta:** Não interfere e **pode residir fora do repositório** — confirmado. O arquivo criado em `%TEMP%` (fora de `%TEMP%\repomix_sprint1_discard`) produziu saída idêntica à baseline executada com cwd = repositório. Sua localização externa não altera a resolução de caminhos nem a saída.

### Q6 — O mecanismo funciona no Windows via `repomix.cmd`?

**Resposta:** Sim — confirmado. Todo o teste foi executado através de `repomix.cmd` no Windows; todos os comandos de transporte retornaram código de saída 0 com saída idêntica.

---
## 4. Prova de paridade

Combinação: `--include` (ou `--config`) + `--compress --stdout --style <xml|markdown>`, diretório de trabalho = repositório de descarte, arquivo de configuração fora do repositório.

| Estilo | Transporte | Código de saída | Bytes | SHA-256 | Paridade |
|---|---|---|---|---|---|
| xml | Baseline (`--include`) | 0 | 2783 | `deb73b0f412dca709ff1912023ea4557b05a9c07914d379f79a7da67048c6b02` | igual à linha seguinte |
| xml | Config (`--config`) | 0 | 2783 | `deb73b0f412dca709ff1912023ea4557b05a9c07914d379f79a7da67048c6b02` | **byte a byte idêntico** |
| markdown | Baseline (`--include`) | 0 | 2642 | `cd1f07b5ff789371a29198be258f6a8b9721c599a5d8d16fd6b2d26810d50489` | igual à linha seguinte |
| markdown | Config (`--config`) | 0 | 2642 | `cd1f07b5ff789371a29198be258f6a8b9721c599a5d8d16fd6b2d26810d50489` | **byte a byte idêntico** |

A estrutura da saída XML contém `<file_summary>`, `<directory_structure>` e os blocos `<file path="...">`, todos presentes e idênticos entre os dois transportes. **Nenhuma diferença foi registrada.**

---

## 5. Comportamento de falha com configuração ausente

Comando:

```text
repomix.cmd --config %TEMP%\repomix_sprint1_nao_existe.json --style xml
```

Evidência observada:

- **Código de saída:** 1
- **stderr:** `✖ Config file not found at C:\Users\ericr\AppData\Local\Temp\repomix_sprint1_nao_existe.json`
- **stdout:** apenas o cabeçalho de versão/logs; sem conteúdo empacotado.

Observação: com `--stdout`, o logging é suprimido; o erro é emitido no stderr independentemente.

---

## 6. Limitações do spike

1. O teste foi feito com um repositório pequeno (6 arquivos); não é um teste de carga nem de volume elevado.
2. Na prova de paridade, a verificação de segurança permaneceu ativa (não se usou `--no-security-check`); o resultado é válido mesmo com a verificação ativa.
3. O mecanismo alternativo de **descoberta automática** (`repomix.config.json` no cwd) não foi o usado na paridade, pois exige escrever o arquivo dentro do repositório do usuário. Apenas o mecanismo `-c/--config` com caminho absoluto externo foi validado como transporte "limpo".
4. Não se testou o transporte com `--remote` (fora do escopo deste spike).
5. A flag `--init` é interativa (prompt) e não foi usada para gerar o arquivo de configuração; o JSON foi escrito manualmente, o que é permitido, já que o formato é apenas JSON.

---

## 7. Veredicto explícito

**SUPORTADO.**

Aplicação da regra de veredicto: um único mecanismo satisfaz integralmente Q1–Q6.

- Q1 — mecanismo exato (`-c, --config <path>`, JSON com array `include`): confirmado.
- Q2 — todas as flags do Direct Output permanecem válidas e preservam efeito idêntico: confirmado (paridade byte a byte).
- Q3 — caminhos relativos de `include` resolvidos contra o diretório de trabalho: confirmado.
- Q4 — saída integral idêntica (xml e markdown): confirmado (mesmo SHA-256).
- Q5 — o arquivo de configuração pode residir fora do repositório sem interferir: confirmado.
- Q6 — funciona no Windows via `repomix.cmd`: confirmado.

Não foram encontradas restrições nem incompatibilidades. Portanto, o transporte da lista de `include` por arquivo de configuração (`-c, --config <path>`) é **SUPORTADO** pelo Repomix v1.15.0 para o Direct Output.

---

## 8. Modelo de comando para uso futuro pelo adapter

Depois de preparar o arquivo de configuração temporário (com a lista em `include`) fora do repositório:

```text
repomix.cmd --config <caminho-absoluto-do-arquivo-de-configuracao> --compress --stdout --style <xml|markdown>
```

Observações para o adapter:

- O arquivo de configuração contém apenas `{"include": ["<caminhos-relativos>"]}`; os caminhos relativos são resolvidos contra o diretório de trabalho, que deve ser `repoPath`.
- `--config` deve receber um **caminho absoluto** para garantir que o arquivo resida fora do repositório do usuário (evita que o arquivo de configuração seja empacotado).
- As flags restantes do Direct Output (`--remove-comments`, `--remove-empty-lines`, `--truncate-base64`, `--parsable-style`, `--no-file-summary`, `--no-directory-structure`, `--include-empty-directories`, `--include-full-directory-structure`) podem ser acrescentadas à mesma invocação, mantendo o mesmo efeito do transporte por `--include`.
- Em caso de arquivo de configuração inexistente, o Repomix retorna código de saída 1 e a mensagem `Config file not found at <path>` no stderr (erro a ser mapeado pelo adapter).