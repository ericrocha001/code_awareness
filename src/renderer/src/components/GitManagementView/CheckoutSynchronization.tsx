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

export function CheckoutSynchronization({ value, loading, error, blocked, verify, act, fetchRemote }: {
  value: GitCheckoutSynchronization | null; loading: boolean; error: string; blocked: boolean
  verify: () => void; act: (value: GitCheckoutSynchronization) => void
  fetchRemote?: () => void
}) {
  if (loading && !value) return <span className="gm-checkout-sync" role="status">Verificando remoto…</span>
  const evidence = value?.evidence
  if (!evidence || evidence.status !== 'VERIFIED') return <span className="gm-checkout-sync">
    <span role="status">{error || (evidence?.status === 'UNAVAILABLE' ? `Não foi possível verificar: ${unavailableReason[evidence.reason]}.` : 'Estado local do último fetch; remoto ainda não verificado.')}</span>
    {value?.blockedReason && <small>{value.blockedReason}</small>}
    <button disabled={blocked} onClick={verify}>Verificar remoto</button>
    {fetchRemote && <button disabled={blocked} onClick={fetchRemote}>Buscar atualizações — Fetch</button>}
  </span>
  const upstream = `${evidence.remote}/${evidence.ref.replace('refs/heads/', '')}`
  const partial = evidence.relationship !== 'IN_SYNC' && (evidence.tracking === 'TRACKING_STALE' || !evidence.remoteCounts || evidence.relationship === 'UNKNOWN')
  const counts = evidence.remoteCounts
  const label = evidence.relationship === 'IN_SYNC' ? `Atualizada com ${upstream}`
    : partial ? `Remoto alterado em ${upstream}; contagem ainda não verificada`
      : evidence.relationship === 'BEHIND' ? `${counts!.behind} ${counts!.behind === 1 ? 'commit' : 'commits'} atrás de ${upstream}`
        : evidence.relationship === 'AHEAD' ? `${counts!.ahead} ${counts!.ahead === 1 ? 'commit' : 'commits'} à frente de ${upstream}`
          : `${counts!.ahead} à frente · ${counts!.behind} atrás de ${upstream}; históricos divergentes`
  const actionLabel = value.action === 'PULL_FF_ONLY' ? 'Atualizar — Pull FF-only'
    : value.action === 'FETCH' ? 'Buscar atualizações — Fetch'
      : value.action === 'PUSH' ? 'Publicar — Push'
      : value.action === 'COMPARE' ? 'Inspecionar divergência' : 'Revisar publicação'
  return <span className="gm-checkout-sync">
    <span role="status">{label} <small>(verificado às {new Date(evidence.observedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})</small></span>
    {value.action && <button disabled={blocked} onClick={() => act(value)}>{actionLabel}</button>}
    {value.action !== 'FETCH' && fetchRemote && value.automaticFetch !== 'PENDING' && <button disabled={blocked} onClick={fetchRemote}>Buscar atualizações — Fetch</button>}
    {value.action === 'PULL_FF_ONLY' && <small>{value.state.branch}: os arquivos do checkout avançarão até {upstream}, somente por fast-forward.</small>}
    {value.action === 'PUSH' && <small>Publicar {counts?.ahead} {counts?.ahead === 1 ? 'commit' : 'commits'} de {value.state.branch} em {upstream}, sem force.</small>}
    {value.action && blocked && <small>Aguarde a leitura ou recupere a operação Git pendente junto à ação.</small>}
    {value.blockedReason && <small>{value.blockedReason}</small>}
    {value.automaticFetch === 'FAILED' && <small>O fetch automático falhou. Use Fetch para tentar novamente.</small>}
    {value.automaticFetch === 'PENDING' && <button disabled={loading || !!value.state.operation} onClick={verify}>Recuperar fetch automático</button>}
  </span>
}
