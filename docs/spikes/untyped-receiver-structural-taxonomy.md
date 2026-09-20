# Spike — Taxonomia Estrutural dos Receivers sem Tipo

## Recomendação

Priorizar uma investigação de **runtime bindings importados diretamente** antes de qualquer type flow geral.

O corpus contém 119 chamadas com origem pequena e determinística:

- 104 chamadas em named imports ligados a `export const x = new Type()`;
- 12 chamadas em `settingsService`, ligado a `SettingsService.getInstance()` com return type explícito `SettingsService`;
- 3 chamadas estáticas em uma classe importada diretamente.

Esse grupo pode reutilizar import resolution, classes, métodos e return types já indexados. Não exige CFG, TypeScript Language Service nem inferência de corpos para os 104 casos `const-new` e os 3 casos estáticos. Os 12 casos `getInstance()` exigem somente value-origin depth 1 com return type explícito.

## Metodologia

A medição usa os mesmos 281 arquivos produtivos e o mesmo universo do benchmark permanente de Member Resolution. Cada ocorrência é ligada à declaração lexical pela AST, respeitando escopo, shadowing, ordem, funções, callbacks e blocos.

As categorias são por ocorrência de member call, não por declaração única. Subcategorias como destructuring e callback são cortes do universo principal e não devem ser somadas novamente à decomposição exclusiva.

## Decomposição exclusiva

| Origem | Ocorrências | Informação ausente | Complexidade provável | Valor para navegação |
|---|---:|---|---|---|
| `const` com initializer | 1.200 | tipo/origem do valor | varia por initializer | médio |
| unbound/global | 779 | símbolo externo indexável | fora do índice local | baixo |
| parâmetro | 419 | annotation suportada ou tipo vindo do caller | média/alta | médio |
| named import | 357 | origem runtime do export | baixa para singletons/classes; maior para objetos | alto no subconjunto interno |
| `let` | 74 | origem e estabilidade do valor | alta quando reassigned | baixo/médio |
| `for-of const` | 58 | tipo do elemento do container | média/alta | médio |
| default import | 27 | símbolo externo | externo | baixo |
| class binding local | 1 | semântica estática | baixa | baixo volume |
| namespace import | 1 | símbolo externo | externo | baixo |
| **Total** | **2.916** |  |  |  |

## Parâmetros

Dos 419 receivers por parâmetro:

- 269 têm annotation que o extractor deliberadamente não materializa;
- 145 não têm annotation;
- 5 têm sintaxe simples, mas aparecem em formas como destructuring que não produzem o mesmo binding tipado.

Sintaxes dominantes: 159 `predefined_type`, 56 arrays, 31 genéricos, 12 qualified/nested types e 145 sem annotation. Os 56 callbacks são um subconjunto dos parâmetros; apenas um callback source já aponta para método interno indexado.

Parâmetro sem annotation exige propagação interprocedural do caller. Arrays, genéricos e callbacks exigem elemento/container type. Não são uma melhoria pequena equivalente aos Tiers 1–6.

## `const`

Os 1.200 receivers ligados a `const` de initializer tradicional se decompõem integralmente em:

| Initializer | Ocorrências |
|---|---:|
| array | 484 |
| member call | 297 |
| identifier call | 213 |
| binary | 45 |
| await | 37 |
| member expression | 33 |
| subscript expression | 32 |
| conditional | 19 |
| `as` expression | 18 |
| identifier | 18 |
| literal | 4 |

Somente cinco ocorrências são aliases simples para bindings com tipo já conhecido. Não existe volume material para um Tier de alias local isolado.

### Identifier call initializers

As 213 ocorrências vêm de 179 imports externos, 22 imports internos ainda sem callee resolvido e 12 calls externas/não resolvidas. Nenhuma possui callee e return type interno comprovados pelo grafo atual. Portanto não existe grupo de factory identifier concreto pronto para resolução.

### Member call initializers

Das 297 ocorrências, 72 apontam para métodos internos indexados. Seus returns são 45 genéricos/containers e 27 tipos externos ou não indexados. Nenhuma retorna classe ou interface concreta indexada.

Os nomes mais frequentes incluem `trim`, `split`, `map`, `slice`, `filter` e `sort`, além de métodos internos como `prepare`, `ensureConnection` e `getFilesByRepository`. O grupo mistura transformação de valores e APIs internas; tratá-lo como factory seria incorreto.

## Imports diretos

Das 357 ocorrências por named import:

- 231 são imports externos;
- 126 são imports internos.

As origens AST dos 126 casos internos são:

| Origem exportada | Ocorrências |
|---|---:|
| `new TelemetryService()` | 81 |
| `new RepositoryEventBus()` | 17 |
| `SettingsService.getInstance()` | 12 |
| arrays exportados | 6 |
| `new TagService()` | 6 |
| classe importada diretamente | 3 |
| `new Set()` | 1 |

Os 104 casos `const-new`, os 12 do singleton com return type explícito e os 3 métodos estáticos formam a oportunidade determinística de maior ROI observada.

## `let`, `var`, iteration e catch

- `let`: 74 ocorrências; 61 possuem reassignment observado antes da call e 13 não possuem.
- `var`: zero ocorrências.
- `for-of const`: 58 ocorrências.
- catch binding: zero ocorrências.

Um Tier geral de `let` exigiria data flow ou CFG para a maior parte do grupo. Um subconjunto sem reassignment recuperaria no máximo 13 ocorrências e não justifica prioridade.

## Destructuring

Foram observadas 114 ocorrências em destructuring de `const`, 70 em parâmetros e 11 em `for-of const`. O tipo depende da propriedade ou do elemento extraído do valor de origem; não há identidade simples equivalente a alias direto.

## Globals e externos

As 779 ocorrências sem binding local são integralmente explicadas por globals/APIs conhecidas no corpus: `console`, `JSON`, `Math`, `Date`, `Array`, `Object`, `document`, `Buffer`, `performance`, `Promise`, `localStorage`, `window`, `Number`, `process`, `AbortSignal` e `crypto`.

Enquanto símbolos externos não forem indexados, esse grupo não é responsabilidade do CodeBrain local e não deve orientar a próxima Member Resolution.

## Ranking de oportunidade

1. **Runtime bindings importados internos** — 119 ocorrências determinísticas, baixo custo relativo e alto valor de navegação. Requer resolver named import para classe estática ou export const com origem `new Type()`/factory depth 1 explícita.
2. **Parâmetros com annotation interna hoje não materializada** — volume potencial, mas a maioria são primitives, arrays ou genéricos. Exige uma medição focada dos tipos internos antes de implementar.
3. **For-of e callbacks** — 114 ocorrências somadas nos cortes observados, mas dependem de container element type e propagação contextual.
4. **Member-call value flow** — 297 ocorrências, porém zero retorno concreto indexado entre os 72 callees internos. Baixo retorno imediato.
5. **`let` geral** — 61 de 74 ocorrências já mostram reassignment; exige CFG/data flow e deve ser adiado.

## Respostas obrigatórias

### Qual é a maior causa estrutural?

`const` com initializer, com 1.200 ocorrências. O maior subtipo é array literal, com 484, seguido de member-call initializer, com 297.

### Qual categoria oferece o melhor ganho sem transformar o CodeBrain em typechecker?

Named imports internos ligados a singletons exportados ou classes estáticas. Há 119 chamadas com origem curta e comprovável.

### Existe capacidade pequena que recuperaria centenas de casos?

Existe uma capacidade pequena que recuperaria aproximadamente uma centena: resolução cross-file de runtime bindings exportados, com até 119 ocorrências neste checkout. Não há evidência de uma capacidade pequena que recupere várias centenas; os grupos maiores exigem semântica de containers, caller propagation ou símbolos externos.

### Qual capacidade pesada deve ser evitada?

Type flow geral para parâmetros/callbacks e CFG para `let` reassigned. O corpus não justifica TypeScript Language Service nem inferência ampla de corpos neste momento.

### Qual é a próxima melhoria de maior ROI após os Tiers 1–6?

Um Tier conservador para receivers importados diretamente:

```text
named import interno
→ export const com initializer new Type()
→ ou classe importada com método static
→ opcionalmente factory depth 1 com return type simples explícito
→ método único no resolvedor existente
```

O primeiro recorte deve começar pelos 104 `const-new` e 3 métodos estáticos. Os 12 casos `getInstance()` podem ser incorporados somente se o return type explícito continuar inequívoco.

## Limitações

- A taxonomia mede ocorrências no checkout atual e não estima projetos externos.
- Reassignment é observado lexicalmente antes da call; não constitui CFG nem prova de execução.
- Callbacks sem candidate de callee compatível permanecem classificados pela evidência disponível, sem inferência semântica.
- Categorias de built-ins são tratadas como externas ao índice local; nenhuma assinatura de biblioteca foi carregada.
- O Spike não alterou resolver, Symbol References, banco, CodeScope, MCP ou baselines.
