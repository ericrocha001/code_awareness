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
date modified: 2026-06-20 01:25
---

# AGENTS

## Blindagem Arquitetural

### Responsabilidades Do Script

Todo script criado pelo agente **deve obrigatoriamente iniciar** com uma seção chamada:

```
Responsabilidades do Script
```

Essa seção deve aparecer nas primeiras linhas do arquivo.

### Objetivo

Permitir entendimento imediato do propósito do arquivo sem leitura completa do código, reduzindo custo cognitivo humano, consumo de contexto por agentes de IA e complexidade arquitetural do sistema.

### Regras Obrigatórias

1. Escrever sempre em português do Brasil.
2. Listar apenas responsabilidades reais do arquivo.
3. Cada responsabilidade deve:
    - começar com verbo de ação;
    - descrever claramente o que o script faz;
    - indicar o domínio ou contexto do sistema quando aplicável;
    - evitar descrições genéricas.
4. Responsabilidade significa **um único motivo futuro de modificação do arquivo**.
5. A lista deve ser escrita em formato numerado.
6. Não descrever detalhes de implementação interna.
7. Não repetir nomes de funções (`def`) ou classes.

### Limite Arquitetural De Responsabilidades

O arquivo deve possuir:

- Ideal: **1 a 3 responsabilidades**
- Limite máximo aceitável: **4 responsabilidades**

Se o número ultrapassar 4, o agente deve:

- sugerir divisão do arquivo;
- propor novos scripts especializados;
- separar responsabilidades por domínio.

### Critérios De Divisão Automática

O agente deve sugerir refatoração quando o script:

- executa múltiplos papéis distintos;
- conversa com mais de um sistema externo;
- mistura regras de negócio, validação e persistência;
- possui responsabilidades parcialmente reutilizáveis.

### Estrutura Padrão Obrigatória

Exemplo correto:

```
Responsabilidades do Script

1. Validar dados de entrada do usuário no módulo de autenticação.
2. Converter respostas da API externa para o modelo interno do sistema.
3. Persistir logs estruturados no sistema de observabilidade.
```

### Benefícios Esperados

- Arquivos pequenos e especializados
- Manutenção simplificada
- Debugging mais rápido
- Melhor navegação do código
- Menor consumo de tokens por agentes de IA
- Arquitetura naturalmente modular

### Atualização Das Responsabilidades

Sempre que o script for modificado, refatorado ou tiver seu comportamento alterado, o agente deve:

1. revisar a seção "Responsabilidades do Script";
2. atualizar, adicionar ou remover responsabilidades quando necessário;
3. garantir que a lista reflita exatamente o estado atual do arquivo.
  
A lista de responsabilidades nunca deve ficar desatualizada em relação ao código.

### Princípio Arquitetural Aplicado

Todo arquivo deve representar **uma unidade clara de responsabilidade dentro do sistema**.
Se o propósito do arquivo não puder ser explicado rapidamente na lista inicial, o design do script deve ser reconsiderado.

-------------------------

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

### Economia de Tokens

1. Não gere plano de implementação.
2. Não gere walkthrough.
3. Se houver dúvidas, alertas ou algo a esclarecer antes da implementação, apenas pergunte e faça sugestões.
4. Após concluir a implementação, forneça apenas um resumo do que foi feito.

### Gerencie o `.gitignore`

1. Adicione `code_awareness/`, `codefetch/` e `.sprintdiff/` ao `.gitignore`. O Git deve ignorar essas pastas nativamente. Garanta também que o `parseGitStatus` ignore tanto o nome puro do diretório (ex.: `"codefetch"`) quanto caminhos internos (ex.: `"codefetch/…"`), evitando entradas fantasmas.
2. Adicione ao `.gitignore` qualquer outra pasta que também deva ser ignorada.