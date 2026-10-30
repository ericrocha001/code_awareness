import React, { useRef, useState } from 'react'
import type { PreviewSelection } from '../../../../shared/types/runtime-preview-types'
import type { PreviewSessionView, RuntimePreviewData, RuntimePreviewRequest } from '../../../../shared/types/runtime-preview-operations'
import type { BranchManagerData, BranchManagerOperation } from '../../../../shared/types/branch-manager-types'
const stages = { TARGET_CHECKOUT: 'Checkout / source', ENDPOINT: 'Endpoint', SERVED_ARTIFACT: 'Artefato servido', LOADED_COMPONENT: 'Componente carregado', BEHAVIOR: 'Comportamento' }
export function RuntimePreviewSession({ selection, repositoryId, worktreeId, startAllowed, disabled, query, inspectionOnly = false }: { selection: PreviewSelection | null; repositoryId: string; worktreeId: string; startAllowed: boolean; disabled: boolean; inspectionOnly?: boolean; query: (operation: BranchManagerOperation) => Promise<BranchManagerData> }) {
  const [mode, setMode] = useState<'LIVE' | 'SNAPSHOT'>('SNAPSHOT')
  const [prepared, setPrepared] = useState<{ captureId: string; buildId: string } | null>(null)
  const [allowDirty, setAllowDirty] = useState(false)
  function prepare() {
    if (selection) void run({ action: 'PREPARE', request: { selection, allowDirty } })
  }
  function acceptBuild(data: RuntimePreviewData) {
    if (data.kind !== 'BUILD' || !selection || !(Object.keys(selection) as Array<keyof PreviewSelection>).every(key => data.selection[key] === selection[key])) return
    setPrepared({ captureId: data.build.captureId, buildId: data.build.buildId }); operation.current = null
    setPending(false); setNotice(data.build.reused ? 'Build preparado reutilizado.' : 'Build preparado. Pronto para iniciar Snapshot.')
  }
  React.useEffect(() => { setPrepared(null); operation.current = null }, [selection?.repositoryId, selection?.worktreeId, selection?.generation, selection?.fingerprint])
  const [session, setSession] = useState<PreviewSessionView | null>(null), [history, setHistory] = useState<PreviewSessionView[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null), [busy, setBusy] = useState(false), [pending, setPending] = useState(false)
  const [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [bindings, setBindings] = useState<Array<{ bindingId: string; executionId: string }>>([]), [bindingId, setBindingId] = useState('')
  const [proofId, setProofId] = useState(''), [criterionId, setCriterionId] = useState(''), [evidence, setEvidence] = useState<Extract<RuntimePreviewData, { kind: 'EVIDENCE' }> | null>(null)
  const operation = useRef<string | null>(null), epoch = useRef(0)
  React.useEffect(() => () => { epoch.current++ }, [])
  React.useEffect(() => { epoch.current++; setBusy(false); return () => { epoch.current++ } }, [disabled, query])
  async function call(request: RuntimePreviewRequest) {
    const result = await query({ action: 'PREVIEW_RUNTIME', request })
    if (result.kind !== 'PREVIEW_RUNTIME') throw new Error('PREVIEW_UNAVAILABLE')
    if (!result.result.success) throw new Error(result.result.code)
    return result.result.data
  }
  async function run(request: RuntimePreviewRequest) {
    const turn = ++epoch.current; setBusy(true); setError('')
    try {
      const data = await call(request)
      if (turn !== epoch.current) return
      if (data.kind === 'SESSION') {
        if (data.session) setSession(data.session)
        setPending(data.pending)
        setNotice(data.pending ? 'Operação em andamento. Consulte a sessão para observar o resultado.' : '')
      }
      if (data.kind === 'SESSIONS') {
        setHistory(values => request.action === 'LIST' && request.cursor ? [...values, ...data.sessions] : data.sessions)
        setNextCursor(data.nextCursor); setPending(!!data.pendingOperationId)
        setSession(value => data.sessions.find(record => record.sessionId === value?.sessionId) ?? value)
        if (data.lastOperation?.code) setError(data.lastOperation.code)
        const completed = data.lastOperation?.result
        if (!data.pendingOperationId && completed?.success && 'session' in completed.data && completed.data.session?.selection.repositoryId === repositoryId && completed.data.session.selection.worktreeId === worktreeId) {
          const observed = completed.data.session
          setSession(value => !value || value.sessionId === observed.sessionId ? observed : value)
        }
        setNotice(data.pendingOperationId ? 'Operação em andamento. A observação é feita sob demanda.' : data.sessions.length ? 'Histórico carregado. Inspecione uma sessão para obter evidência atual.' : 'Nenhuma sessão registrada para esta Worktree.')
      }
      if (data.kind === 'BUILD') acceptBuild(data)
      if (data.kind === 'SESSIONS' && !data.pendingOperationId && data.lastOperation?.result?.success) acceptBuild(data.lastOperation.result.data)
      if (data.kind === 'BINDINGS') { setBindings(data.bindings); setBindingId(data.bindings[0]?.bindingId ?? ''); setNotice(data.reason ?? (data.bindings.length ? '' : 'Nenhum vínculo de execução corrente comprovado.')) }
      if (data.kind === 'QUALIFICATION') { setSession(data.session); setNotice(`Critério ${data.qualification.criterionId}: ${data.qualification.status}${data.qualification.reasons.length ? ' · ' + data.qualification.reasons.join(', ') : ''}`) }
      if (data.kind === 'EVIDENCE') setEvidence(data)
    } catch (failure) { if (turn === epoch.current) setError(failure instanceof Error ? failure.message : 'PREVIEW_UNAVAILABLE') }
    finally { if (turn === epoch.current) setBusy(false) }
  }
  const list = (cursor?: string) => void run({ action: 'LIST', repositoryId, worktreeId, limit: 10, ...(cursor ? { cursor } : {}) })
  const launch = () => {
    if (!selection) return
    if (mode === 'SNAPSHOT' && !prepared) { setError('PREPARE_REQUIRED'); return }
    if (!operation.current) { operation.current = crypto.randomUUID(); setSession(null); setEvidence(null); setBindings([]); setBindingId(''); setProofId('') }
    void run({ action: 'START', selection, operationId: operation.current, ...(mode === 'SNAPSHOT' && prepared ? { snapshot: prepared } : {}) })
  }
  const blocked = disabled || busy
  return <div className="runtime-preview-session">
    {!inspectionOnly && <><label>Modo <select value={mode} disabled={blocked || pending} onChange={e => { setMode(e.target.value as 'LIVE' | 'SNAPSHOT'); operation.current = null }}><option value="SNAPSHOT">Snapshot · build imutável</option><option value="LIVE">Live · V5</option></select></label>{mode === 'SNAPSHOT' && <><label><input type="checkbox" checked={allowDirty} disabled={blocked} onChange={e => setAllowDirty(e.target.checked)}/>Incluir alterações locais na captura</label><button disabled={blocked || !selection || pending} onClick={() => void prepare()}>Preparar Snapshot</button>{prepared && <p>CaptureId <code>{prepared.captureId}</code> · BuildId <code>{prepared.buildId}</code></p>}</>}</>}
    <div className="runtime-preview-actions">
      {!inspectionOnly && <button disabled={blocked || (mode === 'LIVE' ? !startAllowed : !prepared) || pending} onClick={launch}>Iniciar {mode === 'SNAPSHOT' ? 'Snapshot' : 'Live'}</button>}
      <button disabled={blocked} onClick={() => list()}>Consultar sessões</button>
      {session && <button disabled={blocked} onClick={() => void run({ action: 'INSPECT', sessionId: session.sessionId })}>Inspecionar sessão</button>}
      {session && !['STOPPED', 'FAILED'].includes(session.state) && <button disabled={blocked} onClick={() => void run({ action: 'STOP', sessionId: session.sessionId })}>Parar esta sessão</button>}
      {!inspectionOnly && session && ['STOPPED', 'FAILED'].includes(session.state) && <button disabled={blocked || pending || (mode === 'LIVE' ? !startAllowed : !prepared)} onClick={() => { operation.current = null; launch() }}>Nova sessão</button>}
    </div>
    <p className="runtime-preview-note">READY e STOPPED descrevem o runtime. A funcionalidade exige evidência comportamental e identidade comprovada.</p>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {!!history.length && <details open><summary>Sessões desta Worktree</summary><ul className="runtime-preview-history">{history.map(value => <li key={value.sessionId}><button disabled={blocked} onClick={() => void run({ action: 'INSPECT', sessionId: value.sessionId })}>{new Date(value.startedAt).toLocaleString('pt-BR')} · {value.state} · {value.selection.profileId}</button><code>{value.sessionId}</code></li>)}</ul>{nextCursor && <button disabled={blocked} onClick={() => list(nextCursor)}>Mais sessões</button>}</details>}
    {session && <section aria-label="Sessão de runtime">
      <div className="runtime-preview-state"><strong>{session.state}</strong><span>Aplicação: {session.readiness}</span><span>Observação: {session.observation}</span><span>Recursos: {session.resources}</span></div>
      <p><code>{session.sessionId}</code> · perfil r{session.profileRevision} · recibo r{session.revision} · observado em {new Date(session.at).toLocaleString('pt-BR')}</p>
      {session.build && <p>Snapshot · BuildId <code>{session.build.buildId}</code> · RuntimeId <code>{session.build.runtimeId}</code></p>}
      <p>Branch: {session.source?.branch ?? 'não comprovada'} · HEAD <code>{session.source?.head?.slice(0, 12) ?? 'desconhecido'}</code>{session.source?.dirty ? ' · alterações locais' : ''}</p>
      {session.failure && <p role="alert">{session.failure}</p>}
      {session.endpoint && <a href={session.endpoint} target="_blank" rel="noreferrer">{session.observation === 'HISTORICAL' ? 'Abrir endpoint da última observação' : 'Abrir aplicação isolada'}</a>}
      {!inspectionOnly && <><label>Modo <select value={mode} disabled={blocked || pending} onChange={e => { setMode(e.target.value as 'LIVE' | 'SNAPSHOT'); operation.current = null }}><option value="SNAPSHOT">Snapshot · build imutável</option><option value="LIVE">Live · V5</option></select></label>{mode === 'SNAPSHOT' && <><label><input type="checkbox" checked={allowDirty} disabled={blocked} onChange={e => setAllowDirty(e.target.checked)}/>Incluir alterações locais na captura</label><button disabled={blocked || !selection || pending} onClick={() => void prepare()}>Preparar Snapshot</button>{prepared && <p>CaptureId <code>{prepared.captureId}</code> · BuildId <code>{prepared.buildId}</code></p>}</>}</>}
    <div className="runtime-preview-actions"><button disabled={blocked} onClick={() => void run({ action: 'PROBE', sessionId: session.sessionId, probes: ['READINESS', 'ATTESTATION'] })}>Verificar prontidão e carregamento</button><button disabled={blocked} onClick={() => void run({ action: 'EVIDENCE', sessionId: session.sessionId, section: 'COVERAGE', limit: 8 })}>Consultar evidências</button></div>
      <div className="runtime-preview-coverage"><table><caption>Cobertura por etapa e componente</caption><thead><tr><th>Etapa</th><th>Componente</th><th>Estado</th><th>Proveniência e lacuna</th></tr></thead><tbody>{session.coverage.map((value, index) => <tr key={index}><td>{stages[value.stage]}</td><td>{value.component}</td><td><strong>{value.status}</strong></td><td><span>{value.reasonCode}</span><small>{value.evidenceRef ?? 'Sem evidência'} · {new Date(value.at).toLocaleString('pt-BR')}</small>{value.fingerprint && <code title={value.fingerprint}>{value.fingerprint.slice(0, 16)}</code>}</td></tr>)}</tbody></table></div>
      {evidence && <details open><summary>Evidências delimitadas · recibo r{evidence.revision}</summary><pre>{JSON.stringify(evidence.entries, null, 2)}</pre>{evidence.nextOffset !== null && <button disabled={blocked} onClick={() => void run({ action: 'EVIDENCE', sessionId: session.sessionId, revision: evidence.revision, section: evidence.section, offset: evidence.nextOffset!, limit: 8 })}>Próximas evidências</button>}</details>}
      <details className="runtime-preview-qualification"><summary>Qualificar funcionalidade com prova existente</summary><p>A prova do Ledger deve corresponder ao checkout, sessão, execução e critério. Cobertura incompleta produz INCONCLUSIVE.</p>
        <button disabled={blocked} onClick={() => void run({ action: 'BINDINGS', sessionId: session.sessionId })}>Consultar vínculos de execução</button>
        {!!bindings.length && <label>Execução comprovada <select value={bindingId} disabled={blocked} onChange={e => setBindingId(e.target.value)}>{bindings.map(binding => <option key={binding.bindingId} value={binding.bindingId}>{binding.executionId}</option>)}</select></label>}
        <label>Critério existente <input value={criterionId} maxLength={128} disabled={blocked} onChange={e => setCriterionId(e.target.value)}/></label>
        <label>Prova do Validation Ledger <input value={proofId} maxLength={128} disabled={blocked} onChange={e => setProofId(e.target.value)}/></label>
        <button disabled={blocked || !bindingId || !proofId || !criterionId || session.state !== 'RUNNING'} onClick={() => void run({ action: 'QUALIFY', sessionId: session.sessionId, bindingId, proofId, criterionId })}>Validar vínculo e qualificar</button>
      </details>
      {!!session.qualifications.length && <ul>{session.qualifications.map((value, index) => <li key={index}><strong>{value.criterionId}: {value.status}</strong> · observação {value.observedStatus} · execução {value.executionId} · prova {value.proofId}<small>Escopo: {value.scope?.join(', ') || 'não comprovado'}</small><small>Recibo r{value.evidenceRevision} · evidência em {value.evidenceAt ? new Date(value.evidenceAt).toLocaleString('pt-BR') : 'não comprovada'}</small>{value.reasons.length > 0 && <p>{value.reasons.join(', ')}</p>}</li>)}</ul>}
    </section>}
  </div>
}
