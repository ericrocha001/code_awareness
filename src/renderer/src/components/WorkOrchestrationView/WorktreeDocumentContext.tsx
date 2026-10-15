import React, { useEffect, useRef, useState } from 'react'
import { FileText } from 'lucide-react'
import { WorktreeSectionTitle } from './WorktreeSectionTitle'
import type { ObservableWorktree, OrchestrationData, OrchestrationRequest, OrchestrationResult } from '../../../../shared/types/work-orchestration-types'
import type { WorktreeDocumentContext as Context, WorktreeDocumentRequest } from '../../../../shared/types/worktree-document-context-types'

type Query = (extra: Pick<OrchestrationRequest, 'documents'>) => Promise<OrchestrationResult<OrchestrationData>>
const modeLabel = { EXACT: 'Associação declarada', HISTORICAL: 'Referência histórica por caminho — não comprovada', RELATED: 'Contexto relacionado — vínculo documental indireto' }
export function WorktreeDocumentContext({ tree, query }: { tree: ObservableWorktree; query: Query }) {
  const [data, setData] = useState<Context | null>(null), [related, setRelated] = useState<Context | null>(null)
  const [error, setError] = useState(''), [loading, setLoading] = useState(false)
  const sequence = useRef(0), busy = useRef(false), consulted = useRef(false)
  const panel = useRef<HTMLDetailsElement>(null)
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined])
  useEffect(() => { sequence.current++; busy.current = false; consulted.current = false; if (panel.current) panel.current.open = false; setData(null); setRelated(null); setError(''); setLoading(false); setCursors([undefined]);
    return () => { sequence.current++ }
  }, [tree.worktreeId, tree.generation, query])
  const read = async (extra: Pick<WorktreeDocumentRequest, 'mode' | 'artifactId' | 'cursor'>) => {
    if (busy.current) return
    const ticket = ++sequence.current
    busy.current = true; consulted.current = true; setLoading(true); setError('')
    try {
      const result = await query({ documents: { worktreeId: tree.worktreeId, generation: tree.generation, ...extra } })
      if (sequence.current !== ticket) return
      if (!result.success) throw new Error(result.code)
      if (!('queriedAt' in result.data) || result.data.worktreeId !== tree.worktreeId || result.data.generation !== tree.generation) throw new Error('WORKTREE_STALE')
      if (extra.mode === 'RELATED') setRelated(result.data)
      else { setData(result.data); setRelated(null) }
    } catch (failure) { if (sequence.current === ticket) setError(failure instanceof Error ? failure.message : 'CONTINUUM_UNAVAILABLE') }
    finally { if (sequence.current === ticket) { busy.current = false; setLoading(false) } }
  }
  const show = (context: Context) => <section aria-label={modeLabel[context.mode]}>
    <h4>{modeLabel[context.mode]}</h4><p>Última consulta: {new Date(context.queriedAt).toLocaleString('pt-BR')}</p>
    {context.mode === 'HISTORICAL' && <p>Correspondência literal do caminho. Esta referência não comprova vínculo com a identidade atual.</p>}
    {context.mode === 'RELATED' && <p>Origem da relação: {context.sourceArtifactId}</p>}
    {!context.artifacts.length && <p>{context.mode === 'EXACT' ? context.coverage === 'COMPLETE' ? 'Sem vínculo explícito encontrado. Isso não significa ausência de trabalho.' : 'Nenhum vínculo nesta página. A consulta tem cobertura parcial.' : 'Nenhum documento relacionado encontrado nesta consulta.'}</p>}
    <ul className="wo-document-list">{context.artifacts.map(artifact => <li key={artifact.artifactId}>
      <strong>{artifact.name}</strong>{artifact.description && <p>{artifact.description}</p>}
      <p>Tipo: {artifact.kind} · Estado documental: {artifact.status ?? 'Não informado'}</p>
      <p>Data registrada: {new Date(artifact.updatedAt).toLocaleString('pt-BR')}</p>
      <label>ID do Artifact<input aria-label={`ID do Artifact ${artifact.name}`} value={artifact.artifactId} readOnly onFocus={event => event.currentTarget.select()} /></label>
      {artifact.executionId && <p>Execução documentada: {artifact.executionId}</p>}
      {context.mode === 'EXACT' && <button disabled={loading} onClick={() => void read({ mode: 'RELATED', artifactId: artifact.artifactId })}>Ver Plano e handoff relacionados</button>}
      {context.relations.filter(edge => edge.sourceId === artifact.artifactId || edge.targetId === artifact.artifactId).map(edge => <p key={`${edge.sourceId}:${edge.targetId}:${edge.kind}`}>Relação declarada: {edge.sourceId} → {edge.targetId} ({edge.kind})</p>)}
    </li>)}</ul>
    {context.coverage === 'PARTIAL' && <p>Cobertura parcial · consulte o Continuum para aprofundar.</p>}
  </section>
  return <details ref={panel} className="wo-document-context wo-disclosure" onToggle={event => { if (event.target === event.currentTarget && event.currentTarget.open && !consulted.current) void read({ mode: 'EXACT' }) }}>
    <summary><WorktreeSectionTitle icon={FileText} meta={data ? `${data.artifacts.length} nesta página` : 'Sob demanda'}>Contexto documentado</WorktreeSectionTitle></summary>
    <p>Associação documental não comprova atividade de agente, tarefa atual nem integração Git.</p>
    {!consulted.current && <p>Não consultado</p>}
    {loading && <p role="status">Consultando o Continuum…</p>}
    {error && <p className="wo-warning" role="alert">Consulta indisponível ou obsoleta ({error}).{data && ' Exibindo a última consulta, não revalidada.'}</p>}
    <div className="wo-document-actions"><button disabled={loading || tree.missing || tree.prunable} onClick={() => { setCursors([undefined]); void read({ mode: 'EXACT' }) }}>{data ? 'Atualizar vínculos' : 'Consultar vínculos'}</button>
      <button disabled={loading || tree.missing || tree.prunable} onClick={() => { setCursors([undefined]); void read({ mode: 'HISTORICAL' }) }}>Consultar referências históricas por caminho</button></div>
    {data && show(data)}{related && show(related)}
    {data && cursors.length > 1 && <button disabled={loading} onClick={() => { const previous = cursors.slice(0, -1); setCursors(previous); void read({ mode: data.mode, cursor: previous[previous.length - 1] }) }}>Página anterior de documentos</button>}
    {data?.nextCursor && <button disabled={loading} onClick={() => { setCursors([...cursors, data.nextCursor]); void read({ mode: data.mode, cursor: data.nextCursor }) }}>Próxima página de documentos</button>}
  </details>
}
