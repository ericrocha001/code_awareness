import React, { useEffect, useRef, useState } from 'react'
import { Archive } from 'lucide-react'
import { WorktreeSectionTitle } from './WorktreeSectionTitle'
import type { ObservableWorktree } from '../../../../shared/types/work-orchestration-types'
import type { RemovalAction, RemovalPolicy, RemovalPreview, RemovalResponse } from '../../../../shared/types/worktree-removal-types'
import { removalReason } from './worktree-removal-labels'

export function WorktreeRemovalDetails({ tree, context, active, removed }: { tree: ObservableWorktree; context: { projectId: string; revision: number }; active: boolean; removed: () => void }) {
  const [preview, setPreview] = useState<RemovalPreview | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [reason, setReason] = useState(''), [noPr, setNoPr] = useState(false), [released, setReleased] = useState(false), [discard, setDiscard] = useState(false)
  const [mode, setMode] = useState<'INTEGRATED' | 'ABANDONED'>('ABANDONED'), [delivery, setDelivery] = useState('')
  const [policy, setPolicy] = useState<RemovalPolicy | null>(null)
  const [recovery, setRecovery] = useState<{ preparationId: string; operationId: string } | null>(null)
  const alive = useRef(true), serial = useRef(0), running = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false; serial.current++ } }, [])
  useEffect(() => { serial.current++; setPreview(null); setReleased(false); setDiscard(false) }, [active, tree.generation, tree.head, context.projectId, context.revision])
  async function send(operation: RemovalAction) {
    if (running.current || !active) return
    running.current = true; setBusy(true); setError('')
    if (operation.action === 'EXECUTE') setRecovery({ preparationId: operation.preparationId, operationId: operation.operationId })
    const token = ++serial.current
    try {
      const response: RemovalResponse = await window.codeAwareness.manageWorktreeRemoval({ context, operation })
      if (!alive.current || token !== serial.current) return
      if (!response.success) {
        if (operation.action !== 'RECONCILE' && ['REMOVAL_PREVIEW_STALE', 'REMOVAL_PREPARATION_EXPIRED', 'REMOVAL_APPROVAL_DENIED', 'REMOVAL_NOT_PREPARED', 'PROJECT_CONTEXT_CHANGED'].includes(response.code)) { setPreview(null); setRecovery(null) }
        throw new Error(response.code)
      }
      if ('enabled' in response.data) setPolicy(response.data)
      else if ('fingerprint' in response.data) { setPreview(response.data); setReleased(false); setDiscard(false) }
      else if (response.data.state === 'CLOSED') { setPreview(null); setRecovery(null); removed() }
      else if (response.data.state === 'CANCELLED') setPreview(null)
      else if (response.data.state === 'ENROLLED') { setPreview(null); setError('Inscrição confirmada. Revogue a limpeza automática antes de retomar a escrita.') }
      else if (response.data.state === 'NO_PENDING_REMOVAL') { setRecovery(null); setError('Nenhuma remoção pendente encontrada para esta identidade.') }
      else if (response.data.state === 'UNKNOWN') { setRecovery({ preparationId: response.data.preparationId, operationId: response.data.operationId }); setError('Resultado não confirmado. Reconcile o recibo antes de qualquer nova remoção.') }
      else setError('Resultado não confirmado. Reconcile o recibo antes de qualquer nova remoção.')
    } catch (failure) { if (alive.current && token === serial.current) setError(failure instanceof Error ? failure.message : 'Falha na operação') }
    finally { running.current = false; if (alive.current) setBusy(false) }
  }
  if (tree.reference || !window.codeAwareness.manageWorktreeRemoval) return null
  return <details className="wo-removal wo-disclosure"><summary><WorktreeSectionTitle icon={Archive}>Encerramento e remoção</WorktreeSectionTitle></summary>
    <details><summary>Limpeza automática do repositório</summary><p>Desligada por padrão. Abrange somente WorkTrees gerenciadas, inscritas e liberadas; exige entrega verificada e nenhum conteúdo local pendente.</p>
      <button disabled={busy || !active} onClick={() => void send({ action: 'POLICY' })}>Consultar política</button>
      {policy && <><p>{policy.enabled ? `Habilitada · ${policy.enrolled} inscritas` : 'Desligada'}</p><button disabled={busy || !active} onClick={() => void send({ action: 'POLICY', enabled: !policy.enabled })}>{policy.enabled ? 'Revogar limpeza automática' : 'Habilitar limpeza automática'}</button></>}
      {!!policy?.candidates?.length && <ul>{policy.candidates.map(candidate => <li key={candidate.path}>{candidate.path}: {candidate.code ? removalReason(candidate.code) : candidate.state === 'CLOSED' ? 'Remoção comprovada' : candidate.state === 'DELIVERY_PENDING' ? 'Aguardando entrega verificada' : 'Resultado exige reconciliação'}</li>)}</ul>}
    </details>
    <p>Preparação sob demanda. A remoção exige sessão encerrada na IDE e autorização do proprietário.</p>
    <button disabled={busy || !active} onClick={() => void send({ action: 'RECOVER', worktreeId: tree.worktreeId, generation: tree.generation })}>Recuperar operação pendente</button>
    <label>Motivo<select disabled={busy || !!preview} value={mode} onChange={e => setMode(e.target.value as typeof mode)}><option value="ABANDONED">Abandonar tentativa</option><option value="INTEGRATED">Entrega integrada</option></select></label>
    {mode === 'ABANDONED' && <><label>Contexto útil e motivo do abandono<textarea disabled={busy || !!preview} value={reason} onChange={e => setReason(e.target.value)} /></label><label><input type="checkbox" disabled={busy || !!preview} checked={noPr} onChange={e => setNoPr(e.target.checked)} />Confirmo que esta tentativa não tem Pull Request</label></>}
    {(!noPr || mode === 'INTEGRATED') && <label>Número do Pull Request<input type="number" min="1" disabled={busy || !!preview} value={delivery} onChange={e => setDelivery(e.target.value)} /></label>}
    {!preview && <button disabled={busy || !active || mode === 'ABANDONED' && !reason.trim()} onClick={() => {
      const prNumber = !noPr || mode === 'INTEGRATED' ? Number(delivery) : undefined
      if (prNumber !== undefined && (!Number.isSafeInteger(prNumber) || prNumber <= 0)) { setError('Informe o número do Pull Request.'); return }
      void send({ action: 'PREPARE', worktreeId: tree.worktreeId, generation: tree.generation, prNumber, intent: { mode, delivery: null, noPullRequestConfirmed: mode === 'ABANDONED' && noPr, abandonmentReason: reason } })
    }}>Preparar para remoção</button>}
    {preview && <><p role="status">{preview.state === 'PREPARING' ? 'Prévia disponível; revisão e consentimento obrigatórios' : 'Remoção bloqueada'}</p>
      {!!preview.blockers.length && <ul>{preview.blockers.map(code => <li key={code}>{removalReason(code)}</li>)}</ul>}
      <p>Branch preservada: {preview.preservedRef ?? 'Sem referência recuperável'}. Nenhum PR, Artifact ou branch será excluído.</p>
      {preview.intent.delivery && <p>Entrega verificada: {preview.intent.delivery.repository} #{preview.intent.delivery.prNumber} · {preview.intent.delivery.sourceBranch} → {preview.intent.delivery.targetBranch}</p>}
      <details><summary>Conteúdo local revisado · {preview.content.length} arquivos</summary><ul>{preview.content.map(file => <li key={file.path}>{file.path} · {file.kind} · {file.bytes} bytes</li>)}</ul></details>
      <button disabled={busy || !active || !!recovery} onClick={() => void send({ action: 'CANCEL', preparationId: preview.preparationId })}>Cancelar preparação</button>
      {preview.managed && policy?.enabled && mode === 'INTEGRATED' && preview.blockers.every(code => code === 'REMOVAL_MERGE_NOT_VERIFIED') && <button disabled={busy || !active} onClick={() => void send({ action: 'ENROLL', preparationId: preview.preparationId, consent: { fingerprint: preview.fingerprint, exactPath: preview.path, ownerReleased: true, operatorIsOwner: true, noKnownWriter: true, discardPaths: [] } })}>Inscrever após liberar sessão gerenciada</button>}
      {preview.state === 'PREPARING' && <><label><input type="checkbox" checked={released} disabled={busy} onChange={e => setReleased(e.target.checked)} />Sou o proprietário ou operador legítimo; encerrei a sessão na IDE e não há escritor concorrente.</label>
        <label><input type="checkbox" checked={discard} disabled={busy} onChange={e => setDiscard(e.target.checked)} />Revisei todos os arquivos; autorizei a perda do conteúdo local e preservei externamente os dados e evidências necessários.</label>
        <button disabled={busy || !active || !released || !discard || !!recovery} onClick={() => void send({ action: 'EXECUTE', preparationId: preview.preparationId, operationId: crypto.randomUUID(), consent: { fingerprint: preview.fingerprint, exactPath: preview.path, ownerReleased: released, operatorIsOwner: released, noKnownWriter: released, discardPaths: preview.content.map(file => file.path) } })}>Remover WorkTree</button></>}
    </>}
    {recovery && <button disabled={busy || !active} onClick={() => void send({ action: 'RECONCILE', ...recovery })}>Reconciliar recibo</button>}
    {busy && <p role="status">Verificando…</p>}{error && <p role="alert">{removalReason(error)}</p>}
  </details>
}
