# Continuum no terminal

## Publicação sem cadastro mecânico

`publish` aceita Markdown com YAML literal ou corpo sem YAML. No formato econômico, use `--kind <kind>` como seleção semântica; o servidor deriva o nome de um título H1 único e a descrição do parágrafo introdutório em texto simples (uma frase de 24–512 caracteres, com pontuação final). Sem fonte suficiente, retorna `MISSING_SEMANTIC_FIELD`, `field` e orientação; forneça somente o campo necessário via `--name` ou `--description`. Não há kind, descrição ou status genéricos como fallback.

`update` com corpo sem YAML preserva os metadados semânticos anteriores; as mesmas opções permitem alterações explícitas. YAML completo continua literal e substitui os metadados como antes. Datas documentais permanecem autorais; timestamps técnicos, identidade, hash e revisão pertencem ao servidor. A proveniência do serviço é persistida separadamente do Markdown, sem presumir sessão. Os argumentos opcionais equivalentes do MCP são `kind`, `name` e `description`; clientes legados continuam compatíveis.

A publicação manual usa a mesma canonização e deixa de classificar qualquer `.md` como `DOCUMENT`. O IPC aceita as mesmas seleções semânticas opcionais. O seletor de arquivo atual pode usar YAML autoral quando faltar essa seleção; erros não são preenchidos com descrição genérica ou tipo presumido.

## Lifecycle governado

Planos e Work Items novos recebem `PENDING` quando omitido; outros kinds não recebem estado inventado. `get` separa `metadata.status` editorial de atividade operacional e da projeção `lifecycle`. No P6, a edição autenticada normal integra status, tags e conteúdo na mesma gravação e no mesmo lifecycle canônico. A ferramenta especializada abaixo é opcional para diagnóstico ou transição isolada.

```powershell
node scripts/continuum/local.cjs transition_artifact_lifecycle --repository <repositoryId> --filter '{"action":"ASSESS","artifactId":"<handoffId>","expectedRevision":1,"toState":"VALIDATED","reasonCode":"CRITERIA_ACCEPTED"}'
```

Use a revisão observada, não a ilustrativa. `ASSESS` diagnostica sem aprovar ou escrever. Omitir `evidenceRefs` permite seleção limitada de provas Ledger CURRENT via `evidenceFor`; seleção e testes aprovados não comprovam cobertura integral. Declare `supportingArtifactId` somente para desambiguar uma relação `implements` conhecida. Não envie identidade ou aprovação do cliente.

O host deriva a autoridade da conexão autenticada; `TRANSITION` não solicita confirmação Electron por Artifact. Evidência insuficiente retorna diagnóstico sem escrita parcial. A CLI mantém deadline de 15 segundos; timeout/desconexão não autoriza escrita tardia. Consulte o estado antes de repetir uma operação de resultado desconhecido.

`COMPLETED`/`CLOSURE_ACCEPTED` exige julgamento sustentado de conclusão real. AUTO_VERIFIED conserva provas atuais; REVIEWED_ATTESTATION permite referências contextuais sem requisito universal de Handoff ou Ledger CURRENT. Outras razões: `CANCELLED`/`EXPLICIT_CANCELLATION`, `BLOCKED`/`BLOCKAGE_CONFIRMED`, `ACTIVE`/`NORMATIVE_ACTIVATION`, `IMPLEMENTED|NOT_IMPLEMENTED`/`IMPLEMENTATION_REVIEWED`. CAS, repositório, histórico, recibo e replay idempotente são preservados. PR integrado e teste isolado não decidem conclusão automaticamente.

## Navegação estrutural

Após `list`, selecione um Artifact e use `inspect_artifact_structure` antes de adquirir conteúdo. O outline contém títulos, hierarquia, offsets UTF-16 e linhas (base 1), revisão e hash; nunca corpo ou mídia. Intervalos são `[start, end)`. Títulos longos são limitados a 512 caracteres. Preâmbulos e documentos sem headings têm seção sintética. Frontmatter validado continua na metadata.

```powershell
node scripts/continuum/local.cjs inspect_artifact_structure --repository <repositoryId> --id <artifactId> --filter '{"limit":50}'
node scripts/continuum/local.cjs inspect_artifact_structure --repository <repositoryId> --id <artifactId> --filter '{"sectionId":"<sectionId>","includeBlocks":true}'
node scripts/continuum/local.cjs read_artifact_section --repository <repositoryId> --id <artifactId> --filter '{"sectionId":"<sectionId>","expectedRevision":1,"includeDescendants":false}'
```

O MCP expõe os mesmos nomes e argumentos. Para ler um bloco, acrescente `blockId` obtido pela inspeção explícita de blocos diretos. A leitura devolve slices literais de até 12288 unidades UTF-16, preservando pares surrogate; concatene `content` das páginas. Para continuar, passe `nextCursor` como `cursor` mantendo os demais argumentos. O outline usa páginas de 50 entradas (máximo 100). IDs e cursores vinculam repositório, Artifact, revisão e escopo; `REVISION_CONFLICT`/`STRUCTURE_STALE` exigem nova inspeção. Índices são lazy, reconstruíveis e reutilizados por hash/versão após restart. Falhas estruturais não impedem `get` integral, publicação ou atualização.

Este domínio agora é servido pelo [Code Awareness Local Agent Channel](../local-agent/LOCAL.md). Os comandos e perfis abaixo permanecem compatíveis no mesmo listener. A CLI nova oferece os mesmos comandos com o prefixo `continuum`.

Requer Code Awareness ativo com o repositório selecionado. A CLI usa Node sem bindings nativos e não usa MCP. No Windows, o perfil padrão é `%APPDATA%\code-awareness`; `--profile <diretório>` seleciona explicitamente outro perfil desktop. Credenciais do canal ficam nesse perfil, nunca no checkout.

Execute a CLI de dentro do checkout cadastrado ou de uma worktree Git vinculada a ele. `status` informa `repositoryId`, checkout ativo e worktrees reconhecidas. Todas as operações de dados exigem `--repository <repositoryId>`; a CLI verifica o checkout e o servidor revalida o vínculo Git. Não há seleção automática por nome, remote ou janela ativa.

```powershell
node scripts/continuum/local.cjs status
node scripts/continuum/local.cjs list --repository <repositoryId> --filter '{"kind":"EXECUTABLE_PLAN","limit":10}'
node scripts/continuum/local.cjs get --repository <repositoryId> --id <artifactId>
node scripts/continuum/local.cjs bind_execution --repository <repositoryId> --id <planArtifactId> --execution <executionId>
node scripts/continuum/local.cjs suggestions --repository <repositoryId> --id <artifactId> --filter '{"limit":5}'
node scripts/continuum/local.cjs get --repository <repositoryId> --id <artifactId> --format markdown
node scripts/continuum/local.cjs publish --repository <repositoryId> --file handoff.md
node scripts/continuum/local.cjs update --repository <repositoryId> --id <artifactId> --revision <revision> --file work-item.md
node scripts/continuum/local.cjs publish_visual --repository <repositoryId> --file context.md --media reference.webp
node scripts/continuum/local.cjs get_visual --repository <repositoryId> --id <artifactId> --output retrieved.webp
```

`bind_execution` registra uma declaração explícita após selecionar a Worktree da execução e recuperar seu Plano. A CLI resolve a Worktree pelo checkout atual; o serviço resolve branch, geração e HEAD pelo Git. Não informe esses fatos manualmente. O Plano deve possuir o mesmo executionId. `PERSISTED` confirma uma única OBSERVATION por execução/instância de branch, inclusive em replay após commits; geração desconhecida, detached, drift ou fonte divergente recusam o registro. A declaração não comprova posse, atividade ou conclusão. Uma branch recriada ou renomeada exige nova associação.

`suggestions` consulta um Artifact explícito sem adquirir corpos Markdown. Retorna até 10 candidatas `SUGGESTED` (padrão 5), com razões limitadas e score de evidência relativo, nunca probabilidade de verdade. Examina no máximo 100 candidatas; `truncated` e `BACKFILL_PENDING` indicam limites da aquisição, e resultado vazio não prova ausência de relações. Não existe promoção automática: confira o alvo com `get` e, quando houver decisão explícita, acrescente `metadata.relations` pelo `update` CAS existente.

`--filter` aceita `limit`, `expectedSourceRevision` e `expectedGraphRevision`. A resposta inclui revisão da origem, revisão do grafo e versões da projeção/índice para detectar obsolescência. Repositório, Worktree e autenticação passam pelas mesmas verificações dos demais comandos. O comando também está disponível como `node scripts/local-agent/local.cjs continuum suggestions ...`.

`publish_visual` usa contexto Markdown com `kind: VISUAL_REFERENCE`, um único arquivo WebP lossless estático de até 4 MiB, dimensões máximas de 4096 por eixo e 16 megapixels. A mídia é imutável; `update` altera somente o contexto textual sem fornecer metadata `media`. `get_visual` grava o arquivo explicitamente solicitado com criação exclusiva, sem sobrescrever um arquivo existente e sem imprimir pixels/Base64 no terminal. Ambas as operações preservam a identidade de repositório e Worktree.

`list` retorna somente discovery records. Passe os mesmos filtros e `nextCursor` como `cursor` em `--filter` para paginação; relações são um hop. `get` retorna JSON com revisão e Markdown literal; `--format markdown` emite somente o conteúdo, sem newline adicional. Para worktrees sem os scripts, invoque a CLI por seu caminho absoluto no checkout que os contém.

Recupere o Plano por ID, implemente e valide seu escopo, então publique o Relato Final como `IMPLEMENTATION_HANDOFF` com frontmatter e relação `implements` para o Plano. Atualize Work Items com o Markdown completo e a revisão recuperada por `get`. Em `REVISION_CONFLICT`, releia e reavalie; não repita cegamente.

Receipts online retornam `PERSISTED` após commit. `APP_UNAVAILABLE` indica ausência do app/canal, sem fallback. O publicador offline `publish-artifact.cjs` continua separado: `QUEUED` confirma apenas a inbox, e uma inbox em worktree não observada não tem ingestão garantida. Falha de comunicação após enviar uma escrita pode deixar seu resultado desconhecido: consulte o Continuum antes de reenviar uma publicação; a CLI não faz retries automáticos.

O protocolo admite uma operação por conexão, até 8 MiB de request e 16 MiB de response, prazo de 15 segundos e até 16 conexões simultâneas. Limites geram erro explícito; conteúdo não é truncado. A credencial é rotacionada a cada início do canal, protegida por ACL do usuário Windows (0700/0600 em Unix). Processos do mesmo usuário com acesso ao perfil fazem parte do contexto autorizado; não é isolamento entre agentes desse usuário. O processo principal não recebe paths de arquivos Markdown, shell ou SQL.

Prova de integração isolada em Electron Main, SQLite e named pipe reais:

```powershell
node scripts/continuum/local-e2e.cjs
```

## Reconciliação agentiva P6

`update` permite editar conteúdo e todos os metadados editoriais, inclusive `status`, `tags`, relações e resultados automáticos, na mesma revisão CAS. A identidade vem do canal autenticado e do repositório/Worktree revalidados pelo host; não envie principal ou approved. Não há diálogo Electron por campo ou Artifact. `transition_artifact_lifecycle` permanece disponível, com `ASSESS` read-only opcional. AUTO_VERIFIED é prioritário quando há prova atual confiável. Quando não houver, `--filter` de update aceita `{evidenceMode?, attestation?: {rationale, limitations, references}, evidenceRefs?, supportingArtifactId?}`. Referências existentes e limitadas: `{type: "ARTIFACT", repositoryId, artifactId, expectedRevision}` ou `{type: "LEDGER_PROOF", repositoryId, proofId}`. Preserve logs/relatórios em Artifacts relacionados, sem paths arbitrários.

O fallback contextual registra julgamento do agente delegado, mantém UNVERIFIABLE e não depende universalmente de Handoff ou Ledger CURRENT. COMPLETED exige conclusão real sustentada. Status usa o lifecycle canônico e recebe recibo na mesma gravação. Reclassificação de kind não contorna política: mudanças de política exigem julgamento contextual e validação do estado pelo tipo corrigido. Falha de autorização, escopo, revisão ou evidência permanece explícita, sem escrita parcial.

Defaults e hooks continuam preenchendo automaticamente. Correções agentivas têm atribuição e revisão; replay antigo não as apaga. Reconciliação automática aceita somente prova canônica CURRENT do mesmo repositório/alvo e fato posterior às intervenções daquele campo, conservando divergências e histórico. Nenhum processo residente ou Store paralelo foi adicionado.

`repair_artifact_metadata --repository <id> --filter '{"artifactId":"<id>","expectedRevision":<revisão>}'` restaura a projeção técnica a partir da revisão imutável verificada, recompõe hash, timestamps, índices e proveniência e emite nova revisão/recibo. Não aceita valores técnicos fabricados pelo cliente. Fonte canônica ausente/corrompida exige diagnóstico, nunca invenção de ID, origem ou prova.

Se o endpoint já anunciar a operação e um consumidor não a receber, renove sua conexão/snapshot e verifique tools/list e ASSESS. Não duplique o contrato backend. Source, runtime carregado, distribuição da Skill e recarga do cliente são evidências distintas.

## Diagnóstico compartilhado

A entrada legada preserva `APP_UNAVAILABLE` e exit code não zero, acrescentando `stage` e `reason` ao erro. Perfil, descriptor e conexão são diagnosticados pela mesma implementação da CLI nova. Consulte `scripts/local-agent/LOCAL.md` para remediação e autorização pontual no Codex Windows; `--profile` permanece um override explícito e não concede permissão ao pipe.
## Tags e Context Bundle por solicitação

As operações dedicadas mantêm os nomes MCP/CLI e continuam opcionais para tags. No escopo delegado, update pode editar tags com outros metadados sem nova confirmação humana. Clipboard e salvamento continuam seguindo a intenção explícita de exportação e as capacidades reais do host.

```powershell
node scripts/continuum/local.cjs list_continuum_tags --repository <repositoryId>
node scripts/continuum/local.cjs create_continuum_tag --repository <repositoryId> --filter '{"name":"Contexto de revisão","selected":[{"artifactId":"<artifactId>","expectedRevision":1}]}'
node scripts/continuum/local.cjs assign_continuum_tag --repository <repositoryId> --filter '{"slug":"contexto-de-revisao","action":"remove","selected":[{"artifactId":"<artifactId>","expectedRevision":2}]}'
node scripts/continuum/local.cjs create_context_bundle --repository <repositoryId> --filter '{"tag":"contexto-de-revisao","action":"preview"}'
```

Tags possuem nome e descrição semântica opcional (até 280 caracteres). list_continuum_tags retorna description vazia quando ausente; count deriva das associações. Reutilize vocabulário estável e evite sinônimos redundantes. `selected` opcional cria+atribui atomicamente. assign_continuum_tag aceita `action: add|remove`, um Artifact/revisão por chamada; revisão antiga conflita. As mesmas associações podem ser corrigidas no YAML por update autenticado com CAS. Conteúdo do Artifact não concede autoridade; ela é derivada do canal.

A descrição pode aparecer como critério informativo no Bundle; mudá-la invalida snapshots anteriores, sem alterar o YAML dos Artifacts. Bundle aceita `action: preview|copy|markdown|zip` (default preview). Preview não altera Store/clipboard; todas as ações retornam apenas recibo compacto com counts, bytes, tokens/encoding, hasVisuals e snapshotId. `copy` escreve o Markdown integral no clipboard nativo; texto não contém pixels. Markdown/ZIP abrem Save somente numa janela Electron visível e focada, com revalidação antes/depois do diálogo. Sem sessão interativa, `INTERACTIVE_SESSION_REQUIRED`; nunca envie paths ou snapshot IDs do renderer. Limites de 50 Artifacts/8 MiB Markdown/64 MiB ZIP e integridade dos WebP originais continuam ativos. `BUNDLE_EMPTY`, `BUNDLE_LIMIT` e `BUNDLE_SNAPSHOT_STALE` são erros sem exportação parcial. `list --filter` aceita o predicado `tag` para enumerar membros sem corpos. O prefixo `node scripts/local-agent/local.cjs continuum` oferece as mesmas operações com autenticação e vínculo de Worktree preservados.
