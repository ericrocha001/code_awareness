import React, { useEffect, useState } from 'react'
import type { GitAtlasCoreEvidence, GitAtlasPrEvidence } from '../../../../shared/types/git-atlas-evidence-types'
import type { GitAtlasWindow } from '../../../../shared/types/git-atlas-types'
import type { GitManagementContext } from '../../../../shared/types/git-management-types'
import type { GitSelection } from './GitInspector'

export function AtlasCheckout({ core, context, windowDays, base, inspect }: {
  core: GitAtlasCoreEvidence | null; context: GitManagementContext; windowDays: GitAtlasWindow; base: string; inspect: (sha: string) => void
}) {
  const [reference, setReference] = useState('')
  const [checkout, setCheckout] = useState<GitAtlasCoreEvidence['checkout'] | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  useEffect(() => { setReference(''); setCheckout(null); setError('') }, [core?.gitSnapshot, context])
  useEffect(() => {
    let current = true
    setCheckout(null); setError(''); setLoading(false)
    if (!core || !reference) return
    setLoading(true)
    window.codeAwareness.getGitAtlasCore({ context, window: windowDays, limit: 1, comparisonRef: reference }).then(result => {
      if (!current) return
      if (result.success && result.data.repositoryId === core.repositoryId && result.data.gitSnapshot === core.gitSnapshot && result.data.worktreeId === core.worktreeId && result.data.worktreeGeneration === core.worktreeGeneration) setCheckout(result.data.checkout)
      else setError(result.success ? 'A revisão mudou; atualize o Atlas.' : result.code)
    }).catch(() => { if (current) setError('Comparação indisponível') }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [core, context, windowDays, reference])
  if (!core) return null
  const upstream = core.git.refs.find(ref => ref.ref === core.checkout.upstream || ref.name === core.checkout.upstream)?.ref
  const choices = [...new Set([upstream, base].filter((value): value is string => !!value))]
  return <div className="gm-checkout-context">
    <button disabled={!core.checkout.head} onClick={() => core.checkout.head && inspect(core.checkout.head)}><span className="gm-head-icon" />Você está aqui · {core.checkout.ref?.replace('refs/heads/', '') ?? (core.checkout.detached ? 'HEAD detached' : 'sem commits')} · {core.checkout.head?.slice(0, 8) ?? 'HEAD não criado'}</button>
    <label>Comparar HEAD<select aria-label="Comparar checkout com referência" value={reference} onChange={event => setReference(event.target.value)}><option value="">Sem comparação</option>{choices.map(ref => <option key={ref} value={ref}>{ref.replace(/^refs\/(heads|remotes)\//, '')}</option>)}</select></label>
    {loading ? <span role="status">Comparando…</span> : error ? <span role="status">{error}</span> : checkout && <span className={checkout.relation === 'DIVERGED' ? 'gm-checkout-diverged' : ''}>{checkout.relation === 'EQUAL' ? 'Mesmo commit' : checkout.relation === 'UNRELATED' ? 'Sem ancestral comum' : checkout.relation === 'UNKNOWN' ? 'Relação desconhecida' : `${checkout.ahead} à frente · ${checkout.behind} atrás`}</span>}
    {checkout?.comparisonSource === 'LOCAL_REMOTE_TRACKING' && <small>Comparação com referência remota local; pode estar desatualizada.</small>}
  </div>
}

export function AtlasPullRequests({ evidence, selection, selectedPr, choose }: {
  evidence: GitAtlasPrEvidence | null; selection: GitSelection; selectedPr: number | null; choose: (number: number) => void
}) {
  if (!evidence) return <p className="gm-comparison-note">PRs ainda não consultados.</p>
  const branches = evidence.branches
  const relations = branches?.relations.filter(relation => relation.classification === 'CONFIRMED_CURRENT' || relation.classification === 'CONFIRMED_HISTORICAL') ?? []
  const contextual = new Set<number>()
  if (selection?.kind === 'BRANCH') {
    for (const relation of relations) if (relation.ref === selection.ref.ref) contextual.add(relation.pullRequest.number)
    for (const relation of branches?.received ?? []) if ('refs/heads/' + relation.pullRequest.base.ref === selection.ref.ref) contextual.add(relation.pullRequest.number)
  } else if (selection?.kind === 'COMMIT') {
    for (const pr of evidence.pullRequests) if (pr.lifecycle === 'MERGED' && pr.record.mergeCommit === selection.sha) contextual.add(pr.record.number)
    for (const relation of relations) if ((relation.classification === 'CONFIRMED_CURRENT' && relation.head === selection.sha) || relation.historicalEvidence?.sha === selection.sha) contextual.add(relation.pullRequest.number)
  }
  const chosen = evidence.pullRequests.find(pr => pr.record.number === selectedPr)
  const items = selectedPr !== null ? chosen ? [chosen] : [] : evidence.pullRequests.filter(pr => contextual.has(pr.record.number))
  return <section className="gm-inspector-section gm-pr-context">
    <h3>{selectedPr !== null ? `Pull Request #${selectedPr}` : 'PRs neste contexto'}</h3>
    {evidence.coverage !== 'COMPLETE' && <p className="gm-comparison-note">{evidence.coverage === 'UNAVAILABLE' ? 'GitHub indisponível; o histórico Git continua disponível.' : 'Catálogo parcial; ausência de PR não comprova inexistência.'}</p>}
    {items.map(({ record, lifecycle }) => {
      const integration = evidence.events.find(event => event.kind === 'PR_MERGED' && event.prNumber === record.number)
      const sourceLinks = relations.filter(relation => relation.pullRequest.number === record.number)
      const received = branches?.received.some(relation => relation.pullRequest.number === record.number)
      return <article key={record.id}>
        <button onClick={() => choose(record.number)}>#{record.number} · {record.title}</button>
        <p>{lifecycle === 'OPEN' ? record.draft ? 'Aberto · rascunho' : 'Aberto' : lifecycle === 'CLOSED_UNMERGED' ? 'Fechado sem merge' : 'Integrado'} · destino declarado: {record.base.ref}</p>
        <small>Criado: {new Date(record.createdAt).toLocaleString()}{record.mergedAt && <> · integrado: {new Date(record.mergedAt).toLocaleString()}</>}</small>
        {integration?.kind === 'PR_MERGED' && <p>{integration.integrationMethod === 'MERGE_COMMIT' ? 'Merge commit · SHA e topologia conferidos' : 'PR integrado · método não identificado'}</p>}
        <p>{sourceLinks.map(relation => relation.classification === 'CONFIRMED_CURRENT' ? 'Vínculo atual confirmado' : 'Vínculo histórico confirmado').join(' · ')}{received ? ' · destino declarado confirmado' : ''}</p>
        <small>Fonte: GitHub · observado {new Date(evidence.observedAt).toLocaleString()}. Inclusão no HEAD local e intervalo continuamente aberto: desconhecidos.</small>
        <p><a href={/^https:\/\/github\.com\//i.test(record.url) ? record.url : undefined} target="_blank" rel="noreferrer">Abrir no GitHub</a></p>
      </article>
    })}
    {!items.length && <p className="gm-comparison-note">{selectedPr !== null ? 'PR não disponível nesta revisão.' : 'Nenhuma associação comprovada para esta seleção no catálogo consultado.'}</p>}
  </section>
}
