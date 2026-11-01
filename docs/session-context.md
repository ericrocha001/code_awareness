# Agent Session Context P0

O histórico pertence ao repositório canônico do catálogo. Worktrees reconhecidas do mesmo repositório usam o mesmo arquivo privado:

`<perfil>/continuum/repositories/<repositoryId em base64url>/session-context.sqlite`

O banco é independente do Continuum e do Git Atlas. As cinco ferramentas de histórico mantêm o contrato de consulta local; somente `refresh_agent_sessions` solicita ingestão. Sem `sessionId`, atualiza o catálogo sem importar bodies; com um ID descoberto, importa somente aquela sessão. A ausência de associação provada deixa `executionId`, Worktree e commit indisponíveis. Uma alegação de teste ou commit no texto não equivale a prova do Validation Ledger ou Git Operations.

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

## Limites e cobertura

Cada banco admite 500 sessões. A inserção seguinte remove atomicamente a ENDED mais antiga, com desempate por ID; ACTIVE, UNKNOWN e estados terminais sem evidência não são removidos. Se não houver vítima elegível, retorna CAPACITY_REACHED. Replay não ocupa outro slot.

O texto sanitizado tem limites de 32 KiB por evento, 8 MiB por sessão e 512 MiB por repositório. Omissões permanecem no envelope com motivo e cobertura. A fonte pode exigir exportação integral O(n); persistência idempotente não significa cursor incremental do Entire. Há limites de 32 MiB de stdout, 20 mil eventos, 256 KiB por linha de entrada e 12 segundos por atualização. Importação e consultas SQLite ficam em worker dedicado com backpressure e cancelamento na troca de projeto.

As respostas têm limites após serialização: catálogo 8 KiB, mapa 12 KiB, envelopes 12 KiB e leitura literal 16 KiB, com paginação íntegra. Conteúdo importado é dado não confiável. A sanitização minimiza padrões comuns de segredos, endereços e caminhos privados; não oferece garantia de redação perfeita. Reasoning privado não é persistido. Nenhum conteúdo é promovido automaticamente à Academy ou transmitido a outro serviço.

O mapa informa bytes de payload e tamanhos reais do banco/WAL separadamente. Checkpoint PASSIVE e manutenção incremental não equivalem a limite físico de 512 MiB; a rotação pode deixar páginas reutilizáveis. Não há VACUUM bloqueante por evento.

## Evidência e dependência externa

As suítes `src/main/session-context/*.test.ts` exercitam SQLite real no runner Electron nativo e o Channel HTTP. A fixture pública Codex possui origem e revisão em `fixtures/codex-exec.source.json`; ela prova compatibilidade de parsing, não captura autorizada de uma sessão do operador. A aceitação integral exige Entire instalado, opt-in seguro e importação de uma sessão real selecionada. Sem isso, a cobertura da captura real permanece UNAVAILABLE.
