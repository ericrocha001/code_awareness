import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Play, Square } from 'lucide-react'
import type { BranchRecord, BranchWorktree } from '../../../../shared/types/branch-orchestration-types'
import type { BranchManagerData, BranchManagerOperation } from '../../../../shared/types/branch-manager-types'
import type { PreviewSessionView, RuntimePreviewData, RuntimePreviewRequest } from '../../../../shared/types/runtime-preview-operations'

type Intent = Extract<RuntimePreviewRequest, { action: 'RUN_BRANCH_APP' }>
type Notice = { ref: string; message: string; code?: string; candidates?: BranchWorktree[]; preflight?: unknown; conflict?: PreviewSessionView }
export const unresolvedPreview = (s: PreviewSessionView) => !['STOPPED', 'FAILED'].includes(s.state) || s.resources !== 'RELEASED'
const errors: Record<string, string> = {
  BRANCH_CHANGED: 'A branch mudou. Atualize a lista antes de tentar novamente.',
  WORKTREE_STALE: 'O checkout mudou ou está indisponível. Atualize a lista.',
  PROJECT_CONTEXT_CHANGED: 'O projeto ativo mudou. A operação não pode continuar neste contexto.',
  PREVIEW_SESSION_BUSY: 'Já existe uma sessão de preview. Encerre-a explicitamente antes de iniciar outra.'
}
export function useBranchAppRuntime(repositoryId: string | undefined, query: (operation: BranchManagerOperation) => Promise<BranchManagerData>, enabled: boolean) {
  const [session, setSession] = useState<PreviewSessionView | null>(null), [notice, setNotice] = useState<Notice | null>(null)
  const [pending, setPending] = useState<{ ref: string; stop: boolean } | null>(null), [uncertain, setUncertain] = useState(false)
  const [retry, setRetry] = useState(0), [ready, setReady] = useState(false)
  const [observationPaused, setObservationPaused] = useState(false)
  const [verifiedSession, setVerifiedSession] = useState<string | null>(null)
  const inspection = useRef<{ sessionId: string; operationId: string } | null>(null)
  const commandBusy = useRef(false), mutation = useRef(0)
  const epoch = useRef(0), working = useRef(false), intent = useRef<Intent | null>(null)
  const observed = useRef(session); observed.current = session
  const waiting = useRef<{ operationId: string; ref: string } | null>(null)
  const call = useCallback(async (request: RuntimePreviewRequest) => {
    const value = await query({ action: 'PREVIEW_RUNTIME', request })
    if (value.kind !== 'PREVIEW_RUNTIME') throw Error('PREVIEW_UNAVAILABLE')
    if (!value.result.success) throw Error(value.result.code)
    return value.result.data
  }, [query])
  const apply = useCallback((data: RuntimePreviewData, ref: string) => {
    if (data.kind === 'BRANCH_APP') {
      setNotice({ ref, message: data.message, code: data.reasonCode, candidates: data.candidates, preflight: data.preflight, conflict: data.activeSession })
      if (data.activeSession) setSession(data.activeSession)
      if (!data.candidates?.length) intent.current = null
      setPending(null); waiting.current = null
    } else if (data.kind === 'SESSION') {
      if (data.session) {
        setSession(data.session)
        if (data.session.failure) setNotice({ ref, message: data.session.termination?.kind === 'UNEXPECTED_EXIT' ? 'O aplicativo saiu inesperadamente. O diagnóstico foi preservado.' : 'A sessão exige atenção. Consulte o diagnóstico antes de tentar novamente.', code: data.session.failure })
      }
      if (!data.pending) { setPending(null); intent.current = null; waiting.current = null }
    } else throw Error('PREVIEW_UNAVAILABLE')
  }, [])
  useEffect(() => {
    epoch.current++; setObservationPaused(false); inspection.current = null; setVerifiedSession(null); commandBusy.current = false; intent.current = null; waiting.current = null; working.current = false
    setSession(null); setNotice(null); setPending(null); setUncertain(false); setReady(false)
  }, [repositoryId, query])
  useEffect(() => {
    const version = ++epoch.current
    if (!enabled || !repositoryId) { setVerifiedSession(null); return }
    let timer: ReturnType<typeof setTimeout> | undefined, disposed = false
    const observe = async () => {
      if (disposed || version !== epoch.current) return
      if (working.current || commandBusy.current) { timer = setTimeout(observe, 2000); return }
      timer = undefined
      const commandVersion = mutation.current
      working.current = true
      try {
        const list = await call({ action: 'LIST', repositoryId, limit: 20 })
        if (disposed || version !== epoch.current || commandVersion !== mutation.current) return
        if (list.kind !== 'SESSIONS') throw Error('PREVIEW_UNAVAILABLE')
        const request = waiting.current
        if (request && list.lastOperation?.operationId === request.operationId && !list.pendingOperationId) {
          const result = list.lastOperation.result
          if (result?.success) apply(result.data, request.ref)
          else { const code = result && !result.success ? result.code : list.lastOperation.code ?? 'PREVIEW_UNAVAILABLE'; setNotice({ ref: request.ref, message: errors[code] ?? 'O aplicativo não pôde ser iniciado. Consulte o diagnóstico.', code }); setPending(null); waiting.current = null; intent.current = null }
        }
        let completedInspection = false
        const expected = inspection.current, completed = list.lastOperation?.result
        if (expected && !list.pendingOperationId && list.lastOperation?.operationId === expected.operationId) {
          if (!completed?.success) throw Error(completed && !completed.success ? completed.code : 'PREVIEW_UNAVAILABLE')
          if (completed.data.kind !== 'SESSION' || completed.data.session?.sessionId !== expected.sessionId || completed.data.session.selection.repositoryId !== repositoryId) throw Error('SESSION_IDENTITY_MISMATCH')
          const value = completed.data.session
          setSession(value); setVerifiedSession(value.sessionId); completedInspection = true; inspection.current = null
          if (value.failure) setNotice({ ref: 'refs/heads/' + value.source?.branch, message: value.termination?.kind === 'UNEXPECTED_EXIT' ? 'O aplicativo saiu inesperadamente. O diagnóstico foi preservado.' : 'O encerramento exige atenção. Consulte os detalhes.', code: value.failure })
        }
        const record = list.sessions.find(unresolvedPreview) ?? list.sessions.find(s => s.sessionId === observed.current?.sessionId)
        // Keep receipt capacity available for stop and recovery instead of exhausting the bounded history.
        if (record?.state === 'RUNNING' && record.revision >= 192 && !list.pendingOperationId && !waiting.current) {
          setSession(record); setVerifiedSession(null); setReady(true); setUncertain(true); setObservationPaused(true)
          setNotice({ ref: '', message: 'Observação automática pausada para preservar o histórico de encerramento. O aplicativo não foi encerrado.', code: 'AUTOMATIC_OBSERVATION_LIMIT' })
          return
        }
        if (record && !list.pendingOperationId && !completedInspection) {
          inspection.current = { sessionId: record.sessionId, operationId: record.operationId }
          const value = await call({ action: 'INSPECT', sessionId: record.sessionId })
          if (disposed || version !== epoch.current || commandVersion !== mutation.current) return
          if (value.kind !== 'SESSION') throw Error('PREVIEW_UNAVAILABLE')
          if (value.session) {
            if (value.session.sessionId !== record.sessionId || value.session.selection.repositoryId !== repositoryId) throw Error('SESSION_IDENTITY_MISMATCH')
            setSession(value.session); setVerifiedSession(value.session.sessionId); inspection.current = null
            if (value.session.failure) setNotice({ ref: 'refs/heads/' + value.session.source?.branch, message: value.session.termination?.kind === 'UNEXPECTED_EXIT' ? 'O aplicativo saiu inesperadamente. O diagnóstico foi preservado.' : 'O encerramento exige atenção. Consulte os detalhes.', code: value.session.failure })
          } else if (!observed.current) setSession(record)
        }
        setUncertain(false); setReady(true)
        timer = setTimeout(observe, list.pendingOperationId || waiting.current || inspection.current ? 2000 : record && unresolvedPreview(record) ? 5000 : 15000)
      } catch (error) {
        if (!disposed && version === epoch.current && commandVersion === mutation.current && error instanceof Error && error.message === 'PREVIEW_OPERATION_BUSY') { timer = setTimeout(observe, 2000) }
        else if (!disposed && version === epoch.current && commandVersion === mutation.current) { setUncertain(true); setNotice({ ref: waiting.current?.ref ?? '', message: 'Não foi possível confirmar o estado do preview. A execução não foi presumida.', code: error instanceof Error ? error.message : 'PREVIEW_UNAVAILABLE' }) }
      } finally { if (version === epoch.current) { working.current = false; if (!disposed && !timer && commandVersion !== mutation.current) timer = setTimeout(observe, 2000) } }
    }
    void observe()
    return () => { disposed = true; epoch.current++; clearTimeout(timer); working.current = false }
  }, [enabled, repositoryId, call, apply, retry])
  const execute = async (request: RuntimePreviewRequest, ref: string, stop = false) => {
    if (commandBusy.current || !enabled || !repositoryId) return
    const version = epoch.current
    commandBusy.current = true; setObservationPaused(false); mutation.current++; inspection.current = null; setPending({ ref, stop }); setNotice(null)
    try {
      const data = await call(request)
      if (version !== epoch.current) return
      apply(data, ref); setUncertain(false)
      if (data.kind === 'SESSION' && data.pending) setRetry(n => n + 1)
    } catch (error) {
      if (version === epoch.current) { const code = error instanceof Error ? error.message : 'PREVIEW_UNAVAILABLE'; setNotice({ ref, message: errors[code] ?? 'Não foi possível concluir a operação. Confira o diagnóstico e verifique o estado antes de repetir.', code }); setUncertain(true); setPending(null) }
    } finally { if (version === epoch.current) commandBusy.current = false }
  }
  const start = (branch: BranchRecord, worktree?: BranchWorktree) => {
    if (commandBusy.current) return
    const request: Intent = !worktree && intent.current?.ref === branch.ref && intent.current.revision === branch.revision ? intent.current : { action: 'RUN_BRANCH_APP', repositoryId: repositoryId!, ref: branch.ref, revision: branch.revision, operationId: crypto.randomUUID() }
    intent.current = worktree ? { ...request, worktree: { worktreeId: worktree.worktreeId, generation: worktree.generation } } : request
    waiting.current = { operationId: request.operationId, ref: branch.ref }
    void execute(intent.current, branch.ref)
  }
  const stop = (value: PreviewSessionView, ref: string) => { if (commandBusy.current) return; waiting.current = { operationId: value.operationId, ref }; void execute({ action: 'STOP', sessionId: value.sessionId }, ref, true) }
  return { session, notice, pending, uncertain, ready, verifiedSession, observationPaused, start, stop, reconcile: () => setRetry(n => n + 1) }
}
export function BranchAppAction({ branch, runtime, disabled }: { branch: BranchRecord; runtime: ReturnType<typeof useBranchAppRuntime>; disabled: boolean }) {
  const { session, notice, pending, uncertain } = runtime
  const own = session?.selection.repositoryId === branch.repositoryId && branch.worktrees.some(w => w.worktreeId === session.selection.worktreeId && w.generation === session.selection.generation)
  const active = own && session && unresolvedPreview(session)
  const preparing = pending?.ref === branch.ref
  const message = notice?.ref === branch.ref ? notice : null
  return <div className="bm-app-action">
    <div className="bm-app-controls">
      {branch.namespace !== 'LOCAL' && !active && <span>Requer checkout local</span>}
      {active && <span role="status">{uncertain ? 'Estado não confirmado' : session.state === 'RUNNING' && (session.observation === 'CURRENT' || runtime.verifiedSession === session.sessionId) && session.readiness === 'READY' && session.liveness === 'VERIFIED' ? 'Em execução' : session.state === 'STOPPING' ? 'Encerrando…' : 'Verificando aplicativo…'}</span>}
      <button className="bm-run-app" disabled={disabled || !runtime.ready || !!pending || (uncertain && !active) || (branch.namespace !== 'LOCAL' && !active)} aria-label={`${active ? 'Encerrar aplicativo' : 'Rodar aplicativo'}: ${branch.name}`} onClick={() => active ? runtime.stop(session, branch.ref) : runtime.start(branch)}>
        {active ? <Square size={14}/> : <Play size={14}/>}{preparing ? pending.stop ? 'Encerrando…' : 'Preparando…' : active ? 'Encerrar' : 'Rodar aplicativo'}
      </button>
    </div>
    {message && <div className="bm-app-notice"><p role="alert">{message.message}</p>
      {message.candidates?.map(tree => <button key={tree.worktreeId} disabled={disabled || !!pending} onClick={() => runtime.start(branch, tree)}>Rodar neste checkout: {tree.path}</button>)}
      {message.conflict && unresolvedPreview(message.conflict) && <button disabled={disabled || !!pending} onClick={() => runtime.stop(message.conflict!, branch.ref)}>Encerrar sessão atual</button>}
      {message.code && <details><summary>Diagnóstico</summary><code>{message.code}</code>{message.preflight != null && <pre>{JSON.stringify(message.preflight, null, 2)}</pre>}</details>}
    </div>}
  </div>
}
