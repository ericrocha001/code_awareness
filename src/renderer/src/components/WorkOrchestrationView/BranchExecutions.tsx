import React, { useEffect, useRef, useState } from 'react'
import type { BranchRecord } from '../../../../shared/types/branch-orchestration-types'
import type { BranchManagerData, BranchManagerOperation } from '../../../../shared/types/branch-manager-types'
import type { ExecutionBinding, ExecutionBindingPage, ExecutionDocumentPage } from '../../../../shared/types/execution-branch-types'

const labels = { VERIFIED_CURRENT: 'Vínculo corrente verificado', HISTORICAL: 'Vínculo histórico', DECLARED_UNVERIFIED: 'Declaração não verificada', STALE: 'Identidade precisa de revalidação', UNAVAILABLE: 'Verificação indisponível', AMBIGUOUS: 'Associação ambígua' }
export interface ArtifactNavigation { repositoryId: string; artifactId: string }
interface ExecutionView { scope: string; bindings: ExecutionBindingPage | null; documents: ExecutionDocumentPage | null; execution: ExecutionBinding | null; error: string; loading: boolean }
interface ExecutionReader { documents(binding: ExecutionBinding, cursor?: string): void; bindings(cursor: string): void }
export function BranchExecutions({ branch, active, query, onArtifact }: { branch: BranchRecord; active: boolean; query: (op: BranchManagerOperation) => Promise<BranchManagerData>; onArtifact?: (intent: ArtifactNavigation) => void }) {
  const scope = JSON.stringify([branch.repositoryId, branch.ref, branch.revision, branch.generation])
  const [view, setView] = useState<ExecutionView>({ scope, bindings: null, documents: null, execution: null, error: '', loading: active })
  const reader = useRef<ExecutionReader | null>(null)
  const selection = useRef<{ scope: string; query: typeof query; binding: ExecutionBinding } | null>(null)
  useEffect(() => {
    const empty = { scope, bindings: null, documents: null, execution: null, error: '', loading: active }
    setView(empty)
    if (!active) return
    let disposed = false, running = false, version = 0, dirtyBindings = true
    let bindingCursor: string | undefined, documentCursor: string | undefined
    let selected = selection.current?.scope === scope && selection.current.query === query ? selection.current.binding : null
    let bindings: ExecutionBindingPage | null = null
    const drain = async () => {
      if (running) return
      running = true
      try {
        while (!disposed) {
          const ticket = version, execution = selected
          try {
            let nextBindings = bindings
            if (dirtyBindings) {
              const data = await query({ action: 'EXECUTIONS', ref: branch.ref, revision: branch.revision, ...(bindingCursor ? { cursor: bindingCursor } : {}) })
              if (disposed) return
              if (ticket !== version) continue
              if (data.kind !== 'EXECUTIONS' || data.page.repositoryId !== branch.repositoryId || data.page.branchRef !== branch.ref || data.page.branchRevision !== branch.revision) throw new Error('EXECUTION_CONTEXT_CHANGED')
              nextBindings = data.page
            }
            let documents: ExecutionDocumentPage | null = null
            if (execution) {
              const data = await query({ action: 'EXECUTION_DOCUMENTS', ref: branch.ref, revision: branch.revision, bindingId: execution.artifactId, executionId: execution.executionId, ...(documentCursor ? { cursor: documentCursor } : {}) })
              if (disposed) return
              if (ticket !== version) continue
              if (data.kind !== 'EXECUTION_DOCUMENTS' || data.page.repositoryId !== branch.repositoryId || data.page.executionId !== execution.executionId) throw new Error('EXECUTION_CONTEXT_CHANGED')
              documents = data.page
            }
            bindings = nextBindings; dirtyBindings = false
            setView({ scope, bindings, documents, execution, loading: false, error: '' })
          } catch (failure) {
            if (disposed) return
            if (ticket !== version) continue
            dirtyBindings = true
            setView({ ...empty, loading: false, error: failure instanceof Error ? failure.message : 'CONTINUUM_UNAVAILABLE' })
          }
          return
        }
      } finally { running = false }
    }
    const schedule = () => {
      version++
      setView(previous => previous.scope === scope ? { ...previous, error: '', loading: true } : { ...empty, loading: true })
      void drain()
    }
    const controls: ExecutionReader = {
      documents: (binding, cursor) => { selected = binding; selection.current = { scope, query, binding }; documentCursor = cursor; schedule() },
      bindings: cursor => { bindingCursor = cursor; selected = null; selection.current = null; documentCursor = undefined; dirtyBindings = true; schedule() }
    }
    reader.current = controls
    const unsubscribe = window.codeAwareness.onContinuumChanged(change => {
      if (disposed || change.repositoryId !== branch.repositoryId) return
      bindingCursor = undefined; documentCursor = undefined; dirtyBindings = true; schedule()
    })
    schedule()
    return () => { disposed = true; unsubscribe(); if (reader.current === controls) reader.current = null }
  }, [scope, active, query])
  const current = view.scope === scope && active ? view : null
  const { bindings, documents, execution, error, loading } = current ?? { bindings: null, documents: null, execution: null, error: '', loading: active }
  return <section className="bm-executions" aria-label="Execuções do Continuum" aria-busy={loading}>
    <h3>Execuções do Continuum</h3>
    <p>Declarações vinculadas à instância Git. Não comprovam atividade, autoria ou conclusão.</p>
    {loading && <p role="status">Consultando o Continuum…</p>}
    {!active && <p>Consulta precisa de atualização.</p>}
    {error && <p role="alert">Consulta indisponível ou obsoleta ({error}). Não é possível concluir ausência de vínculos.</p>}
    {bindings && <>
      {!loading && !bindings.bindings.length && <p>{bindings.coverage === 'COMPLETE' ? 'Sem vínculo explícito encontrado. Isso não significa ausência de trabalho ou documentos.' : 'Nenhum vínculo nesta página; cobertura parcial.'}</p>}
      <ul className="wo-document-list">{bindings.bindings.map(binding => <li key={binding.artifactId}><strong>{binding.executionId}</strong><p>{loading ? 'Consulta em atualização — vínculo ainda não revalidado' : labels[binding.classification]}</p>
        <small>HEAD no registro: {binding.sourceHeadAtBinding.slice(0, 8)} · checkout {binding.checkout === 'CURRENT' ? 'verificado' : binding.checkout === 'HISTORICAL' ? 'histórico' : 'não verificado'}</small>
        <button aria-disabled={loading} onClick={() => { if (!loading) reader.current?.documents(binding) }}>Ver Artifacts desta execução</button></li>)}</ul>
      {bindings.nextCursor && <button aria-disabled={loading} onClick={() => { if (!loading) reader.current?.bindings(bindings.nextCursor!) }}>Próxima página de execuções</button>}
    </>}
    {documents && execution && <section aria-label="Artifacts da execução"><h4>{execution.executionId}</h4><ul className="wo-document-list">{documents.artifacts.map(artifact => <li key={artifact.artifactId}>
      <strong>{artifact.name}</strong><p>{artifact.kind} · Estado documental: {artifact.status ?? 'Não informado'}</p>
      <button disabled={!onArtifact} aria-disabled={loading} onClick={() => { if (!loading) onArtifact?.({ repositoryId: documents.repositoryId, artifactId: artifact.artifactId }) }}>Abrir no Continuum</button>
    </li>)}</ul>{documents.nextCursor && <button aria-disabled={loading} onClick={() => { if (!loading) reader.current?.documents(execution, documents.nextCursor) }}>Próxima página de Artifacts</button>}</section>}
  </section>
}
