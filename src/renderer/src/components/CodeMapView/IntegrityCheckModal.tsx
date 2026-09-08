/*
-T ---
*/

import React, { useState, useMemo, useEffect } from 'react'
import {
  AlertTriangle,
  Info,
  X,
  Loader2,
  Wrench,
  Download,
  ChevronDown,
  ChevronRight,
  CheckSquare,
  Square
} from 'lucide-react'
import type { IntegrityIssue, IntegrityRepairResult, IntegrityCheckResult } from '../../../../shared/types'
import { buildIntegrityReportMarkdown } from '../../utils/integrity-report'
import './IntegrityCheckModal.css'

export interface IntegrityCheckModalProps {
  isOpen: boolean
  onClose: () => void
  issues: IntegrityIssue[]
  repoPath: string
  onRepairComplete: (repairResult?: IntegrityRepairResult) => void
  collapsedGroups?: Set<string>
  onCollapsedGroupsChange?: (groups: Set<string>) => void
  onStatusMessage?: (message: string, isError?: boolean) => void
  checkResult?: IntegrityCheckResult
}

const TYPE_LABELS: Record<string, string> = {
  hash_mismatch: 'Hash Mismatch (Divergência no Conteúdo)',
  file_missing: 'File Missing (Arquivo Ausente no Disco)',
  file_unexpected: 'File Unexpected (Arquivo Novo Não Indexado)',
  orphan_element: 'Orphan Element (Elemento Sem Arquivo Pai)',
  invalid_relationship: 'Invalid Relationship (Relacionamento Quebrado)',
  database_inconsistency: 'Database Inconsistency (Inconsistência Interna)'
}

export const IntegrityCheckModal: React.FC<IntegrityCheckModalProps> = ({
  isOpen,
  onClose,
  issues,
  repoPath,
  onRepairComplete,
  collapsedGroups: collapsedGroupsProp,
  onCollapsedGroupsChange,
  onStatusMessage,
  checkResult
}) => {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [localCollapsedGroups, setLocalCollapsedGroups] = useState<Set<string>>(new Set())
  const [isRepairing, setIsRepairing] = useState(false)
  const [repairError, setRepairError] = useState<string | null>(null)
  const [isExporting, setIsExporting] = useState(false)
  const [lastRepairResult, setLastRepairResult] = useState<IntegrityRepairResult | undefined>(undefined)

  // Colapso: controlado pelo pai (persistido entre aberturas) ou local como fallback
  const collapsedGroups = collapsedGroupsProp ?? localCollapsedGroups
  const updateCollapsedGroups = (next: Set<string>): void => {
    if (onCollapsedGroupsChange) {
      onCollapsedGroupsChange(next)
    } else {
      setLocalCollapsedGroups(next)
    }
  }

  // Recarrega seleção padrão (todos selecionados) ao abrir ou receber novas issues
  useEffect(() => {
    if (isOpen) {
      const allIds = new Set(issues.map((issue, idx) => issue.id || issue.target || `issue-${idx}`))
      setSelectedIds(allIds)
      setIsRepairing(false)
      setRepairError(null)
      // Reset do resultado de reparação da sessão anterior ao abrir com novas issues
      setLastRepairResult(undefined)
    }
  }, [isOpen, issues])

  // Agrupa issues por tipo
  const groupedIssues = useMemo(() => {
    const map = new Map<string, IntegrityIssue[]>()
    for (const issue of issues) {
      const list = map.get(issue.type) || []
      list.push(issue)
      map.set(issue.type, list)
    }
    return map
  }, [issues])

  if (!isOpen) return null

  const getIssueId = (issue: IntegrityIssue, index: number): string => {
    return issue.id || issue.target || `issue-${index}`
  }

  const toggleSelectAll = () => {
    if (selectedIds.size === issues.length) {
      setSelectedIds(new Set())
    } else {
      const allIds = new Set(issues.map((issue, idx) => getIssueId(issue, idx)))
      setSelectedIds(allIds)
    }
  }

  const toggleGroupSelect = (groupType: string, groupList: IntegrityIssue[]) => {
    const groupIds = groupList.map((issue, idx) => getIssueId(issue, idx))
    const allSelected = groupIds.every(id => selectedIds.has(id))

    setSelectedIds(prev => {
      const next = new Set(prev)
      if (allSelected) {
        groupIds.forEach(id => next.delete(id))
      } else {
        groupIds.forEach(id => next.add(id))
      }
      return next
    })
  }

  const toggleIssueSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const toggleGroupCollapse = (groupType: string) => {
    const next = new Set(collapsedGroups)
    if (next.has(groupType)) {
      next.delete(groupType)
    } else {
      next.add(groupType)
    }
    updateCollapsedGroups(next)
  }

  const handleRepair = async () => {
    if (selectedIds.size === 0 || isRepairing) return

    // Confirma antes de reparar órfãos — a reparação requer reindexação completa do repositório
    const hasOrphansSelected = Array.from(selectedIds).some(id => id.startsWith('orphan_element:'))
    if (hasOrphansSelected) {
      const confirmed = window.confirm(
        'A reparação de elementos órfãos requer reindexação completa do repositório. ' +
          'Isso pode levar vários minutos. Deseja continuar?'
      )
      if (!confirmed) return
    }

    setIsRepairing(true)
    setRepairError(null)

    try {
      // Extrai as issues selecionadas do agrupamento para a reparação cirúrgica,
      // evitando que o backend redescubra inconsistências já conhecidas.
      const selectedIssues: IntegrityIssue[] = []
      for (const groupList of groupedIssues.values()) {
        groupList.forEach((issue, index) => {
          if (selectedIds.has(getIssueId(issue, index))) {
            selectedIssues.push(issue)
          }
        })
      }

      const result = await window.codeAwareness.verifyIntegrity(repoPath, {
        autoRepair: true,
        selectedIssues: Array.from(selectedIds),
        issues: selectedIssues
      })

      if (!result.success) {
        setRepairError(result.error || 'Erro ao executar reparação')
        return
      }

      if (result.data?.repairResult) {
        setLastRepairResult(result.data.repairResult)
      }
      onRepairComplete(result.data?.repairResult)
      onClose()
    } catch (err) {
      setRepairError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsRepairing(false)
    }
  }

  const handleExport = async () => {
    if (isExporting) return

    setIsExporting(true)
    try {
      const projectName = repoPath.split('/').pop() || 'projeto'
      const now = new Date()
      const pad = (n: number) => String(n).padStart(2, '0')
      const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`

      const markdown = buildIntegrityReportMarkdown({
        projectName,
        repoPath,
        // Quando checkResult é fornecido pelo CodeMapView, usa as métricas reais
        // (filesChecked, hashesChecked, durationMs, contagens agregadas). Caso contrário,
        // deriva contagens por tipo a partir das issues exibidas (fallback para dados parciais).
        checkResult: checkResult ?? {
          status: issues.length === 0 ? 'healthy' : 'inconsistent',
          filesChecked: 0,
          hashesChecked: 0,
          hashesMismatched: issues.filter(i => i.type === 'hash_mismatch').length,
          filesMissing: issues.filter(i => i.type === 'file_missing').length,
          filesUnexpected: issues.filter(i => i.type === 'file_unexpected').length,
          orphanElements: issues.filter(i => i.type === 'orphan_element').length,
          invalidRelationships: issues.filter(i => i.type === 'invalid_relationship').length,
          databaseInconsistencies: issues.filter(i => i.type === 'database_inconsistency').length,
          details: issues,
          durationMs: 0
        },
        repairResult: lastRepairResult,
        generatedAt: now.toISOString()
      })

      // Sanitiza o nome do projeto para evitar caracteres inválidos em sistemas de arquivo
      const safeProjectName = projectName.replace(/[/\\:*?"<>|]/g, '_')
      // Envia o nome-base e o formato; o backend deriva a extensão (fonte única).
      const fileName = `integridade_${safeProjectName}_${timestamp}`

      const result = await window.codeAwareness.saveToDownloads(markdown, fileName, 'markdown')

      if (result.success && result.filePath) {
        if (onStatusMessage) {
          onStatusMessage(`✓ Relatório exportado: ${result.filePath}`, false)
        } else {
          console.log('Relatório exportado:', result.filePath)
        }
      } else if (onStatusMessage) {
        onStatusMessage(`Falha ao exportar relatório: ${result.error ?? 'erro desconhecido'}`, true)
      } else {
        console.error('Falha ao exportar relatório:', result.error)
      }
    } catch (err) {
      if (onStatusMessage) {
        onStatusMessage(`Erro ao exportar relatório: ${err instanceof Error ? err.message : String(err)}`, true)
      } else {
        console.error('Erro ao exportar relatório:', err)
      }
    } finally {
      setIsExporting(false)
    }
  }

  const allSelected = issues.length > 0 && selectedIds.size === issues.length
  const someSelected = selectedIds.size > 0 && selectedIds.size < issues.length

  return (
    <div className="icm-overlay" onClick={onClose} data-testid="integrity-modal-overlay">
      <div
        className="icm-modal"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="icm-title"
      >
        <div className="icm-header">
          <div className="icm-header-title" id="icm-title">
            <AlertTriangle className="icm-header-icon" size={20} />
            <span>Inconsistências Encontradas ({issues.length})</span>
          </div>
          <button
            className="icm-close-btn"
            onClick={onClose}
            disabled={isRepairing}
            aria-label="Fechar"
          >
            <X size={18} />
          </button>
        </div>

        <div className="icm-body">
          <div className="icm-summary-bar">
            <span>
              <span className="icm-summary-count">{selectedIds.size}</span> de {issues.length} problema(s) selecionado(s)
              {(checkResult?.staleHealed ?? 0) > 0 && (
                <span className="icm-summary-subtext">
                  Estados obsoletos curados: {checkResult.staleHealed}
                </span>
              )}
            </span>
            <div
              className="icm-select-all-toggle"
              onClick={toggleSelectAll}
              role="button"
              tabIndex={0}
            >
              {allSelected ? (
                <CheckSquare size={16} />
              ) : someSelected ? (
                <CheckSquare size={16} style={{ opacity: 0.6 }} />
              ) : (
                <Square size={16} />
              )}
              <span>{allSelected ? 'Desmarcar todos' : 'Selecionar todos'}</span>
            </div>
          </div>

          {repairError && (
            <div className="icm-badge error icm-repair-error">
              {repairError}
            </div>
          )}

          {Array.from(groupedIssues.entries()).map(([groupType, groupList]) => {
            const isCollapsed = collapsedGroups.has(groupType)
            const groupIds = groupList.map((issue, idx) => getIssueId(issue, idx))
            const isGroupAllSelected = groupIds.every(id => selectedIds.has(id))
            const isGroupSomeSelected = groupIds.some(id => selectedIds.has(id)) && !isGroupAllSelected

            return (
              <div key={groupType} className="icm-group">
                <div className="icm-group-header">
                  <div
                    className="icm-group-title"
                    onClick={() => toggleGroupCollapse(groupType)}
                  >
                    {isCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                    <span>{TYPE_LABELS[groupType] || groupType}</span>
                    {groupType === 'orphan_element' && (
                      <span
                        className="icm-info-icon"
                        title="Devido a limitações do contrato, a reparação de elementos órfãos requer reindexação completa do repositório"
                      >
                        <Info size={14} />
                      </span>
                    )}
                    <span className="icm-badge warning">{groupList.length}</span>
                  </div>

                  <div className="icm-group-actions">
                    <div
                      className="icm-select-all-toggle"
                      onClick={e => {
                        e.stopPropagation()
                        toggleGroupSelect(groupType, groupList)
                      }}
                      role="checkbox"
                      aria-checked={isGroupAllSelected}
                    >
                      {isGroupAllSelected ? (
                        <CheckSquare size={16} />
                      ) : isGroupSomeSelected ? (
                        <CheckSquare size={16} style={{ opacity: 0.6 }} />
                      ) : (
                        <Square size={16} />
                      )}
                    </div>
                  </div>
                </div>

                {!isCollapsed && (
                  <div className="icm-issue-list">
                    {groupList.map((issue, idx) => {
                      const id = getIssueId(issue, idx)
                      const isChecked = selectedIds.has(id)
                      return (
                        <div key={id} className="icm-issue-item">
                          <input
                            type="checkbox"
                            className="icm-checkbox"
                            checked={isChecked}
                            onChange={() => toggleIssueSelect(id)}
                            disabled={isRepairing}
                            id={`issue-check-${id}`}
                          />
                          <label htmlFor={`issue-check-${id}`} className="icm-issue-content" style={{ cursor: 'pointer' }}>
                            <span className="icm-issue-target">{issue.target}</span>
                            <span className="icm-issue-desc">{issue.description}</span>
                          </label>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>

        <div className="icm-footer">
          <button
            className="app-ghost-btn"
            onClick={onClose}
            disabled={isRepairing}
          >
            Cancelar
          </button>
          <button
            className="app-ghost-btn"
            onClick={handleExport}
            disabled={isRepairing || isExporting}
          >
            {isExporting ? (
              <>
                <Loader2 size={16} className="icm-spin" />
                <span>Exportando...</span>
              </>
            ) : (
              <>
                <Download size={16} />
                <span>Exportar relatório</span>
              </>
            )}
          </button>
          <button
            className="app-pill-btn primary"
            onClick={handleRepair}
            disabled={selectedIds.size === 0 || isRepairing}
          >
            {isRepairing ? (
              <>
                <Loader2 size={16} className="icm-spin" />
                <span>Corrigindo...</span>
              </>
            ) : (
              <>
                <Wrench size={16} />
                <span>Corrigir Selecionados ({selectedIds.size})</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
