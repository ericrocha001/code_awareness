/*
-T ---
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
