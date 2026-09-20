# Conexão externa do MCP

O processo principal mantém a autoridade do lifecycle. Os settings persistem somente a intenção `remoteAccessEnabled` e a seleção `transportKind` (`relay` ou `ngrok`). Instalações novas começam desabilitadas. Quando habilitada, a conexão aguarda um projeto ativo e o MCP local disponível; não seleciona nem persiste automaticamente um projeto.

O transporte Relay usa `https://code-awareness-gateway.eric-rocha.workers.dev/mcp` e a credencial protegida da instalação no userData canônico. A conexão automática não depende de token OAuth humano ou novo enrollment. Reiniciar o Desktop preserva a intenção; selecionar um projeto permite conectar novamente. `getConnectionState()`, `connect()`, `disconnect()` e `onConnectionChanged()` compartilham o estado canônico via preload/IPC.

O endpoint público `/mcp` é protegido exclusivamente por uma Cloudflare Access Application com Managed OAuth. O Worker valida `Cf-Access-Jwt-Assertion` contra as chaves da organização, o issuer configurado em `CLOUDFLARE_ACCESS_TEAM_DOMAIN` e o AUD da aplicação em `CLOUDFLARE_ACCESS_AUD`. O `sub` validado é a identidade usada no vínculo com a instalação. O origin não publica discovery, challenge ou escopos Auth0 para MCP; esses contratos pertencem ao Access. `AUTHORIZATION_SERVER` permanece restrito ao enrollment existente e não participa de chamadas MCP.

Falhas transitórias do Relay permitem novas tentativas de conexão após 1, 2, 5, 10 e no máximo 30 segundos. Conectar com sucesso reinicia o contador. Esse mecanismo não repete chamadas MCP. Desabilitar o acesso ou encerrar o aplicativo cancela as tentativas. Erros terminais exigem intervenção.

Trocar o projeto encerra a exposição anterior antes de confirmar a nova seleção. Fechar o projeto remove a exposição e mantém a intenção habilitada para uma seleção posterior. Timers, estados de conexão e portas não são persistidos.

Ngrok permanece disponível por seleção explícita de `transportKind`, sem ativação simultânea com Relay. Configure `ngrokDomain` com o hostname estável da conta, sem protocolo ou caminho; o CLI deve estar instalado e autenticado. Não há troca automática de transporte nem fallback para domínio aleatório. A inspeção local é desabilitada com `--inspect=false`; Full Capture deve permanecer desabilitado na conta ngrok.

O Gateway persiste metadados de identidade e autorização, sem armazenar corpos MCP ou código. O cliente ChatGPT pode apresentar o `503 INSTALLATION_OFFLINE` do Gateway como um erro genérico `502`; isso não altera o contrato do servidor.
