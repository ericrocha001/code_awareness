# Continuum no terminal

Este domínio agora é servido pelo [Code Awareness Local Agent Channel](../local-agent/LOCAL.md). Os comandos e perfis abaixo permanecem compatíveis no mesmo listener. A CLI nova oferece os mesmos comandos com o prefixo `continuum`.

Requer Code Awareness ativo com o repositório selecionado. A CLI usa Node sem bindings nativos e não usa MCP. No Windows, o perfil padrão é `%APPDATA%\code-awareness`; `--profile <diretório>` seleciona explicitamente outro perfil desktop. Credenciais do canal ficam nesse perfil, nunca no checkout.

Execute a CLI de dentro do checkout cadastrado ou de uma worktree Git vinculada a ele. `status` informa `repositoryId`, checkout ativo e worktrees reconhecidas. Todas as operações de dados exigem `--repository <repositoryId>`; a CLI verifica o checkout e o servidor revalida o vínculo Git. Não há seleção automática por nome, remote ou janela ativa.

```powershell
node scripts/continuum/local.cjs status
node scripts/continuum/local.cjs list --repository <repositoryId> --filter '{"kind":"EXECUTABLE_PLAN","limit":10}'
node scripts/continuum/local.cjs get --repository <repositoryId> --id <artifactId>
node scripts/continuum/local.cjs get --repository <repositoryId> --id <artifactId> --format markdown
node scripts/continuum/local.cjs publish --repository <repositoryId> --file handoff.md
node scripts/continuum/local.cjs update --repository <repositoryId> --id <artifactId> --revision <revision> --file work-item.md
node scripts/continuum/local.cjs publish_visual --repository <repositoryId> --file context.md --media reference.webp
node scripts/continuum/local.cjs get_visual --repository <repositoryId> --id <artifactId> --output retrieved.webp
```

`publish_visual` usa contexto Markdown com `kind: VISUAL_REFERENCE`, um único arquivo WebP lossless estático de até 4 MiB, dimensões máximas de 4096 por eixo e 16 megapixels. A mídia é imutável; `update` altera somente o contexto textual sem fornecer metadata `media`. `get_visual` grava o arquivo explicitamente solicitado com criação exclusiva, sem sobrescrever um arquivo existente e sem imprimir pixels/Base64 no terminal. Ambas as operações preservam a identidade de repositório e Worktree.

`list` retorna somente discovery records. Passe os mesmos filtros e `nextCursor` como `cursor` em `--filter` para paginação; relações são um hop. `get` retorna JSON com revisão e Markdown literal; `--format markdown` emite somente o conteúdo, sem newline adicional. Para worktrees sem os scripts, invoque a CLI por seu caminho absoluto no checkout que os contém.

Recupere o Plano por ID, implemente e valide seu escopo, então publique o Relato Final como `IMPLEMENTATION_HANDOFF` com frontmatter e relação `implements` para o Plano. Atualize Work Items com o Markdown completo e a revisão recuperada por `get`. Em `REVISION_CONFLICT`, releia e reavalie; não repita cegamente.

Receipts online retornam `PERSISTED` após commit. `APP_UNAVAILABLE` indica ausência do app/canal, sem fallback. O publicador offline `publish-artifact.cjs` continua separado: `QUEUED` confirma apenas a inbox, e uma inbox em worktree não observada não tem ingestão garantida. Falha de comunicação após enviar uma escrita pode deixar seu resultado desconhecido: consulte o Continuum antes de reenviar uma publicação; a CLI não faz retries automáticos.

O protocolo admite uma operação por conexão, até 8 MiB de request e 16 MiB de response, prazo de 15 segundos e até 16 conexões simultâneas. Limites geram erro explícito; conteúdo não é truncado. A credencial é rotacionada a cada início do canal, protegida por ACL do usuário Windows (0700/0600 em Unix). Processos do mesmo usuário com acesso ao perfil fazem parte do contexto autorizado; não é isolamento entre agentes desse usuário. O processo principal não recebe paths de arquivos Markdown, shell ou SQL.

Prova de integração isolada em Electron Main, SQLite e named pipe reais:

```powershell
node scripts/continuum/local-e2e.cjs
```
