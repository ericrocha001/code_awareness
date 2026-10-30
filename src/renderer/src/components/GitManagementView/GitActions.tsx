import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type {
  GitBasicAction,
  GitHistoryPage,
  GitManagementContext,
  GitMutationRequest,
  GitOverview,
  GitManagementState,
  GitCheckoutSynchronization
} from '../../../../shared/types/git-management-types'

const errorText: Record<string, string> = {
  GIT_STATE_CHANGED:
    'O estado Git mudou desde a inspeção. Atualize e revise os arquivos novamente.',
  DIRTY_WORKTREE:
    'Há alterações locais. Prepare e registre seu trabalho antes de atualizar a branch.',
  WORKTREE_BRANCH_OCCUPIED: 'Esta branch está em uso em outra worktree.',
  WORKTREE_OWNERSHIP_REQUIRED:
    'O controle Git desta worktree está concedido a outro executor.',
  NON_FAST_FORWARD:
    'As branches divergiram. Esta interface permite somente fast-forward e push normal.',
  REMOTE_NOT_FOUND: 'O remoto origin não está configurado.',
  AUTHENTICATION_REQUIRED:
    'A autenticação do remoto falhou. Verifique sua conexão e credenciais.',
  NOTHING_TO_COMMIT: 'Não há alterações preparadas para registrar.',
  PROJECT_CONTEXT_CHANGED:
    'O projeto ativo mudou. Reabra este repositório para reconciliar a operação.'
}
export interface GitActionsHandle {
  execute: (operation: GitBasicAction, snapshot: GitManagementState) => void
  recover: () => void
}
export interface GitActionsFeedback { busy: boolean; pending: boolean; status: string }
export const GitActions = forwardRef<GitActionsHandle, {
  context: GitManagementContext
  overview: GitOverview
  history: GitHistoryPage | null
  refresh: () => Promise<void>
  blocked: boolean
  onMutationStart?: () => void
  onLockedChange?: (locked: boolean) => void
  onFeedbackChange?: (feedback: GitActionsFeedback) => void
  synchronization?: GitCheckoutSynchronization | null
}>(function GitActions({
  context,
  overview,
  history,
  refresh,
  blocked,
  onMutationStart,
  onLockedChange,
  onFeedbackChange,
  synchronization
}, ref) {
  const [paths, setPaths] = useState<string[]>([])
  const [message, setMessage] = useState('')
  const [branch, setBranch] = useState('')
  const [confirmation, updateConfirmation] = useState<GitBasicAction | null>(null)
  const confirmationSnapshot = useRef<GitManagementState | null>(null)
  const setConfirmation = (operation: GitBasicAction | null) => {
    confirmationSnapshot.current = null
    updateConfirmation(operation)
  }
  const confirmationDialog = useRef<HTMLDivElement>(null)
  const [pending, setPending] = useState<GitMutationRequest | null>(() => {
    try {
      const value = sessionStorage.getItem(
        `git-management:pending:${context.projectId}`
      )
      return value ? JSON.parse(value) : null
    } catch {
      return null
    }
  })
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const mounted = useRef(true)
  const activeRequest = useRef(false)
  const staged = overview.changes.filter(
    (change) => change.stagedState && !change.conflicted
  )
  const available = overview.changes.filter((change) => !change.conflicted)
  const locked =
    blocked ||
    busy ||
    !!pending ||
    !!overview.state.operation ||
    overview.state.conflictCount > 0
  useEffect(() => { onLockedChange?.(locked) }, [locked, onLockedChange])
  useEffect(() => { onFeedbackChange?.({ busy, pending: !!pending, status }) }, [busy, pending, status, onFeedbackChange])
  useEffect(() => {
    if (confirmation && confirmationSnapshot.current) confirmationDialog.current?.scrollIntoView?.({ block: 'nearest' })
  }, [confirmation])
  useEffect(() => {
    setPaths([])
    if (!confirmationSnapshot.current) setConfirmation(null)
  }, [overview])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const persist = (request: GitMutationRequest | null) => {
    try {
      const key = `git-management:pending:${context.projectId}`
      if (request) sessionStorage.setItem(key, JSON.stringify(request))
      else sessionStorage.removeItem(key)
    } catch {}
  }
  const execute = async (
    operation: GitBasicAction,
    recover?: GitMutationRequest
  ) => {
    if (activeRequest.current) return
    if (recover && (recover.context.projectId !== context.projectId || recover.context.revision !== context.revision)) {
      setStatus(errorText.PROJECT_CONTEXT_CHANGED)
      return
    }
    activeRequest.current = true
    const request = recover ?? {
      context,
      snapshot: confirmationSnapshot.current ?? overview.state,
      operation,
      operationId: crypto.randomUUID()
    }
    persist(request)
    onMutationStart?.()
    confirmationSnapshot.current = null
    setBusy(true)
    setPending(request)
    setStatus('Executando operação Git…')
    setConfirmation(null)
    try {
      const response = await window.codeAwareness.mutateGitManagement(request)
      if (!mounted.current) return
      if (!response.success) {
        setStatus(errorText[response.code] ?? response.code)
        return
      }
      const result = response.data
      const code = String(result.value.code ?? '')
      if (
        [
          'OPERATION_OUTCOME_UNKNOWN',
          'RECEIPT_UNAVAILABLE',
          'RECEIPT_BUSY',
          'RECEIPT_CAPACITY_EXCEEDED'
        ].includes(code)
      ) {
        setStatus(
          `Resultado ainda não confirmado (${code}). Recupere a mesma operação antes de continuar.`
        )
        return
      }
      persist(null)
      setPending(null)
      if (result.isError)
        setStatus(errorText[code] ?? `Operação recusada: ${code}`)
      else {
        setStatus(
          operation.action === 'COMMIT'
            ? 'Commit registrado no índice inspecionado.'
            : operation.action === 'FETCH'
              ? 'Fetch concluído: referências remotas consultadas. A branch local não foi atualizada.'
              : operation.action === 'PUSH'
                ? 'Push confirmado pelo remoto.'
                : 'Operação Git confirmada.'
        )
        if (operation.action === 'COMMIT') setMessage('')
      }
      await refresh()
    } catch {
      if (mounted.current)
        setStatus(
          'A resposta foi perdida. Recupere a mesma operação antes de continuar.'
        )
    } finally {
      activeRequest.current = false
      if (mounted.current) setBusy(false)
    }
  }
  useImperativeHandle(ref, () => ({
    execute(operation, snapshot) {
      if (locked || activeRequest.current) return
      confirmationSnapshot.current = snapshot
      void execute(operation)
    },
    recover() { if (pending && !busy) void execute(pending.operation, pending) }
  }))
  const direct = (action: 'PULL_FF_ONLY' | 'PUSH') => {
    if (synchronization?.action !== action || locked) return
    confirmationSnapshot.current = synchronization.state
    void execute({ action, contextual: true })
  }
  const selectedPaths = (action: 'STAGE' | 'UNSTAGE') =>
    available
      .filter(
        (change) =>
          paths.includes(change.path) &&
          (action === 'UNSTAGE'
            ? change.stagedState
            : change.untracked || change.unstagedState)
      )
      .flatMap((change) =>
        change.previousPath ? [change.path, change.previousPath] : [change.path]
      )
  return (
    <section className="gm-actions" aria-label="Operações Git">
      <h3>Preparar → Registrar → Publicar</h3>
      {overview.state.operation || overview.state.conflictCount > 0 ? (
        <p role="alert">
          Resolva a operação Git ou os conflitos em uma ferramenta local antes
          de continuar.
        </p>
      ) : null}
      <div className="gm-path-selection">
        {available.map((change) => (
          <label key={change.path}>
            <input
              type="checkbox"
              disabled={locked}
              checked={paths.includes(change.path)}
              onChange={(event) =>
                setPaths((previous) =>
                  event.target.checked
                    ? [...previous, change.path]
                    : previous.filter((path) => path !== change.path)
                )
              }
            />
            <span>{change.path}</span>
          </label>
        ))}
      </div>
      <div className="gm-action-row">
        <button
          disabled={locked || !selectedPaths('STAGE').length}
          onClick={() =>
            void execute({ action: 'STAGE', paths: selectedPaths('STAGE') })
          }
        >
          Preparar selecionados
        </button>
        <button
          disabled={locked || !selectedPaths('UNSTAGE').length}
          onClick={() =>
            void execute({ action: 'UNSTAGE', paths: selectedPaths('UNSTAGE') })
          }
        >
          Retirar do índice
        </button>
      </div>
      <div className="gm-commit-review">
        <h3>Prévia do commit · {staged.length} arquivos</h3>
        {staged.length ? (
          <ul>
            {staged.map((change) => (
              <li key={change.path}>
                {change.previousPath ? `${change.previousPath} → ` : ''}
                {change.path}
              </li>
            ))}
          </ul>
        ) : (
          <p>Prepare arquivos para registrar um commit.</p>
        )}
        <label>
          Mensagem do commit
          <textarea
            aria-label="Mensagem do commit"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            disabled={locked}
            maxLength={10000}
            rows={3}
          />
        </label>
        <button
          disabled={locked || !message.trim() || !staged.length}
          onClick={() => setConfirmation({ action: 'COMMIT', message })}
        >
          Registrar commit…
        </button>
      </div>
      <details>
        <summary>Branches e sincronização</summary>
        <p>
          Origin é o remoto padrão. Fetch consulta suas referências; pull
          atualiza a branch local somente por fast-forward. Push publica commits
          sem force.
        </p>
        <label>
          Nova branch
          <input
            aria-label="Nova branch"
            value={branch}
            onChange={(event) => setBranch(event.target.value)}
            disabled={locked}
            maxLength={250}
          />
        </label>
        <button
          disabled={locked || !branch.trim() || !overview.state.head}
          onClick={() =>
            setConfirmation({ action: 'CREATE', branch: branch.trim() })
          }
        >
          Criar branch…
        </button>
        <label>
          Trocar branch
          <select
            aria-label="Trocar branch"
            value=""
            disabled={locked}
            onChange={(event) => {
              if (event.target.value)
                setConfirmation({
                  action: 'SWITCH',
                  branch: event.target.value
                })
            }}
          >
            <option value="">Selecione uma branch local</option>
            {history?.refs
              .filter(
                (ref) =>
                  ref.kind === 'LOCAL' && ref.name !== overview.state.branch
              )
              .map((ref) => (
                <option key={ref.ref} value={ref.name}>
                  {ref.name}
                </option>
              ))}
          </select>
        </label>
        <div className="gm-action-row">
          <button
            disabled={locked}
            onClick={() => void execute({ action: 'FETCH' })}
          >
            Fetch
          </button>
          <button
            disabled={locked || synchronization?.action !== 'PULL_FF_ONLY'}
            title={
              overview.state.dirty
                ? 'Pull exige uma worktree limpa'
                : 'Atualizar por fast-forward'
            }
            onClick={() => direct('PULL_FF_ONLY')}
          >
            Pull FF-only
          </button>
          <button
            disabled={locked || !overview.state.branch || !overview.state.head}
            onClick={() => synchronization?.action === 'PUSH' ? direct('PUSH') : setConfirmation({ action: 'PUSH' })}
          >
            {synchronization?.action === 'PUSH' ? 'Publicar · Push' : 'Revisar publicação…'}
          </button>
        </div>
      </details>
      {confirmation && (
        <div
          ref={confirmationDialog}
          className="gm-confirm"
          role="dialog"
          aria-label="Confirmar operação Git"
        >
          <h3>Confirmar {confirmation.action}</h3>
          <p>
            {confirmation.action === 'COMMIT'
              ? `Registrar somente os ${staged.length} arquivos listados na prévia. Não prepara nem publica outras alterações.`
              : confirmation.action === 'CREATE'
                ? `Criar ${confirmation.branch} no HEAD inspecionado. A branch atual permanece ativa.`
                : confirmation.action === 'SWITCH'
                  ? `Trocar para ${confirmation.branch}. O Git pode recusar se alterações locais impedirem a troca.`
                  : `Executar ${confirmation.action} no remoto origin para este repositório.`}
          </p>
          <div className="gm-action-row">
            <button
              disabled={locked}
              onClick={() => void execute(confirmation)}
            >
              Confirmar operação
            </button>
            <button onClick={() => setConfirmation(null)}>Cancelar</button>
          </div>
        </div>
      )}
      {pending && (
        <div className="gm-pending" role="alert">
          <p>
            Operação pendente: <code>{pending.operationId}</code>
          </p>
          <button
            disabled={busy || blocked}
            onClick={() => void execute(pending.operation, pending)}
          >
            Recuperar mesma operação
          </button>
        </div>
      )}
      {status && <p role="status">{status}</p>}
    </section>
  )
})
