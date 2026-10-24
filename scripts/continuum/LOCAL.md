# Continuum no terminal

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

## Diagnóstico compartilhado

A entrada legada preserva `APP_UNAVAILABLE` e exit code não zero, acrescentando `stage` e `reason` ao erro. Perfil, descriptor e conexão são diagnosticados pela mesma implementação da CLI nova. Consulte `scripts/local-agent/LOCAL.md` para remediação e autorização pontual no Codex Windows; `--profile` permanece um override explícito e não concede permissão ao pipe.
## Tags e Context Bundle por solicitação

As quatro operações dedicadas usam os mesmos nomes no MCP e na CLI local. Verifique sua descoberta no runtime em execução antes de usar uma versão nova. Somente execute mutação, clipboard ou salvamento por solicitação explícita do usuário. Navegação/leitura e atualização textual não autorizam tags.

```powershell
node scripts/continuum/local.cjs list_continuum_tags --repository <repositoryId>
node scripts/continuum/local.cjs create_continuum_tag --repository <repositoryId> --filter '{"name":"Contexto de revisão","selected":[{"artifactId":"<artifactId>","expectedRevision":1}]}'
node scripts/continuum/local.cjs assign_continuum_tag --repository <repositoryId> --filter '{"slug":"contexto-de-revisao","action":"remove","selected":[{"artifactId":"<artifactId>","expectedRevision":2}]}'
node scripts/continuum/local.cjs create_context_bundle --repository <repositoryId> --filter '{"tag":"contexto-de-revisao","action":"preview"}'
```

Tags possuem nome e descrição semântica opcional (description, até 280 caracteres), usada como critério de pertencimento; cor e objetivo não são aceitos. list_continuum_tags retorna description como string, vazia quando ausente. O slug continua sendo identidade interna estável e count é derivado das associações. Consulte o catálogo e reutilize antes de propor criação; crie só por pedido explícito ou proposta aprovada, nunca uma tag automática por Artifact. `selected` é opcional em create; quando fornecido, criar+atribuir é uma transação. Atribuição aceita um Artifact explícito por chamada, com revisão observada; revisão antiga conflita mesmo se o membership já coincidir. Criação retorna `state: PERSISTED`, `creation: CREATED|EXISTING`, tag e recibos; colisão real retorna `TAG_IDENTITY_CONFLICT`. Slug é derivado no servidor e imutável. `assign_continuum_tag` aceita `action: add|remove`; não há `confirmed`, edição/exclusão agentiva nem escape pelo YAML genérico.

A descrição pode aparecer como critério informativo no Bundle; mudá-la invalida snapshots anteriores, sem alterar o YAML dos Artifacts. Bundle aceita `action: preview|copy|markdown|zip` (default preview). Preview não altera Store/clipboard; todas as ações retornam apenas recibo compacto com counts, bytes, tokens/encoding, hasVisuals e snapshotId. `copy` escreve o Markdown integral no clipboard nativo; texto não contém pixels. Markdown/ZIP abrem Save somente numa janela Electron visível e focada, com revalidação antes/depois do diálogo. Sem sessão interativa, `INTERACTIVE_SESSION_REQUIRED`; nunca envie paths ou snapshot IDs do renderer. Limites de 50 Artifacts/8 MiB Markdown/64 MiB ZIP e integridade dos WebP originais continuam ativos. `BUNDLE_EMPTY`, `BUNDLE_LIMIT` e `BUNDLE_SNAPSHOT_STALE` são erros sem exportação parcial. `list --filter` aceita o predicado `tag` para enumerar membros sem corpos. O prefixo `node scripts/local-agent/local.cjs continuum` oferece as mesmas operações com autenticação e vínculo de Worktree preservados.
