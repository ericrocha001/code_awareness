# Captura nativa de proveniência

O instalador e a inspeção de trust usam a mesma lista de versões qualificadas. O status informa a versão encontrada no PATH da execução, se disponível. O schema gerado pelo executável ajuda a qualificar uma versão. O aceite também exige inspeção autorizada da thread ativa e prova de execução.

Execute no checkout governado e vinculado ao Code Awareness:

```powershell
node scripts/session-context/native-hooks.cjs status
```

Rode `status` também em Worktrees criadas fora do aplicativo, depois de vinculá-las ao repositório ativo. `INSTALLATION_OWNERSHIP_UNPROVEN` indica que o snapshot não comprova a propriedade dos handlers. Em conflito, preserve a configuração e investigue sua origem antes de reparar.

Antes de abrir a sessão Codex, selecione o caminho absoluto do executável que será usado para iniciá-la. Após autorização explícita do operador para alterar os hooks do checkout, execute a preparação na própria Worktree:

```powershell
node scripts/session-context/native-hooks.cjs status "--codex=$codexExecutable"
node scripts/session-context/native-hooks.cjs install --authorized "--codex=$codexExecutable" --git-commit-tool=mcp__code_awareness_local__commit_git_changes
node scripts/session-context/native-hooks.cjs disable --authorized
```

Use o nome exato da ferramenta MCP autorizado naquele ambiente. A instalação acrescenta handlers, conserva os existentes e guarda o estado para restauração. Inicie a sessão com o executável selecionado e revise os hashes pela interface nativa do Codex. Confirme a captura com eventos dessa sessão e recibos verificados. Se houver edição concorrente do arquivo, o desligamento preserva essa edição e informa `restored:false`.

O comando coleta apenas campos estruturais permitidos em spool limitado, sem rede ou SQLite próprio. A ativação do projeto e consultas de Session Context ingerem pequenas rodadas no Store existente. `list_agent_sessions` com `source:NATIVE_HOOK` lista identidades pseudonimizadas; `discover_execution_context` aprofunda as relações.

Somente o caminho MCP configurado de `commit_git_changes`, com Pre/Post correspondentes, recibo concluído e objeto Git compatível, admite relação causal verificada. Shell, replay e eventos incompletos não demonstram autoria. Os aliases Entire permanecem não conciliados quando não houver evidência positiva. Nenhuma instalação de hook Git global ou alteração de `core.hooksPath` é realizada.

### Repositórios do Catalog e captura offline

Execute o CLI empacotado a partir da raiz física da Worktree alvo, usando o Node exigido pelo projeto. O build de desenvolvimento gera `out/session-context/native-hooks-catalog.cjs`. No Desktop empacotado, o CLI está em `resources/app.asar.unpacked/out/session-context/`.

```powershell
node <caminho-do-cli> install --repository=<id-do-catalog> --provider=codex --codex=<codex.exe> --authorized
node <caminho-do-cli> install --repository=<id-do-catalog> --provider=antigravity --antigravity=<Antigravity.exe> --authorized
node <caminho-do-cli> status --repository=<id-do-catalog> --provider=codex
node <caminho-do-cli> disable --repository=<id-do-catalog> --provider=codex --authorized
```

Autorize o alvo antes de usar `--authorized`. No Codex, instalar em linked Worktree também prepara o manifesto e o binding do checkout principal daquele repositório. No Antigravity, a instalação prepara apenas a Worktree selecionada. Para delegar a preparação das futuras Worktrees gerenciadas criadas pelo fluxo Git do Code Awareness, acrescente `--authorize-managed-worktrees` à instalação autorizada. Para Worktrees externas, execute a instalação a partir do checkout vinculado. O comando aceita `--profile=<diretório>` para perfis isolados de validação.

O helper fica no perfil do Code Awareness, com nome derivado do digest. O repositório pode produzir eventos com o Desktop fechado. A seleção posterior do projeto aciona o fluxo de ingestão existente no SQLite daquele repositório. `status` informa instalação e autorização no Catalog. Origem carregada, trust do cliente e eventos são verificações independentes. `disable` nesta modalidade revoga imediatamente o provedor para o repositório, preservando arquivos de terceiros e a evidência já capturada. A revogação não apaga manifests nem concede trust.

### Codex e Antigravity no perfil do usuário (`$CODEX_HOME/hooks.json` e `~/.gemini/config/hooks.json`)

Para instalar uma única vez os handlers no perfil do usuário (7 eventos no Codex em `$CODEX_HOME/hooks.json`; grupo `code-awareness-session-context` com 6 eventos no Antigravity em `~/.gemini/config/hooks.json`), habilitar a captura explícita por repositório sem `binding.json` prévio nem scripts por checkout, e opcionalmente limpar handlers legados por projeto (`--cutover`):

```powershell
node <caminho-do-cli> status --user --provider=codex
node <caminho-do-cli> install --user --provider=codex --authorized --codex=<codex.exe> [--enroll-active] [--auto-enroll] [--cutover]
node <caminho-do-cli> status --user --provider=antigravity
node <caminho-do-cli> install --user --provider=antigravity --authorized --antigravity=<Antigravity.exe|agy.exe> [--enroll-active] [--auto-enroll] [--cutover]
node <caminho-do-cli> enroll --repository=<id-do-catalog> --provider=<codex|antigravity> --authorized [--cutover]
node <caminho-do-cli> cutover --provider=<codex|antigravity> --authorized
node <caminho-do-cli> disable --user --provider=<codex|antigravity> --authorized
```

No Codex, a revisão de confiança continua nativa na primeira ativação ou alteração da definição global. No Antigravity, o grupo nomeado preserva os demais hooks existentes no arquivo e a confiança do cliente é reportada honestamente como `CLIENT_TRUST_UNSUPPORTED`. Worktrees ligadas ou em detached HEAD pertencentes a repositórios inscritos fazem bootstrap atômico na primeira captura elegível (`SessionStart` / `PreToolUse`, ou `PreInvocation` no Antigravity), mantendo saídas neutras para repositórios fora do escopo.
