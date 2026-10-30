# Git Atlas — smoke test manual de sincronização contextual

Este documento é uma alteração **não executável** usada para exercitar o fluxo real de branch → pull request → merge em `main`, sem modificar comportamento do aplicativo. O merge remoto, isoladamente, **não comprova** a interface de sincronização do Git Atlas.

## Objetivo

Confirmar visualmente que, ao integrar um novo commit na branch remota, a instalação do Code Awareness que já contém a implementação do PR #71 identifica a relação da `main` local com o upstream e oferece a ação segura adequada.

## Pré-condições

- O Code Awareness deve estar executando a versão que contém o PR #71 (reiniciar após atualizar o checkout local).
- A `main` local deve ter upstream `origin/main` e estar limpa, sem operação Git em andamento.
- O teste de **Behind → Pull FF-only** requer que um novo PR seja integrado ao remoto **depois** que o checkout local estiver atualizado para o código da feature, mas **antes** que esse novo commit seja recebido localmente.
- Não executar checkout, reset, stash ou descarte de alterações como parte deste roteiro.

## Procedimento de aceitação

1. Registrar o SHA da `main` local e o SHA remoto antes do novo merge.
2. Integrar remotamente um PR de mudança documental mínima; manter a `main` local sem pull.
3. Abrir o Git Atlas e verificar o marcador **Você está aqui** e a situação de sincronização do checkout ativo.
4. Se a evidência do remoto estiver incompleta, usar o **Fetch explícito** e confirmar que a branch local não avançou.
5. Com relação **Behind** comprovada, verificar o número de commits atrás, o upstream exibido e a ação contextual **Pull FF-only**.
6. Confirmar o Pull; verificar que o HEAD local avançou por fast-forward e que o Atlas passa a indicar **IN_SYNC / atualizado**.
7. Verificar que a seleção de commits/branches e o scroll do Atlas não executam comandos remotos nem mutações.

## Limites da evidência

- Um merge realizado **antes** de atualizar/reiniciar o aplicativo não é, por si só, demonstração visual da nova interface.
- O resultado esperado depende do estado Git real; quantidade de commits e disponibilidade de ações não devem ser inventadas.
- Falhas de rede, upstream incompatível, Worktree sem autorização ou alterações locais impedem concluir o caminho positivo sem novo preparo.
- Registrar em separado: PR/SHA remoto, SHA local antes/depois, evidência visível do Git Atlas e eventuais erros. A validação visual só fica concluída com observação da interface.
