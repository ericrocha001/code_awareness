# Code Awareness Local Agent Channel

Um único listener local do Electron oferece adaptadores separados para Continuum e Academy, sem MCP. No Windows, o perfil padrão é `%APPDATA%\code-awareness`; `--profile <diretório>` seleciona explicitamente outro perfil autorizado. O descriptor principal está em `local-agent-channel/endpoint.json`. Credencial e ACL pertencem ao usuário do perfil, nunca ao repositório.

```powershell
node scripts/local-agent/local.cjs status
node scripts/local-agent/local.cjs continuum status
node scripts/local-agent/local.cjs continuum list --repository <repositoryId> --filter '{"kind":"EXECUTABLE_PLAN","limit":10}'
node scripts/local-agent/local.cjs continuum get --repository <repositoryId> --id <artifactId> --format markdown
node scripts/local-agent/local.cjs continuum publish --repository <repositoryId> --file handoff.md
node scripts/local-agent/local.cjs continuum update --repository <repositoryId> --id <artifactId> --revision <revision> --file handoff.md
node scripts/local-agent/local.cjs academy list --status ACTIVE
node scripts/local-agent/local.cjs academy get --id <skillId>
node scripts/local-agent/local.cjs academy create --scope GLOBAL --file package.json
node scripts/local-agent/local.cjs academy create --scope PROJECT --projects '["destinationId"]' --file package.json
node scripts/local-agent/local.cjs academy update --id <skillId> --version <observedVersion> --file package.json
```

Continuum conserva seleção explícita por RepositoryRecord.id e comprovação de checkout/worktree Git. Descoberta não contém Markdown; `get --format markdown` emite conteúdo literal sem newline adicional. [Fluxo do implementador](../continuum/LOCAL.md) continua válido.

Academy funciona mesmo sem repositório ativo ou fora de uma pasta Git. `list` retorna metadados; `get` retorna o package canônico exato, versão, hash, origem e estados observados de distribuição. `--file` lê localmente uma serialização JSON UTF-8 integral `{ "skillMd": "...", "artifacts": { "references/usage.md": "..." } }`; o Main recebe conteúdo, nunca o path. Não grave em pastas projetadas para publicar uma versão.

Em `PROJECT`, `--projects` deve conter IDs existentes de destinos Academy, consultáveis na gestão de destinos do aplicativo. IDs não são deduzidos do checkout ou de repositoryId. Não há fallback para GLOBAL. Em update, omitir scope/projetos preserva associações. Para alterá-las, informe scope e, para PROJECT, a lista integral de destinos; `--scope GLOBAL` limpa associações explícitas. Scope GLOBAL não aceita uma lista não vazia.

Uma escrita Academy retorna `state: PERSISTED`, `skillId`, `version`, `packageHash`, scope/projetos e `distribution.status`: `CONVERGED`, `DEGRADED`, `NOT_APPLICABLE` ou `ERROR`. Persistência não equivale à distribuição. `CONVERGED` exige estados locais confirmados para a versão/hash retornados; não comprova atualização de plugin hospedado ou release remoto. Falha de reconciliação após commit retorna `PERSISTED` com `ERROR`, nunca sugere rollback. Consulte `get` e os diagnósticos do app para reconciliação posterior.

`VERSION_CONFLICT` exige reler a versão e reavaliar. Create recusa nome ativo duplicado. Erros de scope/projetos, token, protocolo ou operação encerram sem sucesso falso. Archive/restore, conflitos, Git e releases não fazem parte deste canal. Depois de perder a resposta de uma escrita, consulte ID ou nome e versão/hash antes de reenviar; não existe retry automático.

O protocolo `code-awareness-local/v1` exige domínio, ação e args explícitos, com schemas fechados e operações registradas. Há um request por conexão, limite de 8 MiB de request/16 MiB de response, deadline absoluto de 15 segundos e no máximo 16 conexões. Não há truncamento silencioso nem fallback offline. Processos do mesmo usuário com acesso ao perfil integram o contexto autorizado.

## Compatibilidade e aceitação

`scripts/continuum/local.cjs`, `continuum-local/v1` e seu descriptor continuam disponíveis no mesmo listener, inclusive o prefixo de pipe validado pelos clientes antigos. Não há segundo servidor. Remova a compatibilidade somente após migrar consumidores reais (incluindo `continuum-local-cli`), confirmar aceitação dos comandos/perfis existentes e deixar de existir necessidade de clientes legados. A inbox offline mantém a semântica `QUEUED`, separada de `PERSISTED`.

```powershell
node scripts/local-agent/e2e.cjs
```

O E2E usa Electron Main, named pipe, catálogos/Stores nativos e destinos temporários reais. Inclui as duas CLIs, domínio Academy sem repositório, scope, versões, distribuição convergente/degradada, recusas, timeout, restart e persistência. `scripts/continuum/local-e2e.cjs` conserva o comando legado como entrada para a mesma aceitação.
