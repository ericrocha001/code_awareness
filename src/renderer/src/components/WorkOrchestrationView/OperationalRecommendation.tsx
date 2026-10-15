import type { OperationalRecommendation as Recommendation } from '../../../../shared/types/work-orchestration-attention-types'

export function OperationalRecommendation({ recommendation, provider, consumer }: { recommendation?: Recommendation; provider: string; consumer: string }) {
  if (!recommendation) return <p>Verificar a evidência antes de decidir como coordenar os trabalhos.</p>
  const symbols = recommendation.symbols.join(', ') + (recommendation.symbolCount > recommendation.symbols.length ? ' e outros' : '')
  return <div className="wo-recommendation">
    <p>{recommendation.action === 'REVIEW_CONTRACT_COMPATIBILITY' ? `Revisar compatibilidade ${symbols ? `do contrato ${symbols}` : 'dos contratos'} com o consumidor antes de integrar esses trabalhos.` : 'Revalidar essa interferência antes de decidir como coordenar os trabalhos.'}</p>
    <p className="wo-recommendation-reason">{recommendation.reason === 'DIRECT_CONTRACT_CONSUMER' ? `Contrato exportado alterado em ${provider}; consumidor modificado em ${consumer}, com vínculo direto resolvido.` : 'A evidência anterior não comprova o estado atual dessas worktrees.'}</p>
    <p className="wo-recommendation-limit">Potencial interferência; não comprova bug, quebra de compatibilidade ou conflito de merge.</p>
  </div>
}
