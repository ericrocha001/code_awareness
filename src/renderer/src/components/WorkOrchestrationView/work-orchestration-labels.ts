import type { LocalChangeCategory } from '../../../../shared/types/local-change-types'

const categories: Record<LocalChangeCategory, [string, string]> = {
  added: ['adicionado', 'adicionados'], modified: ['modificado', 'modificados'], deleted: ['excluído', 'excluídos'],
  renamed: ['renomeado', 'renomeados'], untracked: ['não rastreado', 'não rastreados'], conflicted: ['em conflito', 'em conflito']
}
export const categoryLabel = (category: LocalChangeCategory, count: number) => categories[category][count === 1 ? 0 : 1]
const reasons: Record<string, string> = {
  GIT_STATE_CHANGED: 'O estado Git mudou. Revalide a observação.', WORKTREE_STALE: 'A worktree foi alterada ou substituída.',
  WORKTREE_MISSING: 'A worktree não está disponível no disco.', WORKTREE_PRUNABLE: 'O registro da worktree pode ser removido pelo Git.',
  WORKTREE_NOT_DISCOVERED: 'A worktree não consta no inventário. Atualize a lista.', WORKTREE_IDENTITY_MISMATCH: 'A identidade da worktree não corresponde ao registro.',
  WORKTREE_REPOSITORY_CHANGED: 'O repositório da worktree mudou.', REPOSITORY_CONTEXT_CHANGED: 'O contexto do repositório mudou.',
  PROJECT_CONTEXT_CHANGED: 'O projeto ativo mudou. Atualize a observação.', GIT_READ_UNAVAILABLE: 'A leitura do estado Git está indisponível.',
  HEAD_UNAVAILABLE: 'HEAD indisponível.', MERGE_BASE_UNAVAILABLE: 'Não foi possível determinar o merge-base.',
  GIT_PATH_LIMIT: 'O limite de caminhos da leitura Git foi atingido.', INVALID_ARGUMENT: 'Parâmetros de leitura inválidos.',
  REVALIDATING: 'Revalidando…', REVALIDATION_FAILED: 'Não foi possível revalidar a observação.'
}
export const reasonLabel = (reason: string) => reasons[reason] ?? (/^[A-Z][A-Z0-9_]+$/.test(reason) ? `Falha na leitura Git (${reason}).` : reason)
