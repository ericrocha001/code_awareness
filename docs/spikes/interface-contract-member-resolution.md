# Spike — Interface Contract Member Resolution

## Recomendação

`IMPLEMENT LIMITED SCOPE`

Calls cujo receiver possui tipo estático explícito de interface conhecida podem ser ligadas de forma honesta e útil ao método declarado diretamente no contrato. O destino representa o contrato estático, não uma previsão da implementação executada em runtime.

O primeiro escopo deve aceitar somente:

- receiver com tipo simples explícito já capturado pelo `StructureReader`;
- parâmetro tipado, propriedade tipada ou constructor parameter property;
- interface local, local exportada, named import ou named import com alias;
- exatamente um método com o nome chamado, declarado diretamente na interface;
- referência `caller -> interface method` com `kind: call` no grafo existente.

Devem permanecer unresolved no primeiro escopo:

- método herdado de outra interface;
- overloads;
- herança múltipla;
- interface externa não indexada;
- union;
- generic parameter;
- type alias que exigiria alias chasing novo;
- optional chaining, até existir cobertura real específica;
- qualquer tentativa de selecionar implementação concreta.

## Metodologia

Foi executada uma sonda descartável sobre os mesmos 281 arquivos produtivos do benchmark de Member Resolution:

- somente `src`;
- extensões TS, TSX, JS, JSX, MJS e CJS;
- exclusão de testes, specs e benchmarks;
- `readStructure` e `ImportResolver` existentes;
- comparação com as referências já resolvidas pelos Tiers 1–5;
- classificação por ocorrência de member call;
- inspeção dos elementos e ranges de interfaces e métodos;
- projeções hipotéticas com os serializers públicos e o tokenizer canônico.

A sonda e sua entrada temporária no runner foram removidas. Nenhum comportamento produtivo, banco, MCP, baseline, `RelationshipResolver` ou Harness foi alterado.

## Resultado quantitativo

O benchmark permanente ainda reporta 207 interface typed receivers. Essa contagem não reconhece interfaces exportadas e usadas localmente no mesmo arquivo porque seu helper local exige `parentElementId === null`.

A sonda encontrou 15 ocorrências adicionais desse padrão. O universo estrutural correto no checkout é, portanto, 222.

| Superfície | Ocorrências |
|---|---:|
| Coorte do benchmark anterior | 207 |
| Método direto e único nessa coorte | 199 |
| Método herdado nessa coorte | 8 |
| Interfaces locais exportadas antes subcontadas | 15 |
| Universo atualizado | 222 |
| Método direto e único no universo atualizado | 214 |
| Excluído por optional chaining | 2 |
| Elegível no escopo limitado | 212 |
| Bloqueado por interface inheritance | 8 |
| Overload observado | 0 |
| Ambiguidade por herança múltipla observada | 0 |
| Member inexistente observado | 0 |
| Optional chaining observado | 2 |

A implementação posterior corrigiu a detecção de optional chaining da sonda: dois dos 214 métodos diretos estão em calls opcionais e permanecem fora do escopo. Os 212 casos elegíveis atingem 99 métodos de interface distintos.

Partindo das 617 resoluções cumulativas dos Tiers 1–5:

```text
escopo estrito da coorte anterior: 617 + 199 = 816
escopo recomendado após excluir optional chaining: 617 + 212 = 829
```

## Origem dos receivers

| Origem | Ocorrências |
|---|---:|
| Parâmetro explicitamente tipado | 35 |
| Propriedade regular tipada | 130 |
| Constructor parameter property | 57 |

Os Tiers 2, 4 e 5 já preservam o tipo estático necessário. Não é preciso criar novo modelo lexical ou novo fato de propriedade.

## Imports, aliases e tipos externos

| Categoria | Ocorrências |
|---|---:|
| Interface local | 32 |
| Named import interno | 190 |
| Alias de named import observado | 0 |
| Receiver com tipo importado externo, fora da coorte | 119 |

`ImportBinding` já separa `localName` de `importedName`; portanto o mesmo caminho resolve `ServicePort as Port` sem alias chasing adicional. Não há ocorrência real de alias de interface neste corpus para medir volume, mas o suporte estrutural é direto.

Os 119 receivers com tipo importado externo não fornecem uma interface indexada nem um método endereçável. Eles devem continuar unresolved.

Union e generic parameter não aparecem na coorte porque o extrator deliberadamente só materializa `receiverTypeName` para uma única annotation simples. Não se deve ampliar essa extração como parte desta melhoria.

## Representação e addressability

A auditoria encontrou:

| Propriedade | Quantidade |
|---|---:|
| Elementos `interface` | 326 |
| Métodos filhos de interface | 123 |
| Métodos com `parentElementId` para a interface correta | 123 |
| Métodos `retrievable` | 123 |
| Métodos com CodeTarget compacto válido | 123 |

Uma declaração como `ServicePort.execute` já é um `CodeMapElement` de kind `method`, granularity `member`, com range exato e pai `ServicePort`. Como é retrievable, segue o mesmo caminho público de `read_code`: resolução do CodeTarget, validação de retrievability e `getElementExactSources`.

O formato persistido de `symbol_references` também já aceita naturalmente:

```text
sourceElementId = caller
targetElementId = ServicePort.execute
kind = call
```

O resolvedor atual já grava `call` para métodos de classe pelo mesmo caminho. Não é necessário novo schema, tabela ou grafo paralelo.

## Semântica estática

Resolver:

```text
service: ServicePort
service.execute()
```

como:

```text
caller -> call ServicePort.execute
```

é semanticamente correto. A annotation prova o contrato disponível no call site. Ela não prova a classe concreta do objeto.

Consequentemente:

- `get_references(ServicePort.execute)` significa callers estaticamente ligados ao contrato;
- não significa callers runtime de cada implementação concreta;
- múltiplas implementações não produzem múltiplos targets para a call;
- ausência de implementação indexada não invalida o target do contrato.

Entre as 22 interfaces usadas como receiver:

| Implementações diretas conhecidas | Interfaces |
|---|---:|
| Nenhuma | 12 |
| Uma | 5 |
| Múltiplas | 5 |

Das resoluções diretas, 61 calls apontam para contratos sem implementação conhecida e 44 apontam para contratos com múltiplas implementações. Ambas continuam determinísticas porque a identidade resolvida é a do contrato.

## `kind: call`

Não é necessário introduzir `contract-call`.

`call` descreve corretamente a relação sintática e semântica entre caller e método invocado. O target já carrega a distinção: seu pai é uma interface. Um kind novo duplicaria informação estrutural, ampliaria schema, serializers e consumidores e sugeriria uma diferença operacional que o grafo não precisa representar.

O formato model-facing existente é suficiente:

```text
call t:<interface-method> src/ports.ts
```

Quando necessário, `inspect_files` ou `read_code` do target revela imediatamente que o pai é o contrato.

## Efeito em navegação

### `get_symbol_dependencies`

Para um caller elegível, a projeção passa a informar diretamente:

```text
call ServicePort.execute
```

Isso elimina a necessidade de ler o caller apenas para descobrir a dependência de contrato.

### `get_references`

Consultado com o target do método de interface, retorna exclusivamente os locais estaticamente tipados para aquele contrato. Essa resposta é parcial por definição, mas não mistura dispatch concreto nem promete completude runtime.

### Symbol Hierarchy

O fluxo separado permanece coerente:

```text
ServicePort.execute
-> parent ServicePort
-> get_symbol_hierarchy(ServicePort, down)
-> classes que declaram implements ServicePort
```

Isso é informação suficiente para o agente investigar implementações conhecidas sem atribuí-las à call original. A hierarquia atual não liga um método de interface aos métodos correspondentes das classes; uma projeção futura desse tipo deve permanecer separada do call graph.

## Ganho de contexto

As projeções abaixo usam a serialização pública compacta. `reference` inclui todos os callers hipotéticos do target, não apenas a ocorrência escolhida.

| Caller | Target de contrato | Source | Dependencies | References |
|---|---|---:|---:|---:|
| `checkpoint-handler.ts:registerCheckpointHandlers` | `ActionLogPort.insertAction` | 2.756 | 30 | 224 |
| `repository-model.ts:discoverIntegrityIssues` | `RepositoryRepository.getFilesByRepository` | 1.877 | 28 | 287 |
| `repository-model.ts:reconcileWithDisk` | `RepositoryRepository.getFilesByRepository` | 1.488 | 29 | 287 |

Economia observada:

- dependencies: 98–99%;
- references: 81–92%.

A redução é material nos três exemplos reais e não depende de fabricar implementação concreta.

## Interface inheritance

Oito ocorrências usam `CodeMapNavigationPort` e membros declarados em sua interface parent. A sonda conseguiu demonstrar um único método herdado por leitura estrutural, mas a produção não representa `interface extends interface` no `RelationshipResolver` nem oferece essa travessia ao resolvedor comum.

Esses oito casos devem continuar unresolved até a lacuna ser tratada como capacidade própria. Eles representam 3,6% do universo de 222 e não bloqueiam as 212 resoluções elegíveis.

A medição torna a lacuna concreta, mas não justifica elevá-la acima da implementação direta: o ganho adicional é pequeno e exige modelar corretamente ciclos, múltiplos parents e conflitos de nomes.

## Overloads e herança múltipla

Não houve ocorrência real bloqueada por overload ou herança múltipla no universo medido.

A política permanece conservadora:

- mais de um método direto homônimo: unresolved;
- membros homônimos herdados de parents distintos: unresolved;
- não selecionar uma assinatura por aridade sem identidade canônica de grupo;
- não escolher um parent arbitrariamente.

## Call graph

O resultado seria um static contract call graph parcial:

```text
caller -> interface method
```

Essa representação é mais honesta que expandir uma call para todas as implementações possíveis. Uma navegação futura:

```text
interface method -> known implementation methods
```

pode ser útil, mas deve ser uma projeção separada e nunca evidência de que uma call específica executará todas elas.

## Implementação mínima futura

Uma implementação posterior deve reutilizar o fluxo existente de member resolution:

1. obter o `receiverTypeName` já demonstrado pelos Tiers 2, 4 e 5;
2. resolver exatamente uma interface local ou via `ImportResolver`;
3. selecionar exatamente um método filho direto com o nome chamado;
4. emitir a referência existente com `kind: call`;
5. deixar todos os demais casos unresolved.

Não são necessários novo modelo de dados, migração, relação, serializer, ferramenta MCP, baseline ou inferência de dispatch.

## Respostas obrigatórias

### Resolver para o método da interface é semanticamente correto e útil?

Sim. É uma resolução do contrato estático demonstrado pelo source e não uma alegação sobre runtime dispatch.

### Quantas calls unresolved seriam recuperadas?

O universo atualizado contém 214 calls com método direto, mas duas usam optional chaining e permanecem fora. O escopo implementável recupera 212 de 222 e eleva o acumulado de 617 para 829.

### A resolução reduz leitura de source materialmente?

Sim. Nos três exemplos reais, `get_symbol_dependencies` reduziu 98–99% dos tokens e `get_references` reduziu 81–92%.

### O Symbol Reference Graph atual é suficiente?

Sim. `sourceElementId`, `targetElementId` e `kind: call` representam o vínculo sem dispatch artificial. O target do método e seu pai interface preservam a semântica.

### A lacuna `interface extends interface` passa a justificar prioridade?

Ela passa a ter impacto quantificado: oito calls. Isso justifica mantê-la visível, mas não torná-la pré-requisito nem prioridade superior ao escopo direto de 212 calls.

## Harness Improvement Opportunity

`factoryReceivers` continua sendo uma métrica heurística e não deve ser tratada como factory comprovada. A correção deve ser uma manutenção separada do benchmark; não foi incorporada neste Spike.
