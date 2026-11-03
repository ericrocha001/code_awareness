# Agent Session Context P0

## Capture Health

`get_system_health({feature:"session_context"})` inspeciona configuração, captura observada e checkpoint do checkout governado; `worktreeId` e `generation` selecionam uma Worktree irmã. `refresh:true` solicita uma rechecagem limitada e `commitSha` seleciona um commit explícito. Nenhum hook, login ou configuração é alterado. O estado e os recibos compactos ficam no mesmo SessionStore, fora da retenção de transcrições.

`READY_CONFIGURED` confirma somente configuração pinada e hooks Git/Codex compatíveis. `CAPTURE_OBSERVED` requer identidade do chamador no Entire e progresso metadata-only da sessão na Worktree correta. Sessão ativa, arquivo de hook ou resolução por Worktree isolados não provam captura; ausência de evidência é `SESSION_UNOBSERVED`. O resultado conserva timestamp e `OBSERVED_SNAPSHOT`, nunca promete atividade atual sem rechecagem.

Ativação do projeto e commit nativo sinalizam observações limitadas; alterações de HEAD/refs/configuração são reconciliadas sob demanda para checkouts externos. Não há timer, crawling histórico ou hook novo. Um commit sem trailer só é `CHECKPOINT_MISSING` se a captura anterior e a origem local comprovarem a expectativa; merge remoto/cherry-pick ou captura não esperada não herdam essa falha. Verificação positiva usa trailer, ref local estável e metadados literais de sessão, sem prompts. Diagnósticos incluem a próxima evidência útil e indicam quando reparo precisa de autorização própria.

O histórico pertence ao repositório canônico do catálogo. Worktrees reconhecidas do mesmo repositório usam o mesmo arquivo privado:

`<perfil>/continuum/repositories/<repositoryId em base64url>/session-context.sqlite`

O banco é independente do Continuum e do Git Atlas. As ferramentas de histórico mantêm o contrato de consulta local; `refresh_agent_sessions` solicita ingestão explícita. Sem `sessionId`, atualiza o catálogo sem importar bodies; com um ID descoberto e sem `association`, importa somente aquela sessão. Uma alegação de teste ou commit no texto não equivale a prova do Validation Ledger ou Git Operations.

## Associações históricas e encerramento

`list_agent_sessions` aceita seletores exatos `executionId`, `artifactId`, `commitSha` (SHA completo) e `pullRequest` (número no repositório ativo). Não faz joins por horário, nome de branch ou autor Git. As associações muitos-para-muitos ficam no SessionStore existente, com integridade, revisão CAS e origem tipada. A atualização metadata-only autorizada do Entire preserva o vínculo com a identidade validada da Worktree. Consultas posteriores não exigem remontá-la; `worktreeAvailability: NOT_RECHECKED` evita alegar disponibilidade sem nova observação. Ausência de vínculo retorna `NO_ASSOCIATION_OBSERVED`, não prova de ausência de captura.

`WORKTREE_VERIFIED` corresponde à observação do checkout; `CHECKPOINT_VERIFIED` é registrado somente quando a desambiguação existente do Entire confirma metadados de sessão no checkpoint, com trailer verificado quando há commit. `HANDOFF_DECLARED` preserva somente a declaração. Nenhum nível comprova autoria exclusiva. A retenção continua em 500 sessões: associações sobrevivem à evicção, mas retornam `SESSION_EVICTED`; eventos ausentes não são reconstruídos.

Um Implementation Handoff pode declarar `sessionLinks: [{sessionId: <UUID já descoberto>}]`, `executionId`, `commitSha`, `pullRequest` e `proofIds` na metadata. As relações `implements` selecionam os Planos no mesmo Continuum. Ao publicar pela CLI local, o recibo inclui `sessionCoverage`; o histórico recebe somente declarações compatíveis com a Worktree verificada e com o Artifact persistido. Provas precisam existir no Ledger e referenciar o Plano ou Handoff; não viram evidência de autoria. Sem sessão declarada, a publicação permanece válida e informa `NO_ASSOCIATION_OBSERVED`.

Recuperação explícita usa `refresh_agent_sessions` com `sessionId`, seleção de Worktree e `association: {sourceArtifactId, artifactId?, executionId?, commitSha?, pullRequest?, proofIds?, expectedCatalogRevision}`. Esse modo apenas registra a declaração existente no Handoff; não lê transcript. A revisão vem de `list_agent_sessions`. Uma Worktree diferente não pode alterar o vínculo. Até dez associações por publicação; cobertura parcial não bloqueia commit ou PR.

## Sessões arquivadas no Codex

`list_agent_sessions({includeArchived:true})` pode consultar `thread/list` com `archived:true`, `cwd` exato e limite 20, exclusivamente por conexão local já autorizada, vinculada a conta/repositório e com suporte de schema confirmado. `archiveCursor` continua a página oficial; `cursor` continua o índice sem repetir a consulta ao provedor. O adaptador descarta previews, turns, prompts e paths da projeção; IDs Codex e Entire têm namespaces separados. Arquivamento observado é independente de `ENDED`. Respostas após cancelamento não gravam observações. Capacidade esgotada preserva o índice com `ARCHIVE_INDEX_PARTIAL` e motivo `CAPACITY_REACHED`.

O Code Awareness não possui atualmente uma conexão Codex App Server autorizada instalada por este fluxo: retorna `ARCHIVE_PROVIDER_UNAVAILABLE` e conserva o índice histórico. Não inicia app-server, não lê diretórios privados, não configura hooks nem habilita captura. A integração opcional recebe uma conexão já governada do host; disponibilidade do protocolo público não comprova disponibilidade local. Contrato oficial: [Codex App Server — thread/list](https://developers.openai.com/codex/app-server#list-threads-with-pagination--filters). Não há promessa de recuperação retroativa do PR #89.

## Fonte consultiva live — CH-13

`discover_entire_sessions` consulta uma vez `session list --json` do Entire 0.12.2 e retorna até 20 registros `ENTIRE_LIVE` das Worktrees governadas. Não importa transcripts nem altera a materialização `TRANSCRIPT_IMPORTED` do histórico. Filtros opcionais de Worktree exigem `worktreeId` e `generation` juntos; estado e intervalo de início também podem restringir a seleção. Inventário limitado ou fontes indisponíveis produzem cobertura parcial explícita, com contagens de omissão; não há truncamento silencioso nem promessa de inventário completo.

`inspect_entire_session` exige `providerSessionId`, `worktreeId` e `generation`. Confere a origem retornada pelo provider contra o registry e revalida contexto e identidade antes de devolver o resultado. Expõe metadados, turnos e `pendingTurns`; o alias depreciado `checkpoints` não é projetado. Arquivos tocados só aparecem com `includeFiles:true`, em paths repo-relativos seguros, até `fileLimit` (máximo 20), com cobertura própria. Checkpoint consolidado e associação com sessão SQLite permanecem indisponíveis sem prova.

`get_entire_session_usage` usa a mesma seleção, verifica primeiro `session info` e projeta `session tokens --json` como `ENTIRE_REPORTED`: input, output, cache, total e chamadas. Métricas ausentes não viram zero. A razão de input+cache sobre total, quando observável e pelo menos 90%, é um sinal tipado `HEURISTIC`, não instrução ou custo faturável. Recomendações textuais do fornecedor não são transmitidas.

As três operações usam o executor seguro existente, sem shell, auth, rede, mutações Git ou captura automática. Exigem opt-in pinned e configuração local privada com `push_sessions:false` e `telemetry:false`. A verificação de hash/versão/ajuda pode ser reutilizada somente enquanto a identidade física, tamanho e timestamps do executável e o pin permanecem iguais; opt-in e privacidade são relidos. Saída CLI tem limite de 1 MiB, stderr 64 KiB, prazo de provider 12 segundos e orçamento MCP de 12 KiB para descoberta/8 KiB para detalhes e métricas. Cancelamento, drift e falhas são erros explícitos. Nenhuma projeção inclui `last_prompt`, transcript, credenciais ou caminhos físicos.

## Opt-in do operador

O operador instala e configura o Entire separadamente, consentindo com sua captura. Esta integração não executa enable, configure, hooks, push, fetch ou checkout. Antes do uso, o operador confirma que `.entire/settings.local.json` é um arquivo local não versionado e contém `strategy_options.push_sessions: false`. Configuração ausente, ambígua ou insegura recusa a importação.

Ao lado do SQLite, o operador cria `session-context.provider.json`, fora do Git, com:

```json
{
  "enabled": true,
  "repositoryId": "identidade-canônica-do-catálogo",
  "executable": "C:\\caminho-autorizado\\entire.exe",
  "sha256": "sha256-hexadecimal-do-executável-autorizado",
  "version": "versão-semver-exata-confirmada-localmente"
}
```

O caminho precisa ser absoluto; o arquivo executável é fixado por hash e versão. A atualização do Entire exige nova conferência pelo operador. O preflight confirma os comandos `session list --json` e `session info <id> --json|--transcript` na ajuda da versão local antes de consumir dados. O adaptador aceita os formatos JSONL Codex rollout e exec; schemas desconhecidos permanecem PARTIAL/UNAVAILABLE. Não configura nem instala o provider para satisfazer o preflight. Remover ou desativar o opt-in impede novas importações; o histórico já armazenado continua consultável.

Para atualizar uma Worktree irmã sem mudar o projeto ativo, descubra-a pelo Git Operations e forneça `worktreeId` e `generation` juntos a `refresh_agent_sessions`, com `sessionId` opcional. O registry do repositório ativo resolve e revalida o alvo; paths e branches não são aceitos. Sem alvo, permanece o checkout ativo. Worktrees estrangeiras, missing/prunable, detached ou de geração antiga são recusadas. O Entire usa o cwd e a configuração local segura do alvo, mantendo o mesmo SQLite do repositoryId. A identidade é conferida antes da consulta, antes do commit SQLite e após a importação; resultados obsoletos são recusados. Não se deduz autoria por nome de branch, pasta ou HEAD. Não há busca global de sessões.

## Captura Codex no Windows

O Entire instala os hooks; o Codex executa os comandos no shell do ambiente selecionado. Em Worktree vinculada, o arquivo efetivamente carregado pode ser `.codex/hooks.json` do checkout principal. Descoberta e confiança não comprovam execução: confirme separadamente os eventos reais `SessionStart` e `UserPromptSubmit` e seus resultados.

No Entire 0.12.2, o `SessionStart` Windows gerado pode conter sintaxe direta de `cmd.exe`, incompatível com PowerShell. O wrapper silencioso Windows usado pelos demais handlers evita essa incompatibilidade:

```text
cmd.exe /d /s /c "where.exe entire >nul 2>nul & if errorlevel 1 (ver>nul) else (entire hooks codex session-start)"
```

Essa forma não emite o aviso de CLI ausente; confirme antes a disponibilidade do executável. Uma reinstalação pelo mesmo gerador pode restaurar o comando incompatível. Não reinstale repetidamente nem altere o produto para compensar esse problema operacional.

Qualquer ajuste no arquivo efetivo compartilhado exige autorização específica, backup privado dos bytes originais e conferência de que somente o handler pretendido mudou. Preserve os demais handlers e a privacidade. Reaprove a confiança do comando alterado pelo mecanismo do Codex, vinculada ao hash atual; não use bypass. Para reverter, restaure apenas a alteração autorizada após conferir que o arquivo não recebeu mudanças concorrentes e revalide a confiança correspondente. Não versione o JSON privado.

Após o ajuste, inicie uma sessão Codex genuína e verifique `entire session current --json`: `resolution` deve identificar o chamador (`caller-env` ou `ancestry`), com sessão e Worktree corretas. A captura pode ser inicializada por `UserPromptSubmit` mesmo quando `SessionStart` falha; isso não torna o handler com falha saudável. Preserve `push_sessions:false`, `telemetry:false` e `checkpoint_push_disabled:true`.

Antes de um commit legítimo, confirme trabalho pendente correspondente aos arquivos realmente alterados. Depois do commit normal, confira o trailer `Entire-Checkpoint` e a resolução local por `entire checkpoint explain --commit <SHA> --json`; IDs, origem e arquivos devem ser coerentes. Não use commit vazio, alteração fictícia, attach forçado ou reescrita de histórico para produzir essa evidência. Checkpoints e transcripts permanecem locais e não acompanham o push da branch de código.

## Limites e cobertura

Cada banco admite 500 sessões. A inserção seguinte remove atomicamente a ENDED mais antiga, com desempate por ID; ACTIVE, UNKNOWN e estados terminais sem evidência não são removidos. Se não houver vítima elegível, retorna CAPACITY_REACHED. Replay não ocupa outro slot.

O texto sanitizado tem limites de 32 KiB por evento, 8 MiB por sessão e 512 MiB por repositório. Omissões permanecem no envelope com motivo e cobertura. A fonte pode exigir exportação integral O(n); persistência idempotente não significa cursor incremental do Entire. Há limites de 32 MiB de stdout, 20 mil eventos, 256 KiB por linha de entrada e 12 segundos por atualização. Importação e consultas SQLite ficam em worker dedicado com backpressure e cancelamento na troca de projeto.

As respostas têm limites após serialização: catálogo 8 KiB, mapa 12 KiB, envelopes 12 KiB e leitura literal 16 KiB, com paginação íntegra. Conteúdo importado é dado não confiável. A sanitização minimiza padrões comuns de segredos, endereços e caminhos privados; não oferece garantia de redação perfeita. Reasoning privado não é persistido. Nenhum conteúdo é promovido automaticamente à Academy ou transmitido a outro serviço.

O mapa informa bytes de payload e tamanhos reais do banco/WAL separadamente. Checkpoint PASSIVE e manutenção incremental não equivalem a limite físico de 512 MiB; a rotação pode deixar páginas reutilizáveis. Não há VACUUM bloqueante por evento.

## Evidência e dependência externa

As suítes `src/main/session-context/*.test.ts` exercitam SQLite real no runner Electron nativo e o Channel HTTP. A fixture pública Codex possui origem e revisão em `fixtures/codex-exec.source.json`; ela prova compatibilidade de parsing, não captura autorizada de uma sessão do operador. A aceitação integral exige Entire instalado, opt-in seguro e importação de uma sessão real selecionada. Sem isso, a cobertura da captura real permanece UNAVAILABLE.
