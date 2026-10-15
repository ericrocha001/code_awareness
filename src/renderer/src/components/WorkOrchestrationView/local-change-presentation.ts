import type { LocalChange } from '../../../../shared/types/local-change-types'

const labels: Record<string, string> = { A: 'Adicionado', C: 'Adicionado', M: 'Modificado', T: 'Modificado', D: 'Excluído', R: 'Renomeado' }
const indexStates: Record<string, string> = {
  A: 'Adicionado ao índice', C: 'Copiado no índice', M: 'Modificado no índice', T: 'Tipo de arquivo alterado no índice', D: 'Excluído do índice', R: 'Renomeado no índice'
}
const directoryStates: Record<string, string> = {
  A: 'Adicionado no diretório de trabalho', C: 'Copiado no diretório de trabalho', M: 'Modificado no diretório de trabalho',
  T: 'Tipo de arquivo alterado no diretório de trabalho', D: 'Excluído no diretório de trabalho', R: 'Renomeado no diretório de trabalho'
}

export function presentLocalChange(change: LocalChange): { classification: string; description: string } {
  if (change.conflicted) return { classification: 'Em conflito', description: 'Conflito não resolvido' }
  if (change.untracked) return { classification: 'Não rastreado', description: 'Ainda não rastreado pelo Git' }
  const states = [change.stagedState, change.unstagedState].filter((state): state is string => state !== null)
  const classifications = [...new Set(states.map(state => labels[state] ?? 'Estado não classificado'))]
  const descriptions: string[] = []
  if (change.stagedState) descriptions.push(indexStates[change.stagedState] ?? 'Alteração no índice não classificada')
  if (change.unstagedState) descriptions.push(directoryStates[change.unstagedState] ?? 'Alteração no diretório de trabalho não classificada')
  return { classification: classifications.join(' · ') || 'Estado não classificado', description: descriptions.join('; ') || 'Classificação não disponível nesta observação' }
}
