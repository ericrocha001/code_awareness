/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Renderizar o topo fixo do drawer com avatar, nome grande, botão de renomear e subtítulo de data relativa.
2. Exibir a ficha de identidade com duas DrawerFieldRow: Status e Criado em.

Mapa de Relacionamentos do Script

1. CheckpointDrawer.tsx
   - Tipo: Dependência Inversa
   - Relação: Instancia o ImplementationHeader como zona fixa do modo detalhes.
   - Criticidade: Alta

2. DrawerFieldRow.tsx
   - Tipo: Dependência Direta
   - Relação: Compõe linhas de ficha (Status, Criado em) dentro da moldura.
   - Criticidade: Alta

3. RestoreStatusBadge.tsx
   - Tipo: Dependência Direta
   - Relação: Renderiza o selo colorido como valor da linha Status, se statusInfo existir.
   - Criticidade: Média

4. checkpointUtils.ts
   - Tipo: Dependência Direta
   - Relação: Consome getRelativeDate e formatDate para subtítulo e valor da ficha.
   - Criticidade: Alta

5. ImplementationHeader.css
   - Tipo: Relação de UI
   - Relação: Consome os estilos definidos neste arquivo.
   - Criticidade: Alta

6. BlueprintBar.tsx (removido)
   - Tipo: Dependência Direta
   - Relação: Foi removido do cabeçalho — o indicador permanece exclusivamente nos cards da timeline.
   - Criticidade: N/A

Invariantes do Script

1. Componente focado na renderização, gerencia apenas estado de UI local (dropdown aberto/fechado), sem estado de dados e sem IPC.
2. A ficha sempre renderiza "Criado em" e "Campanhas" (plural); "Status" só aparece se statusInfo existir.
3. O subtítulo de data relativa usa getRelativeDate — nunca string manual.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React from 'react'
import { Pencil, GitCommitHorizontal, CalendarDays, Tag, Flag } from 'lucide-react'
import { CheckpointStatusInfo } from './restoreUtils'
import { RestoreStatusBadge } from './RestoreStatusBadge'
import { DrawerFieldRow } from './DrawerFieldRow'
import { getRelativeDate, formatDate } from './checkpointUtils'
import { Campaign } from '../../../../shared/types'
import { CampaignPicker } from './CampaignPicker'
import './ImplementationHeader.css'

interface ImplementationHeaderProps {
  name: string
  createdAt: string
  statusInfo: CheckpointStatusInfo | undefined
  selectedCampaignIds: string[]
  campaigns: Campaign[]
  onCampaignChange: (ids: string[]) => void
  onRename: () => void
}

/**
 * Topo fixo do drawer de auditoria.
 * Avatar + nome + renomear + subtítulo de data relativa + ficha de identidade.
 */
export const ImplementationHeader: React.FC<ImplementationHeaderProps> = ({
  name,
  createdAt,
  statusInfo,
  selectedCampaignIds,
  campaigns,
  onCampaignChange,
  onRename
}) => {
  const relativeDate = getRelativeDate(createdAt)
  const fullDate = formatDate(createdAt)

  return (
    <div className="ih-header">
      {/* Avatar + identidade */}
      <div className="ih-identity">
        <div className="ih-avatar">
          <GitCommitHorizontal size={18} />
        </div>
        <div className="ih-identity-text">
          <div className="ih-name-row">
            <h2 className="ih-name">{name}</h2>
            <button
              className="ih-rename-btn"
              onClick={onRename}
              title="Renomear implementação"
              aria-label="Renomear implementação"
            >
              <Pencil size={13} />
            </button>
          </div>
          <span className="ih-subtitle">{relativeDate}</span>
        </div>
      </div>

      {/* Ficha de identidade — moldura única */}
      <div className="ih-card">
        {statusInfo && (
          <div className="ih-field-row">
            <DrawerFieldRow
              icon={<Tag size={11} />}
              label="Status"
              value={
                <RestoreStatusBadge
                  status={statusInfo.status}
                  statusAt={statusInfo.statusAt}
                />
              }
            />
          </div>
        )}
        <div className={`ih-field-row${statusInfo ? ' ih-field-row--border-top' : ''}`}>
          <DrawerFieldRow
            icon={<CalendarDays size={11} />}
            label="Criado em"
            value={fullDate}
          />
        </div>
        <div className="ih-field-row ih-field-row--border-top">
          <DrawerFieldRow
            icon={<Flag size={11} />}
            label="Campanhas"
            value={
              <CampaignPicker
                campaigns={campaigns}
                selectedCampaignIds={selectedCampaignIds}
                onChange={onCampaignChange}
                variant="field"
              />
            }
          />
        </div>
      </div>
    </div>
  )
}

ImplementationHeader.displayName = 'ImplementationHeader'
