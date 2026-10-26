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
node scripts/local-agent/local.cjs academy set_academy_skill_enabled --id <skillId> --enabled false --state-revision <observedStateRevision>
node scripts/local-agent/local.cjs academy history --id <skillId> --metadata-only true
node scripts/local-agent/local.cjs academy history --id <skillId> --version <version>
node scripts/local-agent/local.cjs academy create --scope GLOBAL --file package.json
node scripts/local-agent/local.cjs academy create --scope PROJECT --projects '["destinationId"]' --file package.json
node scripts/local-agent/local.cjs academy update --id <skillId> --version <observedVersion> --file package.json
node scripts/local-agent/local.cjs academy delivery_status --id <skillId> [--version <observedVersion>]
node scripts/local-agent/local.cjs academy change_impact --file impact-request.json
node scripts/local-agent/local.cjs academy verify_change_impact --file freshness-request.json
```

Continuum conserva seleção explícita por RepositoryRecord.id e comprovação de checkout/worktree Git. Descoberta não contém Markdown; `get --format markdown` emite conteúdo literal sem newline adicional. [Fluxo do implementador](../continuum/LOCAL.md) continua válido.

Academy funciona mesmo sem repositório ativo ou fora de uma pasta Git. `list` retorna metadados; `get` retorna o package canônico exato, versão, hash, origem e estados observados de distribuição. `--file` lê localmente uma serialização JSON UTF-8 integral `{ "skillMd": "...", "artifacts": { "references/usage.md": "..." } }`; o Main recebe conteúdo, nunca o path. Não grave em pastas projetadas para publicar uma versão.

Em `PROJECT`, `--projects` deve conter IDs existentes de destinos Academy, consultáveis na gestão de destinos do aplicativo. IDs não são deduzidos do checkout ou de repositoryId. Não há fallback para GLOBAL. Em update, omitir scope/projetos preserva associações. Para alterá-las, informe scope e, para PROJECT, a lista integral de destinos; `--scope GLOBAL` limpa associações explícitas. Scope GLOBAL não aceita uma lista não vazia.

Uma escrita Academy confirma persistência imediatamente (`state: 'PERSISTED'`) no SQLite. `distribution.status` no recibo imediato indica `PENDING` (quando há destinos atribuídos) ou `NOT_APPLICABLE` (quando não há destinos). Não esperar distribuição síncrona; utilize `academy delivery_status --id <skillId> [--version <versão>]` para consultar a qualquer momento o estado compacto de entrega e convergência (`PENDING`, `CONVERGED`, `DEGRADED`, `ERROR`, `NOT_APPLICABLE`) sem varredura em disco ou download de pacotes. Persistência não equivale a consumidores recarregados.

`VERSION_CONFLICT` exige reler a versão e reavaliar. Create recusa nome canônico duplicado, inclusive desativado. Erros de scope/projetos, token, protocolo ou operação encerram sem sucesso falso. Conflitos, Git e releases não fazem parte deste canal. Depois de perder a resposta de uma escrita, consulte ID ou nome e versão/hash antes de reenviar; não existe retry automático.

`academy list` lista ACTIVE e DISABLED com `stateRevision`; filtros aceitam ambos e ARCHIVED como alias legado de DISABLED. A operação `set_academy_skill_enabled` recebe ID, booleano e revisão de estado esperada. `STATE_REVISION_CONFLICT` exige reler e reavaliar, sem retry cego. Retorna o estado canônico persistido e agenda reconciliação separada, sem publicar plugin. Transições incrementam somente `stateRevision`; edição desativada incrementa somente a versão de conteúdo e continua fora da distribuição. Os aliases temporários `archive` e `restore` recebem `--id` e `--version`, desativando/ativando; protegem somente a versão do conteúdo. Prefira CAS de ativação. Desativar preserva ID, nome reservado, histórico, escopo e associações.

O protocolo `code-awareness-local/v1` exige domínio, ação e args explícitos, com schemas fechados e operações registradas. Há um request por conexão, limite de 8 MiB de request/16 MiB de response, deadline absoluto de 15 segundos e no máximo 16 conexões. Não há truncamento silencioso nem fallback offline. Processos do mesmo usuário com acesso ao perfil integram o contexto autorizado.

## Histórico seletivo da Academy

`academy history --id <skillId> --metadata-only true` descobre versões em ordem decrescente sem ler ou retornar seus packages. A metadata contém `skillId`, `version`, `origin`, `createdAt` e `packageHash`. Use `--version <inteiro positivo seguro>` para obter uma única `AcademySkillVersion`, com package literal completo e hash canônico. Nenhum conteúdo é truncado; os limites atuais do transporte continuam aplicáveis.

Os seletores são mutuamente exclusivos, inclusive `--metadata-only false` junto de `--version`. Versões zero, fracionárias, inseguras e strings não numéricas são recusadas. Skill ausente produz `SKILL_NOT_FOUND`; versão ausente de uma Skill existente produz `VERSION_NOT_FOUND`. Skills desativadas continuam consultáveis. Sem seletores (ou com `--metadata-only false` isolado), retorna-se intencionalmente o array integral legado.

O MCP oferece os mesmos modos na operação existente `get_academy_skill_history`: `{skillId, metadataOnly:true}`, `{skillId, version:n}` ou `{skillId}`. MCP e Local Agent Channel delegam ao serviço canônico; nenhuma consulta grava versões, reconcilia distribuição ou executa scripts.

## Change Impact Preflight

`change_impact` recebe JSON completo da consulta em `--file`, sem escrever na Academy ou executar scripts. Modo candidato: `{ "skillId": "id", "expectedVersion": 3, "package": { "skillMd": "...", "artifacts": {} } }`. Modo retrospectivo: `{ "skillId": "id", "baseVersion": 2, "targetVersion": 3 }`. Os modos são exclusivos. O MCP expõe os mesmos contratos por `analyze_academy_change_impact` e `verify_academy_change_impact`.

A resposta contém diff literal, propriedades de frontmatter quando resolvíveis e possíveis consumidores diretos ACTIVE no alcance canônico atual. Menções negativas e exemplos continuam sendo evidência textual, sem classificação automática de dependência ou compatibilidade. Ausência de referências detectadas não demonstra ausência de impacto; aliases e dependências implícitas não são resolvidos. GLOBAL pode alcançar qualquer projeto; PROJECT cruza associações compartilhadas, preservando alcance desconhecido como ambíguo. O escopo histórico não é reconstruído.

`changes`, `consumers` e `evidence` aceitam `offset` (padrão 0), `limit` (padrões 10/10/2, máximo 50), `textOffset` (0) e `textLimit` (400 caracteres, máximo 4000). A janela textual se aplica a changes/evidence. Cada página informa `total` e `nextOffset`; cada trecho informa offset, totalCharacters e nextOffset. Reenvie a consulta com os offsets para recuperar conteúdo omitido; `consumerId` seleciona um candidato. Reanalise se o fingerprint mudar durante o aprofundamento. Offsets não são cursores persistidos.

`verify_change_impact` recebe `{ "snapshot": <snapshot retornado>, "candidateHash": "<sha256 opcional>" }`. O snapshot é uma identidade consultiva sem estado persistido e sua leitura usa uma transação SQLite consistente. Cobre fonte, base imutável, candidato e todo o conjunto elegível (inclusive Skills sem referências), com versões, status, escopos e associações ordenados. A verificação retorna CURRENT, STALE ou UNKNOWN e razões observáveis. Sem novo hash, o candidato não é reobservado: verifica-se somente a identidade de conteúdo fornecida anteriormente. Para outro candidato, use o hash canônico de seu package completo ou reanalise.

Freshness não cria lock, recibo durável ou garantia atômica até o update. Mudanças podem ocorrer depois da consulta; `expectedVersion` continua protegendo apenas a Skill editada. UNKNOWN nunca deve ser tratado como CURRENT.

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
