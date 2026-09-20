# Spike — Factory e Local Type Flow Resolution

## Recomendação

`DEFER`

Factory/type-flow não é a próxima melhoria de maior retorno para Member Resolution no checkout medido. A classificação AST exata encontrou zero member calls adicionais que pudessem ser ligadas a uma classe concreta indexada por return type explícito ou por retorno direto de `new`.

Não implementar `LocalValueOrigin`, análise de corpos, CFG, TypeScript Language Service, persistência adicional ou novo contrato público neste momento.

## Estado atual

A infraestrutura existente já separa quase todo o problema:

- a pilha lexical efêmera do `StructureReader` liga receivers a parâmetros e declarações locais, respeitando blocos, shadowing e ordem;
- `const x = new Type()` já materializa origem suficiente para o Tier 3;
- calls simples de factory já podem gerar referência para a própria função local ou importada;
- `ImportResolver` resolve named imports e aliases;
- `CodeMapElement.returnType` preserva o return type como fato estruturado;
- o resolvedor comum já encontra classe, método, override e método herdado;
- `symbol_references` já representa caller e callee;
- reindexação do arquivo e de importadores diretos já cobre mudanças locais e named imports diretos.

O binding lexical não é a lacuna principal. A lacuna é demonstrar a origem concreta do valor do initializer.

## Metodologia

Foi executada uma sonda Tree-sitter descartável sobre os mesmos 281 arquivos produtivos usados pelo benchmark atual de Member Resolution:

- somente `src`;
- extensões TS, TSX, JS, JSX, MJS e CJS;
- exclusão de testes, specs e benchmarks;
- binding lexical por pilha de escopos;
- apenas `const` visível e anterior à ocorrência;
- apenas candidates produtivos com receiver identifier e sem tipo conhecido;
- resolução local/importada conservadora;
- nenhuma alteração em código produtivo, banco, MCP ou baselines.

A sonda e sua entrada temporária no runner de benchmark foram removidas ao final.

## Correção da estimativa anterior

O número anterior de 528 factory receivers era uma heurística textual. Ele detectava a existência de declarações com o mesmo nome no arquivo, mas não provava que a ocorrência estava ligada lexicalmente à declaração nem que o initializer era uma factory.

A passagem estrutural encontrou:

| Superfície | Ocorrências |
|---|---:|
| Receivers sem tipo ligados inequivocamente a um `const` | 307 |
| Initializers que são calls | 100 |
| Calls por identifier | 15 |
| Calls de membro | 85 |
| Initializers não-call | 207 |

Assim, 528 deve ser tratado como limite heurístico antigo, não como universo real de factories resolvíveis.

## Taxonomia real

| Categoria | Calls | Classificação |
|---|---:|---|
| Return type explícito para classe concreta indexada | 0 | `DETERMINISTIC`, mas ausente |
| Return type explícito para interface | 1 | `UNSAFE` para concrete dispatch |
| Return type explícito para tipo externo não indexado | 2 | `UNSAFE` |
| Return genérico/container | 8 | `UNSAFE` |
| Factory identifier externa ou não resolvida | 3 | `UNSAFE` |
| `await`/async/Promise | 2 | `CONDITIONAL`, fora do primeiro escopo |
| Initializer por member call não-await | 84 | `CONDITIONAL`; exige resolver o callee e seu retorno |
| Conditional initializer | 2 | `UNSAFE` |
| Outros initializers locais | 205 | Fora de factory/type-flow |
| Direct `return new Type()` elegível | 0 | `DETERMINISTIC`, mas ausente |
| Arrow direct `new` elegível | 0 | `DETERMINISTIC`, mas ausente |
| Arrow block com direct `new` elegível | 0 | `DETERMINISTIC`, mas ausente |
| Múltiplos returns da mesma classe | 0 | Não observado |
| Múltiplas classes possíveis | 0 | Não observado |
| Identity/pass-through | 0 | Não observado |
| Destructuring de factory | 0 | Não observado |

As 85 calls de membro não são 85 factories concretas. A maioria são transformações como `path.split()`, `array.map()`, `content.slice()` ou chamadas a métodos internos cujo tipo de retorno exigiria uma resolução anterior do próprio método.

## Estratégia declaration-driven

O return type de funções já está disponível diretamente em `CodeMapElement.returnType`. A `declarationSignature` também o contém, mas não precisa nem deve ser parseada.

Uma implementação limitada poderia atravessar:

```text
const binding
→ initializer call por identifier
→ função local ou named import
→ returnType simples
→ classe concreta
→ método de instância
```

Esse caminho seria pequeno, determinístico e incremental para funções locais e named imports diretos. No checkout atual, porém:

```text
Strategy 1 only → 0 calls adicionais
```

Os únicos casos anotados terminam em:

- `TokenizerPort`, uma interface;
- `Server`, um tipo externo não indexado, em duas calls;
- containers genéricos como `Array`, `Set` e `Map`.

Não há volume real que justifique implementação agora.

## Estratégia body-driven

O `StructureReader` percorre `return_statement`, `new_expression` e `call_expression`, mas não preserva a relação:

```text
função → origem concreta de retorno
```

`new_expression` pode gerar uma referência de instanciação, porém isso não prova isoladamente que o objeto é retornado. Para inferência por corpo seria necessário extrair um fato adicional durante a AST, agregar todos os returns diretos, excluir funções aninhadas, tratar controle de fluxo e disponibilizar o resultado durante reindexações futuras.

A sonda avaliou:

- function com único `return new Type()`;
- arrow expression com `new Type()`;
- arrow block com return direto;
- múltiplos returns convergentes;
- múltiplas classes possíveis;
- return-through-call.

Nenhum receiver do universo medido ganhou resolução por esses padrões:

```text
Strategy 1 + simple direct-return inference
→ 0 calls adicionais

Ganho marginal da análise de corpo
→ 0
```

Logo, o custo adicional não se justifica sobre a estratégia declaration-driven.

## Lexical binding

A infraestrutura dos Tiers 2 e 3 é suficiente para o subconjunto local considerado. Uma pilha efêmera de escopos consegue provar:

```text
receiver
→ declaração const correta
→ initializer
```

Não é necessário persistir um modelo lexical formal nem criar tabela de escopos. O problema restante é value-origin resolution.

## Value origin

Um conceito pequeno de `LocalValueOrigin` seria tecnicamente possível, por exemplo:

```text
new-class
function-return-class
function-direct-new-return
```

Os dados atuais não demonstram reutilização suficiente para justificar essa abstração. Criá-la agora seria arquitetura especulativa.

Se o corpus mudar, a primeira reconsideração deve ser apenas `function-return-class`, derivada de return type explícito. Body origins devem continuar separados.

## Incrementalidade

### Declaration-driven

- factory local: a mudança reindexa o próprio arquivo;
- named factory importada: mudança do return type reavalia importadores diretos;
- a call para a factory já pode existir em `symbol_references`, mas o mecanismo atual de importadores diretos já é suficiente para depth 1;
- reexports, default imports, namespace imports e propagação por calls continuam fora.

Não seria necessário reindex global nem nova tabela.

### Body-driven

Uma mudança de `return new Service()` para `return new OtherService()` também poderia reavaliar importadores diretos em depth 1, mas o return origin precisaria estar disponível fora da AST do arquivo-alvo. Isso exigiria novo fato persistido ou ampliação equivalente do modelo estrutural.

Return-through-call introduziria dependência transitiva, profundidade, ciclos e invalidação indireta. Deve permanecer fora.

## Precisão

| Padrão | Política recomendada |
|---|---|
| Return type explícito para classe concreta local/importada | `DETERMINISTIC` |
| Único direct return de `new Class()` | `DETERMINISTIC`, mas deferido |
| Arrow direct `new Class()` | `DETERMINISTIC`, mas deferido |
| Todos os returns diretos na mesma classe | Potencialmente determinístico; sem volume observado |
| Return interface | `UNSAFE` para implementação concreta |
| Generic return | `UNSAFE` |
| Multiple possible classes | `UNSAFE` |
| Conditional initializer | `UNSAFE` |
| External factory | `UNSAFE` |
| Member/static factory | `CONDITIONAL`; requer outra resolução antes |
| Return-through-call | `UNSAFE` no primeiro escopo |
| Async/Promise/await | `CONDITIONAL`; fora do primeiro escopo |
| Recursive factory | `UNSAFE`; não propagar |

## Cobertura potencial

Sobre os números atuais:

```text
Tiers 1–5 resolved: 617
Strategy 1 additional: 0
Strategy 2 additional: 0
Potential total after factory/type-flow: 617
```

Factory/type-flow não reduz materialmente os 2.913 identifier receivers unresolved neste checkout.

## Ganho de tokens

Não existem três casos reais potencialmente resolvíveis sob a política de classe concreta. Portanto não há comparação legítima de source versus `get_references`/`get_symbol_dependencies` para produzir.

Os três casos mais próximos não admitem target model-facing correto:

1. `getCanonicalTokenizer() → TokenizerPort`: termina em interface, sem implementação concreta demonstrável;
2. `createMcpHttpServer() → Server`, chamada `listen`: tipo externo não indexado;
3. `createMcpHttpServer() → Server`, chamada `close`: tipo externo não indexado.

Fabricar targets ou projeções para esses casos superestimaria o ganho e violaria a política de precisão do Spike.

## Relação com interfaces

Foi encontrado um caso declaration-driven que termina em interface: `TokenizerPort.count`.

A annotation prova o contrato `TokenizerPort`, não que o runtime receiver é `CanonicalTokenizer`. Resolver para a implementação concreta exigiria interface dispatch e não pertence a este Spike.

## Relação com `let`

O benchmark anterior encontrou 80 receivers associados heuristicamente a `let`. Reutilizar initializer origin ajudaria apenas depois de provar ausência de reassignment.

Essa prova exige pelo menos varredura de assignments e awareness de funções/blocos aninhados. Não requer necessariamente CFG completo para um subconjunto conservador, mas é uma capacidade diferente e não ganha suporte automaticamente com factory resolution.

## Relação com Call Graph

O grafo atual já representa:

```text
caller → factory
```

quando a factory local/importada é resolvida como call. Uma resolução de origem acrescentaria:

```text
caller → ConcreteType.method
```

Isso seria suficiente para navegação direta sem nova ferramenta de call graph. O problema observado não é representação; é ausência de origem concreta comprovável.

## Arquitetura mínima recomendada

Resultado escolhido: opção D.

```text
Custo/volume atual insuficiente → defer
```

Se uma medição futura encontrar volume material, reconsiderar somente:

```text
const receiver = factoryIdentifier()
factory local ou named import
returnType explícito e simples
returnType resolve para classe concreta indexada
método único pelo resolvedor existente
depth 1
```

Não incluir body inference, member factories, interfaces, async, pass-through, reexports, default/namespace imports ou calls transitivas no primeiro escopo futuro.

## Respostas obrigatórias

### Factory/type-flow é realmente a próxima melhoria de maior retorno?

Não. A estimativa de 528 era heurística; a medição estrutural encontrou somente 100 const receivers originados por calls e zero destinos adicionais de classe concreta.

### Podemos capturar parte material sem CFG ou TypeScript Language Service?

Tecnicamente é possível capturar explicit return class sem CFG ou Language Service, mas o checkout atual contém zero calls elegíveis. Portanto a parte material é zero.

### Body inference justifica a complexidade sobre return types explícitos?

Não. O ganho marginal medido foi zero, enquanto a solução exigiria um novo fato de return origin e maior superfície incremental.

### Precisamos de modelo lexical formal?

Não para este subconjunto. O binding conservador existente é suficiente; o problema restante é value-origin resolution. Como esse origin não oferece cobertura real agora, também não deve ser implementado.

## Limitações da medição

- O universo segue o benchmark atual: 281 arquivos produtivos sob `src`.
- Calls de membro foram classificadas como uma fronteira única; não houve tentativa de resolver recursivamente o return type do método.
- Tipos externos não indexados foram corretamente considerados unresolved.
- Não foi executado TypeScript Language Service nem inferência semântica.
- As categorias são por member-call occurrence, não por quantidade de declarações únicas.

## Oportunidades de melhoria

O campo `factoryReceivers` do benchmark permanente é uma heurística textual e deveria ser renomeado ou substituído por uma medição estrutural antes de orientar uma futura priorização. Esta correção de Harness é útil, mas não foi incorporada ao benchmark produtivo durante o Spike para evitar transportar o protótipo descartável para a suíte permanente.
