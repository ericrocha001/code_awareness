/*
-T ---
*/

import React from 'react'
import type { CodeMapRepository } from '../../../../shared/types'

interface CodeMapOverviewProps {
  /** Registro do repositório; pode ser null quando o projeto ainda não foi indexado. */
  repository: CodeMapRepository | null
  /** Total de arquivos indexados; deve ser ≥ 0. */
  fileCount: number
  /** Total de elementos extraídos; deve ser ≥ 0. */
  elementCount: number
  /** Total de arquivos modificados; deve ser ≥ 0. Exibido em âmbar quando > 0. */
  modifiedCount: number
  /** true quando o repositório nunca foi indexado (repository null ou lastIndexedAt null). */
  neverIndexed: boolean
  /** Carimbo ISO da última sincronização bem-sucedida; null quando nunca sincronizado. */
  lastSyncAt: string | null
}

/** Formata uma string ISO em pt-BR, retornando o fallback quando ausente ou inválida. */
function formatDate(isoString: string | null | undefined, fallback: string): string {
  if (!isoString) return fallback
  const date = new Date(isoString)
  return isNaN(date.getTime()) ? fallback : date.toLocaleString('pt-BR')
}

export const CodeMapOverview: React.FC<CodeMapOverviewProps> = ({
  repository,
  fileCount,
  elementCount,
  modifiedCount,
  neverIndexed,
  lastSyncAt
}) => {
  // BUGFIX: data inválida (ex: "invalid-date") faria new Date() retornar Invalid Date,
  // exibindo "Invalid Date" ao usuário. Valida antes de formatar.
  const lastIndexedLabel = (() => {
    if (neverIndexed || !repository?.lastIndexedAt) return 'Nunca indexado'
    const date = new Date(repository.lastIndexedAt)
    return isNaN(date.getTime()) ? 'Nunca indexado' : date.toLocaleString('pt-BR')
  })()

  // Última sincronização: usa lastSyncAt; fallback para a data de indexação (repositórios antigos)
  const lastSyncLabel = formatDate(lastSyncAt ?? repository?.lastIndexedAt, 'Nunca sincronizado')

  return (
    <div className="cmv-overview">
      <h2 className="cmv-overview-title">{repository?.name ?? 'Repositório'}</h2>

      <div className="cmv-overview-stats">
        <div className="cmv-overview-stat">
          <span className="cmv-overview-stat-value">{fileCount}</span>
          <span className="cmv-overview-stat-label">arquivo(s)</span>
        </div>
        <div className="cmv-overview-stat">
          <span className="cmv-overview-stat-value">{elementCount}</span>
          <span className="cmv-overview-stat-label">elemento(s)</span>
        </div>
        <div className="cmv-overview-stat">
          <span
            className={`cmv-overview-stat-value${modifiedCount > 0 ? ' cmv-overview-stat-value--modified' : ''}`}
          >
            {modifiedCount}
          </span>
          <span className="cmv-overview-stat-label">modificado(s)</span>
        </div>
      </div>

      <div className="cmv-overview-footer">
        <span className="cmv-overview-label">Última indexação</span>
        <span className="cmv-overview-value">{lastIndexedLabel}</span>
      </div>
      <div className="cmv-overview-footer">
        <span className="cmv-overview-label">Última sincronização</span>
        <span className="cmv-overview-value">{lastSyncLabel}</span>
      </div>
    </div>
  )
}