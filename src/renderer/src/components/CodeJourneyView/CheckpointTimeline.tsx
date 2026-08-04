/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Renderizar a timeline de checkpoints em largura total com cards conectados por linha vertical.
2. Agrupar visualmente os checkpoints por data (Hoje, Ontem, Esta Semana, etc.).
3. Emitir o evento onSelect quando o usuário clica em um checkpoint.
4. Expor ações de ciclo de vida do item (marcar/desmarcar, restaurar, excluir) diretamente no rodapé de cada card, no padrão fantasma (ghost) com ícone + nome.
5. Exibir a campanha de cada checkpoint em uma badge clicável e permitir troca rápida via dropdown inline (Popover único ancorado dinamicamente).

Mapa de Relacionamentos do Script

1. CodeJourneyView.tsx
   - Tipo: Dependência Inversa
   - Relação: É instanciado pelo orquestrador, recebe checkpoints, selectedId, campaigns e callbacks de ciclo de vida via props.
   - Criticidade: Alta

2. CheckpointTimeline.css
   - Tipo: Relação de UI
   - Relação: Consome os estilos definidos no arquivo CSS correspondente (prefixo ctl-).
   - Criticidade: Alta

3. Popover.tsx (shared)
   - Tipo: Dependência Direta
   - Relação: Renderiza o dropdown de troca de campanha via portal, ancorado na badge da timeline.
   - Criticidade: Alta

4. ../../../../shared/types
   - Tipo: Contrato / Interface
   - Relação: Fornece os tipos CheckpointSummary e Campaign.
   - Criticidade: Alta

5. Button.tsx (shared)
   - Tipo: Dependência Direta
   - Relação: Renderiza os botões de ação de ciclo de vida no formato fantasma.
   - Criticidade: Alta

6. BlueprintBar.tsx
   - Tipo: Dependência Direta
   - Relação: Exibe o indicador de preenchimento de Instrução e Resultado em cada card de implementação.
   - Criticidade: Baixa

Invariantes do Script

1. Nunca gerenciar estado próprio de seleção — apenas emitir onSelect.
2. As ações de ciclo de vida (marcar/desmarcar, restaurar, excluir) são expostas diretamente no card, sem menu de contexto.
3. Os grupos de data devem sempre aparecer na ordem: Hoje → Ontem → Esta Semana → Este Mês → Antigos.
4. O layout usa cards com bordas e linha vertical — nenhuma funcionalidade existente deve ser quebrada.
5. A data relativa à esquerda é puramente visual — nunca deve bloquear interação com o card.
6. O stopPropagation nos botões de ação impede que o clique dispare onSelect (abrir o drawer).
7. O clique na badge de campanha usa stopPropagation — nunca abre o drawer.
8. A cor da badge deriva do status da campanha (active = amarelo, completed = verde), nunca do status do checkpoint.
9. Campanhas órfãs (IDs em `campaignIds` sem campanha correspondente) são ignoradas na badge — o fallback é no builder, não no picker.
10. Apenas um Popover é renderizado na timeline, ancorado dinamicamente via anchorRef.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React, { useMemo } from 'react'
import { CheckpointSummary, Campaign } from '../../../../shared/types'
import { getRelativeDate } from './checkpointUtils'
import { deriveCheckpointStatuses } from './restoreUtils'
import { RestoreStatusBadge } from './RestoreStatusBadge'
import { BookmarkCheck, BookmarkX, RotateCcw, Trash2 } from 'lucide-react'
import { Button } from '../shared/Button/Button'
import { BlueprintBar } from './BlueprintBar'
import { CampaignPicker } from './CampaignPicker'
import './CheckpointTimeline.css'

interface CheckpointTimelineProps {
  checkpoints: CheckpointSummary[]
  campaigns: Campaign[]
  selectedId: string | null
  onSelect: (id: string) => void
  onCreate: () => void
  allCheckpointsCount?: number
  onClearFilters?: () => void
  isLoading?: boolean
  onRestore: (id: string) => void
  onDelete: (id: string) => void
  onMarkRestored: (id: string) => void
  onUnmarkRestored: (id: string) => void
  onCampaignChange: (checkpointId: string, campaignIds: string[]) => void
}

interface DateGroup {
  label: string
  items: CheckpointSummary[]
}

/**
 * Classifica uma data em um dos grupos temporais.
 */
function getDateGroupLabel(createdAt: string): string {
  const now = new Date()
  const date = new Date(createdAt)

  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const startOfYesterday = new Date(startOfToday)
  startOfYesterday.setDate(startOfToday.getDate() - 1)
  const startOfWeek = new Date(startOfToday)
  startOfWeek.setDate(startOfToday.getDate() - 7)
  const startOfMonth = new Date(startOfToday)
  startOfMonth.setDate(startOfToday.getDate() - 30)

  if (date >= startOfToday) return 'Hoje'
  if (date >= startOfYesterday) return 'Ontem'
  if (date >= startOfWeek) return 'Esta Semana'
  if (date >= startOfMonth) return 'Este Mês'
  return 'Antigos'
}

const GROUP_ORDER = ['Hoje', 'Ontem', 'Esta Semana', 'Este Mês', 'Antigos']

/**
 * Agrupa a lista de checkpoints por categoria temporal.
 */
function groupByDate(checkpoints: CheckpointSummary[]): DateGroup[] {
  const groupMap = new Map<string, CheckpointSummary[]>()

  for (const cp of checkpoints) {
    const label = getDateGroupLabel(cp.createdAt)
    if (!groupMap.has(label)) groupMap.set(label, [])
    groupMap.get(label)!.push(cp)
  }

  return GROUP_ORDER
    .filter(label => groupMap.has(label))
    .map(label => ({ label, items: groupMap.get(label)! }))
}


/**
 * Componente puro de timeline. Recebe dados via props e emite seleção via callback.
 * As ações de ciclo de vida (marcar/desmarcar, restaurar, excluir) são expostas
 * diretamente no rodapé de cada card, com stopPropagation para não abrir o drawer.
 */
export const CheckpointTimeline: React.FC<CheckpointTimelineProps> = React.memo(({
  checkpoints,
  campaigns,
  selectedId,
  onSelect,
  onCreate,
  allCheckpointsCount = 0,
  onClearFilters,
  isLoading = false,
  onRestore,
  onDelete,
  onMarkRestored,
  onUnmarkRestored,
  onCampaignChange
}) => {
  const groups = useMemo(() => groupByDate(checkpoints), [checkpoints])
  const statusMap = useMemo(() => deriveCheckpointStatuses(checkpoints), [checkpoints])

  // BUGFIX: Distingue "sem checkpoints" de "filtros sem resultado"
  const hasActiveFilters = allCheckpointsCount > 0 && checkpoints.length === 0

  // Estado de loading
  if (isLoading) {
    return (
      <div className="ctl-loading">
        Carregando implementações...
      </div>
    )
  }

  if (checkpoints.length === 0 && !hasActiveFilters) {
    return (
      <div className="ctl-root">
        <div className="ctl-create-card" onClick={onCreate} role="button" tabIndex={0} aria-label="Criar nova implementação"
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onCreate() } }}>
          <span className="ctl-create-icon">+</span>
          <span className="ctl-create-label">Nova Implementação</span>
        </div>
        <div className="ctl-empty">
          <p>Nenhuma implementação encontrada.</p>
          <p>Clique no card '+' acima para criar sua primeira implementação.</p>
        </div>
      </div>
    )
  }

  // Estado vazio quando filtros não retornam resultados
  if (hasActiveFilters) {
    return (
      <div className="ctl-root">
        <div className="ctl-create-card" onClick={onCreate} role="button" tabIndex={0} aria-label="Criar nova implementação"
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onCreate() } }}>
          <span className="ctl-create-icon">+</span>
          <span className="ctl-create-label">Nova Implementação</span>
        </div>
        <div className="ctl-empty">
          <p>Nenhuma implementação encontrada com os filtros aplicados.</p>
          {onClearFilters && (
            <button className="ctl-clear-filters-btn" onClick={onClearFilters}>
              Limpar filtros
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="ctl-root">
      {/* Card "+" fixo no topo — sempre visível */}
      <div className="ctl-create-card" onClick={onCreate} role="button" tabIndex={0} aria-label="Criar nova implementação"
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onCreate() } }}>
        <span className="ctl-create-icon">+</span>
        <span className="ctl-create-label">Nova Implementação</span>
      </div>

      {/* Grupos da timeline (scrollável) */}
      <div className="ctl-groups-scroll">
        {groups.map(group => (
          <div key={group.label} className="ctl-group">
            <div className="ctl-group-label">{group.label}</div>
            <div className="ctl-timeline-container">
              {/* Linha vertical */}
              <div className="ctl-timeline-line" />

              {group.items.map((cp, index) => {
                const cpStatus = statusMap[cp.id]?.status
                const isRestoredCp = cpStatus === 'restored'
                const isRevertedCp = cpStatus === 'reverted'

                return (
                  <div
                    key={cp.id}
                    className="ctl-timeline-item"
                    style={{ animationDelay: `${Math.min(index * 40, 400)}ms` }}
                  >
                    {/* Coluna de data relativa à esquerda da linha */}
                    <div className="ctl-date-column">
                      <span className="ctl-date-relative">{getRelativeDate(cp.createdAt)}</span>
                      <span className="ctl-date-full">
                        {new Date(cp.createdAt).toLocaleDateString('pt-BR')}
                      </span>
                    </div>

                    {/* Ponto na linha do tempo */}
                    <div className={`ctl-timeline-dot${isRestoredCp ? ' ctl-dot-restored' : ''}${isRevertedCp ? ' ctl-dot-reverted' : ''}`} />

                    {/* Card do checkpoint com ações de ciclo de vida */}
                    <div
                      className={`ctl-card${selectedId === cp.id ? ' selected' : ''}${isRestoredCp ? ' ctl-card-restored' : ''}${isRevertedCp ? ' ctl-card-reverted' : ''}`}
                      onClick={() => onSelect(cp.id)}
                      role="button"
                      tabIndex={0}
                      aria-pressed={selectedId === cp.id}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          onSelect(cp.id)
                        }
                      }}
                    >
                        <div className="ctl-card-content">
                          <div className="ctl-card-name-row">
                            <div className="ctl-card-name">{cp.name}</div>
                            <BlueprintBar
                              instructions={cp.instructions}
                              agentSummary={cp.agentSummary}
                            />
                          </div>

                          <div className="ctl-card-field">
                            <span className="ctl-field-label">Criado em</span>
                            <span className="ctl-field-value">
                              {new Date(cp.createdAt).toLocaleString('pt-BR')}
                            </span>
                          </div>

                          <div className="ctl-card-field">
                            <span className="ctl-field-label">Arquivos</span>
                            <span className="ctl-field-value">
                              {cp.fileCount} arquivo{cp.fileCount !== 1 ? 's' : ''}
                            </span>
                          </div>

                          <div className="ctl-card-field">
                            <span className="ctl-field-label">Campanha</span>
                            {/* Badge de campanha com troca rápida via dropdown */}
                            <CampaignPicker 
                              campaigns={campaigns} 
                              selectedCampaignIds={cp.campaignIds ?? []} 
                              onChange={(ids) => onCampaignChange(cp.id, ids)} 
                              variant="compact" 
                            />
                          </div>

                          {cp.hasContent === false && <span className="ctl-archived-badge">Arquivado</span>}
                          {cpStatus && (isRestoredCp || isRevertedCp) && (
                            <div className="ctl-card-field">
                              <span className="ctl-field-label">Status</span>
                              <RestoreStatusBadge
                                status={cpStatus}
                                statusAt={statusMap[cp.id].statusAt}
                              />
                            </div>
                          )}

                        {/* Ações de ciclo de vida no rodapé do card */}
                        <div className="ctl-card-actions">
                          <Button
                            variant="ghost"
                            icon={isRestoredCp ? <BookmarkX size={14} /> : <BookmarkCheck size={14} />}
                            onClick={(e) => { e.stopPropagation(); isRestoredCp ? onUnmarkRestored(cp.id) : onMarkRestored(cp.id) }}
                            className="sm"
                          >
                            {isRestoredCp ? 'Desmarcar' : 'Marcar'}
                          </Button>
                          <Button
                            variant="ghost"
                            icon={<RotateCcw size={14} />}
                            onClick={(e) => { e.stopPropagation(); onRestore(cp.id) }}
                            className="sm"
                          >
                            Restaurar
                          </Button>
                          <Button
                            variant="ghost"
                            icon={<Trash2 size={14} />}
                            onClick={(e) => { e.stopPropagation(); onDelete(cp.id) }}
                            className="sm app-ghost-btn--danger"
                          >
                            Excluir
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
})

CheckpointTimeline.displayName = 'CheckpointTimeline'