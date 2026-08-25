# Structural Information Specification

> Este documento define quais informações estruturais o Repository Model do Code Awareness deve conhecer. É o contrato entre o Structure Reader (que coleta) e o Repository Model (que armazena). Qualquer adaptador de linguagem deve produzir exatamente estes campos.

## Princípio de Coleta

> O Repository Model armazena toda informação estrutural exposta pelo parser que seja independente da lógica de execução do programa.

**Coletar** (estrutura): classes, funções, métodos, interfaces, enums, tipos, variáveis, constantes, imports, exports, parâmetros, tipo de retorno, visibilidade, modificadores, herança, interfaces implementadas, decorators, generics, namespaces, localização completa, relações de composição, existência de documentação.

**NÃO coletar** (lógica): corpo de funções, expressões, ifs, fors, whiles, chamadas internas, literais, operadores.

---

## 1. Arquivo (`CodeMapFile`)

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `id` | `string` | Identificador estável (hash de repositoryId + relativePath) |
| `repositoryId` | `string` | ID do repositório |
| `relativePath` | `string` | Caminho relativo à raiz do repositório |
| `language` | `string` | Linguagem detectada (ex: `"typescript"`) |
| `extension` | `string` | Extensão com ponto (ex: `".ts"`) |
| `lines` | `number` | Quantidade total de linhas |
| `sizeBytes` | `number` | Tamanho em bytes |
| `mtime` | `number` | Timestamp de última modificação |
| `status` | `'indexed' \| 'modified'` | Estado de sincronização |

---

## 2. Elemento (`CodeMapElement`)

### 2.1 Identificação

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `id` | `string` | ID estável determinístico (hash de repositoryId + path + kind + name + parentId) |
| `repositoryId` | `string` | ID do repositório |
| `fileId` | `string` | ID do arquivo (hash) |
| `kind` | `CodeMapElementKind` | Tipo: class, function, method, interface, enum, typeAlias, variable, constant, import, export |
| `name` | `string` | Nome do elemento |
| `parentElementId` | `string \| null` | Elemento pai (null se raiz) |

### 2.2 Localização (`ElementLocation`)

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `location.start.line` | `number` | Linha inicial (1-indexed) |
| `location.start.column` | `number` | Coluna inicial (0-indexed) |
| `location.start.byte` | `number` | Offset inicial em bytes |
| `location.end.line` | `number` | Linha final (1-indexed) |
| `location.end.column` | `number` | Coluna final (0-indexed) |
| `location.end.byte` | `number` | Offset final em bytes |
| `sizeLines` | `number` | `endLine - startLine` |
| `sizeBytes` | `number` | `endByte - startByte` |

### 2.3 Assinatura

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `visibility` | `'public' \| 'private' \| 'protected' \| null` | Visibilidade (quando aplicável) |
| `modifiers` | `string[]` | Modificadores: static, async, abstract, readonly, declare, override |
| `returnType` | `string \| null` | Tipo de retorno (funções/métodos) |
| `baseClass` | `string \| null` | Classe base para herança |
| `hasDocumentation` | `boolean` | Presença de JSDoc ou docstring |
| `parameterCount` | `number` | Quantidade de parâmetros |

### 2.4 Coleções variáveis (tabelas auxiliares)

| Tabela | Campos | Descrição |
|--------|--------|-----------|
| `element_parameters` | `element_id, position, name, type` | Parâmetros de funções/métodos |
| `element_interfaces` | `element_id, interface_name` | Interfaces implementadas por classes |
| `element_decorators` | `element_id, decorator_name` | Decorators/annotations |
| `element_type_parameters` | `element_id, name, constraint_text` | Generics/type parameters |

---

## 3. Relacionamentos (`CodeMapRelationship`)

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `id` | `string` | ID estável (hash de sourceId + targetId + type) |
| `repositoryId` | `string` | ID do repositório |
| `sourceId` | `string` | ID do elemento ou arquivo de origem |
| `targetId` | `string` | ID do elemento ou arquivo de destino |
| `type` | `CodeMapRelationshipType` | Tipo da relação |

### Tipos de relacionamento

| Tipo | Origem | Destino | Descrição |
|------|--------|---------|-----------|
| `contains` | Elemento | Elemento | Pai contém filho (ex: classe contém método) |
| `extends` | Classe | Classe | Herança de classe |
| `implements` | Classe | Interface | Implementação de interface |
| `imports` | Elemento (import) | Arquivo | Import de módulo (resolvido para arquivo local) |
| `exports` | Arquivo | Elemento | Export de elemento |

### Resolução cross-file

O Structure Reader coleta apenas dados brutos (nomes de classes base, nomes de interfaces, caminhos de import). A resolução para `targetId` real é feita pelo Repository Model após a indexação completa, usando as seguintes regras:

- **Herança e interfaces**: resolução por nome simples (primeira ocorrência no repositório).
- **Imports**: resolução por caminho relativo, tentando variações `.ts`, `.tsx`, `/index.ts`, `/index.tsx`. Imports de pacotes externos são descartados.
- **Referências não resolvidas**: descartadas silenciosamente (não geram erro).

---

## 4. Configuração por Repositório

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `enabled_languages` | `string[]` (JSON) | Linguagens habilitadas (ex: `["typescript"]`) |
| `ignored_patterns` | `string[]` (JSON) | Padrões ignorados (ex: `["*.test.ts"]`) |
| `max_file_size_bytes` | `number` | Limite de indexação (default: 2MB) |
| `last_sync_at` | `string \| null` | Timestamp da última sincronização |
| `gitignore_hash` | `string \| null` | Hash do .gitignore para detectar mudanças |

---

## 5. Versionamento do Schema

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `schema_version` | `number` | Versão do schema SQL |
| `model_version` | `number` | Versão do modelo estrutural |
| `parser_version` | `string \| null` | Versão do Tree-sitter e gramáticas |
| `created_at` | `string` | Timestamp de criação |
| `updated_at` | `string` | Timestamp de última atualização |

### Regra de evolução

Quando `model_version` do banco divergir do `model_version` em código → reconstrução automática do índice (marcar todos os arquivos como Modified e disparar sincronização).

---

## 6. Linguagens suportadas

### MVP

| Linguagem | Extensões | Gramática Tree-sitter |
|-----------|-----------|----------------------|
| TypeScript | `.ts`, `.tsx` | `tree-sitter-typescript` (typescript + tsx) |

### Futuro

JavaScript, Python, Go, Rust, Java, Kotlin, C#, PHP, Ruby, Swift, C, C++.

Cada linguagem requer um `Language Adapter` específico e mapeamentos de nós no `Structure Reader`, mas deve produzir exatamente os mesmos campos desta especificação.

---

## 7. Invariantes

1. O `fileId` é sempre determinístico: `hash(repositoryId + relativePath)`.
2. O `elementId` é sempre determinístico: `hash(repositoryId + path + kind + name + parentId)`.
3. Relacionamentos cross-file são resolvidos apenas quando o target existe no repositório.
4. Referências não resolvidas são descartadas silenciosamente.
5. O modelo em memória é reconstruído a cada indexação completa.
6. Falhas de parsing nunca quebram o pipeline — retornam arrays vazios.
7. O Repository Model é a única fonte de verdade estrutural — nenhuma funcionalidade deve persistir dados estruturais diretamente.

---

## 8. Status da Implementação

### Coletado no MVP (TypeScript)

- Todos os campos de `CodeMapFile`
- Todos os campos de `CodeMapElement` (exceto coleções variáveis)
- Relacionamentos: `contains`, `extends`, `implements`, `imports`

### Planejado para iterações futuras

- Tabelas auxiliares: `element_parameters`, `element_interfaces`, `element_decorators`, `element_type_parameters`
- Relacionamentos: `exports`
- Suporte a outras linguagens
