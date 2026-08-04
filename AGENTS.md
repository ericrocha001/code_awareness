---
aliases: []
tags: [IDE/antigravity, IDE/antigravity/rules/rule, programação, software, software/engenharia_de_software, software/engenharia_de_software/arquitetura_de_software, software/mecanismo_software, software/resiliencia_software, software/segurança_software, software/software_agentivo, software/software_erro]
title: AGENTS
source:
  - https://chatgpt.com/g/g-p-6981cf9c38988191932b596154a84f94-google-antigravity/c/69cac95e-f804-8328-995e-f5c0f2ce1526
author:
  - Eric Rocha
project:
connections:
date created: 2026-03-30 15:53
date modified: 2026-07-25 15:41
---

# AGENTS

## Arquitetura Autoexplicativa De Scripts

Todo script criado ou modificado pelo agente **deve obrigatoriamente iniciar**, nas primeiras linhas do arquivo, com um bloco de documentação arquitetural delimitado por:

```txt
--- ARQUITETURA DO SCRIPT ---
```

e

```txt
--- FIM ARQUITETURA DO SCRIPT ---
```

Esse bloco deve sempre estar encapsulado dentro de um comentário válido da linguagem utilizada (ex.: `/* */`, `""" """`, etc.).

O objetivo desse delimitador é permitir que humanos, agentes de IA e sistemas automatizados localizem, extraiam e analisem rapidamente os metadados arquiteturais do script.

Dentro desse bloco deve existir obrigatoriamente uma tríade de documentação arquitetural.

A tríade obrigatória é composta por:

1. **Responsabilidades do Script**
2. **Mapa de Relacionamentos do Script**
3. **Invariantes do Script**

Essas três seções devem sempre aparecer nesta ordem.

> Os scripts que não estiverem neste padrão atualize.

### Objetivo

Garantir que cada script explique claramente:

- por que existe;
- com quem se relaciona;
- o que nunca pode ser quebrado.

Isso reduz custo cognitivo humano, melhora análise por agentes de IA, reduz regressões e incentiva arquitetura modular.

### Estrutura Externa Obrigatória

Exemplo da estrutura externa do bloco:

```txt
/*
--- ARQUITETURA DO SCRIPT ---

… conteúdo da tríade …

--- FIM ARQUITETURA DO SCRIPT ---
*/
```

## Pilar 1 — Responsabilidades Do Script

Todo script deve iniciar a tríade com:

```txt
Responsabilidades do Script
```

### Regras Obrigatórias

1. Escrever em português do Brasil.
2. Listar apenas responsabilidades reais.
3. Cada responsabilidade deve:

    - começar com verbo de ação;
    - descrever claramente o propósito do arquivo;
    - evitar descrições genéricas.

4. Responsabilidade significa **um único motivo futuro de modificação**.
5. Usar lista numerada.
6. Não descrever implementação interna.
7. Não repetir nomes de funções ou classes.

### Exemplo

```txt
Responsabilidades do Script

1. Validar dados de entrada do usuário.
2. Converter respostas externas para o modelo interno.
3. Persistir logs estruturados.
```

## Pilar 2 — Mapa De Relacionamentos Do Script

Todo script deve conter logo abaixo:

```txt
Mapa de Relacionamentos do Script
```

### Regras Obrigatórias

1. Listar apenas relacionamentos arquiteturalmente relevantes.
2. Cada item deve conter:

    - nome do arquivo;
    - tipo;
    - relação;
    - criticidade.

3. Não listar imports triviais.
4. Usar lista numerada.

### Tipos Permitidos

- Dependência Direta
- Dependência Inversa
- Fluxo de Dados
- Contrato / Interface
- Comunicação por Evento
- Relação de UI

### Criticidade

- Alta
- Média
- Baixa

### Exemplo

```txt
Mapa de Relacionamentos do Script

1. diff-service.ts
   - Tipo: Fluxo de Dados
   - Relação: Recebe payloads processados.
   - Criticidade: Alta
```

## Pilar 3 — Invariantes Do Script

Todo script deve conter logo abaixo:

```txt
Invariantes do Script
```

### Definição

Invariantes são regras arquiteturais ou comportamentais que **nunca podem ser violadas**, mesmo após refactors ou novas features.

Se um invariante for quebrado, o comportamento do sistema é considerado incorreto.

### Regras Obrigatórias

1. Escrever em português do Brasil.
2. Listar apenas invariantes reais.
3. Cada invariante deve:
    - ser verificável;
    - ser específico;
    - descrever uma garantia obrigatória.

4. Usar lista numerada.
5. Não descrever detalhes de implementação.

### Exemplos De Bons Invariantes

```txt
Invariantes do Script

1. Nunca retornar dados nulos após validação bem-sucedida.
2. O output deve sempre ser determinístico para a mesma entrada.
3. Erros externos nunca devem interromper a renderização da UI.
```

### Exemplos De Maus Invariantes

Ruim:

```txt
1. O código deve ser limpo.
```

Bom:

```txt
1. O parser nunca deve descartar blocos semânticos válidos.
```

## Exemplo Completo Da Arquitetura Do Script

```txt
/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Gerar diff semântico entre versões de arquivos.
2. Estruturar o resultado em markdown para renderização.

Mapa de Relacionamentos do Script

1. parser.ts
   - Tipo: Fluxo de Dados
   - Relação: Fornece AST normalizada para análise semântica.
   - Criticidade: Alta

2. renderer.ts
   - Tipo: Relação de UI
   - Relação: Consome markdown gerado por este script.
   - Criticidade: Média

Invariantes do Script

1. Nunca gerar diff vazio quando houver alterações válidas.
2. O output deve ser determinístico para a mesma entrada.
3. Blocos semânticos válidos nunca podem ser descartados.

--- FIM ARQUITETURA DO SCRIPT ---
*/
```

## Atualização Obrigatória Da Tríade

Sempre que um script for criado, modificado ou refatorado, o agente deve obrigatoriamente revisar a tríade completa.

Checklist obrigatório:

1. Responsabilidades ainda refletem o propósito atual?
2. Relacionamentos continuam corretos?
3. Invariantes continuam válidos?

A tríade nunca pode ficar desatualizada em relação ao código.

## Regra De Segurança Arquitetural

Antes de propor alterações relevantes em um script, o agente deve:

1. Ler a tríade completa.
2. Carregar arquivos com criticidade **Alta** como contexto prioritário.
3. Garantir que nenhum invariante seja violado.

## Princípio Arquitetural Aplicado

Todo arquivo deve ser autoexplicativo em três dimensões:

- Propósito
- Dependências
- Garantias

Se um script não puder explicar claramente essas três dimensões, sua arquitetura deve ser reconsiderada.

----------

## Diretrizes de Desacoplamento

- Implemente novas funcionalidades priorizando separação de responsabilidades, baixo acoplamento e alta coesão.
- Cada módulo, serviço, classe ou script deve possuir uma única responsabilidade arquitetural e, consequentemente, apenas um motivo para mudar.
- Antes de adicionar uma nova funcionalidade a um arquivo existente, verifique se ela pertence à responsabilidade atual. Caso contrário, implemente-a em um novo módulo ou serviço.
- Não introduza novos motivos para mudança em um módulo existente. Quando necessário, crie um novo módulo.
- Prefira composição e colaboração entre módulos menores e coesos em vez de concentrar comportamentos em componentes universais ou excessivamente abrangentes.
- Evite módulos que concentrem responsabilidades de coordenação, regras de negócio e infraestrutura ao mesmo tempo.
- Não introduza dependências circulares entre módulos.
- Não introduza dependências diretas entre camadas distintas sem uma justificativa arquitetural explícita.
- Exponha apenas interfaces, contratos e comportamentos necessários. Não exponha detalhes internos de implementação.
- Crie abstrações somente quando houver benefício prático e imediato. Evite camadas, padrões ou interfaces desnecessárias.
- Organize os arquivos de forma que as responsabilidades de cada módulo permaneçam claras e bem delimitadas.
- Toda alteração deve preservar ou aumentar a coesão e preservar ou reduzir o acoplamento do sistema.
- Limite o impacto das mudanças ao menor número possível de módulos. Mudanças locais devem permanecer locais.
- Expanda um módulo existente apenas quando a nova funcionalidade pertencer claramente à sua responsabilidade. Caso contrário, crie um novo módulo.
- Mantenha a comunicação entre módulos simples, explícita e baseada em contratos bem definidos.
- Em caso de conflito entre simplicidade e desacoplamento, escolha a solução mais simples que preserve uma única responsabilidade por módulo e minimize o acoplamento global.

--------------

## Código Limpo e Enxuto

Todo código criado ou modificado pelo agente deve priorizar simplicidade, legibilidade, consistência e baixa complexidade.

### Regras Obrigatórias

1. Preferir sempre a solução mais simples que atenda corretamente aos requisitos atuais.
2. Evitar abstrações, padrões, configurações, estruturas e otimizações prematuras.
3. Não implementar funcionalidades, comportamentos ou configurações que ainda não sejam necessários.
4. Manter funções pequenas, coesas e fáceis de compreender.
5. Utilizar nomes claros, consistentes e autoexplicativos para variáveis, funções, classes, módulos e arquivos.
6. Evitar níveis profundos de indentação e estruturas de controle desnecessariamente complexas.
7. Não duplicar lógica. Sempre que uma implementação começar a se repetir de forma significativa, avaliar sua extração para um componente reutilizável.
8. Remover automaticamente:

    - código morto;
    - variáveis não utilizadas;
    - imports desnecessários;
    - comentários obsoletos;
    - trechos redundantes ou simplificáveis.

9. Sempre que modificar código existente, simplificar o que for possível sem alterar o comportamento esperado.
10. Toda alteração deve reduzir ou, no mínimo, não aumentar desnecessariamente a complexidade do código.

### Regra de Decisão

Em caso de dúvida entre duas ou mais soluções que atendam igualmente aos requisitos, escolher sempre a mais simples, clara e fácil de manter.

---------

## Política Universal De Comentários Para Código (Humanos + IA)

### Objetivo

Comentários devem adicionar contexto que o código sozinho não transmite, permitindo que humanos e agentes de IA entendam rapidamente a arquitetura, lógica, decisões críticas e riscos do sistema, mesmo em código comprimido.

### Regras

#### 1. Comente Apenas Lógica Não Trivial

Todo bloco com regras de negócio, validações complexas, concorrência, integrações, performance, cache, retries, workarounds ou fluxo crítico deve ter comentário curto (1–3 frases) explicando sua intenção e motivo de existir.

#### 2. Não Comente Sintaxe Óbvia

Nunca escreva comentários que apenas repetem o código. Priorize explicar **por que** a lógica existe, qual problema resolve e o que quebra se for alterada.

#### 3. Documente Estrutura E Contratos

Módulos, classes ou arquivos complexos devem declarar suas responsabilidades no topo. Funções críticas devem explicar entrada, saída, side effects e dependências importantes.

#### 4. Documente Bugs, Invariantes E Áreas Sensíveis

Toda correção relevante deve gerar comentário local contendo:

- natureza do bug
- causa
- consequência de remover a correção

Também documente invariantes, warnings e regras que nunca podem ser quebradas.

Use tags quando útil:

- `BUGFIX`
- `WARNING`
- `INVARIANT`
- `HACK`
- `TODO`

#### 5. Comentários Devem Sobreviver à Compressão

Escreva assumindo que a IA pode ver apenas imports, interfaces, assinaturas e comentários. Se o corpo da função desaparecer, o comentário ainda deve transmitir a lógica central.

#### 6. Comentários Devem Evoluir Com O Código

Ao alterar uma lógica comentada, revise e atualize seus comentários imediatamente. Comentário desatualizado é pior que ausência de comentário.

#### 7. Respeite a Linguagem

Sempre adapte o formato dos comentários às convenções da linguagem usada (ex.: JSDoc, docstrings, GoDoc, JavaDoc, XML docs).

### Regra Suprema

Escreva comentários como se eles fossem a principal fonte de contexto para reconstruir mentalmente toda a arquitetura e decisões críticas do sistema.

### ATENÇÃO

- NUNCA remova comentários de `BUGFIX`. Porque eles servem de alerta para agentes futuros não repetir o erro que foi corrigido.

--------------

## Economia De Tokens

1. Não gere plano de implementação.
2. Não gere walkthrough.
3. Se houver dúvidas, alertas ou algo a esclarecer antes da implementação, apenas pergunte e faça sugestões.
4. Após concluir a implementação, forneça apenas um resumo do que foi feito.

---------------

## Política De `.gitignore`

1. Adicione ao `.gitignore` todo arquivo ou diretório temporário, gerado automaticamente, local ou derivado (ex.: caches, logs, builds, outputs e arquivos intermediários).
2. Ignore arquivos criados por ferramentas, agentes, IDEs ou automações que não sejam necessários para reproduzir o projeto em outra máquina.
3. Nunca versione arquivos sensíveis ou específicos da máquina, como credenciais, tokens, paths locais e estados de runtime.
4. Se um arquivo ou pasta pode ser recriado automaticamente ou não é essencial ao projeto, ele deve estar no `.gitignore`.
