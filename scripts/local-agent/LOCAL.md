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
node scripts/local-agent/local.cjs academy delivery_status --id <skillId> [--version <observedVersion>]
```

Continuum conserva seleção explícita por RepositoryRecord.id e comprovação de checkout/worktree Git. Descoberta não contém Markdown; `get --format markdown` emite conteúdo literal sem newline adicional. [Fluxo do implementador](../continuum/LOCAL.md) continua válido.

Academy funciona mesmo sem repositório ativo ou fora de uma pasta Git. `list` retorna metadados; `get` retorna o package canônico exato, versão, hash, origem e estados observados de distribuição. `--file` lê localmente uma serialização JSON UTF-8 integral `{ "skillMd": "...", "artifacts": { "references/usage.md": "..." } }`; o Main recebe conteúdo, nunca o path. Não grave em pastas projetadas para publicar uma versão.

Em `PROJECT`, `--projects` deve conter IDs existentes de destinos Academy, consultáveis na gestão de destinos do aplicativo. IDs não são deduzidos do checkout ou de repositoryId. Não há fallback para GLOBAL. Em update, omitir scope/projetos preserva associações. Para alterá-las, informe scope e, para PROJECT, a lista integral de destinos; `--scope GLOBAL` limpa associações explícitas. Scope GLOBAL não aceita uma lista não vazia.

Uma escrita Academy confirma persistência imediatamente (`state: 'PERSISTED'`) no SQLite. `distribution.status` no recibo imediato indica `PENDING` (quando há destinos atribuídos) ou `NOT_APPLICABLE` (quando não há destinos). Não esperar distribuição síncrona; utilize `academy delivery_status --id <skillId> [--version <versão>]` para consultar a qualquer momento o estado compacto de entrega e convergência (`PENDING`, `CONVERGED`, `DEGRADED`, `ERROR`, `NOT_APPLICABLE`) sem varredura em disco ou download de pacotes. Persistência não equivale a consumidores recarregados.

`VERSION_CONFLICT` exige reler a versão e reavaliar. Create recusa nome ativo duplicado. Erros de scope/projetos, token, protocolo ou operação encerram sem sucesso falso. Archive/restore, conflitos, Git e releases não fazem parte deste canal. Depois de perder a resposta de uma escrita, consulte ID ou nome e versão/hash antes de reenviar; não existe retry automático.

O protocolo `code-awareness-local/v1` exige domínio, ação e args explícitos, com schemas fechados e operações registradas. Há um request por conexão, limite de 8 MiB de request/16 MiB de response, deadline absoluto de 15 segundos e no máximo 16 conexões. Não há truncamento silencioso nem fallback offline. Processos do mesmo usuário com acesso ao perfil integram o contexto autorizado.

## Compatibilidade e aceitação

`scripts/continuum/local.cjs`, `continuum-local/v1` e seu descriptor continuam disponíveis no mesmo listener, inclusive o prefixo de pipe validado pelos clientes antigos. Não há segundo servidor. Remova a compatibilidade somente após migrar consumidores reais (incluindo `continuum-local-cli`), confirmar aceitação dos comandos/perfis existentes e deixar de existir necessidade de clientes legados. A inbox offline mantém a semântica `QUEUED`, separada de `PERSISTED`.

```powershell
node scripts/local-agent/e2e.cjs
```

O E2E usa Electron Main, named pipe, catálogos/Stores nativos e destinos temporários reais. Inclui as duas CLIs, domínio Academy sem repositório, scope, versões, distribuição convergente/degradada, recusas, timeout, restart e persistência. `scripts/continuum/local-e2e.cjs` conserva o comando legado como entrada para a mesma aceitação.

## Perfil e diagnóstico no Windows

O Main e as CLIs compartilham a definição `src/shared/desktop-profile.cjs`: o perfil padrão é `%APPDATA%\code-awareness`. O Main mantém o `userData` efetivo do Electron; esta alteração não move dados nem inicia outro Store. O bootstrap registra `appName` e `profileMatchesDefault`, sem caminho ou segredo. Para um perfil desktop explicitamente personalizado, use `--profile` com o `userData` autorizado. Não selecione perfis por varredura de descriptors.

Falhas preservam o código principal e exit code não zero. Campos adicionais `stage` e `reason` distinguem `profile/PROFILE_NOT_FOUND`, `descriptor/DESCRIPTOR_NOT_FOUND`, `DESCRIPTOR_INVALID`, `PROTOCOL_INCOMPATIBLE`, `ENDPOINT_INVALID`, `connect/PIPE_NOT_FOUND`, `CONNECTION_REFUSED` e `ACCESS_DENIED`. Timeout usa `IPC_TIMEOUT` com estágio `connect` ou `response`; encerramento prematuro usa `IPC_CLOSED/PREMATURE_CLOSE`. Ausência de descriptor não prova que o aplicativo esteja desligado: confira o perfil e o diagnóstico de startup do Main (`profile`, `authorization`, `listen`, `descriptor`). Nenhuma falha gera retry automático.

No Codex Windows, `APP_UNAVAILABLE` com `stage: connect` e `reason: ACCESS_DENIED` indica restrição do token/sandbox. Solicite uma aprovação pontual oficial do executor para o comando necessário, mantendo as demais proteções. Compare `status` em PowerShell normal e no Codex autorizado, na mesma Worktree, e confirme `repositoryId` antes de ler Continuum. Se a aprovação não estiver disponível, reporte bloqueio de autorização. Não altere ACLs, copie tokens ou abra outro transporte. Um `--profile` correto não concede acesso ao pipe.
