import React, { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Copy, Download, Package, RefreshCw, X } from 'lucide-react'
import type { ContinuumBundlePreview, ContinuumBundleExport, ContinuumBundleSource } from '../../../../shared/types/continuum-bundle-types'

export function ContinuumBundleComposer({ repositoryId, slug, source, preferredIntent, onClose }: { repositoryId: string; slug?: string; source?: ContinuumBundleSource; preferredIntent?: 'copy' | 'zip'; onClose(): void }) {
  const [preview, setPreview] = useState<ContinuumBundlePreview | null>(null)
  const [order, setOrder] = useState<string[]>([]), [dirty, setDirty] = useState(false), [pending, setPending] = useState(false)
  const [error, setError] = useState(''), [message, setMessage] = useState('')
  const [budget, setBudget] = useState('')
  const generation = useRef(0), busy = useRef(false)
  const snapshot = useRef<string | null>(null)
  const sourceKey = JSON.stringify(source ?? { kind: 'tag', slug })
  const explicit = source?.kind === 'selection'
  const discard = (id: string | null) => { if (id) void window.codeAwareness.discardContinuumBundle?.(id).catch(() => {}) }
  const prepare = async (initial = false) => {
    if (busy.current) return
    const current = ++generation.current
    busy.current = true; setPending(true); setError(''); setMessage('')
    try {
      const selected = source?.kind === 'selection' ? (initial ? source.selected : order.map(id => source.selected.find(item => item.artifactId === id)!)) : null
      if (selected && !selected.length) throw new Error('BUNDLE_EMPTY: selecione ao menos um Artifact')
      const result = await window.codeAwareness.prepareContinuumBundle({ repositoryId, ...(selected ? { source: { kind: 'selection' as const, selected } } : source ? { source } : { slug: slug! }), ...(!initial ? { order } : {}) })
      if (current !== generation.current) { discard(result.snapshotId); return }
      if (result.repositoryId !== repositoryId || (!explicit && result.slug !== (source?.kind === 'tag' ? source.slug : slug))) throw new Error('BUNDLE_CONTEXT_CHANGED')
      snapshot.current = result.snapshotId
      setPreview(result); setOrder(result.members.map(member => member.artifactId)); setDirty(false)
    } catch (reason) { if (current === generation.current) { setError(String(reason)); setPreview(null) } }
    finally { busy.current = false; if (current === generation.current) setPending(false) }
  }
  useEffect(() => { prepare(true); return () => { generation.current++; discard(snapshot.current); snapshot.current = null } }, [repositoryId, sourceKey])
  useEffect(() => window.codeAwareness.onContinuumChanged?.(() => { generation.current++; discard(snapshot.current); snapshot.current = null; setDirty(true); setPending(false); setMessage(''); setError('BUNDLE_SNAPSHOT_STALE: regenere o pacote') }), [])
  const exportBundle = async (intent: ContinuumBundleExport['intent']) => {
    if (!preview || dirty || busy.current) return
    const current = generation.current
    busy.current = true; setPending(true); setError(''); setMessage('')
    try {
      const result = await window.codeAwareness.exportContinuumBundle({ repositoryId, snapshotId: preview.snapshotId, intent })
      if (current !== generation.current) return
      if (result.snapshotId !== preview.snapshotId) throw new Error('BUNDLE_CONTEXT_CHANGED')
      setMessage(result.outcome === 'cancelled' ? 'Salvamento cancelado.' : result.outcome === 'copied' ? 'Context Bundle copiado.' : 'Context Bundle salvo.')
    } catch (reason) { if (current === generation.current) { setError(String(reason)); setDirty(true) } }
    finally { busy.current = false; if (current === generation.current) setPending(false) }
  }
  const reorder = (index: number, direction: number) => { const next = [...order]; [next[index], next[index + direction]] = [next[index + direction], next[index]]; setOrder(next); setDirty(true); setMessage('') }
  const members = order.map(id => preview?.members.find(member => member.artifactId === id)).filter((member): member is NonNullable<typeof member> => !!member)
  return <section className="continuum-bundle-composer" role="dialog" aria-label="Context Bundle" aria-busy={pending}>
    <header><h2>Context Bundle · {preview?.tagName ?? (explicit ? 'Seleção avulsa' : slug)}</h2><button className="continuum-icon-button" aria-label="Fechar Context Bundle" title="Fechar Context Bundle" disabled={pending} onClick={onClose}><X size={16} /></button></header>
    <p>Fotografia documental para outra IA. O conteúdo pode ser histórico e não comprova o estado atual do código ou runtime.</p>
    <div className="continuum-export-actions">
      <button className="continuum-icon-button" aria-label="Regenerar Context Bundle" title="Regenerar Context Bundle" disabled={pending} onClick={() => prepare()}><RefreshCw size={16} /></button>
      <button className="continuum-icon-button" aria-label="Copiar Context Bundle" title="Copiar Context Bundle" autoFocus={preferredIntent === 'copy'} disabled={pending || dirty || !members.length || preview?.compositionAvailable === false} onClick={() => exportBundle('copy')}><Copy size={16} /></button>
      <button className="continuum-icon-button" aria-label="Salvar Markdown do Bundle" title="Salvar Markdown do Bundle" disabled={pending || dirty || !members.length || preview?.compositionAvailable === false} onClick={() => exportBundle('markdown')}><Download size={16} /></button>
      {(explicit || preview?.hasVisuals) && <button className="continuum-icon-button" aria-label="Salvar pacote ZIP completo" title="Salvar pacote ZIP completo" autoFocus={preferredIntent === 'zip'} disabled={pending || dirty || !members.length} onClick={() => exportBundle('zip')}><Package size={16} /></button>}
    </div>
    {pending && <p role="status">Preparando operação local…</p>}
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {dirty && <p>Regere a prévia para aplicar alterações ou obter as revisões atuais antes de exportar.</p>}
    {preview && <>
      {preview.tagDescription && <p>Critério da coleção (informativo): {preview.tagDescription}</p>}
      {preview.compositionAvailable === false ? <p role="alert">Composição excede 8 MiB. O ZIP preserva todos os originais, sem context.md. Refine a seleção para copiar texto.</p> : <p>{members.length} Artifacts · {preview.markdownBytes.toLocaleString()} bytes · aproximadamente {preview.tokenCount.toLocaleString()} tokens do pacote ({preview.tokenizerEncoding}), incluindo índices e separadores. Estimativa relativa; a IA destinatária pode usar outro encoding.</p>}
      <label>Orçamento opcional de tokens<input aria-label="Orçamento de tokens" type="number" min="1" value={budget} onChange={event => setBudget(event.target.value)} /></label>
      {Number(budget) > 0 && preview.compositionAvailable !== false && preview.tokenCount > Number(budget) && <p role="note">O pacote excede o orçamento em {(preview.tokenCount - Number(budget)).toLocaleString()} tokens; conteúdo integral, sem truncamento.</p>}
      {preview.hasVisuals && <p role="note">Markdown copia somente texto. Os pixels WebP não são transmitidos pelo clipboard; use o pacote ZIP para incluir as imagens.</p>}
      {!members.length ? <p>Esta tag não possui Artifacts. Nenhum conteúdo será exportado.</p> : <ol>{members.map((member, index) => <li key={member.artifactId}>
        <span>{member.name} · {member.kind} · revisão {member.revision}{member.mediaPath ? ' · WebP' : ''}<small>{member.artifactId}</small></span>
        <button className="continuum-icon-button" aria-label={`Mover ${member.artifactId} acima`} title="Mover acima" disabled={pending || index === 0} onClick={() => reorder(index, -1)}><ArrowUp size={14} /></button>
        <button className="continuum-icon-button" aria-label={`Mover ${member.artifactId} abaixo`} title="Mover abaixo" disabled={pending || index === members.length - 1} onClick={() => reorder(index, 1)}><ArrowDown size={14} /></button>
        {explicit && <button className="continuum-icon-button" aria-label={`Retirar ${member.artifactId}`} title="Retirar do pacote" disabled={pending} onClick={() => { setOrder(previous => previous.filter(id => id !== member.artifactId)); setDirty(true); setMessage('') }}><X size={14} /></button>}
      </li>)}</ol>}
      {preview.compositionAvailable !== false && <label>Prévia integral<textarea aria-label="Prévia do Context Bundle" readOnly value={preview.markdown} /></label>}
    </>}
  </section>
}
