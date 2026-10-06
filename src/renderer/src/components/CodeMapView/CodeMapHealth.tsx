import React, { useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, ChevronRight, Clock3, DatabaseZap, Loader2, ShieldCheck } from 'lucide-react'
import { Button } from '../shared/Button/Button'
import { Popover } from '../shared/Popover/Popover'
import { CodeMapRebuildConfirmation } from './CodeMapRebuildConfirmation'
import './CodeMapHealth.css'

export type CodeMapHealthState = 'healthy' | 'updating' | 'pending' | 'issue'
export type CodeMapIntegrityState = 'unknown' | 'healthy' | 'issue'

interface CodeMapHealthProps {
  state: CodeMapHealthState
  indexedAt: string | null
  lastSyncAt: string | null
  modifiedCount: number
  integrityState: CodeMapIntegrityState
  integrityIssueCount: number
  isVerifying: boolean
  isRebuilding: boolean
  operationError?: string | null
  onVerifyIntegrity: () => void
  onShowIntegrityIssues: () => void
  onRebuild: () => void
}

const HEALTH_LABEL: Record<CodeMapHealthState, string> = {
  healthy: 'Healthy', updating: 'Working', pending: 'Pending', issue: 'Issue'
}

function formatStateTime(value: string | null): string {
  if (!value) return 'Sem registro'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Sem registro' : date.toLocaleString('pt-BR')
}

export const CodeMapHealth: React.FC<CodeMapHealthProps> = ({
  state, indexedAt, lastSyncAt, modifiedCount, integrityState, integrityIssueCount,
  isVerifying, isRebuilding, operationError, onVerifyIntegrity, onShowIntegrityIssues, onRebuild
}) => {
  const [open, setOpen] = useState(false)
  const [confirmRebuild, setConfirmRebuild] = useState(false)
  const anchorRef = useRef<HTMLButtonElement>(null)
  const working = isVerifying || isRebuilding
  const StateIcon = working ? Loader2 : state === 'healthy' ? CheckCircle2 : state === 'pending' ? Clock3 : AlertTriangle
  const summary = isRebuilding ? 'Reconstruindo índice...' : isVerifying ? 'Verificando integridade...'
    : operationError ? 'Não foi possível concluir a operação' : integrityState === 'issue' ? 'Problemas de integridade encontrados'
    : modifiedCount > 0 ? `${modifiedCount} ${modifiedCount === 1 ? 'alteração pendente' : 'alterações pendentes'}` : 'Índice atualizado'

  return (
    <>
      <Button ref={anchorRef} variant="pill" className={`cmh-trigger cmh-trigger--${state}`}
        icon={<StateIcon size={16} className={working ? 'cmv-spin' : undefined} />}
        chevron open={open} onClick={() => setOpen(value => !value)} aria-expanded={open}
        aria-label={`Code Map Health: ${HEALTH_LABEL[state]}`}>
        {HEALTH_LABEL[state]}
      </Button>
      <Popover open={open} anchorRef={anchorRef} onClose={() => setOpen(false)} placement="bottom-end">
        <section className={`cmh-panel cmh-panel--${state}`} aria-label="Saúde do CodeMap">
          <header className="cmh-header">
            <div><strong>Saúde do CodeMap</strong><span aria-live="polite">{summary}</span></div>
            <StateIcon size={20} className={`cmh-state-icon cmh-state-icon--${state}${working ? ' cmv-spin' : ''}`} />
          </header>
          {operationError && <p className="cmh-error" role="alert">{operationError}</p>}
          <dl className="cmh-details">
            <div><dt>Índice</dt><dd className={indexedAt ? 'cmh-value--healthy' : undefined}>{indexedAt ? 'Pronto' : 'Não indexado'}</dd></div>
            <div><dt>Sincronização automática</dt><dd>Ativa</dd></div>
            <div><dt>Watcher</dt><dd>Ativo</dd></div>
            <div><dt>Integridade</dt><dd className={`cmh-value--${integrityState}`}>
              {integrityState === 'unknown' ? 'Não verificada' : integrityState === 'healthy' ? 'Saudável' : `${integrityIssueCount} problema(s)`}
            </dd></div>
            <div><dt>Último estado</dt><dd className="cmh-time">{formatStateTime(lastSyncAt ?? indexedAt)}</dd></div>
          </dl>
          <div className="cmh-actions">
            <Button variant="ghost" className="cmh-action" icon={isVerifying ? <Loader2 size={20} className="cmv-spin" /> : <ShieldCheck size={20} />}
              onClick={() => { setOpen(false); onVerifyIntegrity() }} disabled={working}>
              <span><strong>{isVerifying ? 'Verificando integridade...' : 'Verificar integridade'}</strong>
                <small>Confere arquivos, hashes, relacionamentos e consistência do índice.</small></span>
            </Button>
            {integrityIssueCount > 0 && (
              <Button variant="ghost" className="cmh-action cmh-action--issue" icon={<AlertTriangle size={20} />}
                onClick={() => { setOpen(false); onShowIntegrityIssues() }} disabled={working}>
                <span><strong>Revisar inconsistências</strong><small>{integrityIssueCount} problema(s) encontrado(s)</small></span>
              </Button>
            )}
          </div>
          <details className="cmh-advanced">
            <summary><ChevronRight size={15} />Avançado</summary>
            <Button variant="ghost" className="cmh-action cmh-action--rebuild" icon={<DatabaseZap size={19} />}
              onClick={() => { setOpen(false); setConfirmRebuild(true) }} disabled={working}>
              <span><strong>Reconstruir índice</strong><small>Reconstrói completamente o índice estrutural do repositório.</small></span>
            </Button>
            <p>Use apenas quando uma reconstrução completa for necessária.</p>
          </details>
        </section>
      </Popover>
      {confirmRebuild && <CodeMapRebuildConfirmation returnFocusRef={anchorRef}
        onCancel={() => setConfirmRebuild(false)}
        onConfirm={() => { setConfirmRebuild(false); onRebuild() }} />}
    </>
  )
}
