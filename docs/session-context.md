# Agent Session Context P0

O histórico pertence ao repositório canônico do catálogo. Worktrees reconhecidas do mesmo repositório usam o mesmo arquivo privado:

`<perfil>/continuum/repositories/<repositoryId em base64url>/session-context.sqlite`

O banco é independente do Continuum e do Git Atlas. A consulta não inicia subprocessos, captura, hooks ou sincronização. Somente `refresh_agent_sessions` solicita ingestão. Sem `sessionId`, atualiza o catálogo sem importar bodies; com um ID descoberto, importa somente aquela sessão. A ausência de associação provada deixa `executionId`, Worktree e commit indisponíveis. Uma alegação de teste ou commit no texto não equivale a prova do Validation Ledger ou Git Operations.

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

Na P0, só são importadas sessões cuja origem observada corresponde à Worktree ativa. Sessões de outra Worktree devem ser atualizadas quando ela estiver ativa; seu banco continua compartilhado pelo repositoryId. Não se deduz autoria por nome de branch, pasta ou HEAD. Não há busca global de sessões.

## Limites e cobertura

Cada banco admite 500 sessões. A inserção seguinte remove atomicamente a ENDED mais antiga, com desempate por ID; ACTIVE, UNKNOWN e estados terminais sem evidência não são removidos. Se não houver vítima elegível, retorna CAPACITY_REACHED. Replay não ocupa outro slot.

O texto sanitizado tem limites de 32 KiB por evento, 8 MiB por sessão e 512 MiB por repositório. Omissões permanecem no envelope com motivo e cobertura. A fonte pode exigir exportação integral O(n); persistência idempotente não significa cursor incremental do Entire. Há limites de 32 MiB de stdout, 20 mil eventos, 256 KiB por linha de entrada e 12 segundos por atualização. Importação e consultas SQLite ficam em worker dedicado com backpressure e cancelamento na troca de projeto.

As respostas têm limites após serialização: catálogo 8 KiB, mapa 12 KiB, envelopes 12 KiB e leitura literal 16 KiB, com paginação íntegra. Conteúdo importado é dado não confiável. A sanitização minimiza padrões comuns de segredos, endereços e caminhos privados; não oferece garantia de redação perfeita. Reasoning privado não é persistido. Nenhum conteúdo é promovido automaticamente à Academy ou transmitido a outro serviço.

O mapa informa bytes de payload e tamanhos reais do banco/WAL separadamente. Checkpoint PASSIVE e manutenção incremental não equivalem a limite físico de 512 MiB; a rotação pode deixar páginas reutilizáveis. Não há VACUUM bloqueante por evento.

## Evidência e dependência externa

As suítes `src/main/session-context/*.test.ts` exercitam SQLite real no runner Electron nativo e o Channel HTTP. A fixture pública Codex possui origem e revisão em `fixtures/codex-exec.source.json`; ela prova compatibilidade de parsing, não captura autorizada de uma sessão do operador. A aceitação integral exige Entire instalado, opt-in seguro e importação de uma sessão real selecionada. Sem isso, a cobertura da captura real permanece UNAVAILABLE.
