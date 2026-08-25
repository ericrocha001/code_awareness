/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Renderizar o resumo do repositório na zona de leitura (nome, contagens, última indexação e última sincronização).
2. Exibir a contagem de arquivos modificados em âmbar quando maior que zero.
3. Exibir o carimbo de última sincronização com fallback para a data de indexação em repositórios antigos.

Mapa de Relacionamentos do Script

1. CodeMapView.tsx
   - Tipo: Dependência Inversa
   - Relação: É instanciado pelo orquestrador com as props de resumo do repositório.
   - Criticidade: Alta

2. ../../../../shared/types
   - Tipo: Contrato / Interface
   - Relação: Fornece o tipo CodeMapRepository.
   - Criticidade: Alta

3. CodeMapView.css
   - Tipo: Relação de UI
   - Relação: Consome as classes com prefixo cmv-overview-.
   - Criticidade: Alta

Invariantes do Script

1. O componente é puramente apresentacional — não possui estado, efeitos ou IPC.
2. A última indexação é formatada em pt-BR; repositório sem timestamp exibe "Nunca indexado".
3. A contagem de modificados usa âmbar semântico (#f59e0b) apenas quando maior que zero.
4. A data de última sincronização nunca renderiza "Invalid Date" — fallback para a data de indexação quando ausente ou inválida.

--- FIM ARQUITETURA DO SCRIPT ---
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