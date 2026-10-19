# Recuperação Determinística de Abertura de PR para Worktree Execution

Esta documentação registra a implementação e validação do mecanismo determinístico de recuperação de abertura de Pull Request na Skill canônica `worktree-execution`.

## Contexto e Objetivo

Concluir a segunda camada do Harness de execução em Git Worktrees, provendo um script portátil e determinístico (`scripts/open-pr-safe.cjs`) para recuperar falhas de abertura de PR em clientes e modelos econômicos sem alterar o fluxo principal ou depender de ferramentas MCP não homologadas.

## Implementação Canônica na Academy

O script foi versionado no package canônico da Skill `worktree-execution` (ID `ae5eb7c9-8633-4837-b9cf-bbc7149cdc3a`):
- **Versão**: 27
- **Hash do Package**: `18f15ae43a0427b5cad148ea5f44db9fc37dec5433f47849842c25c2ac8cac0e`
- **Artefatos**:
  - `scripts/open-pr-safe.cjs`: script seguro e idempotente em Node 24 utilizando apenas módulos nativos e a CLI `gh`.
  - `references/pr-creation-recovery.md`: complemento condicional orientando a invocação prioritária do script se presente no runtime.

## Propriedades e Salvaguardas

1. **Parâmetros Estritos**: `--repo OWNER/REPO`, `--head`, `--base`, `--title`, `--body` / `--body-file`, `--expected-head-sha`. Rejeição preventiva de head igual à base e valores vazios.
2. **Autenticação**: Checagem de `gh --version` e `gh auth status` sem exigir `GITHUB_TOKEN` e sem expor credenciais.
3. **Inspeção Read-only**: Validação de existência do repositório, branch base e commit no head remoto correspondente ao HEAD local, sem qualquer comando mutatório (`push`, `rebase`, `commit` ou `force`).
4. **Prevenção de Duplicatas**: Consulta de PRs prévios (`gh pr list`). Reutiliza PR `OPEN` existente e bloqueia com `BLOCKED` se houver PR `CLOSED` ou `MERGED`.
5. **Criação Segura**: Criação sem `--web`, sem `--draft`, sem merge e sem tocar na `main`.
6. **Reconciliação e Verificação**: Reconciliação imediata pós-criação confirmando existência remota, `number`, URL real de PR, `state=OPEN` e `isDraft=false`.
7. **Retorno Estruturado**: Saída padronizada em JSON com distinção entre `CREATED`, `EXISTING_OPEN`, `BLOCKED` e `UNKNOWN`.

## Rastreabilidade no Continuum

- **Plano Canônico**: `artifact-a0d6f223-f9d0-444d-9083-7452a3e99c09` (status: `COMPLETED`)
- **Implementation Handoff**: `artifact-5cc6dd5e-13f2-4ddb-9c31-2e9df8af965e` (status: `VALIDATED`)
