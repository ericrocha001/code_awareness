import React, { useEffect, useRef, useState } from 'react'
import type { BranchRecord } from '../../../../shared/types/branch-orchestration-types'
import type { BranchManagerData, BranchManagerOperation } from '../../../../shared/types/branch-manager-types'
import type { ExecutionBinding, ExecutionBindingPage, ExecutionDocumentPage } from '../../../../shared/types/execution-branch-types'

const labels = { VERIFIED_CURRENT: 'Vínculo corrente verificado', HISTORICAL: 'Vínculo histórico', DECLARED_UNVERIFIED: 'Declaração não verificada', STALE: 'Identidade precisa de revalidação', UNAVAILABLE: 'Verificação indisponível', AMBIGUOUS: 'Associação ambígua' }
export interface ArtifactNavigation { repositoryId: string; artifactId: string }
export function BranchExecutions({ branch, active, query, onArtifact }: { branch: BranchRecord; active: boolean; query: (op: BranchManagerOperation) => Promise<BranchManagerData>; onArtifact?: (intent: ArtifactNavigation) => void }) {
  const [bindings, setBindings] = useState<ExecutionBindingPage | null>(null), [documents, setDocuments] = useState<ExecutionDocumentPage | null>(null)
  const [execution, setExecution] = useState<ExecutionBinding | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(false)
  const sequence = useRef(0), consulted = useRef(false), panel = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    sequence.current++; consulted.current = false; setBindings(null); setDocuments(null); setExecution(null); setError(''); setLoading(false)
    if (panel.current) panel.current.open = false
    return () => { sequence.current++ }
  }, [branch.ref, branch.revision, active, query])
  const read = async (selected?: ExecutionBinding, cursor?: string) => {
    if (!active) return
    const ticket = ++sequence.current
    consulted.current = true; setLoading(true); setError('')
    try {
      const data = await query(selected ? { action: 'EXECUTION_DOCUMENTS', ref: branch.ref, revision: branch.revision, bindingId: selected.artifactId, executionId: selected.executionId, cursor } : { action: 'EXECUTIONS', ref: branch.ref, revision: branch.revision, cursor })
      if (ticket !== sequence.current) return
      if (data.kind === 'EXECUTIONS' && data.page.repositoryId === branch.repositoryId && data.page.branchRevision === branch.revision) {
        setBindings(data.page); setDocuments(null); setExecution(null)
      } else if (selected && data.kind === 'EXECUTION_DOCUMENTS' && data.page.repositoryId === branch.repositoryId && data.page.executionId === selected.executionId) {
        setDocuments(data.page); setExecution(selected)
      } else throw new Error('EXECUTION_CONTEXT_CHANGED')
    } catch (failure) { if (ticket === sequence.current) { setBindings(null); setDocuments(null); setError(failure instanceof Error ? failure.message : 'CONTINUUM_UNAVAILABLE') } }
    finally { if (ticket === sequence.current) setLoading(false) }
  }
  return <details ref={panel} className="wo-disclosure bm-executions" onToggle={event => { if (event.target === event.currentTarget && event.currentTarget.open && !consulted.current) void read() }}>
    <summary>Execuções do Continuum</summary>
    <p>Declarações vinculadas à instância Git. Não comprovam atividade, autoria ou conclusão.</p>
    {loading && <p role="status">Consultando o Continuum…</p>}
    {!active && <p>Consulta precisa de atualização.</p>}
    {error && <p role="alert">Consulta indisponível ou obsoleta ({error}). Não é possível concluir ausência de vínculos.</p>}
    <button disabled={loading || !active} onClick={() => void read()}>Atualizar execuções</button>
    {bindings && <>
      {!bindings.bindings.length && <p>{bindings.coverage === 'COMPLETE' ? 'Sem vínculo explícito encontrado. Isso não significa ausência de trabalho ou documentos.' : 'Nenhum vínculo nesta página; cobertura parcial.'}</p>}
      <ul className="wo-document-list">{bindings.bindings.map(binding => <li key={binding.artifactId}><strong>{binding.executionId}</strong><p>{active ? labels[binding.classification] : 'Consulta obsoleta'}</p>
        <small>HEAD no registro: {binding.sourceHeadAtBinding.slice(0, 8)} · checkout {binding.checkout === 'CURRENT' ? 'verificado' : binding.checkout === 'HISTORICAL' ? 'histórico' : 'não verificado'}</small>
        <button disabled={loading || !active} onClick={() => void read(binding)}>Ver Artifacts desta execução</button></li>)}</ul>
      {bindings.nextCursor && <button disabled={loading || !active} onClick={() => void read(undefined, bindings.nextCursor)}>Próxima página de execuções</button>}
    </>}
    {documents && execution && <section aria-label="Artifacts da execução"><h4>{execution.executionId}</h4><ul className="wo-document-list">{documents.artifacts.map(artifact => <li key={artifact.artifactId}>
      <strong>{artifact.name}</strong><p>{artifact.kind} · Estado documental: {artifact.status ?? 'Não informado'}</p>
      <button disabled={!onArtifact || !active} onClick={() => onArtifact?.({ repositoryId: documents.repositoryId, artifactId: artifact.artifactId })}>Abrir no Continuum</button>
    </li>)}</ul>{documents.nextCursor && <button disabled={loading || !active} onClick={() => void read(execution, documents.nextCursor)}>Próxima página de Artifacts</button>}</section>}
  </details>
}
