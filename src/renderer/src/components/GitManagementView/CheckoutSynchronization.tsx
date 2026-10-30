import React from 'react'
import type { GitCheckoutSynchronization } from '../../../../shared/types/git-management-types'

const unavailableReason = {
  NO_UPSTREAM: 'esta branch não tem upstream configurado',
  REMOTE_MISSING: 'o remoto configurado não está disponível',
  REMOTE_REF_MISSING: 'a referência upstream não existe no remoto',
  TIMEOUT: 'o remoto não respondeu no prazo',
  ACCESS_DENIED: 'acesso ao remoto recusado; verifique suas credenciais',
  NETWORK_ERROR: 'falha de conexão com o remoto',
  INVALID_REMOTE_RESPONSE: 'o remoto devolveu uma resposta inválida'
}

export function CheckoutSynchronization({ value, loading, error, blocked, verify, act }: {
  value: GitCheckoutSynchronization | null; loading: boolean; error: string; blocked: boolean
  verify: () => void; act: (value: GitCheckoutSynchronization) => void
}) {
  if (loading) return <span className="gm-checkout-sync" role="status">Verificando remoto…</span>
  const evidence = value?.evidence
  if (!evidence || evidence.status !== 'VERIFIED') return <span className="gm-checkout-sync">
    <span role="status">{error || (evidence?.status === 'UNAVAILABLE' ? `Não foi possível verificar: ${unavailableReason[evidence.reason]}.` : 'Estado local do último fetch; remoto ainda não verificado.')}</span>
    {value?.blockedReason && <small>{value.blockedReason}</small>}
    <button disabled={blocked} onClick={verify}>Verificar remoto</button>
  </span>
  const upstream = `${evidence.remote}/${evidence.ref.replace('refs/heads/', '')}`
  const partial = evidence.relationship !== 'IN_SYNC' && (evidence.tracking === 'TRACKING_STALE' || !evidence.remoteCounts || evidence.relationship === 'UNKNOWN')
  const counts = evidence.remoteCounts
  const label = evidence.relationship === 'IN_SYNC' ? `Atualizada com ${upstream}`
    : partial ? `Remoto alterado em ${upstream}; contagem ainda não verificada`
      : evidence.relationship === 'BEHIND' ? `${counts!.behind} ${counts!.behind === 1 ? 'commit' : 'commits'} atrás de ${upstream}`
        : evidence.relationship === 'AHEAD' ? `${counts!.ahead} ${counts!.ahead === 1 ? 'commit' : 'commits'} à frente de ${upstream}`
          : `${counts!.ahead} à frente · ${counts!.behind} atrás de ${upstream}; históricos divergentes`
  const actionLabel = value.action === 'PULL_FF_ONLY' ? 'Atualizar — Pull FF-only…'
    : value.action === 'FETCH' ? 'Buscar atualizações — Fetch…'
      : value.action === 'COMPARE' ? 'Inspecionar divergência' : 'Revisar publicação'
  return <span className="gm-checkout-sync">
    <span role="status">{label} <small>(verificado às {new Date(evidence.observedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})</small></span>
    {value.action && <button disabled={blocked} onClick={() => act(value)}>{actionLabel}</button>}
    {value.action && blocked && <small>Aguarde a leitura ou conclua/recupere a operação Git existente no painel de alterações.</small>}
    {value.blockedReason && <small>{value.blockedReason}</small>}
  </span>
}
