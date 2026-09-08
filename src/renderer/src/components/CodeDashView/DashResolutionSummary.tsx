import React, { useMemo } from 'react'
import {
  AlertTriangle,
  Archive,
  FileCode,
  XCircle
} from 'lucide-react'
import type {
  DashFailureReason,
  DashItem,
  DashResolutionReport
} from '../../../../shared/types/dash-types'
import './DashResolutionSummary.css'

export interface DashResolutionSummaryProps {
  report: DashResolutionReport
}

const FAILURE_REASON_LABELS: Record<DashFailureReason, string> = {
  not_found: 'Arquivo não encontrado',
  ambiguous: 'Caminho ambíguo (múltiplos arquivos)',
  path_traversal: 'Tentativa de path traversal bloqueada',
  absolute_path: 'Caminho absoluto não permitido',
  invalid_path: 'Caminho inválido',
  invalid_representation: 'Representação inválida',
  invalid_format: 'Formato de saída inválido',
  unknown_protocol: 'Versão de protocolo desconhecida',
  unknown_field: 'Campo desconhecido no schema',
  duplicate_item: 'Item duplicado',
  empty_items: 'Lista de arquivos vazia',
  invalid_json: 'JSON malformado'
}

export const DashResolutionSummary: React.FC<DashResolutionSummaryProps> = ({
  report
}) => {
  const resolvedItems = useMemo<DashItem[]>(() => {
    return report.request?.items ?? []
  }, [report.request])

  const sourceItems = useMemo(() => {
    return resolvedItems.filter((it) => it.representation === 'source')
  }, [resolvedItems])

  const compressionItems = useMemo(() => {
    return resolvedItems.filter((it) => it.representation === 'compression')
  }, [resolvedItems])

  const failures = report.failures ?? []

  const totalRequested = resolvedItems.length + failures.length
  const totalResolved = resolvedItems.length
  const totalFailed = failures.length

  const isAllResolved = totalFailed === 0 && totalResolved > 0

  return (
    <div className="dash-summary-container">
      <div className="dash-summary-header">
        <div className="dash-summary-title-group">
          <h3 className="dash-summary-title">Resumo da Resolução</h3>
          <span className="dash-summary-counts">
            {totalRequested} {totalRequested === 1 ? 'item solicitado' : 'itens solicitados'} ·{' '}
            {totalResolved} {totalResolved === 1 ? 'resolvido' : 'resolvidos'} ·{' '}
            {totalFailed} não {totalFailed === 1 ? 'resolvido' : 'resolvidos'}
          </span>
        </div>

        {isAllResolved ? (
          <span className="dash-status-ok">Todos Resolvidos</span>
        ) : (
          <div className="dash-status-badge warning">
            <AlertTriangle size={14} />
            <span>Resolução Parcial</span>
          </div>
        )}
      </div>

      <div className="dash-summary-sections">
        {/* Seção SOURCE */}
        {sourceItems.length > 0 && (
          <div className="dash-section-block">
            <div className="dash-section-header">
              <FileCode size={14} />
              <span>
                Source ({sourceItems.length})
              </span>
            </div>
            <ul className="dash-item-list">
              {sourceItems.map((item, idx) => (
                <li key={`source-${item.path}-${idx}`} className="dash-item-row">
                  <span className="dash-item-path">{item.path}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Seção COMPRESSION */}
        {compressionItems.length > 0 && (
          <div className="dash-section-block">
            <div className="dash-section-header">
              <Archive size={14} />
              <span>
                Compression ({compressionItems.length})
              </span>
            </div>
            <ul className="dash-item-list">
              {compressionItems.map((item, idx) => (
                <li
                  key={`compression-${item.path}-${idx}`}
                  className="dash-item-row"
                >
                  <span className="dash-item-path">{item.path}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Seção UNRESOLVED */}
        {failures.length > 0 && (
          <div className="dash-section-block">
            <div className="dash-section-header unresolved">
              <XCircle size={14} />
              <span>
                Não Resolvidos ({failures.length})
              </span>
            </div>
            <ul className="dash-item-list">
              {failures.map((fail, idx) => (
                <li key={`fail-${fail.path}-${idx}`} className="dash-item-row">
                  <span className="dash-item-path">{fail.path}</span>
                  <span className="dash-item-reason">
                    {FAILURE_REASON_LABELS[fail.reason] || fail.reason}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}
