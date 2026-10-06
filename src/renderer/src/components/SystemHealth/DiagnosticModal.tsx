import React, { useCallback, useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { SystemHealthState, CanonicalStageResult, StageStatus } from '../../../../shared/types/system-health-types'
import './DiagnosticModal.css'

interface DiagnosticModalProps {
  onClose: () => void
}

function badgeClass(status: StageStatus): string {
  switch (status) {
    case 'OPERATIONAL': return 'badge-operational'
    case 'FAILED': return 'badge-failed'
    case 'BLOCKED': return 'badge-blocked'
    default: return 'badge-unknown'
  }
}

function formatTs(iso: string | null | undefined): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

const stageLabel = (stage: string) => stage.replace('CodeScope', 'Code Navigation')

function StageRow({ result }: { result: CanonicalStageResult }) {
  return (
    <li className="diagnostic-stage">
      <div style={{ flex: 1 }}>
        <div className="diagnostic-stage-name">{stageLabel(result.stage)}</div>
        {(result.durationMs !== null || result.reasonCode) && (
          <div className="diagnostic-stage-detail">
            {result.durationMs !== null && `${result.durationMs}ms`}
            {result.durationMs !== null && result.reasonCode && ' — '}
            {result.reasonCode}
          </div>
        )}
      </div>
      <span className={`diagnostic-stage-badge ${badgeClass(result.status)}`}>{result.status}</span>
    </li>
  )
}

export function DiagnosticModal({ onClose }: DiagnosticModalProps) {
  const [state, setState] = useState<SystemHealthState | null>(null)
  const [copied, setCopied] = useState(false)
  const mounted = useRef(false)
  const dialog = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose() }
      if (event.key !== 'Tab') return
      const buttons = dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
      if (!buttons?.length) return
      const first = buttons[0], last = buttons[buttons.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', handleKey)
    return () => { document.removeEventListener('keydown', handleKey); previousFocus?.focus() }
  }, [onClose])

  useEffect(() => {
    mounted.current = true
    const unsubscribe = window.codeAwareness.onSystemHealthChanged((next) => {
      if (mounted.current) setState(next)
    })
    window.codeAwareness.getSystemHealthState().then((s) => {
      if (mounted.current) setState(s)
    }).catch(() => {})
    return () => { mounted.current = false; unsubscribe() }
  }, [])

  const handleCopy = useCallback(async () => {
    try {
      const report = await window.codeAwareness.getSystemHealthDiagnosticReport()
      await navigator.clipboard.writeText(report)
      setCopied(true)
      setTimeout(() => { if (mounted.current) setCopied(false) }, 2000)
    } catch {}
  }, [])

  const handleOverlayClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose()
  }, [onClose])

  const failure = state?.lastFailure ?? null
  const proof = state?.lastFunctionalProof ?? null
  const stages = failure?.stages ?? null

  return (
    <div ref={dialog} className="diagnostic-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="diag-title" onClick={handleOverlayClick}>
      <div className="diagnostic-modal">
        <div className="diagnostic-modal-header">
          <div>
            <h2 id="diag-title">System Health — Code Navigation</h2>
            <p>
              Estado: <strong>{state?.status ?? '…'}</strong>
              {state?.stale && ' (evidência desatualizada)'}
            </p>
          </div>
          <button type="button" className="diagnostic-modal-close" onClick={onClose} aria-label="Fechar diagnóstico"><X size={18} /></button>
        </div>

        <div className="diagnostic-modal-body">
          {!state && <p className="diagnostic-empty">Carregando diagnóstico…</p>}

          {state && (
            <>
              <div className="diagnostic-section">
                <h3>Última operação funcional</h3>
                {proof ? (
                  <dl className="diagnostic-meta">
                    <dt>Operação</dt><dd>{proof.operation}</dd>
                    <dt>Trace ID</dt><dd>{proof.traceId}</dd>
                    <dt>Horário</dt><dd>{formatTs(proof.at)}</dd>
                    <dt>Duração</dt><dd>{proof.durationMs}ms</dd>
                  </dl>
                ) : (
                  <p className="diagnostic-empty">Nenhuma prova funcional nesta sessão.</p>
                )}
              </div>

              {failure && (
                <>
                  <div className="diagnostic-section">
                    <h3>Última falha</h3>
                    <dl className="diagnostic-meta">
                      <dt>Operação</dt><dd>{failure.operation}</dd>
                      <dt>Trace ID</dt><dd>{failure.traceId}</dd>
                      <dt>Horário</dt><dd>{formatTs(failure.at)}</dd>
                    </dl>
                  </div>

                  {failure.firstFailedBoundary && (
                    <div className="diagnostic-section">
                      <div className="diagnostic-failure-summary">
                        <strong>Primeira fronteira falha: {stageLabel(failure.firstFailedBoundary)}</strong>
                        {failure.reasonCode && <span>Motivo: {failure.reasonCode}</span>}
                        {failure.lastSuccessfulStage && (
                          <><br /><span>Última etapa saudável: {stageLabel(failure.lastSuccessfulStage)}</span></>
                        )}
                      </div>
                    </div>
                  )}
                </>
              )}

              {stages && (
                <div className="diagnostic-section">
                  <h3>Pipeline</h3>
                  <ul className="diagnostic-pipeline">
                    {stages.map((s) => <StageRow key={s.stage} result={s} />)}
                  </ul>
                </div>
              )}

              {!failure && !stages && proof && (
                <div className="diagnostic-section">
                  <h3>Pipeline</h3>
                  <p className="diagnostic-empty">Todas as etapas operacionais na última prova funcional.</p>
                </div>
              )}
            </>
          )}
        </div>

        <div className="diagnostic-modal-footer">
          <button type="button" className="diagnostic-copy-btn" onClick={handleCopy}>
            {copied ? 'Copiado!' : 'Copiar diagnóstico'}
          </button>
          <button type="button" className="diagnostic-close-btn" onClick={onClose}>Fechar</button>
        </div>
      </div>
    </div>
  )
}
