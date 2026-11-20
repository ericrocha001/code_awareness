import React, { useState, useEffect, useRef } from 'react'
import { Wrench, RefreshCw, CheckCircle2, AlertCircle, ChevronDown, ChevronRight } from 'lucide-react'
import { Popover } from '../shared/Popover/Popover'
import type { DevSyncAvailability, DevSyncResult } from '../../../../main/dev-sync/dev-sync-types'
import './DevelopmentMenu.css'

interface DevelopmentMenuProps {
  isSidebarOpen: boolean
}

export const DevelopmentMenu: React.FC<DevelopmentMenuProps> = ({ isSidebarOpen }) => {
  const [availability, setAvailability] = useState<DevSyncAvailability | null>(null)
  const [open, setOpen] = useState(false)
  const [isSyncing, setIsSyncing] = useState(false)
  const [syncStatusText, setSyncStatusText] = useState<string | null>(null)
  const [syncResult, setSyncResult] = useState<DevSyncResult | null>(null)
  const [showErrorDetails, setShowErrorDetails] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    let mounted = true
    if (window.codeAwareness?.getDevSyncStatus) {
      window.codeAwareness.getDevSyncStatus()
        .then((res) => {
          if (mounted) {
            setAvailability(res)
            if (res?.lastResult) {
              setSyncResult(res.lastResult)
            }
          }
        })
        .catch(() => {
          if (mounted) setAvailability(null)
        })
    }
    return () => { mounted = false }
  }, [])

  const handleOpen = () => {
    setOpen((prev) => {
      const next = !prev
      if (next && window.codeAwareness?.getDevSyncStatus) {
        window.codeAwareness.getDevSyncStatus().then((fresh) => {
          setAvailability(fresh)
          if (fresh?.lastResult) setSyncResult(fresh.lastResult)
        }).catch(() => {})
      }
      return next
    })
  }

  // Se DevSync não estiver disponível, renderiza botão clássico do DevTools (para modo produção / fallback)
  if (!availability?.available) {
    return (
      <button
        className="global-sidebar-footer-btn global-sidebar-devtools-btn"
        onClick={() => window.codeAwareness.toggleDevTools()}
        aria-label="Abrir DevTools"
        title="Abrir DevTools (F12)"
      >
        <span className="global-sidebar-nav-icon" aria-hidden="true">
          <Wrench size={18} strokeWidth={2} />
        </span>
        <span className="global-sidebar-nav-label">DevTools</span>
      </button>
    )
  }

  const handleDevSyncClick = async () => {
    if (isSyncing) return
    setIsSyncing(true)
    setSyncStatusText('Sincronizando...')
    setShowErrorDetails(false)
    try {
      const result = await window.codeAwareness.requestDevSync()
      setSyncResult(result)
      if (result.status === 'SCHEDULED') {
        setSyncStatusText('Reiniciando runtime...')
      } else {
        setSyncStatusText(null)
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      setSyncResult({
        operationId: 'local-err',
        status: 'FAILED',
        message
      })
      setSyncStatusText(null)
    } finally {
      setIsSyncing(false)
    }
  }

  const handleDevToolsClick = () => {
    window.codeAwareness.toggleDevTools()
    setOpen(false)
  }

  return (
    <>
      <button
        ref={buttonRef}
        className="global-sidebar-footer-btn global-sidebar-devmenu-btn"
        onClick={handleOpen}
        aria-label="Menu Development"
        aria-haspopup="true"
        aria-expanded={open}
        title="Development (DevSync e Ferramentas)"
      >
        <span className="global-sidebar-nav-icon" aria-hidden="true">
          <Wrench size={18} strokeWidth={2} />
        </span>
        <span className="global-sidebar-nav-label">Development</span>
      </button>

      <Popover
        open={open}
        anchorRef={buttonRef}
        onClose={() => setOpen(false)}
        placement="top-start"
      >
        <div className="dev-menu-container" role="menu" aria-label="Opções de Desenvolvimento">
          <div className="dev-menu-header">
            <span className="dev-menu-title">Desenvolvimento</span>
            {availability.branch && (
              <span className="dev-menu-branch" title={`Branch: ${availability.branch}`}>
                {availability.branch}
              </span>
            )}
          </div>

          {/* Banner de resultado anterior ou concluído */}
          {syncResult?.status === 'COMPLETED' && (
            <div className="dev-menu-banner dev-menu-banner--success" role="status">
              <CheckCircle2 size={15} className="dev-menu-banner-icon" />
              <div className="dev-menu-banner-text">
                <div>DevSync concluído ({syncResult.head?.slice(0, 7) || 'atualizado'})</div>
                <div className="dev-menu-banner-sub">Se necessário, execute "Atualizar ações" no ChatGPT.</div>
              </div>
            </div>
          )}

          {syncResult?.status === 'ALREADY_CURRENT' && (
            <div className="dev-menu-banner dev-menu-banner--info" role="status">
              <CheckCircle2 size={15} className="dev-menu-banner-icon" />
              <div className="dev-menu-banner-text">
                <div>Já atualizado com upstream</div>
                <div className="dev-menu-banner-sub">HEAD: {syncResult.head?.slice(0, 7) || availability.head?.slice(0, 7)}</div>
              </div>
            </div>
          )}

          {syncResult && ['FAILED', 'PARTIAL', 'DIRTY_WORKTREE', 'AHEAD_OR_DIVERGED', 'DETACHED_HEAD', 'UPSTREAM_UNAVAILABLE', 'EXPECTED_COMMIT_NOT_INTEGRATED'].includes(syncResult.status) && (
            <div className="dev-menu-banner dev-menu-banner--error" role="alert">
              <AlertCircle size={15} className="dev-menu-banner-icon" />
              <div className="dev-menu-banner-text">
                <div className="dev-menu-banner-error-msg">{syncResult.message}</div>
                {syncResult.details && (
                  <button
                    type="button"
                    className="dev-menu-details-toggle"
                    onClick={() => setShowErrorDetails(!showErrorDetails)}
                  >
                    {showErrorDetails ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Detalhes técnicos
                  </button>
                )}
                {showErrorDetails && syncResult.details && (
                  <pre className="dev-menu-error-pre">
                    {JSON.stringify(syncResult.details, null, 2)}
                  </pre>
                )}
              </div>
            </div>
          )}

          <div className="dev-menu-actions">
            {/* Ação Primária: DevSync */}
            <button
              type="button"
              className="dev-menu-action-btn dev-menu-action-btn--primary"
              onClick={handleDevSyncClick}
              disabled={isSyncing}
              role="menuitem"
            >
              <RefreshCw size={16} className={`dev-menu-action-icon ${isSyncing ? 'dev-menu-spin' : ''}`} />
              <div className="dev-menu-action-content">
                <div className="dev-menu-action-label">
                  {syncStatusText || 'DevSync'}
                </div>
                <div className="dev-menu-action-desc">
                  Sincronizar código e reiniciar runtime
                </div>
              </div>
            </button>

            <div className="dev-menu-divider" />

            {/* Ação Secundária: Chromium DevTools */}
            <button
              type="button"
              className="dev-menu-action-btn"
              onClick={handleDevToolsClick}
              role="menuitem"
            >
              <Wrench size={16} className="dev-menu-action-icon" />
              <div className="dev-menu-action-content">
                <div className="dev-menu-action-label">Chromium DevTools</div>
                <div className="dev-menu-action-desc">Inspecionar UI e Console (F12)</div>
              </div>
            </button>
          </div>
        </div>
      </Popover>
    </>
  )
}
