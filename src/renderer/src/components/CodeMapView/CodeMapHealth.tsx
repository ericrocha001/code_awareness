import React, { useRef, useState } from 'react'
import { Activity, AlertTriangle, CheckCircle2, DatabaseZap, Loader2, RefreshCw, ShieldCheck } from 'lucide-react'
import { Button } from '../shared/Button/Button'
import { Popover } from '../shared/Popover/Popover'
import './CodeMapHealth.css'

export type CodeMapHealthState = 'healthy' | 'updating' | 'issue'
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
  onVerifyIntegrity: () => void
  onShowIntegrityIssues: () => void
  onRebuild: () => void
}

const HEALTH_LABEL: Record<CodeMapHealthState, string> = {
  healthy: 'Healthy',
  updating: 'Updating',
  issue: 'Issue'
}

function formatStateTime(value: string | null): string {
  if (!value) return 'No completed sync yet'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

export const CodeMapHealth: React.FC<CodeMapHealthProps> = ({
  state,
  indexedAt,
  lastSyncAt,
  modifiedCount,
  integrityState,
  integrityIssueCount,
  isVerifying,
  isRebuilding,
  onVerifyIntegrity,
  onShowIntegrityIssues,
  onRebuild
}) => {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLButtonElement>(null)
  const StateIcon = state === 'healthy' ? CheckCircle2 : state === 'updating' ? Activity : AlertTriangle

  return (
    <>
      <Button
        ref={anchorRef}
        variant="pill"
        className={`cmh-trigger cmh-trigger--${state}`}
        icon={<StateIcon size={16} className={state === 'updating' ? 'cmv-spin' : undefined} />}
        chevron
        open={open}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={`Code Map Health: ${HEALTH_LABEL[state]}`}
      >
        {HEALTH_LABEL[state]}
      </Button>
      <Popover open={open} anchorRef={anchorRef} onClose={() => setOpen(false)} placement="bottom-end">
        <section className="cmh-panel" aria-label="Code Map Health details">
          <header className="cmh-header">
            <div>
              <strong>Code Map Health</strong>
              <span>{modifiedCount > 0 ? `${modifiedCount} change(s) settling` : 'Index is current'}</span>
            </div>
            <StateIcon size={18} className={`cmh-state-icon cmh-state-icon--${state}`} />
          </header>

          <dl className="cmh-details">
            <div><dt>Index</dt><dd>{indexedAt ? 'Ready' : 'Not indexed'}</dd></div>
            <div><dt>Auto-sync</dt><dd>Active</dd></div>
            <div><dt>Watcher</dt><dd>Active</dd></div>
            <div>
              <dt>Integrity</dt>
              <dd>{integrityState === 'unknown' ? 'Not checked' : integrityState === 'healthy' ? 'Healthy' : `${integrityIssueCount} issue(s)`}</dd>
            </div>
            <div><dt>Last state</dt><dd>{formatStateTime(lastSyncAt ?? indexedAt)}</dd></div>
          </dl>

          <div className="cmh-actions">
            <Button
              variant="ghost"
              icon={isVerifying ? <Loader2 size={16} className="cmv-spin" /> : <ShieldCheck size={16} />}
              onClick={onVerifyIntegrity}
              disabled={isVerifying}
            >
              {isVerifying ? 'Checking...' : 'Integrity Check'}
            </Button>
            {integrityIssueCount > 0 && (
              <Button variant="ghost" icon={<AlertTriangle size={16} />} onClick={onShowIntegrityIssues}>
                Review issues
              </Button>
            )}
          </div>

          <details className="cmh-advanced">
            <summary>Advanced</summary>
            <Button
              variant="ghost"
              icon={isRebuilding ? <Loader2 size={16} className="cmv-spin" /> : <DatabaseZap size={16} />}
              onClick={onRebuild}
              disabled={isRebuilding}
            >
              {isRebuilding ? 'Rebuilding...' : 'Rebuild Index'}
            </Button>
          </details>
        </section>
      </Popover>
    </>
  )
}
