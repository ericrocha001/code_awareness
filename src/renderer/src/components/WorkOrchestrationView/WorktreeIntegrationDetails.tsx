import { WorktreeCommitsDisclosure } from './WorktreeCommitsDisclosure'
import React, { useEffect, useRef, useState } from 'react'
import { GitPullRequest } from 'lucide-react'
import { WorktreeSectionTitle } from './WorktreeSectionTitle'
import type { ObservableWorktree, OrchestrationContext } from '../../../../shared/types/work-orchestration-types'
import type { IntegrationEvidence } from '../../../../shared/types/worktree-integration-evidence-types'

export function WorktreeIntegrationDetails({ tree, context, active = true, children }: { tree: ObservableWorktree; context: OrchestrationContext; active?: boolean; children?: React.ReactNode }) {
  const [target, setTarget] = useState(''), [evidence, setEvidence] = useState<IntegrationEvidence | null>(null), [evaluationError, setEvaluationError] = useState(''), [evaluating, setEvaluating] = useState(false)
  const assessment = useRef(0)
  useEffect(() => { assessment.current++; setEvidence(null); setEvaluating(false); return () => { assessment.current++ } }, [tree.worktreeId, tree.generation, tree.head, context.projectId, context.revision, active])
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
    <WorktreeCommitsDisclosure tree={tree} context={context} active={active} />
    {children}
    <details className="wo-integration wo-disclosure"><summary><WorktreeSectionTitle icon={GitPullRequest}>Integração</WorktreeSectionTitle></summary><section aria-label="Evidências de integração"><h3>Evidências de integração</h3><form onSubmit={evaluate}><label>Branch de destino<input value={target} onChange={event => { assessment.current++; setTarget(event.target.value); setEvidence(null); setEvaluating(false) }} placeholder="Escolha explicitamente a branch" required /></label><button disabled={!target.trim() || evaluating}>Avaliar integração</button></form>
      {evaluating && <p role="status">Avaliando origem e destino…</p>}{evaluationError && <p role="alert">{evaluationError}</p>}
      {evidence && <><p role="status">{({ BLOCKED: 'Bloqueada', EVIDENCE_PENDING: 'Evidências pendentes', ELIGIBLE_FOR_REVIEW: 'Elegível para revisão', STALE: 'Obsoleta — avalie novamente' })[evidence.state]}</p><p>Origem {evidence.source.head?.slice(0, 8) ?? 'sem HEAD'} → {evidence.target.branch} · {evidence.target.head.slice(0, 8)} · {evidence.mode}</p><p>{evidence.nextAction}</p><p>{evidence.compatibility === 'MERGE_COMPATIBILITY_NOT_VERIFIED' ? 'Compatibilidade de merge não verificada.' : evidence.compatibility === 'FAST_FORWARD_VERIFIED' ? 'Ancestralidade de fast-forward verificada; não autoriza integração.' : 'Candidata verificada; revisão ainda necessária.'}</p><details><summary>Impedimentos, provas e cobertura</summary><ul>{[...evidence.blockers, ...evidence.missing].map(reason => <li key={reason}>{reason}</li>)}</ul><p>Cobertura dos commits exclusivos: {evidence.coverage}</p><p>Provas atuais: {evidence.proofs.filter(p => p.freshness === 'CURRENT').length}. Sem requisitos explícitos, a validação permanece pendente.</p><p>Captura: {new Date(evidence.observedAt).toLocaleString('pt-BR')}</p></details></>}
    </section></details>
  </>
}
