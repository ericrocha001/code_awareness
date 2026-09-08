# Runtime Nativo e Testes

O runtime nativo canonico do Code Awareness e o Electron. A arvore principal `node_modules` deve permanecer preparada para o ABI do Electron instalado pelo projeto.

## Politica

1. O Electron canonico e `32.0.0`.
2. As dependencias nativas conhecidas sao `better-sqlite3`, `tree-sitter`, `tree-sitter-typescript` e `tree-sitter-javascript`.
3. Instalacoes devem usar npm 10.
4. Em rotina limpa, use `npm ci`.
5. O diagnostico canonico e `npm run native:doctor`.
6. O reparo autorizado e `npm run native:prepare`.
7. Suites sem addons nativos rodam na pista Node; suites nativas declaradas rodam pelo Electron com `ELECTRON_RUN_AS_NODE=1`.
8. O comando `native:node` nao existe mais.
9. Nao altere ABI manualmente nem recompile bindings para o Node externo.
10. Ao adicionar um novo modulo nativo usado diretamente pela aplicacao, atualize a Native Runtime Policy.

## Comandos

Fresh checkout:

```bash
npx -p npm@10.9.4 npm run bootstrap
```

Rotina de validacao:

```bash
npm run native:preflight
npm run native:doctor
npm run test:node
npm run test:native
npm run test:run
npm run test:db
npm run build
```

`native:doctor` apenas diagnostica. Ele nao instala pacotes, nao executa rebuild e nao altera `node_modules`.

`native:preflight` valida npm 10, manifesto, lockfile, npm registry, DNS do GitHub e HTTPS do GitHub antes de qualquer `npm ci`. Se falhar, nenhum rebuild ou fallback de compilacao deve ser iniciado.

`native:prepare` executa o preparo nativo do addon ABI-sensivel para o Electron instalado. Use esse comando somente quando o Doctor indicar incompatibilidade de addon ou depois de uma alteracao deliberada de dependencia nativa. A validacao funcional completa dos quatro modulos nativos permanece no `native:doctor`.

## Pistas de teste

`test:node` executa pelo Node normal as suites TypeScript/JavaScript que nao carregam addons nativos. `test:native` executa pelo launcher Electron somente as suites listadas em `scripts/test-runtime-lanes.cjs`. `test:run` encadeia as duas pistas nessa ordem.

`test:lanes:guard` valida a lista nativa e rejeita imports diretos dos quatro pacotes nativos em suites da pista Node. Ao surgir uma nova dependencia nativa em teste, mova explicitamente a suite para a lista Electron ou remova o acoplamento; nunca reconstrua a arvore para o ABI do Node.

## Invariante

O fluxo `test:node -> test:native -> test:db -> dev` deve funcionar sem rebuild intermediario. Se falhar, o estado nativo e invalido e deve ser diagnosticado pelo Native Runtime Guard.
