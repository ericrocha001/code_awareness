import React, { useEffect, useRef, useState } from 'react'
import type { ObservableWorktree, OrchestrationContext } from '../../../../shared/types/work-orchestration-types'
import type { WorktreeTimelinePage, IntegrationEvidence, CommitNavigationIntent } from '../../../../shared/types/worktree-integration-evidence-types'

export function WorktreeIntegrationDetails({ tree, context, active = true, onCommit }: { tree: ObservableWorktree; context: OrchestrationContext; active?: boolean; onCommit?: (intent: CommitNavigationIntent) => void }) {
  const [page, setPage] = useState<WorktreeTimelinePage | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [target, setTarget] = useState(''), [evidence, setEvidence] = useState<IntegrationEvidence | null>(null), [evaluationError, setEvaluationError] = useState(''), [evaluating, setEvaluating] = useState(false)
  const [lastKnown, setLastKnown] = useState(false)
  const epoch = useRef(0), assessment = useRef(0)
  const pending = useRef(new Map<string, ReturnType<typeof window.codeAwareness.getWorkOrchestration>>())
  const load = async (cursor?: string) => {
    const request = ++epoch.current
    setBusy(true); setError(''); setLastKnown(false)
    try {
      const query = { context, timeline: { worktreeId: tree.worktreeId, generation: tree.generation, limit: 20, cursor } }, key = JSON.stringify(query)
      let promise = pending.current.get(key)
      if (!promise) { promise = window.codeAwareness.getWorkOrchestration(query).finally(() => pending.current.delete(key)); pending.current.set(key, promise) }
      const result = await promise
      if (epoch.current !== request) return
      if (!result.success) throw new Error(result.code)
      if (!('timeline' in result.data)) throw new Error('TIMELINE_UNAVAILABLE')
      const next = result.data.timeline
      setPage(previous => cursor && previous?.revision === next.revision ? { ...next, items: [...previous.items, ...next.items] } : next)
    } catch (failure) { if (epoch.current === request) { setPage(null); setError(`Histórico indisponível ou obsoleto: ${failure instanceof Error ? failure.message : 'erro de leitura'}`) } }
    finally { if (epoch.current === request) setBusy(false) }
  }
  useEffect(() => { setPage(null); setEvidence(null); if (active) void load(); return () => { epoch.current++; assessment.current++ } }, [tree.worktreeId, tree.generation, tree.head, context.projectId, context.revision])
  useEffect(() => { if (!active) { epoch.current++; assessment.current++; setBusy(false); setEvaluating(false); setLastKnown(true) } }, [active])
  const evaluate = async (event: React.FormEvent) => {
    event.preventDefault()
    const request = ++assessment.current
    setEvaluating(true); setEvaluationError(''); setEvidence(null)
    try {
      const result = await window.codeAwareness.getWorkOrchestration({ context, integration: { worktreeId: tree.worktreeId, generation: tree.generation, targetBranch: target } })
      if (assessment.current !== request) return
      if (!result.success) throw new Error(result.code)
      if (!('state' in result.data) || !('nextAction' in result.data)) throw new Error('INTEGRATION_EVIDENCE_UNAVAILABLE')
      setEvidence(result.data)
    } catch (failure) { if (assessment.current === request) setEvaluationError(`Avaliação indisponível: ${failure instanceof Error ? failure.message : 'erro de leitura'}`) }
    finally { if (assessment.current === request) setEvaluating(false) }
  }
  return <>
    <section aria-label="Histórico de commits da worktree"><h3>Histórico alcançável pelo HEAD</h3><p>Data do commit (committer date). Não indica criação da worktree ou autoria nela.</p>
      {error && <p role="alert">{error}</p>}
      {lastKnown && <p>Última consulta conhecida. Atualize o histórico e avalie novamente antes de decidir.</p>}
      <ol>{page?.items.map(item => <li key={item.sha}><button onClick={() => onCommit?.({ ...context, commitSha: item.sha, requestId: crypto.randomUUID() })} disabled={!onCommit}>{item.title || 'Sem título'} · {item.sha.slice(0, 8)}{item.relation === 'HEAD_EXACT' ? ' · HEAD' : ''}</button><br /><time dateTime={item.committerDate}>{new Date(item.committerDate).toLocaleString('pt-BR')}</time></li>)}</ol>
      {page && <p>{page.coverage === 'PARTIAL' ? 'Cobertura parcial — há mais histórico.' : page.items.length ? 'Página final do histórico.' : 'Nenhum commit nesta consulta verificada.'}</p>}
      {busy && <p role="status">Carregando commits…</p>}
      {page?.nextCursor && <button disabled={busy} onClick={() => void load(page.nextCursor!)}>Carregar mais commits</button>}
      <button disabled={busy} onClick={() => void load()}>Atualizar histórico</button>
    </section>
    <section aria-label="Evidências de integração"><h3>Evidências de integração</h3><form onSubmit={evaluate}><label>Branch de destino<input value={target} onChange={event => { assessment.current++; setTarget(event.target.value); setEvidence(null); setEvaluating(false) }} placeholder="Escolha explicitamente a branch" required /></label><button disabled={!target.trim() || evaluating}>Avaliar integração</button></form>
      {evaluating && <p role="status">Avaliando origem e destino…</p>}{evaluationError && <p role="alert">{evaluationError}</p>}
      {evidence && <><p role="status">{({ BLOCKED: 'Bloqueada', EVIDENCE_PENDING: 'Evidências pendentes', ELIGIBLE_FOR_REVIEW: 'Elegível para revisão', STALE: 'Obsoleta — avalie novamente' })[evidence.state]}</p><p>Origem {evidence.source.head?.slice(0, 8) ?? 'sem HEAD'} → {evidence.target.branch} · {evidence.target.head.slice(0, 8)} · {evidence.mode}</p><p>{evidence.nextAction}</p><p>{evidence.compatibility === 'MERGE_COMPATIBILITY_NOT_VERIFIED' ? 'Compatibilidade de merge não verificada.' : evidence.compatibility === 'FAST_FORWARD_VERIFIED' ? 'Ancestralidade de fast-forward verificada; não autoriza integração.' : 'Candidata verificada; revisão ainda necessária.'}</p><details><summary>Impedimentos, provas e cobertura</summary><ul>{[...evidence.blockers, ...evidence.missing].map(reason => <li key={reason}>{reason}</li>)}</ul><p>Cobertura dos commits exclusivos: {evidence.coverage}</p><p>Provas atuais: {evidence.proofs.filter(p => p.freshness === 'CURRENT').length}. Sem requisitos explícitos, a validação permanece pendente.</p><p>Captura: {new Date(evidence.observedAt).toLocaleString('pt-BR')}</p></details></>}
    </section>
  </>
}
