# Conexão externa do MCP

O processo principal mantém a autoridade do lifecycle. Os settings persistem somente a intenção `remoteAccessEnabled` e a seleção `transportKind` (`relay` ou `ngrok`). Instalações novas começam desabilitadas. Quando habilitada, a conexão aguarda um projeto ativo e o MCP local disponível; não seleciona nem persiste automaticamente um projeto.

## Configuração da infraestrutura

A infraestrutura versionada é um template e não deve conter identificadores de uma implantação pessoal.

Antes de implantar o Gateway:

1. crie o banco D1 e substitua `REPLACE_WITH_YOUR_D1_DATABASE_ID` em `infra/gateway/wrangler.jsonc`;
2. configure `AUTHORIZATION_SERVER` com o issuer da sua própria implantação de autorização;
3. configure `CLOUDFLARE_ACCESS_TEAM_DOMAIN` e `CLOUDFLARE_ACCESS_AUD` no ambiente do Worker;
4. mantenha segredos e variáveis locais em mecanismos não versionados, como `.dev.vars`, que já é ignorado pelo repositório.

O script auxiliar `scripts/auth0-pkce-login.cjs` também não contém identidade de uma implantação. Para utilizá-lo, forneça `CODE_AWARENESS_AUTH0_ISSUER`, `CODE_AWARENESS_AUTH0_CLIENT_ID` e `CODE_AWARENESS_GATEWAY_AUDIENCE` no ambiente. `CODE_AWARENESS_AUTH0_SCOPE` e `CODE_AWARENESS_AUTH0_REDIRECT` são opcionais; o redirect deve permanecer em host loopback.

O transporte Relay usa o endpoint MCP da implantação configurada e a credencial protegida da instalação no userData canônico. A conexão automática não depende de token OAuth humano ou novo enrollment. Reiniciar o Desktop preserva a intenção; selecionar um projeto permite conectar novamente. `getConnectionState()`, `connect()`, `disconnect()` e `onConnectionChanged()` compartilham o estado canônico via preload/IPC.

O endpoint público `/mcp` é protegido exclusivamente por uma Cloudflare Access Application com Managed OAuth. O Worker valida `Cf-Access-Jwt-Assertion` contra as chaves da organização, o issuer configurado em `CLOUDFLARE_ACCESS_TEAM_DOMAIN` e o AUD da aplicação em `CLOUDFLARE_ACCESS_AUD`. O `sub` validado é a identidade usada no vínculo com a instalação. O origin não publica discovery, challenge ou escopos Auth0 para MCP; esses contratos pertencem ao Access. `AUTHORIZATION_SERVER` permanece restrito ao enrollment existente e não participa de chamadas MCP.

Falhas transitórias do Relay permitem novas tentativas de conexão após 1, 2, 5, 10 e no máximo 30 segundos. Conectar com sucesso reinicia o contador. Esse mecanismo não repete chamadas MCP. Desabilitar o acesso ou encerrar o aplicativo cancela as tentativas. Erros terminais exigem intervenção.

Trocar o projeto encerra a exposição anterior antes de confirmar a nova seleção. Fechar o projeto remove a exposição e mantém a intenção habilitada para uma seleção posterior. Timers, estados de conexão e portas não são persistidos.

Ngrok permanece disponível por seleção explícita de `transportKind`, sem ativação simultânea com Relay. Configure `ngrokDomain` com o hostname estável da conta, sem protocolo ou caminho; o CLI deve estar instalado e autenticado. Não há troca automática de transporte nem fallback para domínio aleatório. A inspeção local é desabilitada com `--inspect=false`; Full Capture deve permanecer desabilitado na conta ngrok.

O Gateway persiste metadados de identidade e autorização, sem armazenar corpos MCP ou código. O cliente MCP pode apresentar o `503 INSTALLATION_OFFLINE` do Gateway como um erro genérico `502`; isso não altera o contrato do servidor.
