# Academy governance

A contribuição de uma Skill pública inclui `skills/<name>/SKILL.md` e a entrada com seu `skillId` persistente em `.academy/identities.json`, schema 2, no mesmo commit. Renomear conserva o ID e atualiza o path. Excluir conserva a entrada com `state: REMOVED`, `baseHash` SHA-256 do pacote e `revision` positiva. Desativação é preferência local e não altera a árvore pública.

Execute `node scripts/academy-governance/validate.cjs HEAD <base-sha>` antes de propor o commit. A validação lê árvores Git e nunca executa arquivos importados. Mudanças de versão do manifesto são propostas; o check não reserva nem aprova releases no ledger local.

No repositório de publicação da Academy, instale conjuntamente a workflow, o script e `src/shared/academy-identity.cjs`. O operador autorizado deve abrir Settings → Rules → Rulesets (ou Branches), selecionar `main`, exigir Pull Request e o check `academy-governance`, restringir force-push/deletion e revisar a lista de bypass. Confirme que o plano GitHub permite essas regras. Nenhuma regra administrativa é ativada por estes arquivos; até a configuração e sua verificação, a proteção efetiva permanece PENDENTE.
