# Captura nativa de proveniência

O instalador e a inspeção de trust usam a mesma lista de versões qualificadas. O status informa a versão encontrada no PATH da execução, se disponível. O schema gerado pelo executável ajuda a qualificar uma versão. O aceite também exige inspeção autorizada da thread ativa e prova de execução.

Execute no checkout governado e vinculado ao Code Awareness:

```powershell
node scripts/session-context/native-hooks.cjs status
```

Rode `status` também em Worktrees criadas fora do aplicativo, depois de vinculá-las ao repositório ativo. `INSTALLATION_OWNERSHIP_UNPROVEN` indica que o snapshot não comprova a propriedade dos handlers. Em conflito, preserve a configuração e investigue sua origem antes de reparar.

Somente após autorização explícita do operador para alterar os hooks desse checkout:

```powershell
node scripts/session-context/native-hooks.cjs install --authorized --git-commit-tool=mcp__code_awareness_local__commit_git_changes
node scripts/session-context/native-hooks.cjs disable --authorized
```

Use o nome exato da ferramenta MCP autorizado naquele ambiente. A instalação acrescenta handlers, conserva os existentes e guarda o estado para restauração. Revise e confie nos novos hooks pela interface do Codex; configuração não comprova captura. Se houver edição concorrente do arquivo, o desligamento preserva essa edição e informa `restored:false`.

O comando coleta apenas campos estruturais permitidos em spool limitado, sem rede ou SQLite próprio. A ativação do projeto e consultas de Session Context ingerem pequenas rodadas no Store existente. `list_agent_sessions` com `source:NATIVE_HOOK` lista identidades pseudonimizadas; `discover_execution_context` aprofunda as relações.

Somente o caminho MCP configurado de `commit_git_changes`, com Pre/Post correspondentes, recibo concluído e objeto Git compatível, admite relação causal verificada. Shell, replay e eventos incompletos não demonstram autoria. Os aliases Entire permanecem não conciliados quando não houver evidência positiva. Nenhuma instalação de hook Git global ou alteração de `core.hooksPath` é realizada.
