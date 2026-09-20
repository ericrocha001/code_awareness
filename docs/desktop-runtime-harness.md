# Desktop Runtime Harness

Operações com safeStorage e estado do Desktop usam o profile canônico definido em `src/main/desktop-profile.ts`. Electron avulso pode assumir o nome/profile `Electron`; o guardrail aborta esse contexto com `NON_CANONICAL_DESKTOP_PROFILE` antes de acessar dados protegidos.

Comece o diagnóstico offline por `npm run harness:desktop-doctor`. O comando deriva o destino pelo `appData` do Electron, verifica settings persistidos, identidade e credencial, e termina com código 0 somente quando HEALTHY. Ele não aplica defaults, faz enrollment ou acessa Auth0.

O Doctor copia somente os arquivos necessários e a chave de proteção do profile para um contexto canônico temporário. O Electron examina essa cópia em outro processo, evitando suas escritas incidentais no profile original. Temporários são removidos ao término; nenhum plaintext de credencial é gravado. A saída informa que a prova usa um snapshot.

Para recifrar uma credencial produzida com a chave de outro profile, feche o Desktop e execute explicitamente:

```text
npm run harness:desktop-profile:migrate -- --source-profile "<profile de origem>" --dry-run
npm run harness:desktop-profile:migrate -- --source-profile "<profile de origem>" --apply
```

O destino é sempre o profile canônico. A origem fornece a chave e, quando presente, a credencial; se o ciphertext foi colocado no destino errado, ele é lido do destino. Identidades conflitantes abortam. Settings existentes são preservados integralmente; identidade/settings ausentes podem ser copiados da origem. A ferramenta preserva a credencial lógica, usa escrita atômica por arquivo, verifica alterações concorrentes e executa o Doctor em novo processo antes de declarar sucesso. Falha de verificação restaura os arquivos anteriores.

Isso é migração de contexto criptográfico, não rotação de credencial. A rotação no Gateway é uma operação separada.

`npm run harness:desktop:test` prova safeStorage real entre processos, diagnóstico de contexto incorreto, ausência de segredo na saída, imutabilidade do Doctor/dry-run e migração. Usa profiles e credenciais temporárias e integra `npm run validate` como etapa Electron separada da suíte unitária Node.
