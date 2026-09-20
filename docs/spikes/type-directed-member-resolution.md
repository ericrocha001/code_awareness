# Spike — Type-Directed Member Resolution

## Recomendação

`IMPLEMENT LIMITED SCOPE`

Implementar resolução conservadora de membros somente quando o receiver puder ser ligado sintaticamente a um tipo e houver exatamente um membro compatível. Ausência de prova deve continuar produzindo `unresolved`.

Escopo recomendado:

1. `this.method()` e `this.method` na classe atual; se não houver override local, permitir somente um ancestral direto conhecido com um único método homônimo.
2. `parameter: Type` seguido de `parameter.method()`, com binding lexical inequívoco e membro declarado diretamente em `Type`.
3. `const value = new Type()` seguido de `value.method()`, no mesmo binding lexical, sem reassignment e com membro declarado diretamente em `Type`.
4. `this.property.method()` para propriedade com tipo explícito e membro declarado diretamente no tipo.
5. Constructor parameter property explicitamente tipada, como `constructor(private service: Service)`, nas mesmas condições do item anterior.
6. Quando o tipo declarado for interface, apontar para `Interface.method`, nunca para uma implementação concreta.

Continuam fora: receivers produzidos por chamada, containers, element access, cadeias arbitrárias, unions, valores reatribuídos, seleção de overload e despacho para implementação de interface.

## Estado atual

| Fato necessário | Estado | Evidência atual |
|---|---|---|
| Métodos e method signatures | Já disponível | Elementos `method`, com `parentElementId`, localização, assinatura e identidade própria. |
| Classes e interfaces | Já disponível | Elementos estruturais com filhos ligados por `contains`. |
| Parâmetros | Parcial | Elementos existem, mas o tipo não é preservado no elemento. A assinatura do pai contém texto, mas não é um binding tipado confiável. |
| Variáveis e constantes | Parcial | Elementos e ranges existem; initializer e tipo inferido por `new` não são fatos disponíveis ao resolver. |
| Propriedades | Parcial | `public_field_definition` e `property_signature` viram elementos, mas o tipo explícito não é preservado. |
| Constructor parameter properties | Parcial | Tree-sitter expõe `required_parameter` com `accessibility_modifier` e `type_annotation`; hoje ele vira apenas parâmetro do constructor, não propriedade da classe. |
| Ancestralidade estrutural | Já disponível | `parentElementId` e `contains` permitem encontrar a classe do método. Blocos lexicais não são indexados. |
| Herança e implementação | Já disponível com fronteira | Relações diretas `extends` e `implements` existem para TypeScript; interface inheritance e JavaScript inheritance permanecem lacunas conhecidas. |
| Imports e aliases | Já disponível | `ImportBinding` preserva módulo, nome importado e alias local. |
| Type references | Já disponível | Candidates `type` são resolvidos para classe/interface/type alias/enum. |
| Symbol references | Já disponível | `symbol_references` já acomoda origem, destino, kind e localização. |
| Member expressions | Faltante | O extrator só cria candidate `call` quando o callee é um `identifier`; `member_expression` é ignorado como chamada. |
| Binding lexical | Faltante | Há heurísticas de shadowing, mas não há identidade de escopo de bloco nem ligação ocorrência → declaração. |

O resolver atual recebe somente `name`, `kind`, `location` e `sourceElementId`. Essa forma é suficiente para símbolos top-level locais/importados, mas perde receiver, propriedade acessada e evidência do tipo. Métodos também não pertencem aos kinds aceitos por `call`, que hoje aceita apenas `function`.

`CodeMapElement.id` é suficiente para identidade de métodos: inclui arquivo, pai, kind, nome, assinatura e twin index. Homônimos em classes distintas não colidem. Overrides têm identidades distintas. Overloads também têm identidades distintas, mas não existe identidade canônica de grupo; portanto, overloads devem permanecer unresolved.

## Fatos Tree-sitter

Uma sonda executada com a gramática TypeScript usada pelo projeto confirmou:

- `this.execute()` é `call_expression(function: member_expression(object: this, property: property_identifier))`;
- `parameter.execute()` e `local.execute()` usam `member_expression(object: identifier, property: property_identifier)`;
- `this.service.execute()` contém dois `member_expression` aninhados;
- `parameter: Service` é `required_parameter` com `type_annotation(type_identifier)`;
- `const local = new Service()` é `lexical_declaration → variable_declarator → new_expression`;
- `private field: Service` é `public_field_definition` com `property_identifier` e `type_annotation`;
- `constructor(private service: Service)` é um `required_parameter` com `accessibility_modifier` e `type_annotation`.

Esses são fatos sintáticos. Concluir que um identifier usa determinada declaração exige binding lexical. Concluir que uma interface escolhe uma implementação concreta ou que uma expressão dinâmica retorna determinado tipo seria inferência semântica não demonstrada e deve ser rejeitada.

## Padrões investigados

| Padrão | Classificação | Condições |
|---|---|---|
| `this.method()` na mesma classe | Reliable | Receiver literal `this`; um único método local; override local precede base. |
| `this.method` sem chamada | Reliable para referência | Mesmas condições; persistir como `reference`, não `call`. |
| `this.method()` em base direta | Conditional | Somente se não existir método local e houver exatamente um membro na base direta conhecida. Não atravessar ancestralidade arbitrária. |
| Parâmetro explicitamente tipado | Conditional | Exige binding lexical ocorrência → parâmetro e resolução inequívoca do tipo/alias. |
| `const x = new Type()` | Conditional | Exige escopo lexical, declaração anterior, `const`, initializer direto e ausência de ambiguidades. |
| Propriedade explicitamente tipada | Conditional | Exige preservar tipo da propriedade durante extração e resolver `this.property`. |
| Constructor parameter property | Conditional | Exige materializar o fato de que o parâmetro também declara uma propriedade. |
| Método de interface | Reliable como símbolo declarado | Resolver para `Interface.method`; não afirmar implementação runtime. |
| Overload | Unsafe | Argumentos não devem selecionar overload; não há target canônico de grupo. |
| Receiver por chamada, container, índice, union ou assignment | Unsafe | Exigiria inferência de fluxo ou typechecker. |
| Cadeia arbitrária como `foo.bar.baz.execute()` | Unsafe | Cada elo exigiria novo binding/tipo; fora do subconjunto conservador. |

## Dados reais

Medição em 16 de setembro de 2026 sobre `src`, `infra` e `scripts`. O conjunto principal contém 322 arquivos TS/TSX/JS não-testados; arquivos `*.test.*`, `*.spec.*` e declarations foram excluídos. Uma segunda passagem cobriu todos os 461 arquivos indexáveis. A contagem usou um scanner AST descartável, sem typechecker, e as formas sintáticas relevantes foram confirmadas separadamente com o Tree-sitter nativo do projeto. O protótipo foi removido após a medição.

Uma ocorrência foi marcada como potencialmente resolvível somente quando o binding sintático se encaixava no padrão, o tipo local/importado era encontrável e havia exatamente um método direto ou em uma base direta. “Não resolvível” agrega tipo/membro ausente, overload e binding insuficiente; não significa necessariamente código inválido.

| Categoria | Total produção | Potencialmente resolvível | Não resolvível conservadoramente |
|---|---:|---:|---:|
| `this.method()` | 491 | 444 | 47 |
| parâmetro explicitamente tipado | 614 | 109 | 505 |
| `const x = new Type(); x.method()` | 484 | 62 | 422 |
| propriedade explicitamente tipada | 317 | 192 | 125 |
| constructor parameter property | 106 | 89 | 17 |
| **Total prioritário** | **2.012** | **896 (44,5%)** | **1.116** |
| dinâmico ou fora dos padrões | 5.307 | 0 | 5.307 |

Dos 896 targets potenciais, 238 são métodos de interface: 35 em parâmetros, 130 em propriedades e 73 em constructor parameter properties. Eles são úteis como dependência do contrato declarado, mas não representam despacho runtime. Os 658 restantes apontam para classes concretas segundo a regra medida. O caso `this.method()` inclui oito resoluções por uma base direta.

Incluindo testes, foram observadas 3.206 chamadas prioritárias, das quais 1.865 seriam potencialmente resolvíveis. O salto é explicado principalmente por 1.028 chamadas resolvíveis sobre `const x = new Type()` em testes.

Há ainda 1.227 acessos de membro `this.x` sem chamada em produção. Apenas três eram métodos únicos segundo a mesma regra; a maioria são propriedades e não deve ser confundida com referência de método.

## Necessidade de lexical scopes

Binding lexical explícito, ou estrutura equivalente durante extração, é necessário para parâmetros e variáveis locais. `sourceElementId` identifica a função/método estrutural, mas não distingue blocos aninhados, shadowing entre blocos ou qual declaração homônima está ativa no ponto da ocorrência.

Não é necessário persistir uma tabela geral de escopos. A alternativa mínima é resolver o binding enquanto a AST está disponível, com uma pilha de escopos e ordem de declaração, e emitir no candidate somente a evidência normalizada necessária para a resolução cross-file. Se o extrator não puder demonstrar o binding, não emite candidate de membro.

`this.method()` não precisa de escopo lexical: classe atual, pai estrutural e nome do membro bastam. Propriedades precisam de um mapa sintático da classe, não de escopo geral. Constructor parameter properties precisam ser reconhecidas como propriedade da classe além de parâmetro do constructor.

## Arquitetura mínima

Não criar grafo paralelo nem typechecker.

1. Estender a extração com um candidate de membro que preserve member name, kind, `sourceElementId`, localização e uma evidência discriminada do receiver: `this`, tipo explícito ligado lexicalmente, `const-new` ou propriedade tipada de `this`.
2. Manter um resolvedor lexical estritamente local e efêmero durante a travessia Tree-sitter. Ele aceita somente identifiers simples, respeita blocos, declaração anterior e shadowing e não é persistido.
3. No resolver existente, resolver o tipo por declaração local ou `ImportBinding`, encontrar a classe/interface e selecionar exatamente um filho `method` compatível.
4. Para `this`, procurar primeiro a classe atual; somente na ausência de override, consultar uma base direta conhecida.
5. Persistir o resultado como `symbol_references` com `kind: call` ou `reference`.

Não são necessárias novas tabelas. Também não é necessário alterar CodeScope, MCP ou as projeções existentes: `get_references` e `get_symbol_dependencies` consumiriam as novas arestas automaticamente.

## Incrementalidade

A substituição atômica de `symbol_references` por arquivo-fonte já atende mudanças locais. O mecanismo atual também reavalia importadores diretos quando um arquivo-alvo muda, suficiente para members declarados diretamente no tipo importado.

Há uma fronteira importante: resolver em consumidores um método herdado de um ancestral indireto introduziria invalidação transitiva. Um consumidor pode importar `Child`, enquanto a mudança ocorre em `Base`; atualizar apenas importadores diretos de `Base` não alcança esse consumidor. Por isso, o primeiro escopo deve:

- permitir base direta para `this.method()` dentro do próprio arquivo da subclasse, que importa/conhece diretamente a base;
- não resolver membro herdado para parâmetros, propriedades ou `const-new` em arquivos consumidores até existir uma política incremental comprovada;
- continuar reindexando somente o arquivo alterado e seus importadores diretos.

Adicionar/remover método no tipo declarado, mudar tipo explícito, initializer, import alias ou receiver reindexa o source ou um importador direto. Isso mantém custo incremental aceitável e evita reindex global.

## Ganho para `get_references`

Hoje um target de método não recebe as chamadas `receiver.method()`, então `get_references(methodTarget)` retorna incompleto e o agente precisa inspecionar arquivos e ler source.

Dois exemplos reais:

- `CodeMapService.ensureInstance` possui 21 chamadas `this.ensureInstance()` no mesmo arquivo. O arquivo inteiro custa 4.621 tokens canônicos; a projeção compacta estimada dessas 21 referências custa 321 tokens. O caminho passa de inspeção + leitura de um arquivo para uma chamada de `get_references`, sem leitura de source.
- `ContextEngine.validatePaths` possui três chamadas `this.validatePaths()`. O arquivo inteiro custa 3.013 tokens; a projeção compacta estimada custa 51 tokens.

Esses números isolam source versus projeção e não incluem envelopes de ferramenta. Ainda assim, mostram redução de aproximadamente 93% e 98% no conteúdo relevante desses exemplos, além de eliminar seleção manual de call sites.

## Ganho para `get_symbol_dependencies`

Uma chamada resolvida já cabe no contrato persistido existente:

```text
sourceElementId = método chamador
targetElementId = método chamado
kind = call
```

Assim, métodos como `ContextEngine.inspectFiles` passariam a listar diretamente chamadas internas como `validatePaths` e `selectFiles`; métodos de `CodeMapService` passariam a expor `ensureInstance` como dependência. O benefício é simétrico ao inbound: as mesmas 896 ocorrências potenciais enriquecem dependências outbound sem nova projeção.

## Relação com Call Graph

As referências `call` existentes já contêm caller (`sourceElementId`) e callee (`targetElementId`). Depois da resolução limitada, elas são suficientes para um grafo direto de callers/callees sobre símbolos declarados.

Esse grafo não é um call graph runtime completo. Chamadas a métodos de interface terminam no método da interface; despacho dinâmico, overload selection e receivers inferidos continuam ausentes. Nenhuma ferramenta de call graph deve ser criada como parte desta implementação.

## Resposta à pergunta obrigatória

Sim. Implementar Type-Directed Member Resolution agora, no escopo limitado acima, aumentaria materialmente a capacidade do agente de navegar e entender o Code Awareness com menos leitura de source.

A conclusão se apoia em 896 chamadas potencialmente resolvíveis nos 322 arquivos de produção auditados, incluindo 444 casos de alta confiança de `this.method()`. Os exemplos reais medidos reduzem milhares de tokens de source para dezenas ou centenas de tokens de referências compactas. O ganho não exige TypeScript Language Service, tabela nova, grafo paralelo ou mudança pública; exige apenas preservar evidência sintática do receiver e realizar binding lexical local conservador.

O valor não justifica resolução universal. A implementação deve falhar fechada e manter todos os padrões dinâmicos fora do grafo.
