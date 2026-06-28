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
date modified: 2026-06-26 17:09
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

## Código Limpo E Enxuto

Todo código criado ou modificado pelo agente deve priorizar simplicidade, legibilidade e baixa complexidade.

## Regras Obrigatórias

1. Preferir sempre a solução mais simples que funcione.
2. Use bastante comentários no código. Deixe claro a razão da existência de cada bloco.
3. Evitar abstrações, padrões ou otimizações prematuras.
4. Manter funções pequenas e fáceis de entender.
5. Utilizar nomes claros e autoexplicativos.
6. Evitar níveis profundos de indentação.
7. Remover automaticamente:
    - código morto;
    - variáveis não utilizadas;
    - imports desnecessários;
    - comentários obsoletos.
8. Não adicionar lógica, configurações ou estruturas que não sejam necessárias no momento atual.
9. Sempre que modificar código existente, simplificar o que for possível.

## Regra De Decisão

Se existir dúvida entre uma solução simples e uma solução sofisticada, escolher sempre a mais simples.

--------------

### Economia De Tokens

1. Não gere plano de implementação.
2. Não gere walkthrough.
3. Se houver dúvidas, alertas ou algo a esclarecer antes da implementação, apenas pergunte e faça sugestões.
4. Após concluir a implementação, forneça apenas um resumo do que foi feito.

### Gerencie O `.gitignore`

1. Adicione `code_awareness/`, `codefetch/` e `.sprintdiff/` ao `.gitignore`. O Git deve ignorar essas pastas nativamente. Garanta também que o `parseGitStatus` ignore tanto o nome puro do diretório (ex.: `"codefetch"`) quanto caminhos internos (ex.: `"codefetch/…"`), evitando entradas fantasmas.
2. Adicione ao `.gitignore` qualquer outra pasta que também deva ser ignorada.
